import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexHistoryService, type CodexHistoryUsageSnapshot } from "../src/codex-history.js";
import { CodexUsageSnapshotWriter, type CodexUsageSnapshotWriterOptions } from "../src/codex-usage-snapshot-writer.js";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(options: CodexUsageSnapshotWriterOptions = { delayMs: 30 }) {
  const root = mkdtempSync(join(tmpdir(), "bridge-usage-writer-"));
  const path = join(root, "fixture.db");
  const db = new StateDatabase(path);
  const writer = new CodexUsageSnapshotWriter(path, options);
  const inspection = new Database(path);
  cleanups.push(() => { writer.stop(); inspection.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, db, writer, inspection };
}

function snapshot(tokens: number, date = "2026-10-28", time = "01:00:00.000Z"): CodexHistoryUsageSnapshot {
  return { snapshotDate: date, capturedAt: `${date}T${time}`,
    tokenUsage: { summary: { lifetimeTokens: tokens }, dailyUsageBuckets: [{ startDate: "2026-10-27", tokens }] } };
}

async function eventually(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("background writer condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("background Codex usage snapshots", () => {
  it("defers the default write for five seconds without delaying the caller", async () => {
    const f = fixture({});
    const started = performance.now();
    f.writer.enqueue("home", snapshot(100), []);
    expect(performance.now() - started).toBeLessThan(100);
    expect(f.db.getCodexUsageSnapshot("home")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 4_700));
    expect(f.db.getCodexUsageSnapshot("home")).toBeNull();
    await eventually(() => f.db.getCodexUsageSnapshot("home") !== null);
    expect(performance.now() - started).toBeGreaterThanOrEqual(5_000);
  }, 10_000);

  it("coalesces rapid refreshes, merges omitted dates, ignores older captures and preserves account/date boundaries", async () => {
    const f = fixture();
    f.inspection.exec(`CREATE TABLE fixture_writes (home_id TEXT);
      CREATE TRIGGER fixture_insert AFTER INSERT ON codex_account_usage_snapshots
      BEGIN INSERT INTO fixture_writes VALUES (new.home_id); END;
      CREATE TRIGGER fixture_update AFTER UPDATE ON codex_account_usage_snapshots
      BEGIN INSERT INTO fixture_writes VALUES (new.home_id); END;`);
    f.writer.enqueue("one", snapshot(100), [{ startDate: "2026-10-25", tokens: 50 }]);
    f.writer.enqueue("one", snapshot(200, "2026-10-28", "02:00:00.000Z"), [{ startDate: "2026-10-27", tokens: 200 }]);
    f.writer.enqueue("one", snapshot(10, "2026-10-28", "00:00:00.000Z"), [{ startDate: "2026-10-27", tokens: 10 }]);
    f.writer.enqueue("one", snapshot(300, "2026-10-29"), []);
    f.writer.enqueue("two", snapshot(400), []);
    await eventually(() => (f.inspection.query("SELECT count(*) AS count FROM fixture_writes").get() as { count: number }).count === 3);
    expect(f.db.getCodexUsageSnapshot("one")).toEqual(snapshot(300, "2026-10-29"));
    expect(f.db.getCodexUsageSnapshot("two")).toEqual(snapshot(400));
    expect(f.db.listCodexUsageDailyBuckets("one")).toEqual([
      { startDate: "2026-10-25", tokens: 50 }, { startDate: "2026-10-27", tokens: 200 },
    ]);
    expect(JSON.parse((f.inspection.query("SELECT payload_json FROM codex_account_usage_snapshots WHERE home_id='one' AND snapshot_date='2026-10-28'")
      .get() as { payload_json: string }).payload_json)).toEqual(snapshot(200, "2026-10-28", "02:00:00.000Z"));
  });

  it("keeps the freshest in-memory result available when a later RPC fails before any disk write", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "state_5.sqlite"), "");
    let failing = false;
    const service = new CodexHistoryService({ executable: "unused", environment: { CODEX_HOME: f.root }, usageSnapshotStore: f.db,
      createClient: () => ({
        listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
        readAccountRateLimits: async () => ({ rateLimits: {} }),
        readAccountTokenUsage: async () => { if (failing) throw new Error("offline"); return snapshot(200).tokenUsage; },
        close: async () => undefined,
      }) });
    const homeId = service.listHomes()[0]!.id;
    const fresh = (await service.readUsage(homeId)).accounts[0]!;
    expect(f.db.getCodexUsageSnapshot(homeId)).toBeNull();
    failing = true;
    const stale = (await service.readUsage(homeId)).accounts[0]!;
    expect(stale.tokenUsage).toEqual(fresh.tokenUsage);
    expect(stale.tokenUsageUpdatedAt).toBe(fresh.tokenUsageUpdatedAt);
    expect(stale.stale?.tokenUsage).toBe(true);
  });

  it("does expensive SQLite work in a separate thread while the main event loop keeps running", async () => {
    const f = fixture();
    f.inspection.exec(`CREATE TRIGGER fixture_slow BEFORE INSERT ON codex_account_usage_snapshots BEGIN
      SELECT (WITH RECURSIVE counter(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM counter WHERE value < 3000000)
        SELECT sum(value) FROM counter); END;`);
    let ticks = 0;
    let longestGap = 0;
    let last = performance.now();
    const heartbeat = setInterval(() => { const now = performance.now(); longestGap = Math.max(longestGap, now - last); last = now; ticks += 1; }, 10);
    try {
      f.writer.enqueue("home", snapshot(100), []);
      await eventually(() => f.db.getCodexUsageSnapshot("home") !== null, 5_000);
      expect(ticks).toBeGreaterThan(10);
      expect(longestGap).toBeLessThan(250);
    } finally { clearInterval(heartbeat); }
  }, 8_000);

  it("serves Session reads while the background writer is executing slow SQL", async () => {
    const f = fixture();
    const session = { id: "$41", name: "fixture", cwd: f.root, createdAt: 1, windows: 1, attachedClients: 0 };
    f.db.recordTmuxSession(session);
    const tmux = new TmuxDashboardApi({ db: f.db, operations: {
      listSessions: async () => [session], findSession: async () => session,
      createSession: async () => session, killSession: async () => undefined,
    } });
    const server = new DashboardServer({ db: f.db, tmuxDashboard: tmux,
      auth: new WebPairingAuth({ db: f.db, allowLocalRequests: true }),
      host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
    cleanups.push(() => server.stop());
    const url = await server.start();
    f.inspection.exec(`CREATE TRIGGER fixture_slow_api BEFORE INSERT ON codex_account_usage_snapshots BEGIN
      SELECT (WITH RECURSIVE counter(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM counter WHERE value < 3000000)
        SELECT sum(value) FROM counter); END;`);
    f.writer.enqueue("home", snapshot(100), []);
    await eventually(() => {
      try { f.inspection.exec("BEGIN IMMEDIATE"); }
      catch (error) {
        if ((error as { code?: string }).code === "SQLITE_BUSY") return true;
        throw error;
      }
      f.inspection.exec("ROLLBACK");
      return false;
    });
    const started = performance.now();
    const response = await fetch(url + "/tmux-dashboard/api/sessions?includeHomes=0");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessions: [{ id: session.id, endedAt: null }] });
    expect(performance.now() - started).toBeLessThan(250);
    expect(f.db.getCodexUsageSnapshot("home")).toBeNull();
    await eventually(() => f.db.getCodexUsageSnapshot("home") !== null);
  });

  it("keeps prior autocommitted rows when a later cache statement fails", async () => {
    const f = fixture();
    f.inspection.exec(`CREATE TRIGGER fixture_failure BEFORE INSERT ON codex_account_usage_snapshots
      BEGIN SELECT RAISE(ABORT, 'fixture cache failure'); END;`);
    const errors: string[] = [];
    f.writer.enqueue("home", snapshot(100), [{ startDate: "2026-10-27", tokens: 100 }], (error) => errors.push(error.message));
    expect(errors).toEqual([]);
    await eventually(() => errors.length === 1);
    expect(errors[0]).toContain("fixture cache failure");
    expect(f.db.getCodexUsageSnapshot("home")).toBeNull();
    // Removing the explicit transaction leaves earlier statements committed.
    expect(f.db.listCodexUsageDailyBuckets("home")).toEqual([{ startDate: "2026-10-27", tokens: 100 }]);
    f.inspection.exec("DROP TRIGGER fixture_failure");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.db.getCodexUsageSnapshot("home")).toBeNull();
    expect(errors).toHaveLength(1);
    f.writer.enqueue("home", snapshot(200), []);
    await eventually(() => f.db.getCodexUsageSnapshot("home") !== null);
    expect(f.db.getCodexUsageSnapshot("home")).toEqual(snapshot(200));
  });

  it("bounds pending cache entries and cancels delayed work on shutdown", async () => {
    const f = fixture();
    for (let index = 0; index < 70; index += 1) f.writer.enqueue(`home-${index}`, snapshot(index), []);
    await eventually(() => f.db.getCodexUsageSnapshot("home-69") !== null);
    expect(f.inspection.query("SELECT count(*) AS count FROM codex_account_usage_snapshots").get()).toEqual({ count: 64 });
    expect(f.db.getCodexUsageSnapshot("home-0")).toBeNull();
    f.writer.enqueue("cancelled", snapshot(100), []);
    f.writer.stop();
    f.writer.enqueue("after-stop", snapshot(100), []);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.db.getCodexUsageSnapshot("cancelled")).toBeNull();
    expect(f.db.getCodexUsageSnapshot("after-stop")).toBeNull();
  });
});
