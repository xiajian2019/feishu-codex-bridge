import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@larksuiteoapi/node-sdk";

import { parseConfig } from "../src/config.js";
import { StateDatabase } from "../src/db.js";
import {
  FeishuSqliteCodexRuntime,
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

  it("resolves task headers before defaults and supports a single registry entry", () => {
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
      projectKey: "food",
      modeKey: "implement",
    });
    expect(resolveDirectTaskRoute("修复问题", {
      ...config,
      direct: { ...config.direct, projectKey: undefined, mode: undefined },
      projects: {},
      modes: {},
    })).toMatchObject({ ok: false });
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

  it("resolves direct projects from the shared Codex project map", () => {
    const directory = mkdtempSync(join(tmpdir(), "direct-project-map-"));
    const projectMapPath = join(directory, "project-map.yaml");
    writeFileSync(projectMapPath, `projects:\n  feishu-codex-bridge:\n    root: ${process.cwd()}\n`);
    try {
      const mappedConfig = {
        ...config,
        aamp: {
          ...config.aamp,
          worktree: {
            enabled: true,
            projectMapPath,
            globalAgentsPath: join(directory, "AGENTS.md"),
            taskDir: join(directory, "tasks"),
            worktreeRoot: join(directory, "worktrees"),
            baseRef: "HEAD",
            branchPrefix: "test/agent",
          },
        },
        projects: { food: config.projects.food },
      };
      expect(resolveDirectTaskRoute("项目：feishu-codex-bridge\n模式：implement\n查看状态", mappedConfig)).toMatchObject({
        ok: true,
        projectKey: "feishu-codex-bridge",
        project: { repo: process.cwd() },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain("接入模式：Codex 直连");

    const send = (runtime as any).channel.send as ReturnType<typeof vi.fn>;
    await (runtime as any).handleGlobalCardAction({
      messageId: "global-card",
      chatId: "oc-chat",
      operator: { openId: "ou-user" },
      action: {
        tag: "button",
        value: { kind: "aamp_command", command: "progress", taskId: direct.bridge_task_id },
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0][1].card)).toContain("最新执行进度");
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
});
