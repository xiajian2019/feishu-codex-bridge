import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, relative, resolve } from "node:path";

import { Codex, type Input, type ThreadEvent, type ThreadOptions, type UserInput } from "@openai/codex-sdk";

import {
  CODEX_THREAD_SOURCE_KINDS,
  CODEX_THREAD_STATUS_TYPES,
  CodexAppServerClient,
  codexThreadSourceLabel,
  codexThreadStatusType,
  codexThreadTimestampMs,
  type CodexAppServerQueryClient,
  type CodexThread,
  type CodexThreadListParams,
  type CodexThreadSortDirection,
  type CodexThreadSortKey,
  type CodexThreadSourceKind,
} from "./codex-app-server.js";
import type { Logger } from "./types.js";

export const CODEX_HISTORY_DEFAULT_SOURCE_KINDS: CodexThreadSourceKind[] = ["cli", "appServer"];
export const CODEX_HISTORY_PAGE_SIZE = 200;
export const CODEX_HISTORY_MAX_SCAN = 10_000;
export const CODEX_HISTORY_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const CODEX_HISTORY_MAX_ATTACHMENTS = 10;

export type CodexHistoryArchivedFilter = "active" | "archived" | "all";

export interface CodexHistoryHome {
  id: string;
  label: string;
  path: string;
  available: boolean;
  error?: string;
}

interface ResolvedCodexHistoryHome extends CodexHistoryHome {
  sqliteHome?: string;
}

export interface CodexHistoryQuery {
  homeId?: string;
  searchTerm?: string;
  statuses?: string[];
  sourceKinds: CodexThreadSourceKind[];
  modelProviders?: string[];
  cwd?: string[];
  archived: CodexHistoryArchivedFilter;
  sortKey: CodexThreadSortKey;
  sortDirection: CodexThreadSortDirection;
  limit: number;
  offset: number;
}

export interface CodexHistoryItem {
  home: CodexHistoryHome;
  thread: CodexThread;
}

export interface CodexHistoryListResponse {
  items: CodexHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  homes: CodexHistoryHome[];
}

export interface CodexHistoryDetailResponse {
  home: CodexHistoryHome;
  thread: CodexThread;
  imageAttachments?: CodexHistoryTurnAttachments[];
}

export interface CodexHistoryAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface CodexHistoryMessageInput {
  text: string;
  attachmentIds?: string[];
  turnIndex?: number;
}

export type CodexHistoryWriterState = "available" | "busy" | "unknown";

export interface CodexHistoryWriterStatus {
  state: CodexHistoryWriterState;
  checkedAt: string;
  localRun?: {
    runId: string;
    threadId: string;
    userText: string;
    state: "running" | "cancelling";
    cursor: number;
  };
}

export interface CodexHistoryInterruptResponse {
  ok: boolean;
  state: CodexHistoryRunState;
}

export interface CodexHistoryTurnAttachments {
  runId: string;
  turnIndex: number;
  attachments: CodexHistoryAttachment[];
}

export interface CodexHistoryAttachmentFile {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
}

export type CodexHistoryRunState = "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface CodexHistoryMessageResponse {
  runId: string;
  threadId: string;
  state: CodexHistoryRunState;
  cursor: number;
  turnIndex: number;
  attachments: CodexHistoryAttachment[];
}

export interface CodexHistoryUpdateEvent {
  cursor: number;
  type: string;
  item?: unknown;
  message?: string;
  usage?: unknown;
}

export interface CodexHistoryUpdatesResponse {
  runId: string;
  threadId: string;
  userText: string;
  state: CodexHistoryRunState;
  cursor: number;
  events: CodexHistoryUpdateEvent[];
  attachments?: CodexHistoryAttachment[];
  finalResponse?: string;
  error?: string;
  resetRequired?: boolean;
}

export interface CodexHistoryAgentThread {
  readonly id: string | null;
  runStreamed(input: Input, options?: { signal?: AbortSignal }): Promise<{
    events: AsyncIterable<ThreadEvent>;
  }>;
}

export interface CodexHistoryAgent {
  resumeThread(threadId: string, options?: ThreadOptions): CodexHistoryAgentThread;
}

