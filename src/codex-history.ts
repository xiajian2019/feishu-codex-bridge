import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
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
  type CodexAccountResetCredit,
  type CodexAccountRateLimitSnapshot,
  type CodexAccountRateLimitsResponse,
  type CodexAccountTokenUsageResponse,
  type CodexModelListResponse,
  type CodexResetCreditConsumeResponse,
  type CodexThreadTokenUsageSnapshot,
  type CodexThread,
  type CodexThreadListParams,
  type CodexThreadSortDirection,
  type CodexThreadSortKey,
  type CodexThreadSourceKind,
} from "./codex-app-server.js";
import { unlinkOwnedCodexHistoryAttachment } from "./codex-history-attachments.js";
import type { Logger } from "./types.js";

export const CODEX_HISTORY_DEFAULT_SOURCE_KINDS: CodexThreadSourceKind[] = ["cli", "appServer"];
export const CODEX_HISTORY_PAGE_SIZE = 200;
export const CODEX_HISTORY_MAX_SCAN = 10_000;
export const CODEX_HISTORY_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const CODEX_HISTORY_MAX_ATTACHMENTS = 10;
const CODEX_HISTORY_LIST_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;
const CODEX_HISTORY_LIST_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const CODEX_HISTORY_RECOVERY_CHECK_INTERVAL_MS = 2_000;
export type CodexHistoryReasoningEffort = string;

export interface CodexHistoryListCacheStore {
  getCodexHistoryListCache(homeId: string, filterKey: string): {
    sourceFingerprint: string;
    payloadJson: string;
    refreshedAt: string;
  } | null;
  saveCodexHistoryListCache(homeId: string, filterKey: string, sourceFingerprint: string, payloadJson: string): void;
}

export interface CodexHistoryThreadHomePreferenceStore {
  getCodexHistoryThreadHomePreferences(threadIds: string[]): Map<string, string>;
  saveCodexHistoryThreadHomePreference(threadId: string, preferredHomeId: string): string;
}

/** Bridge-owned, content-minimal metadata for one history continuation. */
export interface CodexHistoryStoredRun {
  runId: string;
  homeId: string;
  threadId: string;
  requestFingerprint: string;
  turnIndex: number;
  attachments: CodexHistoryAttachment[];
  model?: string;
  reasoningEffort?: CodexHistoryReasoningEffort;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  state: CodexHistoryRunState;
  cursor: number;
  usage?: CodexHistoryTurnUsage;
}

export interface CodexHistoryRunStore {
  listCodexHistoryRuns(limit: number): CodexHistoryStoredRun[];
  findCodexHistoryRunByKey(homeId: string, threadId: string, keyHash: string): {
    requestFingerprint: string;
    runId: string;
    run?: CodexHistoryStoredRun;
  } | null;
  createCodexHistoryRun(run: CodexHistoryStoredRun, keyHash?: string): {
    kind: "created" | "existing" | "conflict" | "expired";
    run?: CodexHistoryStoredRun;
  };
  saveCodexHistoryRun(run: CodexHistoryStoredRun): void;
  /** Expire run metadata while keeping its idempotency receipt as a tombstone. */
  expireCodexHistoryRun(runId: string): void;
}

export class CodexHistoryIdempotencyConflictError extends Error {
  constructor() {
    super("该幂等键已用于不同的历史会话消息，请为新提交生成新的幂等键。");
    this.name = "CodexHistoryIdempotencyConflictError";
  }
}

export class CodexHistoryIdempotencyExpiredError extends Error {
  constructor() {
    super("该幂等键对应的历史续聊回执已过期；为新的提交生成新的幂等键。");
    this.name = "CodexHistoryIdempotencyExpiredError";
  }
}

export function isCodexHistoryReasoningEffort(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

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
  preferredHomeId?: string;
}

export interface CodexHistoryListResponse {
  items: CodexHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  homes: CodexHistoryHome[];
}

export interface CodexHistoryUsageAccount {
  homeId: string;
  label: string;
  available: boolean;
  checkedAt: string;
  quota?: {
    ordinaryUsageAllowed?: boolean | null;
    planType?: string | null;
    buckets: CodexAccountRateLimitSnapshot[];
    resetCreditsAvailableCount?: number | null;
    resetCredits?: CodexAccountResetCredit[] | null;
  };
  tokenUsage?: CodexAccountTokenUsageResponse;
  errors?: {
    quota?: string;
    tokenUsage?: string;
  };
}

export interface CodexHistoryUsageResponse {
  generatedAt: string;
  dataSource: "codex-app-server";
  accounts: CodexHistoryUsageAccount[];
}

export interface CodexHistoryDetailResponse {
  home: CodexHistoryHome;
  thread: CodexThread;
  imageAttachments?: CodexHistoryTurnAttachments[];
  models?: CodexHistoryModelOption[];
  turnUsages?: CodexHistoryTurnUsageRecord[];
}

export interface CodexHistoryModelOption {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort?: CodexHistoryReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: CodexHistoryReasoningEffort;
    description: string;
  }>;
}

export interface CodexHistoryTurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
}

export interface CodexHistoryTurnUsageRecord {
  turnIndex: number;
  usage: CodexHistoryTurnUsage;
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
  model?: string;
  reasoningEffort?: CodexHistoryReasoningEffort;
  idempotencyKey?: string;
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
    turnIndex: number;
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

export type CodexHistoryRunState = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export interface CodexHistoryRunRecoveryStatus {
  checkedAt: string;
  codexThreadStatus: string | null;
  error?: string;
}

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
  usage?: CodexHistoryTurnUsage;
}

export interface CodexHistoryUpdatesResponse {
  runId: string;
  threadId: string;
  userText: string;
  state: CodexHistoryRunState;
  cursor: number;
  events: CodexHistoryUpdateEvent[];
  attachments?: CodexHistoryAttachment[];
  usage?: CodexHistoryTurnUsage;
  finalResponse?: string;
  error?: string;
  resetRequired?: boolean;
  recovery?: CodexHistoryRunRecoveryStatus;
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
  /** How long completed run attachments remain available for preview. Defaults to 24 hours. */
  attachmentRetentionMs?: number;
  /** How long an unused staged attachment remains available to a draft. Defaults to 24 hours. */
  stagedAttachmentRetentionMs?: number;
  /** Optional Bridge DB cache for per-home Codex thread list summaries. */
  listCacheStore?: CodexHistoryListCacheStore;
  /** Optional Bridge DB preferences for the Home used to open each history thread. */
  threadHomePreferenceStore?: CodexHistoryThreadHomePreferenceStore;
  /** Optional Bridge DB receipts and metadata for recoverable history continuations. */
  runStore?: CodexHistoryRunStore;
  /** Injectable clock for deterministic attachment lifecycle tests. */
  now?: () => number;
}

