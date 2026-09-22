import { Codex } from "@openai/codex-sdk";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { loadConfig } from "./config.js";
import { isSingleBinaryRuntime } from "./portable-runtime.js";
import { StateDatabase } from "./db.js";
import { prependPath, resolveLarkConfigDir } from "./runtime-env.js";
import type { BridgeConfig, WorkerProgress, WorkerResult } from "./types.js";

interface WorkerArguments {
  runId: string;
  dbPath: string;
  configPath: string;
}

export function buildCodexEnvironment(
  config: BridgeConfig,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (
      typeof value === "string" &&
      !key.startsWith("LARK_") &&
      !key.startsWith("FEISHU_")
    ) {
      env[key] = value;
    }
  }
  // These variables are intentionally scoped to Codex's child process by the SDK.
  if (config.codex.env.HTTP_PROXY) env.HTTP_PROXY = config.codex.env.HTTP_PROXY;
  if (config.codex.env.HTTPS_PROXY) env.HTTPS_PROXY = config.codex.env.HTTPS_PROXY;
  // Keep local lark-cli calls made by a Codex turn on the same explicit
  // profile store as the bridge. The profile name itself is passed separately
  // by callers and is never replaced with a fallback profile.
  env.LARKSUITE_CLI_CONFIG_DIR = resolveLarkConfigDir(config, inherited);
  if (config.lark.cliPath) {
    env.LARK_CLI_PATH = config.lark.cliPath;
    env.PATH = prependPath(dirname(config.lark.cliPath), env.PATH);
  }
  return env;
}

export async function runWorker(args: WorkerArguments): Promise<WorkerResult> {
  const db = new StateDatabase(args.dbPath);
  let cancelRequested = false;
  const abortController = new AbortController();
  const onSigterm = (): void => {
    cancelRequested = true;
    abortController.abort();
  };
  process.once("SIGTERM", onSigterm);

  try {
    const config = loadConfig(args.configPath);
    let run = db.getRun(args.runId);
    if (!run) {
      throw new Error(`找不到运行记录 ${args.runId}`);
    }
    if (run.state === "QUEUED") {
      // Give the parent a chance to atomically record RUNNING after spawn().
      // If the run was canceled during that window, stop before touching the repo.
      for (let attempt = 0; attempt < 20 && run.state === "QUEUED"; attempt += 1) {
        await sleep(25);
        const refreshed = db.getRun(args.runId);
        if (!refreshed) {
          throw new Error(`找不到运行记录 ${args.runId}`);
        }
        run = refreshed;
      }
    }
    if (run.state !== "RUNNING") {
      // The parent may have canceled the run in the short window between
      // spawning this process and recording its PID.
      const result: WorkerResult = {
        status: "canceled",
        error: "本轮运行在 worker 启动前已被取消。",
        errorKind: "canceled",
      };
      emit({ type: "worker.canceled", result });
      return result;
    }
    const task = db.getTask(run.task_guid);
    if (!task) {
      throw new Error(`找不到任务记录 ${run.task_guid}`);
    }
    const mode = config.modes[task.mode];
    if (!mode) {
      throw new Error(`运行记录中的模式 ${task.mode} 不在配置中`);
    }
    const project = config.projects[task.project_key];
    if (!project || project.repo !== task.repo) {
      throw new Error("运行记录中的仓库路径与项目白名单不一致");
    }

    const codex = new Codex({
      // Do not let the SDK discover and launch its bundled @openai/codex
      // binary. The configured path must point to the system Codex CLI.
      codexPathOverride: config.codex.cliPath,
      env: buildCodexEnvironment(config),
    });
    const threadOptions = {
      workingDirectory: task.repo,
      sandboxMode: mode.sandboxMode,
      approvalPolicy: "never" as const,
    };
    const thread = run.thread_id
      ? codex.resumeThread(run.thread_id, threadOptions)
      : codex.startThread(threadOptions);

    let finalResponse = "";
    let usage: unknown;
    const { events } = await thread.runStreamed(run.prompt_text, {
      signal: abortController.signal,
    });

    for await (const rawEvent of events) {
      const event = asRecord(rawEvent);
      const progress = progressForEvent(event);
      if (progress) {
        emit({ type: "worker.progress", progress });
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        // Persist in the worker as well as reporting to the parent. This closes
        // the crash window between the first streamed event and parent handling.
        db.saveThreadId(args.runId, event.thread_id);
        emit({ type: "thread.started", thread_id: event.thread_id });
      } else if (event.type === "item.completed") {
        const item = asRecord(event.item);
        if (item.type === "agent_message" && typeof item.text === "string") {
          finalResponse = item.text;
        }
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        const error = asRecord(event.error);
        throw new Error(
          typeof error.message === "string" ? error.message : "Codex turn failed",
        );
      } else if (event.type === "error") {
        throw new Error(
          typeof event.message === "string" ? event.message : "Codex event stream failed",
        );
      }
    }

    if (thread.id) {
      db.saveThreadId(args.runId, thread.id);
    }
    if (cancelRequested) {
      const result: WorkerResult = {
        status: "canceled",
        threadId: thread.id ?? undefined,
        errorKind: "canceled",
      };
      emit({ type: "worker.canceled", result });
      return result;
    }
    const result: WorkerResult = {
      status: "succeeded",
      threadId: thread.id ?? undefined,
      finalResponse,
      usage,
    };
    emit({ type: "worker.finished", result });
    return result;
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    const result: WorkerResult = cancelRequested
      ? { status: "canceled", error: message, errorKind: "canceled" }
      : {
          status: "failed",
          error: message,
          errorKind: isProxyError(message) ? "proxy" : "unknown",
        };
    emit({
      type: cancelRequested ? "worker.canceled" : "worker.failed",
      result,
    });
    return result;
  } finally {
    process.off("SIGTERM", onSigterm);
    db.close();
  }
}

