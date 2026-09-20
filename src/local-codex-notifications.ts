import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  codexThreadSourceLabel,
  codexThreadStatusType,
  codexThreadTimestampMs,
  type CodexAppServerQueryClient,
  type CodexThread,
} from "./codex-app-server.js";
import type { Logger } from "./types.js";

const STATE_VERSION = 2;
const DEFAULT_STATE_FILE = "runtime/codex-local-notifications.json";
const MAX_THREADS = 500;
const MAX_NOTIFICATION_BODY = 600;
const CODEX_SOURCE_KINDS = ["cli", "appServer"] as const;
const TERMINAL_STATUSES = new Set(["idle", "notLoaded", "systemError"]);

export interface LocalCodexNotificationOptions {
  createClient: () => CodexAppServerQueryClient;
  statePath?: string;
  logger?: Logger;
  sendNotification?: LocalNotificationSender;
}

export type LocalNotificationSender = (title: string, body: string) => Promise<void>;

export interface LocalCodexNotification {
  threadKey: string;
  threadId: string;
  source: "cli" | "appServer";
  title: string;
  body: string;
}

interface WatchedThread {
  key: string;
  threadId: string;
  source: "cli" | "appServer";
  status: string;
  updatedAt: string;
  preview: string;
  cwd?: string;
}

interface StoredThreadState {
  source: "cli" | "appServer";
  status: string;
  updatedAt: string;
  notifiedSignature?: string;
}

interface LocalCodexNotificationState {
  version: typeof STATE_VERSION;
  baselineAt: string;
  threads: Record<string, StoredThreadState>;
}

/**
 * Poll Codex app-server's local thread index and notify only when a thread
 * observed as active transitions to idle/notLoaded/systemError. Bridge task
 * tables are intentionally not watched here; those already have Feishu cards.
 */
export class LocalCodexNotificationWatcher {
  private readonly createClient: () => CodexAppServerQueryClient;
  private readonly statePath: string;
  private readonly logger?: Logger;
  private readonly sendNotification: LocalNotificationSender;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollPromise: Promise<LocalCodexNotification[]> | undefined;

  constructor(options: LocalCodexNotificationOptions) {
    this.createClient = options.createClient;
    this.statePath = options.statePath ?? DEFAULT_STATE_FILE;
    this.logger = options.logger;
    this.sendNotification = options.sendNotification ?? sendMacLocalNotification;
  }

  public async start(intervalSeconds: number): Promise<void> {
    if (this.timer) return;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10) {
      throw new Error("local notification intervalSeconds must be an integer >= 10");
    }
    if (this.sendNotification === sendMacLocalNotification && process.platform !== "darwin") {
      throw new Error("system local Codex notifications currently require macOS");
    }

    await this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        this.logger?.warn("local Codex notification poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalSeconds * 1_000);
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.pollPromise;
  }

