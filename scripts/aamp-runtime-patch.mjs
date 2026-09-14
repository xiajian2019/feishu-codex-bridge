const patched = Symbol.for('feishu-codex-bridge.help-card-patch');

const TERMINAL_TASK_STATUSES = new Set(['completed', 'rejected', 'failed']);
const CANCEL_ACTION_KIND = 'task_cancel';
const CANCEL_REASON = '用户通过飞书卡片请求中断本轮执行。';
const taskQueues = new WeakMap();

function enqueueTask(runtime, taskId, operation) {
  if (!taskId) return Promise.resolve().then(operation);

  let queues = taskQueues.get(runtime);
  if (!queues) taskQueues.set(runtime, queues = new Map());
  const previous = queues.get(taskId) || Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  queues.set(taskId, run);
  void run.finally(() => {
    if (queues.get(taskId) === run) queues.delete(taskId);
  }).catch(() => {});
  return run;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCardActionValue(event) {
  return isRecord(event?.action?.value) ? event.action.value : undefined;
}

function isCancelAction(event) {
  return readCardActionValue(event)?.kind === CANCEL_ACTION_KIND;
}

function taskIsTerminal(task) {
  return Boolean(task?.bridgeCancelledAt) || TERMINAL_TASK_STATUSES.has(task?.status);
}

function isV2Card(card) {
  return card?.schema === '2.0' || card?.schema === 2;
}

function normalizeV2CardActions(card) {
  if (!isV2Card(card)) return card;
  const body = card?.body;
  if (!isRecord(body) || !Array.isArray(body.elements)) {
    throw new Error('AAMP compatibility: upstream V2 card has no body.elements; review upstream update');
  }

  let changed = false;
  const elements = body.elements.flatMap((element) => {
    if (!isRecord(element) || element.tag !== 'action' || !Array.isArray(element.actions)) {
      return [element];
    }
    changed = true;
    return element.actions.filter(isRecord);
  });
  if (!changed) return card;
  return {
    ...card,
    body: {
      ...body,
      elements,
    },
  };
}

function appendCancelAction(card, task) {
  if (!task?.taskId || taskIsTerminal(task)) return card;
  const normalizedCard = normalizeV2CardActions(card);
  const body = normalizedCard?.body;
  if (!isRecord(body) || !Array.isArray(body.elements)) {
    throw new Error('AAMP compatibility: upstream streaming card has no body.elements; review upstream update');
  }

  const alreadyHasCancel = body.elements.some((element) =>
    isRecord(element)
      && ((element.tag === 'button'
        && readCardActionValue({ action: element })?.kind === CANCEL_ACTION_KIND)
        || (element.tag === 'action'
          && Array.isArray(element.actions)
          && element.actions.some((action) => readCardActionValue({ action })?.kind === CANCEL_ACTION_KIND))),
  );
  if (alreadyHasCancel) return normalizedCard;

  const retrying = task.bridgeCancelState === 'failed';
  const cancelButton = {
    tag: 'button',
    element_id: 'st_cancel',
    text: {
      tag: 'plain_text',
      content: retrying ? '重试中断' : '中断执行',
    },
    type: 'danger',
    value: {
      kind: CANCEL_ACTION_KIND,
      taskId: task.taskId,
    },
  };
  const cancelElement = isV2Card(normalizedCard)
    ? cancelButton
    : {
        tag: 'action',
        element_id: 'st_cancel',
        actions: [{
          tag: 'button',
          text: cancelButton.text,
          type: cancelButton.type,
          value: cancelButton.value,
        }],
      };
  return {
    ...normalizedCard,
    body: {
      ...body,
      elements: [
        ...body.elements,
        cancelElement,
      ],
    },
  };
}

function buildCancelledCard(runtime, task) {
  const elements = [];
  const hasTimeline = Boolean(
    task.streamEntries?.length || task.streamText?.trim() || task.toolTraceText?.trim(),
  );
  if (hasTimeline) {
    elements.push(...runtime.buildStreamTimelineElements(task, {
      textPanelTitle: '中断前的过程',
      includePlaceholder: false,
    }));
  }
  elements.push({
    tag: 'markdown',
    content: runtime.sanitizeCardText([
      '本轮执行已中断。',
      task.bridgeCancelReason || CANCEL_REASON,
    ].join('\n\n')),
  });
  return runtime.buildCardShell(elements);
}

async function updateStreamingCardAfterCancelFailure(runtime, task) {
  await runtime.waitForStreamCardUpdates(task.taskId).catch(() => {});
  const nextCard = runtime.buildStreamingCard(task);
  const session = runtime.cardSessions?.get(task.taskId);
  if (session) {
    await session.update(nextCard);
    return;
  }
  if (task.bridgeMessageId) {
    await runtime.channel.updateCard(task.bridgeMessageId, nextCard);
  }
}

async function clearTaskReactions(runtime, task) {
  for (const method of ['clearReceivedReaction', 'clearTypingReaction']) {
    const clear = runtime[method];
    if (typeof clear !== 'function') continue;
    await clear.call(runtime, task).catch((error) => {
      runtime.logger?.error?.(`[AAMP compatibility] failed to clear ${method} task=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function isUndeliveredTerminalTask(task) {
  return Boolean(
    task?.taskId
      && task.userMessageId
      && task.dispatchMessageId
      && TERMINAL_TASK_STATUSES.has(task.status)
      && !task.bridgeMessageId
      && !task.helpCardMessageId,
  );
}

async function recoverUndeliveredTerminalCards(runtime) {
  const tasks = Object.values(runtime.state?.tasks ?? {}).filter(isUndeliveredTerminalTask);
  for (const task of tasks) {
    try {
      await runtime.sendOrUpdateTerminalCard(task, {
        allowNewMessageFallback: true,
        includeReplay: true,
      });
      await clearTaskReactions(runtime, task);
      await runtime.persistState();
      runtime.logger?.log?.(`[AAMP compatibility] recovered terminal card task=${task.taskId}`);
    } catch (error) {
      runtime.logger?.error?.(`[AAMP compatibility] failed to recover terminal card task=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function cancelTaskFromCard(runtime, taskId) {
  const task = runtime.state?.tasks?.[taskId];
  if (!task) return;
  if (task.bridgeCancelledAt || !runtime.liveTaskIds?.has?.(taskId)) return;
  if (typeof runtime.aamp?.sendCancel !== 'function') {
    throw new Error('AAMP compatibility: AampClient.sendCancel is unavailable; review upstream update');
  }

  const targetAgentEmail = task.targetAgentEmail || runtime.config?.targetAgentEmail;
  if (!targetAgentEmail) {
    throw new Error(`AAMP compatibility: task ${taskId} has no target Agent mailbox`);
  }
  const helpCardMessageId = task.status === 'help_needed' ? task.helpCardMessageId : undefined;

  task.bridgeCancelState = 'sending';
  task.bridgeCancelError = undefined;
  task.progressLabel = '正在发送中断请求...';
  task.updatedAt = new Date().toISOString();
  await runtime.persistState();

  try {
    await runtime.aamp.sendCancel({
      to: targetAgentEmail,
      taskId,
      bodyText: CANCEL_REASON,
      ...(task.dispatchMessageId ? { inReplyTo: task.dispatchMessageId } : {}),
    });
  } catch (error) {
    task.bridgeCancelState = 'failed';
    task.bridgeCancelError = error instanceof Error ? error.message : String(error);
    task.progressLabel = '中断请求失败，请点击“重试中断”。';
    task.updatedAt = new Date().toISOString();
    await runtime.persistState();
    await updateStreamingCardAfterCancelFailure(runtime, task).catch((updateError) => {
      runtime.logger?.error?.(`[AAMP compatibility] failed to update cancel-error card task=${taskId}: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
    });
    runtime.logger?.error?.(`[AAMP compatibility] task.cancel failed task=${taskId}: ${task.bridgeCancelError}`);
    return;
  }

  runtime.closeActiveStream(taskId);
  runtime.liveTaskIds.delete(taskId);
  task.bridgeCancelState = 'sent';
  task.bridgeCancelledAt = new Date().toISOString();
  task.bridgeCancelReason = CANCEL_REASON;
  task.status = 'failed';
  task.statusLabel = '已中断';
  task.progressLabel = undefined;
  task.resultError = CANCEL_REASON;
  task.updatedAt = new Date().toISOString();

  await runtime.waitForStreamCardUpdates(taskId);
  if (helpCardMessageId) {
    await runtime.channel.updateCard(
      helpCardMessageId,
      runtime.buildTerminalCard(task, { includeReplay: true }),
    );
  } else {
    await runtime.sendOrUpdateTerminalCard(task, {
      allowNewMessageFallback: false,
      includeReplay: true,
    });
  }
  await clearTaskReactions(runtime, task);
  await runtime.persistState();
}

// Apply at the runtime level: IM uses the SDK's websocket channel, while
// task commands use lark-cli. A CLI-only patch cannot intercept IM cards.
export function patchHelpCards(Runtime) {
  const prototype = Runtime.prototype;
  if (prototype[patched]) return;
  for (const method of [
    'start',
    'handleTaskHelp',
    'sendHelpCard',
    'buildHelpCard',
    'persistState',
    'handleCardAction',
    'handleTaskResult',
    'buildStreamingCard',
    'buildTerminalCard',
    'buildCardShell',
    'buildStreamTimelineElements',
    'waitForStreamCardUpdates',
    'closeActiveStream',
    'sendOrUpdateTerminalCard',
  ]) {
    if (typeof prototype[method] !== 'function') {
      throw new Error(`AAMP compatibility: missing ${method}; review upstream update`);
    }
  }
  const originalStart = prototype.start;
  const originalHelp = prototype.handleTaskHelp;
  const originalSend = prototype.sendHelpCard;
  const originalCardAction = prototype.handleCardAction;
  const originalResult = prototype.handleTaskResult;
  const originalHelpCard = prototype.buildHelpCard;
  const originalStreamingCard = prototype.buildStreamingCard;
  const originalTerminalCard = prototype.buildTerminalCard;
  prototype.start = async function (...args) {
    await originalStart.apply(this, args);
    await recoverUndeliveredTerminalCards(this);
  };
  prototype.handleTaskHelp = function (event) {
    return enqueueTask(this, event.taskId, async () => {
      const state = this.state.tasks[event.taskId];
      if (state?.bridgeCancelledAt) return;
      const options = (event.suggestedOptions || []).flatMap(option =>
        option.includes('|') ? option.split('|').map(item => item.trim()).filter(Boolean) : [option]);
      if (state?.helpCardMessageId && state.status === 'help_needed'
        && state.helpQuestion === event.question
        && state.blockedReason === event.blockedReason
        && JSON.stringify(state.helpSuggestedOptions || []) === JSON.stringify(options)) {
        this.logger?.log?.(`[AAMP compatibility] skipped help replay task=${event.taskId}`);
        return;
      }
      const snapshot = state ? {
        status: state.status,
        helpQuestion: state.helpQuestion,
        blockedReason: state.blockedReason,
        helpSuggestedOptions: state.helpSuggestedOptions,
        statusLabel: state.statusLabel,
      } : undefined;
      try {
        return await originalHelp.call(this, event);
      } catch (error) {
        // The upstream handler mutates the question before sending. Restore
        // it on failure so a retry is not mistaken for a delivered replay.
        if (snapshot) Object.assign(state, snapshot);
        throw error;
      }
    });
  };
  prototype.handleCardAction = function (event) {
    const value = readCardActionValue(event);
    const taskId = typeof value?.taskId === 'string' ? value.taskId.trim() : '';
    if (isCancelAction(event)) {
      if (!taskId) return;
      return enqueueTask(this, taskId, () => cancelTaskFromCard(this, taskId));
    }
    if (taskId) return enqueueTask(this, taskId, () => originalCardAction.call(this, event));
    return originalCardAction.call(this, event);
  };
  prototype.handleTaskResult = function (event) {
    const taskId = event?.taskId;
    if (typeof taskId !== 'string' || !taskId.trim()) return originalResult.call(this, event);
    return enqueueTask(this, taskId, async () => {
      if (this.state?.tasks?.[taskId]?.bridgeCancelledAt) {
        this.logger?.log?.(`[AAMP compatibility] ignored result after task.cancel task=${taskId}`);
        return;
      }
      return originalResult.call(this, event);
    });
  };
  prototype.buildHelpCard = function (task, ...args) {
    const card = originalHelpCard.call(this, task, ...args);
    const options = args[0];
    if (isRecord(options) && options.submissionState) return normalizeV2CardActions(card);
    return appendCancelAction(card, task);
  };
  prototype.buildStreamingCard = function (task, ...args) {
    return appendCancelAction(originalStreamingCard.call(this, task, ...args), task);
  };
  prototype.buildTerminalCard = function (task, ...args) {
    if (task?.bridgeCancelledAt) return buildCancelledCard(this, task);
    return originalTerminalCard.call(this, task, ...args);
  };
  prototype.sendHelpCard = async function (task) {
    if (!task.helpCardMessageId) return originalSend.call(this, task);
    // Changed questions update the same card. A failed update must not fall
    // back to sending a duplicate; preserve the ID for a later retry.
    await this.channel.updateCard(task.helpCardMessageId, this.buildHelpCard(task));
    task.updatedAt = new Date().toISOString();
    await this.persistState();
  };
  Object.defineProperty(prototype, patched, { value: true });
  console.error('[AAMP compatibility] V2 card buttons, terminal-card recovery, help-card replay protection and task cancellation active');
}
