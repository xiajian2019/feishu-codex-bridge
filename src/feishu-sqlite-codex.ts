import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Codex, type Input, type UserInput } from "@openai/codex-sdk";
import {
  createLarkChannel,
  type CardActionEvent,
  Domain,
  type LarkChannel,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";

import {
  AAMP_COMMAND_ACTION_KIND,
  AAMP_TASK_CANCEL_ACTION_KIND,
  AAMP_TASK_HIDE_ACTION_KIND,
  GLOBAL_TASK_MODES,
  buildCommandCard,
  compactGlobalCard,
  buildDirectInfoCard,
  buildRecentCard,
  readAampCanonicalTaskStates,
  readCommandActionValue,
  type GlobalCardRuntime,
  type GlobalCommand,
} from "../scripts/aamp-command-patch.mjs";

import { isDirectExecutionMode } from "./config.js";
import { readProjectMap, resolveMappedProject } from "./project-map.js";
import type { StateDatabase } from "./db.js";
import {
  resolveSharedFeishuCredentials,
  type FeishuCredentialResolutionOptions,
} from "./feishu-credentials.js";
import type {
  BridgeConfig,
  DirectAttachmentInput,
  DirectAttachmentType,
  DirectMessageInput,
  DirectPermissionRule,
  Logger,
  ModeConfig,
  ProjectConfig,
  StoredBridgeTask,
  StoredBridgeTaskAttachment,
  StoredAampTask,
} from "./types.js";

interface TextOutboxPayload {
  chatId: string;
  text: string;
  replyTo?: string;
}

interface StreamCardOutboxPayload {
  bridgeTaskId: string;
  chatId: string;
  replyTo?: string;
}

interface CommandCardOutboxPayload {
  chatId: string;
  card: object;
}

export interface DirectRuntimeOptions {
  db: StateDatabase;
  logger: Logger;
  attachmentsDir?: string;
}

export interface DirectPermissionContext {
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
}

export type DirectPermissionKind = "message" | "attachment" | "cancel";

export interface DirectPermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface DirectPromptAttachment {
  type: DirectAttachmentType;
  fileName: string;
  localPath: string;
}

export interface ParsedDirectTaskRoute {
  projectKey?: string;
  modeKey?: string;
}

export type DirectTaskRouteResult =
  | {
      ok: true;
      projectKey: string;
      modeKey: string;
      project: ProjectConfig;
      mode: ModeConfig;
    }
  | { ok: false; message: string };

type DirectControlCommand = "help" | "status" | "recent" | "task" | "usage"
  | "thread" | "resume" | "retry" | "queue" | "progress" | "events"
  | "changes" | "commands" | "tools";
type DirectDetailCommand = "thread" | "resume" | "retry" | "queue" | "progress" | "events" | "changes" | "commands" | "tools";

export const DIRECT_RUNTIME_LEASE_NAME = "direct-codex-runtime";
const RUNTIME_LEASE_MS = 30_000;
const RUNTIME_HEARTBEAT_MS = 10_000;
const TASK_LEASE_MS = 120_000;
const TASK_HEARTBEAT_MS = 15_000;
const CARD_POLL_MS = 250;
const CARD_MAX_FAILURE_ATTEMPTS = 3;
const CARD_CONTENT_LIMIT = 28_000;

/**
 * Small direct runtime for the personal Feishu workflow.
 *
 * Feishu's channel SDK owns only the WebSocket transport and message API.
 * SQLite owns delivery deduplication, task leasing, progress, card state,
 * attachment metadata, and the durable outbound queue. Codex SDK owns the
 * actual agent turn.
 */
export class FeishuSqliteCodexRuntime {
  private readonly config: BridgeConfig;
  private readonly db: StateDatabase;
  private readonly logger: Logger;
  private readonly workerId = `feishu-codex-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly codex: Codex;
  private readonly attachmentsDir: string;
  private readonly stopped: Promise<void>;
  private readonly activeCardDeliveries = new Map<number, Promise<void>>();
  private resolveStopped: (() => void) | undefined;
  private channel: LarkChannel | undefined;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private pumpPromise: Promise<void> | undefined;
  private activeAbortController: AbortController | undefined;
  private activeTaskId: string | undefined;
  private runtimeLeaseTimer: ReturnType<typeof setInterval> | undefined;
  private pumping = false;
  private started = false;
  private stopping = false;
  private runtimeLeaseLost = false;
  private activeTaskLeaseLost = false;
  private startedAt: string | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(config: BridgeConfig, options: DirectRuntimeOptions) {
    if (!isDirectExecutionMode(config.execution.mode)) {
      throw new Error(
        `FeishuSqliteCodexRuntime cannot start with execution.mode=${config.execution.mode}`,
      );
    }
    this.config = config;
    this.db = options.db;
    this.logger = options.logger;
    this.attachmentsDir = resolve(
      options.attachmentsDir ?? join(process.cwd(), "runtime", "direct", "attachments"),
    );
    this.codex = new Codex({
      codexPathOverride: config.codex.cliPath,
      env: buildDirectCodexEnvironment(config),
    });
    this.stopped = new Promise<void>((resolvePromise) => {
      this.resolveStopped = resolvePromise;
    });
  }

  public async start(): Promise<void> {
    if (this.started) return;
    const credentials = resolveSharedFeishuCredentials(this.config);
    if (!this.db.acquireRuntimeLease(DIRECT_RUNTIME_LEASE_NAME, this.workerId, RUNTIME_LEASE_MS)) {
      throw new Error("已有另一个直连 Feishu/Codex runtime 正在使用同一个 SQLite 数据库");
    }
    try {
      const recovery = this.db.recoverExpiredBridgeTasks(true);
      if (recovery.requeued > 0 || recovery.cancelled > 0) {
        this.logger.warn("direct runtime recovered unfinished tasks", { ...recovery });
      }
      const backfilledCards = this.db.ensureDirectCardOutboxes();
      if (backfilledCards > 0) {
        this.logger.info("direct runtime backfilled card outboxes", { count: backfilledCards });
      }
      this.runtimeLeaseTimer = setInterval(() => {
        if (this.stopping) return;
        if (!this.db.renewRuntimeLease(DIRECT_RUNTIME_LEASE_NAME, this.workerId, RUNTIME_LEASE_MS)) {
          this.runtimeLeaseLost = true;
          this.logger.error("direct runtime lease was lost; stopping this worker");
          this.activeAbortController?.abort();
          void this.stop();
        }
      }, RUNTIME_HEARTBEAT_MS);

      this.channel = createLarkChannel({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        transport: "websocket",
        // The SDK's default chat pipeline batches nearby messages. Direct mode
        // needs one SQLite task per Feishu message, so batching is disabled and
        // serialization is handled by bridge_tasks instead.
        safety: { chatQueue: { enabled: false } },
        policy: {
          groupAllowlist: this.config.direct.feishu.groupAllowlist,
          dmMode: this.config.direct.feishu.dmMode,
          dmAllowlist: this.config.direct.feishu.dmAllowlist,
          requireMention: this.config.direct.feishu.requireMention,
        },
        outbound: {
          streamThrottleMs: 250,
          streamThrottleChars: 80,
          streamInitialText: "正在连接 Codex…",
        },
        domain: resolveDirectLarkDomain(this.config.direct.feishu.domain, credentials.tenantBrand),
        source: "feishu-codex-bridge",
        handshakeTimeoutMs: 30_000,
        wsConfig: { pingTimeout: 90_000 },
        includeRawEvent: true,
      });
      this.channel.on("message", (message) => {
        void this.handleMessage(message).catch((error) => {
          this.logger.error("failed to persist direct Feishu message", {
            error: sanitizeError(error instanceof Error ? error.message : String(error)),
          });
        });
      });
      this.channel.on("cardAction", (event) => {
        void this.handleGlobalCardAction(event).catch((error) => {
          this.logger.error("failed to handle global task card action", {
            error: sanitizeError(error instanceof Error ? error.message : String(error)),
          });
        });
      });
      this.channel.on("error", (error) => {
        this.logger.error("Feishu channel error", {
          code: error.code,
          error: error.message,
        });
      });
      this.channel.on("reconnecting", () => {
        this.logger.warn("Feishu channel reconnecting");
      });
      this.channel.on("reconnected", () => {
        this.logger.info("Feishu channel reconnected");
        this.schedulePump(0);
      });

      await this.channel.connect();
      this.started = true;
      this.startedAt = new Date().toISOString();
      this.logger.info("direct Feishu channel connected", {
        mode: this.config.execution.mode,
        project: this.config.direct.projectKey ?? "按任务选择",
        codexMode: this.config.direct.mode ?? "按任务选择",
        workerId: this.workerId,
      });
      this.schedulePump(0);
    } catch (error) {
      if (this.runtimeLeaseTimer) {
        clearInterval(this.runtimeLeaseTimer);
        this.runtimeLeaseTimer = undefined;
      }
      this.db.releaseRuntimeLease(DIRECT_RUNTIME_LEASE_NAME, this.workerId);
      throw error;
    }
  }

  public async waitUntilStopped(): Promise<void> {
    await this.stopped;
  }

  /** Drain the currently due direct queue once; useful for `--once` and smoke tests. */
  public async runOnce(): Promise<void> {
    if (!this.started) throw new Error("direct runtime must be started before runOnce()");
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    if (this.pumpPromise) await this.pumpPromise;
    else await this.pump();
    await Promise.allSettled([...this.activeCardDeliveries.values()]);
    await this.flushOutbox();
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
  }

  public async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    if (this.runtimeLeaseTimer) {
      clearInterval(this.runtimeLeaseTimer);
      this.runtimeLeaseTimer = undefined;
    }
    this.activeAbortController?.abort();
    try {
      await this.pumpPromise;
    } catch (error) {
      this.logger.warn("direct runtime pump stopped with an error", {
        error: sanitizeError(error instanceof Error ? error.message : String(error)),
      });
    }
    // Card producers observe `stopping` and exit on their next poll. Wait for
    // them before closing SQLite; an in-flight task/card outbox remains
    // undelivered and is recovered on the next process start.
    await Promise.allSettled([...this.activeCardDeliveries.values()]);
    await this.channel?.disconnect().catch((error) => {
      this.logger.warn("failed to disconnect Feishu channel", {
        error: sanitizeError(error instanceof Error ? error.message : String(error)),
      });
    });
    this.db.releaseRuntimeLease(DIRECT_RUNTIME_LEASE_NAME, this.workerId);
    this.resolveStopped?.();
  }

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    if (this.stopping) return;
    if (this.channel?.botIdentity?.openId === message.senderId || isBotMessage(message)) {
      return;
    }
    const attachments = normalizeAttachments(message);
    if (message.rawContentType !== "text" && attachments.length === 0) return;
    const text = message.content.trim();
    if (!text && attachments.length === 0) return;

    const allowedSenders = this.config.direct.feishu.allowedSenderOpenIds;
    if (allowedSenders.length > 0 && !allowedSenders.includes(message.senderId)) {
      this.logger.warn("direct Feishu message ignored by sender allowlist", {
        messageId: message.messageId,
        senderId: message.senderId,
      });
      return;
    }

    const input = toDirectMessageInput(message, text || "请处理这条附件中的内容。", attachments);
    const messagePermission = evaluateDirectPermission(this.config, input, "message");
    if (!messagePermission.allowed) {
      this.persistControlReply(input, `当前用户或会话没有权限使用 Codex：${messagePermission.reason ?? "未授权"}`);
      return;
    }
    if (attachments.length > 0) {
      const attachmentPermission = evaluateDirectPermission(this.config, input, "attachment");
      if (!attachmentPermission.allowed) {
        this.persistControlReply(input, `当前权限不允许处理附件：${attachmentPermission.reason ?? "附件能力未开启"}`);
        return;
      }
    }

    const cancelCommand = parseCancelCommand(text);
    if (cancelCommand) {
      const cancelPermission = evaluateDirectPermission(this.config, input, "cancel");
      if (!cancelPermission.allowed) {
        this.persistControlReply(input, `当前权限不允许取消任务：${cancelPermission.reason ?? "取消能力未开启"}`);
        return;
      }
      this.handleCancelCommand(input, cancelCommand.taskId);
      return;
    }

    const controlCommand = parseDirectControlCommand(text);
    if (controlCommand) {
      await this.handleDirectControlCommand(input, controlCommand.command, controlCommand.argument);
      return;
    }

    const result = this.db.ingestDirectMessage(input);
    if (result.created) {
      this.logger.info("direct Feishu message persisted", {
        bridgeTaskId: result.task.bridge_task_id,
        messageId: message.messageId,
        attachmentCount: attachments.length,
        continued: result.continued ?? false,
      });
    }
    this.schedulePump(0);
  }

  private persistControlReply(input: DirectMessageInput, text: string): void {
    this.db.ingestDirectControl(input, text);
    this.schedulePump(0);
  }

  private handleCancelCommand(input: DirectMessageInput, explicitTaskId?: string): void {
    let task = explicitTaskId
      ? this.db.getBridgeTask(explicitTaskId)
      : this.db.getActiveBridgeTaskForSession(input.sessionKey);
    if (task && (task.chat_id !== input.chatId || task.sender_id !== input.senderId)) {
      task = null;
    }
    if (!task) {
      this.persistControlReply(input, "当前会话没有可取消的 Codex 任务。");
      return;
    }
    const updated = this.db.requestBridgeTaskCancellation(task.bridge_task_id);
    if (!updated) {
      this.persistControlReply(input, "取消请求未能写入任务状态，请稍后重试。");
      return;
    }
    const response = updated.status === "CANCELLED"
      ? "已取消尚未开始执行的任务。"
      : updated.status === "CANCEL_REQUESTED"
        ? "已请求取消当前 Codex 任务，正在等待运行中的进程退出。"
        : "该任务已经结束，无需取消。";
    this.persistControlReply(input, response);
    if (this.activeTaskId === updated.bridge_task_id) {
      this.activeAbortController?.abort();
    }
    this.schedulePump(0);
  }

  private async handleDirectControlCommand(
    input: DirectMessageInput,
    command: DirectControlCommand,
    argument?: string,
  ): Promise<void> {
    if (isDirectDetailCommand(command)) {
      const card = this.buildDirectDetailCommandCard(input, command, argument);
      if (this.db.ingestDirectControlCard(input, card)) this.schedulePump(0);
      return;
    }
    const globalCommand: GlobalCommand = {
      command: command === "task" ? "tasks" : command,
      args: argument ? [argument] : [],
      raw: `/${command}${argument ? ` ${argument}` : ""}`,
    };
    const card = buildCommandCard(this.globalCardRuntime(), input.chatId, globalCommand);
    if (this.db.ingestDirectControlCard(input, card)) this.schedulePump(0);
  }

  private buildDirectDetailCommandCard(
    input: DirectMessageInput,
    command: DirectControlCommand,
    argument?: string,
  ): object {
    if (["resume", "retry", "events", "changes", "commands", "tools"].includes(command)
      && !argument?.trim()) {
      return buildDirectInfoCard(this.globalCardRuntime(), `直连 /${command}`, [`用法：/${command} <任务ID${command === "resume" ? "或 thread ID" : ""}>`]);
    }
    const task = this.resolveDirectCommandTask(input.chatId, argument, command === "thread");
    if (command === "thread") {
      const route = task ? resolveDirectTaskRoute(task.text, this.config) : undefined;
      return buildDirectInfoCard(this.globalCardRuntime(), "当前 Codex thread", [
        `Thread ID：${task?.thread_id ?? "暂无"}`,
        `项目：${route?.ok ? route.projectKey : "暂无"}`,
        `模式：${route?.ok ? route.modeKey : "暂无"}`,
        `最近任务：${task?.bridge_task_id ?? "暂无"}`,
      ]);
    }
    if (command === "queue") {
      const tasks = this.db.listBridgeTasks({ chatId: input.chatId, limit: 200, offset: 0 }).items
        .filter((item) => ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(item.status));
      return buildDirectInfoCard(this.globalCardRuntime(), "直连任务队列", tasks.length > 0
        ? tasks.map((item) => `${directTaskStatusLabel(item.status)} · ${item.bridge_task_id}`)
        : ["当前没有排队、运行中或待取消的直连任务。"]);
    }
    if (command === "resume") {
      if (!task) return buildDirectInfoCard(this.globalCardRuntime(), "恢复历史 thread", ["未找到当前会话中的直连任务或 thread ID。"]);
      if (!task.thread_id) return buildDirectInfoCard(this.globalCardRuntime(), "恢复历史 thread", ["该任务没有已保存的 Codex thread ID，无法恢复。"]);
      const route = resolveDirectTaskRoute(task.text, this.config);
      if (!route.ok) return buildDirectInfoCard(this.globalCardRuntime(), "恢复历史 thread", [route.message]);
      const resumeText = [`项目：${route.projectKey}`, `模式：${route.modeKey}`, "", "请继续处理上一个任务。"].join("\n");
      const resumed = this.db.ingestDirectMessage({
        ...input,
        sourceEventId: `${input.sourceEventId}:resume:${randomUUID()}`,
        messageId: `${input.messageId}:resume:${randomUUID()}`,
        text: resumeText,
      });
      if (resumed.created) {
        this.db.saveBridgeThreadId(resumed.task.bridge_task_id, task.thread_id);
        this.schedulePump(0);
      }
      return buildDirectInfoCard(this.globalCardRuntime(), "恢复历史 thread", [
        `原 thread：${task.thread_id}`,
        resumed.created ? `已重新排队任务：${resumed.task.bridge_task_id}` : "恢复请求已去重。",
      ]);
    }
    if (command === "retry") {
      if (!task) return buildDirectInfoCard(this.globalCardRuntime(), "重试直连任务", ["未找到当前会话中的直连任务。"]);
      const retried = this.db.retryBridgeTask(task.bridge_task_id, "飞书 /retry 命令请求重试。");
      if (!retried) return buildDirectInfoCard(this.globalCardRuntime(), "重试直连任务", [`任务当前状态为 ${task.status}，只有失败或已取消任务可以重试。`]);
      this.schedulePump(0);
      return buildDirectInfoCard(this.globalCardRuntime(), "重试直连任务", [`已重新排队：${retried.bridge_task_id}`]);
    }
    if (!task) return buildDirectInfoCard(this.globalCardRuntime(), `直连 /${command}`, ["未找到当前会话中的直连任务。"]);
    if (command === "progress") {
      return buildDirectInfoCard(this.globalCardRuntime(), "最新执行进度", [
        `任务：${task.bridge_task_id}`,
        `状态：${directTaskStatusLabel(task.status)}`,
        `事件：${task.last_progress_event ?? "暂无"}`,
        `时间：${task.last_progress_at ?? "暂无"}`,
        `进度：${task.last_progress_text ?? "暂无进度"}`,
      ]);
    }
    if (command === "events") {
      const events = this.db.listBridgeTaskEvents(task.bridge_task_id, 80);
      return buildDirectInfoCard(this.globalCardRuntime(), "Codex 事件时间线", events.length > 0
        ? events.map((event) => `${event.created_at} · ${event.event_type}${eventSummary(event.payload_json)}`)
        : ["该任务暂无 Codex 事件记录。"]);
    }
    const events = this.db.listBridgeTaskEvents(task.bridge_task_id, 500);
    const filtered = events.filter((event) => eventMatchesCommand(event.payload_json, command));
    const title = command === "changes" ? "Codex 文件变更" : command === "commands" ? "Shell 命令记录" : "MCP 工具调用记录";
    return buildDirectInfoCard(this.globalCardRuntime(), title, filtered.length > 0
      ? filtered.map((event) => `${event.created_at} · ${event.event_type}${eventSummary(event.payload_json)}`)
      : ["该任务暂无匹配记录。"]);
  }

  private resolveDirectCommandTask(
    chatId: string,
    selector: string | undefined,
    preferActive: boolean,
  ): StoredBridgeTask | null {
    const tasks = this.db.listBridgeTasks({ chatId, limit: 200, offset: 0 }).items;
    const normalized = selector?.trim();
    if (normalized) {
      return tasks.find((task) => task.bridge_task_id === normalized || task.bridge_task_id.startsWith(normalized) || task.thread_id === normalized) ?? null;
    }
    if (preferActive) {
      return tasks.find((task) => ["RUNNING", "QUEUED", "CANCEL_REQUESTED"].includes(task.status) && task.thread_id)
        ?? tasks.find((task) => task.thread_id) ?? null;
    }
    return tasks.find((task) => task.thread_id) ?? tasks[0] ?? null;
  }

  private globalCardRuntime(): GlobalCardRuntime {
    return {
      globalTaskMode: GLOBAL_TASK_MODES.DIRECT,
      state: {
        connectivity: {
          feishu: this.started && !this.stopping ? "connected" : "disconnected",
          aamp: "disconnected",
        },
        lastStartedAt: this.startedAt,
      },
      config: {
        projects: Object.keys(this.config.projects),
        modes: Object.keys(this.config.modes),
      },
      listGlobalTasks: (chatId) => this.listGlobalCardTasks(chatId),
      getGlobalHiddenTaskIds: (chatId) => this.db.getGlobalHiddenTaskIds(chatId),
      hideGlobalTask: (taskId, chatId) => this.db.hideGlobalTask(taskId, chatId),
    };
  }

  private listGlobalCardTasks(chatId: string): unknown[] {
    const canonicalAampTasks = readAampCanonicalTaskStates();
    const directTasks = this.db
      .listBridgeTasks({ chatId, limit: 200, offset: 0 })
      .items
      .map(globalDirectTask);
    const aampTasks = this.db
      .listAampTasks({ chatId, limit: 200, offset: 0 })
      .items
      .map((task) => globalAampTask(task, canonicalAampTasks[task.aamp_task_id]));
    return [...directTasks, ...aampTasks]
      .sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
  }

  private async handleGlobalCardAction(event: CardActionEvent): Promise<void> {
    if (!this.channel) return;
    const value = readCommandActionValue(event);
    if (!value) return;
    const kind = stringValue(value?.kind);
    if (kind === AAMP_COMMAND_ACTION_KIND) {
      const command = normalizeGlobalCommand(value);
      if (!command) return;
      if (isDirectDetailCommand(command.command)) {
        const input = directInputFromCardAction(event, command);
        await this.channel.send(event.chatId, {
          card: this.buildDirectDetailCommandCard(input, command.command, command.args[0]),
        });
        return;
      }
      await this.channel.send(event.chatId, {
        card: buildCommandCard(this.globalCardRuntime(), event.chatId, command),
      });
      return;
    }
    if (kind === AAMP_TASK_HIDE_ACTION_KIND) {
      const taskId = stringValue(value?.taskId);
      const sourceMode = stringValue(value?.sourceMode);
      const task = this.listGlobalCardTasks(event.chatId).find((candidate) => {
        const record = asRecord(candidate);
        return record.taskId === taskId && record.sourceMode === sourceMode;
      });
      if (!taskId || !task) return;
      this.db.hideGlobalTask(taskId, event.chatId);
      await this.channel.updateCard(
        event.messageId,
        buildRecentCard(this.globalCardRuntime(), event.chatId),
      );
      return;
    }
    if (kind !== AAMP_TASK_CANCEL_ACTION_KIND) return;
    if (stringValue(value?.sourceMode) !== GLOBAL_TASK_MODES.DIRECT) {
      this.logger.warn("ignored cross-mode task cancellation from direct runtime", {
        taskId: stringValue(value?.taskId),
        sourceMode: stringValue(value?.sourceMode),
      });
      return;
    }
    const taskId = stringValue(value?.taskId);
    const task = taskId ? this.db.getBridgeTask(taskId) : null;
    if (!task || task.chat_id !== event.chatId || task.sender_id !== event.operator.openId) return;
    const permission = evaluateDirectPermission(this.config, {
      chatId: task.chat_id,
      chatType: task.chat_type,
      senderId: event.operator.openId,
    }, "cancel");
    if (!permission.allowed) return;
    const updated = this.db.requestBridgeTaskCancellation(task.bridge_task_id);
    if (updated && this.activeTaskId === updated.bridge_task_id) this.activeAbortController?.abort();
    this.schedulePump(0);
    await this.channel.updateCard(
      event.messageId,
      buildRecentCard(this.globalCardRuntime(), event.chatId),
    );
  }

  private schedulePump(delayMs: number): void {
    if (this.stopping || this.pumpTimer || this.pumping) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pumpPromise = this.pump()
        .catch((error) => {
          this.logger.error("direct runtime pump failed", {
            error: sanitizeError(error instanceof Error ? error.message : String(error)),
          });
        })
        .finally(() => {
          this.pumpPromise = undefined;
        });
    }, Math.max(0, delayMs));
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      while (!this.stopping) {
        await this.flushOutbox();
        const task = this.db.claimDueBridgeTask(this.workerId, TASK_LEASE_MS);
        if (!task) break;
        await this.processTask(task);
      }
      await this.flushOutbox();
    } finally {
      this.pumping = false;
      if (!this.stopping) this.schedulePump(500);
    }
  }

  private async processTask(task: StoredBridgeTask): Promise<void> {
    const current = this.db.getBridgeTask(task.bridge_task_id);
    if (!current || current.lease_owner !== this.workerId) return;
    if (current.status === "CANCELLED") return;
    if (current.status === "CANCEL_REQUESTED") {
      this.db.finishBridgeTaskTurn(
        task.bridge_task_id,
        undefined,
        "FAILED",
        undefined,
        "用户请求取消。",
        this.workerId,
      );
      return;
    }

    // A task may contain several Feishu messages. The root message is the
    // first turn; once its Codex thread exists, replies are claimed in FIFO
    // order as follow-up turns on the same task.
    const followupCandidate = current.thread_id
      ? this.db.getNextBridgeTaskFollowup(task.bridge_task_id)
      : null;
    const followup = followupCandidate
      ? this.db.claimBridgeTaskFollowup(followupCandidate.followup_id)
      : null;
    const route = followup
      ? resolveDirectContinuationRoute(followup.text, current.text, this.config)
      : resolveDirectTaskRoute(current.text, this.config);
    if (!route.ok) {
      this.db.finishBridgeTaskTurn(
        task.bridge_task_id,
        followup?.followup_id,
        "FAILED",
        undefined,
        route.message,
        this.workerId,
      );
      return;
    }
    const { projectKey, modeKey, project, mode } = route;

    const controller = new AbortController();
    this.activeAbortController = controller;
    this.activeTaskId = task.bridge_task_id;
    this.activeTaskLeaseLost = false;
    const taskLeaseTimer = setInterval(() => {
      if (this.stopping || controller.signal.aborted) return;
      if (!this.db.renewBridgeTaskLease(task.bridge_task_id, this.workerId, TASK_LEASE_MS)) {
        this.activeTaskLeaseLost = true;
        this.logger.error("direct task lease was lost; Codex turn will be abandoned", {
          bridgeTaskId: task.bridge_task_id,
        });
        controller.abort();
      }
    }, TASK_HEARTBEAT_MS);
    const cancellationTimer = setInterval(() => {
      if (this.stopping || controller.signal.aborted) return;
      const currentTask = this.db.getBridgeTask(task.bridge_task_id);
      if (currentTask?.status === "CANCEL_REQUESTED") {
        this.logger.info("direct Codex cancellation observed from SQLite", {
          bridgeTaskId: task.bridge_task_id,
        });
        controller.abort();
      }
    }, 500);
    const timeout = setTimeout(() => controller.abort(), this.config.runTimeoutSeconds * 1000);

    try {
      const downloadedAttachments = await this.prepareTaskAttachments(task, followup?.followup_id);
      const attachmentDirectory = downloadedAttachments.length > 0
        ? join(this.attachmentsDir, task.bridge_task_id)
        : undefined;
      const threadOptions = {
        workingDirectory: project.repo,
        sandboxMode: mode.sandboxMode,
        approvalPolicy: "never" as const,
        ...(attachmentDirectory ? { additionalDirectories: [attachmentDirectory] } : {}),
      };
      const previousTask = this.db.getLatestBridgeTaskForSession(
        task.session_key,
        task.bridge_task_id,
      );
      const previousRoute = previousTask
        ? resolveDirectTaskRoute(previousTask.text, this.config)
        : undefined;
      const canResumePreviousThread = Boolean(
        previousTask?.thread_id
        && previousRoute?.ok
        && previousRoute.project.repo === project.repo
        && previousRoute.mode.sandboxMode === mode.sandboxMode,
      );
      // An explicitly persisted thread belongs to this task and is safe to
      // recover. For a new message, resume only when the previous message was
      // routed to the same repository and sandbox; otherwise start a new
      // Codex thread instead of crossing project boundaries.
      const threadId = task.thread_id
        ?? (canResumePreviousThread ? previousTask!.thread_id : null);
      if (threadId && !task.thread_id) {
        this.db.saveBridgeThreadId(task.bridge_task_id, threadId, this.workerId);
      }
      const thread = threadId
        ? this.codex.resumeThread(threadId, threadOptions)
        : this.codex.startThread(threadOptions);
      const prompt = buildDirectPrompt({
        projectKey,
        modeKey,
        repo: project.repo,
        sandboxMode: mode.sandboxMode,
        text: followup?.text ?? task.text,
        sessionKey: task.session_key,
        attachments: downloadedAttachments.map((attachment) => ({
          type: attachment.type,
          fileName: attachment.file_name ?? attachment.file_key,
          localPath: attachment.local_path!,
        })),
      });
      const codexInput = makeCodexInput(prompt, downloadedAttachments);
      this.db.recordBridgeTaskProgress(
        task.bridge_task_id,
        "codex.started",
        downloadedAttachments.length > 0
          ? `Codex 已启动，已准备 ${downloadedAttachments.length} 个附件。`
          : "Codex 已启动，等待执行事件。",
        {},
        this.workerId,
      );
      const { events } = await thread.runStreamed(codexInput, { signal: controller.signal });
      let finalResponse = "";
      for await (const rawEvent of events) {
        const event = asRecord(rawEvent);
        const eventType = typeof event.type === "string" ? event.type : "codex.event";
        if (eventType === "thread.started" && typeof event.thread_id === "string") {
          this.db.saveBridgeThreadId(task.bridge_task_id, event.thread_id, this.workerId);
        }
        if (eventType === "item.completed") {
          const item = asRecord(event.item);
          if (item.type === "agent_message" && typeof item.text === "string") {
            finalResponse = item.text;
          }
        }
        if (eventType === "turn.failed") {
          const error = asRecord(event.error);
          throw new Error(
            typeof error.message === "string" ? error.message : "Codex turn failed",
          );
        }
        if (eventType === "error") {
          throw new Error(
            typeof event.message === "string"
              ? event.message
              : "Codex event stream failed",
          );
        }
        const progress = summarizeCodexEvent(event);
        this.db.recordBridgeTaskProgress(
          task.bridge_task_id,
          eventType,
          progress,
          event,
          this.workerId,
        );
      }
      if (thread.id) this.db.saveBridgeThreadId(task.bridge_task_id, thread.id, this.workerId);
      if (controller.signal.aborted) {
        throw new Error(
          this.stopping
            ? "桥接服务正在停止，Codex 运行已中止。"
            : this.activeTaskLeaseLost || this.runtimeLeaseLost
              ? "Codex 运行租约已丢失。"
              : "Codex 运行超时。",
        );
      }
      this.db.finishBridgeTaskTurn(
        task.bridge_task_id,
        followup?.followup_id,
        "SUCCEEDED",
        finalResponse,
        undefined,
        this.workerId,
      );
    } catch (error) {
      const message = sanitizeError(error instanceof Error ? error.message : String(error));
      const currentTask = this.db.getBridgeTask(task.bridge_task_id);
      if (this.stopping && currentTask?.status === "RUNNING") {
        this.db.requeueBridgeTask(task.bridge_task_id, this.workerId);
      } else if (this.runtimeLeaseLost || this.activeTaskLeaseLost) {
        // A new process may already own the runtime. Do not let this stale
        // worker write a terminal result over the replacement worker's task.
        this.logger.warn("direct Codex task abandoned after lease loss", {
          bridgeTaskId: task.bridge_task_id,
          error: message,
        });
      } else {
        this.db.finishBridgeTaskTurn(
          task.bridge_task_id,
          followup?.followup_id,
          currentTask?.status === "CANCEL_REQUESTED" ? "CANCELLED" : "FAILED",
          undefined,
          message,
          this.workerId,
        );
        this.logger.error("direct Codex task failed", {
          bridgeTaskId: task.bridge_task_id,
          error: message,
        });
      }
    } finally {
      clearInterval(taskLeaseTimer);
      clearInterval(cancellationTimer);
      clearTimeout(timeout);
      if (this.activeTaskId === task.bridge_task_id) {
        this.activeTaskId = undefined;
        this.activeAbortController = undefined;
        this.activeTaskLeaseLost = false;
      }
    }
  }

  private async prepareTaskAttachments(
    task: StoredBridgeTask,
    followupId?: string,
  ): Promise<StoredBridgeTaskAttachment[]> {
    const attachments = this.db.getBridgeTaskAttachments(task.bridge_task_id, followupId ?? null);
    if (attachments.length === 0) return [];
    const taskDirectory = join(this.attachmentsDir, task.bridge_task_id);
    await mkdir(taskDirectory, { recursive: true });
    const staleTemporaryFiles = (await readdir(taskDirectory)).filter((name) => name.endsWith(".tmp"));
    await Promise.all(staleTemporaryFiles.map((name) => unlink(join(taskDirectory, name)).catch(() => undefined)));
    const prepared: StoredBridgeTaskAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.status === "DOWNLOADED" && attachment.local_path) {
        try {
          await access(attachment.local_path);
          prepared.push(attachment);
          continue;
        } catch {
          // The path may have been removed during manual cleanup. Download it
          // again and keep the durable attachment row as the source of truth.
        }
      }
      try {
        // Feishu's file endpoint is also the download path for audio/video/
        // sticker resources. The channel exposes it as the generic `file`
        // resource type; only images use the image endpoint.
        const downloadType = attachment.type === "image" ? "image" : "file";
        const data = await this.channel!.downloadResource(attachment.file_key, downloadType);
        const fileName = `${attachment.attachment_id.slice(-8)}-${safeAttachmentFileName(
          attachment.file_name,
          attachment.file_key,
        )}`.slice(0, 180);
        const localPath = join(taskDirectory, fileName);
        const temporaryPath = `${localPath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, data);
        await rename(temporaryPath, localPath);
        this.db.markAttachmentDownloaded(attachment.attachment_id, localPath);
        prepared.push(this.db.getBridgeTaskAttachments(task.bridge_task_id, followupId ?? null)
          .find((item) => item.attachment_id === attachment.attachment_id) ?? {
            ...attachment,
            local_path: localPath,
            status: "DOWNLOADED",
            error: null,
          });
      } catch (error) {
        const message = sanitizeError(error instanceof Error ? error.message : String(error));
        this.db.markAttachmentFailed(attachment.attachment_id, message);
        throw new Error(`附件下载失败（${attachment.file_name ?? attachment.file_key}）：${message}`);
      }
    }
    return prepared;
  }

  private async flushOutbox(): Promise<void> {
    if (!this.channel || this.stopping) return;
    const commandCardEntries = this.db.getDueOutbox(50, ["feishu.send_card"]);
    for (const entry of commandCardEntries) {
      if (this.stopping) return;
      try {
        const payload = parseCommandCardOutboxPayload(entry.payload_json);
        await this.channel.send(payload.chatId, { card: compactGlobalCard(payload.card) });
        this.db.markOutboxDelivered(entry.id);
      } catch (error) {
        const attempts = this.db.markOutboxFailed(entry.id);
        this.logger.warn("direct Feishu command card outbox delivery failed", {
          outboxId: entry.id,
          attempts,
          error: sanitizeError(error instanceof Error ? error.message : String(error)),
        });
      }
    }

    const textEntries = this.db.getDueOutbox(50, ["feishu.send_text"]);
    for (const entry of textEntries) {
      if (this.stopping) return;
      try {
        const payload = parseTextOutboxPayload(entry.payload_json);
        await this.channel.send(
          payload.chatId,
          { text: payload.text },
          {
            replyTo: payload.replyTo,
            replyInThread: this.config.direct.feishu.replyInThread,
          },
        );
        this.db.markOutboxDelivered(entry.id);
      } catch (error) {
        const attempts = this.db.markOutboxFailed(entry.id);
        this.logger.warn("direct Feishu text outbox delivery failed", {
          outboxId: entry.id,
          attempts,
          error: sanitizeError(error instanceof Error ? error.message : String(error)),
        });
      }
    }

    const cardEntries = this.db.getDueOutbox(50, ["feishu.stream_card"]);
    for (const entry of cardEntries) {
      if (this.stopping || this.activeCardDeliveries.has(entry.id)) continue;
      const delivery = this.deliverStreamCard(entry)
        .catch((error) => {
          this.logger.warn("direct Feishu card delivery task failed", {
            outboxId: entry.id,
            error: sanitizeError(error instanceof Error ? error.message : String(error)),
          });
        })
        .finally(() => {
          this.activeCardDeliveries.delete(entry.id);
        });
      this.activeCardDeliveries.set(entry.id, delivery);
    }
  }

  private async deliverStreamCard(entry: {
    id: number;
    payload_json: string;
  }): Promise<void> {
    let payload: StreamCardOutboxPayload | undefined;
    try {
      const streamPayload = parseStreamCardOutboxPayload(entry.payload_json);
      payload = streamPayload;
      const existingTask = this.db.getBridgeTask(streamPayload.bridgeTaskId);
      if (existingTask?.card_message_id && existingTask.card_state === "STREAMING") {
        await this.deliverExistingCard(streamPayload, entry.id, existingTask.card_message_id);
        return;
      }
      await this.channel!.stream(
        streamPayload.chatId,
        {
          markdown: async (controller) => {
            let lastContent = "";
            while (!this.stopping) {
              const task = this.db.getBridgeTask(streamPayload.bridgeTaskId);
              if (!task) return;
              const attachmentNames = this.db
                .getBridgeTaskAttachments(task.bridge_task_id)
                .map((attachment) => attachment.file_name ?? attachment.file_key);
              const content = renderDirectCardContent(task, attachmentNames);
              if (content !== lastContent) {
                await controller.setContent(content);
                this.db.markBridgeCardStreaming(task.bridge_task_id, controller.messageId);
                this.db.saveBridgeCardContent(task.bridge_task_id, content);
                lastContent = content;
              } else if (!task.card_message_id && controller.messageId) {
                this.db.markBridgeCardStreaming(task.bridge_task_id, controller.messageId);
              }
              if (isTerminalDirectTaskStatus(task.status)) {
                return;
              }
              await delay(CARD_POLL_MS);
            }
          },
        },
        {
          replyTo: streamPayload.replyTo,
          replyInThread: this.config.direct.feishu.replyInThread,
        },
      );
      const task = this.db.getBridgeTask(streamPayload.bridgeTaskId);
      if (!task) {
        this.db.markOutboxDelivered(entry.id);
      } else if (!this.stopping && isTerminalDirectTaskStatus(task.status)) {
        this.db.markBridgeCardCompleted(streamPayload.bridgeTaskId);
        this.db.markOutboxDelivered(entry.id);
      }
    } catch (error) {
      if (this.stopping) return;
      const message = sanitizeError(error instanceof Error ? error.message : String(error));
      const attempts = this.db.markOutboxFailed(entry.id);
      if (attempts >= CARD_MAX_FAILURE_ATTEMPTS) {
        if (payload) this.db.markBridgeCardDeliveryFailed(payload.bridgeTaskId, message);
        this.db.markOutboxDelivered(entry.id);
        const task = payload ? this.db.getBridgeTask(payload.bridgeTaskId) : null;
        if (task && isTerminalDirectTaskStatus(task.status)) {
          this.db.enqueueDirectTextReply(
            task.bridge_task_id,
            task.chat_id,
            fallbackTextForTask(task),
            task.message_id,
          );
        }
      }
      this.logger.warn("direct Feishu streaming card delivery failed", {
        outboxId: entry.id,
        bridgeTaskId: payload?.bridgeTaskId,
        attempts,
        error: message,
      });
    }
  }

  private async deliverExistingCard(
    payload: StreamCardOutboxPayload,
    outboxId: number,
    messageId: string,
  ): Promise<void> {
    let lastContent = "";
    while (!this.stopping) {
      const task = this.db.getBridgeTask(payload.bridgeTaskId);
      if (!task) {
        this.db.markOutboxDelivered(outboxId);
        return;
      }
      const attachmentNames = this.db
        .getBridgeTaskAttachments(task.bridge_task_id)
        .map((attachment) => attachment.file_name ?? attachment.file_key);
      const content = renderDirectCardContent(task, attachmentNames);
      if (content !== lastContent) {
        await this.channel!.updateCard(messageId, buildDirectCard(content));
        this.db.markBridgeCardStreaming(task.bridge_task_id, messageId);
        this.db.saveBridgeCardContent(task.bridge_task_id, content);
        lastContent = content;
      }
      if (isTerminalDirectTaskStatus(task.status)) {
        this.db.markBridgeCardCompleted(task.bridge_task_id);
        this.db.markOutboxDelivered(outboxId);
        return;
      }
      await delay(CARD_POLL_MS);
    }
  }
}

