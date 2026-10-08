import { describe, expect, it } from "bun:test";
import type { IncomingMessage } from "node:http";

import { parseConfig } from "../src/config.js";
import { StateDatabase } from "../src/db.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";
import type { LarkClient } from "../src/lark.js";
import type { BridgeConfig, WorkerHandle, WorkerResult, WorkerRunner } from "../src/types.js";

function createConfig(): BridgeConfig {
  return parseConfig({
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
    codex: { cliPath: "/usr/bin/codex", env: {} },
    projects: { food: { optionGuid: "option-food", repo: "/tmp/food" } },
    modes: { implement: { optionGuid: "option-implement", sandboxMode: "workspace-write" } },
  }, { checkRepositories: false });
}

class ControlledRunner implements WorkerRunner {
  readonly starts: string[] = [];
  private readonly pending = new Map<string, (result: WorkerResult) => void>();

  start(runId: string): WorkerHandle {
    this.starts.push(runId);
    let resolveResult!: (result: WorkerResult) => void;
    const result = new Promise<WorkerResult>((resolve) => { resolveResult = resolve; });
    this.pending.set(runId, resolveResult);
    return {
      pid: 1000 + this.starts.length,
      result,
      terminate: async () => {
        this.pending.delete(runId);
        resolveResult({ status: "canceled", error: "terminated", errorKind: "canceled" });
      },
    };
  }

  finish(runId: string, result: WorkerResult): void {
    const resolveResult = this.pending.get(runId);
    if (!resolveResult) throw new Error(`unknown run ${runId}`);
    this.pending.delete(runId);
    resolveResult(result);
  }
}

function createHarness() {
  const db = new StateDatabase(":memory:");
  db.createProject({ name: "food", path: process.cwd() });
  const runner = new ControlledRunner();
  const dispatcher = new Dispatcher({
    db,
    lark: {} as LarkClient,
    config: createConfig(),
    workerRunner: runner,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { db, runner, dispatcher };
}

async function submitTask(dispatcher: Dispatcher) {
  return dispatcher.submitWebTask({
    idempotencyKey: "submit-task-1",
    projectKey: "food",
    mode: "implement",
    summary: "修复订单导出",
    description: "保留导出列顺序并补上异常处理。",
  });
}

describe("Dispatcher Web task retry", () => {
  it("retries a failed task once per key, keeps the failed run, and resumes its thread", async () => {
    const { db, runner, dispatcher } = createHarness();
    const task = await submitTask(dispatcher);
    const firstRunId = runner.starts[0]!;
    db.saveThreadId(firstRunId, "thread-retry-1");
    runner.finish(firstRunId, { status: "failed", error: "first attempt failed" });
    await dispatcher.waitForIdle();
    expect(db.getTask(task.task_guid)?.state).toBe("FAILED");

    const retry = await dispatcher.retryWebTask(task.task_guid, "retry-key-1");
    const retryRunId = runner.starts[1]!;
    expect(retry.state).toBe("RUNNING");
    expect(retryRunId).not.toBe(firstRunId);
    expect(db.getRun(firstRunId)).toMatchObject({ state: "FAILED", thread_id: "thread-retry-1" });
    expect(db.getRun(retryRunId)).toMatchObject({
      state: "RUNNING",
      thread_id: "thread-retry-1",
      previous_input_text: db.getRun(firstRunId)?.input_text,
    });
    expect(db.getRun(retryRunId)?.prompt_text).toContain("明确请求重试");

    await dispatcher.retryWebTask(task.task_guid, "retry-key-1");
    expect(runner.starts).toHaveLength(2);

    runner.finish(retryRunId, { status: "failed", error: "second attempt failed" });
    await dispatcher.waitForIdle();
    expect(db.getTask(task.task_guid)?.state).toBe("FAILED");
    await dispatcher.retryWebTask(task.task_guid, "retry-key-1");
    expect(runner.starts).toHaveLength(2);
    await dispatcher.retryWebTask(task.task_guid, "retry-key-2");
    const thirdRunId = runner.starts[2]!;
    expect(thirdRunId).not.toBe(retryRunId);
    runner.finish(thirdRunId, { status: "failed", error: "third attempt failed" });
    await dispatcher.waitForIdle();
    const runs = db.listRunsForTask(task.task_guid);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.run_id)).toContain(firstRunId);
    expect(runs.map((run) => run.run_id)).toContain(retryRunId);
    expect(runs.map((run) => run.run_id)).toContain(thirdRunId);
    db.close();
  });

  it("retries a canceled task and rejects tasks that are not failed or canceled", async () => {
    const { db, runner, dispatcher } = createHarness();
    const task = await submitTask(dispatcher);
    const firstRunId = runner.starts[0]!;
    db.saveThreadId(firstRunId, "thread-retry-canceled");
    expect(await dispatcher.interruptTask(task.task_guid)).toBe(true);
    await dispatcher.waitForIdle();
    expect(db.getRun(firstRunId)?.state).toBe("CANCELED");

    const retry = await dispatcher.retryWebTask(task.task_guid, "retry-canceled-key");
    expect(retry.state).toBe("RUNNING");
    expect(runner.starts).toHaveLength(2);
    expect(db.getRun(runner.starts[1]!)?.thread_id).toBe("thread-retry-canceled");
    await expect(dispatcher.retryWebTask(task.task_guid, "another-key")).rejects.toThrow("失败或已取消");
    await dispatcher.shutdown();
    db.close();
  });

  it("exposes an authenticated, idempotent Web retry action", async () => {
    const { db, runner, dispatcher } = createHarness();
    const task = await submitTask(dispatcher);
    runner.finish(runner.starts[0]!, { status: "failed", error: "retry me" });
    await dispatcher.waitForIdle();
    const auth = new WebPairingAuth({ db });
    const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [], actions: {
      retryWebTask: (taskGuid, idempotencyKey) => dispatcher.retryWebTask(taskGuid, idempotencyKey),
      interruptTask: async () => ({ ok: false }), appendFeedback: async () => ({ ok: false, state: "FAILED" }),
    } });
    try {
      const url = await server.start();
      const endpoint = `${url}/api/tasks/${task.task_guid}/retry`;
      expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
      const pairing = auth.startPairing();
      const request = { headers: { "user-agent": "fixture" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
      const session = auth.claimPairing(request, pairing.code);
      const headers = { Cookie: `bridge_session=${session}` };
      expect((await fetch(endpoint, { method: "POST", headers })).status).toBe(403);
      const actionToken = (await (await fetch(`${url}/api/session`, { headers })).json() as { actionToken: string }).actionToken;
      const submit = () => fetch(endpoint, {
        method: "POST", headers: { ...headers, Origin: url, "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken },
        body: JSON.stringify({ idempotencyKey: "web-retry-http-key" }),
      });
      expect((await submit()).status).toBe(200);
      expect((await submit()).status).toBe(200);
      expect(runner.starts).toHaveLength(2);
      expect(db.listRunsForTask(task.task_guid)).toHaveLength(2);
    } finally {
      await server.stop();
      await dispatcher.shutdown();
      db.close();
    }
  });
});
