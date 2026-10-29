import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      expect(commands[0]!.at(-1)).toContain("#{pane_current_path}");
      expect(commands[0]!.at(-1)).not.toContain("#{session_path}");
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
      expect(pastedCommand).toContain("__bridge_codex_worktree_task() {");
      expect(pastedCommand).toContain("CODEX_WORKTREE_DELETE_TASK_FILE_AFTER_RUN=1");
      expect(pastedCommand).toContain("'/fixture/bin/codex-worktree' --help");
      expect(pastedCommand).toContain("${__bridge_codex_worktree_handoff:+--tmux-handoff} --task-file '");
      const taskFile = pastedCommand.match(/--task-file '([^']+)'/)?.[1];
      expect(taskFile).toBeTruthy();
      expect(readFileSync(taskFile!, "utf8")).toBe("修复 session 创建后的初始任务\n并保留 shell quote: 'quoted'");
      expect(pastedCommand).toContain("rm -f '");
      expect(pastedCommand).not.toContain('exit "$status"');
    } finally {
      const taskFile = pastedCommand.match(/--task-file '([^']+)'/)?.[1];
      if (taskFile) rmSync(taskFile, { force: true });
      await api.stop();
      db.close();
    }
  });

  it("updates a Session name and logical directory without changing the pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-session-edit-"));
    const workingDirectory = join(root, "worktree");
    mkdirSync(workingDirectory);
    const db = new StateDatabase(":memory:");
    db.createProject({ name: "fixture", path: "/tmp" });
    let session = { id: "$12", name: "before", cwd: "/tmp", createdAt: 12, windows: 1, attachedClients: 0 };
    db.recordTmuxSession(session, { projectKey: "fixture" });
    const updates: Array<{ id: string; name: string; cwd: string }> = [];
    const api = new TmuxDashboardApi({
      db,
      operations: {
        listSessions: async () => [session],
        findSession: async (id) => id === session.id ? session : undefined,
        createSession: async () => session,
        killSession: async () => {},
        getCurrentPanePath: async () => session.cwd,
        updateSession: async (id, name, cwd) => {
          updates.push({ id, name, cwd });
          session = { ...session, name };
          return session;
        },
      },
    });
    const request = Readable.from([JSON.stringify({ name: "after", workingDirectory })]) as IncomingMessage;
    request.method = "PATCH";
    request.url = "/tmux-dashboard/api/sessions/%2412";
    request.headers = { "content-type": "application/json" };
    const response = responseFixture();
    try {
      await api.handleRequest(request, response as unknown as ServerResponse);
      expect(response.statusCode).toBe(200);
      const canonicalWorkingDirectory = realpathSync(workingDirectory);
      expect(JSON.parse(response.body).session).toMatchObject({ id: "$12", name: "after", cwd: canonicalWorkingDirectory });
      expect(updates).toEqual([{ id: "$12", name: "after", cwd: canonicalWorkingDirectory }]);
      expect(db.getLatestTmuxSession("$12")).toMatchObject({
        session_name: "after",
        working_directory: canonicalWorkingDirectory,
        working_directory_override: canonicalWorkingDirectory,
        project_key: null,
      });
      expect(session.cwd).toBe("/tmp");
      const listResponse = responseFixture();
      await api.handleRequest({ method: "GET", url: "/tmux-dashboard/api/sessions?includeHomes=0" } as IncomingMessage,
        listResponse as unknown as ServerResponse);
      expect(JSON.parse(listResponse.body).sessions[0].cwd).toBe(canonicalWorkingDirectory);
    } finally {
      await api.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const staleState of ["recreated", "ended", "suspended"] as const) {
    it(`ignores a ${staleState} Session's directory override on direct file access`, async () => {
      const root = mkdtempSync(join(tmpdir(), "bridge-stale-session-directory-"));
      const oldDirectory = join(root, "old");
      const currentDirectory = join(root, "current");
      mkdirSync(oldDirectory);
      mkdirSync(currentDirectory);
      writeFileSync(join(oldDirectory, "old.txt"), "old session");
      writeFileSync(join(currentDirectory, "current.txt"), "current session");
      const db = new StateDatabase(":memory:");
      const previous = { id: "$17", name: "previous", cwd: currentDirectory, createdAt: 1, windows: 1, attachedClients: 0 };
      const record = db.recordTmuxSession(previous);
      db.setTmuxSessionWorkingDirectory(record.record_id, currentDirectory, oldDirectory);
      if (staleState === "ended") db.markTmuxSessionEnded(previous.id);
      if (staleState === "suspended") db.markTmuxSessionSuspended(previous.id);
      const live = { ...previous, createdAt: staleState === "recreated" ? 2 : 1 };
      const api = new TmuxDashboardApi({ db, operations: {
        listSessions: async () => [live], findSession: async () => live,
        createSession: async () => live, killSession: async () => {},
        getCurrentPanePath: async () => currentDirectory,
      } });
      try {
        const response = responseFixture();
        await api.handleRequest({ method: "GET", url: "/tmux-dashboard/api/sessions/%2417/files" } as IncomingMessage,
          response as unknown as ServerResponse);
        expect(response.statusCode).toBe(200);
        const result = JSON.parse(response.body);
        expect(result.root).toBe(realpathSync(currentDirectory));
        expect(result.entries.map((entry: { name: string }) => entry.name)).toEqual(["current.txt"]);
      } finally {
        await api.stop();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
