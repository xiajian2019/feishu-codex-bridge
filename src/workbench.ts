import type { StateDatabase } from "./db.js";
import type { CodexHistoryActionResponse, CodexHistoryService } from "./codex-history.js";
import type { DashboardActions } from "./web.js";
import type { DatabaseChange, Logger, StoredTask } from "./types.js";
import {
  parseWorkbenchTarget, workbenchTargetKey,
  type WorkbenchTarget, type WorkbenchAutomation, type WorkbenchAutomationClaim,
  type WorkbenchQueueMessage, type WorkbenchNotificationCategory,
  type WorkbenchTemplatePatch, type WorkbenchPreferencePatch,
  type NewWorkbenchTemplate, type WorkbenchMachineProfilePatch,
  type WorkbenchAutomationPatch, type NewWorkbenchAutomation,
  type WorkbenchPendingAction, type WorkbenchMachineProfile,
} from "./workbench-store.js";

export class WorkbenchError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

interface WorkbenchOptions {
  db: StateDatabase;
  history?: CodexHistoryService;
  tmuxAvailable?: boolean;
  actions?: DashboardActions;
  logger?: Logger;
  now?: () => number;
}

export interface WorkbenchResult { status: number; body: unknown }

/** Additive metadata and delivery coordination; never replaces a source task state machine. */
export class WorkbenchService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private ticking = false;
  private readonly dispatching = new Set<string>();
  private readonly now: () => number;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly options: WorkbenchOptions) { this.now = options.now ?? Date.now; }
  private get store() { return this.options.db.workbench; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { this.track(this.tick()); }, 1_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inFlight]);
  }

  private track(promise: Promise<unknown>): void {
    this.inFlight.add(promise);
    void promise.catch((error) => this.options.logger?.warn("workbench update failed", {
      error: message(error),
    })).finally(() => this.inFlight.delete(promise));
  }

  onDatabaseChange(change: DatabaseChange): void {
    let target: WorkbenchTarget;
    let state: string | undefined;
    let eventIdentity: string;
    if (change.kind === "bridge_task") {
      const task = this.options.db.getBridgeTask(change.taskGuid);
      if (!task) return;
      target = { kind: "task", source: "direct", id: task.bridge_task_id };
      state = task.status;
      eventIdentity = `${task.attempt}:${state}`;
    } else if (change.kind === "aamp_task") {
      const task = this.options.db.getAampTask(change.aampTaskId ?? change.taskGuid);
      if (!task) return;
      target = { kind: "task", source: "aamp", id: task.aamp_task_id };
      state = task.status;
      eventIdentity = state;
    } else if (change.kind === "task" || change.kind === "run") {
      const task = this.options.db.getTask(change.taskGuid);
      if (!task) return;
      target = { kind: "task", source: "desk", id: task.task_guid };
      state = task.state;
      eventIdentity = `${change.runId ?? task.active_run_id ?? this.options.db.getLatestRun(task.task_guid)?.run_id ?? task.updated_at}:${state}`;
    } else return;
    const category = terminalCategory(state);
    if (category) this.notify(target, category, eventIdentity);
    if (state === "WAITING_REVIEW") this.notify(target, "completion", eventIdentity);
    if (category || state === "WAITING_REVIEW") this.reconcileAutomations();
  }

  private notify(target: WorkbenchTarget, category: WorkbenchNotificationCategory, identity: string): void {
    if (!this.store.getNotificationSettings()[category]) return;
    const eventKey = `${workbenchTargetKey(target)}:${category}:${identity}`;
    if (this.store.hasNotification(eventKey)) return;
    this.store.recordNotification({ eventKey, target, category,
      title: category === "completion" ? "执行已完成" : category === "failure" ? "执行失败或已中断" : "等待你处理" });
    this.store.updatePreferences(target, { unread: true });
  }

  async request(method: string, url: URL, body: Record<string, unknown> = {}): Promise<WorkbenchResult> {
    const path = url.pathname.slice("/api/workbench".length);
    const ok = (value: unknown, status = 200): WorkbenchResult => ({ status, body: value });
    if (path === "/inbox" && method === "GET") {
      await this.syncHistory();
      return ok({ actions: this.store.listPendingActions({ statuses: ["pending"] }).map(publicAction),
        notifications: this.store.listNotifications(), connection: { state: "connected", checkedAt: this.now() } });
    }
    if (path === "/preferences") {
      if (method === "GET") return ok({ preferences: this.store.listPreferences() });
      if (method === "PATCH") {
        const target = await this.validateTarget(body.target);
        return ok({ preference: this.store.updatePreferences(target, record(body.patch) as WorkbenchPreferencePatch) });
      }
    }
    if (path === "/templates") {
      if (method === "GET") return ok({ templates: this.store.listTemplates() });
      if (method === "POST") return ok({ template: this.store.createTemplate(body as unknown as NewWorkbenchTemplate) }, 201);
    }
    const template = /^\/templates\/([^/]+)$/.exec(path);
    if (template) {
      const id = decode(template[1]!);
      if (method === "PATCH") return ok({ template: this.store.updateTemplate(id, body as WorkbenchTemplatePatch) });
      if (method === "DELETE") return ok({ ok: this.store.deleteTemplate(id) });
    }
    if (path === "/settings") {
      if (method === "PATCH") {
        const settings = record(body.notifications ?? (body.settings === undefined ? body : record(body.settings).notifications));
        const patch = { ...settings };
        if (patch.browser !== undefined) { patch.system = patch.browser; delete patch.browser; }
        this.store.updateNotificationSettings(patch);
      }
      if (method === "GET" || method === "PATCH") {
        const { system, updatedAt: _at, ...settings } = this.store.getNotificationSettings();
        return ok({ settings: { notifications: { ...settings, browser: system } } });
      }
    }
    const dismiss = /^\/notifications\/([^/]+)\/dismiss$/.exec(path);
    if (dismiss && method === "POST") return ok({ notification: this.store.dismissNotification(decode(dismiss[1]!)) });
    if (path === "/queue") {
      const target = await this.validateTarget(method === "GET" ? queryTarget(url) : body.target);
      this.assertQueueSupported(target);
      if (method === "GET") return ok({ messages: this.store.listQueueMessages(target) });
      if (method === "POST") {
        const text = requiredText(body.text, target.kind === "task" ? 2_000 : 8_000);
        const item = this.store.enqueueQueueMessage(target, { text, idempotencyKey: requiredText(body.idempotencyKey, 200),
          ...(body.model !== undefined ? { model: requiredText(body.model, 200) } : {}),
          ...(body.reasoningEffort !== undefined ? { reasoningEffort: requiredText(body.reasoningEffort, 40) } : {}) });
        // Queue acceptance is durable, not a claim that Codex has executed it.
        return ok({ message: item }, 201);
      }
    }
    const queue = /^\/queue\/([^/]+)(?:\/(send))?$/.exec(path);
    if (queue) {
      const item = this.store.getQueueMessage(decode(queue[1]!));
      if (!item) throw new WorkbenchError(404, "队列消息不存在");
      const target = await this.validateTarget(item.target);
      if (method === "PATCH") {
        return this.options.db.transaction(() => {
          if (body.move !== undefined) {
            if (body.move !== "up" && body.move !== "down") throw new WorkbenchError(400, "move 必须是 up/down");
            const queued = this.store.listQueueMessages(target).filter((entry) => entry.status === "queued");
            const index = queued.findIndex((entry) => entry.id === item.id);
            if (index < 0) throw new WorkbenchError(409, "只有待发消息可排序");
            const next = Math.max(0, Math.min(queued.length - 1, index + (body.move === "up" ? -1 : 1)));
            this.store.moveQueueMessage(target, item.id, next);
          }
          const patch = { ...body }; delete patch.move;
          if (patch.text !== undefined) patch.text = requiredText(patch.text, target.kind === "task" ? 2_000 : 8_000);
          const updated = Object.keys(patch).length ? this.store.updateQueueMessage(target, item.id, patch) : this.store.getQueueMessage(item.id);
          return ok({ message: updated, messages: this.store.listQueueMessages(target) });
        });
      }
      if (method === "DELETE") return ok({ ok: this.store.removeQueueMessage(target, item.id) });
      if (method === "POST" && queue[2] === "send") {
        const head = this.store.listQueueMessages(target).find((entry) => entry.status === "queued");
        if (head?.id !== item.id) throw new WorkbenchError(409, "请先发送队首，或调整顺序");
        if (!await this.isIdle(target)) throw new WorkbenchError(409, "原会话正在运行；消息已保留，空闲后发送");
        await this.dispatchNext(target);
        return ok({ message: this.store.getQueueMessage(item.id) });
      }
    }
    if (path === "/actions" && method === "GET") {
      await this.syncHistory();
      const target = url.searchParams.has("kind") ? await this.validateTarget(queryTarget(url)) : undefined;
      return ok({ actions: this.store.listPendingActions({ target, statuses: ["pending"] }).map(publicAction) });
    }
    const action = /^\/actions\/([^/]+)\/respond$/.exec(path);
    if (action && method === "POST") return this.respondAction(decode(action[1]!), body);
    if (path === "/automations") {
      if (method === "GET") return ok({ automations: this.store.listAutomations().map(publicAutomation) });
      if (method === "POST") {
        const value = await this.automationInput(body, false);
        return ok({ automation: publicAutomation(this.store.createAutomation(value as NewWorkbenchAutomation)) }, 201);
      }
    }
    const automation = /^\/automations\/([^/]+)(?:\/(run|runs))?$/.exec(path);
    if (automation) {
      const id = decode(automation[1]!);
      if (method === "GET" && automation[2] === "runs") return ok({ runs: this.store.listAutomationRuns(id) });
      if (method === "PATCH") {
        const current = this.store.listAutomations().find((entry) => entry.id === id);
        if (!current) throw new WorkbenchError(404, "自动化不存在");
        return ok({ automation: publicAutomation(this.store.updateAutomation(id, await this.automationInput(body, true, current.target))) });
      }
      if (method === "DELETE") return ok({ ok: this.store.deleteAutomation(id) });
      if (method === "POST" && automation[2] === "run") {
        const idempotencyKey = requiredText(body.idempotencyKey, 200);
        const previous = this.store.listAutomationRuns(id).find((run) => run.idempotencyKey === idempotencyKey);
        if (previous) return ok({ run: previous, runs: this.store.listAutomationRuns(id) });
        const claim = this.store.claimAutomation(id, idempotencyKey);
        if (!claim) throw new WorkbenchError(409, "自动化已有提交进行中");
        await this.runAutomation(claim);
        const runs = this.store.listAutomationRuns(id);
        return ok({ run: runs.find((run) => run.id === claim.runId), runs });
      }
    }
    if (path === "/machines") {
      if (method === "GET") return ok({ machines: this.store.listMachineProfiles().map((value) => publicMachine(value, [
        ...(this.options.actions?.createTask ? ["task-desk"] : []),
        ...(this.options.history ? ["history"] : []),
        ...(this.options.tmuxAvailable ? ["tmux"] : []),
      ])), localId: "local" });
      if (method === "POST") return ok({ machine: publicMachine(this.store.createMachineProfile({ name: requiredText(body.name, 200),
        ...(body.url !== undefined ? { url: requiredText(body.url, 2_000) } : {}) })) }, 201);
    }
    const machine = /^\/machines\/([^/]+)$/.exec(path);
    if (machine) {
      const id = decode(machine[1]!);
      if (method === "PATCH") return ok({ machine: publicMachine(this.store.updateMachineProfile(id, body as WorkbenchMachineProfilePatch)) });
      if (method === "DELETE") {
        if (id === "local") throw new WorkbenchError(409, "本地执行主机不可移除");
        return ok({ ok: this.store.deleteMachineProfile(id) });
      }
    }
    throw new WorkbenchError(404, "workbench endpoint not found");
  }

  private async validateTarget(value: unknown): Promise<WorkbenchTarget> {
    const target = parseWorkbenchTarget(value);
    if (target.kind === "history") {
      if (!target.homeId) throw new WorkbenchError(400, "History 目标必须包含 homeId");
      if (!this.options.history) throw new WorkbenchError(501, "Codex History 未配置");
      if (!this.options.history.listHomes().some((home) => home.id === target.homeId && home.available)) throw new WorkbenchError(404, "Codex Home 不可用");
      // The official read validates account + original thread ownership, without opening Codex-owned DB files.
      await this.options.history.readThread(target.homeId, target.id, false);
      return target;
    }
    if (!target.source) throw new WorkbenchError(400, "任务目标必须包含 source");
    const found = target.source === "desk" ? this.options.db.getTask(target.id)
      : target.source === "direct" ? this.options.db.getBridgeTask(target.id) : this.options.db.getAampTask(target.id);
    if (!found) throw new WorkbenchError(404, "目标任务不存在");
    return target;
  }

  private assertQueueSupported(target: WorkbenchTarget): void {
    if (target.kind === "task") {
      if (target.source === "aamp") throw new WorkbenchError(501, "AAMP 队列由原运行时管理，本页只读");
      if (target.source === "desk") {
        const task = this.options.db.getTask(target.id)!;
        if (task.origin !== "web" || !this.options.actions?.appendWebFollowup) throw new WorkbenchError(501, "该任务没有可靠的 Web 续问入口");
        const workspace = this.options.db.getTaskWorkspace(target.id);
        if (workspace?.followups_closed_at || workspace?.status === "removed") throw new WorkbenchError(409, "工作区已归档，不再接收续问");
      } else if (!this.options.actions?.appendDirectFollowup) throw new WorkbenchError(501, "Direct 续问当前不可用");
    }
  }

  private async isIdle(target: WorkbenchTarget): Promise<boolean> {
    if (target.kind === "history") return Boolean(target.homeId && this.options.history
      && (await this.options.history.getWriterStatus(target.homeId, target.id)).state === "available");
    if (target.source === "desk") {
      const task = this.options.db.getTask(target.id);
      return Boolean(task && !["RUNNING", "QUEUED", "BLOCKED_CONFIG"].includes(task.state));
    }
    if (target.source === "direct") {
      const task = this.options.db.getBridgeTask(target.id);
      return Boolean(task?.thread_id && !["QUEUED", "RUNNING", "CANCEL_REQUESTED", "RETRY_WAIT"].includes(task.status));
    }
    return false;
  }

  private async dispatchNext(target: WorkbenchTarget): Promise<void> {
    const key = workbenchTargetKey(target);
    if (this.dispatching.has(key)) return;
    this.dispatching.add(key);
    try {
      this.assertQueueSupported(target);
      if (!await this.isIdle(target)) return;
      const queued = this.store.claimNextQueueMessage(target);
      if (!queued) return;
      try {
        const executionId = await this.deliver(queued);
        if (executionId && queued.idempotencyKey.startsWith("automation:")) {
          this.store.linkAutomationRun(queued.idempotencyKey.slice("automation:".length), target, executionId);
        }
        this.store.finishQueueMessage(target, queued.id, { status: "sent" });
        this.reconcileAutomations();
      } catch (error) {
        // The original backend may have accepted before a transport failed. Never replay an ambiguous send.
        this.store.finishQueueMessage(target, queued.id, { status: "unconfirmed", error: message(error) });
        this.notify(target, "failure", `queue:${queued.id}`);
      }
    } finally { this.dispatching.delete(key); }
  }

  private async deliver(item: WorkbenchQueueMessage): Promise<string | undefined> {
    const { target } = item;
    const key = `workbench_${item.id}`;
    if (target.kind === "history") {
      if (!target.homeId || !this.options.history) throw new WorkbenchError(501, "History 未配置");
      const accepted = await this.options.history.sendMessage(target.homeId, target.id, {
        text: item.text, model: item.model, idempotencyKey: key,
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort as Parameters<CodexHistoryService["sendMessage"]>[2]["reasoningEffort"] } : {}),
      });
      return accepted.runId;
    } else if (target.source === "desk" && this.options.actions?.appendWebFollowup) {
      const accepted = await this.options.actions.appendWebFollowup(target.id, item.text, key);
      return this.deskExecutionId(accepted, key);
    } else if (target.source === "direct" && this.options.actions?.appendDirectFollowup) {
      await this.options.actions.appendDirectFollowup(target.id, item.text, key);
      const followup = this.options.db.getBridgeTaskFollowupBySourceEvent(`web-task-followup:${key}`);
      return followup?.bridge_task_id === target.id ? followup.followup_id : undefined;
    } else throw new WorkbenchError(501, "原任务续问不可用");
  }

  private deskExecutionId(task: StoredTask, idempotencyKey: string): string | undefined {
    // A worker can finish before Dispatcher returns, clearing active_run_id.
    // The submission receipt is the durable identity; never guess the latest run.
    const receipt = this.options.db.getWebTaskSubmission(idempotencyKey);
    if (receipt) {
      if (receipt.task_guid !== task.task_guid || this.options.db.getRun(receipt.run_id)?.task_guid !== task.task_guid) {
        throw new Error("任务提交凭据与原执行目标不匹配");
      }
      return receipt.run_id;
    }
    return task.active_run_id ?? undefined;
  }

  private async automationInput(body: Record<string, unknown>, partial: boolean, previousTarget?: WorkbenchTarget): Promise<WorkbenchAutomationPatch> {
    const value = { ...body };
    if (value.text !== undefined) { value.prompt = value.text; delete value.text; }
    delete value.title;
    if (value.target !== undefined && value.target !== null) {
      value.target = await this.validateTarget(value.target);
      this.assertQueueSupported(value.target as WorkbenchTarget);
    }
    if (value.projectKey !== undefined && value.projectKey !== null) {
      const project = this.options.db.getAvailableProject(requiredText(value.projectKey, 200));
      if (!project) throw new WorkbenchError(400, "自动化只能使用已登记且启用的项目");
      if (!this.options.actions?.createTask) throw new WorkbenchError(501, "任务创建入口未配置");
    }
    if (!partial) { value.enabled ??= false; value.timeZone ??= "Asia/Shanghai"; }
    if (value.prompt !== undefined) {
      const target = (value.target ?? (value.projectKey ? undefined : previousTarget)) as WorkbenchTarget | undefined;
      value.prompt = requiredText(value.prompt, target?.kind === "task" ? 2_000 : target?.kind === "history" ? 8_000 : 20_000);
    }
    return value as WorkbenchAutomationPatch;
  }

  private async runAutomation(claim: WorkbenchAutomationClaim): Promise<void> {
    try {
      const automation = claim.automation;
      let taskTarget: WorkbenchTarget | undefined;
      let executionId: string | undefined;
      if (automation.target) {
        const target = await this.validateTarget(automation.target);
        this.assertQueueSupported(target);
        this.store.enqueueQueueMessage(target, { text: automation.prompt, idempotencyKey: `automation:${claim.runId}` });
      } else {
        if (!automation.projectKey || !this.options.db.getAvailableProject(automation.projectKey)) throw new Error("自动化项目已停用");
        if (!this.options.actions?.createTask) throw new Error("任务创建入口未配置");
        const task = await this.options.actions.createTask({ projectKey: automation.projectKey, description: automation.prompt,
          idempotencyKey: `automation:${claim.runId}` });
        taskTarget = { kind: "task", source: "desk", id: task.task_guid };
        executionId = this.deskExecutionId(task, `automation:${claim.runId}`);
      }
      this.store.finishAutomationClaim(claim.claimToken, { status: "accepted", ...(taskTarget ? { taskTarget } : {}) });
      if (taskTarget && executionId) this.store.linkAutomationRun(claim.runId, taskTarget, executionId);
      this.reconcileAutomations();
    } catch (error) {
      this.store.finishAutomationClaim(claim.claimToken, { status: "failed", error: message(error) });
    }
  }

  private reconcileAutomations(): void {
    for (const automation of this.store.listAutomations()) for (const run of this.store.listAutomationRuns(automation.id)) {
      const target = run.executionTarget;
      if (!target || !run.executionId || run.executionStatus !== "running") continue;
      let state: string | undefined;
      let error: string | null | undefined;
      if (target.kind === "history") {
        const current = this.options.history?.listWorkbenchRuns().find((item) => item.runId === run.executionId
          && item.homeId === target.homeId && item.threadId === target.id);
        state = current?.state; error = current?.error;
      } else if (target.source === "desk") {
        const current = this.options.db.getRun(run.executionId);
        if (current?.task_guid === target.id) { state = current.state; error = this.options.db.getTask(target.id)?.last_error; }
      } else if (target.source === "direct") {
        const current = this.options.db.getBridgeTaskFollowupById(run.executionId);
        if (current?.bridge_task_id === target.id) { state = current.status; error = current.error; }
      }
      const category = terminalCategory(state);
      if (state === "WAITING_REVIEW" || category === "completion" || category === "failure") {
        this.store.completeAutomationRun(run.id, { status: category === "failure" ? "failed" : "completed",
          ...(target.kind === "task" ? { taskTarget: target } : {}), ...(error ? { error } : {}) });
      }
    }
  }

  private async syncHistory(): Promise<void> {
    this.store.expirePendingActions();
    const history = this.options.history;
    if (!history?.listPendingActions) return;
    const actions = history.listPendingActions();
    const existing = this.store.listPendingActions();
    for (const action of actions) {
      if (action.status !== "pending") continue;
      const target = { kind: "history", homeId: action.homeId, id: action.threadId } as const;
      const stored = this.store.recordPendingAction({ runId: action.runId, requestId: action.id, target,
        type: action.type.includes("Approval") ? "approval" : "question",
        payload: { method: action.type, params: action.payload } });
      if (stored.status === "pending") this.notify(target, "action", `${action.runId}:${action.id}`);
    }
    for (const stored of existing) {
      if (stored.status !== "pending" || stored.target.kind !== "history") continue;
      const target = stored.target;
      const native = actions.find((action) => action.id === stored.requestId && action.runId === stored.runId
        && action.homeId === target.homeId && action.threadId === target.id);
      if (native?.status === "responded") this.store.resolvePendingAction(stored.id, { handledByOriginalRun: true });
      else if (!native || native.status === "expired") this.store.expirePendingAction(stored.id);
    }
    for (const run of history.listWorkbenchRuns()) {
      const category = terminalCategory(run.state);
      if (category) this.notify({ kind: "history", homeId: run.homeId, id: run.threadId }, category, run.runId);
    }
  }

  private async respondAction(id: string, body: Record<string, unknown>): Promise<WorkbenchResult> {
    await this.syncHistory();
    const stored = this.store.listPendingActions().find((action) => action.id === id);
    const history = this.options.history;
    if (!stored || stored.status !== "pending" || stored.expiresAt <= this.now()
      || stored.target.kind !== "history" || !stored.target.homeId || !history) {
      throw new WorkbenchError(409, "审批请求已失效，或所属交互会话不可用");
    }
    const native = history.getPendingActions(stored.target.homeId, stored.target.id)
      .find((action) => action.id === stored.requestId && action.runId === stored.runId && action.status === "pending");
    if (!native) { this.store.expirePendingAction(id); throw new WorkbenchError(409, "原始 Codex 请求已结束"); }
    await history.respondAction(stored.target.homeId, stored.target.id, stored.runId,
      stored.requestId, body as CodexHistoryActionResponse);
    const action = this.store.resolvePendingAction(id, body);
    return { status: 200, body: { ok: true, action: publicAction(action) } };
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.syncHistory();
      this.reconcileAutomations();
      // A crashed sender is displayed as uncertain after the grace window, never silently replayed.
      this.store.markStaleQueueMessagesUnconfirmed(this.now() - 15 * 60_000);
      for (const { target, queuedCount } of this.store.listQueueTargets()) {
        if (this.stopped) break;
        if (!queuedCount) continue;
        await this.dispatchNext(target).catch((error) => this.options.logger?.warn("queue dispatch unavailable", { target: workbenchTargetKey(target), error: message(error) }));
      }
      if (!this.stopped) for (const claim of this.store.claimDueAutomations()) {
        if (this.stopped) { this.store.releaseAutomationClaim(claim.claimToken); continue; }
        await this.runAutomation(claim);
      }
    } finally { this.ticking = false; }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkbenchError(400, "JSON object is required");
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) throw new WorkbenchError(400, `请输入 1–${limit} 字符`);
  return value.trim();
}
function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new WorkbenchError(400, "无效标识"); }
}
function queryTarget(url: URL): WorkbenchTarget {
  return parseWorkbenchTarget(Object.fromEntries(["kind", "source", "homeId", "id"].flatMap((key) => {
    const value = url.searchParams.get(key); return value === null ? [] : [[key, value]];
  })));
}
function publicAutomation(value: WorkbenchAutomation) {
  return { ...value, text: value.prompt, title: value.prompt.split("\n")[0]!.slice(0, 80) };
}
function publicAction(value: WorkbenchPendingAction) {
  return { ...value, method: value.payload.method, params: value.payload.params };
}
function publicMachine(value: WorkbenchMachineProfile, capabilities: string[] = []) {
  return { ...value, status: value.kind === "local" ? "local" : "unconnected",
    capabilities: value.kind === "local" ? capabilities : [],
    ...(value.kind === "remote" ? { limitation: "仅登记地址；尚未配置认证连接和会话迁移协议" } : {}) };
}
function terminalCategory(state: string | undefined): WorkbenchNotificationCategory | undefined {
  if (["SUCCEEDED", "COMPLETED", "completed", "done"].includes(state ?? "")) return "completion";
  if (["FAILED", "CANCELED", "CANCELLED", "failed", "cancelled", "interrupted"].includes(state ?? "")) return "failure";
  if (["WAITING_REVIEW", "BLOCKED_CONFIG"].includes(state ?? "")) return "action";
  return undefined;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
