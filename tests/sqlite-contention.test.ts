import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { CodexHistoryService, type CodexHistoryUsageSnapshot } from "../src/codex-history.js";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi, type TmuxDashboardApiOptions } from "../src/tmux-dashboard-api.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { DashboardServer } from "../src/web.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-sqlite-contention-"));
  const path = join(root, "fixture.db");
  let now = new Date("2026-10-28T06:00:00.000Z");
  const db = new StateDatabase(path, () => now, { delayMs: 20 });
  const writer = new Database(path);
  writer.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0");
  cleanups.push(() => {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    writer.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const connection = (db as unknown as { db: Database }).db;
  return { root, db, writer, connection, advance: () => { now = new Date(now.getTime() + 61_000); } };
}

const snapshot = (tokens: number): CodexHistoryUsageSnapshot => ({
  snapshotDate: "2026-10-28",
  capturedAt: "2026-10-28T06:00:00.000Z",
  tokenUsage: { summary: { lifetimeTokens: tokens }, dailyUsageBuckets: [{ startDate: "2026-10-27", tokens }] },
});

describe("SQLite contention during usage refresh and page reload", () => {
  it("keeps the database writable while quota and token RPCs are still pending", async () => {
    const { root, db, writer, connection } = fixture();
    writeFileSync(join(root, "state_5.sqlite"), "");
    let finishQuota!: () => void;
    let finishUsage!: () => void;
    const quotaGate = new Promise<void>((resolve) => { finishQuota = resolve; });
    const usageGate = new Promise<void>((resolve) => { finishUsage = resolve; });
    let clientCount = 0;
    const service = new CodexHistoryService({
      executable: "unused-in-test", environment: { CODEX_HOME: root }, usageSnapshotStore: db,
      now: () => Date.parse(snapshot(200).capturedAt),
      createClient: () => {
        clientCount += 1;
        return {
          listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
          readAccountRateLimits: async () => { await quotaGate; return { rateLimits: {} }; },
          readAccountTokenUsage: async () => { await usageGate; return snapshot(200).tokenUsage; },
          close: async () => undefined,
        };
      },
    });
    const homeId = service.listHomes()[0]!.id;
    const reads = Promise.all([service.readUsage(homeId), service.readUsage(homeId)]);
    try {
      expect(connection.inTransaction).toBe(false);
      writer.exec("BEGIN IMMEDIATE; INSERT INTO projects VALUES ('one', '/tmp', 'available', 'now', 'now'); COMMIT");
      finishQuota();
      await Promise.resolve();
      expect(connection.inTransaction).toBe(false);
      writer.exec("BEGIN IMMEDIATE; INSERT INTO projects VALUES ('two', '/tmp', 'available', 'now', 'now'); COMMIT");
    } finally {
      finishQuota(); finishUsage();
      await reads;
    }
    expect(clientCount).toBe(1);
    await eventually(() => db.getCodexUsageSnapshot(homeId)?.tokenUsage.summary?.lifetimeTokens === 200);
    expect(db.getCodexUsageSnapshot(homeId)).toEqual(snapshot(200));
  });

  it("returns fresh usage and drops a cache write on contention without retrying after unlock", async () => {
    const { root, db, writer, connection } = fixture();
    writeFileSync(join(root, "state_5.sqlite"), "");
    const warnings: string[] = [];
    const service = new CodexHistoryService({
      executable: "unused-in-test", environment: { CODEX_HOME: root }, usageSnapshotStore: db,
      now: () => Date.parse(snapshot(200).capturedAt),
      logger: { info() {}, error() {}, warn(message) { warnings.push(message); } },
      createClient: () => ({
        listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
        readAccountRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 20 } } }),
        readAccountTokenUsage: async () => snapshot(200).tokenUsage,
        close: async () => undefined,
      }),
    });
    const homeId = service.listHomes()[0]!.id;
    db.saveCodexUsageSnapshot(homeId, snapshot(100), [{ startDate: "2026-10-27", tokens: 100 }]);
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const account = (await service.readUsage(homeId)).accounts[0]!;
    const elapsed = performance.now() - started;
    expect(account.tokenUsage?.summary?.lifetimeTokens).toBe(200);
    expect(account.quota?.buckets[0]?.primary?.usedPercent).toBe(20);
    expect(db.getCodexUsageSnapshot(homeId)).toEqual(snapshot(100));
    expect(connection.inTransaction).toBe(false);
    expect(connection.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
    expect(warnings).toEqual([]);
    expect(elapsed).toBeLessThan(1_000);
    await eventually(() => warnings.length === 1);
    expect(db.getCodexUsageSnapshot(homeId)).toEqual(snapshot(100));
    expect(warnings).toEqual(["failed to persist Codex account usage snapshot"]);
    writer.exec("ROLLBACK");
    // Wait beyond the former five-second retry interval: a failed write stays discarded.
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    expect(db.getCodexUsageSnapshot(homeId)).toEqual(snapshot(100));
    expect(warnings).toHaveLength(1);
    // An explicit new refresh may enqueue a new attempt.
    await service.readUsage(homeId);
    await eventually(() => db.getCodexUsageSnapshot(homeId)?.tokenUsage.summary?.lifetimeTokens === 200);
    expect(db.getCodexUsageSnapshot(homeId)).toEqual(snapshot(200));
    expect(db.listCodexUsageDailyBuckets(homeId)).toEqual([{ startDate: "2026-10-27", tokens: 200 }]);
  }, 10_000);

  it("reloads the session list and reconnects an existing terminal while a writer is busy", async () => {
    const f = fixture();
    const session = { id: "$41", name: "fixture", cwd: f.root, createdAt: 1, windows: 1, attachedClients: 0 };
    const saved = f.db.recordTmuxSession(session);
    f.advance();
    const runtime: NonNullable<TmuxDashboardApiOptions["terminalRuntime"]> = {
      spawn() {
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        return {
          terminal: { write() {}, resize() {}, close() {} }, exited, killed: false,
          kill() { this.killed = true; resolveExit(0); },
        };
      },
    };
    const tmux = new TmuxDashboardApi({ db: f.db, terminalRuntime: runtime, operations: {
      listSessions: async () => [session], findSession: async () => session,
      createSession: async () => session, killSession: async () => undefined,
      capturePane: async () => "fixture snapshot",
    } });
    const auth = new WebPairingAuth({ db: f.db, allowLocalRequests: true });
    const warnings: string[] = [];
    const server = new DashboardServer({ db: f.db, auth, tmuxDashboard: tmux, host: "127.0.0.1", port: 0,
      modes: [], cleanupExpiredStagedAttachments: false,
      logger: { info() {}, error() {}, warn(message) { warnings.push(message); } } });
    let socket: WebSocket | undefined;
    cleanups.push(async () => {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
      await server.stop();
    });
    const url = await server.start();
    f.writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    socket = new WebSocket(url.replace("http:", "ws:") + "/tmux-dashboard/terminal?session=%2441", {
      headers: { Origin: url }, handshakeTimeout: 8_000,
    });
    const [response, , [frame]] = await Promise.all([
      fetch(url + "/tmux-dashboard/api/sessions?includeHomes=0"),
      once(socket, "open"), once(socket, "message"),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessions: [{ id: session.id, endedAt: null }] });
    expect(String(frame)).toContain("fixture snapshot");
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(warnings).toEqual([]);
    expect(f.db.getLatestTmuxSession(session.id)?.last_seen_at).toBe(saved.last_seen_at);
    expect(f.connection.inTransaction).toBe(false);
    expect(f.connection.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
    f.writer.exec("ROLLBACK");
    expect((await fetch(url + "/tmux-dashboard/api/sessions?includeHomes=0")).status).toBe(200);
    expect(f.db.getLatestTmuxSession(session.id)?.last_seen_at).not.toBe(saved.last_seen_at);
  }, 15_000);

  it("never falls back to an ended or recreated session record when the writer is busy", () => {
    const f = fixture();
    const session = { id: "$41", name: "fixture", cwd: f.root, createdAt: 1 };
    const saved = f.db.recordTmuxSession(session);
    f.advance();
    f.writer.exec("BEGIN IMMEDIATE");
    expect(f.db.observeTmuxSession(session).record_id).toBe(saved.record_id);
    expect(() => f.db.observeTmuxSession({ ...session, createdAt: 2 })).toThrow(/locked/i);
    expect(() => f.db.observeTmuxSession({ ...session, id: "$42" })).toThrow(/locked/i);
    f.writer.exec("ROLLBACK");
    f.db.markTmuxSessionEnded(session.id);
    f.writer.exec("BEGIN IMMEDIATE");
    expect(() => f.db.observeTmuxSession(session)).toThrow(/locked/i);
    f.writer.exec("ROLLBACK");
    const recreated = f.db.observeTmuxSession({ ...session, createdAt: 2 });
    expect(recreated.record_id).not.toBe(saved.record_id);
    expect(recreated.tmux_created_at).toBe(2);
  });

  it("rolls back a failed session sync and still surfaces errors unrelated to contention", () => {
    const f = fixture();
    const first = { id: "$41", name: "first", cwd: f.root, createdAt: 1 };
    f.db.recordTmuxSession(first);
    f.advance();
    const second = { ...first, id: "$42", name: "second", createdAt: 2 };
    f.writer.exec("BEGIN IMMEDIATE");
    f.db.syncTmuxSessions([second]);
    expect(f.db.getLatestTmuxSession(first.id)?.ended_at).toBeNull();
    expect(f.db.getLatestTmuxSession(second.id)).toBeNull();
    f.writer.exec("ROLLBACK");
    expect(() => f.db.syncTmuxSessions([{ ...second, name: null as unknown as string }])).toThrow(/NOT NULL/i);
    expect(f.db.getLatestTmuxSession(first.id)?.ended_at).toBeNull();
    f.db.syncTmuxSessions([second]);
    expect(f.db.getLatestTmuxSession(first.id)?.ended_at).not.toBeNull();
    expect(f.db.getLatestTmuxSession(second.id)?.ended_at).toBeNull();
  });

  it("discards rolled-back savepoint events while publishing successful outer changes after commit", () => {
    const { db, writer } = fixture();
    const events: string[] = [];
    db.subscribe((change) => events.push(change.taskGuid));
    db.transaction(() => {
      db.initializeAampTask({ aampTaskId: "outer-one", chatId: "fixture", userText: "one" });
      expect(() => db.transaction(() => {
        db.initializeAampTask({ aampTaskId: "rolled-back", chatId: "fixture", userText: "two" });
        throw new Error("rollback fixture");
      })).toThrow("rollback fixture");
      db.initializeAampTask({ aampTaskId: "outer-two", chatId: "fixture", userText: "three" });
      expect(events).toEqual([]);
    });
    expect(events).toEqual(["aamp:outer-one", "aamp:outer-two"]);
    expect(db.getAampTask("rolled-back")).toBeNull();
    expect(writer.query("SELECT count(*) AS count FROM aamp_tasks").get()).toEqual({ count: 2 });
  });

  it("restores transaction state after COMMIT fails so a later write is actually committed", () => {
    const { db, writer, connection } = fixture();
    connection.exec(`CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE fixture_child (id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);`);
    expect(() => db.transaction(() => {
      connection.exec("INSERT INTO fixture_child VALUES (1, 999)");
    })).toThrow(/FOREIGN KEY/i);
    expect(connection.inTransaction).toBe(false);
    db.transaction(() => db.createProject({ name: "after-commit-failure", path: "/tmp" }));
    expect(connection.inTransaction).toBe(false);
    expect(writer.query("SELECT name FROM projects WHERE name = 'after-commit-failure'").get())
      .toEqual({ name: "after-commit-failure" });
    writer.exec("BEGIN IMMEDIATE; COMMIT");
  });
});

async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("background usage persistence timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