  /** Poll once; the first poll baselines existing App/CLI threads. */
  public async pollOnce(): Promise<LocalCodexNotification[]> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.pollOnceInternal();
    try {
      return await this.pollPromise;
    } finally {
      this.pollPromise = undefined;
    }
  }

  private async pollOnceInternal(): Promise<LocalCodexNotification[]> {
    const previous = await readState(this.statePath);
    const nextThreads = { ...previous.threads };
    const hadBaseline = Boolean(previous.baselineAt);
    const baselineAt = previous.baselineAt || new Date().toISOString();
    const notifications: LocalCodexNotification[] = [];
    const threads = await this.listThreads();

    for (const thread of threads) {
      const signature = `${thread.status}:${thread.updatedAt}`;
      const prior = previous.threads[thread.key];
      const next: StoredThreadState = {
        source: thread.source,
        status: thread.status,
        updatedAt: thread.updatedAt,
        notifiedSignature: prior?.notifiedSignature,
      };

      const wasActive = prior?.status === "active";
      const isNewCompletedThread = !prior
        && hadBaseline
        && isTerminal(thread.status)
        && thread.updatedAt !== "unknown"
        && thread.updatedAt >= baselineAt;
      if ((wasActive || isNewCompletedThread) && isTerminal(thread.status) && prior?.notifiedSignature !== signature) {
        const notification = formatLocalCodexNotification(thread);
        try {
          await this.sendNotification(notification.title, notification.body);
          next.notifiedSignature = signature;
          notifications.push(notification);
        } catch (error) {
          this.logger?.warn("local Codex system notification failed; will retry", {
            threadId: thread.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      nextThreads[thread.key] = next;
    }

    trimThreadState(nextThreads);
    await writeState(this.statePath, { version: STATE_VERSION, baselineAt, threads: nextThreads });
    return notifications;
  }

  private async listThreads(): Promise<WatchedThread[]> {
    const client = this.createClient();
    const threads: WatchedThread[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < 10; page += 1) {
        const result = await client.listThreads({
          sourceKinds: [...CODEX_SOURCE_KINDS],
          archived: false,
          useStateDbOnly: true,
          limit: 200,
          cursor,
          sortKey: "recency_at",
          sortDirection: "desc",
        });
        for (const thread of result.data) {
          const source = sourceKind(thread);
          if (!source) continue;
          threads.push(toWatchedThread(thread, source));
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return threads;
    } finally {
      await client.close();
    }
  }
}

export function formatLocalCodexNotification(thread: WatchedThread): LocalCodexNotification {
  const status = localStatusLabel(thread.status);
  const sourceLabel = thread.source === "cli" ? "Codex CLI" : "Codex App";
  const detail = truncate(thread.preview || thread.cwd || "Codex thread 已进入终态。", MAX_NOTIFICATION_BODY);
  return {
    threadKey: thread.key,
    threadId: thread.threadId,
    source: thread.source,
    title: `${sourceLabel}任务${status}`,
    body: `${thread.threadId}\n${detail}`,
  };
}

export function buildMacNotificationScript(title: string, body: string): string {
  return `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
}

export function sendMacLocalNotification(title: string, body: string): Promise<void> {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("system local Codex notifications currently require macOS"));
  }
  const script = buildMacNotificationScript(title, body);
  return new Promise<void>((resolve, reject) => {
    execFile("osascript", ["-e", script], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function toWatchedThread(
  thread: CodexThread,
  source: "cli" | "appServer",
): WatchedThread {
  const timestamp = codexThreadTimestampMs(thread);
  return {
    key: `thread:${thread.id}`,
    threadId: thread.id,
    source,
    status: codexThreadStatusType(thread.status),
    updatedAt: timestamp === null ? "unknown" : new Date(timestamp).toISOString(),
    preview: thread.preview || thread.name || "",
    cwd: thread.cwd || thread.path || undefined,
  };
}

function sourceKind(thread: CodexThread): "cli" | "appServer" | undefined {
  const label = codexThreadSourceLabel(thread.source ?? thread.threadSource);
  if (label === "cli" || label.toLowerCase() === "cli") return "cli";
  if (label === "appServer" || label.toLowerCase() === "appserver") return "appServer";
  return undefined;
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function localStatusLabel(status: string): string {
  return status === "systemError" ? "失败" : "已完成";
}

function trimThreadState(threads: Record<string, StoredThreadState>): void {
  const entries = Object.entries(threads);
  if (entries.length <= MAX_THREADS) return;
  entries
    .sort((left, right) => left[1].updatedAt.localeCompare(right[1].updatedAt))
    .slice(0, entries.length - MAX_THREADS)
    .forEach(([key]) => delete threads[key]);
}

function appleScriptString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")}"`;
}

async function readState(path: string): Promise<LocalCodexNotificationState> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<LocalCodexNotificationState>;
    if (raw.version !== STATE_VERSION || !raw.threads || typeof raw.threads !== "object") {
      return emptyState();
    }
    return {
      version: STATE_VERSION,
      baselineAt: typeof raw.baselineAt === "string" ? raw.baselineAt : "",
      threads: raw.threads as Record<string, StoredThreadState>,
    };
  } catch {
    return emptyState();
  }
}

async function writeState(path: string, state: LocalCodexNotificationState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function emptyState(): LocalCodexNotificationState {
  return { version: STATE_VERSION, baselineAt: "", threads: {} };
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