/**
 * The SDK accepts Domain enum values or absolute endpoint URLs. AAMP binding
 * files store the tenant brand as the lowercase string "feishu"/"lark";
 * passing that string through creates URLs such as `feishu/open-apis/...`.
 */
export function resolveDirectLarkDomain(
  configured: string | undefined,
  tenantBrand: "feishu" | "lark" | undefined,
): string | Domain {
  const value = configured?.trim().toLowerCase();
  if (!value || value === "feishu") return tenantBrand === "lark" ? Domain.Lark : Domain.Feishu;
  if (value === "lark") return Domain.Lark;
  return configured!.trim();
}

export function resolveFeishuCredentials(
  config: BridgeConfig,
  options: FeishuCredentialResolutionOptions = {},
): {
  appId: string;
  appSecret: string;
} {
  const credentials = resolveSharedFeishuCredentials(config, options);
  return { appId: credentials.appId, appSecret: credentials.appSecret };
}

export interface DirectPromptOptions {
  projectKey: string;
  modeKey: string;
  repo: string;
  sandboxMode: "read-only" | "workspace-write";
  text: string;
  sessionKey: string;
  attachments?: DirectPromptAttachment[];
}

/**
 * Read optional routing headers from a Feishu task message. The headers are
 * deliberately line-based so ordinary prose containing the words "项目" or
 * "模式" does not unexpectedly change the route.
 *
 * Supported forms:
 *   项目：food
 *   模式：implement
 *   project: food
 *   mode=implement
 */
