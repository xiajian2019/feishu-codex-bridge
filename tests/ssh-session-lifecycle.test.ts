import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import type { TmuxResurrectController } from "../src/tmux-resurrect.js";

class ResponseFixture {
  statusCode = 0;
  body = "";
  setHeader(): void {}
  end(value?: string): void { this.body = value ?? ""; }
  json(): Record<string, unknown> { return this.body ? JSON.parse(this.body) as Record<string, unknown> : {}; }
}
async function call(api: TmuxDashboardApi, method: string, path: string, createdAt?: number): Promise<ResponseFixture> {
  const request = Readable.from([]) as Readable & Record<string, unknown>;
  request.method = method;
  request.url = `/tmux-dashboard/api${path}`;
  request.headers = createdAt === undefined ? {} : { "x-bridge-session-created-at": String(createdAt) };
  const response = new ResponseFixture();
  await api.handleRequest(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return response;
}
function controller(save: (name: string) => Promise<void>): TmuxResurrectController {
  return {
    status: () => ({ installed: true, configured: true, automaticSave: false, automaticRestore: false,
      perSessionRestore: true, automaticStart: false, pluginDirectory: "/fixture/plugin", saveDirectory: "/fixture/state",
      sessionSnapshotDirectory: "/fixture/state/bridge-sessions", configPath: null, lastSnapshotAt: null }),
    saveSession: async (sessionName) => { await save(sessionName); return { action: "save", sessionName, snapshot: { sessionName, savedAt: "now" }, output: "" }; },
    restoreSession: async (sessionName) => ({ action: "restore", sessionName, snapshot: { sessionName, savedAt: "now" }, output: "" }),
    restorePendingSessions: async () => ({ restored: [], failures: [] }),
    snapshotForSession: () => null,
    disableSession: () => {},
  };
}
const session = { id: "$1", name: "alpha", cwd: "/tmp", createdAt: 10, windows: 1, attachedClients: 0 };

describe("SSH and Web Session lifecycle", () => {
  it("rejects a reused Session ID before saving, killing, or changing the database", async () => {
    const db = new StateDatabase(":memory:");
    db.recordTmuxSession(session);
    let saves = 0; let kills = 0;
    const api = new TmuxDashboardApi({ db, resurrect: controller(async () => { saves += 1; }), operations: {
      listSessions: async () => [session], findSession: async () => session, createSession: async () => session,
      killSession: async () => { kills += 1; },
    } });
    try {
      expect((await call(api, "GET", "/sessions/%241/identity", 9)).statusCode).toBe(409);
      expect((await call(api, "POST", "/sessions/%241/suspend", 9)).statusCode).toBe(409);
      expect((await call(api, "DELETE", "/sessions/%241", 9)).statusCode).toBe(409);
      expect(saves).toBe(0); expect(kills).toBe(0);
      expect(db.getLatestTmuxSession("$1")?.ended_at).toBeNull();
      expect(db.getLatestTmuxSession("$1")?.suspended_at).toBeNull();
    } finally { await api.stop(); db.close(); }
  });

  it("does not kill a new Session if the target changes while its snapshot is being saved", async () => {
    const db = new StateDatabase(":memory:"); db.recordTmuxSession(session);
    let lookups = 0; let kills = 0;
    const api = new TmuxDashboardApi({ db, resurrect: controller(async () => {}), operations: {
      listSessions: async () => [session], findSession: async () => ++lookups === 1 ? session : { ...session, createdAt: 11 },
      createSession: async () => session, killSession: async () => { kills += 1; },
    } });
    try {
      expect((await call(api, "POST", "/sessions/%241/suspend", 10)).statusCode).toBe(409);
      expect(kills).toBe(0);
      expect(db.getLatestTmuxSession("$1")?.suspended_at).toBeNull();
    } finally { await api.stop(); db.close(); }
  });

  it("resumes the suspended record when a restarted tmux server reuses its ID", async () => {
    const db = new StateDatabase(":memory:");
    const suspended = db.recordTmuxSession(session);
    db.markTmuxSessionSuspended(session.id);
    const other = { ...session, name: "other", createdAt: 20 };
    db.recordTmuxSession(other);
    const restored = { ...session, id: "$2", createdAt: 21 };
    let restoredLive = false;
    const resurrect = controller(async () => {});
    resurrect.restoreSession = async (name) => {
      restoredLive = true;
      return { action: "restore", sessionName: name, snapshot: { sessionName: name, savedAt: "now" }, output: "" };
    };
    const api = new TmuxDashboardApi({ db, resurrect, operations: {
      listSessions: async () => restoredLive ? [other, restored] : [other],
      findSession: async (id) => id === other.id ? other : restoredLive && id === restored.id ? restored : undefined,
      createSession: async () => other, killSession: async () => { throw new Error("must not kill the other Session"); },
    } });
    try {
      expect((await call(api, "POST", "/sessions/%241/resume", 10)).statusCode).toBe(200);
      expect(db.getTmuxSession(suspended.record_id)).toMatchObject({ tmux_session_id: "$2", suspended_at: null, ended_at: null });
      expect(db.getLatestTmuxSession("$1")).toMatchObject({ session_name: "other", tmux_created_at: 20, ended_at: null });
    } finally { await api.stop(); db.close(); }
  });

  it("terminates only the selected record when an active and suspended Session share an ID", async () => {
    for (const endSuspended of [false, true]) {
      const db = new StateDatabase(":memory:");
      const suspended = db.recordTmuxSession(session);
      db.markTmuxSessionSuspended(session.id);
      const live = { ...session, name: "other", createdAt: 20 };
      const active = db.recordTmuxSession(live);
      let kills = 0;
      const api = new TmuxDashboardApi({ db, resurrect: controller(async () => {}), operations: {
        listSessions: async () => [live], findSession: async () => live,
        createSession: async () => live, killSession: async () => { kills += 1; },
      } });
      try {
        expect((await call(api, "DELETE", "/sessions/%241", endSuspended ? 10 : 20)).statusCode).toBe(204);
        expect(kills).toBe(endSuspended ? 0 : 1);
        expect(db.getTmuxSession(suspended.record_id)?.ended_at === null).toBe(!endSuspended);
        expect(db.getTmuxSession(active.record_id)?.ended_at === null).toBe(endSuspended);
      } finally { await api.stop(); db.close(); }
    }
  });

  it("preserves a suspended snapshot when another live Session uses the same name", async () => {
    const db = new StateDatabase(":memory:");
    const suspended = db.recordTmuxSession(session); db.markTmuxSessionSuspended(session.id);
    const live = { ...session, id: "$2", createdAt: 20 };
    const active = db.recordTmuxSession(live);
    let saves = 0; let kills = 0; let disables = 0;
    const resurrect = controller(async () => { saves += 1; });
    resurrect.disableSession = () => { disables += 1; };
    const api = new TmuxDashboardApi({ db, resurrect, operations: {
      listSessions: async () => [live], findSession: async (id) => id === live.id ? live : undefined,
      createSession: async () => live, killSession: async () => { kills += 1; },
    } });
    try {
      expect((await call(api, "POST", "/sessions/%242/resurrect/save", 20)).statusCode).toBe(409);
      expect((await call(api, "POST", "/sessions/%242/suspend", 20)).statusCode).toBe(409);
      expect((await call(api, "DELETE", "/sessions/%242", 20)).statusCode).toBe(409);
      expect((await call(api, "DELETE", "/sessions/%241", 10)).statusCode).toBe(409);
      expect({ saves, kills, disables }).toEqual({ saves: 0, kills: 0, disables: 0 });
      expect(db.getTmuxSession(suspended.record_id)?.suspended_at).not.toBeNull();
      expect(db.getTmuxSession(active.record_id)?.ended_at).toBeNull();
    } finally { await api.stop(); db.close(); }
  });

  it("does not restore snapshots or wait for restoration while listing Sessions", async () => {
    const db = new StateDatabase(":memory:"); db.recordTmuxSession(session);
    let restores = 0;
    const resurrect = controller(async () => {});
    resurrect.restorePendingSessions = async () => {
      restores += 1;
      return { restored: [], failures: [] };
    };
    const api = new TmuxDashboardApi({ db, autoRestoreSessions: true, resurrect, operations: {
      listSessions: async () => [session], findSession: async () => session,
      createSession: async () => session, killSession: async () => {},
    } });
    try {
      const list = await call(api, "GET", "/sessions?includeHomes=0");
      expect(list.statusCode).toBe(200);
      expect(restores).toBe(0);
      expect(db.getLatestTmuxSession("$1")?.ended_at).toBeNull();
      expect(db.getLatestTmuxSession("$1")?.suspended_at).toBeNull();
    } finally { await api.stop(); db.close(); }
  });

  it("reads suspended rows without restoring them from the Session list", async () => {
    const db = new StateDatabase(":memory:"); db.recordTmuxSession(session);
    db.markTmuxSessionSuspended(session.id);
    let restores = 0;
    const attachmentDirectory = mkdtempSync(join(tmpdir(), "bridge-ssh-history-test-"));
    const resurrect = controller(async () => {});
    resurrect.restorePendingSessions = async () => {
      restores += 1;
      return { restored: [], failures: [] };
    };
    const api = new TmuxDashboardApi({ db, attachmentDirectory, autoRestoreSessions: true, resurrect, operations: {
      listSessions: async () => [],
      findSession: async () => undefined, createSession: async () => session, killSession: async () => {},
    } });
    try {
      const list = await call(api, "GET", "/sessions?includeHomes=0");
      expect(list.statusCode).toBe(200);
      expect(list.json().sessions).toEqual([expect.objectContaining({ id: "$1", name: "alpha", suspendedAt: expect.any(String) })]);
      expect(restores).toBe(0);
      const before = restores;
      const suspended = await call(api, "GET", "/sessions/suspended");
      expect(suspended.json().sessions).toEqual([{ id: "$1", name: "alpha", cwd: "/tmp", createdAt: 10 }]);
      expect(restores).toBe(before);
    } finally { await api.stop(); db.close(); rmSync(attachmentDirectory, { recursive: true, force: true }); }
  });
});
