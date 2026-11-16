import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import type { SshFallbackSnapshots } from "../src/ssh-session-fallback-snapshots.js";
import type { TmuxResurrectController } from "../src/tmux-resurrect.js";

describe("SSH fallback snapshots when Bridge returns", () => {
  it("shows a file-backed snapshot without changing SQLite, then rebinds its original record on API restore", async () => {
    const db = new StateDatabase(":memory:");
    const original = { id: "$7", name: "alpha", cwd: "/fixture", createdAt: 42, windows: 1, attachedClients: 0 };
    const saved = db.recordTmuxSession(original);
    const restored = { ...original, id: "$9", createdAt: 44 };
    const snapshot = { id: "$7", createdAt: 42, name: "alpha", cwd: "/fixture", savedAt: "2026-11-03T00:00:00.000Z", source: "ssh-fallback" as const };
    let present = true;
    let restoredCalls = 0;
    const fallback: Pick<SshFallbackSnapshots, "list" | "restore" | "endSuspended"> = {
      list: async () => present ? [snapshot] : [],
      restore: async (id, createdAt) => {
        expect([id, createdAt]).toEqual(["$7", 42]);
        restoredCalls += 1; present = false; return restored;
      },
      endSuspended: async () => { throw new Error("not used"); },
    };
    const resurrect = { snapshotForSession: () => null } as unknown as TmuxResurrectController;
    const api = new TmuxDashboardApi({ db, sshFallbackSnapshots: fallback, resurrect, operations: {
      listSessions: async () => present ? [] : [restored],
      findSession: async () => present ? undefined : restored,
      createSession: async () => restored, killSession: async () => {},
    } });
    async function call(method: string, path: string) {
      const request = Readable.from([]) as IncomingMessage;
      request.method = method; request.url = `/tmux-dashboard/api${path}`;
      request.headers = { "x-bridge-session-created-at": "42" };
      const response = { statusCode: 0, body: "", setHeader() {}, end(value = "") { this.body = value; } };
      await api.handleRequest(request, response as unknown as ServerResponse);
      return { status: response.statusCode, data: response.body ? JSON.parse(response.body) : {} };
    }
    try {
      const list = await call("GET", "/sessions?includeHomes=0");
      expect(list.data.sessions).toEqual([expect.objectContaining({ id: "$7", source: "ssh-fallback", suspendedAt: snapshot.savedAt })]);
      expect(db.getTmuxSession(saved.record_id)).toMatchObject({ tmux_session_id: "$7", ended_at: null, suspended_at: null });
      expect((await call("GET", "/sessions/suspended")).data.sessions).toEqual([expect.objectContaining(snapshot)]);
      const result = await call("POST", "/sessions/%247/resume?source=ssh-fallback");
      expect(result.status).toBe(200);
      expect(result.data.session).toMatchObject({ id: "$9", name: "alpha" });
      expect(restoredCalls).toBe(1);
      expect(db.getTmuxSession(saved.record_id)).toMatchObject({ tmux_session_id: "$9", tmux_created_at: 44, ended_at: null, suspended_at: null });
    } finally { await api.stop(); db.close(); }
  });

  it("refuses an ambiguous Web and SSH snapshot without changing either", async () => {
    const db = new StateDatabase(":memory:");
    const session = { id: "$7", name: "alpha", cwd: "/fixture", createdAt: 42, windows: 1, attachedClients: 0 };
    const saved = db.recordTmuxSession(session);
    db.markTmuxSessionRecordSuspended(saved.record_id);
    let restored = false;
    const fallback: Pick<SshFallbackSnapshots, "list" | "restore" | "endSuspended"> = {
      list: async () => [{ id: "$7", createdAt: 42, name: "alpha", cwd: "/fixture", savedAt: "2026-11-03T00:00:00.000Z", source: "ssh-fallback" }],
      restore: async () => { restored = true; return session; }, endSuspended: async () => { throw new Error("not used"); },
    };
    const api = new TmuxDashboardApi({ db, sshFallbackSnapshots: fallback,
      resurrect: { snapshotForSession: () => null } as unknown as TmuxResurrectController,
      operations: { listSessions: async () => [], findSession: async () => undefined,
        createSession: async () => session, killSession: async () => {} } });
    try {
      const request = Readable.from([]) as IncomingMessage;
      request.method = "POST"; request.url = "/tmux-dashboard/api/sessions/%247/resume";
      request.headers = { "x-bridge-session-created-at": "42" };
      const response = { statusCode: 0, setHeader() {}, end() {} };
      await api.handleRequest(request, response as unknown as ServerResponse);
      expect(response.statusCode).toBe(409);
      expect(restored).toBe(false);
      expect(db.getTmuxSession(saved.record_id)?.suspended_at).not.toBeNull();
    } finally { await api.stop(); db.close(); }
  });

  it("ends only the selected fallback snapshot and retains unrelated Web snapshots", async () => {
    const db = new StateDatabase(":memory:");
    const session = { id: "$7", name: "alpha", cwd: "/fixture", createdAt: 42, windows: 1, attachedClients: 0 };
    const saved = db.recordTmuxSession(session);
    let ended = false;
    let webDisabled = false;
    const fallback: Pick<SshFallbackSnapshots, "list" | "restore" | "endSuspended"> = {
      list: async () => ended ? [] : [{ id: "$7", createdAt: 42, name: "alpha", cwd: "/fixture", savedAt: "2026-11-03T00:00:00.000Z", source: "ssh-fallback" }],
      restore: async () => { throw new Error("not used"); },
      endSuspended: async (id, createdAt) => { expect([id, createdAt]).toEqual(["$7", 42]); ended = true; },
    };
    const api = new TmuxDashboardApi({ db, sshFallbackSnapshots: fallback, resurrect: {
      snapshotForSession: () => null, disableSession: () => { webDisabled = true; },
    } as unknown as TmuxResurrectController, operations: {
      listSessions: async () => [], findSession: async () => undefined,
      createSession: async () => session, killSession: async () => { throw new Error("not used"); },
    } });
    try {
      const request = Readable.from([]) as IncomingMessage;
      request.method = "DELETE"; request.url = "/tmux-dashboard/api/sessions/%247?source=ssh-fallback";
      request.headers = { "x-bridge-session-created-at": "42" };
      const response = { statusCode: 0, setHeader() {}, end() {} };
      await api.handleRequest(request, response as unknown as ServerResponse);
      expect(response.statusCode).toBe(204);
      expect(ended).toBe(true);
      expect(webDisabled).toBe(false);
      expect(db.getTmuxSession(saved.record_id)?.ended_at).not.toBeNull();
    } finally { await api.stop(); db.close(); }
  });

  it("keeps Web restore available if fallback metadata cannot be read", async () => {
    const db = new StateDatabase(":memory:");
    const original = { id: "$7", name: "alpha", cwd: "/fixture", createdAt: 42, windows: 1, attachedClients: 0 };
    const saved = db.recordTmuxSession(original);
    db.markTmuxSessionRecordSuspended(saved.record_id);
    const restored = { ...original, id: "$9", createdAt: 44 };
    let live = false;
    const fallback: Pick<SshFallbackSnapshots, "list" | "restore" | "endSuspended"> = {
      list: async () => { throw new Error("fixture metadata is unreadable"); },
      restore: async () => { throw new Error("not used"); }, endSuspended: async () => { throw new Error("not used"); },
    };
    const resurrect = { snapshotForSession: () => null, restoreSession: async (name: string) => {
      live = true;
      return { action: "restore", sessionName: name, snapshot: { sessionName: name, savedAt: "2026-11-03T00:00:00.000Z" }, output: "" };
    } } as unknown as TmuxResurrectController;
    const api = new TmuxDashboardApi({ db, sshFallbackSnapshots: fallback, resurrect, operations: {
      listSessions: async () => live ? [restored] : [], findSession: async () => undefined,
      createSession: async () => restored, killSession: async () => {},
    } });
    try {
      const request = Readable.from([]) as IncomingMessage;
      request.method = "POST"; request.url = "/tmux-dashboard/api/sessions/%247/resume";
      request.headers = { "x-bridge-session-created-at": "42" };
      const response = { statusCode: 0, setHeader() {}, end() {} };
      await api.handleRequest(request, response as unknown as ServerResponse);
      expect(response.statusCode).toBe(200);
      expect(db.getTmuxSession(saved.record_id)).toMatchObject({ tmux_session_id: "$9", suspended_at: null });
    } finally { await api.stop(); db.close(); }
  });
});
