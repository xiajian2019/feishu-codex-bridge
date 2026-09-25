import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { StateDatabase } from "./db.js";
import { TmuxDashboardApi } from "./tmux-dashboard-api.js";
import { DashboardServer } from "./web.js";
import { WebPairingAuth } from "./web-auth.js";

interface Options {
  dbPath: string;
  port: number;
}

function parseArguments(argv: string[]): Options {
  let dbPath = "";
  let port = 17310;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--db" || arg.startsWith("--db=")) {
      const value = arg.startsWith("--db=") ? arg.slice("--db=".length) : argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--db requires an existing SQLite database path.");
      dbPath = resolve(value);
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const value = arg.startsWith("--port=") ? arg.slice("--port=".length) : argv[++index];
      const parsedPort = Number(value);
      if (!value || value.startsWith("--") || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("--port requires a port from 1 to 65535.");
      }
      port = parsedPort;
      continue;
    }
    throw new Error("Unknown argument: " + arg);
  }
  if (!dbPath || !existsSync(dbPath)) {
    throw new Error("Pass an existing database with --db; this dashboard-only server will not create a database.");
  }
  return { dbPath, port };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const db = new StateDatabase(options.dbPath);
  const tmuxDashboard = new TmuxDashboardApi({ db });
  const dashboard = new DashboardServer({
    db,
    auth: new WebPairingAuth({ db }),
    tmuxDashboard,
    host: "127.0.0.1",
    port: options.port,
    modes: [],
    taskAttachmentsDirectory: join(tmpdir(), "feishu-codex-bridge", "tmux-dashboard-dev-unused"),
    cleanupExpiredStagedAttachments: false,
  });
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void dashboard.stop()
      .catch((error: unknown) => {
        console.error("Failed to stop the tmux dashboard API.", error);
      })
      .finally(() => {
        db.close();
        resolveStopped();
      });
  };
  const onSignal = (): void => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const url = await dashboard.start();
    console.log("tmux dashboard-only API listening at " + url + " using " + options.dbPath);
    await stopped;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!stopping) {
      await dashboard.stop();
      db.close();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