export function parseDirectTaskRoute(text: string): ParsedDirectTaskRoute {
  const projectMatch = text.match(/^[ \t]*(?:项目|project)[ \t]*[:：=][ \t]*(\S+)[ \t]*$/imu);
  const modeMatch = text.match(/^[ \t]*(?:执行模式|模式|mode)[ \t]*[:：=][ \t]*(\S+)[ \t]*$/imu);
  return {
    projectKey: projectMatch?.[1],
    modeKey: modeMatch?.[1],
  };
}

/** Resolve task-level route headers, then configured defaults, then a sole registry entry. */
export function resolveDirectTaskRoute(
  text: string,
  config: BridgeConfig,
): DirectTaskRouteResult {
  const parsed = parseDirectTaskRoute(text);
  const projectKey = parsed.projectKey
    ?? config.direct.projectKey
    ?? soleKey(config.projects);
  if (!projectKey) {
    return {
      ok: false,
      message: missingDirectRouteMessage(
        "项目",
        "项目：<projectKey>",
        Object.keys(config.projects),
      ),
    };
  }
  const project = resolveDirectProject(config, projectKey);
  if (!project) {
    return {
      ok: false,
      message: `任务指定的项目未配置：${projectKey}。可选项目：${formatDirectProjectKeys(config)}。请使用“项目：<projectKey>”指定已登记项目。`,
    };
  }

  const requestedModeKey = parsed.modeKey ?? config.direct.mode;
  const defaultMode = requestedModeKey ? undefined : defaultDirectMode(config.modes);
  const modeKey = requestedModeKey ?? defaultMode!.key;
  const mode = config.modes[modeKey] ?? defaultMode?.value;
  if (!mode) {
    return {
      ok: false,
      message: `任务指定的执行模式未配置：${modeKey}。可选模式：${formatRouteKeys(config.modes)}。请使用“模式：<modeKey>”指定已登记模式。`,
    };
  }
  return { ok: true, projectKey, modeKey, project, mode };
}