export interface CodexHistoryServiceOptions {
  executable: string;
  cwd?: string;
  environment?: Record<string, string>;
  /** Explicit homes are useful for tests and for installations outside ~/.codex/accounts. */
  homePaths?: string[];
  requestTimeoutMs?: number;
  logger?: Logger;
  createClient?: (home: ResolvedCodexHistoryHome) => CodexAppServerQueryClient;
  createAgent?: (home: CodexHistoryHome, environment: Record<string, string>) => CodexHistoryAgent;
  attachmentsDirectory?: string;
}

interface StagedCodexHistoryAttachment extends CodexHistoryAttachment {
  localPath: string;
  inUse: boolean;
}

interface LiveCodexHistoryRun {
  runId: string;
  threadKey: string;
  threadId: string;
  userText: string;
  turnIndex: number;
  workingDirectory?: string;
  attachments: StagedCodexHistoryAttachment[];
  createdAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  abortController: AbortController;
  state: CodexHistoryRunState;
  cursor: number;
  events: CodexHistoryUpdateEvent[];
  finalResponse?: string;
  error?: string;
}

/**
 * Read local Codex history through the app-server protocol and continue an
 * existing thread through the Codex SDK.
 *
 * A Codex home owns both credentials and local history. Every history query
 * gets a separate short-lived app-server process with that home selected in
 * its environment; no auth.json or SQLite file is parsed by the bridge.
 * Interactive turns use the same home selection and resume the selected
 * thread through `@openai/codex-sdk`.
 */
export class CodexHistoryService {
  private readonly options: CodexHistoryServiceOptions;
  private readonly attachmentsDirectory: string;
  private readonly stagedAttachments = new Map<string, StagedCodexHistoryAttachment>();
  private readonly liveRuns = new Map<string, LiveCodexHistoryRun>();
  private readonly latestRunByThread = new Map<string, string>();
  private readonly pendingThreadKeys = new Set<string>();

  constructor(options: CodexHistoryServiceOptions) {
    this.options = options;
    this.attachmentsDirectory = resolve(
      options.attachmentsDirectory ?? join(tmpdir(), "feishu-codex-bridge", "codex-history-attachments"),
    );
  }

  public listHomes(): CodexHistoryHome[] {
    return this.resolveHomes().map(toPublicHome);
  }

  public async listThreads(query: CodexHistoryQuery): Promise<CodexHistoryListResponse> {
    const resolvedHomes = this.resolveHomes();
    const homes = query.homeId
      ? resolvedHomes.filter((home) => home.id === query.homeId)
      : resolvedHomes;
    if (homes.length === 0) {
      throw new Error(`找不到 Codex home：${query.homeId || "(none)"}`);
    }

    const results = await Promise.all(homes.map(async (home) => {
      try {
        const threads = await this.queryHome(home, query);
        return { home, threads };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn("failed to read local Codex history", {
          home: home.path,
          error: message,
        });
        return { home: { ...home, error: message }, threads: [] as CodexThread[] };
      }
    }));

    const items = results.flatMap(({ home, threads }) => threads.map((thread) => ({
      home: toPublicHome(home),
      thread,
    })));
    items.sort((left, right) => compareThreads(left.thread, right.thread, query.sortKey, query.sortDirection));
    const resultHomes = new Map(results.map(({ home }) => [home.id, home]));

    return {
      items: items.slice(query.offset, query.offset + query.limit),
      total: items.length,
      limit: query.limit,
      offset: query.offset,
      // Keep the selector populated with every discovered home even when the
      // current query is scoped to one account.
      homes: resolvedHomes.map((home) => toPublicHome(resultHomes.get(home.id) ?? home)),
    };
  }

  public async readThread(
    homeId: string,
    threadId: string,
    includeTurns = true,
  ): Promise<CodexHistoryDetailResponse> {
    const home = this.resolveHomes().find((candidate) => candidate.id === homeId);
    if (!home) throw new Error(`找不到 Codex home：${homeId}`);
    if (!home.available) throw new Error(`Codex home 不可用：${home.path}`);

    const client = this.createClient(home);
    try {
      if (!client.readThread) throw new Error("当前 Codex 只读客户端不支持 thread/read");
      const result = await client.readThread(threadId, includeTurns);
      return {
        home: toPublicHome(home),
        thread: result.thread,
        imageAttachments: this.listTurnAttachments(homeId, threadId),
      };
    } finally {
      await client.close();
    }
  }

