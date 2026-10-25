import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { DEFAULT_SHORTCUTS } from "../src/tmux-shortcut-defaults.js";
import { DEFAULT_COMPOSER_SHORTCUTS, parseTerminalSequence } from "../web/src/tmux-shortcuts.js";

const databases: StateDatabase[] = [];
const servers: DashboardServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const database of databases.splice(0)) database.close();
});

describe("SQLite shortcut configuration", () => {
  test("seeds current groups and records atomic operation counts", () => {
    const database = new StateDatabase(":memory:");
    databases.push(database);
    const config = database.getShortcutConfig();
    expect(config.groups.map((group) => group.id)).toEqual(["favorites", "codex-tui", "tmux", "codex", "ctrl", "keyboard", "composer"]);
    expect(config.shortcuts.filter((shortcut) => shortcut.group_id === "composer")).toHaveLength(18);
    expect(config.shortcuts.filter((shortcut) => shortcut.group_id === "tmux").map((shortcut) => shortcut.id)).toContain("command-tmuxctl");
    expect(config.shortcuts.filter((shortcut) => shortcut.group_id === "tmux").map((shortcut) => shortcut.id)).toContain("tmux-resize-pane-5-right");
    expect(config.shortcuts.filter((shortcut) => shortcut.group_id === "codex").map((shortcut) => shortcut.value)).toContain("/keymap");
    expect(config.shortcuts.filter((shortcut) => shortcut.group_id === "codex").map((shortcut) => shortcut.value)).toContain("proxyctl");
    expect(config.shortcuts.length).toBeGreaterThan(130);
    const target = config.shortcuts.find((shortcut) => shortcut.id === "favorite-git-status")!;
    expect(database.recordShortcutUse(target.id)?.operation_count).toBe(1);
    expect(database.recordShortcutUse(target.id)?.operation_count).toBe(2);

    const codexShortcuts = database.listShortcuts("codex");
    const lastCodexShortcut = codexShortcuts[codexShortcuts.length - 1]!;
    const movedCodexShortcut = database.moveShortcutToEdge(lastCodexShortcut.id, "start")!;
    expect(database.listShortcuts("codex")[0]?.id).toBe(lastCodexShortcut.id);
    expect(movedCodexShortcut.sort_order).toBeLessThan(codexShortcuts[0]!.sort_order);
  });

  test("puts answer, return and warnings on the first TUI page with navigation keys", () => {
    const database = new StateDatabase(":memory:");
    databases.push(database);
    const firstPage = database.listShortcuts("codex-tui").slice(0, 8);
    expect(firstPage.map((shortcut) => shortcut.value)).toEqual([
      "Shift+Left", "Shift+Right", "F2", "codex-escape", "codex-up", "codex-down", "codex-enter", "codex-tab",
    ]);
    expect(firstPage.slice(0, 3).map((shortcut) => parseTerminalSequence(shortcut.value)))
      .toEqual(["\u001b[1;2D", "\u001b[1;2C", "\u001bOQ"]);
    const fallbackControls = DEFAULT_COMPOSER_SHORTCUTS.filter((shortcut) => shortcut.id.startsWith("composer-tui-"));
    for (const control of fallbackControls) {
      expect(database.getShortcut(control.id)).toMatchObject({
        value: control.value, action_key: control.actionKey, display_mode: control.displayMode,
      });
    }
  });

  test("upgrades old TUI keys once while preserving custom ordering, labels and disabled keys", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-tui-shortcut-upgrade-"));
    const path = join(root, "fixture.db");
    const now = () => new Date("2026-10-22T00:00:00Z");
    let database = new StateDatabase(path, now);
    try {
      const tuiIds = DEFAULT_SHORTCUTS.filter((shortcut) => shortcut.groupId === "codex-tui" && shortcut.id.startsWith("codex-key-"));
      for (const shortcut of tuiIds) {
        database.updateShortcut(shortcut.id, { groupId: "codex", sortOrder: DEFAULT_SHORTCUTS.indexOf(shortcut) });
      }
      database.updateShortcut("codex-key-edit-queued", { detail: "编辑上一条排队消息" });
      database.updateShortcut("codex-key-warnings", { title: "自定义警告", detail: "保留说明", sortOrder: -20, enabled: false });
      database.recordShortcutUse("codex-key-warnings");
      const customGroup = database.createShortcutGroup({ title: "我的按键", icon: "K" });
      database.updateShortcut("codex-key-copy", { groupId: customGroup.id });
      database.close();

      database = new StateDatabase(path, now);
      expect(database.getShortcut("codex-key-edit-queued")).toMatchObject({ group_id: "codex-tui", sort_order: 0, detail: "回答待处理问题 / 编辑排队消息" });
      expect(database.getShortcut("codex-key-warnings")).toMatchObject({ group_id: "codex-tui", title: "自定义警告", detail: "保留说明", sort_order: -20, enabled: false, operation_count: 1 });
      expect(database.getShortcut("codex-key-copy")?.group_id).toBe(customGroup.id);
      const config = database.getShortcutConfig();
      database.close();
      database = new StateDatabase(path, now);
      expect(database.getShortcutConfig()).toEqual(config);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serves CRUD and use-count APIs", async () => {
    const database = new StateDatabase(":memory:");
    databases.push(database);
    const server = new DashboardServer({ db: database, host: "127.0.0.1", port: 0, modes: [] });
    servers.push(server);
    const baseUrl = await server.start();
    const session = await fetch(baseUrl + "/api/session").then((response) => response.json()) as { actionToken: string };
    const headers = { "Content-Type": "application/json", "X-Bridge-Action-Token": session.actionToken };
    const initialConfig = await fetch(baseUrl + "/api/shortcut-config").then((response) => response.json()) as { revision: string; groups: Array<{ id: string; surface: string }>; shortcuts: Array<{ id: string; groupId: string; sortOrder: number }> };
    expect(initialConfig.revision).toMatch(/^[0-9a-f]{64}$/);
    const composerGroup = initialConfig.groups.find((group) => group.surface === "composer")!;
    const composerShortcutResponse = await fetch(baseUrl + "/api/shortcuts", {
      method: "POST",
      headers,
      body: JSON.stringify({ groupId: composerGroup.id, title: "自定义文件", detail: "custom", kind: "insert", value: "", actionKey: "session-files", displayMode: "closed" }),
    });
    expect(composerShortcutResponse.status).toBe(201);
    const revisionAfterCreate = await fetch(baseUrl + "/api/shortcut-config/revision")
      .then((response) => response.json()) as { revision: string };
    expect(revisionAfterCreate.revision).not.toBe(initialConfig.revision);

    const groupResponse = await fetch(baseUrl + "/api/shortcut-groups", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "测试分组", icon: "✦", description: "测试", layout: "grid" }),
    });
    expect(groupResponse.status).toBe(201);
    const group = (await groupResponse.json() as { group: { id: string } }).group;

    const shortcutResponse = await fetch(baseUrl + "/api/shortcuts", {
      method: "POST",
      headers,
      body: JSON.stringify({ groupId: group.id, title: "hello", detail: "test", kind: "send", value: "echo hello" }),
    });
    expect(shortcutResponse.status).toBe(201);
    const shortcut = (await shortcutResponse.json() as { shortcut: { id: string; operationCount: number } }).shortcut;
    expect(shortcut.operationCount).toBe(0);

    const reorderResponse = await fetch(baseUrl + `/api/shortcuts/${encodeURIComponent(shortcut.id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sortOrder: 17 }),
    });
    expect(reorderResponse.status).toBe(200);
    expect((await reorderResponse.json() as { shortcut: { sortOrder: number } }).shortcut.sortOrder).toBe(17);

    const secondShortcutResponse = await fetch(baseUrl + "/api/shortcuts", {
      method: "POST",
      headers,
      body: JSON.stringify({ groupId: group.id, title: "world", detail: "test", kind: "send", value: "echo world" }),
    });
    expect(secondShortcutResponse.status).toBe(201);
    const secondShortcut = (await secondShortcutResponse.json() as { shortcut: { id: string; sortOrder: number } }).shortcut;
    const moveToStartResponse = await fetch(baseUrl + `/api/shortcuts/${encodeURIComponent(secondShortcut.id)}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ position: "start" }),
    });
    expect(moveToStartResponse.status).toBe(200);
    expect((await moveToStartResponse.json() as { shortcut: { sortOrder: number } }).shortcut.sortOrder).toBeLessThan(17);
    expect(database.getShortcut(shortcut.id)?.sort_order).toBe(17);

    const useResponse = await fetch(baseUrl + `/api/shortcuts/${encodeURIComponent(shortcut.id)}/use`, {
      method: "POST",
      headers,
    });
    expect(useResponse.status).toBe(200);
    expect((await useResponse.json() as { shortcut: { operationCount: number } }).shortcut.operationCount).toBe(1);

    const config = await fetch(baseUrl + "/api/shortcut-config").then((response) => response.json()) as { revision: string; groups: Array<{ id: string }>; shortcuts: Array<{ id: string }> };
    expect(config.revision).toBe((await fetch(baseUrl + "/api/shortcut-config/revision")
      .then((response) => response.json()) as { revision: string }).revision);
    expect(config.groups.some((item) => item.id === group.id)).toBe(true);
    expect(config.shortcuts.some((item) => item.id === shortcut.id)).toBe(true);
  });
});
