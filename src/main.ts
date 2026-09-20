import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AampTaskAgentRuntime } from "./aamp-task-agent.js";
import { AampRelayClient, reconcileRunningAampTasks } from "./aamp-relay.js";
import { isDirectExecutionMode, loadConfig, parseExecutionMode } from "./config.js";
import { buildCodexAppServerEnvironment, CodexAppServerClient } from "./codex-app-server.js";
import { LocalCodexNotificationInbox } from "./codex-notification-inbox.js";
import { StateDatabase } from "./db.js";
import { Dispatcher } from "./dispatcher.js";
import { LarkCliClient } from "./lark.js";
import { LocalCodexNotificationWatcher } from "./local-codex-notifications.js";
import { Poller } from "./poller.js";
import type { ExecutionMode, Logger } from "./types.js";
import { DashboardServer } from "./web.js";
import { ChildWorkerRunner } from "./worker-runner.js";

// The legacy Feishu task-list poller is retained for future rollback work, but
// it must not be started while the AAMP + Relay path is the active workflow.
const LEGACY_POLLING_ENABLED = false;

export interface MainArguments {
  configPath: string;
  dbPath: string;
  once: boolean;
  executionMode?: ExecutionMode;
  help?: boolean;
}

export function parseMainArguments(argv: string[], cwd = process.cwd()): MainArguments {
  const root = resolve(cwd);
  let configPath = join(root, "config.json");
  let dbPath = join(root, "runtime", "bridge.db");
  let once = false;
  let executionMode: ExecutionMode | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // pnpm can forward the conventional separator as a literal argument.
    // Accept it so both `pnpm run start --config ...` and
    // `pnpm run start -- --config ...` remain usable.
    if (arg === "--") {
      continue;
    } else if (arg === "--once") {
      once = true;
    } else if (
      arg === "--mode"
      || arg === "--execution-mode"
      || arg.startsWith("--mode=")
      || arg.startsWith("--execution-mode=")
    ) {
      const inlinePrefix = arg.startsWith("--execution-mode=")
        ? "--execution-mode="
        : arg.startsWith("--mode=")
          ? "--mode="
          : undefined;
      const value = inlinePrefix
        ? arg.slice(inlinePrefix.length)
        : argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${inlinePrefix ? inlinePrefix.slice(0, -1) : arg} requires an execution mode`);
      }
      executionMode = parseExecutionMode(value);
      if (!inlinePrefix) index += 1;
    } else if (
      arg === "--config"
      || arg === "--db"
      || arg.startsWith("--config=")
      || arg.startsWith("--db=")
    ) {
      const inlinePrefix = arg.startsWith("--config=")
        ? "--config="
        : arg.startsWith("--db=")
          ? "--db="
          : undefined;
      const value = inlinePrefix ? arg.slice(inlinePrefix.length) : argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${inlinePrefix ? inlinePrefix.slice(0, -1) : arg} requires a path`);
      }
      if (arg === "--config" || inlinePrefix === "--config=") configPath = resolve(cwd, value);
      if (arg === "--db" || inlinePrefix === "--db=") dbPath = resolve(cwd, value);
      if (!inlinePrefix) index += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { configPath, dbPath, once: false, executionMode, help: true };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { configPath, dbPath, once, executionMode };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseMainArguments(argv, process.cwd());
  if (args.help) {
    printUsage();
    return;
  }
  const logger = createLogger();
  const config = loadConfig(args.configPath, { executionMode: args.executionMode });
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  mkdirSync(join(projectRoot, "runtime", "logs"), { recursive: true });

  if (config.execution.mode === "aamp-relay") {
    await runAampMode(config, projectRoot, args, logger);
    return;
  }
  if (isDirectExecutionMode(config.execution.mode)) {
    await runDirectMode(config, projectRoot, args, logger);
    return;
  }
  if (!LEGACY_POLLING_ENABLED) {
    throw new Error(
      "legacy polling mode is disabled; set execution.mode to aamp-relay or feishu-sqlite-codex",
    );
  }

  logger.info("bridge state database", { path: resolve(args.dbPath) });
  const db = new StateDatabase(args.dbPath);
  const lark = new LarkCliClient(config, { logger });
  const workerScript = join(
    dirname(fileURLToPath(import.meta.url)),
    existsSync(join(dirname(fileURLToPath(import.meta.url)), "codex-worker.js"))
      ? "codex-worker.js"
      : "codex-worker.ts",
  );
  const sourceWorker = workerScript.endsWith(".ts");
  const runner = new ChildWorkerRunner({
    workerScript,
    dbPath: resolve(args.dbPath),
    configPath: resolve(args.configPath),
    executable: sourceWorker ? "tsx" : process.execPath,
    onEvent: (runId, event) => {
      if (event.type === "thread.started") {
        db.saveThreadId(runId, event.threadId);
      } else if (event.type === "worker.progress") {
        db.recordRunProgress(runId, event.progress);
      }
    },
    logger,
  });
  const dispatcher = new Dispatcher({
    db,
    lark,
    config,
    workerRunner: runner,
    logger,
  });
  const poller = new Poller({
    lark,
    db,
    dispatcher,
    intervalSeconds: config.pollIntervalSeconds,
    logger,
  });
  const dashboard = config.web.enabled
    ? new DashboardServer({
        db,
        host: config.web.host,
        port: config.web.port,
        projects: Object.keys(config.projects),
        modes: Object.keys(config.modes),
        actions: {
          interruptTask: async (taskGuid, reason) => ({
            ok: await dispatcher.interruptTask(taskGuid, reason),
          }),
          appendFeedback: async (taskGuid, details) => ({
            ok: true,
            state: (await dispatcher.appendFeedback(taskGuid, details)).state,
          }),
        },
        logger,
      })
    : null;

  dispatcher.recoverInterruptedRuns();
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    poller.stop();
    await dispatcher.shutdown();
    await dashboard?.stop();
    db.close();
  };
  const onSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let fatalExitPromise: Promise<void> | undefined;
  const handleFatalProcessError = (kind: string, reason: unknown): void => {
    if (fatalExitPromise) return;
    const message = reason instanceof Error
      ? reason.stack ?? reason.message
      : String(reason);
    logger.error(`direct runtime ${kind}`, { error: message });
    fatalExitPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          stop(),
          new Promise<void>((resolvePromise) => {
            timer = setTimeout(resolvePromise, 5_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        process.exit(1);
      }
    })();
  };
  const onUncaughtException = (error: Error): void => {
    handleFatalProcessError("uncaught exception", error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    handleFatalProcessError("unhandled rejection", reason);
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    if (dashboard) {
      const dashboardUrl = await dashboard.start();
      logger.info("dashboard listening", { url: dashboardUrl });
    }
    if (args.once) {
      await poller.pollOnce();
      await dispatcher.waitForIdle(config.runTimeoutSeconds * 1000 + 5000);
      await dispatcher.flushOutbox();
    } else {
      await poller.run();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
    await stop();
  }
}

async function runDirectMode(
  config: ReturnType<typeof loadConfig>,
  projectRoot: string,
  args: MainArguments,
  logger: Logger,
): Promise<void> {
  const dbPath = resolve(args.dbPath);
  const db = new StateDatabase(dbPath);
  logger.info("bridge state database", {
    path: dbPath,
    mode: config.execution.mode,
  });
  const { FeishuSqliteCodexRuntime } = await import("./feishu-sqlite-codex.js");
  const runtime = new FeishuSqliteCodexRuntime(config, {
    db,
    logger,
    attachmentsDir: join(projectRoot, "runtime", "direct", "attachments"),
  });
  const localNotifications = config.localNotifications.enabled
    && config.localNotifications.mode === "poll"
    ? new LocalCodexNotificationWatcher({
      createClient: () => new CodexAppServerClient({
        executable: config.codex.cliPath,
        cwd: projectRoot,
        env: buildCodexAppServerEnvironment(config),
        clientName: "feishu_codex_bridge_notifications",
        clientTitle: "Feishu Codex Bridge Notifications",
      }),
      logger,
      statePath: join(dirname(dbPath), "codex-local-notifications.json"),
    })
    : null;
  const notificationInbox = config.localNotifications.enabled
    && config.localNotifications.mode === "hook"
    ? new LocalCodexNotificationInbox({ logger })
    : null;
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await localNotifications?.stop();
      await notificationInbox?.stop();
      await runtime.stop();
    } finally {
      db.close();
    }
  };
  const onSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await runtime.start();
    await startLocalNotifications(localNotifications, config.localNotifications.intervalSeconds, logger);
    await startNotificationInbox(notificationInbox, logger);
    if (args.once) {
      await runtime.runOnce();
      await localNotifications?.pollOnce();
      return;
    }
    await runtime.waitUntilStopped();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await stop();
  }
}

