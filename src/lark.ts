import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { buildLarkEnvironment, resolveLarkCliPath } from "./runtime-env.js";
import type { BridgeConfig, LarkTask, LarkTaskSummary, Logger } from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class CliCommandError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly errorType: string | null;
  readonly errorSubtype: string | null;

  constructor(
    message: string,
    details: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      timedOut?: boolean;
      retryable?: boolean;
      status?: number | null;
      errorType?: string | null;
      errorSubtype?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "CliCommandError";
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = details.stderr ?? "";
    this.timedOut = details.timedOut ?? false;
    this.retryable = details.retryable ?? false;
    this.status = details.status ?? null;
    this.errorType = details.errorType ?? null;
    this.errorSubtype = details.errorSubtype ?? null;
  }
}

export type CommandExecutor = (
  file: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export interface LarkClient {
  listIncompleteTasks(): Promise<LarkTaskSummary[]>;
  getTask(taskGuid: string): Promise<LarkTask>;
  addComment(taskGuid: string, content: string): Promise<void>;
  updateDescription(taskGuid: string, description: string): Promise<void>;
  reopenTask(taskGuid: string): Promise<void>;
}

export class LarkCliClient implements LarkClient {
  private readonly executable: string;
  private readonly config: BridgeConfig;
  private readonly timeoutMs: number;
  private readonly execute: CommandExecutor;
  private readonly logger?: Logger;

  constructor(
    config: BridgeConfig,
    options: {
      executable?: string;
      timeoutMs?: number;
      execute?: CommandExecutor;
      logger?: Logger;
      maxAttempts?: number;
      retryDelayMs?: number;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.config = config;
    this.executable = options.executable ?? resolveLarkCliPath(config);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.execute = options.execute ?? runCommand;
    this.logger = options.logger;
    this.maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds).then(() => undefined));
  }

  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  async listIncompleteTasks(): Promise<LarkTaskSummary[]> {
    const items: LarkTaskSummary[] = [];
    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();

    let completedPagination = false;
    for (let page = 0; page < 1000; page += 1) {
      const params: Record<string, unknown> = {
        tasklist_guid: this.config.lark.tasklistGuid,
        completed: false,
        page_size: 100,
      };
      if (pageToken) {
        params.page_token = pageToken;
      }

      // The current CLI exposes path and query parameters through --params.
      const result = await this.call([
        "task",
        "tasklists",
        "tasks",
        "--as",
        "user",
        "--params",
        JSON.stringify(params),
        "--format",
        "json",
      ]);
      const pageData = extractListResponse(result);
      items.push(...pageData.items);
      if (!pageData.hasMore) {
        completedPagination = true;
        break;
      }
      if (!pageData.pageToken) {
        throw new CliCommandError("lark-cli indicated more tasks but returned no page token");
      }
      if (seenPageTokens.has(pageData.pageToken)) {
        throw new CliCommandError("lark-cli returned a repeated page token");
      }
      seenPageTokens.add(pageData.pageToken);
      pageToken = pageData.pageToken;
    }
    if (!completedPagination) {
      throw new CliCommandError("lark-cli task list exceeded the pagination safety limit");
    }

    const unique = new Map<string, LarkTaskSummary>();
    for (const item of items) {
      if (item.guid) {
        unique.set(item.guid, item);
      }
    }
    return [...unique.values()];
  }

  async getTask(taskGuid: string): Promise<LarkTask> {
    const result = await this.call([
      "task",
      "tasks",
      "get",
      "--as",
      "user",
      "--params",
      JSON.stringify({ task_guid: taskGuid }),
      "--format",
      "json",
    ]);
    const payload = unwrapPayload(result);
    const task = isRecord(payload.task)
      ? payload.task
      : isRecord(payload.data) && isRecord(payload.data.task)
        ? payload.data.task
        : payload;
    if (!isRecord(task) || typeof task.guid !== "string") {
      throw new CliCommandError("lark-cli task get returned no valid task");
    }
    return task as unknown as LarkTask;
  }

  async addComment(taskGuid: string, content: string): Promise<void> {
    await this.call([
      "task",
      "+comment",
      "--as",
      "user",
      "--task-id",
      taskGuid,
      "--content",
      sanitizeCommentContent(content),
      "--format",
      "json",
    ]);
  }

  async updateDescription(taskGuid: string, description: string): Promise<void> {
    await this.call([
      "task",
      "+update",
      "--as",
      "user",
      "--task-id",
      taskGuid,
      "--description",
      description,
      "--format",
      "json",
    ]);
  }

  async reopenTask(taskGuid: string): Promise<void> {
    await this.call([
      "task",
      "+reopen",
      "--as",
      "user",
      "--task-id",
      taskGuid,
      "--format",
      "json",
    ]);
  }

  private async call(taskArgs: string[]): Promise<Record<string, unknown>> {
    const args = ["--profile", this.config.lark.profile, ...taskArgs];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.callOnce(args);
      } catch (error) {
        if (
          !(error instanceof CliCommandError)
          || !error.retryable
          || attempt >= this.maxAttempts
        ) {
          throw error;
        }
        this.logger?.warn("lark-cli transient failure; retrying", {
          profile: this.config.lark.profile,
          attempt,
          nextAttempt: attempt + 1,
          error: error.message,
        });
        await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw new CliCommandError("lark-cli request exhausted retry attempts");
  }

  private async callOnce(args: string[]): Promise<Record<string, unknown>> {
    const result = await this.execute(this.executable, args, {
      env: buildLarkEnvironment(this.config),
      timeoutMs: this.timeoutMs,
    });
    let parsed: Record<string, unknown> | null = null;
    if (result.stdout.trim()) {
      try {
        parsed = parseJsonOutput(result.stdout);
      } catch {
        // A non-JSON stderr response is handled by the exit-code branch below.
      }
    }
    if (parsed) {
      const notice = isRecord(parsed._notice) && isRecord(parsed._notice.update)
        ? parsed._notice.update
        : null;
      if (notice && this.logger) {
        const message = typeof notice.message === "string" ? notice.message : "lark-cli update available";
        this.logger.warn(redactSensitive(message));
      }
      if (parsed.ok === false) {
        const error = isRecord(parsed.error) ? parsed.error : {};
        const message = typeof error.message === "string" ? error.message : "Lark API request failed";
        const status = firstNumber(error.status, error.http_status, parsed.status);
        const errorType = firstString(error.type, parsed.type);
        const errorSubtype = firstString(error.subtype, parsed.subtype);
        const context = [errorType, errorSubtype].filter(Boolean).join("/");
        throw new CliCommandError(
          redactSensitive(context ? `${message} (${context})` : message),
          {
            retryable: isTransientFailure(
              [message, errorType, errorSubtype].filter(Boolean).join(" "),
              status,
            ),
            status,
            errorType,
            errorSubtype,
          },
        );
      }
    }
    if (result.exitCode !== 0) {
      const detail = redactSensitive(result.stderr.trim());
      throw new CliCommandError(
        `lark-cli exited with code ${result.exitCode ?? "unknown"}${
          detail ? `: ${detail}` : ""
        }`,
        {
          exitCode: result.exitCode,
          signal: result.signal,
          stderr: detail,
          retryable: isTransientFailure(detail, result.exitCode),
        },
      );
    }
    const parsedOutput = parsed ?? parseJsonOutput(result.stdout);
    return parsedOutput;
  }
}

