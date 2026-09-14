import { describe, expect, it } from "vitest";

import { StateDatabase } from "../src/db.js";
import type { RoutedTask } from "../src/types.js";

const routedTask: RoutedTask = {
  taskGuid: "task-1",
  summary: "测试任务",
  description: "描述",
  projectKey: "food",
  mode: "implement",
  repo: "/tmp/food",
  sandboxMode: "workspace-write",
  inputHash: "hash-1",
  input: {
    projectKey: "food",
    mode: "implement",
    summary: "测试任务",
    description: "描述",
  },
  completed: false,
};

describe("StateDatabase", () => {
  it("uses the AAMP task id as a durable primary key and preserves business state", () => {
    const db = new StateDatabase(":memory:");
    const first = db.initializeAampTask({
      aampTaskId: "aamp-task-1",
      chatId: "oc_chat",
      userText: "请检查图片",
      imageLocalPaths: ["/tmp/task-1.png", "/tmp/task-2.jpg"],
      approvalState: "pending",
      sessionSnapshot: { sessionKey: "group:oc_chat" },
    });
    expect(first).toMatchObject({
      aamp_task_id: "aamp-task-1",
      chat_id: "oc_chat",
      image_local_paths: ["/tmp/task-1.png", "/tmp/task-2.jpg"],
      status: "pending",
    });

    const replay = db.initializeAampTask({
      aampTaskId: "aamp-task-1",
      chatId: "oc_chat",
      userText: "重放",
    });
    expect(replay.aamp_task_id).toBe("aamp-task-1");
    expect(db.listAampTasks().total).toBe(1);

    db.updateAampTask("aamp-task-1", {
      status: "running",
      lastDeltaText: "累计 markdown",
      cardId: "cardkit-card-1",
      approvalState: "waiting",
      eventType: "task.update",
      event: { delta: "累计 markdown" },
    });
    expect(db.getAampTask("aamp-task-1")).toMatchObject({
      status: "running",
      last_delta_text: "累计 markdown",
      card_id: "cardkit-card-1",
      approval_state: "waiting",
      last_event_type: "task.update",
    });
    expect(db.listRunningAampTasks().map((task) => task.aamp_task_id)).toEqual(["aamp-task-1"]);
    expect(db.listAampTasks({ chatId: "oc_chat" }).total).toBe(1);
    expect(db.listAampTasks({ chatId: "oc_other" }).total).toBe(0);
    expect(db.getGlobalHiddenTaskIds("oc_chat")).toEqual([]);
    expect(db.hideGlobalTask("aamp-task-1", "oc_chat")).toBe(true);
    expect(db.getGlobalHiddenTaskIds("oc_chat")).toEqual(["aamp-task-1"]);
    db.close();
  });

  it("persists global command cards without creating a direct Codex task", () => {
    const db = new StateDatabase(":memory:");
    const input = {
      sourceEventId: "evt-command-card",
      eventType: "im.message.receive_v1",
      messageId: "om-command-card",
      chatId: "oc_chat",
      chatType: "p2p" as const,
      senderId: "ou_user",
      text: "/recent",
      sessionKey: "chat:oc_chat",
    };
    expect(db.ingestDirectControlCard(
      input,
      { schema: "2.0", body: { elements: [] } },
      "om-existing-card",
    )).toBe(true);
    expect(db.ingestDirectControlCard(input, { schema: "2.0" })).toBe(false);
    expect(db.listBridgeTasks({ chatId: "oc_chat" }).total).toBe(0);
    const outbox = db.getDueOutbox(10, ["feishu.send_card"]);
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0].payload_json)).toMatchObject({
      chatId: "oc_chat",
      card: { schema: "2.0" },
      updateMessageId: "om-existing-card",
    });
    db.close();
  });

  it("claims a task and prevents a second queued claim", () => {
    const db = new StateDatabase(":memory:");
    const first = db.claimRun({
      task: routedTask,
      inputText: JSON.stringify(routedTask.input),
      promptText: "prompt",
      startedComment: (runId) => `started ${runId}`,
    });
    expect(first).not.toBeNull();
    expect(db.claimRun({
      task: routedTask,
      inputText: JSON.stringify(routedTask.input),
      promptText: "prompt",
      startedComment: "duplicate",
    })).toBeNull();
    expect(db.getTask("task-1")?.state).toBe("QUEUED");
    expect(db.getDueOutbox()[0]?.payload_json).toContain(first?.runId);
    db.close();
  });

  it("persists completion and its comment atomically", () => {
    const db = new StateDatabase(":memory:");
    const claim = db.claimRun({
      task: routedTask,
      inputText: JSON.stringify(routedTask.input),
      promptText: "prompt",
      startedComment: "started",
    });
    expect(claim).not.toBeNull();
    db.markRunRunning(claim!.runId, 123, "service");
    db.finishRun(claim!.runId, {
      status: "succeeded",
      finalResponse: "result",
      usage: { input: 1 },
      comment: "completed",
    });
    expect(db.getTask("task-1")?.state).toBe("WAITING_REVIEW");
    expect(db.getRun(claim!.runId)?.final_response).toBe("result");
    expect(db.getDueOutbox()).toHaveLength(2);
    db.close();
  });

  it("persists streamed worker progress for task and run views", () => {
    const db = new StateDatabase(":memory:");
    const claim = db.claimRun({
      task: routedTask,
      inputText: JSON.stringify(routedTask.input),
      promptText: "prompt",
      startedComment: "started",
    });
    db.markRunRunning(claim!.runId, 123, "service");
    expect(db.recordRunProgress(claim!.runId, {
      eventType: "item.started",
      itemType: "command_execution",
      itemId: "item-1",
      message: "命令已开始：bundle exec rake test",
      at: "2026-09-01T00:00:01.000Z",
    })).toBe(true);
    expect(db.getTask("task-1")).toMatchObject({
      progress_event: "item.started",
      progress_text: "命令已开始：bundle exec rake test",
    });
    expect(db.getRun(claim!.runId)).toMatchObject({
      progress_event: "item.started",
      progress_text: "命令已开始：bundle exec rake test",
    });
    expect(db.listRunEvents(claim!.runId)).toHaveLength(2);
    db.close();
  });

  it("uses exponential outbox backoff", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const db = new StateDatabase(":memory:", () => new Date(nowMs));
    const claim = db.claimRun({
      task: routedTask,
      inputText: JSON.stringify(routedTask.input),
      promptText: "prompt",
      startedComment: "started",
    });
    const entry = db.getDueOutbox()[0];
    expect(entry).toBeDefined();
    expect(db.markOutboxFailed(entry.id)).toBe(1);
    expect(db.getDueOutbox()).toHaveLength(0);
    nowMs += 1000;
    expect(db.getDueOutbox()).toHaveLength(1);
    void claim;
    db.close();
  });

  it("marks stale running runs failed on startup recovery", () => {
    const db = new StateDatabase(":memory:");
    const claim = db.claimRun({
      task: routedTask,
      inputText: JSON.stringify(routedTask.input),
      promptText: "prompt",
      startedComment: "started",
    });
    db.markRunRunning(claim!.runId, 123, "old-service");
    expect(db.recoverInterruptedRuns()).toHaveLength(1);
    expect(db.getTask("task-1")?.state).toBe("FAILED");
    expect(db.getRun(claim!.runId)?.state).toBe("FAILED");
    db.close();
  });

  it("persists direct Feishu messages idempotently and completes a leased Codex task", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const db = new StateDatabase(":memory:", () => new Date(nowMs));
    const input = {
      sourceEventId: "evt-1",
      eventType: "im.message.receive_v1",
      messageId: "om_1",
      chatId: "oc_chat",
      chatType: "p2p" as const,
      senderId: "ou_user",
      senderName: "小贾",
      text: "请检查当前仓库",
      sessionKey: "chat:oc_chat",
      payload: { raw: true },
    };
    const first = db.ingestDirectMessage(input);
    expect(first.created).toBe(true);
    expect(first.task).toMatchObject({
      chat_id: "oc_chat",
      status: "QUEUED",
      attempt: 0,
      session_key: "chat:oc_chat",
    });
    expect(db.ingestDirectMessage(input)).toMatchObject({
      created: false,
      task: { bridge_task_id: first.task.bridge_task_id },
    });
    expect(db.getDueOutbox(50, ["feishu.stream_card"])).toHaveLength(1);

    const claimed = db.claimDueBridgeTask("worker-1", 60_000);
    expect(claimed).toMatchObject({
      bridge_task_id: first.task.bridge_task_id,
      status: "RUNNING",
      attempt: 1,
      lease_owner: "worker-1",
    });
    expect(db.saveBridgeThreadId(first.task.bridge_task_id, "thread-1")).toBe(true);
    expect(db.recordBridgeTaskProgress(
      first.task.bridge_task_id,
      "item.completed",
      "已完成检查",
      { type: "agent_message" },
    )).toBe(true);
    expect(db.listBridgeTaskEvents(first.task.bridge_task_id)).toHaveLength(1);
    db.finishBridgeTask(first.task.bridge_task_id, "SUCCEEDED", "检查完成", undefined, "worker-1");
    expect(db.getBridgeTask(first.task.bridge_task_id)).toMatchObject({
      status: "SUCCEEDED",
      thread_id: "thread-1",
      final_response: "检查完成",
      lease_owner: null,
    });
    expect(db.getDueOutbox(50, ["feishu.stream_card"])).toHaveLength(1);

    nowMs += 60_000;
    expect(db.getLatestBridgeThreadId("chat:oc_chat")).toBe("thread-1");
    db.close();
  });

  it("attaches replies to the existing direct task and reuses its card/thread", () => {
    const db = new StateDatabase(":memory:");
    const original = db.ingestDirectMessage({
      sourceEventId: "evt-root-reply",
      eventType: "im.message.receive_v1",
      messageId: "om-root-reply",
      chatId: "oc-reply",
      chatType: "p2p",
      senderId: "ou-user",
      text: "请检查当前仓库",
      sessionKey: "chat:oc-reply",
    });
    const worker = "worker-reply";
    expect(db.claimDueBridgeTask(worker, 60_000)).not.toBeNull();
    expect(db.saveBridgeThreadId(original.task.bridge_task_id, "thread-reply", worker)).toBe(true);
    expect(db.finishBridgeTask(original.task.bridge_task_id, "SUCCEEDED", "检查完成", undefined, worker))
      .toMatchObject({ status: "SUCCEEDED", thread_id: "thread-reply" });
    expect(db.markBridgeCardStreaming(original.task.bridge_task_id, "om-result-card")).toBe(true);
    expect(db.markBridgeCardCompleted(original.task.bridge_task_id)).toBe(true);

    const reply = db.ingestDirectMessage({
      sourceEventId: "evt-followup-reply",
      eventType: "im.message.receive_v1",
      messageId: "om-followup-reply",
      chatId: "oc-reply",
      chatType: "p2p",
      senderId: "ou-user",
      text: "再检查一下测试结果",
      sessionKey: "chat:oc-reply",
      replyToMessageId: "om-result-card",
      rootMessageId: "om-root-reply",
      attachments: [{ type: "image", fileKey: "followup-image", fileName: "结果.png" }],
    });
    expect(reply).toMatchObject({ created: true, continued: true, task: { bridge_task_id: original.task.bridge_task_id, status: "QUEUED" } });
    expect(db.listBridgeTasks({ chatId: "oc-reply" }).total).toBe(1);
    expect(db.getBridgeTaskForReply({
      chatId: "oc-reply",
      replyToMessageId: "om-followup-reply",
    })).toMatchObject({ bridge_task_id: original.task.bridge_task_id });

    const followup = db.getNextBridgeTaskFollowup(original.task.bridge_task_id);
    expect(followup).toMatchObject({
      bridge_task_id: original.task.bridge_task_id,
      message_id: "om-followup-reply",
      status: "QUEUED",
    });
    expect(db.getBridgeTaskAttachments(original.task.bridge_task_id, followup!.followup_id))
      .toMatchObject([{ file_key: "followup-image", followup_id: followup!.followup_id }]);

    expect(db.claimDueBridgeTask(worker, 60_000)).toMatchObject({
      bridge_task_id: original.task.bridge_task_id,
      status: "RUNNING",
      thread_id: "thread-reply",
    });
    expect(db.claimBridgeTaskFollowup(followup!.followup_id)).toMatchObject({ status: "RUNNING" });
    expect(db.finishBridgeTaskTurn(
      original.task.bridge_task_id,
      followup!.followup_id,
      "SUCCEEDED",
      "测试结果也正常",
      undefined,
      worker,
    )).toMatchObject({
      bridge_task_id: original.task.bridge_task_id,
      status: "SUCCEEDED",
      thread_id: "thread-reply",
      final_response: "测试结果也正常",
    });
    expect(db.listBridgeTasks({ chatId: "oc-reply" }).total).toBe(1);
    db.close();
  });

  it("schedules a transient direct task retry without losing its thread or card outbox", () => {
    const db = new StateDatabase(":memory:");
    const created = db.ingestDirectMessage({
      sourceEventId: "evt-transient-retry",
      eventType: "im.message.receive_v1",
      messageId: "om-transient-retry",
      chatId: "oc-transient-retry",
      chatType: "p2p",
      senderId: "ou-transient-retry",
      text: "临时网络错误后重试",
      sessionKey: "chat:oc-transient-retry",
    });
    const claimed = db.claimDueBridgeTask("worker-transient", 60_000);
    expect(claimed).toMatchObject({
      bridge_task_id: created.task.bridge_task_id,
      status: "RUNNING",
      attempt: 1,
    });
    expect(db.saveBridgeThreadId(created.task.bridge_task_id, "thread-transient", "worker-transient")).toBe(true);
    expect(db.scheduleBridgeTaskRetry(
      created.task.bridge_task_id,
      "worker-transient",
      "Codex 网络连接暂时失败，将自动重试。",
      "2026-09-01T00:00:05.000Z",
    )).toBe(true);
    expect(db.getBridgeTask(created.task.bridge_task_id)).toMatchObject({
      status: "QUEUED",
      attempt: 1,
      thread_id: "thread-transient",
      next_attempt_at: "2026-09-01T00:00:05.000Z",
      last_progress_event: "retry.scheduled",
    });
    expect(db.listBridgeTaskEvents(created.task.bridge_task_id).at(-1)).toMatchObject({
      event_type: "retry.scheduled",
    });
    expect(db.getDueOutbox(50, ["feishu.stream_card"])).toHaveLength(1);
    db.close();
  });

  it("persists direct attachments, supports cancellation, and recovers a running task", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const db = new StateDatabase(":memory:", () => new Date(nowMs));
    const created = db.ingestDirectMessage({
      sourceEventId: "evt-advanced",
      eventType: "im.message.receive_v1",
      messageId: "om-advanced",
      chatId: "oc-advanced",
      chatType: "p2p",
      senderId: "ou-advanced",
      text: "请看附件",
      sessionKey: "chat:oc-advanced",
      attachments: [{ type: "image", fileKey: "img-key", fileName: "截图.png" }],
    });
    const attachment = db.getBridgeTaskAttachments(created.task.bridge_task_id)[0];
    expect(attachment).toMatchObject({
      type: "image",
      file_key: "img-key",
      file_name: "截图.png",
      status: "PENDING",
    });
    expect(db.markAttachmentDownloaded(attachment.attachment_id, "/tmp/screenshot.png")).toBe(true);
    expect(db.getBridgeTaskAttachments(created.task.bridge_task_id)[0].status).toBe("DOWNLOADED");

    expect(db.claimDueBridgeTask("worker-recovery", 10_000)).not.toBeNull();
    expect(db.requestBridgeTaskCancellation(created.task.bridge_task_id)).toMatchObject({
      status: "CANCEL_REQUESTED",
      cancel_reason: "用户请求取消当前任务。",
    });
    nowMs += 10_001;
    expect(db.recoverExpiredBridgeTasks()).toEqual({ requeued: 0, cancelled: 1 });
    expect(db.getBridgeTask(created.task.bridge_task_id)).toMatchObject({
      status: "CANCELLED",
      recovery_count: 1,
      last_progress_event: "runtime.recovered",
    });
    expect(db.getDueOutbox(50, ["feishu.stream_card"])).toHaveLength(1);
    db.close();
  });

  it("enforces a single direct runtime lease and force-recovers orphaned work", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const db = new StateDatabase(":memory:", () => new Date(nowMs));
    const created = db.ingestDirectMessage({
      sourceEventId: "evt-runtime",
      eventType: "im.message.receive_v1",
      messageId: "om-runtime",
      chatId: "oc-runtime",
      chatType: "group",
      senderId: "ou-runtime",
      text: "运行时恢复",
      sessionKey: "chat:oc-runtime",
    });
    expect(db.acquireRuntimeLease("direct-codex-runtime", "runtime-1", 30_000)).toBe(true);
    expect(db.acquireRuntimeLease("direct-codex-runtime", "runtime-2", 30_000)).toBe(false);
    expect(db.claimDueBridgeTask("runtime-1", 120_000)).not.toBeNull();
    expect(db.recoverExpiredBridgeTasks(true)).toEqual({ requeued: 1, cancelled: 0 });
    expect(db.getBridgeTask(created.task.bridge_task_id)?.status).toBe("QUEUED");
    expect(db.renewRuntimeLease("direct-codex-runtime", "runtime-1", 30_000)).toBe(true);
    expect(db.releaseRuntimeLease("direct-codex-runtime", "runtime-1")).toBe(true);
    db.close();
  });

  it("reclaims an expired direct task lease", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const db = new StateDatabase(":memory:", () => new Date(nowMs));
    const created = db.ingestDirectMessage({
      sourceEventId: "evt-lease",
      eventType: "im.message.receive_v1",
      messageId: "om-lease",
      chatId: "oc-chat",
      chatType: "group",
      senderId: "ou-user",
      text: "测试租约",
      sessionKey: "chat:oc-chat",
    });
    expect(db.claimDueBridgeTask("worker-1", 10_000)).not.toBeNull();
    nowMs += 10_001;
    expect(db.claimDueBridgeTask("worker-2", 10_000)).toMatchObject({
      bridge_task_id: created.task.bridge_task_id,
      attempt: 2,
      lease_owner: "worker-2",
    });
    db.close();
  });

  it("supports operator retry, status counts, and direct outbox inspection", () => {
    const db = new StateDatabase(":memory:");
    const created = db.ingestDirectMessage({
      sourceEventId: "evt-retry",
      eventType: "im.message.receive_v1",
      messageId: "om-retry",
      chatId: "oc-retry",
      chatType: "p2p",
      senderId: "ou-retry",
      text: "需要重试",
      sessionKey: "chat:oc-retry",
    });
    const claimed = db.claimDueBridgeTask("worker-retry", 10_000);
    expect(claimed).not.toBeNull();
    db.finishBridgeTask(created.task.bridge_task_id, "FAILED", undefined, "模拟失败", "worker-retry");
    const cardOutbox = db.getDueOutbox(50, ["feishu.stream_card"])[0];
    expect(cardOutbox).toBeDefined();
    db.markOutboxDelivered(cardOutbox.id);
    db.markBridgeCardStreaming(created.task.bridge_task_id, "om-card-retry");
    db.markBridgeCardCompleted(created.task.bridge_task_id);

    const retried = db.retryBridgeTask(created.task.bridge_task_id, "修复配置后重试");
    expect(retried).toMatchObject({
      status: "QUEUED",
      card_state: "STREAMING",
      error: null,
      last_progress_event: "retry.requested",
    });
    expect(db.findBridgeTasksById(created.task.bridge_task_id.slice(0, 12))).toHaveLength(1);
    expect(db.getBridgeTaskStatusCounts()).toMatchObject({ QUEUED: 1, FAILED: 0 });
    expect(db.listOutbox({ taskGuid: created.task.bridge_task_id })).toHaveLength(2);
    expect(db.getOutboxSummary(["feishu.stream_card"])).toMatchObject({
      total: 2,
      pending: 1,
      delivered: 1,
    });
    db.close();
  });
});
