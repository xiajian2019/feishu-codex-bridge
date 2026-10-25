import { afterEach, describe, expect, it } from "bun:test";
import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { WorkbenchService } from "../src/workbench.js";
import type { DashboardActions } from "../src/web.js";
import type { RoutedTask } from "../src/types.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const db = new StateDatabase(":memory:");
  cleanups.push(() => db.close());
  db.createProject({ name: "fixture", path: "/private/tmp" });
  const task: RoutedTask = { taskGuid: "queue-task", projectKey: "fixture", mode: "implement", repo: "/private/tmp",
    summary: "fixture", description: "fixture", inputHash: "fixture", origin: "web", completed: false,
    sandboxMode: "workspace-write", input: { projectKey: "fixture", mode: "implement", summary: "fixture", description: "fixture" } };
  const run = db.claimRun({ task, inputText: JSON.stringify(task.input), promptText: "fixture" })!;
  const target = { kind: "task", source: "desk", id: task.taskGuid } as const;
  const calls: Array<{ text: string; key: string }> = [];
  const actions: DashboardActions = {
    interruptTask: async () => ({ ok: true }), appendFeedback: async () => ({ ok: true, state: "RUNNING" }),
    appendWebFollowup: async (_id, text, key) => { calls.push({ text, key }); return db.getTask(task.taskGuid)!; },
    createTask: async () => db.getTask(task.taskGuid)!,
  };
  const service = new WorkbenchService({ db, actions });
  cleanups.push(() => service.stop());
  const request = (method: string, path: string, body: Record<string, unknown> = {}) => service.request(method, new URL(path, "http://fixture/api/workbench/"), body);
  return { db, run, task, target, calls, service, actions, request };
}