export const runCommand: CommandExecutor = (
  file,
  args,
  options = {},
) => new Promise<CommandResult>((resolve, reject) => {
  const child = spawn(file, args, {
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
    forceKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }, 1000);
  }, timeoutMs);

  const append = (current: string, chunk: Buffer): string => {
    if (current.length >= MAX_CAPTURED_OUTPUT) {
      return current;
    }
    return `${current}${chunk.toString("utf8")}`.slice(0, MAX_CAPTURED_OUTPUT);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    reject(new CliCommandError(`Cannot start ${file}: ${error.message}`, {
      retryable: isTransientFailure(error.message, null),
    }));
  });
  child.once("close", (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (timedOut) {
      reject(
        new CliCommandError(`${file} timed out after ${timeoutMs}ms`, {
          exitCode,
          signal,
          stderr: redactSensitive(stderr),
          timedOut: true,
          retryable: true,
        }),
      );
      return;
    }
    resolve({ stdout, stderr, exitCode, signal });
  });
});

export function parseJsonOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new CliCommandError("lark-cli returned empty JSON output");
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!isRecord(value)) {
      throw new Error("JSON root is not an object");
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliCommandError(`Cannot parse lark-cli JSON output: ${message}`);
  }
}

/**
 * lark-cli accepts web/app links in Markdown, but rejects local filesystem
 * links such as `[file](/Users/name/repo/file.rb:12)`. Keep the useful label
 * while removing only links that the task comment API cannot validate.
 */
export function sanitizeCommentContent(content: string): string {
  return content.replace(
    /\[([^\]\n]+)\]\(([^)\n]*)\)/g,
    (full, label: string, target: string) => {
      const normalizedTarget = target.trim().toLowerCase();
      if (
        normalizedTarget.startsWith("http://")
        || normalizedTarget.startsWith("https://")
        || normalizedTarget.startsWith("applink://")
      ) {
        return full;
      }
      return label;
    },
  );
}

function extractListResponse(value: Record<string, unknown>): {
  items: LarkTaskSummary[];
  hasMore: boolean;
  pageToken?: string;
} {
  const payload = unwrapPayload(value);
  const items = Array.isArray(payload.items)
    ? payload.items.filter(isRecord).filter((item) => typeof item.guid === "string") as unknown as LarkTaskSummary[]
    : [];
  const rawPageToken = payload.page_token ?? payload.pageToken;
  return {
    items,
    hasMore: payload.has_more === true || payload.hasMore === true,
    pageToken: typeof rawPageToken === "string" && rawPageToken.length > 0
      ? rawPageToken
      : undefined,
  };
}

function unwrapPayload(value: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(value.data)) {
    return value.data;
  }
  if (isRecord(value.result)) {
    return value.result;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSensitive(value: string): string {
  return value
    .replace(/(access[_-]?token|app[_-]?secret|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

function firstNumber(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? null;
}

function isTransientFailure(message: string, status: number | null): boolean {
  if (status === 408 || status === 429 || (status !== null && status >= 500)) {
    return true;
  }
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNABORTED|EHOSTUNREACH|EHOSTDOWN|EPIPE|socket hang up|network|timed out|timeout/i.test(message);
}
