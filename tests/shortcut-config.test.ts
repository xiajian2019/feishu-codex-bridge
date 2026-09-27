import { afterEach, describe, expect, test } from "bun:test";

import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";

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
    expect(config.groups.map((group) => group.id)).toEqual(["favorites", "tmux", "codex", "ctrl", "keyboard"]);
    expect(config.shortcuts.length).toBeGreaterThan(60);
    const target = config.shortcuts.find((shortcut) => shortcut.id === "favorite-git-status")!;
    expect(database.recordShortcutUse(target.id)?.operation_count).toBe(1);
    expect(database.recordShortcutUse(target.id)?.operation_count).toBe(2);
  });

  test("serves CRUD and use-count APIs", async () => {
    const database = new StateDatabase(":memory:");
    databases.push(database);
    const server = new DashboardServer({ db: database, host: "127.0.0.1", port: 0, modes: [] });
    servers.push(server);
    const baseUrl = await server.start();
    const session = await fetch(baseUrl + "/api/session").then((response) => response.json()) as { actionToken: string };
    const headers = { "Content-Type": "application/json", "X-Bridge-Action-Token": session.actionToken };

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

    const useResponse = await fetch(baseUrl + `/api/shortcuts/${encodeURIComponent(shortcut.id)}/use`, {
      method: "POST",
      headers,
    });
    expect(useResponse.status).toBe(200);
    expect((await useResponse.json() as { shortcut: { operationCount: number } }).shortcut.operationCount).toBe(1);

    const config = await fetch(baseUrl + "/api/shortcut-config").then((response) => response.json()) as { groups: Array<{ id: string }>; shortcuts: Array<{ id: string }> };
    expect(config.groups.some((item) => item.id === group.id)).toBe(true);
    expect(config.shortcuts.some((item) => item.id === shortcut.id)).toBe(true);
  });
});
