import { describe, it, expect, vi } from 'vitest';
import { patchHelpCards } from '../scripts/aamp-runtime-patch.mjs';

function fixture(existing = true, options = {}) {
  class Runtime {
    state = {
      tasks: {
        t: {
          taskId: 't',
          status: options.terminal ? 'completed' : (existing ? 'help_needed' : 'streaming'),
          helpQuestion: 'question',
          blockedReason: 'blocked',
          helpSuggestedOptions: [],
          userMessageId: 'user-message',
          outputText: options.terminal ? 'recovered output' : '',
          targetAgentEmail: 'agent@example.com',
          dispatchMessageId: 'dispatch-id',
          ...(existing
            ? { helpCardMessageId: 'old' }
            : {
                bridgeMessageId: 'stream-card',
                dispatchMessageId: 'dispatch-id',
                targetAgentEmail: 'agent@example.com',
              }),
          ...(options.terminal
            ? { bridgeMessageId: undefined, helpCardMessageId: undefined }
            : {}),
        },
      },
    };
    channel = { send: vi.fn(async () => ({ messageId: 'new' })), updateCard: vi.fn(async () => {}) };
    persistState = vi.fn(async () => {});
    async persistState() {}
    liveTaskIds = new Set(['t']);
    cardSessions = new Map();
    config = { targetAgentEmail: 'agent@example.com' };
    aamp = { sendCancel: vi.fn(async () => ({ messageId: 'cancel-message' })) };
    logger = { log: vi.fn(), error: vi.fn() };
    resultCalls = 0;
    async start() {}
    buildHelpCard(task) {
      const elements = [
        { tag: 'markdown', content: task.helpQuestion },
      ];
      if (options.withHelpAction) {
        elements.push({
          tag: 'action',
          actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '继续' },
            type: 'primary',
            value: { kind: 'help_reply', taskId: task.taskId, response: '继续' },
          }],
        });
      }
      return this.buildCardShell(elements);
    }
    sanitizeCardText(value) { return value; }
    buildStreamTimelineElements(task) {
      return task.streamText
        ? [{ tag: 'markdown', element_id: 'timeline', content: task.streamText }]
        : [];
    }
    buildCardShell(elements, options = {}) {
      return {
        schema: '2.0',
        config: options.streaming ? { streaming_mode: true } : {},
        body: { elements },
      };
    }
    buildStreamingCard() {
      return this.buildCardShell([
        { tag: 'markdown', element_id: 'st_s', content: 'working' },
      ], { streaming: true });
    }
    buildTerminalCard(task) {
      return this.buildCardShell([
        { tag: 'markdown', content: task.outputText || task.resultError || 'terminal' },
      ]);
    }
    async waitForStreamCardUpdates() {}
    waitForStreamCardUpdates = vi.fn(async () => {});
    closeActiveStream() {}
    closeActiveStream = vi.fn();
    async sendOrUpdateTerminalCard(task, options) {
      this.terminalCard = this.buildTerminalCard(task, options);
      this.terminalOptions = options;
      if (options?.allowNewMessageFallback) task.bridgeMessageId = 'recovered-card';
    }
    async handleTaskHelp(event) {
      const task = this.state.tasks[event.taskId];
      Object.assign(task, { helpQuestion: event.question, blockedReason: event.blockedReason, helpSuggestedOptions: event.suggestedOptions });
      await this.sendHelpCard(task);
    }
    async sendHelpCard(task) { task.helpCardMessageId = (await this.channel.send()).messageId; }
    async handleCardAction() {}
    async handleTaskResult() { this.resultCalls += 1; }
  }
  patchHelpCards(Runtime);
  return new Runtime();
}
const event = { taskId: 't', question: 'question', blockedReason: 'blocked', suggestedOptions: [] };
const cancelEvent = { action: { value: { kind: 'task_cancel', taskId: 't' } } };
describe('SDK help replay protection', () => {
  it('skips persisted identical help on every restart', async () => {
    for (let i = 0; i < 3; i++) {
      const runtime = fixture();
      await runtime.handleTaskHelp(event);
      expect(runtime.channel.send).not.toHaveBeenCalled();
      expect(runtime.channel.updateCard).not.toHaveBeenCalled();
    }
  });
  it('serializes concurrent first delivery', async () => {
    const runtime = fixture(false);
    await Promise.all([runtime.handleTaskHelp(event), runtime.handleTaskHelp(event)]);
    expect(runtime.channel.send).toHaveBeenCalledTimes(1);
  });
  it('updates changed questions without a new send', async () => {
    const runtime = fixture();
    await runtime.handleTaskHelp({ ...event, question: 'new question' });
    const updatedCard = runtime.channel.updateCard.mock.calls[0][1];
    expect(updatedCard.body.elements[0]).toMatchObject({
      tag: 'markdown',
      content: 'new question',
    });
    expect(updatedCard.body.elements.at(-1).value).toEqual({
      kind: 'task_cancel',
      taskId: 't',
    });
    expect(runtime.channel.send).not.toHaveBeenCalled();
  });
  it('does not add cancellation to a submitted help-card replay', () => {
    const runtime = fixture();
    const card = runtime.buildHelpCard(runtime.state.tasks.t, {
      submittedResponse: 'continue',
      submissionState: 'submitted',
    });

    expect(card.body.elements.some((element) => element.tag === 'action')).toBe(false);
  });
  it('converts upstream V2 action wrappers to direct buttons', () => {
    const runtime = fixture(true, { withHelpAction: true });
    const card = runtime.buildHelpCard(runtime.state.tasks.t);

    expect(card.body.elements.some((element) => element.tag === 'action')).toBe(false);
    const buttons = card.body.elements.filter((element) => element.tag === 'button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({
      text: expect.objectContaining({ content: '继续' }),
      value: { kind: 'help_reply', taskId: 't', response: '继续' },
    });
    expect(buttons[1]).toMatchObject({
      text: expect.objectContaining({ content: '中断执行' }),
      value: { kind: 'task_cancel', taskId: 't' },
    });
  });
  it('never falls back to sending when updating fails', async () => {
    const runtime = fixture();
    runtime.channel.updateCard.mockRejectedValue(new Error('offline'));
    await expect(runtime.handleTaskHelp({ ...event, question: 'changed' })).rejects.toThrow('offline');
    expect(runtime.channel.send).not.toHaveBeenCalled();
    expect(runtime.state.tasks.t.helpCardMessageId).toBe('old');
  });
  it('recovers a completed task whose stream card was never delivered', async () => {
    const runtime = fixture(false, { terminal: true });

    await runtime.start();

    expect(runtime.terminalCard.body.elements.find((element) => element.tag === 'markdown')).toMatchObject({
      tag: 'markdown',
      content: 'recovered output',
    });
    expect(runtime.terminalCard.body.elements.find((element) => element.tag === 'button')).toMatchObject({
      text: { content: '查看详情' },
      value: { kind: 'aamp_command', command: 'tasks', taskId: 't' },
    });
    expect(runtime.state.tasks.t.bridgeMessageId).toBe('recovered-card');
  });
});