interface StagedCodexHistoryAttachment extends CodexHistoryAttachment {
  localPath: string;
  inUse: boolean;
  createdAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

interface LiveCodexHistoryRun {
  runId: string;
  homeId: string;
  threadKey: string;
  threadId: string;
  requestFingerprint: string;
  userText: string;
  turnIndex: number;
  workingDirectory?: string;
  attachments: StagedCodexHistoryAttachment[];
  model?: string;
  reasoningEffort?: CodexHistoryReasoningEffort;
  usage?: CodexHistoryTurnUsage;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  abortController: AbortController;
  state: CodexHistoryRunState;
  cursor: number;
  events: CodexHistoryUpdateEvent[];
  finalResponse?: string;
  error?: string;
  recovered: boolean;
  recovery?: CodexHistoryRunRecoveryStatus;
  lastReconciledAt?: number;
}

interface PreparedCodexHistoryMessage {
  home: ResolvedCodexHistoryHome;
  threadId: string;
  text: string;
  attachmentIds: string[];
  turnIndex: number;
  model?: string;
  reasoningEffort?: CodexHistoryReasoningEffort;
  requestFingerprint: string;
  idempotencyKeyHash?: string;
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
  private readonly attachmentRetentionMs: number;
  private readonly stagedAttachmentRetentionMs: number;
  private readonly now: () => number;
  private readonly stagedAttachments = new Map<string, StagedCodexHistoryAttachment>();
  private readonly liveRuns = new Map<string, LiveCodexHistoryRun>();
  /** Set only after the directory is created; cleanup is limited to this physical root. */
  private attachmentRootRealPath?: string;
  private readonly modelCatalogCache = new Map<string, { expiresAt: number; models: CodexHistoryModelOption[] }>();
  private readonly restoredThreadUsageCache = new Map<string, {
    expiresAt: number;
    updatedAt?: number;
    record: CodexHistoryTurnUsageRecord | null;
  }>();
  private readonly latestRunByThread = new Map<string, string>();
  private readonly pendingThreadKeys = new Set<string>();
  private readonly pendingIdempotentMessages = new Map<string, {
    requestFingerprint: string;
    promise: Promise<CodexHistoryMessageResponse>;
  }>();
  private readonly listRefreshes = new Map<string, Promise<CodexThread[]>>();
  private readonly recoveryChecks = new Map<string, Promise<CodexHistoryRunRecoveryStatus>>();

  constructor(options: CodexHistoryServiceOptions) {
    this.options = options;
    this.attachmentsDirectory = resolve(
      options.attachmentsDirectory ?? join(tmpdir(), "feishu-codex-bridge", "codex-history-attachments"),
    );
    this.attachmentRetentionMs = normalizeRetentionMs(options.attachmentRetentionMs, 24 * 60 * 60 * 1_000);
    this.stagedAttachmentRetentionMs = normalizeRetentionMs(
      options.stagedAttachmentRetentionMs,
      24 * 60 * 60 * 1_000,
    );
    this.now = options.now ?? Date.now;
    this.restorePersistedRuns();
  }

