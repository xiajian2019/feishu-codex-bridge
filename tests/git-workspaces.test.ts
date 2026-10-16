import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../src/config.js";
import { StateDatabase } from "../src/db.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DatabaseSync } from "../src/sqlite.js";
import {
  inspectTaskWorkspace,
  prepareTaskWorkspace,
  provisionTaskWorkspace,
  removeTaskWorkspaceDirectory,
  verifyTaskWorkspace,
} from "../src/git-workspaces.js";
import { captureGitWorkspaceSnapshot } from "../src/run-artifacts.js";
import type { LarkClient } from "../src/lark.js";
import type { StoredTaskWorkspace, WorkerHandle, WorkerResult, WorkerRunner } from "../src/types.js";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
}

function createRepository(parent: string): string {
  const repository = join(parent, "repo");
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Bridge Test");
  git(repository, "config", "user.email", "bridge-test@example.invalid");
  writeFileSync(join(repository, "README.md"), "base\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  return repository;
}

function storedWorkspace(prepared: Awaited<ReturnType<typeof prepareTaskWorkspace>>, overrides: Partial<StoredTaskWorkspace> = {}): StoredTaskWorkspace {
  const now = new Date().toISOString();
  return {
    workspace_id: prepared.workspaceId,
    task_guid: prepared.taskGuid,
    project_key: prepared.projectKey,
    project_root: prepared.projectRoot,
    project_git_root: prepared.projectGitRoot,
    git_common_directory: prepared.gitCommonDirectory,
    working_directory: prepared.workingDirectory,
    worktree_path: prepared.worktreePath,
    branch: prepared.branch,
    base_ref: prepared.baseRef,
    base_sha: prepared.baseSha,
    source_tmux_session_id: prepared.sourceTmuxSessionId,
    status: "provisioning",
    followups_closed_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    removed_at: null,
    ...overrides,
  };
}

describe("Git task workspaces", () => {
  it("adds workspace links to an existing tmux database without replacing session history", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-workspace-migration-"));
    fixtures.push(root);
    const databasePath = join(root, "bridge.db");
    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec(`CREATE TABLE tmux_sessions (
      record_id TEXT PRIMARY KEY,
      tmux_session_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      project_key TEXT,
      working_directory TEXT NOT NULL,
      tmux_created_at INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ended_at TEXT,
      created_by_device_id TEXT
    )`);
    oldDatabase.prepare(`INSERT INTO tmux_sessions
      (record_id, tmux_session_id, session_name, project_key, working_directory, tmux_created_at,
       first_seen_at, last_seen_at, ended_at, created_by_device_id)
      VALUES ('record-old', '$9', 'old-session', 'fixture', '/tmp/old-session', 9, '2026-01-01', '2026-01-02', NULL, NULL)`).run();
    oldDatabase.close();

    const upgraded = new StateDatabase(databasePath);
    try {
      expect(upgraded.getLatestTmuxSession("$9")).toMatchObject({
        record_id: "record-old",
        session_name: "old-session",
        project_key: "fixture",
        workspace_id: null,
      });
      expect(upgraded.listTaskWorkspaces()).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("creates an isolated worktree, verifies its repository, and keeps the branch by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-task-workspace-"));
    fixtures.push(root);
    const repository = createRepository(root);
    const prepared = await prepareTaskWorkspace({
      workspaceRoot: join(root, "managed-worktrees"),
      workspaceId: "workspace-1",
      taskGuid: "web-0123456789abcdef",
      projectKey: "fixture",
      projectRoot: repository,
      summary: "Add scoped workspace",
    });
    const workspace = storedWorkspace(prepared);

    await provisionTaskWorkspace(workspace);
    await provisionTaskWorkspace(workspace);

    expect(await verifyTaskWorkspace(workspace)).toBe(workspace.worktree_path);
    expect(git(repository, "branch", "--show-current")).toBe("main");
    expect(git(workspace.worktree_path, "branch", "--show-current")).toBe(workspace.branch);
    writeFileSync(join(workspace.working_directory, "isolated.txt"), "only in the task worktree\n");
    expect(existsSync(join(repository, "isolated.txt"))).toBe(false);
    expect((await inspectTaskWorkspace(workspace)).dirtyEntryCount).toBe(1);
    const otherRepository = createRepository(join(root, "other-project"));
    await expect(verifyTaskWorkspace({ ...workspace, project_root: otherRepository })).rejects.toThrow("登记项目的 Git 仓库已变化");

    rmSync(join(workspace.working_directory, "isolated.txt"));
    const result = await removeTaskWorkspaceDirectory({ ...workspace, status: "retained", followups_closed_at: new Date().toISOString() });
    expect(result.branchDeleted).toBe(false);
    expect(existsSync(workspace.worktree_path)).toBe(false);
    expect(git(repository, "show-ref", "--verify", `refs/heads/${workspace.branch}`)).toBe(`${git(repository, "rev-parse", workspace.branch)} refs/heads/${workspace.branch}`);
  });

  it("rejects dirty source directories and redirects an in-repository worktree root outside the repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-task-workspace-source-"));
    fixtures.push(root);
    const repository = createRepository(root);
    writeFileSync(join(repository, "README.md"), "uncommitted\n");
    await expect(prepareTaskWorkspace({
      workspaceRoot: join(root, "outside-worktrees"),
      workspaceId: "workspace-dirty",
      taskGuid: "web-dirty",
      projectKey: "fixture",
      projectRoot: repository,
      summary: "Task from dirty repo",
    })).rejects.toThrow("未提交改动");

    git(repository, "checkout", "--", "README.md");
    const prepared = await prepareTaskWorkspace({
      workspaceRoot: join(repository, "runtime", "worktrees"),
      workspaceId: "workspace-root-fallback",
      taskGuid: "web-root-fallback",
      projectKey: "fixture",
      projectRoot: repository,
      summary: "Fallback root",
    });
    expect(prepared.worktreePath.startsWith(repository + "/")).toBe(false);
    expect(existsSync(join(repository, "runtime"))).toBe(false);
  });

  it("refuses forced branch deletion when the worktree is dirty or commits are unmerged", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-task-workspace-cleanup-"));
    fixtures.push(root);
    const repository = createRepository(root);
    const prepared = await prepareTaskWorkspace({
      workspaceRoot: join(root, "worktrees"),
      workspaceId: "workspace-cleanup",
      taskGuid: "web-cleanup-123456",
      projectKey: "fixture",
      projectRoot: repository,
      summary: "Preserve branch",
    });
    const workspace = storedWorkspace(prepared, { status: "retained" });
    await provisionTaskWorkspace(workspace);
    writeFileSync(join(workspace.worktree_path, "new.txt"), "uncommitted\n");
    const archivedWorkspace = { ...workspace, followups_closed_at: new Date().toISOString() };
    await expect(removeTaskWorkspaceDirectory(archivedWorkspace, { deleteBranch: true })).rejects.toThrow("未提交改动");
    rmSync(join(workspace.worktree_path, "new.txt"));
    writeFileSync(join(workspace.worktree_path, "new.txt"), "committed\n");
    git(workspace.worktree_path, "add", "new.txt");
    git(workspace.worktree_path, "commit", "-m", "unmerged task commit");
    await expect(removeTaskWorkspaceDirectory(archivedWorkspace, { deleteBranch: true })).rejects.toThrow("尚未确认合并");
    expect(existsSync(workspace.worktree_path)).toBe(true);
  });

  it("keeps a Task Desk workspace stable across completion and follow-up runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-task-workspace-dispatcher-"));
    fixtures.push(root);
    const repository = createRepository(root);
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
    const starts: string[] = [];
    const runner: WorkerRunner = {
      start(runId): WorkerHandle {
        starts.push(runId);
        const result: WorkerResult = starts.length === 1
          ? { status: "failed", error: "retry fixture" }
          : { status: "succeeded", threadId: `thread-${starts.length}`, finalResponse: "完成" };
        return { pid: 8000 + starts.length, result: Promise.resolve(result), terminate: async () => undefined };
      },
    };
    const snapshotDirectories: string[] = [];
    const dispatcher = new Dispatcher({
      db,
      lark: {} as LarkClient,
      config,
      workerRunner: runner,
      larkOutboxEnabled: false,
      worktreeRoot: join(root, "managed-worktrees"),
      captureWorkspaceSnapshot: async (directory) => {
        snapshotDirectories.push(directory);
        return captureGitWorkspaceSnapshot(directory);
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    try {
      const request = {
        idempotencyKey: "create-isolated-task",
        projectKey: "fixture",
        summary: "Isolated task",
        description: "Run in an isolated workspace",
        createWorktree: true,
      };
      const [task, replay] = await Promise.all([dispatcher.submitWebTask(request), dispatcher.submitWebTask(request)]);
      expect(replay.task_guid).toBe(task.task_guid);
      expect(db.listTaskWorkspaces()).toHaveLength(1);
      await dispatcher.waitForIdle();
      expect(db.getTask(task.task_guid)?.state).toBe("FAILED");
      await dispatcher.retryWebTask(task.task_guid, "retry-isolated-task");
      await dispatcher.waitForIdle();
      const firstWorkspace = db.getTaskWorkspace(task.task_guid)!;
      expect(firstWorkspace.status).toBe("retained");
      expect(starts).toHaveLength(2);
      const session = db.recordTmuxSession({ id: "$81", name: "task-test", cwd: firstWorkspace.working_directory, createdAt: 81 }, {
        projectKey: "fixture",
        workspaceId: firstWorkspace.workspace_id,
      });
      expect(db.listTmuxSessionsForWorkspace(firstWorkspace.workspace_id).map((item) => item.record_id)).toContain(session.record_id);
      db.markTmuxSessionEnded(session.tmux_session_id);

      await dispatcher.appendWebTaskFollowup(task.task_guid, "Keep the same base workspace", "followup-isolated-task");
      await dispatcher.waitForIdle();
      const secondWorkspace = db.getTaskWorkspace(task.task_guid)!;
      expect(secondWorkspace.workspace_id).toBe(firstWorkspace.workspace_id);
      expect(secondWorkspace.worktree_path).toBe(firstWorkspace.worktree_path);
      expect(secondWorkspace.branch).toBe(firstWorkspace.branch);
      expect(starts).toHaveLength(3);
      expect(db.listRunsForTask(task.task_guid)).toHaveLength(3);
      expect(snapshotDirectories.length).toBe(6);
      expect(snapshotDirectories.every((directory) => directory === firstWorkspace.working_directory)).toBe(true);
      const archived = db.archiveTaskWorkspace(firstWorkspace.workspace_id)!;
      expect(archived.followups_closed_at).not.toBeNull();
      await expect(dispatcher.appendWebTaskFollowup(task.task_guid, "should be rejected", "after-archive")).rejects.toThrow("已归档或移除");
      const removed = await removeTaskWorkspaceDirectory(archived);
      expect(removed.branchDeleted).toBe(false);
      expect(db.markTaskWorkspaceRemoved(firstWorkspace.workspace_id)?.status).toBe("removed");
    } finally {
      await dispatcher.shutdown();
      db.close();
    }
  });
});