describe('AAMP streaming-card cancellation', () => {
  it('adds an interrupt button to a live streaming card', () => {
    const runtime = fixture(false);
    const card = runtime.buildStreamingCard(runtime.state.tasks.t);
    const actions = card.body.elements.filter((element) => element.tag === 'button');

    expect(actions).toHaveLength(2);
    expect(actions.find((action) => action.value?.kind === 'task_cancel')).toMatchObject({
      tag: 'button',
      type: 'danger',
      text: { content: '中断执行' },
      value: { kind: 'task_cancel', taskId: 't' },
    });
    expect(actions.find((action) => action.value?.kind === 'aamp_command')).toMatchObject({
      tag: 'button',
      type: 'primary',
      text: { content: '查看详情' },
      value: { kind: 'aamp_command', command: 'tasks', taskId: 't' },
    });
  });

  it('sends one task.cancel and replaces the existing stream card', async () => {
    const runtime = fixture(false);
    runtime.state.tasks.t.streamText = 'partial output';

    await Promise.all([
      runtime.handleCardAction(cancelEvent),
      runtime.handleCardAction(cancelEvent),
    ]);

    expect(runtime.aamp.sendCancel).toHaveBeenCalledTimes(1);
    expect(runtime.aamp.sendCancel).toHaveBeenCalledWith({
      to: 'agent@example.com',
      taskId: 't',
      bodyText: '用户通过飞书卡片请求中断本轮执行。',
      inReplyTo: 'dispatch-id',
    });
    expect(runtime.closeActiveStream).toHaveBeenCalledWith('t');
    expect(runtime.liveTaskIds.has('t')).toBe(false);
    expect(runtime.state.tasks.t).toMatchObject({
      status: 'failed',
      statusLabel: '已中断',
      bridgeCancelState: 'sent',
      resultError: '用户通过飞书卡片请求中断本轮执行。',
    });
    expect(runtime.terminalOptions).toMatchObject({
      allowNewMessageFallback: false,
      includeReplay: true,
    });
    expect(runtime.terminalCard.body.elements
      .filter((element) => element.tag === 'markdown')
      .some((element) => element.content.includes('本轮执行已中断'))).toBe(true);
    expect(runtime.terminalCard.body.elements.some((element) => element.tag === 'action')).toBe(false);

    await runtime.handleTaskResult({ taskId: 't', status: 'completed', output: 'late result' });
    expect(runtime.resultCalls).toBe(0);
  });

  it('updates the existing help card when cancelling a blocked task', async () => {
    const runtime = fixture();

    await runtime.handleCardAction(cancelEvent);

    expect(runtime.aamp.sendCancel).toHaveBeenCalledTimes(1);
    expect(runtime.channel.updateCard).toHaveBeenCalledWith(
      'old',
      expect.objectContaining({
        body: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              tag: 'markdown',
              content: expect.stringContaining('本轮执行已中断'),
            }),
          ]),
        }),
      }),
    );
    expect(runtime.terminalCard).toBeUndefined();
  });

  it('keeps the retry button when task.cancel fails', async () => {
    const runtime = fixture(false);
    runtime.aamp.sendCancel.mockRejectedValueOnce(new Error('offline'));

    await runtime.handleCardAction(cancelEvent);

    expect(runtime.state.tasks.t).toMatchObject({
      status: 'streaming',
      bridgeCancelState: 'failed',
      progressLabel: '中断请求失败，请点击“重试中断”。',
    });
    expect(runtime.liveTaskIds.has('t')).toBe(true);
    expect(runtime.channel.updateCard).toHaveBeenCalledWith(
      'stream-card',
      expect.objectContaining({
        body: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              tag: 'button',
              text: expect.objectContaining({ content: '重试中断' }),
            }),
          ]),
        }),
      }),
    );

    await runtime.handleCardAction(cancelEvent);
    expect(runtime.aamp.sendCancel).toHaveBeenCalledTimes(2);
    expect(runtime.state.tasks.t.bridgeCancelState).toBe('sent');
  });
});