/** Resolve a reply against its parent task, inheriting omitted route fields. */
export function resolveDirectContinuationRoute(
  text: string,
  parentText: string,
  config: BridgeConfig,
): DirectTaskRouteResult {
  const parent = resolveDirectTaskRoute(parentText, config);
  if (!parent.ok) return parent;
  const parsed = parseDirectTaskRoute(text);
  const projectKey = parsed.projectKey ?? parent.projectKey;
  const modeKey = parsed.modeKey ?? parent.modeKey;
  const project = resolveDirectProject(config, projectKey);
  const mode = config.modes[modeKey] ?? (modeKey === parent.modeKey ? parent.mode : undefined);
  if (!project) {
    return {
      ok: false,
      message: `续问指定的项目未配置：${projectKey}。可选项目：${formatDirectProjectKeys(config)}。`,
    };
  }
  if (!mode) {
    return {
      ok: false,
      message: `续问指定的执行模式未配置：${modeKey}。可选模式：${formatRouteKeys(config.modes)}。`,
    };
  }
  if (project.repo !== parent.project.repo || mode.sandboxMode !== parent.mode.sandboxMode) {
    return {
      ok: false,
      message: `续问不能切换项目或沙箱模式（原任务：${parent.projectKey}/${parent.modeKey}）。请创建新任务处理其他项目或模式。`,
    };
  }
  return { ok: true, projectKey, modeKey, project, mode };
}

