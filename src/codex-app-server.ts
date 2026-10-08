import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { buildCodexEnvironment } from "./codex-worker.js";
import type { BridgeConfig } from "./types.js";

export const CODEX_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export type CodexThreadSourceKind = (typeof CODEX_THREAD_SOURCE_KINDS)[number];

export const CODEX_THREAD_STATUS_TYPES = [
  "notLoaded",
  "idle",
  "active",
  "systemError",
] as const;

export type CodexThreadStatusType = (typeof CODEX_THREAD_STATUS_TYPES)[number];

export type CodexThreadSortKey = "created_at" | "updated_at" | "recency_at";
export type CodexThreadSortDirection = "asc" | "desc";

export interface CodexThreadStatus {
  type: CodexThreadStatusType | string;
  activeFlags?: string[];
  [key: string]: unknown;
}

/** A version-tolerant view of the app-server Thread object. */
export interface CodexThread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  preview?: string;
  ephemeral?: boolean;
  projectId?: string | null;
  modelProvider?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  status?: CodexThreadStatus;
  path?: string | null;
  cwd?: string;
  cliVersion?: string;
  source?: unknown;
  threadSource?: unknown;
  gitInfo?: unknown;
  name?: string | null;
  turns?: unknown[];
  [key: string]: unknown;
}

export interface CodexThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: CodexThreadSortKey | null;
  sortDirection?: CodexThreadSortDirection | null;
  modelProviders?: string[] | null;
  sourceKinds?: CodexThreadSourceKind[] | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
}

export interface CodexThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface CodexThreadReadResponse {
  thread: CodexThread;
}

export interface CodexModelReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModelCatalogEntry {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexModelReasoningEffortOption[];
}

export interface CodexModelListResponse {
  data: CodexModelCatalogEntry[];
  nextCursor: string | null;
}

export interface CodexThreadTokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningOutputTokens?: number;
}

export interface CodexThreadTokenUsageSnapshot {
  threadId: string;
  turnId: string;
  last: CodexThreadTokenUsageBreakdown;
  total: CodexThreadTokenUsageBreakdown;
}

export interface CodexAccountRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexAccountRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  normalModelSlug?: string | null;
  primary?: CodexAccountRateLimitWindow | null;
  secondary?: CodexAccountRateLimitWindow | null;
  credits?: {
    balance?: string | null;
    hasCredits?: boolean;
    unlimited?: boolean;
  } | null;
  individualLimit?: {
    limit?: string;
    used?: string;
    remainingPercent?: number;
    resetsAt?: number;
  } | null;
  spendControlReached?: boolean | null;
  rateLimitReachedType?: number | string | null;
  planType?: string | null;
}

export interface CodexAccountRateLimitsResponse {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: CodexAccountRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexAccountRateLimitSnapshot> | null;
  rateLimitResetCredits?: {
    availableCount?: number;
    credits?: CodexAccountResetCredit[] | null;
  } | null;
}

export interface CodexAccountResetCredit {
  id: string;
  resetType?: string;
  status: string;
  grantedAt: number;
  expiresAt?: number | null;
  title?: string | null;
  description?: string | null;
}

export type CodexResetCreditConsumeOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed"
  | "unknown";

export interface CodexResetCreditConsumeResponse {
  outcome: CodexResetCreditConsumeOutcome;
}

export interface CodexAccountTokenUsageResponse {
  summary?: {
    lifetimeTokens?: number | null;
    peakDailyTokens?: number | null;
    longestRunningTurnSec?: number | null;
    currentStreakDays?: number | null;
    longestStreakDays?: number | null;
  };
  dailyUsageBuckets?: Array<{ startDate: string; tokens: number }> | null;
}

export interface CodexAppServerClientOptions {
  executable: string;
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  /** Mutating reset-credit RPCs stay disabled unless a confirmed UI action opts in. */
  allowRateLimitResetCreditConsumption?: boolean;
}