  private restorePersistedRuns(): void {
    const store = this.options.runStore;
    if (!store) return;
    let persistedRuns: CodexHistoryStoredRun[];
    try {
      persistedRuns = store.listCodexHistoryRuns(1_000);
    } catch (error) {
      this.options.logger?.warn("failed to restore Codex history run metadata", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const persisted of persistedRuns) {
      if (!isCodexHistoryStoredRun(persisted)) continue;
      const run = this.restoreStoredRun(persisted);
      this.registerRun(run);
      if (run.state === "interrupted" || run.finishedAt !== persisted.finishedAt) this.persistRun(run);
      this.scheduleStoredRunExpiry(run);
    }
  }

  private restoreStoredRun(persisted: CodexHistoryStoredRun): LiveCodexHistoryRun {
    const wasActive = persisted.state === "running" || persisted.state === "cancelling";
    const state: CodexHistoryRunState = wasActive ? "interrupted" : persisted.state;
    const finishedAt = persisted.finishedAt ?? (wasActive || !isActiveRun(state) ? this.now() : undefined);
    let restoredAttachmentRoot = this.attachmentsDirectory;
    try {
      restoredAttachmentRoot = realpathSync.native(this.attachmentsDirectory);
      this.attachmentRootRealPath = restoredAttachmentRoot;
    } catch {
      // The attachment root is created lazily when the first attachment is staged.
    }
    const attachments = persisted.attachments.flatMap((attachment) => {
      if (!isValidAttachmentId(attachment.attachmentId)) return [];
      const fileName = sanitizeAttachmentFileName(attachment.fileName);
      if (!fileName) return [];
      return [{
        attachmentId: attachment.attachmentId,
        fileName,
        mimeType: normalizeAttachmentMimeType(attachment.mimeType),
        sizeBytes: Math.max(0, Math.trunc(attachment.sizeBytes)),
        localPath: join(
          restoredAttachmentRoot,
          `${attachment.attachmentId}${attachmentFileExtension(fileName, attachment.mimeType)}`,
        ),
        inUse: false,
        createdAt: persisted.createdAt,
      } satisfies StagedCodexHistoryAttachment];
    });
    return {
      runId: persisted.runId,
      homeId: persisted.homeId,
      threadKey: makeThreadKey(persisted.homeId, persisted.threadId),
      threadId: persisted.threadId,
      requestFingerprint: persisted.requestFingerprint,
      // Message content is intentionally re-read from official thread/read when needed.
      userText: "",
      turnIndex: persisted.turnIndex,
      attachments,
      ...(persisted.model ? { model: persisted.model } : {}),
      ...(persisted.reasoningEffort ? { reasoningEffort: persisted.reasoningEffort } : {}),
      ...(persisted.usage ? { usage: persisted.usage } : {}),
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      ...(finishedAt === undefined ? {} : { finishedAt }),
      abortController: new AbortController(),
      state,
      cursor: persisted.cursor,
      events: [],
      ...(wasActive
        ? { error: "Bridge 在 Codex turn 结束前重启；请求没有自动重发，请核对 Codex 历史后再提交。" }
        : {}),
      recovered: true,
    };
  }

  private registerRun(run: LiveCodexHistoryRun): void {
    this.liveRuns.set(run.runId, run);
    const currentRunId = this.latestRunByThread.get(run.threadKey);
    const currentRun = currentRunId ? this.liveRuns.get(currentRunId) : undefined;
    if (!currentRun || run.createdAt >= currentRun.createdAt) {
      this.latestRunByThread.set(run.threadKey, run.runId);
    }
  }

  private persistRun(run: LiveCodexHistoryRun): void {
    const store = this.options.runStore;
    if (!store) return;
    run.updatedAt = this.now();
    try {
      store.saveCodexHistoryRun(toStoredCodexHistoryRun(run));
    } catch (error) {
      this.options.logger?.warn("failed to persist Codex history run metadata", {
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleStoredRunExpiry(run: LiveCodexHistoryRun): void {
    if (run.finishedAt === undefined || isActiveRun(run.state)) return;
    if (run.expiryTimer) clearTimeout(run.expiryTimer);
    const remainingMs = Math.max(0, this.attachmentRetentionMs - (this.now() - run.finishedAt));
    run.expiryTimer = setTimeout(() => {
      void this.cleanupExpiredAttachments();
    }, remainingMs);
    run.expiryTimer.unref?.();
  }

  private async reconcileRecoveredRun(run: LiveCodexHistoryRun): Promise<CodexHistoryRunRecoveryStatus> {
    const now = this.now();
    if (run.recovery && run.lastReconciledAt !== undefined
      && now - run.lastReconciledAt < CODEX_HISTORY_RECOVERY_CHECK_INTERVAL_MS) {
      return run.recovery;
    }
    const currentCheck = this.recoveryChecks.get(run.runId);
    if (currentCheck) return currentCheck;
    const check = (async (): Promise<CodexHistoryRunRecoveryStatus> => {
      const checkedAt = new Date(this.now()).toISOString();
      let status: string | null = null;
      let error: string | undefined;
      const home = this.resolveHomes().find((candidate) => candidate.id === run.homeId);
      if (!home?.available) {
        error = "Codex home 当前不可用，稍后可重新核验。";
      } else {
        let client: CodexAppServerQueryClient | null = null;
        try {
          client = this.createClient(home);
          if (!client.readThread) throw new Error("thread/read unavailable");
          const result = await client.readThread(run.threadId, false);
          status = typeof result.thread.status?.type === "string" ? result.thread.status.type : null;
          if (result.thread.id !== run.threadId) status = null;
        } catch (cause) {
          error = "无法通过 Codex app-server 核验线程状态，稍后可重试。";
          this.options.logger?.warn("failed to reconcile recovered Codex history run", {
            runId: run.runId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        } finally {
          await client?.close().catch(() => undefined);
        }
      }
      const recovery: CodexHistoryRunRecoveryStatus = {
        checkedAt,
        codexThreadStatus: status,
        ...(error ? { error } : {}),
      };
      run.recovery = recovery;
      run.lastReconciledAt = this.now();
      return recovery;
    })();
    this.recoveryChecks.set(run.runId, check);
    try {
      return await check;
    } finally {
      if (this.recoveryChecks.get(run.runId) === check) this.recoveryChecks.delete(run.runId);
    }
  }

  public listHomes(): CodexHistoryHome[] {
    return this.resolveHomes().map(toPublicHome);
  }

  public setThreadHomePreference(threadId: string, preferredHomeId: string): {
    threadId: string;
    preferredHomeId: string;
    updatedAt: string;
  } {
    const normalizedThreadId = threadId.trim();
    const normalizedHomeId = preferredHomeId.trim();
    if (!normalizedThreadId || normalizedThreadId.length > 200) throw new Error("invalid Codex thread id");
    if (!normalizedHomeId || normalizedHomeId.length > 200) throw new Error("invalid Codex home id");
    const home = this.resolveHomes().find((candidate) => candidate.id === normalizedHomeId);
    if (!home) throw new Error("找不到 Codex home");
    if (!home.available) throw new Error("Codex home 不可用");
    const store = this.options.threadHomePreferenceStore;
    if (!store) throw new Error("Codex history preferences are not configured");
    const updatedAt = store.saveCodexHistoryThreadHomePreference(normalizedThreadId, normalizedHomeId);
    return { threadId: normalizedThreadId, preferredHomeId: normalizedHomeId, updatedAt };
  }

  public async readUsage(homeId?: string): Promise<CodexHistoryUsageResponse> {
    const generatedAt = new Date().toISOString();
    const homes = this.resolveHomes();
    const selectedHomes = homeId ? homes.filter((home) => home.id === homeId) : homes;
    if (homeId && selectedHomes.length === 0) throw new Error("找不到 Codex home");
    const accounts = await Promise.all(selectedHomes.map(async (home) => {
      const checkedAt = new Date().toISOString();
      if (!home.available) {
        return {
          homeId: home.id,
          label: home.label,
          available: false,
          checkedAt,
          errors: { quota: "Codex home 不可用。", tokenUsage: "Codex home 不可用。" },
        } satisfies CodexHistoryUsageAccount;
      }

      let client: CodexAppServerQueryClient | null = null;
      try {
        client = this.createClient(home);
        const quotaRequest = client.readAccountRateLimits
          ? client.readAccountRateLimits()
          : Promise.reject(new Error("account/rateLimits/read is unavailable"));
        const tokenUsageRequest = client.readAccountTokenUsage
          ? client.readAccountTokenUsage()
          : Promise.reject(new Error("account/usage/read is unavailable"));
        const [quotaResult, tokenUsageResult] = await Promise.allSettled([quotaRequest, tokenUsageRequest]);
        const errors: NonNullable<CodexHistoryUsageAccount["errors"]> = {};
        const quota = quotaResult.status === "fulfilled" ? publicQuotaResponse(quotaResult.value) : undefined;
        if (quotaResult.status === "rejected") {
          errors.quota = "读取额度失败，请确认该账户的 Codex 登录状态和网络连接。";
        }
        if (tokenUsageResult.status === "rejected") {
          errors.tokenUsage = "账户每日 Token 统计暂不可用。";
        }
        return {
          homeId: home.id,
          label: home.label,
          available: true,
          checkedAt,
          ...(quota ? { quota } : {}),
          ...(tokenUsageResult.status === "fulfilled"
            ? { tokenUsage: publicTokenUsageResponse(tokenUsageResult.value) }
            : {}),
          ...(Object.keys(errors).length > 0 ? { errors } : {}),
        } satisfies CodexHistoryUsageAccount;
      } catch {
        return {
          homeId: home.id,
          label: home.label,
          available: true,
          checkedAt,
          errors: {
            quota: "读取额度失败，请确认该账户的 Codex 登录状态和网络连接。",
            tokenUsage: "账户每日 Token 统计暂不可用。",
          },
        } satisfies CodexHistoryUsageAccount;
      } finally {
        if (client) await client.close().catch(() => undefined);
      }
    }));
    return { generatedAt, dataSource: "codex-app-server", accounts };
  }

  public async consumeResetCredit(
    homeId: string,
    creditId: string,
    idempotencyKey: string,
  ): Promise<CodexResetCreditConsumeResponse> {
    const home = this.resolveHomes().find((candidate) => candidate.id === homeId);
    if (!home) throw new Error("Codex home not found");
    if (!home.available) throw new Error("Codex home is unavailable");
    const normalizedCreditId = creditId.trim();
    const normalizedIdempotencyKey = idempotencyKey.trim();
    if (!normalizedCreditId || !normalizedIdempotencyKey) throw new Error("creditId and idempotencyKey are required");

    const client = this.createResetCreditClient(home);
    try {
      return await client.consumeAccountRateLimitResetCredit({
        creditId: normalizedCreditId,
        idempotencyKey: normalizedIdempotencyKey,
      });
    } finally {
      await client.close();
    }
  }

  public async listThreads(query: CodexHistoryQuery): Promise<CodexHistoryListResponse> {
    const resolvedHomes = this.resolveHomes();
    if (query.homeId && !resolvedHomes.some((home) => home.id === query.homeId)) {
      throw new Error(`找不到 Codex home：${query.homeId || "(none)"}`);
    }

    // Read every configured Home so the account filter can be applied to each
    // thread's saved Home preference, rather than only its source account.
    const results = await Promise.all(resolvedHomes.map(async (home) => {
      try {
        const threads = await this.queryHomeWithCache(home, query);
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

    const sourceItems = results.flatMap(({ home, threads }) => threads.map((thread) => ({
      home: toPublicHome(home),
      thread,
    })));
    const resultHomes = new Map(results.map(({ home }) => [home.id, home]));
    const homePreferences = this.options.threadHomePreferenceStore?.getCodexHistoryThreadHomePreferences(
      sourceItems.map((item) => item.thread.id),
    ) ?? new Map<string, string>();
    const preferredItems = sourceItems.map((item) => {
      const preferredHomeId = homePreferences.get(item.thread.id);
      return { ...item, preferredHomeId };
    });
    const filteredItems = query.homeId
      ? preferredItems.filter((item) => (item.preferredHomeId || item.home.id) === query.homeId)
      : preferredItems;
    filteredItems.sort((left, right) => compareThreads(left.thread, right.thread, query.sortKey, query.sortDirection));
    const pageItems = filteredItems.slice(query.offset, query.offset + query.limit);

    return {
      items: pageItems,
      total: filteredItems.length,
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
      const models = includeTurns ? await this.readModelCatalog(home, client) : undefined;
      let turnUsages = this.listTurnUsages(homeId, threadId, result.thread);
      const threadTurns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
      const latestTurnIndex = threadTurns.length - 1;
      const latestTurnHasUsage = turnUsages.some((item) => item.turnIndex === latestTurnIndex);
      // CLI-originated histories lack SDK live events; restore the latest official app-server usage only for an idle, unlocked thread.
      if (includeTurns
        && latestTurnIndex >= 0
        && !latestTurnHasUsage
        && result.thread.status?.type !== "active"
        && client.readThreadTokenUsage) {
        const writerStatus = await this.getWriterStatus(homeId, threadId).catch(() => ({ state: "unknown" as const }));
        if (writerStatus.state === "available") {
          try {
            const snapshot = await client.readThreadTokenUsage(threadId);
            const usageRecord = snapshot
              ? tokenUsageRecordForThreadTurn(snapshot, threadTurns, latestTurnIndex)
              : null;
            const threadKey = makeThreadKey(homeId, threadId);
            this.restoredThreadUsageCache.set(threadKey, {
              expiresAt: Date.now() + 5 * 60 * 1_000,
              ...(typeof result.thread.updatedAt === "number" ? { updatedAt: result.thread.updatedAt } : {}),
              record: usageRecord,
            });
            turnUsages = this.listTurnUsages(homeId, threadId, result.thread);
          } catch {
            // Token usage is optional detail data; keep the thread itself readable.
          }
        }
      }
      return {
        home: toPublicHome(home),
        thread: result.thread,
        imageAttachments: this.listTurnAttachments(homeId, threadId),
        ...(models ? { models } : {}),
        ...(turnUsages.length > 0 ? { turnUsages } : {}),
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
    await this.cleanupExpiredAttachments();
    if (input.data.length === 0) throw new Error("附件不能为空。");
    if (input.data.length > CODEX_HISTORY_MAX_ATTACHMENT_BYTES) {
      throw new Error("单个附件不能超过 25 MiB。");
    }
    const fileName = sanitizeAttachmentFileName(input.fileName);
    if (!fileName) throw new Error("附件文件名无效。");
    const mimeType = normalizeAttachmentMimeType(input.mimeType);
    const attachmentId = randomUUID();
    const attachmentRoot = await this.ensureAttachmentRoot();
    const localPath = join(attachmentRoot, `${attachmentId}${attachmentFileExtension(fileName, mimeType)}`);
    await writeFile(localPath, input.data, { flag: "wx", mode: 0o600 });
    const createdAt = this.now();
    const attachment: StagedCodexHistoryAttachment = {
      attachmentId,
      fileName,
      mimeType,
      sizeBytes: input.data.length,
      localPath,
      inUse: false,
      createdAt,
    };
    this.stagedAttachments.set(attachmentId, attachment);
    this.scheduleStagedAttachmentExpiry(attachment);
    return publicAttachment(attachment);
  }

  public async deleteStagedAttachment(attachmentId: string): Promise<boolean> {
    const attachment = this.stagedAttachments.get(attachmentId);
    if (!attachment || attachment.inUse) return false;
    this.stagedAttachments.delete(attachmentId);
    if (attachment.expiryTimer) clearTimeout(attachment.expiryTimer);
    await this.unlinkOwnedAttachment(attachment);
    return true;
  }

  public sendMessage(
    homeId: string,
    threadId: string,
    input: CodexHistoryMessageInput,
  ): Promise<CodexHistoryMessageResponse> {
    const prepared = this.prepareMessage(homeId, threadId, input);
    const keyHash = prepared.idempotencyKeyHash;
    if (keyHash) {
      const pending = this.pendingIdempotentMessages.get(keyHash);
      if (pending) {
        if (pending.requestFingerprint !== prepared.requestFingerprint) {
          return Promise.reject(new CodexHistoryIdempotencyConflictError());
        }
        return pending.promise;
      }
    }

    const promise = this.submitPreparedMessage(prepared);
    if (keyHash) {
      this.pendingIdempotentMessages.set(keyHash, {
        requestFingerprint: prepared.requestFingerprint,
        promise,
      });
      void promise.then(
        () => this.clearPendingIdempotentMessage(keyHash, promise),
        () => this.clearPendingIdempotentMessage(keyHash, promise),
      );
    }
    return promise;
  }

  private prepareMessage(homeId: string, threadId: string, input: CodexHistoryMessageInput): PreparedCodexHistoryMessage {
    const home = this.resolveHomes().find((candidate) => candidate.id === homeId);
    if (!home) throw new Error(`找不到 Codex home：${homeId}`);
    if (!home.available) throw new Error(`Codex home 不可用：${home.path}`);
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("threadId is required");
    if (input.model !== undefined && typeof input.model !== "string") {
      throw new Error("model must be a string");
    }
    const text = input.text.trim();
    const model = input.model?.trim();
    if (model && (model.length > 128 || /[\r\n]/.test(model))) {
      throw new Error("model must be a single line of at most 128 characters");
    }
    if (input.reasoningEffort !== undefined && !isCodexHistoryReasoningEffort(input.reasoningEffort)) {
      throw new Error("reasoningEffort is invalid");
    }
    if (input.turnIndex !== undefined && (!Number.isSafeInteger(input.turnIndex) || input.turnIndex < 0)) {
      throw new Error("turnIndex must be a non-negative integer");
    }
    if (input.idempotencyKey !== undefined
      && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.trim().length > 200)) {
      throw new Error("idempotencyKey must contain 1 to 200 characters");
    }
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (attachmentIds.some((attachmentId) => typeof attachmentId !== "string" || !attachmentId.trim())) {
      throw new Error("attachmentIds must contain non-empty strings");
    }
    if (attachmentIds.length > CODEX_HISTORY_MAX_ATTACHMENTS) {
      throw new Error(`一次最多发送 ${CODEX_HISTORY_MAX_ATTACHMENTS} 个附件。`);
    }
    if (!text && attachmentIds.length === 0) {
      throw new Error("请输入消息或选择附件。");
    }
    const turnIndex = input.turnIndex ?? 0;
    const requestFingerprint = fingerprintCodexHistoryMessage({
      text,
      attachmentIds,
      turnIndex,
      model: model || undefined,
      reasoningEffort: input.reasoningEffort,
    });
    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey && !this.options.runStore) {
      throw new Error("历史续聊幂等存储尚未配置。");
    }
    const idempotencyKeyHash = idempotencyKey
      ? createHash("sha256").update(JSON.stringify([home.id, normalizedThreadId, idempotencyKey])).digest("hex")
      : undefined;
    return {
      home,
      threadId: normalizedThreadId,
      text,
      attachmentIds,
      turnIndex,
      ...(model ? { model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      requestFingerprint,
      ...(idempotencyKeyHash ? { idempotencyKeyHash } : {}),
    };
  }

  private clearPendingIdempotentMessage(keyHash: string, promise: Promise<CodexHistoryMessageResponse>): void {
    if (this.pendingIdempotentMessages.get(keyHash)?.promise === promise) {
      this.pendingIdempotentMessages.delete(keyHash);
    }
  }

  private async submitPreparedMessage(prepared: PreparedCodexHistoryMessage): Promise<CodexHistoryMessageResponse> {
    await this.cleanupExpiredAttachments();
    const { home, threadId, text, attachmentIds, turnIndex, model, reasoningEffort } = prepared;
    const threadKey = makeThreadKey(home.id, threadId);
    const store = this.options.runStore;
    const keyHash = prepared.idempotencyKeyHash;
    if (keyHash && store) {
      const receipt = store.findCodexHistoryRunByKey(home.id, threadId, keyHash);
      if (receipt) {
        if (receipt.requestFingerprint !== prepared.requestFingerprint) {
          throw new CodexHistoryIdempotencyConflictError();
        }
        if (!receipt.run) throw new CodexHistoryIdempotencyExpiredError();
        const run = this.liveRuns.get(receipt.runId) ?? this.restoreStoredRun(receipt.run);
        this.registerRun(run);
        return messageResponseForRun(run);
      }
    }

    if (this.pendingThreadKeys.has(threadKey)) {
      throw new Error("当前 Codex session 正在处理上一条消息，请等待本轮完成。");
    }
    const latestRun = this.latestRunByThread.get(threadKey);
    if (latestRun && isActiveRun(this.liveRuns.get(latestRun)?.state)) {
      throw new Error("当前 Codex session 正在处理上一条消息，请等待本轮完成。");
    }

    this.pendingThreadKeys.add(threadKey);
    let resolvedAttachments: StagedCodexHistoryAttachment[] = [];
    let attachmentsReserved = false;
    let registered = false;
    try {
      const writerStatus = await this.getWriterStatus(home.id, threadId);
      if (writerStatus.state === "busy") {
        throw new Error("该 Codex session 正在其他位置使用，请先在原窗口结束或关闭此 session 后再发送。");
      }
      const currentRunId = this.latestRunByThread.get(threadKey);
      if (currentRunId && isActiveRun(this.liveRuns.get(currentRunId)?.state)) {
        throw new Error("当前 Codex session 正在处理上一条消息，请等待本轮完成。");
      }

      const currentThread = await this.readThread(home.id, threadId, false);
      const workingDirectory = currentThread.thread.cwd?.trim()
        ? resolve(currentThread.thread.cwd)
        : undefined;
      const currentModel = currentThread.thread.model?.trim() || undefined;
      const catalog = this.modelCatalogCache.get(home.id);
      const usableCatalog = catalog && catalog.expiresAt > Date.now() ? catalog.models : undefined;
      if (model && usableCatalog && !usableCatalog.some((candidate) => candidate.model === model)) {
        throw new Error("所选模型已不在当前账户的可用列表中，请刷新会话后重试。");
      }
      if (reasoningEffort) {
        const targetModel = model || currentModel;
        const selectedModel = usableCatalog && targetModel
          ? usableCatalog.find((candidate) => candidate.model === targetModel)
          : undefined;
        if (selectedModel
          && !selectedModel.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === reasoningEffort)) {
          throw new Error("所选推理强度不受当前模型支持，请重新选择。");
        }
      }
      const attachments = attachmentIds.map((attachmentId) => this.stagedAttachments.get(attachmentId));
      if (attachments.some((attachment) => !attachment)) {
        throw new Error("历史会话附件已失效，请重新选择附件。");
      }
      resolvedAttachments = attachments as StagedCodexHistoryAttachment[];
      if (resolvedAttachments.some((attachment) => attachment.inUse)) {
        throw new Error("历史会话附件已被另一轮 Codex 消息使用，请重新选择附件。");
      }
      for (const attachment of resolvedAttachments) {
        attachment.inUse = true;
        if (attachment.expiryTimer) clearTimeout(attachment.expiryTimer);
      }
      attachmentsReserved = true;

      const now = this.now();
      const run: LiveCodexHistoryRun = {
        runId: randomUUID(),
        homeId: home.id,
        threadKey,
        threadId,
        requestFingerprint: prepared.requestFingerprint,
        userText: text,
        turnIndex,
        ...(workingDirectory ? { workingDirectory } : {}),
        attachments: resolvedAttachments,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        createdAt: now,
        updatedAt: now,
        abortController: new AbortController(),
        state: "running",
        cursor: 0,
        events: [],
        recovered: false,
      };
      if (store) {
        const created = store.createCodexHistoryRun(toStoredCodexHistoryRun(run), keyHash);
        if (created.kind === "conflict") throw new CodexHistoryIdempotencyConflictError();
        if (created.kind === "expired") throw new CodexHistoryIdempotencyExpiredError();
        if (created.kind === "existing") {
          if (!created.run) throw new CodexHistoryIdempotencyExpiredError();
          for (const attachment of resolvedAttachments) {
            attachment.inUse = false;
            this.scheduleStagedAttachmentExpiry(attachment);
          }
          attachmentsReserved = false;
          const existing = this.liveRuns.get(created.run.runId) ?? this.restoreStoredRun(created.run);
          this.registerRun(existing);
          return messageResponseForRun(existing);
        }
      }
      this.registerRun(run);
      registered = true;
      await this.cleanupExpiredAttachments();
      void this.runMessage(home, run, resolvedAttachments).catch((error) => {
        this.finishLiveRunWithError(run, error);
      });
      return messageResponseForRun(run);
    } finally {
      if (attachmentsReserved && !registered) {
        for (const attachment of resolvedAttachments) {
          attachment.inUse = false;
          this.scheduleStagedAttachmentExpiry(attachment);
        }
      }
      this.pendingThreadKeys.delete(threadKey);
    }
  }

  public async getMessageUpdates(
    homeId: string,
    threadId: string,
    runId: string | undefined,
    afterCursor: number,
  ): Promise<CodexHistoryUpdatesResponse> {
    const normalizedThreadId = threadId.trim();
    const threadKey = makeThreadKey(homeId, normalizedThreadId);
    const selectedRunId = runId?.trim() || this.latestRunByThread.get(threadKey);
    const run = selectedRunId ? this.liveRuns.get(selectedRunId) : undefined;
    if (!run || run.threadKey !== threadKey) {
      throw new Error("找不到正在运行或刚刚完成的 Codex turn。");
    }
    if (run.recovered) await this.reconcileRecoveredRun(run);
    const firstCursor = run.events[0]?.cursor;
    const resetRequired = run.recovered || (firstCursor !== undefined && afterCursor < firstCursor - 1);
    return {
      runId: run.runId,
      threadId: run.threadId,
      userText: run.userText,
      state: run.state,
      cursor: run.cursor,
      events: resetRequired ? [] : run.events.filter((event) => event.cursor > afterCursor),
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.finalResponse ? { finalResponse: run.finalResponse } : {}),
      ...(run.error ? { error: run.error } : {}),
      attachments: run.attachments.map(publicAttachment),
      ...(resetRequired ? { resetRequired: true } : {}),
      ...(run.recovery ? { recovery: run.recovery } : {}),
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
    this.persistRun(run);
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
    if (!attachment) return null;
    try {
      const root = this.attachmentRootRealPath ?? realpathSync.native(this.attachmentsDirectory);
      if (realpathSync.native(dirname(attachment.localPath)) !== root) return null;
      const fileInfo = lstatSync(attachment.localPath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return null;
    } catch {
      return null;
    }
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
          turnIndex: localRun.turnIndex,
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

  private listTurnUsages(homeId: string, threadId: string, thread?: CodexThread): CodexHistoryTurnUsageRecord[] {
    const threadKey = makeThreadKey(homeId, threadId);
    const usages = new Map<number, CodexHistoryTurnUsage>();
    const restored = this.restoredThreadUsageCache.get(threadKey);
    if (restored
      && restored.expiresAt > Date.now()
      && restored.updatedAt === thread?.updatedAt
      && restored.record) {
      usages.set(restored.record.turnIndex, restored.record.usage);
    } else if (restored && (restored.expiresAt <= Date.now() || restored.updatedAt !== thread?.updatedAt)) {
      this.restoredThreadUsageCache.delete(threadKey);
    }
    for (const run of [...this.liveRuns.values()]
      .filter((candidate) => candidate.threadKey === threadKey && candidate.usage)
      .sort((left, right) => left.createdAt - right.createdAt)) {
      usages.set(run.turnIndex, run.usage!);
    }
    return [...usages.entries()].map(([turnIndex, usage]) => ({ turnIndex, usage }));
  }

  private resolveHomes(): ResolvedCodexHistoryHome[] {
    const homeDirectory = homedir();
    const configuredHome = normalizePath(
      this.options.environment?.CODEX_HOME || join(homeDirectory, ".codex"),
      homeDirectory,
    );
    const primaryHome = codexAccountsRoot(configuredHome, homeDirectory);
    const configuredHomes = this.options.homePaths?.length
      ? this.options.homePaths
      : discoverCodexHomePaths(this.options.environment, homeDirectory);
    const paths = uniquePaths([
      primaryHome,
      configuredHome,
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

  private async queryHomeWithCache(home: ResolvedCodexHistoryHome, query: CodexHistoryQuery): Promise<CodexThread[]> {
    const cacheStore = this.options.listCacheStore;
    if (!cacheStore) return this.queryHome(home, query);

    const archivedValues: boolean[] = query.archived === "all"
      ? [false, true]
      : [query.archived === "archived"];
    const threads: CodexThread[] = [];
    const seenThreadIds = new Set<string>();

    for (const archived of archivedValues) {
      const partitionQuery: CodexHistoryQuery = {
        ...query,
        archived: archived ? "archived" : "active",
      };
      const filterKey = codexHistoryListCacheFilterKey(partitionQuery, archived);
      const sourceFingerprint = codexHistorySourceFingerprint(home);
      let cached: ReturnType<CodexHistoryListCacheStore["getCodexHistoryListCache"]> = null;
      try {
        cached = cacheStore.getCodexHistoryListCache(home.id, filterKey);
      } catch {
        // Cache storage is an optimization; fall back to app-server on cache read errors.
      }
      const refreshedAt = cached ? Date.parse(cached.refreshedAt) : Number.NaN;
      if (cached
        && sourceFingerprint
        && cached.sourceFingerprint === sourceFingerprint
        && Number.isFinite(refreshedAt)
        && Date.now() - refreshedAt >= 0
        && Date.now() - refreshedAt <= CODEX_HISTORY_LIST_CACHE_MAX_AGE_MS) {
        const cachedThreads = parseCodexHistoryListCache(cached.payloadJson);
        if (cachedThreads) {
          for (const thread of cachedThreads) {
            if (seenThreadIds.has(thread.id)) continue;
            seenThreadIds.add(thread.id);
            threads.push(thread);
          }
          continue;
        }
      }

      const refreshKey = `${home.id}:${filterKey}`;
      let refresh = this.listRefreshes.get(refreshKey);
      if (!refresh) {
        refresh = this.queryHome(home, partitionQuery).then((freshThreads) => {
          const payloadJson = JSON.stringify(freshThreads);
          const nextFingerprint = codexHistorySourceFingerprint(home);
          if (sourceFingerprint
            && nextFingerprint === sourceFingerprint
            && Buffer.byteLength(payloadJson) <= CODEX_HISTORY_LIST_CACHE_MAX_BYTES) {
            try {
              cacheStore.saveCodexHistoryListCache(home.id, filterKey, sourceFingerprint, payloadJson);
            } catch {
              // A cache write failure must not hide a successful history read.
            }
          }
          return freshThreads;
        }).finally(() => {
          this.listRefreshes.delete(refreshKey);
        });
        this.listRefreshes.set(refreshKey, refresh);
      }
      for (const thread of await refresh) {
        if (seenThreadIds.has(thread.id)) continue;
        seenThreadIds.add(thread.id);
        threads.push(thread);
      }
    }

    return threads;
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

  private createResetCreditClient(home: ResolvedCodexHistoryHome): CodexAppServerClient {
    const environment = { ...(this.options.environment ?? {}) };
    environment.CODEX_HOME = home.path;
    if (home.sqliteHome) environment.CODEX_SQLITE_HOME = home.sqliteHome;
    else delete environment.CODEX_SQLITE_HOME;
    return new CodexAppServerClient({
      executable: this.options.executable,
      cwd: this.options.cwd,
      env: environment,
      requestTimeoutMs: this.options.requestTimeoutMs,
      clientName: "feishu_codex_bridge_usage_action",
      clientTitle: "Feishu Codex Bridge (confirmed usage action)",
      allowRateLimitResetCreditConsumption: true,
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

  private async readModelCatalog(
    home: ResolvedCodexHistoryHome,
    client: CodexAppServerQueryClient,
  ): Promise<CodexHistoryModelOption[] | undefined> {
    const cached = this.modelCatalogCache.get(home.id);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    if (!client.listModels) return undefined;
    try {
      const response: CodexModelListResponse = await client.listModels();
      const models = response.data
        .filter((model) => !model.hidden)
        .map((model): CodexHistoryModelOption => {
          const supportedReasoningEfforts = model.supportedReasoningEfforts.filter((effort) =>
            isCodexHistoryReasoningEffort(effort.reasoningEffort));
          return {
            model: model.model,
            displayName: model.displayName,
            description: model.description,
            isDefault: model.isDefault,
            ...(model.defaultReasoningEffort && isCodexHistoryReasoningEffort(model.defaultReasoningEffort)
              ? { defaultReasoningEffort: model.defaultReasoningEffort }
              : {}),
            supportedReasoningEfforts,
          };
        });
      this.modelCatalogCache.set(home.id, { expiresAt: Date.now() + 5 * 60 * 1_000, models });
      return models;
    } catch (error) {
      this.options.logger?.warn("failed to read Codex model catalog", {
        home: home.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async runMessage(
    home: ResolvedCodexHistoryHome,
    run: LiveCodexHistoryRun,
    attachments: StagedCodexHistoryAttachment[],
  ): Promise<void> {
    try {
      const agent = this.createAgent(home);
      const directories = [...new Set(attachments.map((attachment) => dirname(attachment.localPath)))];
      const threadOptions: ThreadOptions = {
        ...(run.workingDirectory ? { workingDirectory: run.workingDirectory } : {}),
        ...(directories.length > 0 ? { additionalDirectories: directories } : {}),
        ...(run.model ? { model: run.model } : {}),
        // model/list is authoritative for the configured Codex executable; the SDK declaration can lag new effort values.
        ...(run.reasoningEffort
          ? { modelReasoningEffort: run.reasoningEffort as NonNullable<ThreadOptions["modelReasoningEffort"]> }
          : {}),
      };
      const thread = agent.resumeThread(
        run.threadId,
        Object.keys(threadOptions).length > 0 ? threadOptions : undefined,
      );
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
        if (this.stagedAttachments.get(attachment.attachmentId) === attachment) {
          this.stagedAttachments.delete(attachment.attachmentId);
        }
        if (attachment.expiryTimer) clearTimeout(attachment.expiryTimer);
      }
      this.scheduleRunExpiry(run);
      await this.cleanupExpiredAttachments();
    }
  }

  private recordLiveEvent(run: LiveCodexHistoryRun, event: ThreadEvent): void {
    const record = asRecord(event);
    const type = typeof record.type === "string" ? record.type : "codex.event";
    const item = record.item;
    const usage = type === "turn.completed" ? parseSdkTurnUsage(record.usage) : undefined;
    if (usage) run.usage = usage;
    const update: CodexHistoryUpdateEvent = {
      cursor: run.cursor + 1,
      type,
      ...(item !== undefined ? { item } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(usage ? { usage } : {}),
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
    if (run.state === "completed" || run.state === "failed" || this.now() - run.updatedAt >= 1_000) {
      this.persistRun(run);
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
    this.persistRun(run);
  }

  private scheduleRunExpiry(run: LiveCodexHistoryRun): void {
    run.finishedAt = this.now();
    this.persistRun(run);
    run.expiryTimer = setTimeout(() => {
      void this.cleanupExpiredAttachments();
    }, this.attachmentRetentionMs);
    run.expiryTimer.unref?.();
  }

  private scheduleStagedAttachmentExpiry(attachment: StagedCodexHistoryAttachment): void {
    attachment.expiryTimer = setTimeout(() => {
      void this.cleanupExpiredAttachments();
    }, this.stagedAttachmentRetentionMs);
    attachment.expiryTimer.unref?.();
  }

  /**
   * Prune expired staged files and terminal runs owned by this service instance.
   * Unknown files are deliberately left alone: after restart there is no durable
   * ownership record proving that an attachment is an orphan or inactive.
   */
  public async cleanupExpiredAttachments(): Promise<void> {
    const now = this.now();
    const finishedRuns = [...this.liveRuns.values()]
      .filter((run) => run.finishedAt !== undefined && !isActiveRun(run.state))
      .sort(compareFinishedRuns);
    const runsToExpire = new Set<LiveCodexHistoryRun>();

    for (const run of finishedRuns) {
      if (now - run.finishedAt! >= this.attachmentRetentionMs) runsToExpire.add(run);
    }

    const runsByThread = new Map<string, LiveCodexHistoryRun[]>();
    for (const run of finishedRuns) {
      const threadRuns = runsByThread.get(run.threadKey) ?? [];
      threadRuns.push(run);
      runsByThread.set(run.threadKey, threadRuns);
    }
    for (const threadRuns of runsByThread.values()) {
      for (const run of threadRuns.slice(0, Math.max(0, threadRuns.length - 4))) runsToExpire.add(run);
    }
    for (const run of finishedRuns.slice(0, Math.max(0, finishedRuns.length - 40))) runsToExpire.add(run);

    const stagedToExpire = [...this.stagedAttachments.values()]
      .filter((attachment) => !attachment.inUse
        && now - attachment.createdAt >= this.stagedAttachmentRetentionMs);
    const stagedFilesToUnlink: StagedCodexHistoryAttachment[] = [];
    for (const attachment of stagedToExpire) {
      if (this.stagedAttachments.get(attachment.attachmentId) !== attachment
        || attachment.inUse
        || now - attachment.createdAt < this.stagedAttachmentRetentionMs) continue;
      this.stagedAttachments.delete(attachment.attachmentId);
      if (attachment.expiryTimer) clearTimeout(attachment.expiryTimer);
      stagedFilesToUnlink.push(attachment);
    }
    await Promise.all([
      ...stagedFilesToUnlink.map((attachment) => this.unlinkOwnedAttachment(attachment)),
      ...[...runsToExpire].map((run) => this.expireRun(run)),
    ]);
  }

  private async expireRun(run: LiveCodexHistoryRun): Promise<void> {
    if (this.liveRuns.get(run.runId) !== run || run.finishedAt === undefined || isActiveRun(run.state)) return;
    this.liveRuns.delete(run.runId);
    if (run.expiryTimer) clearTimeout(run.expiryTimer);
    if (this.latestRunByThread.get(run.threadKey) === run.runId) this.latestRunByThread.delete(run.threadKey);
    try {
      this.options.runStore?.expireCodexHistoryRun(run.runId);
    } catch (error) {
      this.options.logger?.warn("failed to expire Codex history run metadata", {
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (run.attachments.length > 0 && !this.attachmentRootRealPath) {
      await this.ensureAttachmentRoot().catch(() => undefined);
    }
    for (const attachment of run.attachments) await this.unlinkOwnedAttachment(attachment);
  }

  private async ensureAttachmentRoot(): Promise<string> {
    await mkdir(this.attachmentsDirectory, { recursive: true, mode: 0o700 });
    const actualRoot = await realpath(this.attachmentsDirectory);
    if (this.attachmentRootRealPath && this.attachmentRootRealPath !== actualRoot) {
      throw new Error("Codex History attachment directory changed after staging began.");
    }
    this.attachmentRootRealPath = actualRoot;
    return actualRoot;
  }

  private async unlinkOwnedAttachment(attachment: StagedCodexHistoryAttachment): Promise<boolean> {
    const root = this.attachmentRootRealPath;
    if (!root) return false;
    return unlinkOwnedCodexHistoryAttachment(root, attachment.localPath, attachment.attachmentId);
  }
}

export function discoverCodexHomePaths(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): string[] {
  const configuredHome = normalizePath(
    environment.CODEX_HOME || join(homeDirectory, ".codex"),
    homeDirectory,
  );
  const primaryHome = codexAccountsRoot(configuredHome, homeDirectory);
  const explicitHomes = [
    environment.FEISHU_CODEX_HISTORY_HOMES,
    environment.CODEX_HISTORY_HOMES,
  ].flatMap((value) => value ? value.split(delimiter) : [])
    .map((value) => normalizePath(value, homeDirectory));
  const accountHomes = readAccountHomes(primaryHome);
  return uniquePaths([primaryHome, configuredHome, ...accountHomes, ...explicitHomes]);
}

export function discoverCodexHistoryHomes(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): CodexHistoryHome[] {
  const configuredHome = normalizePath(
    environment.CODEX_HOME || join(homeDirectory, ".codex"),
    homeDirectory,
  );
  const primaryHome = codexAccountsRoot(configuredHome, homeDirectory);
  return discoverCodexHomePaths(environment, homeDirectory)
    .map((path) => toPublicHome(buildHome(normalizePath(path, homeDirectory), primaryHome)));
}

function codexAccountsRoot(configuredHome: string, homeDirectory: string): string {
  const defaultHome = normalizePath(join(homeDirectory, ".codex"), homeDirectory);
  const relativeToDefaultAccounts = relative(join(defaultHome, "accounts"), configuredHome);
  const firstSegment = relativeToDefaultAccounts.split(/[\\/]/, 1)[0];
  return relativeToDefaultAccounts === ""
    || relativeToDefaultAccounts === "."
    || firstSegment !== ".."
    ? defaultHome
    : configuredHome;
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

function codexHistoryListCacheFilterKey(query: CodexHistoryQuery, archived: boolean): string {
  const filter = {
    archived,
    searchTerm: query.searchTerm ?? "",
    statuses: [...(query.statuses ?? [])].sort(),
    sourceKinds: [...query.sourceKinds].sort(),
    modelProviders: [...(query.modelProviders ?? [])].sort(),
    cwd: [...(query.cwd ?? [])].map((path) => resolve(path)).sort(),
    sortKey: query.sortKey,
    sortDirection: query.sortDirection,
  };
  return createHash("sha256").update(JSON.stringify(filter)).digest("hex");
}

function codexHistorySourceFingerprint(home: ResolvedCodexHistoryHome): string | null {
  if (!home.sqliteHome) return null;
  try {
    const files = readdirSync(home.sqliteHome)
      .filter((name) => /^state_\d+\.sqlite(?:-(?:wal|journal))?$/.test(name))
      .sort();
    if (files.length === 0) return null;
    const snapshot = files.map((name) => {
      const file = statSync(join(home.sqliteHome!, name));
      return `${name}:${file.size}:${file.mtimeMs}:${file.ino}`;
    }).join("\n");
    return createHash("sha256").update(snapshot).digest("hex");
  } catch {
    return null;
  }
}

function parseCodexHistoryListCache(payloadJson: string): CodexThread[] | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!Array.isArray(parsed)) return null;
    const threads: CodexThread[] = [];
    for (const value of parsed) {
      const record = asRecord(value);
      if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
      threads.push(record as unknown as CodexThread);
    }
    return threads;
  } catch {
    return null;
  }
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

function publicQuotaResponse(response: CodexAccountRateLimitsResponse): NonNullable<CodexHistoryUsageAccount["quota"]> {
  const byLimitId = response.rateLimitsByLimitId ?? {};
  let buckets = Object.entries(byLimitId).map(([limitId, snapshot]) => publicRateLimitSnapshot(snapshot, limitId));
  if (buckets.length === 0 && response.rateLimits) {
    buckets = [publicRateLimitSnapshot(response.rateLimits, response.rateLimits.limitId || "codex")];
  }
  const planType = buckets.find((bucket) => bucket.planType)?.planType;
  const resetCreditsAvailableCount = response.rateLimitResetCredits?.availableCount;
  const resetCredits = response.rateLimitResetCredits?.credits;
  return {
    ordinaryUsageAllowed: response.ordinaryUsageAllowed ?? null,
    ...(planType === undefined ? {} : { planType }),
    buckets,
    ...(resetCreditsAvailableCount === undefined ? {} : { resetCreditsAvailableCount }),
    ...(resetCredits === undefined ? {} : {
      resetCredits: resetCredits === null ? null : resetCredits.map(publicResetCredit),
    }),
  };
}

function publicResetCredit(credit: CodexAccountResetCredit): CodexAccountResetCredit {
  return {
    id: credit.id,
    status: credit.status,
    grantedAt: credit.grantedAt,
    ...(credit.resetType === undefined ? {} : { resetType: credit.resetType }),
    ...(credit.expiresAt === undefined ? {} : { expiresAt: credit.expiresAt }),
    ...(credit.title === undefined ? {} : { title: credit.title }),
    ...(credit.description === undefined ? {} : { description: credit.description }),
  };
}

function publicRateLimitSnapshot(
  snapshot: CodexAccountRateLimitSnapshot,
  fallbackLimitId: string,
): CodexAccountRateLimitSnapshot {
  return {
    limitId: snapshot.limitId || fallbackLimitId,
    ...(snapshot.limitName == null ? {} : { limitName: snapshot.limitName }),
    ...(snapshot.normalModelSlug == null ? {} : { normalModelSlug: snapshot.normalModelSlug }),
    ...(snapshot.planType == null ? {} : { planType: snapshot.planType }),
    ...(snapshot.primary === undefined ? {} : { primary: publicRateLimitWindow(snapshot.primary) }),
    ...(snapshot.secondary === undefined ? {} : { secondary: publicRateLimitWindow(snapshot.secondary) }),
    ...(snapshot.credits === undefined ? {} : {
      credits: snapshot.credits === null ? null : {
        ...(snapshot.credits.balance === undefined ? {} : { balance: snapshot.credits.balance }),
        ...(snapshot.credits.hasCredits === undefined ? {} : { hasCredits: snapshot.credits.hasCredits }),
        ...(snapshot.credits.unlimited === undefined ? {} : { unlimited: snapshot.credits.unlimited }),
      },
    }),
    ...(snapshot.individualLimit === undefined ? {} : {
      individualLimit: snapshot.individualLimit === null ? null : {
        ...(snapshot.individualLimit.limit === undefined ? {} : { limit: snapshot.individualLimit.limit }),
        ...(snapshot.individualLimit.used === undefined ? {} : { used: snapshot.individualLimit.used }),
        ...(snapshot.individualLimit.remainingPercent === undefined
          ? {}
          : { remainingPercent: snapshot.individualLimit.remainingPercent }),
        ...(snapshot.individualLimit.resetsAt === undefined ? {} : { resetsAt: snapshot.individualLimit.resetsAt }),
      },
    }),
    ...(snapshot.spendControlReached === undefined ? {} : { spendControlReached: snapshot.spendControlReached }),
    ...(snapshot.rateLimitReachedType === undefined ? {} : { rateLimitReachedType: snapshot.rateLimitReachedType }),
  };
}

function publicRateLimitWindow(
  window: NonNullable<CodexAccountRateLimitSnapshot["primary"]> | null,
): NonNullable<CodexAccountRateLimitSnapshot["primary"]> | null {
  if (window === null) return null;
  return {
    usedPercent: window.usedPercent,
    ...(window.windowDurationMins === undefined ? {} : { windowDurationMins: window.windowDurationMins }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
}

function publicTokenUsageResponse(response: CodexAccountTokenUsageResponse): CodexAccountTokenUsageResponse {
  const summary = response.summary ?? {};
  const publicSummary: NonNullable<CodexAccountTokenUsageResponse["summary"]> = {};
  for (const key of [
    "lifetimeTokens",
    "peakDailyTokens",
    "longestRunningTurnSec",
    "currentStreakDays",
    "longestStreakDays",
  ] as const) {
    const value = summary[key];
    if (value !== undefined) publicSummary[key] = value;
  }
  const dailyUsageBuckets = response.dailyUsageBuckets;
  return {
    summary: publicSummary,
    ...(dailyUsageBuckets === undefined
      ? {}
      : { dailyUsageBuckets: dailyUsageBuckets === null ? null : dailyUsageBuckets.map(({ startDate, tokens }) => ({ startDate, tokens })) }),
  };
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

function normalizeRetentionMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(2_147_483_647, Math.max(0, Math.floor(value)));
}

function compareFinishedRuns(left: LiveCodexHistoryRun, right: LiveCodexHistoryRun): number {
  return (left.finishedAt ?? 0) - (right.finishedAt ?? 0)
    || left.createdAt - right.createdAt
    || left.runId.localeCompare(right.runId);
}

function isActiveRun(state: CodexHistoryRunState | undefined): state is "running" | "cancelling" {
  return state === "running" || state === "cancelling";
}

function fingerprintCodexHistoryMessage(input: {
  text: string;
  attachmentIds: string[];
  turnIndex: number;
  model?: string;
  reasoningEffort?: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    text: input.text,
    attachmentIds: input.attachmentIds,
    turnIndex: input.turnIndex,
    model: input.model ?? "",
    reasoningEffort: input.reasoningEffort ?? "",
  })).digest("hex");
}

function toStoredCodexHistoryRun(run: LiveCodexHistoryRun): CodexHistoryStoredRun {
  return {
    runId: run.runId,
    homeId: run.homeId,
    threadId: run.threadId,
    requestFingerprint: run.requestFingerprint,
    turnIndex: run.turnIndex,
    attachments: run.attachments.map(publicAttachment),
    ...(run.model ? { model: run.model } : {}),
    ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    state: run.state,
    cursor: run.cursor,
    ...(run.usage ? { usage: run.usage } : {}),
  };
}

function isCodexHistoryStoredRun(value: unknown): value is CodexHistoryStoredRun {
  const run = value as Partial<CodexHistoryStoredRun> | null;
  return !!run && typeof run === "object"
    && typeof run.runId === "string" && run.runId.length > 0
    && typeof run.homeId === "string" && run.homeId.length > 0
    && typeof run.threadId === "string" && run.threadId.length > 0
    && typeof run.requestFingerprint === "string" && /^[0-9a-f]{64}$/i.test(run.requestFingerprint)
    && Number.isSafeInteger(run.turnIndex) && Number(run.turnIndex) >= 0
    && Array.isArray(run.attachments)
    && Number.isFinite(run.createdAt) && Number.isFinite(run.updatedAt)
    && Number.isSafeInteger(run.cursor) && Number(run.cursor) >= 0
    && (run.state === "running" || run.state === "cancelling" || run.state === "completed"
      || run.state === "failed" || run.state === "cancelled" || run.state === "interrupted");
}

function messageResponseForRun(run: LiveCodexHistoryRun): CodexHistoryMessageResponse {
  return {
    runId: run.runId,
    threadId: run.threadId,
    state: run.state,
    cursor: run.cursor,
    turnIndex: run.turnIndex,
    attachments: run.attachments.map(publicAttachment),
  };
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

function isValidAttachmentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

function parseSdkTurnUsage(value: unknown): CodexHistoryTurnUsage | undefined {
  const usage = asRecord(value);
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cached_input_tokens;
  const outputTokens = usage.output_tokens;
  if (![inputTokens, cachedInputTokens, outputTokens].every((count) =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return undefined;
  return {
    inputTokens: inputTokens as number,
    cachedInputTokens: cachedInputTokens as number,
    outputTokens: outputTokens as number,
    ...(typeof usage.reasoning_output_tokens === "number"
      && Number.isSafeInteger(usage.reasoning_output_tokens)
      && usage.reasoning_output_tokens >= 0
      ? { reasoningOutputTokens: usage.reasoning_output_tokens }
      : {}),
  };
}

function tokenUsageRecordForThreadTurn(
  snapshot: CodexThreadTokenUsageSnapshot,
  turns: unknown[],
  fallbackTurnIndex: number,
): CodexHistoryTurnUsageRecord {
  const matchedTurnIndex = turns.findIndex((turn) => asRecord(turn).id === snapshot.turnId);
  const last = snapshot.last;
  return {
    turnIndex: matchedTurnIndex >= 0 ? matchedTurnIndex : fallbackTurnIndex,
    usage: {
      inputTokens: last.inputTokens,
      cachedInputTokens: last.cachedInputTokens,
      outputTokens: last.outputTokens,
      ...(last.reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens: last.reasoningOutputTokens }),
    },
  };
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
