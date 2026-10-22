import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { parseConfig } from "../src/config.js";
import { StateDatabase } from "../src/db.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DashboardServer } from "../src/web.js";
import type { LarkClient } from "../src/lark.js";
import type { TmuxSession } from "../src/tmux-dashboard.js";
import type { WorkerHandle, WorkerRunner } from "../src/types.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
}

function initRepository(parent: string): string {
  const repository = join(parent, "repo");
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "-b", "master");
  git(repository, "config", "user.name", "Bridge HTTP Test");
  git(repository, "config", "user.email", "bridge-http-test@example.invalid");
  writeFileSync(join(repository, "README.md"), "base\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  return repository;
}

describe("Task workspace HTTP lifecycle", () => {
  it("creates a task from the current tmux pane, opens its worktree, and protects cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-worktree-http-"));
    const repository = initRepository(root);
    const unmanagedPath = join(root, "manual-worktree");
    git(repository, "worktree", "add", "-b", "manual/unmanaged", unmanagedPath, "master");
    const masterSha = git(repository, "rev-parse", "master");
    git(repository, "checkout", "-b", "xiajian/source-feature");
    writeFileSync(join(repository, "source-feature.txt"), "source feature\n");
    git(repository, "add", "source-feature.txt");
    git(repository, "commit", "-m", "source feature");
    const db = new StateDatabase(":memory:");
    db.createProject({ name: "fixture", path: repository });
    const config = parseConfig({
      maxConcurrency: 1,
      runTimeoutSeconds: 30,
      codex: { cliPath: "/unused-fixture-codex" },
      lark: { profile: "fixture", tasklistGuid: "list", projectFieldGuid: "project", modeFieldGuid: "mode" },
      projects: { fixture: { optionGuid: "option-fixture", repo: repository } },
      modes: { implement: { optionGuid: "option-implement", sandboxMode: "workspace-write" } },
    }, { checkRepositories: false });
    let runCount = 0;
    const workerRunner: WorkerRunner = {
      start(): WorkerHandle {
        runCount += 1;
        return {
          pid: 9100 + runCount,
          result: Promise.resolve({ status: "succeeded", threadId: `thread-${runCount}`, finalResponse: "done" }),
          terminate: async () => undefined,
        };
      },
    };
    const dispatcher = new Dispatcher({
      db,
      lark: {} as LarkClient,
      config,
      workerRunner,
      larkOutboxEnabled: false,
      worktreeRoot: join(root, "managed-worktrees"),
      logger: { info() {}, warn() {}, error() {} },
    });

    const sessions: TmuxSession[] = [{ id: "$1", name: "source", windows: 1, attachedClients: 0, cwd: repository, createdAt: 1 }];
    const createdDirectories: string[] = [];
    let nextSessionId = 2;
    const tmuxDashboard = new TmuxDashboardApi({
      db,
      operations: {
        listSessions: async () => [...sessions],
        findSession: async (id) => sessions.find((session) => session.id === id),
        createSession: async (name, cwd) => {
          const session = { id: `$${nextSessionId++}`, name, windows: 1, attachedClients: 0, cwd: cwd ?? "", createdAt: nextSessionId };
          sessions.push(session);
          createdDirectories.push(session.cwd);
          return session;
        },
        killSession: async (id) => { const index = sessions.findIndex((session) => session.id === id); if (index >= 0) sessions.splice(index, 1); },
        getCurrentPanePath: async (_id, knownSession) => knownSession.cwd,
      },
      createTaskFromSession: (input, source) => dispatcher.submitWebTask(input, source),
    });
    const server = new DashboardServer({ db, tmuxDashboard: tmuxDashboard, host: "127.0.0.1", port: 0, modes: [] });
    try {
      const baseUrl = await server.start();
      const actionToken = (await (await fetch(`${baseUrl}/api/session`)).json() as { actionToken: string }).actionToken;
      const actionHeaders = { "Content-Type": "application/json", Origin: baseUrl, "X-Bridge-Action-Token": actionToken };
      const workspacesPage = await fetch(`${baseUrl}/system-management/workspaces`);
      expect(workspacesPage.status).toBe(200);
      expect(workspacesPage.headers.get("content-type")).toContain("text/html");

      const contextResponse = await fetch(`${baseUrl}/tmux-dashboard/api/sessions/%241/task-context`);
      expect(contextResponse.status).toBe(200);
      const context = await contextResponse.json() as { directory: string; branch: string; baseSha: string; sourceHeadSha: string; baseRef: string; targetBaseSha: string; dirtyEntryCount: number };
      expect(context.directory).toBe(realpathSync(repository));
      expect(context.baseSha).toBe(git(repository, "rev-parse", "HEAD"));
      expect(context.sourceHeadSha).toBe(context.baseSha);
      expect(context.branch).toBe("xiajian/source-feature");
      expect(context.baseRef).toBe("master");
      expect(context.targetBaseSha).toBe(masterSha);
      expect(context.dirtyEntryCount).toBe(0);

      const changesResponse = await fetch(baseUrl + "/tmux-dashboard/api/sessions/%241/git-changes");
      expect(changesResponse.status).toBe(200);
      const changes = await changesResponse.json() as { sessionId: string; directory: string; files: unknown[]; patch: string };
      expect(changes.sessionId).toBe("$1");
      expect(changes.directory).toBe(realpathSync(repository));
      expect(changes.files).toEqual([]);
      expect(changes.patch).toBe("");

      const unauthenticatedTask = await fetch(`${baseUrl}/tmux-dashboard/api/sessions/%241/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ description: "missing action token", sourceDirectory: context.directory, expectedBaseSha: context.baseSha }),
      });
      expect(unauthenticatedTask.status).toBe(403);

      const staleContext = await fetch(`${baseUrl}/tmux-dashboard/api/sessions/%241/tasks`, {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify({
          description: "Stale source must not be used",
          idempotencyKey: "tmux-task-stale-context",
          sourceDirectory: context.directory,
          expectedBaseSha: "0".repeat(40),
        }),
      });
      expect(staleContext.status).toBe(409);
      expect(db.listTaskWorkspaces()).toHaveLength(0);

      const taskResponse = await fetch(`${baseUrl}/tmux-dashboard/api/sessions/%241/tasks`, {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify({
          description: "Create an isolated task from tmux",
          idempotencyKey: "tmux-task-submit-1",
          sourceDirectory: context.directory,
          expectedBaseSha: context.baseSha,
        }),
      });
      expect(taskResponse.status).toBe(201);
      const submitted = await taskResponse.json() as { task: { task_guid: string }; latest_run: { run_id: string } };
      await dispatcher.waitForIdle();
      const workspace = db.getTaskWorkspace(submitted.task.task_guid)!;
      expect(workspace.source_tmux_session_id).toBe("$1");
      expect(workspace.base_ref).toBe("master");
      expect(workspace.base_sha).toBe(masterSha);
      expect(workspace.branch.startsWith("xiajian/agent/")).toBe(true);
      expect(workspace.worktree_path).toContain("/managed-worktrees/fixture/wt-");
      expect(workspace.status).toBe("retained");
      expect(db.getTask(submitted.task.task_guid)?.repo).toBe(repository);

      writeFileSync(join(repository, "README.md"), "advanced source HEAD\n");
      git(repository, "add", "README.md");
      git(repository, "commit", "-m", "advance source after accepted submission");
      const replay = await fetch(`${baseUrl}/tmux-dashboard/api/sessions/%241/tasks`, {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify({
          description: "Create an isolated task from tmux",
          idempotencyKey: "tmux-task-submit-1",
          sourceDirectory: context.directory,
          expectedBaseSha: context.baseSha,
        }),
      });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { task: { task_guid: string } }).task.task_guid).toBe(submitted.task.task_guid);
      expect(db.listTaskWorkspaces()).toHaveLength(1);

      const openResponse = await fetch(`${baseUrl}/tmux-dashboard/api/workspaces/${workspace.workspace_id}/session`, {
        method: "POST", headers: actionHeaders, body: JSON.stringify({ path: repository }),
      });
      expect(openResponse.status).toBe(201);
      const opened = await openResponse.json() as { session: { id: string; cwd: string; workspaceId: string; taskGuid: string } };
      expect(opened.session.cwd).toBe(workspace.working_directory);
      expect(opened.session.workspaceId).toBe(workspace.workspace_id);
      expect(opened.session.taskGuid).toBe(workspace.task_guid);
      expect(createdDirectories).toContain(workspace.working_directory);

      const inventoryResponse = await fetch(`${baseUrl}/api/task-workspaces`);
      expect(inventoryResponse.status).toBe(200);
      const inventory = await inventoryResponse.json() as {
        workspaces: Array<{ workspace_id: string; active_session_count: number }>;
        unmanaged: Array<{ path: string; branch: string | null; inspection: { dirtyEntryCount: number; mergedIntoBase: boolean | null } }>;
      };
      expect(inventory.workspaces.find((item) => item.workspace_id === workspace.workspace_id)?.active_session_count).toBe(1);
      expect(inventory.unmanaged.find((item) => item.path === realpathSync(unmanagedPath))).toMatchObject({
        branch: "manual/unmanaged",
        inspection: { dirtyEntryCount: 0, mergedIntoBase: true },
      });

      const archiveResponse = await fetch(`${baseUrl}/api/task-workspaces/${workspace.workspace_id}/archive`, {
        method: "POST", headers: actionHeaders, body: JSON.stringify({}),
      });
      expect(archiveResponse.status).toBe(200);
      const archivedTask = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(workspace.task_guid)}`);
      expect(archivedTask.status).toBe(200);
      expect(await archivedTask.json()).toMatchObject({ can_followup: false, workspace: { followups_closed_at: expect.any(String) } });
      const blockedCleanup = await fetch(`${baseUrl}/api/task-workspaces/${workspace.workspace_id}`, {
        method: "DELETE", headers: actionHeaders, body: JSON.stringify({ deleteBranch: true }),
      });
      expect(blockedCleanup.status).toBe(409);
      expect(existsSync(workspace.worktree_path)).toBe(true);

      const endSession = await fetch(`${baseUrl}/tmux-dashboard/api/sessions/${encodeURIComponent(opened.session.id)}`, {
        method: "DELETE", headers: actionHeaders,
      });
      expect(endSession.status).toBe(204);
      const cleanup = await fetch(`${baseUrl}/api/task-workspaces/${workspace.workspace_id}`, {
        method: "DELETE", headers: actionHeaders, body: JSON.stringify({ deleteBranch: true }),
      });
      expect(cleanup.status).toBe(200);
      expect((await cleanup.json() as { branchDeleted: boolean }).branchDeleted).toBe(true);
      expect(existsSync(workspace.worktree_path)).toBe(false);
      expect(db.getTaskWorkspace(workspace.task_guid)?.status).toBe("removed");
    } finally {
      await server.stop();
      await dispatcher.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
