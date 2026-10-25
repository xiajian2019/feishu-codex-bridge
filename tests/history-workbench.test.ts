import { describe, expect, test } from "bun:test";

import {
  buildForwardedHistoryText,
  createHistoryQueueDraftSubmitter,
  extractHistoryMessages,
  extractHistoryTemplateVariables,
  exactHistoryProjectMatches,
  fillHistoryTemplate,
  historyActionKind,
  historyActionPermissions,
  historyActionElicitationSchema,
  historyActionQuestions,
  historyActionSummary,
  historyBookmarkStorageKey,
  historyTaskDraftNavigationState,
  historyPreferenceKey,
  historyTarget,
  loadHistoryBookmarks,
  normalizeHistoryPreference,
  normalizeHistoryTags,
  normalizeProjectPath,
  organizeHistoryItems,
  saveHistoryBookmarks,
  toggleHistoryBookmark,
  type HistoryQueueMessage,
  type HistoryWorkbenchAction,
  type HistoryWorkbenchPreference,
} from "../web/src/history-workbench.js";

describe("History workbench helpers", () => {
  test("normalizes tags and fills missing preferences with safe defaults", () => {
    expect(normalizeHistoryTags(" 项目 进度,项目 进度, 待回访 ")).toEqual(["项目 进度", "待回访"]);
    expect(normalizeHistoryPreference(historyTarget("home-a", "thread-a"))).toEqual({
      target: historyTarget("home-a", "thread-a"),
      pinned: false,
      tags: [],
      unread: false,
      keepAttention: false,
    });
  });

  test("filters and sorts only the current page using persisted thread preferences", () => {
    const items = [
      { home: { id: "home-a", label: "A" }, thread: { id: "recent", updatedAt: 300 } },
      { home: { id: "home-a", label: "A" }, thread: { id: "pinned", updatedAt: 100 } },
      { home: { id: "home-b", label: "B" }, thread: { id: "other", updatedAt: 200 } },
    ] as const;
    const preferences = new Map<string, HistoryWorkbenchPreference>([
      [historyPreferenceKey(historyTarget("home-a", "pinned")), normalizeHistoryPreference(historyTarget("home-a", "pinned"), { pinned: true, tags: ["release"], unread: true })],
      [historyPreferenceKey(historyTarget("home-b", "other")), normalizeHistoryPreference(historyTarget("home-b", "other"), { keepAttention: true })],
    ]);

    expect(organizeHistoryItems([...items], preferences, { sort: "pinned" }).map((item) => item.thread.id))
      .toEqual(["pinned", "recent", "other"]);
    expect(organizeHistoryItems([...items], preferences, { filter: "unread" }).map((item) => item.thread.id))
      .toEqual(["pinned"]);
    expect(organizeHistoryItems([...items], preferences, { filter: "attention" }).map((item) => item.thread.id))
      .toEqual(["other"]);
    expect(organizeHistoryItems([...items], preferences, { tag: "RELEASE" }).map((item) => item.thread.id))
      .toEqual(["pinned"]);
  });

  test("extracts stable message anchors and forwards only selected messages in transcript order", () => {
    const messages = extractHistoryMessages({
      id: "thread-1",
      turns: [
        { items: [
          { type: "userMessage", text: "Please inspect this." },
          { type: "agentMessage", text: "I found two details." },
        ] },
        { items: [
          { type: "user_message", content: [{ type: "text", text: "What changed?" }] },
          { type: "assistant_message", content: "The file changed." },
        ] },
      ],
    });

    expect(messages.map((message) => message.id)).toEqual([
      "thread-1-turn-0-user-0",
      "thread-1-turn-0-assistant",
      "thread-1-turn-1-user-0",
      "thread-1-turn-1-assistant",
    ]);
    expect(buildForwardedHistoryText(messages, new Set([messages[1]!.id, messages[2]!.id]), "Review"))
      .toContain("转发自会话「Review」\n\nCodex：\nI found two details.\n\n---\n\n用户：\nWhat changed?");
    expect(buildForwardedHistoryText(messages, new Set(), "Review")).toBe("");
  });

  test("keeps message bookmarks scoped to the local installation and device", () => {
    const target = historyTarget("home-a", "thread-a");
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const key = historyBookmarkStorageKey("device-scope-one", target);
    expect(key).not.toBe(historyBookmarkStorageKey("device-scope-two", target));

    const next = toggleHistoryBookmark(new Set(), "message-1");
    saveHistoryBookmarks("device-scope-one", target, next, storage);
    expect([...loadHistoryBookmarks("device-scope-one", target, storage)]).toEqual(["message-1"]);
    expect([...loadHistoryBookmarks("device-scope-two", target, storage)]).toEqual([]);
  });

  test("maps native approval and structured question actions without guessing unknown fields", () => {
    const approval: HistoryWorkbenchAction = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "bun test" },
    };
    const question: HistoryWorkbenchAction = {
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        questions: [{ id: "scope", question: "Which files?", options: [{ label: "UI", value: "ui" }] }],
      },
    };
    const unknown: HistoryWorkbenchAction = { id: "other-1", kind: "custom-action" };
    const pendingWorkbenchQuestion: HistoryWorkbenchAction = {
      id: "question-2",
      type: "question",
      payload: {
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "intent", header: "Intent", question: "What should change?" }] },
      },
    };
    const storedApproval: HistoryWorkbenchAction = {
      id: "approval-2",
      type: "approval",
      payload: { method: "item/commandExecution/requestApproval", params: { command: "bun run build" } },
    };
    const permissions: HistoryWorkbenchAction = {
      id: "permissions-1",
      type: "approval",
      payload: { method: "item/permissions/requestApproval", params: { permissions: { network: true } } },
    };
    const elicitation: HistoryWorkbenchAction = {
      id: "elicitation-1",
      type: "question",
      payload: { method: "mcpServer/elicitation/request", params: { requestedSchema: { type: "object" } } },
    };

    expect(historyActionKind(approval)).toBe("approval");
    expect(historyActionSummary(approval)).toBe("bun test");
    expect(historyActionKind(question)).toBe("question");
    expect(historyActionQuestions(question)).toEqual([{ id: "scope", prompt: "Which files?", options: [{ value: "ui", label: "UI" }] }]);
    expect(historyActionKind(unknown)).toBe("other");
    expect(historyActionQuestions(pendingWorkbenchQuestion)).toEqual([{ id: "intent", prompt: "What should change?", options: [] }]);
    expect(historyActionKind(storedApproval)).toBe("approval");
    expect(historyActionSummary(storedApproval)).toBe("bun run build");
    expect(historyActionKind(permissions)).toBe("permissions");
    expect(historyActionPermissions(permissions)).toEqual({ network: true });
    expect(historyActionKind(elicitation)).toBe("elicitation");
    expect(historyActionElicitationSchema(elicitation)).toEqual({ type: "object" });
  });

  test("requires all template variables to be filled before producing draft text", () => {
    const template = "Review {{project}} for {{risk}}; compare {{project}} with main.";
    expect(extractHistoryTemplateVariables(template)).toEqual(["project", "risk"]);
    expect(fillHistoryTemplate(template, { project: "Bridge", risk: "data loss" }))
      .toBe("Review Bridge for data loss; compare Bridge with main.");
    expect(fillHistoryTemplate(template, { project: "Bridge", risk: " " })).toBeNull();
    expect(fillHistoryTemplate("Inspect {{ }}", {})).toBeNull();
  });

  test("retries a saved queue draft with its original key after losing the response", async () => {
    const target = historyTarget("home-a", "thread-a");
    const saved = new Map<string, HistoryQueueMessage>();
    const requestKeys: string[] = [];
    let loseResponse = true;
    const submit = createHistoryQueueDraftSubmitter(async (input) => {
      requestKeys.push(input.idempotencyKey);
      const key = JSON.stringify([input.target, input.idempotencyKey]);
      const message = saved.get(key) ?? { id: `message-${saved.size + 1}`, text: input.text, status: "queued" as const };
      saved.set(key, message);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after save");
      }
      return { message };
    });

    await expect(submit(target, "inspect the diff")).rejects.toThrow("response lost after save");
    expect(saved.size).toBe(1);
    expect((await submit(target, "  inspect the diff  ")).message.id).toBe("message-1");
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(saved.size).toBe(1);

    await submit(historyTarget("home-b", "thread-a"), "inspect the diff");
    expect(requestKeys[2]).not.toBe(requestKeys[0]);
    expect(saved.size).toBe(2);
    await submit(target, "inspect the diff");
    expect(requestKeys[3]).not.toBe(requestKeys[0]);
    expect(saved.size).toBe(3);
  });

  test("coalesces simultaneous submissions of the same queue draft", async () => {
    let requests = 0;
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const submit = createHistoryQueueDraftSubmitter(async (input) => {
      requests += 1;
      await wait;
      return { message: { id: "message-one", text: input.text, status: "queued" } };
    });
    const target = historyTarget("home-a", "thread-a");
    const first = submit(target, "inspect the diff");
    const second = submit(target, "inspect the diff");
    expect(second).toBe(first);
    release!();
    expect((await second).message.id).toBe("message-one");
    expect(requests).toBe(1);
  });

  test("matches a History cwd only to an available project with the exact normalized path", () => {
    const projects = [
      { name: "bridge", path: "/work/bridge/", status: "available", available: true },
      { name: "bridge-child", path: "/work/bridge-child", status: "available", available: true },
      { name: "disabled", path: "/work/bridge", status: "disabled", available: false },
    ] as const;
    expect(normalizeProjectPath("\\work\\bridge\\")).toBe("/work/bridge");
    expect(exactHistoryProjectMatches("/work/bridge", [...projects]).map((project) => project.name)).toEqual(["bridge"]);
    expect(exactHistoryProjectMatches("/work/bridge/src", [...projects])).toEqual([]);
    expect(historyTaskDraftNavigationState("bridge")).toEqual({
      newTaskDraft: { source: "history", projectKey: "bridge", description: "" },
    });
  });
});