async function runAampMode(
  config: ReturnType<typeof loadConfig>,
  projectRoot: string,
  args: MainArguments,
  logger: Logger,
): Promise<void> {
  const dbPath = resolve(args.dbPath);
  const db = new StateDatabase(dbPath);
  logger.info("bridge state database", { path: dbPath, mode: "aamp" });
  const relay = new AampRelayClient(config.relay);
  if (config.relay.enabled && config.relay.statusUrl) {
    const report = await reconcileRunningAampTasks(db, relay, logger);
    logger.info("AAMP startup compensation scan completed", { ...report });
  } else if (config.relay.enabled) {
    logger.warn("AAMP Relay statusUrl is not configured; startup compensation scan skipped", {
      aampHost: config.relay.aampHost,
    });
  }

  const runtime = new AampTaskAgentRuntime(config, {
    projectRoot,
    configPath: args.configPath,
    sqlitePath: dbPath,
    attachmentsDir: join(projectRoot, "runtime", "aamp", "attachments"),
    logger,
  });
  const localNotifications = config.localNotifications.enabled
    && config.localNotifications.mode === "poll"
    ? new LocalCodexNotificationWatcher({
      createClient: () => new CodexAppServerClient({
        executable: config.codex.cliPath,
        cwd: projectRoot,
        env: buildCodexAppServerEnvironment(config),
        clientName: "feishu_codex_bridge_notifications",
        clientTitle: "Feishu Codex Bridge Notifications",
      }),
      logger,
      statePath: join(dirname(dbPath), "codex-local-notifications.json"),
    })
    : null;
  const notificationInbox = config.localNotifications.enabled
    && config.localNotifications.mode === "hook"
    ? new LocalCodexNotificationInbox({ logger })
    : null;
  const dashboard = config.web.enabled
    ? new DashboardServer({
        db,
        host: config.web.host,
        port: config.web.port,
        projects: Object.keys(config.projects),
        modes: Object.keys(config.modes),
        logger,
      })
    : null;
  let runtimeStarted = false;
  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await localNotifications?.stop();
      await notificationInbox?.stop();
      if (runtimeStarted && config.aamp.stopOnShutdown) {
        await runtime.stop();
      } else {
        if (runtimeStarted) {
          logger.info("leaving the official AAMP background service running", {
            reason: "aamp.stopOnShutdown=false",
          });
        }
      }
    } catch (error) {
      logger.warn("failed to stop the official AAMP background service", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await dashboard?.stop().catch((error) => {
        logger.warn("failed to stop AAMP dashboard", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      db.close();
      resolveStopped?.();
    }
  };
  const onSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (dashboard) {
      const dashboardUrl = await dashboard.start();
      logger.info("dashboard listening", { url: dashboardUrl, mode: "aamp" });
    }
    await runtime.start();
    runtimeStarted = true;
    await startLocalNotifications(localNotifications, config.localNotifications.intervalSeconds, logger);
    await startNotificationInbox(notificationInbox, logger);
    logger.info("official AAMP runtime started", {
      profile: config.lark.profile,
      relay: config.relay.aampHost ?? "official-default",
      note: "AAMP owns Feishu WSS/IM/card events; SQLite persistence and the local dashboard are owned by this bridge.",
    });
    if (args.once) {
      await localNotifications?.pollOnce();
      return;
    }
    await stopped;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await stop();
  }
}

async function startLocalNotifications(
  watcher: LocalCodexNotificationWatcher | null,
  intervalSeconds: number,
  logger: Logger,
): Promise<void> {
  if (!watcher) return;
  try {
    await watcher.start(intervalSeconds);
    logger.info("local Codex system notifications enabled", { intervalSeconds });
  } catch (error) {
    logger.warn("local Codex system notifications disabled after startup failure", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function startNotificationInbox(
  inbox: LocalCodexNotificationInbox | null,
  logger: Logger,
): Promise<void> {
  if (!inbox) return;
  try {
    await inbox.start();
    logger.info("official Codex notify inbox enabled");
  } catch (error) {
    logger.warn("official Codex notify inbox disabled after startup failure", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function createLogger(): Logger {
  const write = (level: string, message: string, details?: Record<string, unknown>): void => {
    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...(details ? { details } : {}),
    };
    console.log(JSON.stringify(record));
  };
  return {
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}

function printUsage(): void {
  console.log(
    [
      "Usage: node dist/main.js [--config path] [--db path] [--once] [--mode execution-mode]",
      "  --config  bridge config JSON (default: ./config.json)",
      "  --db      SQLite path (default: ./runtime/bridge.db)",
      "  --once    start the selected runtime once and exit",
      "  --mode    override execution.mode for this process (alias: --execution-mode)",
      "  execution.mode: aamp-relay | feishu-sqlite-codex | feishu-sqlite-acp (alias) | legacy-polling",
    ].join("\n"),
  );
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