  public async stageAttachment(input: {
    fileName: string;
    mimeType: string;
    data: Uint8Array;
  }): Promise<CodexHistoryAttachment> {
    if (input.data.length === 0) throw new Error("附件不能为空。");
    if (input.data.length > CODEX_HISTORY_MAX_ATTACHMENT_BYTES) {
      throw new Error("单个附件不能超过 25 MiB。");
    }
    const fileName = sanitizeAttachmentFileName(input.fileName);
    if (!fileName) throw new Error("附件文件名无效。");
    const mimeType = normalizeAttachmentMimeType(input.mimeType);
    const attachmentId = randomUUID();
    const localPath = join(
      this.attachmentsDirectory,
      `${attachmentId}${attachmentFileExtension(fileName, mimeType)}`,
    );
    await mkdir(this.attachmentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(localPath, input.data, { flag: "wx", mode: 0o600 });
    const attachment: StagedCodexHistoryAttachment = {
      attachmentId,
      fileName,
      mimeType,
      sizeBytes: input.data.length,
      localPath,
      inUse: false,
    };
    this.stagedAttachments.set(attachmentId, attachment);
    return publicAttachment(attachment);
  }

  public async deleteStagedAttachment(attachmentId: string): Promise<boolean> {
    const attachment = this.stagedAttachments.get(attachmentId);
    if (!attachment || attachment.inUse) return false;
    this.stagedAttachments.delete(attachmentId);
    await unlink(attachment.localPath).catch(() => undefined);
    return true;
  }

  public async sendMessage(
    homeId: string,
    threadId: string,
    input: CodexHistoryMessageInput,
  ): Promise<CodexHistoryMessageResponse> {
    const home = this.resolveHomes().find((candidate) => candidate.id === homeId);
    if (!home) throw new Error(`找不到 Codex home：${homeId}`);
    if (!home.available) throw new Error(`Codex home 不可用：${home.path}`);
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("threadId is required");
    const text = input.text.trim();
    if (input.turnIndex !== undefined && (!Number.isSafeInteger(input.turnIndex) || input.turnIndex < 0)) {
      throw new Error("turnIndex must be a non-negative integer");
    }
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (attachmentIds.length > CODEX_HISTORY_MAX_ATTACHMENTS) {
      throw new Error(`一次最多发送 ${CODEX_HISTORY_MAX_ATTACHMENTS} 个附件。`);
    }
    if (!text && attachmentIds.length === 0) {
      throw new Error("请输入消息或选择附件。");
    }
    const threadKey = makeThreadKey(home.id, normalizedThreadId);
    const latestRun = this.latestRunByThread.get(threadKey);
    if (this.pendingThreadKeys.has(threadKey) || (latestRun && isActiveRun(this.liveRuns.get(latestRun)?.state))) {
      throw new Error("当前 Codex session 正在处理上一条消息，请等待本轮完成。");
    }
    const writerStatus = await this.getWriterStatus(homeId, normalizedThreadId);
    if (writerStatus.state === "busy") {
      throw new Error("该 Codex session 正在其他位置使用，请先在原窗口结束或关闭此 session 后再发送。");
    }
    const currentRunId = this.latestRunByThread.get(threadKey);
    if (this.pendingThreadKeys.has(threadKey)
      || (currentRunId && isActiveRun(this.liveRuns.get(currentRunId)?.state))) {
      throw new Error("当前 Codex session 正在处理上一条消息，请等待本轮完成。");
    }
    this.pendingThreadKeys.add(threadKey);
    let workingDirectory: string | undefined;
    try {
      const currentThread = await this.readThread(homeId, normalizedThreadId, false);
      if (currentThread.thread.cwd?.trim()) workingDirectory = resolve(currentThread.thread.cwd);
    } finally {
      this.pendingThreadKeys.delete(threadKey);
    }
    const attachments = attachmentIds.map((attachmentId) => this.stagedAttachments.get(attachmentId));
    if (attachments.some((attachment) => !attachment)) {
      throw new Error("历史会话附件已失效，请重新选择附件。");
    }
    const resolvedAttachments = attachments as StagedCodexHistoryAttachment[];
    for (const attachment of resolvedAttachments) attachment.inUse = true;

    const run: LiveCodexHistoryRun = {
      runId: randomUUID(),
      threadKey,
      threadId: normalizedThreadId,
      userText: text,
      turnIndex: Number.isSafeInteger(input.turnIndex) && (input.turnIndex ?? -1) >= 0 ? input.turnIndex! : 0,
      ...(workingDirectory ? { workingDirectory } : {}),
      attachments: resolvedAttachments,
      createdAt: Date.now(),
      abortController: new AbortController(),
      state: "running",
      cursor: 0,
      events: [],
    };
    this.liveRuns.set(run.runId, run);
    this.latestRunByThread.set(threadKey, run.runId);
    this.trimLiveRuns(threadKey);
    void this.runMessage(home, run, resolvedAttachments).catch((error) => {
      this.finishLiveRunWithError(run, error);
    });
    return {
      runId: run.runId,
      threadId: normalizedThreadId,
      state: run.state,
      cursor: run.cursor,
      turnIndex: run.turnIndex,
      attachments: resolvedAttachments.map(publicAttachment),
    };
  }

  public getMessageUpdates(
    homeId: string,
    threadId: string,
    runId: string | undefined,
    afterCursor: number,
  ): CodexHistoryUpdatesResponse {
    const normalizedThreadId = threadId.trim();
    const threadKey = makeThreadKey(homeId, normalizedThreadId);
    const selectedRunId = runId?.trim() || this.latestRunByThread.get(threadKey);
    const run = selectedRunId ? this.liveRuns.get(selectedRunId) : undefined;
    if (!run || run.threadKey !== threadKey) {
      throw new Error("找不到正在运行或刚刚完成的 Codex turn。");
    }
    const firstCursor = run.events[0]?.cursor;
    const resetRequired = firstCursor !== undefined && afterCursor < firstCursor - 1;
    return {
      runId: run.runId,
      threadId: run.threadId,
      userText: run.userText,
      state: run.state,
      cursor: run.cursor,
      events: resetRequired ? [] : run.events.filter((event) => event.cursor > afterCursor),
      ...(run.finalResponse ? { finalResponse: run.finalResponse } : {}),
      ...(run.error ? { error: run.error } : {}),
      attachments: run.attachments.map(publicAttachment),
      ...(resetRequired ? { resetRequired: true } : {}),
    };
  }

  public interruptMessage(
    homeId: string,
    threadId: string,
    runId: string,
  ): CodexHistoryInterruptResponse {
    const run = this.liveRuns.get(runId);
    if (!run || run.threadKey !== makeThreadKey(homeId, threadId)) {
      return { ok: false, state: "failed" };
    }
    if (run.state === "cancelling") return { ok: true, state: "cancelling" };
    if (run.state !== "running") return { ok: false, state: run.state };
    run.state = "cancelling";
    run.abortController.abort();
    return { ok: true, state: "cancelling" };
  }

  public getRunAttachment(
    homeId: string,
    threadId: string,
    runId: string,
    attachmentId: string,
  ): CodexHistoryAttachmentFile | null {
    const run = this.liveRuns.get(runId);
    if (!run || run.threadKey !== makeThreadKey(homeId, threadId)) return null;
    const attachment = run.attachments.find((item) => item.attachmentId === attachmentId);
    if (!attachment || !existsSync(attachment.localPath)) return null;
    return {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      localPath: attachment.localPath,
    };
  }

  public async getWriterStatus(homeId: string, threadId: string): Promise<CodexHistoryWriterStatus> {
    const home = this.resolveHomes().find((candidate) => candidate.id === homeId);
    if (!home) throw new Error(`找不到 Codex home：${homeId}`);
    if (!home.available) throw new Error(`Codex home 不可用：${home.path}`);
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("threadId is required");
    const checkedAt = new Date().toISOString();
    const threadKey = makeThreadKey(homeId, normalizedThreadId);
    const localRunId = this.latestRunByThread.get(threadKey);
    const localRun = localRunId ? this.liveRuns.get(localRunId) : undefined;
    if (localRun && isActiveRun(localRun.state)) {
      return {
        state: "busy",
        checkedAt,
        localRun: {
          runId: localRun.runId,
          threadId: localRun.threadId,
          userText: localRun.userText,
          state: localRun.state,
          cursor: localRun.cursor,
        },
      };
    }
    const lockPath = join(home.path, "thread-writer-locks", `${normalizedThreadId}.lock`);
    if (!existsSync(lockPath)) return { state: "available", checkedAt };
    const openState = await isFileOpenByAnotherProcess(lockPath);
    return {
      state: openState === true ? "busy" : openState === false ? "available" : "unknown",
      checkedAt,
    };
  }

  private listTurnAttachments(homeId: string, threadId: string): CodexHistoryTurnAttachments[] {
    const threadKey = makeThreadKey(homeId, threadId);
    return [...this.liveRuns.values()]
      .filter((run) => run.threadKey === threadKey && run.attachments.length > 0)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((run) => ({
        runId: run.runId,
        turnIndex: run.turnIndex,
        attachments: run.attachments.map(publicAttachment),
      }));
  }

  private resolveHomes(): ResolvedCodexHistoryHome[] {
    const homeDirectory = homedir();
    const primaryHome = normalizePath(
      this.options.environment?.CODEX_HOME || join(homeDirectory, ".codex"),
      homeDirectory,
    );
    const configuredHomes = this.options.homePaths?.length
      ? this.options.homePaths
      : discoverCodexHomePaths(this.options.environment, homeDirectory);
    const paths = uniquePaths([
      primaryHome,
      ...configuredHomes.map((path) => normalizePath(path, homeDirectory)),
    ]);
    return paths.map((path) => buildHome(path, primaryHome));
  }

  private async queryHome(home: ResolvedCodexHistoryHome, query: CodexHistoryQuery): Promise<CodexThread[]> {
    if (!home.available) throw new Error(`Codex home 不可用：${home.path}`);

    const client = this.createClient(home);
    try {
      const archivedValues: boolean[] = query.archived === "all"
        ? [false, true]
        : [query.archived === "archived"];
      const threads: CodexThread[] = [];
      const seenThreadIds = new Set<string>();
      let scanned = 0;

      for (const archived of archivedValues) {
        if (scanned >= CODEX_HISTORY_MAX_SCAN) {
          throw new Error(`本地历史最多扫描 ${CODEX_HISTORY_MAX_SCAN} 个线程，请先缩小搜索范围`);
        }
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        while (true) {
          const page = await client.listThreads(buildListParams(query, archived, cursor));
          scanned += page.data.length;
          if (scanned > CODEX_HISTORY_MAX_SCAN) {
            throw new Error(`本地历史最多扫描 ${CODEX_HISTORY_MAX_SCAN} 个线程，请先缩小搜索范围`);
          }
          for (const thread of page.data) {
            if (seenThreadIds.has(thread.id) || !matchesLocalFilters(thread, query)) continue;
            seenThreadIds.add(thread.id);
            threads.push(thread);
          }
          if (!page.nextCursor) break;
          if (seenCursors.has(page.nextCursor)) {
            throw new Error("Codex app-server 返回了重复的分页 cursor");
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
          if (scanned >= CODEX_HISTORY_MAX_SCAN) {
            throw new Error(`本地历史最多扫描 ${CODEX_HISTORY_MAX_SCAN} 个线程，请先缩小搜索范围`);
          }
        }
      }
      return threads;
    } finally {
      await client.close();
    }
  }

  private createClient(home: ResolvedCodexHistoryHome): CodexAppServerQueryClient {
    if (this.options.createClient) return this.options.createClient(home);
    const environment = { ...(this.options.environment ?? {}) };
    environment.CODEX_HOME = home.path;
    if (home.sqliteHome) environment.CODEX_SQLITE_HOME = home.sqliteHome;
    else delete environment.CODEX_SQLITE_HOME;
    return new CodexAppServerClient({
      executable: this.options.executable,
      cwd: this.options.cwd,
      env: environment,
      requestTimeoutMs: this.options.requestTimeoutMs,
      clientName: "feishu_codex_bridge_history",
      clientTitle: "Feishu Codex Bridge (history)",
    });
  }

  private createAgent(home: ResolvedCodexHistoryHome): CodexHistoryAgent {
    const environment = { ...(this.options.environment ?? {}) };
    environment.CODEX_HOME = home.path;
    if (home.sqliteHome) environment.CODEX_SQLITE_HOME = home.sqliteHome;
    else delete environment.CODEX_SQLITE_HOME;
    if (this.options.createAgent) return this.options.createAgent(toPublicHome(home), environment);
    return new Codex({
      codexPathOverride: this.options.executable,
      env: environment,
    });
  }

  private async runMessage(
    home: ResolvedCodexHistoryHome,
    run: LiveCodexHistoryRun,
    attachments: StagedCodexHistoryAttachment[],
  ): Promise<void> {
    try {
      const agent = this.createAgent(home);
      const directories = [...new Set(attachments.map((attachment) => dirname(attachment.localPath)))];
      const threadOptions: ThreadOptions | undefined = run.workingDirectory || directories.length > 0
        ? {
            ...(run.workingDirectory ? { workingDirectory: run.workingDirectory } : {}),
            ...(directories.length > 0 ? { additionalDirectories: directories } : {}),
          }
        : undefined;
      const thread = agent.resumeThread(run.threadId, threadOptions);
      const { events } = await thread.runStreamed(
        buildCodexInput(run.userText, attachments),
        { signal: run.abortController.signal },
      );
      for await (const event of events) {
        this.recordLiveEvent(run, event);
        if (event.type === "turn.failed") {
          throw new Error(event.error.message || "Codex turn failed");
        }
        if (event.type === "error") {
          throw new Error(event.message || "Codex event stream failed");
        }
      }
      if (run.abortController.signal.aborted && run.state !== "completed") {
        run.state = "cancelled";
        run.error = "Codex 执行已由用户中断。";
      } else if (run.state === "running") {
        run.state = "completed";
      }
    } catch (error) {
      if (run.abortController.signal.aborted) {
        run.state = "cancelled";
        run.error = "Codex 执行已由用户中断。";
      } else {
        this.finishLiveRunWithError(run, error);
      }
    } finally {
      for (const attachment of attachments) {
        this.stagedAttachments.delete(attachment.attachmentId);
      }
      this.scheduleRunExpiry(run);
    }
  }

  private recordLiveEvent(run: LiveCodexHistoryRun, event: ThreadEvent): void {
    const record = asRecord(event);
    const type = typeof record.type === "string" ? record.type : "codex.event";
    const item = record.item;
    const update: CodexHistoryUpdateEvent = {
      cursor: run.cursor + 1,
      type,
      ...(item !== undefined ? { item } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
    };
    run.cursor = update.cursor;
    run.events.push(update);
    if (run.events.length > 2_000) run.events.shift();
    const itemRecord = asRecord(item);
    if (itemRecord.type === "agent_message" && typeof itemRecord.text === "string") {
      run.finalResponse = itemRecord.text;
    }
    if (type === "turn.completed") run.state = "completed";
    if (type === "turn.failed" || type === "error") {
      run.state = "failed";
      const error = asRecord(record.error);
      run.error = typeof error.message === "string"
        ? error.message
        : typeof record.message === "string" ? record.message : "Codex turn failed";
    }
  }

  private finishLiveRunWithError(run: LiveCodexHistoryRun, error: unknown): void {
    if (run.state === "completed") return;
    run.state = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    this.options.logger?.warn("Codex history message failed", {
      threadId: run.threadId,
      error: run.error,
    });
  }

  private trimLiveRuns(threadKey: string): void {
    const runs = [...this.liveRuns.values()]
      .filter((run) => run.threadKey === threadKey)
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const run of runs.slice(0, Math.max(0, runs.length - 4))) {
      if (!isActiveRun(run.state)) this.expireRun(run);
    }
    const finishedRuns = [...this.liveRuns.values()]
      .filter((run) => !isActiveRun(run.state))
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const run of finishedRuns.slice(0, Math.max(0, finishedRuns.length - 40))) this.expireRun(run);
  }

  private scheduleRunExpiry(run: LiveCodexHistoryRun): void {
    run.expiryTimer = setTimeout(() => this.expireRun(run), 24 * 60 * 60 * 1_000);
    run.expiryTimer.unref?.();
  }

  private expireRun(run: LiveCodexHistoryRun): void {
    if (run.expiryTimer) clearTimeout(run.expiryTimer);
    this.liveRuns.delete(run.runId);
    if (this.latestRunByThread.get(run.threadKey) === run.runId) this.latestRunByThread.delete(run.threadKey);
    for (const attachment of run.attachments) void unlink(attachment.localPath).catch(() => undefined);
  }
}

export function discoverCodexHomePaths(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): string[] {
  const primaryHome = normalizePath(
    environment.CODEX_HOME || join(homeDirectory, ".codex"),
    homeDirectory,
  );
  const explicitHomes = [
    environment.FEISHU_CODEX_HISTORY_HOMES,
    environment.CODEX_HISTORY_HOMES,
  ].flatMap((value) => value ? value.split(delimiter) : [])
    .map((value) => normalizePath(value, homeDirectory));
  const accountHomes = readAccountHomes(primaryHome);
  return uniquePaths([primaryHome, ...accountHomes, ...explicitHomes]);
}

function buildListParams(
  query: CodexHistoryQuery,
  archived: boolean,
  cursor: string | null,
): CodexThreadListParams {
  return {
    cursor,
    limit: CODEX_HISTORY_PAGE_SIZE,
    sortKey: query.sortKey,
    sortDirection: query.sortDirection,
    sourceKinds: query.sourceKinds,
    modelProviders: query.modelProviders,
    archived,
    cwd: query.cwd?.length === 1 ? query.cwd[0] : query.cwd,
    searchTerm: query.searchTerm,
    // Listing must remain read-only. In particular, do not make app-server
    // scan JSONL and repair its state database just because the page refreshed.
    useStateDbOnly: true,
  };
}

function matchesLocalFilters(thread: CodexThread, query: CodexHistoryQuery): boolean {
  if (query.statuses?.length && !query.statuses.includes(codexThreadStatusType(thread.status))) {
    return false;
  }
  if (query.cwd?.length && (!thread.cwd || !query.cwd.includes(resolve(thread.cwd)))) {
    return false;
  }
  return true;
}

function compareThreads(
  left: CodexThread,
  right: CodexThread,
  sortKey: CodexThreadSortKey,
  direction: CodexThreadSortDirection,
): number {
  const leftValue = threadSortTimestamp(left, sortKey);
  const rightValue = threadSortTimestamp(right, sortKey);
  if (leftValue === rightValue) {
    const leftTitle = left.name?.trim() || left.preview?.trim() || "";
    const rightTitle = right.name?.trim() || right.preview?.trim() || "";
    return leftTitle.localeCompare(rightTitle);
  }
  const result = leftValue - rightValue;
  return direction === "asc" ? result : -result;
}

function threadSortTimestamp(thread: CodexThread, sortKey: CodexThreadSortKey): number {
  const value = sortKey === "created_at"
    ? thread.createdAt
    : sortKey === "updated_at"
      ? thread.updatedAt
      : thread.recencyAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const fallback = codexThreadTimestampMs(thread);
  return fallback === null ? 0 : fallback / 1_000;
}

function buildHome(path: string, primaryHome: string): ResolvedCodexHistoryHome {
  const available = existsSync(path) && isDirectory(path);
  const sqliteHome = available ? findSqliteHome(path) : undefined;
  const relativeToAccounts = relative(join(primaryHome, "accounts"), path);
  const accountName = relativeToAccounts && !relativeToAccounts.startsWith("..")
    ? relativeToAccounts.split("/")[0]
    : undefined;
  const label = path === primaryHome
    ? "默认"
    : accountName || basename(path) || path;
  return {
    id: `codex-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
    label,
    path,
    available,
    ...(sqliteHome ? { sqliteHome } : {}),
    ...(available ? {} : { error: "目录不存在或不可读取" }),
  };
}

function findSqliteHome(homePath: string): string | undefined {
  const nested = join(homePath, "sqlite");
  if (hasStateDatabase(nested)) return nested;
  if (hasStateDatabase(homePath)) return homePath;
  return undefined;
}

function hasStateDatabase(directory: string): boolean {
  if (!existsSync(directory) || !isDirectory(directory)) return false;
  try {
    return readdirSync(directory).some((entry) => /^state_\d+\.sqlite(?:-(?:shm|wal))?$/.test(entry));
  } catch {
    return false;
  }
}

function readAccountHomes(primaryHome: string): string[] {
  const accountsDirectory = join(primaryHome, "accounts");
  if (!existsSync(accountsDirectory) || !isDirectory(accountsDirectory)) return [];
  try {
    return readdirSync(accountsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(accountsDirectory, entry.name));
  } catch {
    return [];
  }
}

function normalizePath(path: string, homeDirectory: string): string {
  const expanded = path.trim().replace(/^~(?=\/|$)/, homeDirectory);
  const resolved = resolve(expanded);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function makeThreadKey(homeId: string, threadId: string): string {
  return `${homeId}:${threadId}`;
}

function isActiveRun(state: CodexHistoryRunState | undefined): state is "running" | "cancelling" {
  return state === "running" || state === "cancelling";
}

function buildCodexInput(text: string, attachments: StagedCodexHistoryAttachment[]): Input {
  const imageAttachments = attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const fileAttachments = attachments.filter((attachment) => !attachment.mimeType.startsWith("image/"));
  const imageNote = imageAttachments.length > 0
    ? [
        "请打开并查看我附上的图片，再结合上面的文字处理：",
        ...imageAttachments.map((attachment, index) =>
          `<image name=[Image #${index + 1}] path="${attachment.localPath}">`,
        ),
      ].join("\n")
    : "";
  const fileNote = fileAttachments.length > 0
    ? [
        "请读取我附上的文件，再结合上面的文字处理：",
        ...fileAttachments.map((attachment) =>
          `<file name="${escapePromptAttribute(attachment.fileName)}" path="${attachment.localPath}">`,
        ),
      ].join("\n")
    : "";
  const prompt = [text, imageNote, fileNote].filter(Boolean).join("\n\n");
  const images = imageAttachments.map((attachment): UserInput => ({
    type: "local_image",
    path: attachment.localPath,
  }));
  return [{ type: "text", text: prompt }, ...images];
}

function escapePromptAttribute(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sanitizeAttachmentFileName(value: string): string {
  const safeBaseName = value.replaceAll("\\", "/").split("/").pop() ?? "";
  return safeBaseName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
}

function normalizeAttachmentMimeType(value: string): string {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function attachmentFileExtension(fileName: string, mimeType: string): string {
  const knownExtensions: Record<string, string> = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  const knownExtension = knownExtensions[mimeType];
  if (knownExtension) return knownExtension;
  const extension = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".blob";
}

function publicAttachment(attachment: StagedCodexHistoryAttachment): CodexHistoryAttachment {
  return {
    attachmentId: attachment.attachmentId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isFileOpenByAnotherProcess(filePath: string): Promise<boolean | null> {
  return new Promise((resolvePromise) => {
    const executable = process.platform === "darwin" && existsSync("/usr/sbin/lsof")
      ? "/usr/sbin/lsof"
      : "lsof";
    execFile(executable, ["-t", filePath], { timeout: 2_000, maxBuffer: 4_096 }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise(stdout.trim().length > 0);
        return;
      }
      const code = (error as Error & { code?: string | number }).code;
      if (code === "ENOENT") {
        resolvePromise(null);
        return;
      }
      if (code === 1 && !stdout.trim() && !stderr.trim()) {
        resolvePromise(false);
        return;
      }
      resolvePromise(null);
    });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toPublicHome(home: ResolvedCodexHistoryHome | CodexHistoryHome): CodexHistoryHome {
  const { id, label, path, available, error } = home;
  return { id, label, path, available, ...(error ? { error } : {}) };
}

// Keep this import-time assertion close to the service contract. It catches a
// future Codex source/status expansion before the web query parser silently
// rejects it, while avoiding a second handwritten list in the page layer.
export const CODEX_HISTORY_SOURCE_KINDS = [...CODEX_THREAD_SOURCE_KINDS];
export const CODEX_HISTORY_STATUS_TYPES = [...CODEX_THREAD_STATUS_TYPES];

export function codexHistorySourceLabel(source: unknown): string {
  return codexThreadSourceLabel(source);
}
