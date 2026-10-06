import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearAllTaskCreateDrafts,
  clearTaskCreateDraft,
  loadLastTaskCreateProjectKey,
  loadTaskCreateDraft,
  saveTaskCreateDraft,
} from "../web/src/task-create-draft-store.js";
import { saveCodexHistoryDraft } from "../web/src/codex-history-draft-store.js";
import { clearLocalDraftsAfterDeviceRevocation } from "../web/src/local-draft-cleanup.js";
import { setLocalDraftScope } from "../web/src/local-draft-scope.js";

const oneWeekMs = 7 * 24 * 60 * 60 * 1_000;
const scopeA = "a".repeat(43);
const scopeB = "b".repeat(43);
let originalWindow: PropertyDescriptor | undefined;
let originalNow: typeof Date.now;
let values: Map<string, string>;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  originalNow = Date.now;
  values = new Map();
  const storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  } as Storage;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  setLocalDraftScope(scopeA);
  Date.now = () => 10_000;
});

afterEach(() => {
  setLocalDraftScope(null);
  Date.now = originalNow;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("Task Desk create-form draft storage", () => {
  test("isolates descriptions by project and does not persist staged attachment IDs", () => {
    saveTaskCreateDraft("project-a", "Draft A", true);
    saveTaskCreateDraft("project-b", "Draft B", false);

    expect(loadTaskCreateDraft("project-a")?.description).toBe("Draft A");
    expect(loadTaskCreateDraft("project-b")?.description).toBe("Draft B");
    expect(loadLastTaskCreateProjectKey()).toBe("project-b");
    expect([...values.values()].join(" ")).not.toContain("attachmentIds");
    expect([...values.values()].join(" ")).not.toContain("staged-attachment-id");
    expect(loadTaskCreateDraft("project-a")?.hadStagedAttachments).toBe(true);
  });

  test("expires idle drafts and clears a confirmed project draft", () => {
    saveTaskCreateDraft("project-a", "Expired draft", false);
    Date.now = () => 10_000 + oneWeekMs + 1;
    expect(loadTaskCreateDraft("project-a")).toBeNull();

    saveTaskCreateDraft("project-a", "Submitted draft", false);
    clearTaskCreateDraft("project-a");
    expect(loadTaskCreateDraft("project-a")).toBeNull();
  });

  test("device-revocation cleanup removes only task and Codex History drafts", async () => {
    saveTaskCreateDraft("project-a", "Task draft", false);
    await saveCodexHistoryDraft(`${scopeA}|home-a/thread-a`, "History draft", []);
    values.set("feishu-codex-bridge:tmux-draft:session-a", "keep tmux draft");
    values.set("feishu-codex-bridge.codex-history-home", "home-a");
    values.set("feishu-codex-bridge.shortcut-config.v1", "keep shortcut config");

    await clearLocalDraftsAfterDeviceRevocation();

    expect(loadTaskCreateDraft("project-a")).toBeNull();
    expect(values.has("feishu-codex-bridge:codex-history-draft:v2:" + encodeURIComponent(`${scopeA}|home-a/thread-a`))).toBe(false);
    expect(values.get("feishu-codex-bridge:tmux-draft:session-a")).toBe("keep tmux draft");
    expect(values.get("feishu-codex-bridge.codex-history-home")).toBe("home-a");
    expect(values.get("feishu-codex-bridge.shortcut-config.v1")).toBe("keep shortcut config");

    clearAllTaskCreateDrafts();
  });

  test("does not read or clear another device scope", async () => {
    saveTaskCreateDraft("project-a", "device A", false);
    await saveCodexHistoryDraft(`${scopeA}|home/thread`, "history A", []);
    setLocalDraftScope(scopeB);
    expect(loadTaskCreateDraft("project-a")).toBeNull();
    saveTaskCreateDraft("project-a", "device B", false);
    await clearLocalDraftsAfterDeviceRevocation();
    expect(loadTaskCreateDraft("project-a")).toBeNull();
    setLocalDraftScope(scopeA);
    expect(loadTaskCreateDraft("project-a")?.description).toBe("device A");
    expect([...values.values()].join(" ")).toContain("history A");
    setLocalDraftScope(null);
    expect(loadTaskCreateDraft("project-a")).toBeNull();
    saveTaskCreateDraft("project-c", "must not persist", false);
    expect([...values.values()].join(" ")).not.toContain("must not persist");
  });
});
