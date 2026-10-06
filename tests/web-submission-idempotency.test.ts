import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { parseConfig } from "../src/config.js";
import { StateDatabase } from "../src/db.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DatabaseSync } from "../src/sqlite.js";
import type { LarkClient } from "../src/lark.js";
import { WebTaskSubmissionConflictError, type WorkerResult, type WorkerRunner } from "../src/types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(maxConcurrency = 1, now?: () => Date) {
  const root = mkdtempSync(join(tmpdir(), "bridge-submit-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "bridge.db");
  const db = new StateDatabase(path, now);
  cleanup.push(() => db.close());
  db.createProject({ name: "fixture", path: root });
  const config = parseConfig({
    maxConcurrency, runTimeoutSeconds: 30, codex: { cliPath: "/unused-fixture-codex" },
    lark: { profile: "fixture", tasklistGuid: "list", projectFieldGuid: "project", modeFieldGuid: "mode" },
    projects: { fixture: { optionGuid: "option-fixture", repo: root } }, modes: { implement: { optionGuid: "option-implement", sandboxMode: "workspace-write" } },
  }, { checkRepositories: false });
  const starts: string[] = [];
  const runner: WorkerRunner = { start(runId) {
    starts.push(runId);
    let finish!: (result: WorkerResult) => void;
    return { pid: 9000 + starts.length, result: new Promise<WorkerResult>((resolve) => { finish = resolve; }),
      terminate: async () => { finish({ status: "canceled" }); } };
  } };
  const makeDispatcher = (database: StateDatabase) => {
    const dispatcher = new Dispatcher({ db: database, config, workerRunner: runner, lark: {} as LarkClient,
      larkOutboxEnabled: false, logger: { info() {}, warn() {}, error() {} } });
    cleanup.push(() => dispatcher.shutdown());
    return dispatcher;
  };
  return { root, path, db, starts, makeDispatcher, dispatcher: makeDispatcher(db) };
}
const input = { idempotencyKey: "same-operation", description: "测试任务", projectKey: "fixture" };

describe("Web submission idempotency", () => {
  it("adds the submission table to an existing database without replacing its tasks", async () => {
    const { db, path, dispatcher } = fixture();
    const task = await dispatcher.submitWebTask(input);
    await dispatcher.shutdown();
    db.close();
    const oldDatabase = new DatabaseSync(path);
    oldDatabase.exec("DROP TABLE web_task_submissions");
    oldDatabase.close();
    const upgraded = new StateDatabase(path);
    cleanup.push(() => upgraded.close());
    expect(upgraded.getTask(task.task_guid)?.input_text).toBe(task.input_text);
    expect(upgraded.listRunsForTask(task.task_guid)).toHaveLength(1);
    expect(upgraded.getWebTaskSubmission("unused")).toBeNull();
  });

  it("replays concurrent requests with a bound attachment and rejects a changed payload", async () => {
    const { db, dispatcher, starts } = fixture();
    db.createStagedWebTaskAttachment({ attachmentId: "image", fileName: "image.png", mimeType: "image/png", sizeBytes: 1, localPath: "/unused-fixture.png" });
    const request = { ...input, attachmentIds: ["image"] };
    const results = await Promise.all(Array.from({ length: 5 }, () => dispatcher.submitWebTask(request)));
    expect(new Set(results.map((task) => task.task_guid)).size).toBe(1);
    expect(db.listTrackedTasks()).toHaveLength(1);
    expect(db.listRunsForTask(results[0]!.task_guid)).toHaveLength(1);
    expect(db.listWebTaskAttachments(results[0]!.task_guid)).toHaveLength(1);
    expect(starts).toHaveLength(1);
    await expect(dispatcher.submitWebTask({ ...request, description: "different" })).rejects.toBeInstanceOf(WebTaskSubmissionConflictError);
    // A replay is still valid after configuration/project availability changes.
    db.updateProject("fixture", { status: "disabled" });
    expect((await dispatcher.submitWebTask(request)).task_guid).toBe(results[0]!.task_guid);
    expect(starts).toHaveLength(1);
  });

  it("rolls back task, run, and attachment binding when saving the receipt fails", async () => {
    const { db, path, dispatcher, starts } = fixture();
    db.createStagedWebTaskAttachment({ attachmentId: "file", fileName: "file.txt", mimeType: "text/plain", sizeBytes: 1, localPath: "/unused-fixture.txt" });
    const sql = new DatabaseSync(path);
    sql.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON web_task_submissions BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    try {
      await expect(dispatcher.submitWebTask({ ...input, attachmentIds: ["file"] })).rejects.toThrow("injected receipt failure");
      expect(db.listTrackedTasks()).toEqual([]);
      expect(sql.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
      expect(db.getStagedWebTaskAttachment("file")).not.toBeNull();
      expect(db.getWebTaskSubmission(input.idempotencyKey)).toBeNull();
      expect(starts).toEqual([]);
      sql.exec("DROP TRIGGER reject_receipt");
      await dispatcher.submitWebTask({ ...input, attachmentIds: ["file"] });
      expect(starts).toHaveLength(1);
    } finally { sql.close(); }
  });

  it("recovers a durably acknowledged QUEUED request after restart and replays without rerunning it", async () => {
    const { db, path, dispatcher, makeDispatcher, starts } = fixture();
    await dispatcher.submitWebTask({ ...input, idempotencyKey: "blocking-run" });
    const queued = await dispatcher.submitWebTask(input);
    expect(queued.state).toBe("QUEUED");
    expect(starts).toHaveLength(1);
    await dispatcher.shutdown();
    db.close();
    const reopened = new StateDatabase(path);
    cleanup.push(() => reopened.close());
    const resumed = makeDispatcher(reopened);
    resumed.recoverInterruptedRuns();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBe(queued.active_run_id!);
    const replay = await resumed.submitWebTask(input);
    expect(replay.task_guid).toBe(queued.task_guid);
    expect(reopened.listRunsForTask(queued.task_guid)).toHaveLength(1);
    expect(starts).toHaveLength(2);
    await resumed.shutdown();
    const terminalReplay = await resumed.submitWebTask(input);
    expect(terminalReplay.state).toBe("CANCELED");
    expect(starts).toHaveLength(2);
  });
});

describe("Phase one HTTP contracts", () => {
  it("expires old Web staged files on startup while preserving bound files and unknown orphans", async () => {
    const { db, root, dispatcher } = fixture(1, () => new Date("2020-01-01T00:00:00Z"));
    for (const id of ["expired", "bound"]) {
      writeFileSync(join(root, `${id}.txt`), id);
      db.createStagedWebTaskAttachment({ attachmentId: id, fileName: `${id}.txt`, mimeType: "text/plain",
        sizeBytes: id.length, localPath: join(root, `${id}.txt`) });
    }
    writeFileSync(join(root, "unknown.txt"), "unknown");
    await dispatcher.submitWebTask({ ...input, attachmentIds: ["bound"] });
    const server = new DashboardServer({ db, host: "127.0.0.1", port: 0, modes: [], taskAttachmentsDirectory: root });
    cleanup.push(() => server.stop());
    await server.start();
    expect(existsSync(join(root, "expired.txt"))).toBe(false);
    expect(db.getStagedWebTaskAttachment("expired")).toBeNull();
    expect(existsSync(join(root, "bound.txt"))).toBe(true);
    expect(existsSync(join(root, "unknown.txt"))).toBe(true);
  });

  it("passes persistent request keys through the API and returns 409 for conflicting content", async () => {
    const { db, dispatcher, starts } = fixture();
    const server = new DashboardServer({ db, host: "127.0.0.1", port: 0, modes: ["implement"],
      actions: { createTask: (request) => dispatcher.submitWebTask(request) } });
    cleanup.push(() => server.stop());
    const url = await server.start();
    const { actionToken } = await (await fetch(`${url}/api/session`)).json() as { actionToken: string };
    const submit = (body: object, authorized = true) => fetch(`${url}/api/tasks`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: url, ...(authorized ? { "X-Bridge-Action-Token": actionToken } : {}) },
      body: JSON.stringify(body) });
    expect((await submit(input, false)).status).toBe(403);
    expect((await submit({ ...input, idempotencyKey: 1 })).status).toBe(400);
    const first = await submit(input);
    expect(first.status).toBe(201);
    const replay = await submit(input);
    expect(replay.status).toBe(201);
    expect((await replay.json() as any).task.task_guid).toBe((await first.json() as any).task.task_guid);
    expect((await submit({ ...input, description: "changed" })).status).toBe(409);
    expect(starts).toHaveLength(1);
  });

  it("lists Web, Direct, and AAMP tasks with source filters, read-only detail, and deep links", async () => {
    const { db, dispatcher } = fixture();
    const webTask = await dispatcher.submitWebTask(input);
    db.finishRun(webTask.active_run_id!, { status: "failed", error: "desk failure" });
    db.initializeAampTask({ aampTaskId: "aamp-only", chatId: "private-chat-id", userText: "aamp-only-needle",
      imageLocalPaths: ["/private/aamp-photo.png"], lastDeltaText: "AAMP progress text",
      sessionSnapshot: { credential: "private-aamp-snapshot" }, relayStatus: { token: "private-relay-token" },
      event: { secret: "private-aamp-event" } });
    db.initializeAampTask({ aampTaskId: "aamp-failed", chatId: "fixture", userText: "failed AAMP task", status: "failed" });
    const message = { sourceEventId: "event-direct", eventType: "im.message.receive_v1", messageId: "direct-msg",
      chatId: "fixture", chatType: "p2p" as const, senderId: "sender", text: "direct-only-needle", sessionKey: "fixture:direct",
      payload: { credential: "must-not-be-exposed" }, attachments: [{ type: "file" as const, fileKey: "private-file-key", fileName: "fixture.txt" }] };
    const direct = db.ingestDirectMessage(message).task;
    db.markBridgeCardDeliveryFailed(direct.bridge_task_id, "Direct card delivery failure");
    db.ingestDirectMessage({ ...message, sourceEventId: "event-other", messageId: "other-msg", sessionKey: "fixture:other", text: "other", attachments: [] });
    const continuation = db.ingestDirectMessage({ ...message, sourceEventId: "event-follow", messageId: "follow-msg",
      replyToMessageId: "direct-msg", text: "follow up", attachments: [] });
    expect(continuation.continued).toBe(true);
    const auth = new WebPairingAuth({ db });
    const pairing = auth.startPairing();
    const request = { headers: { "user-agent": "fixture" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
    const token = auth.claimPairing(request, pairing.code);
    const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [] });
    cleanup.push(() => server.stop());
    const url = await server.start();
    const headers = { Cookie: `bridge_session=${token}` };
    expect((await fetch(`${url}/api/task-panel`, { headers: {} })).status).toBe(401);
    const panel = await (await fetch(`${url}/api/task-panel?limit=3`, { headers })).json() as any;
    expect(panel.total).toBe(5);
    expect(panel.items).toHaveLength(3);
    const nextPanel = await (await fetch(`${url}/api/task-panel?limit=3&offset=3`, { headers })).json() as any;
    expect(nextPanel.items).toHaveLength(2);
    expect([...panel.items, ...nextPanel.items].map((item: any) => item.source).sort()).toEqual(["aamp", "aamp", "desk", "direct", "direct"]);
    const directPanel = await (await fetch(`${url}/api/task-panel?source=direct&q=direct-only-needle`, { headers })).json() as any;
    expect(directPanel.total).toBe(1);
    expect(directPanel.items[0]).toMatchObject({ source: "direct", id: direct.bridge_task_id });
    expect(JSON.stringify(directPanel)).not.toContain("private-file-key");
    const aampPanel = await (await fetch(`${url}/api/task-panel?source=aamp&state=pending&q=aamp-only-needle`, { headers })).json() as any;
    expect(aampPanel.total).toBe(1);
    expect(aampPanel.items[0]).toMatchObject({ source: "aamp", id: "aamp-only", status: "pending", image_count: 1,
      last_progress_text: "AAMP progress text" });
    expect(aampPanel.filters.states).toContain("pending");
    expect(aampPanel.filters.states).toContain("ATTENTION");
    expect(JSON.stringify(aampPanel)).not.toContain("/private/aamp-photo.png");
    expect((await (await fetch(`${url}/api/task-panel?state=pending`, { headers })).json() as any).items.map((item: any) => item.source)).toEqual(["aamp"]);
    const attentionPanel = await (await fetch(`${url}/api/task-panel?state=ATTENTION`, { headers })).json() as any;
    expect(attentionPanel.total).toBe(3);
    expect(attentionPanel.items.map((item: any) => item.source).sort()).toEqual(["aamp", "desk", "direct"]);
    expect((await (await fetch(`${url}/api/task-panel?source=direct&state=ATTENTION`, { headers })).json() as any).items.map((item: any) => item.id)).toEqual([direct.bridge_task_id]);
    expect((await (await fetch(`${url}/api/task-panel?source=aamp&state=FAILED`, { headers })).json() as any).total).toBe(0);
    expect((await (await fetch(`${url}/api/task-panel?source=aamp&project=fixture`, { headers })).json() as any).total).toBe(0);
    const aampDetailResponse = await fetch(`${url}/api/task-panel/aamp/aamp-only`, { headers });
    expect(aampDetailResponse.status).toBe(200);
    const aampDetailText = await aampDetailResponse.text();
    expect(aampDetailText).not.toContain("private-chat-id");
    expect(aampDetailText).not.toContain("private-aamp-snapshot");
    expect(aampDetailText).not.toContain("private-relay-token");
    expect(aampDetailText).not.toContain("private-aamp-event");
    expect(aampDetailText).not.toContain("/private/aamp-photo.png");
    expect(JSON.parse(aampDetailText)).toMatchObject({ can_followup: false, task: { source: "aamp", id: "aamp-only" } });
    expect((await fetch(`${url}/api/task-panel/aamp/aamp-only/followups`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${url}/api/task-panel/aamp/missing`, { headers })).status).toBe(404);
    expect((await fetch(`${url}/api/task-panel?source=invalid`, { headers })).status).toBe(400);
    expect((await (await fetch(`${url}/api/tasks`, { headers })).json() as any).total).toBe(1);
    expect((await fetch(`${url}/api/direct/tasks`)).status).toBe(401);
    expect((await fetch(`${url}/api/direct/tasks/${direct.bridge_task_id}`)).status).toBe(401);
    for (const suffix of ["?status=INVALID", "?limit=101", "?offset=-1", "?offset=NaN"]) {
      expect((await fetch(`${url}/api/direct/tasks${suffix}`, { headers })).status).toBe(400);
    }
    const page = await fetch(`${url}/direct-tasks?task=${direct.bridge_task_id}`, { headers });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="root"');
    for (const path of [`/tasks/direct/${direct.bridge_task_id}`, "/tasks/aamp/aamp-only", "/system-management/projects"]) {
      expect((await fetch(`${url}${path}`, { headers })).status).toBe(200);
    }
    const list = await (await fetch(`${url}/api/direct/tasks?limit=1`, { headers })).json() as any;
    expect(list.total).toBe(2);
    expect(list.items).toHaveLength(1);
    const second = await (await fetch(`${url}/api/direct/tasks?limit=1&offset=1`, { headers })).json() as any;
    expect(second.items[0].id).not.toBe(list.items[0].id);
    const found = await (await fetch(`${url}/api/direct/tasks?q=direct-only-needle&status=QUEUED`, { headers })).json() as any;
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({ source: "direct", id: direct.bridge_task_id });
    const detailResponse = await fetch(`${url}/api/direct/tasks/${direct.bridge_task_id}?limit=1`, { headers });
    expect(detailResponse.status).toBe(200);
    const body = await detailResponse.text();
    expect(body).not.toContain("private-file-key");
    expect(body).not.toContain("must-not-be-exposed");
    const detail = JSON.parse(body);
    expect(detail.followups.total).toBe(1);
    expect(detail.followups.items[0].text).toBe("follow up");
    expect(detail.attachments.total).toBe(1);
    expect(detail.events.total).toBeGreaterThan(0);
    expect(detail.events.items.length).toBeLessThanOrEqual(1);
    const collapsedEvents = await (await fetch(`${url}/api/direct/tasks/${direct.bridge_task_id}?events=0`, { headers })).json() as any;
    expect(collapsedEvents.events.total).toBe(detail.events.total);
    expect(collapsedEvents.events.items).toEqual([]);
    expect((await fetch(`${url}/api/direct/tasks/${direct.bridge_task_id}?events=invalid`, { headers })).status).toBe(400);
    expect((await fetch(`${url}/api/direct/tasks/missing`, { headers })).status).toBe(404);
    expect((await fetch(`${url}/api/direct/tasks/${direct.bridge_task_id}`, { method: "POST", headers })).status).toBe(404);
    expect(db.getBridgeTask(direct.bridge_task_id)?.status).toBe("QUEUED");
  });

  it("appends Web and Direct followups to their original tasks with action-token and replay checks", async () => {
    const { db, dispatcher } = fixture();
    const webTask = await dispatcher.submitWebTask(input);
    db.saveThreadId(webTask.active_run_id!, "thread-web-followup");
    db.finishRun(webTask.active_run_id!, { status: "succeeded", finalResponse: "first result" });
    const direct = db.ingestDirectMessage({ sourceEventId: "followup-direct-event", eventType: "im.message.receive_v1",
      messageId: "followup-direct-message", chatId: "fixture", chatType: "p2p", senderId: "sender",
      text: "Direct original", sessionKey: "fixture:followup", payload: {}, attachments: [] }).task;
    db.saveBridgeThreadId(direct.bridge_task_id, "thread-direct-followup");
    db.finishBridgeTask(direct.bridge_task_id, "SUCCEEDED", "first result");
    const server = new DashboardServer({ db, host: "127.0.0.1", port: 0, modes: [], actions: {
      createTask: (request) => dispatcher.submitWebTask(request),
      interruptTask: async () => ({ ok: false }),
      appendFeedback: async () => ({ ok: false, state: "FAILED" }),
      appendWebFollowup: (taskId, text, key) => dispatcher.appendWebTaskFollowup(taskId, text, key),
      appendDirectFollowup: async (taskId, text, key) => db.appendWebDirectFollowup(taskId, text, key),
    } });
    cleanup.push(() => server.stop());
    const url = await server.start();
    const { actionToken } = await (await fetch(`${url}/api/session`)).json() as { actionToken: string };
    const send = (source: string, taskId: string, text: string, key: string, authorized = true) =>
      fetch(`${url}/api/task-panel/${source}/${taskId}/followups`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: url,
          ...(authorized ? { "X-Bridge-Action-Token": actionToken } : {}) },
        body: JSON.stringify({ text, idempotencyKey: key }) });
    expect((await send("direct", direct.bridge_task_id, "next step", "direct-followup-key", false)).status).toBe(403);
    expect((await send("direct", direct.bridge_task_id, "next step", "direct-followup-key")).status).toBe(200);
    expect((await send("direct", direct.bridge_task_id, "next step", "direct-followup-key")).status).toBe(200);
    expect((await send("direct", direct.bridge_task_id, "changed", "direct-followup-key")).status).toBe(409);
    expect(db.readBridgeTaskPage(direct.bridge_task_id, 30, 0).followups.total).toBe(1);
    expect(db.getBridgeTask(direct.bridge_task_id)?.status).toBe("QUEUED");
    expect(db.getBridgeTask(direct.bridge_task_id)?.initial_final_response).toBe("first result");
    expect((await send("desk", webTask.task_guid, "web followup", "web-followup-key")).status).toBe(200);
    expect((await send("desk", webTask.task_guid, "web followup", "web-followup-key")).status).toBe(200);
    expect((await send("desk", webTask.task_guid, "changed", "web-followup-key")).status).toBe(409);
    expect(db.listRunsForTask(webTask.task_guid)).toHaveLength(2);
    expect(db.getLatestRun(webTask.task_guid)?.thread_id).toBe("thread-web-followup");
    expect(db.getLatestRun(webTask.task_guid)?.prompt_text).toContain("Bridge 任务面板追加了信息");
    expect(db.getTask(webTask.task_guid)?.input_text).toContain("web followup");
    expect((await (await fetch(`${url}/api/tasks/${webTask.task_guid}`)).json() as any).can_followup).toBe(false);
    expect((await (await fetch(`${url}/api/direct/tasks/${direct.bridge_task_id}`)).json() as any).can_followup).toBe(true);
  });
});
