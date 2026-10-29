import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { listSessions } from "../src/tmux-dashboard.js";

function responseFixture() {
  return {
    statusCode: 0, body: "", setHeader() {},
    end(value: string) { this.body = value; },
  };
}

async function query(api: TmuxDashboardApi) {
  const response = responseFixture();
  await api.handleRequest({ method: "GET", url: "/tmux-dashboard/api/sessions?includeHomes=0" } as IncomingMessage,
    response as unknown as ServerResponse);
  return { status: response.statusCode, data: JSON.parse(response.body) };
}

describe("bounded tmux Session enumeration", () => {
  it("kills only the stuck query client when the tmux command exceeds its deadline", async () => {
    const signals: string[] = [];
    const commands: string[][] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
      commands.push(command);
      return { stdout: { text: () => new Promise(() => {}) }, stderr: { text: () => new Promise(() => {}) },
        exited: new Promise(() => {}), killed: false, kill: (signal: string) => signals.push(signal) };
    }) as never);
    try {
      await expect(listSessions({ timeoutMs: 15 })).rejects.toThrow("Session 列表查询超时");
      expect(commands).toHaveLength(1);
      expect(commands[0]!.slice(0, 2)).toEqual(["tmux", "list-sessions"]);
      expect(signals).toEqual(["SIGKILL"]);
    } finally { spawn.mockRestore(); }
  });

  it("releases a stuck shared request, preserves history and ignores its late result", async () => {
    const db = new StateDatabase(":memory:");
    const saved = { id: "$1", name: "existing", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
    const ghost = { ...saved, id: "$2", name: "late" };
    db.recordTmuxSession(saved);
    let finishOld!: (sessions: typeof saved[]) => void;
    let calls = 0;
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const api = new TmuxDashboardApi({ db, sessionListTimeoutMs: 20,
      logger: { info() {}, error() {}, warn(_message, details) { warnings.push(details); } },
      operations: {
        listSessions: () => ++calls === 1 ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve([saved]),
        findSession: async () => saved, createSession: async () => saved, killSession: async () => {},
      } });
    try {
      const first = await Promise.all([query(api), query(api)]);
      expect(first.map((result) => result.status)).toEqual([503, 503]);
      expect(calls).toBe(1);
      expect(warnings).toMatchObject([{ phase: "tmux-enumeration", error: expect.stringContaining("超时") }]);
      expect(db.getLatestTmuxSession(saved.id)?.ended_at).toBeNull();
      expect((await query(api)).status).toBe(200);
      expect(calls).toBe(2);
      finishOld([ghost]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(db.getLatestTmuxSession(ghost.id)).toBeNull();
      expect(db.getLatestTmuxSession(saved.id)?.ended_at).toBeNull();
    } finally { await api.stop(); db.close(); }
  });

  for (const operation of ["create", "delete"] as const) {
    it(`invalidates pre-${operation} list results so the mutation is immediately visible`, async () => {
      const db = new StateDatabase(":memory:");
      const existing = { id: "$1", name: "existing", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
      const created = { ...existing, id: "$2", name: "created", createdAt: 2 };
      db.recordTmuxSession(existing);
      db.createProject({ name: "fixture", path: "/tmp" });
      let finishOld!: (sessions: typeof existing[]) => void;
      let calls = 0;
      const current = operation === "create" ? [existing, created] : [];
      const api = new TmuxDashboardApi({ db, operations: {
        listSessions: () => ++calls === 1 ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(current),
        findSession: async () => existing, createSession: async () => created, killSession: async () => {},
      } });
      try {
        const staleRead = query(api);
        const request = Readable.from(operation === "create"
          ? [JSON.stringify({ name: created.name, projectKey: "fixture", workingDirectory: "/tmp" })] : []) as IncomingMessage;
        request.method = operation === "create" ? "POST" : "DELETE";
        request.url = operation === "create" ? "/tmux-dashboard/api/sessions" : "/tmux-dashboard/api/sessions/%241";
        request.headers = { "content-type": "application/json" };
        const response = responseFixture();
        await api.handleRequest(request, response as unknown as ServerResponse);
        expect(response.statusCode).toBe(operation === "create" ? 201 : 204);
        finishOld([existing]);
        expect((await staleRead).status).toBe(503);
        const fresh = await query(api);
        expect(fresh.status).toBe(200);
        if (operation === "create") {
          expect(JSON.parse(response.body).session).toMatchObject({ id: created.id, name: created.name });
          expect(fresh.data.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, endedAt: null })]));
          expect(db.getLatestTmuxSession(created.id)?.ended_at).toBeNull();
        } else {
          expect(fresh.data.sessions[0]?.endedAt).not.toBeNull();
          expect(db.getLatestTmuxSession(existing.id)?.ended_at).not.toBeNull();
        }
        expect(calls).toBe(2);
      } finally { await api.stop(); db.close(); }
    });
  }

  it("submits an optional initial task to codex-worktree after creating the Session", async () => {
    const db = new StateDatabase(":memory:");
    const session = { id: "$9", name: "initial-task", cwd: "/tmp", createdAt: 9, windows: 1, attachedClients: 0 };
    db.createProject({ name: "fixture", path: "/tmp" });
    let pastedCommand = "";
    let enteredPane = "";
    const api = new TmuxDashboardApi({
      db,
      codexWorktreeExecutable: "/fixture/bin/codex-worktree",
      operations: {
        listSessions: async () => [session],
        findSession: async () => session,
        createSession: async () => session,
        killSession: async () => {},
        inspectReviewPane: async () => ({
          paneId: "%9",
          panePid: 99,
          paneTty: "/dev/ttysfixture",
          currentCommand: "zsh",
          cwd: "/tmp",
          foregroundCodex: null,
        }),
        pasteTextToPane: async (_paneId, text) => { pastedCommand = text; },
        sendEnterToPane: async (paneId) => { enteredPane = paneId; },
      },
    });
    const request = Readable.from([JSON.stringify({
      name: session.name,
      projectKey: "fixture",
      taskDescription: "修复 session 创建后的初始任务\n并保留 shell quote: 'quoted'",
    })]) as IncomingMessage;
    request.method = "POST";
    request.url = "/tmux-dashboard/api/sessions";
    request.headers = { "content-type": "application/json" };
    const response = responseFixture();
    try {
      await api.handleRequest(request, response as unknown as ServerResponse);
      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).initialTask).toEqual({ status: "submitted" });
      expect(enteredPane).toBe("%9");
      expect(pastedCommand).toContain("'/fixture/bin/codex-worktree' --task-file '");
      const taskFile = pastedCommand.match(/--task-file '([^']+)'/)?.[1];
      expect(taskFile).toBeTruthy();
      expect(readFileSync(taskFile!, "utf8")).toBe("修复 session 创建后的初始任务\n并保留 shell quote: 'quoted'");
      expect(pastedCommand).toContain("rm -f '");
    } finally {
      const taskFile = pastedCommand.match(/--task-file '([^']+)'/)?.[1];
      if (taskFile) rmSync(taskFile, { force: true });
      await api.stop();
      db.close();
    }
  });
});
