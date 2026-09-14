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

export interface CodexAppServerClientOptions {
  executable: string;
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
}

export interface CodexAppServerQueryClient {
  listThreads(params?: CodexThreadListParams): Promise<CodexThreadListResponse>;
  readThread?(threadId: string, includeTurns?: boolean): Promise<CodexThreadReadResponse>;
  close(): Promise<void>;
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
 * Minimal read-only JSONL client for the local Codex app-server.
 *
 * The bridge deliberately starts a short-lived stdio server for each query.
 * It avoids reading Codex's SQLite/JSONL files directly and does not expose
 * mutating app-server methods such as archive, delete, or turn/start.
 */
export class CodexAppServerClient implements CodexAppServerQueryClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly requestTimeoutMs: number;
  private readonly clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  private readonly pending = new Map<number | string, PendingRequest>();
  private nextRequestId = 1;
  private stderr = "";
  private processError: Error | null = null;
  private initialized = false;
  private closed = false;

  constructor(options: CodexAppServerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.clientInfo = {
      name: options.clientName ?? "feishu_codex_bridge",
      title: options.clientTitle ?? "Feishu Codex Bridge",
      version: options.clientVersion ?? "0.1.0",
    };
    this.child = spawn(options.executable, ["app-server", "--listen", "stdio://"], {
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

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      clientInfo: this.clientInfo,
    });
    this.sendNotification("initialized", {});
    this.initialized = true;
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
            message: "This bridge client only supports read-only app-server queries.",
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

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}
