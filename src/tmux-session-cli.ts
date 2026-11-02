import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { StateDatabase } from "./db.js";
import { isSingleBinaryRuntime, resolveBridgeDataRoot } from "./portable-runtime.js";
import { tmuxResurrectController, type TmuxResurrectController } from "./tmux-resurrect.js";
import * as tmux from "./tmux-dashboard.js";

export interface TmuxRestoreCliOptions {
  databasePath: string;
  listSessions?: typeof tmux.listSessions;
  resurrect?: TmuxResurrectController;
}

export interface TmuxRestoreCliResult {
  before: Array<{ id: string; name: string; createdAt: number }>;
  after: Array<{ id: string; name: string; createdAt: number }>;
  candidates: string[];
  restored: string[];
  failures: Array<{ sessionName: string; error: string }>;
  synced: boolean;
}

/**
 * Reconcile tmux-resurrect only when explicitly requested after a restart.
 * The Web Session list deliberately does not call this function.
 */
export async function restorePendingTmuxSessions(options: TmuxRestoreCliOptions): Promise<TmuxRestoreCliResult> {
  if (!existsSync(options.databasePath)) throw new Error(`Bridge 数据库不存在：${options.databasePath}`);
  const database = new StateDatabase(options.databasePath);
  const listSessions = options.listSessions ?? tmux.listSessions;
  const resurrect = options.resurrect ?? tmuxResurrectController;
  try {
    const before = await listSessions();
    const candidates = [...new Set(database.listTmuxSessionsForDashboard()
      .filter((session) => session.ended_at === null && session.suspended_at === null)
      .map((session) => session.session_name))];
    const liveNames = before.map((session) => session.name);
    const status = resurrect.status();
    const restore = candidates.length > 0 && !status.installed
      ? {
        restored: [] as string[],
        failures: candidates.map((sessionName) => ({ sessionName, error: "tmux-resurrect 尚未安装。" })),
      }
      : await resurrect.restorePendingSessions(candidates, liveNames);
    const after = await listSessions();
    // This is the only recovery reconciliation path now. A page read only
    // overlays committed DB metadata and never performs this write. Preserve
    // active rows when a restore fails so a transient plugin error does not
    // make the next manual retry ineligible.
    const synced = restore.failures.length === 0;
    if (synced) database.syncTmuxSessions(after);
    return {
      before: before.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
      after: after.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
      candidates,
      restored: restore.restored,
      failures: restore.failures,
      synced,
    };
  } finally {
    database.close();
  }
}

function parseOptions(argv: string[]): TmuxRestoreCliOptions {
  const dataRoot = resolveBridgeDataRoot(import.meta.url);
  let databasePath = resolve(dataRoot, "runtime", "bridge.db");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "restore") continue;
    if (arg === "--db") {
      const value = argv[++index];
      if (!value) throw new Error("--db 需要一个数据库路径。");
      databasePath = resolve(value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { databasePath };
}

export async function runTmuxSessionCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    const result = await restorePendingTmuxSessions(parseOptions(argv));
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (!isSingleBinaryRuntime() && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runTmuxSessionCli();
}
