import { describe, expect, it } from "bun:test";

import { parseConfig } from "../src/config.js";
import { StateDatabase } from "../src/db.js";
import { Dispatcher } from "../src/dispatcher.js";
import type { DispatcherOptions } from "../src/dispatcher.js";
import type { LarkClient } from "../src/lark.js";
import type { GitWorkspaceSnapshot } from "../src/run-artifacts.js";
import type {
  BridgeConfig,
  LarkTask,
  WorkerHandle,
  WorkerResult,
  WorkerRunner,
} from "../src/types.js";

const config = (): BridgeConfig =>
  parseConfig(
    {
      pollIntervalSeconds: 20,
      maxConcurrency: 1,
      runTimeoutSeconds: 30,
      aamp: { enabled: false, stopOnShutdown: false },
      lark: {
        profile: "work",
        tasklistGuid: "tasklist-1",
        projectFieldGuid: "field-project",
        modeFieldGuid: "field-mode",
      },
      codex: {
        cliPath: "/opt/homebrew/bin/codex",
        env: {
          HTTP_PROXY: "http://127.0.0.1:7897",
          HTTPS_PROXY: "http://127.0.0.1:7897",
        },
      },
      projects: {
        food: { optionGuid: "option-food", repo: "/tmp/food" },
      },
      modes: {
        implement: { optionGuid: "option-implement", sandboxMode: "workspace-write" },
      },
    },
    { checkRepositories: false },
  );

function task(overrides: Partial<LarkTask> = {}): LarkTask {
  return {
    guid: "task-1",
    summary: "修复订单导出",
    description: "增加回归测试",
    status: "todo",
    tasklists: [{ tasklist_guid: "tasklist-1" }],
    custom_fields: [
      { guid: "field-project", single_select_value: "option-food" },
      { guid: "field-mode", single_select_value: "option-implement" },
    ],
    ...overrides,
  };
}

class FakeLark implements LarkClient {
  readonly comments: string[] = [];
  readonly descriptions: string[] = [];
  readonly reopened: string[] = [];
  private current = task();

  setCurrent(next: LarkTask): void {
    this.current = next;
  }

  async listIncompleteTasks() {
    return [];
  }

  async getTask() {
    return this.current;
  }

  async addComment(_taskGuid: string, content: string) {
    this.comments.push(content);
  }

  async updateDescription(_taskGuid: string, description: string) {
    this.descriptions.push(description);
    this.current = task({ description });
  }

  async reopenTask(taskGuid: string) {
    this.reopened.push(taskGuid);
    this.current = task({ status: "todo", completed_at: "0" });
  }
}

class FakeRunner implements WorkerRunner {
  readonly starts: string[] = [];
  private readonly pending = new Map<string, (result: WorkerResult) => void>();

  start(runId: string): WorkerHandle {
    this.starts.push(runId);
    let resolveResult!: (result: WorkerResult) => void;
    const result = new Promise<WorkerResult>((resolve) => {
      resolveResult = resolve;
    });
    this.pending.set(runId, resolveResult);
    return {
      pid: 1000 + this.starts.length,
      result,
      terminate: async () => {
        resolveResult({ status: "canceled", error: "terminated", errorKind: "canceled" });
      },
    };
  }

  finish(runId: string, result: WorkerResult): void {
    const resolveResult = this.pending.get(runId);
    if (!resolveResult) throw new Error(`unknown fake run ${runId}`);
    this.pending.delete(runId);
    resolveResult(result);
  }
}

function createHarness(options: Pick<DispatcherOptions, "captureWorkspaceSnapshot"> = {}) {
  const db = new StateDatabase(":memory:");
  db.createProject({ name: "food", path: process.cwd() });
  const lark = new FakeLark();
  const runner = new FakeRunner();
  const dispatcher = new Dispatcher({
    db,
    lark,
    config: config(),
    workerRunner: runner,
    serviceInstanceId: "test-service",
    logger: { info() {}, warn() {}, error() {} },
    ...(options.captureWorkspaceSnapshot ? { captureWorkspaceSnapshot: options.captureWorkspaceSnapshot } : {}),
  });
  return { db, lark, runner, dispatcher };
}