export interface CodexAppServerQueryClient {
  listThreads(params?: CodexThreadListParams): Promise<CodexThreadListResponse>;
  readThread?(threadId: string, includeTurns?: boolean): Promise<CodexThreadReadResponse>;
  listModels?(): Promise<CodexModelListResponse>;
  readThreadTokenUsage?(threadId: string): Promise<CodexThreadTokenUsageSnapshot | null>;
  readAccountRateLimits?(): Promise<CodexAccountRateLimitsResponse>;
  readAccountTokenUsage?(): Promise<CodexAccountTokenUsageResponse>;
  close(): Promise<void>;
}

/**
 * Read-only app-server clients must not inherit the user's completion hook.
 * Thread hydration/cleanup can otherwise replay completion notifications while
 * a command such as `/threads` is only listing existing sessions.
 */
export function buildCodexAppServerArgs(): string[] {
  return ["app-server", "-c", "notify=[]", "--listen", "stdio://"];
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  [key: string]: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerRpcError extends Error {
  public readonly code: number | undefined;
  public readonly data: unknown;

  constructor(
    method: string,
    message: string,
    code?: number,
    data?: unknown,
  ) {
    super(`Codex app-server ${method} failed${code === undefined ? "" : ` (${code})`}: ${message}`);
    this.name = "CodexAppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Minimal JSONL client for the local Codex app-server.
 *
 * The bridge deliberately starts a short-lived stdio server for each query.
 * It avoids reading Codex's SQLite/JSONL files directly. Mutating reset-credit
 * consumption is disabled unless an explicit user-confirmed action opts in.
 */
export class CodexAppServerClient implements CodexAppServerQueryClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly requestTimeoutMs: number;
  private readonly allowRateLimitResetCreditConsumption: boolean;
  private readonly clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly threadTokenUsageWaiters = new Map<string, Set<(usage: CodexThreadTokenUsageSnapshot) => void>>();
  private nextRequestId = 1;
  private stderr = "";
  private processError: Error | null = null;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private closed = false;

  constructor(options: CodexAppServerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.allowRateLimitResetCreditConsumption = options.allowRateLimitResetCreditConsumption ?? false;
    this.clientInfo = {
      name: options.clientName ?? "feishu_codex_bridge",
      title: options.clientTitle ?? "Feishu Codex Bridge",
      version: options.clientVersion ?? "0.1.0",
    };
    this.child = spawn(options.executable, buildCodexAppServerArgs(), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => {
      this.processError = error;
      this.rejectPending(error);
    });
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
      this.processError = new Error(
        `Codex app-server exited with ${reason}${detail ? `: ${detail}` : ""}`,
      );
      this.rejectPending(this.processError);
    });
  }

  public initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initialization) {
      const initialization = this.request("initialize", {
        clientInfo: this.clientInfo,
      }).then(() => {
        this.sendNotification("initialized", {});
        this.initialized = true;
      });
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = null;
      });
    }
    return this.initialization;
  }

  public async listThreads(
    params: CodexThreadListParams = {},
  ): Promise<CodexThreadListResponse> {
    await this.initialize();
    const raw = await this.request("thread/list", params);
    return parseThreadListResponse(raw);
  }

  public async readThread(
    threadId: string,
    includeTurns = false,
  ): Promise<CodexThreadReadResponse> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("threadId is required");
    await this.initialize();
    const raw = await this.request("thread/read", {
      threadId: normalizedThreadId,
      includeTurns,
    });
    const result = asRecord(raw);
    const thread = asRecord(result.thread);
    if (typeof thread.id !== "string") {
      throw new Error("Codex app-server returned an invalid thread/read response");
    }
    return { thread: thread as CodexThread };
  }

  public async listModels(): Promise<CodexModelListResponse> {
    await this.initialize();
    return parseModelListResponse(await this.request("model/list", { limit: 100, includeHidden: false }));
  }

  public async readThreadTokenUsage(threadId: string): Promise<CodexThreadTokenUsageSnapshot | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("threadId is required");
    await this.initialize();

    let resolveUsage: ((usage: CodexThreadTokenUsageSnapshot) => void) | undefined;
    const usageNotification = new Promise<CodexThreadTokenUsageSnapshot>((resolvePromise) => {
      resolveUsage = resolvePromise;
    });
    const waiters = this.threadTokenUsageWaiters.get(normalizedThreadId)
      ?? new Set<(usage: CodexThreadTokenUsageSnapshot) => void>();
    const waiter = (usage: CodexThreadTokenUsageSnapshot): void => resolveUsage?.(usage);
    waiters.add(waiter);
    this.threadTokenUsageWaiters.set(normalizedThreadId, waiters);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.request("thread/resume", { threadId: normalizedThreadId, excludeTurns: true });
      const timeoutPromise = new Promise<null>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise(null), 1_000);
      });
      return await Promise.race([usageNotification, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
      const currentWaiters = this.threadTokenUsageWaiters.get(normalizedThreadId);
      currentWaiters?.delete(waiter);
      if (currentWaiters?.size === 0) this.threadTokenUsageWaiters.delete(normalizedThreadId);
    }
  }

  public async readAccountRateLimits(): Promise<CodexAccountRateLimitsResponse> {
    await this.initialize();
    return parseAccountRateLimitsResponse(await this.request("account/rateLimits/read"));
  }

  public async readAccountTokenUsage(): Promise<CodexAccountTokenUsageResponse> {
    await this.initialize();
    return parseAccountTokenUsageResponse(await this.request("account/usage/read"));
  }

  public async consumeAccountRateLimitResetCredit(input: {
    idempotencyKey: string;
    creditId: string;
  }): Promise<CodexResetCreditConsumeResponse> {
    if (!this.allowRateLimitResetCreditConsumption) {
      throw new Error("Reset-credit consumption requires explicit action-client authorization.");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    const creditId = input.creditId.trim();
    if (!idempotencyKey || !creditId) throw new Error("idempotencyKey and creditId are required");
    await this.initialize();
    return parseResetCreditConsumeResponse(await this.request("account/rateLimitResetCredit/consume", {
      idempotencyKey,
      creditId,
    }));
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.rejectPending(new Error("Codex app-server client closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      this.child.once("close", finish);
      try {
        this.child.stdin.end();
      } catch {
        finish();
        return;
      }
      forceTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill("SIGTERM");
        }
        setTimeout(finish, 250);
      }, 500);
    });
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed"));
    if (this.processError) return Promise.reject(this.processError);
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message: JsonRpcRequest = { id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: object): void {
    if (this.closed) throw new Error("Codex app-server client is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.processError = new Error(`Codex app-server returned non-JSON output: ${trimmed.slice(0, 500)}`);
      this.rejectPending(this.processError);
      return;
    }
    const message = asRecord(raw) as JsonRpcMessage;
    const id = message.id;
    if (id === undefined || id === null) {
      if (message.method === "thread/tokenUsage/updated") {
        const usage = parseThreadTokenUsageNotification(message.params);
        if (usage) {
          for (const waiter of this.threadTokenUsageWaiters.get(usage.threadId) ?? []) waiter(usage);
        }
      }
      return;
    }
    if (typeof id === "number" || typeof id === "string") {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new CodexAppServerRpcError(
            pending.method,
            typeof message.error.message === "string" ? message.error.message : "unknown error",
            typeof message.error.code === "number" ? message.error.code : undefined,
            message.error.data,
          ));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      // The server can issue requests while a turn is running. This client is
      // intentionally read-only, so explicitly decline rather than leaving
      // the server waiting forever if a future read path triggers one.
      if (typeof message.method === "string") {
        this.write({
          id,
          error: {
            code: -32601,
            message: "This bridge client does not accept server-initiated requests.",
          },
        });
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export function buildCodexAppServerEnvironment(
  config: BridgeConfig,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return buildCodexEnvironment(config, inherited);
}

export function codexThreadStatusType(threadStatus: unknown): string {
  const status = asRecord(threadStatus);
  return typeof status.type === "string" && status.type.length > 0
    ? status.type
    : "unknown";
}

export function codexThreadSourceLabel(source: unknown): string {
  if (typeof source === "string" && source.length > 0) return source;
  const record = asRecord(source);
  if (typeof record.custom === "string" && record.custom.length > 0) {
    return `custom:${record.custom}`;
  }
  const subAgent = asRecord(record.subAgent);
  if (Object.keys(subAgent).length > 0) {
    const kind = typeof subAgent.kind === "string" ? subAgent.kind : "subAgent";
    return kind;
  }
  return "unknown";
}

export function codexThreadTimestampMs(thread: CodexThread): number | null {
  for (const value of [thread.updatedAt, thread.recencyAt, thread.createdAt]) {
    if (typeof value === "number" && Number.isFinite(value)) return value * 1_000;
  }
  return null;
}

function parseThreadListResponse(raw: unknown): CodexThreadListResponse {
  const result = asRecord(raw);
  if (!Array.isArray(result.data)) {
    throw new Error("Codex app-server returned an invalid thread/list response");
  }
  const data = result.data
    .map(asRecord)
    .filter((thread) => typeof thread.id === "string")
    .map((thread) => thread as CodexThread);
  return {
    data,
    nextCursor: nullableString(result.nextCursor),
    backwardsCursor: nullableString(result.backwardsCursor),
  };
}

function parseModelListResponse(raw: unknown): CodexModelListResponse {
  const result = asRecord(raw);
  if (!Array.isArray(result.data)) {
    throw new Error("Codex app-server returned an invalid model/list response");
  }
  const data = result.data.flatMap((value) => {
    const model = asRecord(value);
    if (typeof model.model !== "string" || model.model.trim().length === 0) return [];
    const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap((effortValue) => {
          const effort = asRecord(effortValue);
          return typeof effort.reasoningEffort === "string" && effort.reasoningEffort.length > 0
            ? [{
                reasoningEffort: effort.reasoningEffort,
                description: typeof effort.description === "string" ? effort.description : "",
              }]
            : [];
        })
      : [];
    return [{
      model: model.model,
      displayName: typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName
        : model.model,
      description: typeof model.description === "string" ? model.description : "",
      hidden: model.hidden === true,
      isDefault: model.isDefault === true,
      ...(typeof model.defaultReasoningEffort === "string"
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
      supportedReasoningEfforts,
    }];
  });
  return { data, nextCursor: nullableString(result.nextCursor) };
}

function parseThreadTokenUsageNotification(raw: unknown): CodexThreadTokenUsageSnapshot | null {
  const params = asRecord(raw);
  const threadId = nullableString(params.threadId);
  const turnId = nullableString(params.turnId);
  const tokenUsage = asRecord(params.tokenUsage);
  const last = parseThreadTokenUsageBreakdown(tokenUsage.last);
  const total = parseThreadTokenUsageBreakdown(tokenUsage.total);
  if (!threadId || !turnId || !last || !total) return null;
  return { threadId, turnId, last, total };
}

function parseThreadTokenUsageBreakdown(raw: unknown): CodexThreadTokenUsageBreakdown | null {
  const record = asRecord(raw);
  const values = {
    inputTokens: optionalNumber(record.inputTokens),
    cachedInputTokens: optionalNumber(record.cachedInputTokens),
    outputTokens: optionalNumber(record.outputTokens),
    totalTokens: optionalNumber(record.totalTokens),
    reasoningOutputTokens: optionalNumber(record.reasoningOutputTokens),
  };
  if ([values.inputTokens, values.cachedInputTokens, values.outputTokens, values.totalTokens].some((value) =>
    value === undefined || !Number.isSafeInteger(value) || value < 0)) return null;
  return {
    inputTokens: values.inputTokens!,
    cachedInputTokens: values.cachedInputTokens!,
    outputTokens: values.outputTokens!,
    totalTokens: values.totalTokens!,
    ...(values.reasoningOutputTokens !== undefined
      && Number.isSafeInteger(values.reasoningOutputTokens)
      && values.reasoningOutputTokens >= 0
      ? { reasoningOutputTokens: values.reasoningOutputTokens }
      : {}),
  };
}

function parseAccountRateLimitsResponse(raw: unknown): CodexAccountRateLimitsResponse {
  const result = asRecord(raw);
  const parsed: CodexAccountRateLimitsResponse = {};
  if (result.ordinaryUsageAllowed === null || typeof result.ordinaryUsageAllowed === "boolean") {
    parsed.ordinaryUsageAllowed = result.ordinaryUsageAllowed;
  }
  if (result.rateLimits !== undefined) {
    parsed.rateLimits = parseAccountRateLimitSnapshot(result.rateLimits);
  }
  if (result.rateLimitsByLimitId === null) {
    parsed.rateLimitsByLimitId = null;
  } else if (typeof result.rateLimitsByLimitId === "object" && result.rateLimitsByLimitId !== null) {
    parsed.rateLimitsByLimitId = Object.fromEntries(
      Object.entries(asRecord(result.rateLimitsByLimitId))
        .map(([limitId, snapshot]) => [limitId, parseAccountRateLimitSnapshot(snapshot)]),
    );
  }
  if (result.rateLimitResetCredits === null) {
    parsed.rateLimitResetCredits = null;
  } else if (result.rateLimitResetCredits !== undefined) {
    const credits = asRecord(result.rateLimitResetCredits);
    const availableCount = optionalNumber(credits.availableCount);
    let details: CodexAccountResetCredit[] | null | undefined;
    if (credits.credits === null) {
      details = null;
    } else if (Array.isArray(credits.credits)) {
      details = credits.credits.flatMap((credit) => {
        const parsedCredit = parseAccountResetCredit(credit);
        return parsedCredit ? [parsedCredit] : [];
      });
    }
    parsed.rateLimitResetCredits = {
      ...(availableCount === undefined ? {} : { availableCount }),
      ...(details === undefined ? {} : { credits: details }),
    };
  }
  return parsed;
}

function parseAccountResetCredit(raw: unknown): CodexAccountResetCredit | null {
  const credit = asRecord(raw);
  const id = nullableString(credit.id);
  const status = nullableString(credit.status);
  const grantedAt = optionalNumber(credit.grantedAt);
  if (!id || !status || grantedAt === undefined) return null;
  const expiresAt = optionalNullableNumber(credit.expiresAt);
  const title = optionalNullableString(credit.title);
  const description = optionalNullableString(credit.description);
  return {
    id,
    status,
    grantedAt,
    ...(typeof credit.resetType === "string" ? { resetType: credit.resetType } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

function parseResetCreditConsumeResponse(raw: unknown): CodexResetCreditConsumeResponse {
  const outcome = asRecord(raw).outcome;
  return {
    outcome: outcome === "reset" || outcome === "nothingToReset" || outcome === "noCredit" || outcome === "alreadyRedeemed"
      ? outcome
      : "unknown",
  };
}

function parseAccountRateLimitSnapshot(raw: unknown): CodexAccountRateLimitSnapshot {
  const source = asRecord(raw);
  const result: CodexAccountRateLimitSnapshot = {};
  const limitId = optionalNullableString(source.limitId);
  const limitName = optionalNullableString(source.limitName);
  const normalModelSlug = optionalNullableString(source.normalModelSlug);
  const planType = optionalNullableString(source.planType);
  if (limitId !== undefined) result.limitId = limitId;
  if (limitName !== undefined) result.limitName = limitName;
  if (normalModelSlug !== undefined) result.normalModelSlug = normalModelSlug;
  if (planType !== undefined) result.planType = planType;
  if (source.primary !== undefined) {
    result.primary = source.primary === null ? null : parseAccountRateLimitWindow(source.primary);
  }
  if (source.secondary !== undefined) {
    result.secondary = source.secondary === null ? null : parseAccountRateLimitWindow(source.secondary);
  }
  if (source.credits === null) {
    result.credits = null;
  } else if (source.credits !== undefined) {
    const credits = asRecord(source.credits);
    const balance = optionalNullableString(credits.balance);
    const hasCredits = optionalBoolean(credits.hasCredits);
    const unlimited = optionalBoolean(credits.unlimited);
    result.credits = {
      ...(balance === undefined ? {} : { balance }),
      ...(hasCredits === undefined ? {} : { hasCredits }),
      ...(unlimited === undefined ? {} : { unlimited }),
    };
  }
  if (source.individualLimit === null) {
    result.individualLimit = null;
  } else if (source.individualLimit !== undefined) {
    const limit = asRecord(source.individualLimit);
    const amount = optionalNullableString(limit.limit);
    const used = optionalNullableString(limit.used);
    const remainingPercent = optionalNumber(limit.remainingPercent);
    const resetsAt = optionalNumber(limit.resetsAt);
    result.individualLimit = {
      ...(amount == null ? {} : { limit: amount }),
      ...(used == null ? {} : { used }),
      ...(remainingPercent === undefined ? {} : { remainingPercent }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  }
  const spendControlReached = optionalNullableBoolean(source.spendControlReached);
  const rateLimitReachedType = optionalNullableNumberOrString(source.rateLimitReachedType);
  if (spendControlReached !== undefined) result.spendControlReached = spendControlReached;
  if (rateLimitReachedType !== undefined) result.rateLimitReachedType = rateLimitReachedType;
  return result;
}

function parseAccountRateLimitWindow(raw: unknown): CodexAccountRateLimitWindow | null {
  const source = asRecord(raw);
  const usedPercent = optionalNumber(source.usedPercent);
  if (usedPercent === undefined) return null;
  const windowDurationMins = optionalNullableNumber(source.windowDurationMins);
  const resetsAt = optionalNullableNumber(source.resetsAt);
  return {
    usedPercent,
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function parseAccountTokenUsageResponse(raw: unknown): CodexAccountTokenUsageResponse {
  const result = asRecord(raw);
  const rawSummary = asRecord(result.summary);
  const summary: NonNullable<CodexAccountTokenUsageResponse["summary"]> = {};
  for (const key of [
    "lifetimeTokens",
    "peakDailyTokens",
    "longestRunningTurnSec",
    "currentStreakDays",
    "longestStreakDays",
  ] as const) {
    const value = optionalNullableNumber(rawSummary[key]);
    if (value !== undefined) summary[key] = value;
  }
  const parsed: CodexAccountTokenUsageResponse = { summary };
  if (result.dailyUsageBuckets === null) {
    parsed.dailyUsageBuckets = null;
  } else if (Array.isArray(result.dailyUsageBuckets)) {
    parsed.dailyUsageBuckets = result.dailyUsageBuckets.flatMap((bucket) => {
      const entry = asRecord(bucket);
      const tokens = optionalNumber(entry.tokens);
      return typeof entry.startDate === "string" && tokens !== undefined
        ? [{ startDate: entry.startDate, tokens }]
        : [];
    });
  }
  return parsed;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function optionalNullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : optionalNumber(value);
}

function optionalNullableNumberOrString(value: unknown): number | string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNullableBoolean(value: unknown): boolean | null | undefined {
  return value === null ? null : optionalBoolean(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}
