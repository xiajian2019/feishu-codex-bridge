import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { TmuxResurrectUnavailableError, type TmuxResurrectController } from "../src/tmux-resurrect.js";

class ResponseFixture {
  statusCode = 0;
  body = "";
  setHeader(): void {}
  end(value?: string): void { this.body = value ?? ""; }
  json(): Record<string, unknown> { return JSON.parse(this.body) as Record<string, unknown>; }
}

function requestFixture(method: string, path: string): IncomingMessage {
  const request = Readable.from([]) as Readable & Record<string, unknown>;
  request.method = method;
  request.url = `/tmux-dashboard/api${path}`;
  request.headers = {};
  return request as unknown as IncomingMessage;
}

async function call(api: TmuxDashboardApi, method: string, path: string): Promise<ResponseFixture> {
  const response = new ResponseFixture();
  await api.handleRequest(
    requestFixture(method, path),
    response as unknown as ServerResponse,
  );
  return response;
}

function controller(actions: string[]): TmuxResurrectController {
  const snapshot = { sessionName: "alpha", savedAt: "2026-10-29T00:00:00.000Z" };
  return {
    status: () => ({
      installed: true,
      configured: true,
      automaticSave: true,
      automaticRestore: false,
      perSessionRestore: true,
      automaticStart: true,
      pluginDirectory: "/tmp/tmux-resurrect",
      saveDirectory: "/tmp/tmux-resurrect-state",
      sessionSnapshotDirectory: "/tmp/tmux-resurrect-state/bridge-sessions",
      configPath: "/tmp/tmux.conf",
      lastSnapshotAt: snapshot.savedAt,
    }),
    saveSession: async (sessionName) => {
      actions.push(`save:${sessionName}`);
      return { action: "save", sessionName, snapshot: { ...snapshot, sessionName }, output: "save complete" };
    },
    restoreSession: async (sessionName) => {
      actions.push(`restore:${sessionName}`);
      return { action: "restore", sessionName, snapshot: { ...snapshot, sessionName }, output: "restore complete" };
    },
    restorePendingSessions: async () => ({ restored: [], failures: [] }),
    snapshotForSession: (sessionName) => sessionName === "alpha" ? snapshot : null,
    disableSession: (sessionName) => { actions.push(`disable:${sessionName}`); },
  };
}

describe("per-session tmux-resurrect Dashboard integration", () => {
  it("exposes the snapshot on the Session row and delegates actions by Session name", async () => {
    const db = new StateDatabase(":memory:");
    const actions: string[] = [];
    const session = { id: "$1", name: "alpha", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
    db.recordTmuxSession(session);
    const api = new TmuxDashboardApi({
      db,
      resurrect: controller(actions),
      operations: {
        listSessions: async () => [session],
        findSession: async () => session,
        createSession: async () => session,
        killSession: async () => {},
      },
    });
    try {
      const list = await call(api, "GET", "/sessions?includeHomes=0");
      expect(list.statusCode).toBe(200);
      expect(list.json().sessions).toEqual([expect.objectContaining({
        name: "alpha",
        snapshot: { sessionName: "alpha", savedAt: "2026-10-29T00:00:00.000Z" },
      })]);

      const save = await call(api, "POST", "/sessions/%241/resurrect/save");
      expect(save.statusCode).toBe(200);
      expect(save.json()).toMatchObject({ ok: true, action: "save", sessionName: "alpha" });

      expect(actions).toEqual(["save:alpha"]);
    } finally {
      await api.stop();
      db.close();
    }
  });

  it("keeps suspend distinct from terminate and resumes the same logical Session record", async () => {
    const db = new StateDatabase(":memory:");
    const actions: string[] = [];
    const session = { id: "$1", name: "alpha", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
    const restored = { ...session, id: "$2", createdAt: 2 };
    db.recordTmuxSession(session);
    let live: typeof session | undefined = session;
    const base = controller(actions);
    const api = new TmuxDashboardApi({
      db,
      resurrect: {
        ...base,
        restoreSession: async (sessionName) => {
          actions.push(`restore:${sessionName}`);
          live = restored;
          return { action: "restore", sessionName, snapshot: { sessionName, savedAt: "2026-10-29T00:00:00.000Z" }, output: "restore complete" };
        },
      },
      autoRestoreSessions: true,
      operations: {
        listSessions: async () => live ? [live] : [],
        findSession: async () => live,
        createSession: async () => restored,
        killSession: async () => { live = undefined; },
      },
    });
    try {
      const suspended = await call(api, "POST", "/sessions/%241/suspend");
      expect(suspended.statusCode).toBe(200);
      expect(db.getLatestTmuxSession("$1")?.suspended_at).not.toBeNull();
      expect(db.getLatestTmuxSession("$1")?.ended_at).toBeNull();

      const resumed = await call(api, "POST", "/sessions/%241/resume");
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ ok: true, action: "resume", session: { id: "$2", name: "alpha" } });
      expect(db.getLatestTmuxSession("$2")?.suspended_at).toBeNull();
      expect(db.getLatestTmuxSession("$2")?.ended_at).toBeNull();
      expect(actions).toEqual(["save:alpha", "restore:alpha"]);
    } finally {
      await api.stop();
      db.close();
    }
  });

  it("disables a Session snapshot when the Session is explicitly ended", async () => {
    const db = new StateDatabase(":memory:");
    const actions: string[] = [];
    const session = { id: "$1", name: "alpha", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
    db.recordTmuxSession(session);
    const api = new TmuxDashboardApi({
      db,
      resurrect: controller(actions),
      autoRestoreSessions: true,
      operations: {
        listSessions: async () => [],
        findSession: async () => session,
        createSession: async () => session,
        killSession: async () => {},
      },
    });
    try {
      const response = await call(api, "DELETE", "/sessions/%241");
      expect(response.statusCode).toBe(204);
      expect(actions).toEqual(["disable:alpha"]);
      expect(db.getLatestTmuxSession(session.id)?.ended_at).not.toBeNull();
    } finally {
      await api.stop();
      db.close();
    }
  });

  it("returns a clear unavailable response when the plugin is not installed", async () => {
    const db = new StateDatabase(":memory:");
    const session = { id: "$1", name: "alpha", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
    db.recordTmuxSession(session);
    const base = controller([]);
    const api = new TmuxDashboardApi({
      db,
      resurrect: {
        ...base,
        saveSession: async () => { throw new TmuxResurrectUnavailableError(); },
      },
      operations: {
        listSessions: async () => [session],
        findSession: async () => session,
        createSession: async () => session,
        killSession: async () => {},
      },
    });
    try {
      const response = await call(api, "POST", "/sessions/%241/resurrect/save");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "tmux-resurrect 尚未安装，请先运行 bun run tmux:setup。" });
    } finally {
      await api.stop();
      db.close();
    }
  });
});