describe("Workbench integration", () => {
  it("uses additive schema on the same database and preserves queued messages until the original task is idle", async () => {
    const f = fixture();
    const response = await f.request("POST", "queue", { target: f.target, text: "next", idempotencyKey: "once" });
    expect(response.status).toBe(201);
    const id = (response.body as { message: { id: string } }).message.id;
    expect((await f.request("POST", "queue", { target: f.target, text: "next", idempotencyKey: "once" })).body).toEqual(response.body);
    await expect(f.request("POST", "queue", { target: f.target, text: "different", idempotencyKey: "once" })).rejects.toThrow(/different/);
    f.service.start();
    await f.service.tick();
    expect(f.calls).toEqual([]);
    expect(f.db.workbench.getQueueMessage(id)?.status).toBe("queued");
    f.db.finishRun(f.run.runId, { status: "succeeded", finalResponse: "done" });
    await Promise.all([f.service.tick(), f.service.tick()]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toEqual({ text: "next", key: `workbench_${id}` });
    expect(f.db.workbench.getQueueMessage(id)?.status).toBe("sent");
    await f.service.tick();
    expect(f.calls).toHaveLength(1);
  });

  it("never retries an uncertain dispatch or changes another source's state machine", async () => {
    const f = fixture();
    f.db.finishRun(f.run.runId, { status: "succeeded", finalResponse: "done" });
    f.actions.appendWebFollowup = async () => { throw new Error("transport closed after acceptance"); };
    const response = await f.request("POST", "queue", { target: f.target, text: "next", idempotencyKey: "once" });
    const id = (response.body as { message: { id: string } }).message.id;
    f.service.start();
    await f.service.tick();
    expect(f.db.workbench.getQueueMessage(id)).toMatchObject({ status: "unconfirmed", error: "transport closed after acceptance" });
    await f.service.tick();
    expect(f.db.getTask(f.target.id)?.state).toBe("WAITING_REVIEW");
    await expect(f.request("POST", "queue", { target: { ...f.target, source: "aamp" }, text: "wrong source", idempotencyKey: "wrong" })).rejects.toThrow();
  });

  it("rejects oversized edits atomically without partially reordering the queue", async () => {
    const f = fixture();
    const first = await f.request("POST", "queue", { target: f.target, text: "first", idempotencyKey: "first-key" });
    const second = await f.request("POST", "queue", { target: f.target, text: "second", idempotencyKey: "second-key" });
    const firstId = (first.body as { message: { id: string } }).message.id;
    const secondId = (second.body as { message: { id: string } }).message.id;
    await expect(f.request("PATCH", `queue/${secondId}`, { move: "up", text: "x".repeat(2_001) })).rejects.toThrow();
    expect(f.db.workbench.listQueueMessages(f.target).map((item) => item.id)).toEqual([firstId, secondId]);
    expect(f.db.workbench.getQueueMessage(secondId)?.text).toBe("second");
  });

  it("delivers through Direct's actual followup path with a compatible idempotency key", async () => {
    const f = fixture();
    const original = f.db.ingestDirectMessage({ sourceEventId: "direct-event", eventType: "im.message.receive_v1",
      messageId: "direct-message", chatId: "direct-chat", chatType: "p2p", senderId: "fixture-user", text: "original", sessionKey: "chat:direct-chat" });
    f.db.claimDueBridgeTask("fixture-worker", 60_000);
    f.db.saveBridgeThreadId(original.task.bridge_task_id, "direct-thread", "fixture-worker");
    f.db.finishBridgeTask(original.task.bridge_task_id, "SUCCEEDED", "done", undefined, "fixture-worker");
    f.actions.appendDirectFollowup = async (id, text, key) => f.db.appendWebDirectFollowup(id, text, key);
    const target = { kind: "task", source: "direct", id: original.task.bridge_task_id } as const;
    const response = await f.request("POST", "queue", { target, text: "direct next", idempotencyKey: "direct-key" });
    const id = (response.body as { message: { id: string } }).message.id;
    f.service.start(); await f.service.tick();
    expect(f.db.workbench.getQueueMessage(id)?.status).toBe("sent");
    expect(f.db.getNextBridgeTaskFollowup(target.id)?.text).toBe("direct next");
    await f.service.tick();
    expect(f.db.readBridgeTaskPage(target.id, 20, 0).followups.total).toBe(1);
  });

  it("records an automation's submission separately, links its original run, and deduplicates manual retries", async () => {
    const f = fixture();
    let creates = 0;
    f.actions.createTask = async () => { creates += 1; return f.db.getTask(f.target.id)!; };
    const created = await f.request("POST", "automations", { projectKey: "fixture", text: "automated check", intervalMinutes: 15, timeZone: "Asia/Shanghai", enabled: false });
    const id = (created.body as { automation: { id: string } }).automation.id;
    const result = await f.request("POST", `automations/${id}/run`, { idempotencyKey: "manual-once" });
    expect(result.body).toMatchObject({ run: { submissionStatus: "accepted", executionStatus: "running", executionId: f.run.runId } });
    await f.request("POST", `automations/${id}/run`, { idempotencyKey: "manual-once" });
    expect(creates).toBe(1);
    f.db.finishRun(f.run.runId, { status: "succeeded", finalResponse: "finished automation" });
    f.service.start(); await f.service.tick();
    expect(f.db.workbench.listAutomationRuns(id)[0]).toMatchObject({ submissionStatus: "accepted", executionStatus: "completed" });
    expect(f.db.getTask(f.target.id)?.state).toBe("WAITING_REVIEW");
  });

  it("keeps an automation not_started while queued and follows only its subsequently linked run", async () => {
    const f = fixture();
    f.db.finishRun(f.run.runId, { status: "succeeded", finalResponse: "earlier run" });
    f.actions.appendWebFollowup = async (_id, text, key) => {
      f.db.claimRun({ task: { ...f.task, description: text, inputHash: key, input: { ...f.task.input, description: text } },
        inputText: JSON.stringify({ ...f.task.input, description: text }), promptText: text });
      return f.db.getTask(f.target.id)!;
    };
    const created = await f.request("POST", "automations", { target: f.target, text: "followup from automation", intervalMinutes: 15, timeZone: "UTC", enabled: false });
    const id = (created.body as { automation: { id: string } }).automation.id;
    await f.request("POST", `automations/${id}/run`, { idempotencyKey: "queue-auto-once" });
    expect(f.db.workbench.listAutomationRuns(id)[0]).toMatchObject({ submissionStatus: "accepted", executionStatus: "not_started" });
    f.service.start(); await f.service.tick();
    const actualRunId = f.db.getTask(f.target.id)!.active_run_id!;
    expect(actualRunId).not.toBe(f.run.runId);
    expect(f.db.workbench.listAutomationRuns(id)[0]).toMatchObject({ executionStatus: "running", executionId: actualRunId });
    f.db.finishRun(actualRunId, { status: "succeeded", finalResponse: "automation result" });
    await f.service.tick();
    expect(f.db.workbench.listAutomationRuns(id)[0]?.executionStatus).toBe("completed");
  });

  it("uses the durable Desk receipt when a worker finishes before create/followup returns", async () => {
    const f = fixture();
    f.db.finishRun(f.run.runId, { status: "succeeded", finalResponse: "original" });
    const acceptAndFail = (task: RoutedTask, key: string) => {
      const claim = f.db.claimWebTaskSubmission({ task, idempotencyKey: key, normalizedRequestJson: JSON.stringify({ key, task: task.taskGuid }),
        inputText: JSON.stringify(task.input), promptText: "fixture" });
      const runId = claim.status === "created" ? claim.claim.runId : claim.submission.run_id;
      f.db.finishRun(runId, { status: "failed", error: "worker could not start" });
      return f.db.getTask(task.taskGuid)!;
    };
    f.actions.createTask = async (input) => acceptAndFail({ ...f.task, taskGuid: "fast-failed-task" }, input.idempotencyKey!);
    f.actions.appendWebFollowup = async (_id, _text, key) => acceptAndFail(f.task, key);
    for (const reference of [{ projectKey: "fixture" }, { target: f.target }]) {
      const created = await f.request("POST", "automations", { ...reference, text: "fast failure", intervalMinutes: 10, timeZone: "UTC", enabled: false });
      const automationId = (created.body as { automation: { id: string } }).automation.id;
      await f.request("POST", `automations/${automationId}/run`, { idempotencyKey: `fast-${automationId}` });
      f.service.start(); await f.service.tick();
      const recorded = f.db.workbench.listAutomationRuns(automationId)[0]!;
      expect(recorded).toMatchObject({ submissionStatus: "accepted", executionStatus: "failed", executionError: "worker could not start" });
      expect(recorded.executionId).toBeTruthy();
      expect(f.db.getRun(recorded.executionId!)?.state).toBe("FAILED");
    }
  });

  it("deduplicates notifications and maps settings without treating unread as execution state", async () => {
    const f = fixture();
    f.db.finishRun(f.run.runId, { status: "failed", error: "fixture error" });
    const change = { kind: "task", taskGuid: f.target.id, at: new Date().toISOString() } as const;
    f.service.onDatabaseChange(change); f.service.onDatabaseChange(change);
    expect(f.db.workbench.listNotifications()).toHaveLength(1);
    expect(f.db.workbench.getPreferences(f.target).unread).toBe(true);
    await f.request("PATCH", "preferences", { target: f.target, patch: { unread: false, keepAttention: true } });
    expect(f.db.getTask(f.target.id)?.state).toBe("FAILED");
    const settings = await f.request("PATCH", "settings", { notifications: { browser: true, failure: false } });
    expect(settings.body).toMatchObject({ settings: { notifications: { browser: true, failure: false } } });
  });

  it("keeps remote machine profiles metadata-only and rejects URLs with embedded credentials", async () => {
    const f = fixture();
    await expect(f.request("POST", "machines", { name: "bad", url: "https://user:password@example.test" })).rejects.toThrow();
    const response = await f.request("POST", "machines", { name: "remote", url: "https://bridge.example.test" });
    expect(response.body).toMatchObject({ machine: { kind: "remote", execution: "metadata-only", status: "unconnected", capabilities: [] } });
    await expect(f.request("DELETE", "machines/local")).rejects.toThrow(/不可移除/);
  });

  it("protects all new HTTP writes with same-origin and an action token, and serves new SPA links", async () => {
    const f = fixture();
    const server = new DashboardServer({ db: f.db, actions: f.actions, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
    cleanups.push(() => server.stop());
    const url = await server.start();
    const { actionToken } = await (await fetch(url + "/api/session")).json() as { actionToken: string };
    for (const path of ["/system-management/automations", "/system-management/machines", "/codex-history/home/thread"]) {
      const page = await fetch(url + path); expect(page.status).toBe(200); expect(await page.text()).toContain('id="root"');
    }
    for (const headers of [{}, { "X-Bridge-Action-Token": actionToken, Origin: "https://outside.example" }]) {
      const response = await fetch(url + "/api/workbench/preferences", { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ target: f.target, patch: { pinned: true } }) });
      expect(response.status).toBe(403);
    }
    const response = await fetch(url + "/api/workbench/preferences", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken, Origin: url }, body: JSON.stringify({ target: f.target, patch: { pinned: true } }) });
    expect(response.status).toBe(200);
    expect(f.db.workbench.getPreferences(f.target).pinned).toBe(true);
  });
});
