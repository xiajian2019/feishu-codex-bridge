import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  Logger,
  WorkerHandle,
  WorkerProgress,
  WorkerResult,
  WorkerRunner,
} from "./types.js";

export type WorkerEvent =
  | { type: "thread.started"; threadId: string }
  | { type: "worker.progress"; progress: WorkerProgress }
  | { type: "worker.finished"; result: WorkerResult }
  | { type: "worker.failed"; result: WorkerResult }
  | { type: "worker.canceled"; result: WorkerResult };

export interface ChildWorkerRunnerOptions {
  workerScript: string;
  dbPath: string;
  configPath: string;
  /** Defaults to the current Bun executable. */
  executable?: string;
  /** Arguments inserted before workerScript. */
  executableArgs?: string[];
  logger?: Logger;
  onEvent?: (runId: string, event: WorkerEvent) => void;
}

export class ChildWorkerRunner implements WorkerRunner {
  private readonly options: ChildWorkerRunnerOptions;

  constructor(options: ChildWorkerRunnerOptions) {
    this.options = options;
  }

  start(runId: string): WorkerHandle {
    const args = [
      ...(this.options.executableArgs ?? []),
      this.options.workerScript,
      "--run-id",
      runId,
      "--db",
      this.options.dbPath,
      "--config",
      this.options.configPath,
    ];
    const child = spawn(this.options.executable ?? process.execPath, args, {
      env: workerEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) {
      // spawn() reports ENOENT asynchronously. Attach a listener before throwing
      // so an invalid local executable cannot become an unhandled error event.
      child.once("error", () => undefined);
      throw new Error("Codex worker did not receive a process ID");
    }

    return makeWorkerHandle(child, runId, this.options);
  }
}

function makeWorkerHandle(
  child: ChildProcess,
  runId: string,
  options: ChildWorkerRunnerOptions,
): WorkerHandle {
  let finished = false;
  let requestedTermination = false;
  let lastStderr = "";
  let pendingResult: WorkerResult | null = null;
  let resolveResult!: (result: WorkerResult) => void;
  const result = new Promise<WorkerResult>((resolve) => {
    resolveResult = resolve;
  });

  const report = (event: WorkerEvent): void => {
    try {
      options.onEvent?.(runId, event);
    } catch (error) {
      options.logger?.error("worker event handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseWorkerEvent(line);
      if (!event) return;
      if (event.type === "thread.started" || event.type === "worker.progress") {
        report(event);
      } else if (
        event.type === "worker.finished" ||
        event.type === "worker.failed" ||
        event.type === "worker.canceled"
      ) {
        pendingResult = event.result;
        report(event);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      lastStderr = `${lastStderr}${chunk.toString("utf8")}`.slice(-4096);
    });
  }

  child.once("error", (error) => {
    if (finished) return;
    pendingResult = {
      status: "failed",
      error: `无法启动 Codex worker：${error.message}`,
      errorKind: "crash",
    };
  });
  child.once("close", (code, signal) => {
    if (finished) return;
    finished = true;
    const finalResult = pendingResult ?? {
      status: requestedTermination ? "canceled" : "failed",
      error: requestedTermination
        ? "Codex worker 已被终止。"
        : `Codex worker 异常退出（code=${code ?? "null"}, signal=${signal ?? "none"})${
            lastStderr.trim() ? `: ${redactSensitive(lastStderr.trim())}` : ""
          }`,
      errorKind: requestedTermination ? "canceled" : "crash",
    } satisfies WorkerResult;
    resolveResult(finalResult);
  });

  return {
    pid: child.pid as number,
    result,
    terminate: async () => {
      if (finished) return;
      requestedTermination = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close event will finalize the handle if the process is already gone.
      }
      await waitForClose(child, 5000);
      if (!finished) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may have exited between the two signals.
        }
        await waitForClose(child, 1000);
      }
    },
  };
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && (!key.startsWith("LARK_") && !key.startsWith("FEISHU_") || key === "FEISHU_CODEX_BRIDGE_SINGLE_BINARY" || key === "FEISHU_CODEX_BRIDGE_APP_ROOT" || key === "FEISHU_CODEX_BRIDGE_PORTABLE_ROOT" || key === "FEISHU_CODEX_BRIDGE_INSTALL_ROOT")) {
      env[key] = value;
    }
  }
  return env;
}

function parseWorkerEvent(line: string): WorkerEvent | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
      return { type: "thread.started", threadId: parsed.thread_id };
    }
    if (parsed.type === "worker.progress" && isRecord(parsed.progress)) {
      const progress = parsed.progress;
      if (
        typeof progress.eventType === "string" &&
        typeof progress.message === "string" &&
        typeof progress.at === "string"
      ) {
        return {
          type: "worker.progress",
          progress: {
            eventType: progress.eventType,
            message: progress.message,
            itemType: typeof progress.itemType === "string" ? progress.itemType : undefined,
            itemId: typeof progress.itemId === "string" ? progress.itemId : undefined,
            usage: progress.usage,
            at: progress.at,
          },
        };
      }
    }
    if (
      (parsed.type === "worker.finished" ||
        parsed.type === "worker.failed" ||
        parsed.type === "worker.canceled") &&
      isRecord(parsed.result) &&
      (parsed.result.status === "succeeded" ||
        parsed.result.status === "failed" ||
        parsed.result.status === "canceled")
    ) {
      return {
        type: parsed.type,
        result: parsed.result as unknown as WorkerResult,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSensitive(value: string): string {
  return value
    .replace(/(access[_-]?token|app[_-]?secret|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}