function defaultDirectMode(modes: Record<string, ModeConfig>): { key: string; value: ModeConfig } {
  if (modes.implement) return { key: "implement", value: modes.implement };
  const keys = Object.keys(modes).sort();
  if (keys.length === 1) return { key: keys[0], value: modes[keys[0]] };
  if (keys.length > 1) return { key: keys[0], value: modes[keys[0]] };
  return {
    key: "implement",
    value: { optionGuid: "direct-default-implement", sandboxMode: "workspace-write" },
  };
}

function resolveDirectProject(config: BridgeConfig, projectKey: string): ProjectConfig | undefined {
  const configured = config.projects[projectKey];
  if (configured) return configured;
  const mapPath = config.aamp.worktree?.projectMapPath;
  if (!mapPath) return undefined;
  const mapped = resolveMappedProject(mapPath, projectKey);
  if (!mapped) return undefined;
  // A project-map entry is a repository route, not a Feishu option field;
  // the key is a stable synthetic option id for the direct-only path.
  return { optionGuid: projectKey, repo: mapped.root };
}

function formatDirectProjectKeys(config: BridgeConfig): string {
  const keys = new Set(Object.keys(config.projects));
  const mapPath = config.aamp.worktree?.projectMapPath;
  if (mapPath) {
    try {
      for (const key of Object.keys(readProjectMap(mapPath))) keys.add(key);
    } catch {
      // Keep the configured project list in the user-facing error if the map
      // is temporarily unavailable; the selected route will report details.
    }
  }
  return formatRouteKeys(Object.fromEntries([...keys].map((key) => [key, true])));
}

