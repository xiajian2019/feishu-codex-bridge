import { randomUUID } from "node:crypto";

import { StateDatabase } from "./db.js";
import { computeInputHash, parseTaskInput, serializeTaskInput } from "./fingerprint.js";
import {
  buildRunPrompt,
  formatBlockedComment,
  formatCanceledComment,
  formatCompletedComment,
  formatFailedComment,
  formatStartedComment,
  formatDuration,
} from "./prompts.js";
import { routeTask, isLarkTaskCompleted } from "./router.js";
import type { LarkClient } from "./lark.js";
import type {
  BridgeConfig,
  LarkTask,
  Logger,
  StoredTask,
  WorkerHandle,
  WorkerResult,
  WorkerRunner,
} from "./types.js";

interface ActiveRun {
  runId: string;
  taskGuid: string;
  handle: WorkerHandle;
  cancelRequested: boolean;
  timedOut: boolean;
  monitor: Promise<void>;
}

export interface DispatcherOptions {
  db: StateDatabase;
  lark: LarkClient;
  config: BridgeConfig;
  workerRunner: WorkerRunner;
  serviceInstanceId?: string;
  logger?: Logger;
}

export class Dispatcher {
  private readonly db: StateDatabase;
  private readonly lark: LarkClient;
  private readonly config: BridgeConfig;
  private readonly workerRunner: WorkerRunner;
  private readonly serviceInstanceId: string;
  private readonly logger: Logger;
  private readonly queue: string[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly active = new Map<string, ActiveRun>();
  private pumping = false;
  private stopping = false;
  private flushingOutbox = false;

  constructor(options: DispatcherOptions) {
    this.db = options.db;
    this.lark = options.lark;
    this.config = options.config;
    this.workerRunner = options.workerRunner;
    this.serviceInstanceId = options.serviceInstanceId ?? randomUUID();
    this.logger = options.logger ?? consoleLogger;
  }

  public async observe(task: LarkTask): Promise<void> {
    const existing = this.db.getTask(task.guid);

    // Completion is an explicit user action. Handle it before field validation
    // so removing a custom field cannot leave a finished run in RUNNING forever.
    if (isLarkTaskCompleted(task)) {
      if (existing?.state === "RUNNING" || existing?.state === "QUEUED") {
        await this.cancelTask(task.guid, "用户已在飞书完成任务。");
      } else if (existing?.state === "WAITING_REVIEW") {
        this.db.acceptTask(task.guid);
      } else if (
        existing?.state === "DISCOVERED" ||
        existing?.state === "BLOCKED_CONFIG" ||
        existing?.state === "FAILED"
      ) {
        this.db.cancelTask(task.guid, "用户已在飞书完成任务。");
      }
      return;
    }

    const routed = routeTask(task, this.config);
    if (!routed.ok) {
      await this.blockTask(task, routed.problem.message, routed.problem.code);
      return;
    }

    const candidate = routed.task;
    if (
      existing?.thread_id &&
      (existing.project_key !== candidate.projectKey || existing.repo !== candidate.repo)
    ) {
      const message =
        existing.project_key !== candidate.projectKey
          ? `任务已经在项目 ${existing.project_key} 中创建过 Codex thread，不能切换到项目 ${candidate.projectKey} 恢复原 thread。请为新项目创建新任务。`
          : `任务的项目 ${candidate.projectKey} 已映射到不同的本地仓库，不能在原 thread 中继续。请检查配置或新建任务。`;
      await this.cancelTaskIfActive(task.guid, message);
      this.db.recordBlockedConfig({
        taskGuid: task.guid,
        inputHash: existing.input_hash,
        inputText: existing.input_text,
        message,
        preserveProject: true,
        comment: formatBlockedComment(message),
      });
      return;
    }

    const inputText = serializeTaskInput(candidate.input);
    const previousInput = parseTaskInput(existing?.input_text);
    const prompt = buildRunPrompt(
      candidate.input,
      previousInput,
      Boolean(existing?.thread_id),
    );
    if (existing?.state === "RUNNING") {
      // The next poll sees the changed hash again after this run completes, at
      // which point it becomes a same-thread feedback run. Never run two turns
      // for the same task concurrently.
      return;
    }

    if (existing?.state === "QUEUED" && existing.active_run_id) {
      if (existing.input_hash !== candidate.inputHash) {
        const updated = this.db.updateQueuedRun({
          task: candidate,
          inputText,
          promptText: prompt,
          startedComment: "",
        });
        if (updated) {
          this.logger.info("updated queued task input", { taskGuid: task.guid });
        }
      }
      return;
    }

    const inputChanged = !existing || existing.input_hash !== candidate.inputHash;
    const shouldQueue =
      !existing ||
      existing.state === "DISCOVERED" ||
      existing.state === "BLOCKED_CONFIG" ||
      ((existing.state === "WAITING_REVIEW" ||
        existing.state === "FAILED" ||
        existing.state === "ACCEPTED" ||
        existing.state === "CANCELED") && inputChanged);
    if (!shouldQueue) {
      return;
    }

    const claim = this.db.claimRun({
      task: candidate,
      inputText,
      promptText: prompt,
      startedComment: (runId) =>
        formatStartedComment(runId, candidate.projectKey, candidate.sandboxMode),
    });
    if (!claim) {
      return;
    }
    this.queue.push(claim.runId);
    this.queuedRunIds.add(claim.runId);
    await this.pump();
  }

  public async flushOutbox(): Promise<void> {
    if (this.flushingOutbox) return;
    this.flushingOutbox = true;
    try {
      for (const entry of this.db.getDueOutbox()) {
        try {
          const payload = JSON.parse(entry.payload_json) as { content?: unknown };
          if (entry.operation !== "comment" || typeof payload.content !== "string") {
            this.db.markOutboxDelivered(entry.id);
            continue;
          }
          await this.lark.addComment(entry.task_guid, payload.content);
          this.db.markOutboxDelivered(entry.id);
        } catch (error) {
          const attempts = this.db.markOutboxFailed(entry.id);
          this.logger.warn("outbox delivery failed; will retry", {
            taskGuid: entry.task_guid,
            attempts,
            error: safeErrorMessage(error),
          });
        }
      }
    } finally {
      this.flushingOutbox = false;
    }
  }

  /** Interrupt a queued or running task from an explicitly authorized UI action. */
  public async interruptTask(
    taskGuid: string,
    reason = "用户通过 Bridge 看板请求中断本轮执行。",
  ): Promise<boolean> {
    const task = this.db.getTask(taskGuid);
    if (!task || (task.state !== "RUNNING" && task.state !== "QUEUED")) {
      return false;
    }
    await this.cancelTask(taskGuid, reason);
    return true;
  }

  /** Append a feedback block to Feishu and immediately reconcile the task. */
  public async appendFeedback(taskGuid: string, details: string): Promise<StoredTask> {
    const normalized = details.trim();
    if (!normalized) {
      throw new Error("补充内容不能为空。");
    }
    if (normalized.length > 2000) {
      throw new Error("补充内容不能超过 2000 个字符。");
    }
    const existing = this.db.getTask(taskGuid);
    if (!existing) {
      throw new Error(`本地没有任务记录 ${taskGuid}。`);
    }

    const current = await this.lark.getTask(taskGuid);
    if (isLarkTaskCompleted(current)) {
      await this.lark.reopenTask(taskGuid);
    }
    const currentDescription = typeof current.description === "string"
      ? current.description
      : "";
    const feedback = `补充反馈（Bridge 看板）：\n${normalized}`;
    const nextDescription = currentDescription.trim()
      ? `${currentDescription}\n\n${feedback}`
      : feedback;
    if (nextDescription.length > 3000) {
      throw new Error("追加后飞书任务描述超过 3000 个字符，请先精简原描述。");
    }
    await this.lark.updateDescription(taskGuid, nextDescription);
    const refreshed = await this.lark.getTask(taskGuid);
    await this.observe(refreshed);
    const result = this.db.getTask(taskGuid);
    if (!result) {
      throw new Error(`更新后找不到本地任务记录 ${taskGuid}。`);
    }
    return result;
  }

  public recoverInterruptedRuns(): void {
    const recovered = this.db.recoverInterruptedRuns();
    if (recovered.length > 0) {
      this.logger.warn("recovered interrupted Codex runs", { count: recovered.length });
    }
  }

  public async shutdown(): Promise<void> {
    this.stopping = true;
    this.queue.length = 0;
    this.queuedRunIds.clear();
    const activeRuns = [...this.active.values()];
    for (const active of activeRuns) {
      active.cancelRequested = true;
      await active.handle.terminate();
    }
    await Promise.all(activeRuns.map((active) => active.monitor));
  }

  public async waitForIdle(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.active.size === 0 && this.queue.length === 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.active.size === 0 && this.queue.length === 0;
  }

  public get activeRunCount(): number {
    return this.active.size;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      while (!this.stopping && this.active.size < this.config.maxConcurrency) {
        const runId = this.queue.shift();
        if (!runId) break;
        this.queuedRunIds.delete(runId);
        const run = this.db.getRun(runId);
        if (!run || run.state !== "QUEUED") continue;

        let handle: WorkerHandle;
        try {
          handle = this.workerRunner.start(runId);
        } catch (error) {
          const message = safeErrorMessage(error);
          this.db.finishRun(runId, {
            status: "failed",
            error: message,
            comment: formatFailedComment(message),
          });
          this.logger.error("failed to start Codex worker", {
            runId,
            error: message,
          });
          continue;
        }

        if (!this.db.markRunRunning(runId, handle.pid, this.serviceInstanceId)) {
          await handle.terminate();
          continue;
        }

        const active: ActiveRun = {
          runId,
          taskGuid: run.task_guid,
          handle,
          cancelRequested: false,
          timedOut: false,
          monitor: Promise.resolve(),
        };
        this.active.set(runId, active);
        active.monitor = Promise.resolve().then(() => this.monitor(active));
        // An asynchronous worker may finish before this tick returns; the
        // monitor still owns the lifecycle and removes the active entry.
      }
    } finally {
      this.pumping = false;
    }
  }