describe("Dispatcher", () => {
  it("claims one run, persists the result, and does not rerun unchanged input", async () => {
    const { db, runner, dispatcher } = createHarness();
    await dispatcher.observe(task());
    expect(runner.starts).toHaveLength(1);
    const firstRun = runner.starts[0];
    expect(db.getTask("task-1")?.state).toBe("RUNNING");

    runner.finish(firstRun, {
      status: "succeeded",
      finalResponse: "已修复并通过测试",
      threadId: "thread-1",
    });
    await dispatcher.waitForIdle();
    expect(db.getTask("task-1")?.state).toBe("WAITING_REVIEW");
    expect(db.getTask("task-1")?.thread_id).toBe("thread-1");

    await dispatcher.observe(task());
    expect(runner.starts).toHaveLength(1);
    db.close();
  });

  it("creates a web task on the existing Codex SDK path without Feishu outbox comments", async () => {
    const { db, lark, runner, dispatcher } = createHarness();
    const taskRecord = await dispatcher.submitWebTask({
      summary: "从看板提交的任务",
      description: "走现有 Codex SDK worker",
      projectKey: "food",
      mode: "implement",
    });
    const runId = runner.starts[0];
    expect(taskRecord).toMatchObject({
      origin: "web",
      state: "RUNNING",
      project_key: "food",
      mode: "implement",
    });
    expect(db.getRun(runId)).toMatchObject({ execution_backend: "codex-sdk", tmux_session_id: null });
    expect(db.listOutboxForTask(taskRecord.task_guid)).toHaveLength(0);

    runner.finish(runId, { status: "succeeded", finalResponse: "task done" });
    await dispatcher.waitForIdle();
    expect(db.getTask(taskRecord.task_guid)?.state).toBe("WAITING_REVIEW");
    expect(lark.comments).toHaveLength(0);
    db.close();
  });

  it("records before and after Git workspace snapshots for a Web run", async () => {
    const snapshots: GitWorkspaceSnapshot[] = [];
    const { db, runner, dispatcher } = createHarness({
      captureWorkspaceSnapshot: async (directory) => {
        expect(directory).toBe(process.cwd());
        const snapshot: GitWorkspaceSnapshot = {
          capturedAt: new Date(Date.UTC(2026, 9, 5, 0, 0, snapshots.length)).toISOString(),
          isGitRepository: true,
          headCommit: "a".repeat(40),
          dirtyPaths: snapshots.length === 0 ? ["before.ts"] : ["after.ts"],
          untrackedPaths: [],
          truncated: false,
          taskAttribution: "unattributed-shared-workspace",
          attributionNote: "This is a shared-workspace snapshot; changed paths cannot be attributed to one task.",
        };
        snapshots.push(snapshot);
        return snapshot;
      },
    });

    const taskRecord = await dispatcher.submitWebTask({
      summary: "检查工作区产物基线",
      description: "保存执行前后 Git 状态",
      projectKey: "food",
      mode: "implement",
    });
    const runId = runner.starts[0];
    expect(snapshots).toHaveLength(1);
    expect(db.listRunWorkspaceSnapshots(taskRecord.task_guid)).toMatchObject([
      { run_id: runId, stage: "before", snapshot: { capturedAt: snapshots[0]?.capturedAt, dirtyPaths: ["before.ts"] } },
    ]);

    runner.finish(runId, { status: "succeeded", finalResponse: "完成" });
    await dispatcher.waitForIdle();

    expect(snapshots).toHaveLength(2);
    expect(db.listRunWorkspaceSnapshots(taskRecord.task_guid)).toMatchObject([
      { run_id: runId, stage: "after", snapshot: { capturedAt: snapshots[1]?.capturedAt, dirtyPaths: ["after.ts"] } },
      { run_id: runId, stage: "before", snapshot: { capturedAt: snapshots[0]?.capturedAt, dirtyPaths: ["before.ts"] } },
    ]);
    expect(db.listRunWorkspaceSnapshots(taskRecord.task_guid).every((item) => item.snapshot.taskAttribution === "unattributed-shared-workspace")).toBe(true);
    expect(db.getTask(taskRecord.task_guid)?.state).toBe("WAITING_REVIEW");
    db.close();
  });

  it("continues Web task execution when workspace snapshot capture fails", async () => {
    const { db, runner, dispatcher } = createHarness({
      captureWorkspaceSnapshot: async () => { throw new Error("git metadata unavailable"); },
    });

    const taskRecord = await dispatcher.submitWebTask({
      summary: "继续执行",
      description: "快照采集失败时仍启动 worker",
      projectKey: "food",
      mode: "implement",
    });
    expect(runner.starts).toHaveLength(1);
    expect(db.getTask(taskRecord.task_guid)?.state).toBe("RUNNING");

    runner.finish(runner.starts[0]!, { status: "succeeded", finalResponse: "仍然完成" });
    await dispatcher.waitForIdle();

    expect(db.getTask(taskRecord.task_guid)?.state).toBe("WAITING_REVIEW");
    expect(db.listRunWorkspaceSnapshots(taskRecord.task_guid)).toHaveLength(0);
    db.close();
  });

  it("resumes the same thread when the description is appended", async () => {
    const { db, runner, dispatcher } = createHarness();
    await dispatcher.observe(task());
    const firstRun = runner.starts[0];
    runner.finish(firstRun, { status: "succeeded", finalResponse: "done" });
    // A real worker reports this through thread.started; simulate that event.
    db.saveThreadId(firstRun, "thread-1");
    await dispatcher.waitForIdle();

    await dispatcher.observe(task({ description: "增加回归测试\n重试：1" }));
    expect(runner.starts).toHaveLength(2);
    const resumed = db.getRun(runner.starts[1]);
    expect(resumed?.thread_id).toBe("thread-1");
    expect(resumed?.prompt_text).toContain("重试：1");
    db.close();
  });

  it("blocks invalid configuration without starting a worker", async () => {
    const { db, lark, runner, dispatcher } = createHarness();
    await dispatcher.observe(task({ custom_fields: [] }));
    expect(runner.starts).toHaveLength(0);
    expect(db.getTask("task-1")?.state).toBe("BLOCKED_CONFIG");
    await dispatcher.flushOutbox();
    expect(lark.comments[0]).toContain("配置错误");
    db.close();
  });

  it("cancels a running run when the Feishu task is completed", async () => {
    const { db, runner, dispatcher } = createHarness();
    await dispatcher.observe(task());
    const runId = runner.starts[0];
    await dispatcher.observe(task({ status: "done", completed_at: "123" }));
    expect(db.getTask("task-1")?.state).toBe("CANCELED");
    expect(db.getRun(runId)?.state).toBe("CANCELED");
    db.close();
  });

  it("interrupts a running run and leaves a cancellation comment", async () => {
    const { db, lark, runner, dispatcher } = createHarness();
    await dispatcher.observe(task());
    const runId = runner.starts[0];
    expect(await dispatcher.interruptTask("task-1")).toBe(true);
    await dispatcher.waitForIdle();
    expect(db.getTask("task-1")?.state).toBe("CANCELED");
    expect(db.getRun(runId)?.state).toBe("CANCELED");
    await dispatcher.flushOutbox();
    expect(lark.comments.some((comment) => comment.includes("执行已取消"))).toBe(true);
    db.close();
  });

  it("appends feedback to Feishu and queues another turn for a processed task", async () => {
    const { db, lark, runner, dispatcher } = createHarness();
    await dispatcher.observe(task());
    const firstRun = runner.starts[0];
    runner.finish(firstRun, { status: "succeeded", finalResponse: "done" });
    db.saveThreadId(firstRun, "thread-1");
    await dispatcher.waitForIdle();

    lark.setCurrent(task({ status: "done", completed_at: "123" }));
    const updated = await dispatcher.appendFeedback("task-1", "请补充说明发现的重复定义。");
    expect(lark.descriptions[0]).toContain("补充反馈（Bridge 看板）");
    expect(lark.reopened).toEqual(["task-1"]);
    expect(updated.state).toBe("RUNNING");
    expect(runner.starts).toHaveLength(2);
    expect(db.getRun(runner.starts[1])?.thread_id).toBe("thread-1");
    db.close();
  });
});