function soleKey<T>(values: Record<string, T>): string | undefined {
  const keys = Object.keys(values);
  return keys.length === 1 ? keys[0] : undefined;
}

function formatRouteKeys(values: Record<string, unknown>): string {
  const keys = Object.keys(values);
  return keys.length > 0 ? keys.join(", ") : "(未配置)";
}

function missingDirectRouteMessage(
  label: string,
  example: string,
  keys: string[],
): string {
  const available = keys.length > 0 ? `可选值：${keys.join(", ")}。` : "当前没有已登记值。";
  return `未指定${label}。请在任务消息中增加“${example}”，或在 direct 配置中设置默认值。${available}`;
}

export function buildDirectPrompt(options: DirectPromptOptions): string {
  const attachmentLines = options.attachments && options.attachments.length > 0
    ? [
        "",
        "已下载的用户附件（请在需要时读取；图片也会作为视觉输入传入）：",
        ...options.attachments.map((attachment) =>
          `- ${attachment.type}：${attachment.fileName}，本地路径：${attachment.localPath}`),
      ]
    : [];
  return [
    "你是一个通过飞书接入的个人 Codex 助手。",
    `项目：${options.projectKey}`,
    `执行模式：${options.modeKey}`,
    `仓库：${options.repo}`,
    `沙箱：${options.sandboxMode}`,
    `会话：${options.sessionKey}`,
    "请直接处理下面的用户请求。遵守仓库中的 AGENTS.md 和用户已有工作流；不要自行 commit、push、merge、部署或删除用户数据。",
    "完成后用简洁中文说明结果、验证情况和仍需用户决定的事项。",
    ...attachmentLines,
    "",
    "用户请求：",
    options.text,
  ].join("\n");
}