  private async monitor(active: ActiveRun): Promise<void> {
    let timeoutTimer: NodeJS.Timeout | undefined;
    timeoutTimer = setTimeout(() => {
      active.timedOut = true;
      void active.handle.terminate();
    }, this.config.runTimeoutSeconds * 1000);

    let result: WorkerResult;
    try {
      result = await active.handle.result;
    } catch (error) {
      result = {
        status: "failed",
        error: safeErrorMessage(error),
        errorKind: "crash",
      };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    if (active.timedOut) {
      result = {
        status: "failed",
        error: `Codex worker 超过 ${this.config.runTimeoutSeconds} 秒运行上限。`,
        errorKind: "timeout",
      };
    } else if (active.cancelRequested || result.status === "canceled") {
      result = {
        ...result,
        status: "canceled",
        error: result.error ?? "用户取消了本轮执行。",
        errorKind: "canceled",
      };
    }

    if (result.threadId) {
      this.db.saveThreadId(active.runId, result.threadId);
    }
    const run = this.db.getRun(active.runId);
    const task = this.db.getTask(active.taskGuid);
    if (run && task) {
      if (result.status === "succeeded") {
        const threadId = result.threadId ?? run.thread_id ?? task.thread_id;
        const comment = formatCompletedComment({
          runId: active.runId,
          projectKey: task.project_key,
          finalResponse: result.finalResponse ?? "",
          threadId,
          duration: formatDuration(run.started_at),
        });
        this.db.finishRun(active.runId, {
          status: "succeeded",
          finalResponse: result.finalResponse,
          usage: result.usage,
          comment,
        });
      } else if (result.status === "canceled") {
        this.db.finishRun(active.runId, {
          status: "canceled",
          error: result.error,
          comment: active.cancelRequested
            ? formatCanceledComment(result.error ?? "用户取消了本轮执行。", active.runId)
            : undefined,
        });
      } else {
        const error = result.error ?? "Codex worker 未提供错误信息。";
        this.db.finishRun(active.runId, {
          status: "failed",
          error,
          comment: formatFailedComment(error, result.errorKind === "proxy"),
        });
      }
    }

    this.active.delete(active.runId);
    await this.pump();
  }

  private async blockTask(
    task: LarkTask,
    message: string,
    problemCode: string,
  ): Promise<void> {
    const existing = this.db.getTask(task.guid);
    if (existing?.state === "RUNNING" || existing?.state === "QUEUED") {
      await this.cancelTask(task.guid, message);
    }
    const preserveProject = Boolean(existing?.thread_id);
    const input = {
      projectKey: preserveProject ? existing?.project_key ?? problemCode : problemCode,
      mode: preserveProject ? existing?.mode ?? "" : "",
      summary: typeof task.summary === "string" ? task.summary : "",
      description: typeof task.description === "string" ? task.description : "",
    };
    this.db.recordBlockedConfig({
      taskGuid: task.guid,
      projectKey: input.projectKey,
      mode: input.mode,
      repo: existing?.repo,
      inputHash: preserveProject && existing ? existing.input_hash : computeInputHash(input),
      inputText: preserveProject && existing ? existing.input_text : serializeTaskInput(input),
      message,
      preserveProject,
      comment: formatBlockedComment(message),
    });
  }

  private async cancelTaskIfActive(taskGuid: string, reason: string): Promise<void> {
    const existing = this.db.getTask(taskGuid);
    if (existing?.state === "RUNNING" || existing?.state === "QUEUED") {
      await this.cancelTask(taskGuid, reason);
    }
  }

  private async cancelTask(taskGuid: string, reason: string): Promise<void> {
    const task = this.db.getTask(taskGuid);
    const active = task?.active_run_id ? this.active.get(task.active_run_id) : undefined;
    // Mark the database first. A worker can finish between any two awaits; the
    // monitor must then observe CANCELED and never turn the task back into
    // WAITING_REVIEW.
    const runId = this.db.cancelTask(taskGuid, reason);
    if (runId) {
      this.removeQueuedRun(runId);
    }
    if (active) {
      active.cancelRequested = true;
      await active.handle.terminate();
    } else if (runId) {
      // A queued run has no monitor to emit the cancellation comment.
      this.db.enqueueComment(taskGuid, formatCanceledComment(reason, runId));
    }
  }

  private removeQueuedRun(runId: string): void {
    if (!this.queuedRunIds.has(runId)) return;
    this.queuedRunIds.delete(runId);
    const index = this.queue.indexOf(runId);
    if (index >= 0) this.queue.splice(index, 1);
  }
}

const consoleLogger: Logger = {
  info(message, details) {
    console.info(message, details ?? "");
  },
  warn(message, details) {
    console.warn(message, details ?? "");
  },
  error(message, details) {
    console.error(message, details ?? "");
  },
};

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(access[_-]?token|app[_-]?secret|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}