function parseArguments(argv: string[]): WorkerArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`缺少参数 ${key} 的值`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }
  const runId = values.get("run-id");
  const dbPath = values.get("db");
  const configPath = values.get("config");
  if (!runId || !dbPath || !configPath) {
    throw new Error("worker 需要 --run-id、--db 和 --config");
  }
  return { runId, dbPath, configPath };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function sanitizeError(value: string): string {
  return value
    .replace(/(access[_-]?token|app[_-]?secret|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function isProxyError(value: string): boolean {
  return /127\.0\.0\.1:7897|proxy|ECONNREFUSED|connect\s+enotfound/i.test(value);
}

function progressForEvent(event: Record<string, any>): WorkerProgress | null {
  if (typeof event.type !== "string") return null;
  const at = new Date().toISOString();
  if (event.type === "thread.started") {
    return { eventType: event.type, message: "Codex thread 已创建。", at };
  }
  if (event.type === "turn.started") {
    return { eventType: event.type, message: "Codex turn 已开始。", at };
  }
  if (event.type === "turn.completed") {
    return {
      eventType: event.type,
      message: "Codex turn 已完成，正在整理结果。",
      usage: event.usage,
      at,
    };
  }
  if (event.type === "turn.failed") {
    const error = asRecord(event.error);
    return {
      eventType: event.type,
      message: trimProgress(
        `Codex turn 失败：${typeof error.message === "string" ? error.message : "未知错误"}`,
      ),
      at,
    };
  }
  if (event.type === "error") {
    return {
      eventType: event.type,
      message: trimProgress(
        `Codex 事件流失败：${typeof event.message === "string" ? event.message : "未知错误"}`,
      ),
      at,
    };
  }
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    return null;
  }
  const item = asRecord(event.item);
  const itemType = typeof item.type === "string" ? item.type : undefined;
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const suffix = event.type === "item.started"
    ? "已开始"
    : event.type === "item.updated"
      ? "进行中"
      : "已完成";
  let message = `Codex ${itemType ?? "工作项"} ${suffix}。`;
  if (itemType === "agent_message" && typeof item.text === "string") {
    message = `Codex 回复${suffix}：${item.text}`;
  } else if (itemType === "command_execution" && typeof item.command === "string") {
    const status = typeof item.status === "string" ? `（${item.status}）` : "";
    message = `命令${suffix}${status}：${item.command}`;
  } else if (itemType === "file_change") {
    const changes = Array.isArray(item.changes)
      ? item.changes
        .map((change: unknown) => asRecord(change).path)
        .filter((path: unknown): path is string => typeof path === "string")
      : [];
    message = changes.length > 0
      ? `文件变更${suffix}：${changes.join(", ")}`
      : `文件变更${suffix}。`;
  } else if (itemType === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "MCP";
    const tool = typeof item.tool === "string" ? item.tool : "工具调用";
    message = `${server} / ${tool}${suffix}。`;
  } else if (itemType === "web_search" && typeof item.query === "string") {
    message = `Web 搜索${suffix}：${item.query}`;
  } else if (itemType === "error" && typeof item.message === "string") {
    message = `Codex 工作项错误：${item.message}`;
  } else if (itemType === "reasoning") {
    message = `Codex 分析${suffix}。`;
  }
  return {
    eventType: event.type,
    message: trimProgress(message),
    itemType,
    itemId,
    at,
  };
}

function trimProgress(value: string, maxCharacters = 2000): string {
  const sanitized = sanitizeError(value).replace(/\s+/g, " ").trim();
  return sanitized.length <= maxCharacters
    ? sanitized
    : `${sanitized.slice(0, maxCharacters - 1)}…`;
}

export async function runWorkerCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    const result = await runWorker(parseArguments(argv));
    process.exitCode = result.status === "failed" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${sanitizeError(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}

if (!isSingleBinaryRuntime() && import.meta.url === `file://${process.argv[1]}`) {
  void runWorkerCli();
}
