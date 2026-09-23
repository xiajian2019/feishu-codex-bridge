import { describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@larksuiteoapi/node-sdk";

import { parseConfig } from "../src/config.js";
import type { CodexAppServerQueryClient } from "../src/codex-app-server.js";
import { StateDatabase } from "../src/db.js";
import {
  FeishuSqliteCodexRuntime,
  buildProjectRoutingConfig,
  buildDirectPrompt,
  evaluateDirectPermission,
  parseDirectTaskRoute,
  renderDirectCardContent,
  resolveFeishuCredentials,
  resolveDirectLarkDomain,
  parseDirectControlCommand,
  resolveDirectTaskRoute,
  resolveDirectContinuationRoute,
  summarizeCodexEvent,
  isTransientDirectError,
  calculateDirectRetryDelayMs,
  DIRECT_CHANNEL_HEALTH_CHECK_MS,
  DIRECT_CHANNEL_IDLE_STALE_MS,
  DIRECT_CHANNEL_PING_TIMEOUT_SECONDS,
  DIRECT_CHANNEL_RECONNECT_STALE_MS,
  directChannelRecoveryReason,
} from "../src/feishu-sqlite-codex.js";
import type { StoredBridgeTask } from "../src/types.js";

const config = parseConfig({
  execution: { mode: "feishu-sqlite-codex" },
  direct: {
    projectKey: "food",
    mode: "implement",
    feishu: {},
  },
  lark: {
    profile: "work",
    tasklistGuid: "list",
    projectFieldGuid: "project-field",
    modeFieldGuid: "mode-field",
  },
  codex: {
    cliPath: "/opt/homebrew/bin/codex",
    env: {
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
    },
  },
  projects: { food: { optionGuid: "project-option", repo: "/tmp/food" } },
  modes: { implement: { optionGuid: "mode-option", sandboxMode: "workspace-write" } },
}, { checkRepositories: false });

describe("native Feishu + SQLite + Codex runtime helpers", () => {
  it("intercepts direct-mode slash commands before task routing", () => {
    expect(parseDirectControlCommand("/help")).toEqual({ command: "help", argument: undefined });
    expect(parseDirectControlCommand("/tasks bridge_123")).toEqual({ command: "task", argument: "bridge_123" });
    expect(parseDirectControlCommand("/thread")).toEqual({ command: "thread", argument: undefined });
    expect(parseDirectControlCommand("/threads --project food --search \"fix bug\""))
      .toEqual({ command: "threads", argument: "--project food --search \"fix bug\"" });
    expect(parseDirectControlCommand("/events bridge_123")).toEqual({ command: "events", argument: "bridge_123" });
    expect(parseDirectControlCommand("/tools bridge_123")).toEqual({ command: "tools", argument: "bridge_123" });
    expect(parseDirectControlCommand("/cancel bridge_123")).toBeUndefined();
    expect(parseDirectControlCommand("修复项目问题")).toBeUndefined();
  });

  it("normalizes AAMP tenant brands for the Lark SDK domain option", () => {
    expect(resolveDirectLarkDomain(undefined, "feishu")).toBe(Domain.Feishu);
    expect(resolveDirectLarkDomain("feishu", "feishu")).toBe(Domain.Feishu);
    expect(resolveDirectLarkDomain(undefined, "lark")).toBe(Domain.Lark);
    expect(resolveDirectLarkDomain("lark", "feishu")).toBe(Domain.Lark);
    expect(resolveDirectLarkDomain("https://open.feishu.cn", "feishu")).toBe("https://open.feishu.cn");
  });

  it("parses task-level project and mode headers", () => {
    expect(parseDirectTaskRoute("项目：go-boohee\n模式=review\n\n检查代码")).toEqual({
      projectKey: "go-boohee",
      modeKey: "review",
    });
    expect(parseDirectTaskRoute("请检查项目和模式说明")).toEqual({});
  });

  it("classifies transient Codex failures and applies bounded exponential backoff", () => {
    expect(isTransientDirectError("fetch failed: ECONNRESET")).toBe(true);
    expect(isTransientDirectError("Codex 运行超时。")).toBe(false);
    expect(isTransientDirectError("authentication failed")).toBe(false);
    expect(calculateDirectRetryDelayMs(config.direct.retry, 1, 0)).toBe(5_000);
    expect(calculateDirectRetryDelayMs(config.direct.retry, 2, 0)).toBe(10_000);
    expect(calculateDirectRetryDelayMs(config.direct.retry, 20, 1)).toBe(125_000);
  });

  it("uses seconds for the WebSocket liveness watchdog and recovers stale channel states", () => {
    expect(DIRECT_CHANNEL_PING_TIMEOUT_SECONDS).toBe(5);
    expect(DIRECT_CHANNEL_HEALTH_CHECK_MS).toBe(10_000);
    expect(directChannelRecoveryReason("failed", 0)).toBe("failed");
    expect(directChannelRecoveryReason("reconnecting", DIRECT_CHANNEL_RECONNECT_STALE_MS - 1)).toBeUndefined();
    expect(directChannelRecoveryReason("reconnecting", DIRECT_CHANNEL_RECONNECT_STALE_MS)).toBe("reconnecting_timeout");
    expect(directChannelRecoveryReason("idle", DIRECT_CHANNEL_IDLE_STALE_MS)).toBe("idle_timeout");
  });

  it("schedules non-blocking Get and Think message reactions", async () => {
    const db = new StateDatabase(":memory:");
    const runtime = new FeishuSqliteCodexRuntime(config, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const addReaction = vi.fn(async () => "reaction-1");
    (runtime as any).channel = { addReaction };

    (runtime as any).scheduleMessageReaction("om-reaction", "Get");
    (runtime as any).scheduleMessageReaction("om-reaction", "Think");
    for (let attempt = 0; attempt < 10 && addReaction.mock.calls.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(addReaction.mock.calls).toEqual([
      ["om-reaction", "Get"],
      ["om-reaction", "Think"],
    ]);
    db.close();
  });

  it("uses explicit project headers and treats unscoped messages as consultations", () => {
    expect(resolveDirectTaskRoute("项目：food\n模式：implement\n修复问题", {
      ...config,
      direct: { ...config.direct, projectKey: undefined, mode: undefined },
    })).toMatchObject({
      ok: true,
      projectKey: "food",
      modeKey: "implement",
    });
    expect(resolveDirectTaskRoute("修复问题", {
      ...config,
      direct: { ...config.direct, projectKey: undefined, mode: undefined },
      projects: { food: config.projects.food },
      modes: { implement: config.modes.implement },
    })).toMatchObject({
      ok: true,
      kind: "consultation",
    });
    expect(resolveDirectTaskRoute("修复问题", {
      ...config,
      direct: { ...config.direct, projectKey: undefined, mode: undefined },
      projects: {},
      modes: {},
    })).toMatchObject({ ok: true, kind: "consultation" });
  });

  it("defaults direct tasks without a mode header to implement", () => {
    expect(resolveDirectTaskRoute("项目：food\n修复问题", {
      ...config,
      direct: { ...config.direct, projectKey: undefined, mode: undefined },
    })).toMatchObject({
      ok: true,
      projectKey: "food",
      modeKey: "implement",
      mode: { sandboxMode: "workspace-write" },
    });
  });

  it("executes an unscoped message as a read-only consultation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "direct-consultation-"));
    const db = new StateDatabase(":memory:");
    const runtime = new FeishuSqliteCodexRuntime({
      ...config,
      direct: { ...config.direct, projectKey: "food", mode: "implement" },
    }, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      attachmentsDir: join(directory, "attachments"),
    });
    const threadOptions: Record<string, unknown>[] = [];
    (runtime as any).codex = {
      startThread: (options: Record<string, unknown>) => {
        threadOptions.push(options);
        return {
          id: "consultation-thread",
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started", thread_id: "consultation-thread" };
              yield { type: "item.completed", item: { type: "agent_message", text: "这是一个通用技术回答" } };
            })(),
          }),
        };
      },
    };
    try {
      const task = db.ingestDirectMessage({
        sourceEventId: "evt-consultation",
        eventType: "im.message.receive_v1",
        messageId: "om-consultation",
        chatId: "oc-consultation",
        chatType: "p2p",
        senderId: "ou-consultation",
        text: "HTTP 429 和指数退避有什么区别？",
        sessionKey: "chat:oc-consultation",
      }).task;
      const workerId = (runtime as any).workerId as string;
      const claim = db.claimDueBridgeTask(workerId, 60_000);
      await (runtime as any).processTask(claim);

      expect(db.getBridgeTask(task.bridge_task_id)).toMatchObject({
        status: "SUCCEEDED",
        final_response: "这是一个通用技术回答",
      });
      expect(threadOptions[0]).toMatchObject({
        sandboxMode: "read-only",
        skipGitRepoCheck: true,
      });
      expect(threadOptions[0].workingDirectory).toContain("consultation");
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("inherits omitted project and mode values for a reply", () => {
    expect(resolveDirectContinuationRoute(
      "继续检查刚才发现的问题",
      "项目：food\n模式：implement\n\n检查当前仓库",
      config,
    )).toMatchObject({
      ok: true,
      projectKey: "food",
      modeKey: "implement",
    });
  });

  it("runs a reply as another turn on the parent Codex thread", async () => {
    const db = new StateDatabase(":memory:");
    const root = db.ingestDirectMessage({
      sourceEventId: "evt-runtime-root",
      eventType: "im.message.receive_v1",
      messageId: "om-runtime-root",
      chatId: "oc-runtime-reply",
      chatType: "p2p",
      senderId: "ou-user",
      text: "项目：food\n\n检查仓库",
      sessionKey: "chat:oc-runtime-reply",
    }).task;
    const runtime = new FeishuSqliteCodexRuntime(config, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const starts: string[] = [];
    const resumes: string[] = [];
    const makeThread = (threadId: string) => ({
      id: threadId,
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: threadId };
          yield { type: "item.completed", item: { type: "agent_message", text: `响应 ${threadId}` } };
        })(),
      }),
    });
    (runtime as any).codex = {
      startThread: () => {
        starts.push("start");
        return makeThread("codex-thread-1");
      },
      resumeThread: (threadId: string) => {
        resumes.push(threadId);
        return makeThread(threadId);
      },
    };

    const workerId = (runtime as any).workerId as string;
    const rootClaim = db.claimDueBridgeTask(workerId, 60_000);
    await (runtime as any).processTask(rootClaim);
    expect(db.getBridgeTask(root.bridge_task_id)).toMatchObject({
      status: "SUCCEEDED",
      thread_id: "codex-thread-1",
    });

    const reply = db.ingestDirectMessage({
      sourceEventId: "evt-runtime-followup",
      eventType: "im.message.receive_v1",
      messageId: "om-runtime-followup",
      chatId: "oc-runtime-reply",
      chatType: "p2p",
      senderId: "ou-user",
      text: "请继续说明刚才的检查结果",
      sessionKey: "chat:oc-runtime-reply",
      replyToMessageId: "om-runtime-root",
    });
    expect(reply).toMatchObject({ continued: true, task: { bridge_task_id: root.bridge_task_id } });
    const followupClaim = db.claimDueBridgeTask(workerId, 60_000);
    await (runtime as any).processTask(followupClaim);

    expect(starts).toEqual(["start"]);
    expect(resumes).toEqual(["codex-thread-1"]);
    expect(db.listBridgeTasks({ chatId: "oc-runtime-reply" }).total).toBe(1);
    expect(db.getBridgeTask(root.bridge_task_id)).toMatchObject({
      status: "SUCCEEDED",
      final_response: "响应 codex-thread-1",
    });
    db.close();
  });

  it("uses an internal implement default when direct mode registry is empty", () => {
    expect(resolveDirectTaskRoute("项目：food\n修复问题", {
      ...config,
      direct: { ...config.direct, projectKey: undefined, mode: undefined },
      modes: {},
    })).toMatchObject({
      ok: true,
      modeKey: "implement",
      mode: { sandboxMode: "workspace-write" },
    });
  });

  it("resolves direct projects from the Bridge SQLite registry", () => {
    const db = new StateDatabase(":memory:");
    db.createProject({ name: "feishu-codex-bridge", path: process.cwd() });
    const registryConfig = buildProjectRoutingConfig(config, db);
    expect(resolveDirectTaskRoute("项目：feishu-codex-bridge\n模式：implement\n查看状态", registryConfig)).toMatchObject({
      ok: true,
      projectKey: "feishu-codex-bridge",
      project: { repo: process.cwd() },
    });
    db.close();
  });

  it("resolves credentials from the configured environment names", () => {
    const previousId = process.env.TEST_FEISHU_APP_ID;
    const previousSecret = process.env.TEST_FEISHU_APP_SECRET;
    process.env.TEST_FEISHU_APP_ID = "cli_test";
    process.env.TEST_FEISHU_APP_SECRET = "secret_test";
    try {
      const result = resolveFeishuCredentials({
        ...config,
        direct: {
          ...config.direct,
          feishu: {
            ...config.direct.feishu,
            appIdEnv: "TEST_FEISHU_APP_ID",
            appSecretEnv: "TEST_FEISHU_APP_SECRET",
          },
        },
      });
      expect(result).toEqual({ appId: "cli_test", appSecret: "secret_test" });
    } finally {
      if (previousId === undefined) delete process.env.TEST_FEISHU_APP_ID;
      else process.env.TEST_FEISHU_APP_ID = previousId;
      if (previousSecret === undefined) delete process.env.TEST_FEISHU_APP_SECRET;
      else process.env.TEST_FEISHU_APP_SECRET = previousSecret;
    }
  });

  it("builds a bounded prompt with project and sandbox context", () => {
    const prompt = buildDirectPrompt({
      projectKey: "food",
      modeKey: "implement",
      repo: "/tmp/food",
      sandboxMode: "workspace-write",
      text: "修复单位换算问题",
      sessionKey: "chat:oc_chat",
    });
    expect(prompt).toContain("项目：food");
    expect(prompt).toContain("仓库：/tmp/food");
    expect(prompt).toContain("修复单位换算问题");
    expect(prompt).toContain("不要自行 commit、push、merge、部署或删除用户数据");
  });

  it("builds a consultation prompt without project assumptions", () => {
    const prompt = buildDirectPrompt({
      text: "解释一下 HTTP 429 的常见原因",
      sessionKey: "chat:oc-consultation",
    });
    expect(prompt).toContain("当前请求未指定项目或实现模式");
    expect(prompt).toContain("通用技术咨询");
    expect(prompt).not.toContain("项目：undefined");
    expect(prompt).not.toContain("仓库：undefined");
  });

  it("includes durable attachment paths in the Codex prompt", () => {
    const prompt = buildDirectPrompt({
      projectKey: "food",
      modeKey: "implement",
      repo: "/tmp/food",
      sandboxMode: "workspace-write",
      text: "分析截图",
      sessionKey: "chat:oc_chat",
      attachments: [{ type: "image", fileName: "screen.png", localPath: "/tmp/task/screen.png" }],
    });
    expect(prompt).toContain("screen.png");
    expect(prompt).toContain("/tmp/task/screen.png");
  });

  it("selects the most specific permission rule for each capability", () => {
    const permissionConfig = {
      ...config,
      direct: {
        ...config.direct,
        permissions: {
          defaultAllow: false,
          allowAttachments: false,
          allowCancel: false,
          rules: [
            { chatType: "p2p" as const, allow: true, allowCancel: true },
            { chatId: "oc_chat", senderOpenId: "ou_user", allowAttachments: true },
          ],
        },
      },
    };
    expect(evaluateDirectPermission(permissionConfig, {
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_user",
    }, "message").allowed).toBe(true);
    expect(evaluateDirectPermission(permissionConfig, {
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_user",
    }, "attachment").allowed).toBe(true);
    expect(evaluateDirectPermission(permissionConfig, {
      chatId: "other",
      chatType: "p2p",
      senderId: "ou_user",
    }, "attachment").allowed).toBe(false);
  });

  it("renders progress and terminal task states into one bounded card body", () => {
    const task = {
      bridge_task_id: "bridge-card",
      source_event_id: "evt-card",
      message_id: "om-card",
      chat_id: "oc-chat",
      chat_type: "p2p",
      sender_id: "ou-user",
      sender_name: null,
      text: "检查",
      session_key: "chat:oc-chat",
      status: "SUCCEEDED",
      thread_id: "thread-1",
      attempt: 1,
      next_attempt_at: null,
      lease_owner: null,
      lease_expires_at: null,
      last_progress_event: "item.completed",
      last_progress_text: "测试已通过",
      last_progress_at: "2026-09-01T00:00:00.000Z",
      card_message_id: "om-card-result",
      card_state: "STREAMING",
      card_content: null,
      card_updated_at: null,
      cancel_requested_at: null,
      cancel_reason: null,
      recovery_count: 0,
      last_recovered_at: null,
      final_response: "完成",
      error: null,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    } satisfies StoredBridgeTask;
    const card = renderDirectCardContent(task, ["screen.png"]);
    expect(card).toContain("已完成");
    expect(card).toContain("测试已通过");
    expect(card).toContain("完成");
    expect(card).toContain("screen.png");
  });

  it("summarizes streamed Codex events without retaining huge progress text", () => {
    expect(summarizeCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "检查完成" },
    })).toBe("检查完成");
    expect(summarizeCodexEvent({
      type: "item.started",
      item: { type: "command_execution", command: "pnpm test" },
    })).toBe("item.started: pnpm test");
    expect(summarizeCodexEvent({ type: "turn.started" })).toBe("turn.started");
  });

  it("allows direct cards to cancel only direct tasks", async () => {
    const db = new StateDatabase(":memory:");
    const direct = db.ingestDirectMessage({
      sourceEventId: "evt-direct-card",
      eventType: "im.message.receive_v1",
      messageId: "om-direct-card",
      chatId: "oc-chat",
      chatType: "p2p",
      senderId: "ou-user",
      text: "直连任务",
      sessionKey: "chat:oc-chat",
    }).task;
    db.initializeAampTask({
      aampTaskId: "aamp-live",
      chatId: "oc-chat",
      userText: "AAMP 任务",
      status: "running",
    });
    const runtime = new FeishuSqliteCodexRuntime({
      ...config,
      direct: {
        ...config.direct,
        permissions: { ...config.direct.permissions, defaultAllow: true, allowCancel: true },
      },
    }, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const updateCard = vi.fn(async () => undefined);
    (runtime as any).channel = { updateCard, send: vi.fn(async () => undefined) };
    (runtime as any).schedulePump = vi.fn();

    await (runtime as any).handleGlobalCardAction({
      messageId: "global-card",
      chatId: "oc-chat",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: { kind: "task_cancel", taskId: "aamp-live", sourceMode: "aamp" },
      },
    });
    expect(db.getAampTask("aamp-live")?.status).toBe("running");
    expect(db.getBridgeTask(direct.bridge_task_id)?.status).toBe("QUEUED");
    expect(updateCard).not.toHaveBeenCalled();

    await (runtime as any).handleGlobalCardAction({
      messageId: "global-card",
      chatId: "oc-chat",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: { kind: "task_cancel", taskId: direct.bridge_task_id, sourceMode: "direct" },
      },
    });
    expect(db.getBridgeTask(direct.bridge_task_id)?.status).toBe("CANCELLED");
    // Card actions only persist an update request in the callback. Feishu I/O
    // is performed by the outbox worker after the callback has returned.
    expect(updateCard).not.toHaveBeenCalled();
    expect(db.getDueOutbox(10, ["feishu.send_card"])).toHaveLength(1);
    await (runtime as any).flushOutbox();
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain("接入模式：Codex 直连");

    await (runtime as any).handleGlobalCardAction({
      messageId: "global-card",
      chatId: "oc-chat",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: { kind: "aamp_command", command: "progress", taskId: direct.bridge_task_id },
      },
    });
    expect(updateCard).toHaveBeenCalledTimes(1);
    await (runtime as any).flushOutbox();
    expect(updateCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain("最新执行进度");
    db.close();
  });

  it("updates detail cards asynchronously and does not let a live task stream overwrite them", async () => {
    const db = new StateDatabase(":memory:");
    const direct = db.ingestDirectMessage({
      sourceEventId: "evt-detail-action",
      eventType: "im.message.receive_v1",
      messageId: "om-detail-action",
      chatId: "oc-detail",
      chatType: "p2p",
      senderId: "ou-user",
      text: "检查任务",
      sessionKey: "chat:oc-detail",
    }).task;
    const runtime = new FeishuSqliteCodexRuntime(config, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const send = vi.fn(async () => ({ messageId: "detail-card" }));
    const updateCard = vi.fn(async () => undefined);
    (runtime as any).channel = { send, updateCard };

    await (runtime as any).handleGlobalCardAction({
      messageId: "live-task-card",
      chatId: "oc-detail",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: {
          kind: "aamp_command",
          command: "tasks",
          taskId: direct.bridge_task_id,
          source: "direct_task",
        },
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
    await (runtime as any).flushOutbox();
    expect(send).toHaveBeenCalledTimes(1);
    expect(updateCard).not.toHaveBeenCalled();

    await (runtime as any).handleGlobalCardAction({
      messageId: "detail-card",
      chatId: "oc-detail",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: {
          kind: "aamp_command",
          command: "tasks",
          taskId: direct.bridge_task_id,
          source: "detail",
        },
      },
    });
    expect(updateCard).not.toHaveBeenCalled();
    await (runtime as any).flushOutbox();
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(updateCard.mock.calls[0][0]).toBe("detail-card");
    db.close();
  });

  it("keeps a detail card in place when cancelling a direct task", async () => {
    const db = new StateDatabase(":memory:");
    const direct = db.ingestDirectMessage({
      sourceEventId: "evt-detail-cancel",
      eventType: "im.message.receive_v1",
      messageId: "om-detail-cancel",
      chatId: "oc-detail-cancel",
      chatType: "p2p",
      senderId: "ou-user",
      text: "长时间任务",
      sessionKey: "chat:oc-detail-cancel",
    }).task;
    const runtime = new FeishuSqliteCodexRuntime({
      ...config,
      direct: {
        ...config.direct,
        permissions: { ...config.direct.permissions, defaultAllow: true, allowCancel: true },
      },
    }, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const send = vi.fn(async () => ({ messageId: "new-card" }));
    const updateCard = vi.fn(async () => undefined);
    (runtime as any).channel = { send, updateCard };
    (runtime as any).schedulePump = vi.fn();

    await (runtime as any).handleGlobalCardAction({
      messageId: "detail-card-cancel",
      chatId: "oc-detail-cancel",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: {
          kind: "task_cancel",
          taskId: direct.bridge_task_id,
          sourceMode: "direct",
          source: "detail",
        },
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
    await (runtime as any).flushOutbox();

    expect(send).not.toHaveBeenCalled();
    expect(updateCard).toHaveBeenCalledWith(
      "detail-card-cancel",
      expect.objectContaining({ body: expect.objectContaining({ elements: expect.any(Array) }) }),
    );
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain("Codex 任务详情");
    expect(db.getBridgeTask(direct.bridge_task_id)?.status).toBe("CANCELLED");
    db.close();
  });

  it("delivers direct slash-command responses with the shared global card style", async () => {
    const db = new StateDatabase(":memory:");
    db.initializeAampTask({
      aampTaskId: "aamp-history",
      chatId: "oc-chat",
      userText: "历史 AAMP 任务",
      status: "done",
    });
    const runtime = new FeishuSqliteCodexRuntime(config, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const send = vi.fn(async () => ({ messageId: "global-command-card" }));
    (runtime as any).channel = { send };
    (runtime as any).schedulePump = vi.fn();

    await (runtime as any).handleDirectControlCommand({
      sourceEventId: "evt-recent",
      eventType: "im.message.receive_v1",
      messageId: "om-recent",
      chatId: "oc-chat",
      chatType: "p2p",
      senderId: "ou-user",
      text: "/recent",
      sessionKey: "chat:oc-chat",
    }, "recent");
    expect(db.getDueOutbox(10, ["feishu.send_card"])).toHaveLength(1);
    expect(db.listBridgeTasks({ chatId: "oc-chat" }).total).toBe(0);

    await (runtime as any).flushOutbox();
    expect(send).toHaveBeenCalledTimes(1);
    const card = send.mock.calls[0][1].card;
    expect(JSON.stringify(card)).toContain("Codex 最近任务");
    expect(JSON.stringify(card)).toContain("接入模式：AAMP");
    expect(db.getDueOutbox(10, ["feishu.send_card"])).toHaveLength(0);
    db.close();
  });

  it("queries App/CLI threads from the direct-mode /threads command", async () => {
    const db = new StateDatabase(":memory:");
    const readThread = vi.fn(async (threadId: string) => ({
      thread: {
        id: threadId,
        preview: "Fix bug from CLI",
        source: "cli",
        cwd: "/tmp/food",
        status: { type: "idle" },
        updatedAt: 1_757_030_400,
        turns: [{ type: "command_execution", command: "npm test", status: "completed" }],
      },
    }));
    const client: CodexAppServerQueryClient = {
      listThreads: vi.fn(async (params) => {
        expect(params).toMatchObject({
          sourceKinds: ["cli", "appServer"],
          cwd: "/tmp/food",
          searchTerm: "fix bug",
          limit: 5,
          useStateDbOnly: true,
        });
        return {
          data: [{
            id: "thr_external",
            preview: "Fix bug from CLI",
            source: "cli",
            cwd: "/tmp/food",
            status: { type: "idle" },
            updatedAt: 1_757_030_400,
          }],
          nextCursor: null,
          backwardsCursor: null,
        };
      }),
      readThread,
      close: vi.fn(async () => {}),
    };
    const runtime = new FeishuSqliteCodexRuntime(config, {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createCodexAppServerClient: () => client,
    });
    const updateCard = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ messageId: "thread-card" }));
    (runtime as any).channel = { updateCard, send };
    (runtime as any).schedulePump = vi.fn();

    await (runtime as any).handleDirectControlCommand({
      sourceEventId: "evt-threads",
      eventType: "im.message.receive_v1",
      messageId: "om-threads",
      chatId: "oc-chat",
      chatType: "p2p",
      senderId: "ou-user",
      text: "/threads --project food --search \"fix bug\" --limit 5",
      sessionKey: "chat:oc-chat",
    }, "threads", "--project food --search \"fix bug\" --limit 5");

    expect(client.listThreads).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    const entries = db.getDueOutbox(10, ["feishu.send_card"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload_json).toContain("Codex Threads");
    expect(entries[0]?.payload_json).toContain("thr_external");
    expect(entries[0]?.payload_json).toContain("Fix bug from CLI");
    const listCard = JSON.parse(entries[0]!.payload_json).card;
    const nativeRow = listCard.body.elements.find((element: any) => element.element_id === "threads_native_row_0");
    expect(nativeRow.columns[0].elements[2].columns[0].elements[0]).toMatchObject({
      text: { content: "查看执行" },
      value: {
        kind: "aamp_command",
        command: "thread",
        taskId: "thr_external",
        source: "native_thread",
      },
    });
    await (runtime as any).flushOutbox();
    send.mockClear();
    updateCard.mockClear();

    await (runtime as any).handleGlobalCardAction({
      messageId: "threads-card",
      chatId: "oc-chat",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: nativeRow.columns[0].elements[2].columns[0].elements[0].value,
      },
    });
    expect(readThread).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 10 && !readThread.mock.calls.length; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(readThread).toHaveBeenCalledWith("thr_external", true);
    await (runtime as any).flushOutbox();
    expect(send).toHaveBeenCalledTimes(1);
    expect(updateCard).not.toHaveBeenCalled();
    const detailCard = send.mock.calls[0][1].card;
    const refreshButton = detailCard.body.elements
      .find((element: any) => element.element_id === "thread_detail_actions")
      .columns[0].elements[0];
    expect(refreshButton).toMatchObject({
      text: { content: "刷新详情" },
      value: { source: "native_thread_detail", taskId: "thr_external" },
    });
    await (runtime as any).handleGlobalCardAction({
      messageId: "thread-card",
      chatId: "oc-chat",
      operator: { openId: "ou-user" },
      action: { tag: "button", value: refreshButton.value },
    });
    for (let attempt = 0; attempt < 10 && readThread.mock.calls.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await (runtime as any).flushOutbox();
    expect(updateCard).toHaveBeenCalledWith(
      "thread-card",
      expect.objectContaining({ body: expect.objectContaining({ elements: expect.any(Array) }) }),
    );
    db.close();
  });
});
