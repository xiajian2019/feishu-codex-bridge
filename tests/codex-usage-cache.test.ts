import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { CodexHistoryService, type CodexHistoryUsageSnapshot } from "../src/codex-history.js";

describe("Codex usage cache", () => {
  it("migrates a legacy per-account snapshot without losing snapshots or daily buckets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-legacy-usage-"));
    const path = join(directory, "bridge.db");
    const snapshot = (date: string, tokens: number): CodexHistoryUsageSnapshot => ({
      snapshotDate: date,
      capturedAt: `${date}T12:00:00.000Z`,
      tokenUsage: { summary: { lifetimeTokens: tokens }, dailyUsageBuckets: [{ startDate: "2026-10-07", tokens }] },
    });
    const original = snapshot("2026-10-08", 310_621_319);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE codex_account_usage_snapshots (
        home_id TEXT PRIMARY KEY, snapshot_date TEXT NOT NULL,
        captured_at TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE codex_account_usage_daily_buckets (
        home_id TEXT NOT NULL, usage_date TEXT NOT NULL,
        tokens INTEGER NOT NULL CHECK (tokens >= 0), captured_at TEXT NOT NULL,
        PRIMARY KEY(home_id, usage_date)
      );
    `);
    for (const home of ["first", "second"]) {
      legacy.query("INSERT INTO codex_account_usage_snapshots VALUES (?, ?, ?, ?)")
        .run(home, original.snapshotDate, original.capturedAt, JSON.stringify(original));
      legacy.query("INSERT INTO codex_account_usage_daily_buckets VALUES (?, ?, ?, ?)")
        .run(home, "2026-10-07", 42, original.capturedAt);
    }
    legacy.close();
    let db: StateDatabase | undefined;
    try {
      db = new StateDatabase(path);
      expect(db.getCodexUsageSnapshot("first")).toEqual(original);
      expect(db.getCodexUsageSnapshot("second")).toEqual(original);
      expect(db.listCodexUsageDailyBuckets("first")).toEqual([{ startDate: "2026-10-07", tokens: 42 }]);
      db.saveCodexUsageSnapshot("first", snapshot("2026-10-27", 500), [{ startDate: "2026-10-26", tokens: 100 }]);
      db.saveCodexUsageSnapshot("first", snapshot("2026-10-28", 600), [{ startDate: "2026-10-27", tokens: 200 }]);
      db.close();
      db = undefined;

      // Reopening must leave the migrated schema and all dates intact.
      db = new StateDatabase(path);
      db.saveCodexUsageSnapshot("first", snapshot("2026-10-28", 700), [{ startDate: "2026-10-27", tokens: 300 }]);
      expect(db.getCodexUsageSnapshot("first")).toEqual(snapshot("2026-10-28", 700));
      expect(db.getCodexUsageSnapshot("second")).toEqual(original);
      expect(db.listCodexUsageDailyBuckets("first")).toEqual([
        { startDate: "2026-10-07", tokens: 42 },
        { startDate: "2026-10-26", tokens: 100 },
        { startDate: "2026-10-27", tokens: 300 },
      ]);
      const inspection = new Database(path, { readonly: true });
      try {
        expect(inspection.query("SELECT count(*) AS count FROM codex_account_usage_snapshots").get()).toEqual({ count: 4 });
        expect(inspection.query("SELECT payload_json FROM codex_account_usage_snapshots WHERE home_id = ? AND snapshot_date = ?")
          .get("first", "2026-10-08")).toEqual({ payload_json: JSON.stringify(original) });
      } finally {
        inspection.close();
      }
    } finally {
      db?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists every successful refresh and keeps the last success when the next read fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-usage-refresh-"));
    await writeFile(join(directory, "state_5.sqlite"), "");
    const db = new StateDatabase(join(directory, "fixture.db"), undefined, { delayMs: 20 });
    let now = Date.parse("2026-10-28T01:00:00.000Z");
    let tokens = 100;
    let failing = false;
    const service = new CodexHistoryService({
      executable: "unused-in-test",
      environment: { CODEX_HOME: directory },
      now: () => now,
      usageSnapshotStore: db,
      createClient: () => ({
        listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
        readAccountRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 10 } } }),
        readAccountTokenUsage: async () => {
          if (failing) throw new Error("offline");
          return { summary: { lifetimeTokens: tokens }, dailyUsageBuckets: [{ startDate: "2026-10-27", tokens }] };
        },
        close: async () => undefined,
      }),
    });
    try {
      const homeId = service.listHomes()[0]!.id;
      await service.readUsage(homeId);
      await eventually(() => db.getCodexUsageSnapshot(homeId) !== null);
      const firstCapture = db.getCodexUsageSnapshot(homeId)!.capturedAt;
      now += 60_000;
      tokens = 200;
      const fresh = (await service.readUsage(homeId)).accounts[0]!;
      expect(fresh.tokenUsageUpdatedAt).not.toBe(firstCapture);
      // The response arrives before background persistence; a later worker commit catches up.
      expect(db.getCodexUsageSnapshot(homeId)?.capturedAt).toBe(firstCapture);
      await eventually(() => db.getCodexUsageSnapshot(homeId)?.capturedAt === new Date(now).toISOString());
      expect(db.getCodexUsageSnapshot(homeId)).toMatchObject({
        capturedAt: new Date(now).toISOString(), tokenUsage: { summary: { lifetimeTokens: 200 } },
      });
      expect(db.listCodexUsageDailyBuckets(homeId)).toEqual([{ startDate: "2026-10-27", tokens: 200 }]);
      const lastSuccess = db.getCodexUsageSnapshot(homeId);
      now += 60_000;
      failing = true;
      const stale = (await service.readUsage(homeId)).accounts[0]!;
      expect(stale.stale?.tokenUsage).toBe(true);
      expect(stale.checkedAt).toBe(new Date(now).toISOString());
      expect(stale.tokenUsageUpdatedAt).toBe(lastSuccess!.capturedAt);
      expect(db.getCodexUsageSnapshot(homeId)).toEqual(lastSuccess);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs failed persistence while still returning freshly read usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-usage-write-error-"));
    await writeFile(join(directory, "state_5.sqlite"), "");
    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const service = new CodexHistoryService({
      executable: "unused-in-test",
      environment: { CODEX_HOME: directory },
      usageSnapshotStore: {
        getCodexUsageSnapshot: () => null,
        listCodexUsageDailyBuckets: () => [],
        enqueueCodexUsageSnapshot: () => { throw new Error("cache is read-only"); },
      },
      logger: { info() {}, error() {}, warn(message, details) { warnings.push({ message, details }); } },
      createClient: () => ({
        listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
        readAccountRateLimits: async () => ({ rateLimits: {} }),
        readAccountTokenUsage: async () => ({ summary: { lifetimeTokens: 300 } }),
        close: async () => undefined,
      }),
    });
    try {
      const homeId = service.listHomes()[0]!.id;
      const account = (await service.readUsage(homeId)).accounts[0]!;
      expect(account.tokenUsage?.summary?.lifetimeTokens).toBe(300);
      expect(account.stale?.tokenUsage).not.toBe(true);
      expect(warnings).toEqual([{
        message: "failed to persist Codex account usage snapshot",
        details: { homeId, snapshotDate: expect.any(String), error: "cache is read-only" },
      }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("background usage persistence timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