export function summarizeCodexEvent(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "codex.event";
  const item = asRecord(event.item);
  if (typeof item.text === "string" && item.text.trim()) {
    return truncate(item.text.trim(), 500);
  }
  if (typeof item.command === "string") {
    return `${type}: ${truncate(item.command, 300)}`;
  }
  if (typeof event.message === "string" && event.message.trim()) {
    return truncate(event.message.trim(), 500);
  }
  return type;
}

export function renderDirectCardContent(
  task: StoredBridgeTask,
  attachmentNames: string[] = [],
): string {
  const status = directTaskStatusLabel(task.status);
  const lines = [
    `### Codex · ${status}`,
    `任务：\`${task.bridge_task_id}\``,
  ];
  if (attachmentNames.length > 0) {
    lines.push(`附件：${attachmentNames.map((name) => `\`${name}\``).join("、")}`);
  }
  if (task.last_progress_text) {
    lines.push("", `**当前进度**：${task.last_progress_text}`);
  }
  if (task.status === "SUCCEEDED") {
    lines.push("", "#### 结果", task.final_response ?? "Codex 已完成，但没有返回文本。");
  } else if (task.status === "FAILED") {
    lines.push("", "#### 错误", task.error ?? "Codex 执行失败。");
  } else if (task.status === "CANCEL_REQUESTED") {
    lines.push("", `正在取消：${task.cancel_reason ?? "用户请求取消。"}`);
  } else if (task.status === "CANCELLED") {
    lines.push("", `已取消：${task.cancel_reason ?? "用户请求取消。"}`);
  } else if (task.recovery_count > 0) {
    lines.push("", `已从上次中断恢复（第 ${task.recovery_count} 次）。`);
  }
  return truncate(lines.join("\n"), CARD_CONTENT_LIMIT);
}

export function evaluateDirectPermission(
  config: BridgeConfig,
  context: DirectPermissionContext,
  kind: DirectPermissionKind,
): DirectPermissionDecision {
  const permissions = config.direct.permissions;
  const messageAllowed = permissionValue(permissions.rules, context, "allow")
    ?? permissions.defaultAllow;
  if (kind === "message") {
    return messageAllowed
      ? { allowed: true }
      : { allowed: false, reason: "匹配到拒绝规则" };
  }
  if (!messageAllowed) return { allowed: false, reason: "消息本身未获授权" };
  const allowed = kind === "attachment"
    ? permissionValue(permissions.rules, context, "allowAttachments") ?? permissions.allowAttachments
    : permissionValue(permissions.rules, context, "allowCancel") ?? permissions.allowCancel;
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: kind === "attachment" ? "附件能力未授权" : "取消能力未授权" };
}

function permissionValue(
  rules: DirectPermissionRule[],
  context: DirectPermissionContext,
  key: "allow" | "allowAttachments" | "allowCancel",
): boolean | undefined {
  let bestScore = -1;
  let value: boolean | undefined;
  for (const rule of rules) {
    const score = permissionRuleScore(rule, context);
    if (score >= 0 && typeof rule[key] === "boolean" && score > bestScore) {
      bestScore = score;
      value = rule[key];
    }
  }
  return value;
}

function permissionRuleScore(
  rule: {
    chatId?: string;
    senderOpenId?: string;
    chatType?: "p2p" | "group";
  },
  context: DirectPermissionContext,
): number {
  if (rule.chatId && rule.chatId !== context.chatId) return -1;
  if (rule.senderOpenId && rule.senderOpenId !== context.senderId) return -1;
  if (rule.chatType && rule.chatType !== context.chatType) return -1;
  return Number(Boolean(rule.chatId))
    + Number(Boolean(rule.senderOpenId))
    + Number(Boolean(rule.chatType));
}

function toDirectMessageInput(
  message: NormalizedMessage,
  text: string,
  attachments: DirectAttachmentInput[],
): DirectMessageInput {
  return {
    sourceEventId: sourceEventIdFor(message),
    eventType: "im.message.receive_v1",
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    senderName: message.senderName,
    text,
    sessionKey: makeSessionKey(message),
    replyToMessageId: message.replyToMessageId,
    rootMessageId: message.rootId,
    threadId: message.threadId,
    attachments,
    payload: {
      chatType: message.chatType,
      threadId: message.threadId,
      rootId: message.rootId,
      replyToMessageId: message.replyToMessageId,
      rawContentType: message.rawContentType,
      resources: attachments,
      raw: message.raw,
    },
  };
}

function normalizeAttachments(message: NormalizedMessage): DirectAttachmentInput[] {
  return message.resources.map((resource) => ({
    type: resource.type,
    fileKey: resource.fileKey,
    fileName: resource.fileName,
    durationMs: resource.durationMs,
    coverImageKey: resource.coverImageKey,
  }));
}

function makeSessionKey(message: NormalizedMessage): string {
  if (message.threadId) return `chat:${message.chatId}:thread:${message.threadId}`;
  return `chat:${message.chatId}`;
}

function sourceEventIdFor(message: NormalizedMessage): string {
  const raw = asRecord(message.raw);
  const header = asRecord(raw.header);
  if (typeof header.event_id === "string" && header.event_id.trim()) {
    return header.event_id;
  }
  if (typeof raw.event_id === "string" && raw.event_id.trim()) {
    return raw.event_id;
  }
  return message.messageId;
}

function isBotMessage(message: NormalizedMessage): boolean {
  const raw = asRecord(message.raw);
  const sender = asRecord(raw.sender);
  const senderType = typeof sender.sender_type === "string"
    ? sender.sender_type.toUpperCase()
    : "";
  return senderType === "APP" || senderType === "BOT" || senderType === "ASSISTANT";
}

function buildDirectCodexEnvironment(config: BridgeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !key.startsWith("LARK_") &&
      !key.startsWith("FEISHU_")
    ) {
      env[key] = value;
    }
  }
  if (config.codex.env.HTTP_PROXY) env.HTTP_PROXY = config.codex.env.HTTP_PROXY;
  if (config.codex.env.HTTPS_PROXY) env.HTTPS_PROXY = config.codex.env.HTTPS_PROXY;
  return env;
}

function makeCodexInput(prompt: string, attachments: StoredBridgeTaskAttachment[]): Input {
  const images = attachments
    .filter((attachment) => attachment.type === "image" && attachment.local_path)
    .map((attachment): UserInput => ({ type: "local_image", path: attachment.local_path! }));
  return images.length > 0
    ? [{ type: "text", text: prompt }, ...images]
    : prompt;
}

function parseCancelCommand(text: string): { taskId?: string } | undefined {
  const match = text.match(/^(?:\/cancel|取消|停止|中断)(?:\s+([A-Za-z0-9_-]+))?\s*$/i);
  if (!match) return undefined;
  return { taskId: match[1] };
}

function isDirectDetailCommand(command: string): command is DirectDetailCommand {
  return ["thread", "resume", "retry", "queue", "progress", "events", "changes", "commands", "tools"].includes(command);
}

function directInputFromCardAction(
  event: CardActionEvent,
  command: GlobalCommand,
): DirectMessageInput {
  const argument = command.args[0] ? ` ${command.args[0]}` : "";
  return {
    sourceEventId: `card:${event.messageId}:${randomUUID()}`,
    eventType: "card.action",
    messageId: `card:${event.messageId}:${randomUUID()}`,
    chatId: event.chatId,
    chatType: "p2p",
    senderId: event.operator.openId,
    text: `/${command.command}${argument}`,
    sessionKey: `chat:${event.chatId}`,
    payload: { cardAction: true, command: command.command, taskId: command.args[0] },
  };
}

function eventMatchesCommand(payloadJson: string, command: DirectControlCommand): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return false;
  }
  const text = JSON.stringify(payload).toLowerCase();
  if (command === "commands") return text.includes("command") || text.includes("shell") || text.includes("exec");
  if (command === "tools") return text.includes("mcp") || text.includes("tool_call") || text.includes("tool");
  return text.includes("file") || text.includes("change") || text.includes("patch") || text.includes("diff");
}

function eventSummary(payloadJson: string): string {
  try {
    const payload = asRecord(JSON.parse(payloadJson));
    const item = asRecord(payload.item);
    const command = typeof item.command === "string" ? item.command : undefined;
    const text = typeof item.text === "string" ? item.text : undefined;
    const tool = typeof item.tool === "string" ? item.tool : undefined;
    const detail = command || text || tool;
    return detail ? ` · ${truncate(detail.replace(/\s+/g, " "), 180)}` : "";
  } catch {
    return "";
  }
}

export function parseDirectControlCommand(
  text: string,
): { command: DirectControlCommand; argument?: string } | undefined {
  const match = text.match(/^\/(help|status|recent|tasks?|usage|thread|resume|retry|queue|progress|events|changes|commands|tools)(?:\s+([^\s]+))?\s*$/i);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const command: DirectControlCommand = name === "tasks" || name === "task"
    ? "task"
    : name as DirectControlCommand;
  return { command, argument: match[2] };
}

function normalizeGlobalCommand(value: Record<string, unknown>): GlobalCommand | undefined {
  const raw = stringValue(value.command).toLowerCase();
  const command = raw === "task" ? "tasks" : raw;
  if (!["help", "cancel", "status", "usage", "recent", "tasks", "thread", "resume", "retry", "queue", "progress", "events", "changes", "commands", "tools"].includes(command)) return undefined;
  const taskId = stringValue(value.taskId);
  return {
    command: command as GlobalCommand["command"],
    args: taskId ? [taskId] : [],
    raw: stringValue(value.commandText) || `/${command}`,
  };
}

function globalDirectTask(task: StoredBridgeTask): Record<string, unknown> {
  const status = task.status.toLowerCase();
  return {
    taskId: task.bridge_task_id,
    chatId: task.chat_id,
    senderId: task.sender_id,
    sourceMode: GLOBAL_TASK_MODES.DIRECT,
    status,
    title: "Codex 直连任务",
    userMessageText: task.text,
    outputText: task.final_response ?? "",
    streamText: task.last_progress_text ?? "",
    resultError: task.error,
    threadId: task.thread_id,
    bridgeCancelledAt: status === "cancelled" ? task.updated_at : null,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

function globalAampTask(
  task: StoredAampTask,
  canonical?: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot = parseStoredSnapshot(task.session_snapshot);
  const canonicalStatus = stringValue(canonical?.status);
  return {
    ...snapshot,
    taskId: task.aamp_task_id,
    chatId: task.chat_id,
    sourceMode: GLOBAL_TASK_MODES.AAMP,
    status: canonicalStatus || (task.status === "done" ? "completed" : task.status),
    title: stringValue(canonical?.title) || stringValue(snapshot.title) || "AAMP 任务",
    userMessageText: task.user_text || stringValue(canonical?.userMessageText) || stringValue(snapshot.userMessageText),
    outputText: task.last_delta_text || stringValue(canonical?.outputText) || stringValue(snapshot.outputText),
    resultError: task.error_msg ?? (stringValue(canonical?.resultError) || stringValue(snapshot.resultError) || null),
    createdAt: stringValue(canonical?.createdAt) || task.created_at,
    updatedAt: stringValue(canonical?.updatedAt) || task.updated_at,
  };
}

function parseStoredSnapshot(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timestampValue(value: unknown): number {
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTextOutboxPayload(payloadJson: string): TextOutboxPayload {
  const value = JSON.parse(payloadJson) as Record<string, unknown>;
  const chatId = typeof value.chatId === "string" ? value.chatId.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const replyTo = typeof value.replyTo === "string" ? value.replyTo : undefined;
  if (!chatId || !text) throw new Error("invalid feishu.send_text payload");
  return { chatId, text, replyTo };
}

function parseCommandCardOutboxPayload(payloadJson: string): CommandCardOutboxPayload {
  const value = JSON.parse(payloadJson) as Record<string, unknown>;
  const chatId = stringValue(value.chatId);
  const card = asRecord(value.card);
  if (!chatId || Object.keys(card).length === 0) {
    throw new Error("invalid feishu.send_card payload");
  }
  return { chatId, card };
}

function parseStreamCardOutboxPayload(payloadJson: string): StreamCardOutboxPayload {
  const value = JSON.parse(payloadJson) as Record<string, unknown>;
  const bridgeTaskId = typeof value.bridgeTaskId === "string" ? value.bridgeTaskId.trim() : "";
  const chatId = typeof value.chatId === "string" ? value.chatId.trim() : "";
  const replyTo = typeof value.replyTo === "string" ? value.replyTo : undefined;
  if (!bridgeTaskId || !chatId) throw new Error("invalid feishu.stream_card payload");
  return { bridgeTaskId, chatId, replyTo };
}

function directTaskStatusLabel(status: StoredBridgeTask["status"]): string {
  switch (status) {
    case "QUEUED": return "排队中";
    case "RUNNING": return "执行中";
    case "CANCEL_REQUESTED": return "取消中";
    case "SUCCEEDED": return "已完成";
    case "FAILED": return "失败";
    case "CANCELLED": return "已取消";
  }
}

function fallbackTextForTask(task: StoredBridgeTask): string {
  if (task.status === "SUCCEEDED") return task.final_response ?? "Codex 已完成，但没有返回文本。";
  if (task.status === "CANCELLED") return `任务已取消：${task.cancel_reason ?? "用户请求取消。"}`;
  return `Codex 执行失败：${task.error ?? "未知错误"}`;
}

function buildDirectCard(content: string): object {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: "markdown", element_id: "direct_codex_output", content }],
    },
  };
}

function isTerminalDirectTaskStatus(status: StoredBridgeTask["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}

function safeAttachmentFileName(fileName: string | null, fileKey: string): string {
  const original = basename(fileName || fileKey) || `attachment-${randomUUID().slice(0, 8)}`;
  const sanitized = original.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
  return sanitized || `attachment-${randomUUID().slice(0, 8)}`;
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function sanitizeError(value: string): string {
  return value
    .replace(/(access[_-]?token|app[_-]?secret|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .slice(0, 2000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
