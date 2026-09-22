import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "bun:test";

import type { CodexThread, CodexAppServerQueryClient } from "../src/codex-app-server.js";
import {
  buildMacNotificationScript,
  LocalCodexNotificationWatcher,
} from "../src/local-codex-notifications.js";

describe("local Codex notifications", () => {
  it("baselines App/CLI threads and notifies once after active becomes idle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-local-notify-"));
    const sendNotification = vi.fn(async () => undefined);
    let threads: CodexThread[] = [{
      id: "thr-cli-notify",
      source: "cli",
      status: { type: "active" },
      preview: "CLI 任务",
      updatedAt: 100,
    }];
    const client: CodexAppServerQueryClient = {
      listThreads: vi.fn(async () => ({
        data: threads,
        nextCursor: null,
        backwardsCursor: null,
      })),
      close: vi.fn(async () => undefined),
    };
    const watcher = new LocalCodexNotificationWatcher({
      createClient: () => client,
      statePath: join(directory, "state.json"),
      sendNotification,
    });
    try {
      await watcher.pollOnce();
      expect(sendNotification).not.toHaveBeenCalled();

      threads = [{ ...threads[0], status: { type: "idle" }, updatedAt: 101 }];
      await watcher.pollOnce();
      await watcher.pollOnce();

      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith(
        "Codex CLI任务已完成",
        expect.stringContaining("CLI 任务"),
        "cli",
      );
      expect(client.close).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("observes appServer threads and reports system errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-app-notify-"));
    const sendNotification = vi.fn(async () => undefined);
    let threads: CodexThread[] = [{
      id: "thr-app-notify",
      source: "appServer",
      status: { type: "active" },
      preview: "App 任务",
      updatedAt: 200,
    }];
    const watcher = new LocalCodexNotificationWatcher({
      createClient: () => ({
        listThreads: async () => ({ data: threads, nextCursor: null, backwardsCursor: null }),
        close: async () => undefined,
      }),
      statePath: join(directory, "state.json"),
      sendNotification,
    });
    try {
      await watcher.pollOnce();
      threads = [{ ...threads[0], status: { type: "systemError" }, updatedAt: 201 }];
      await watcher.pollOnce();
      expect(sendNotification).toHaveBeenCalledWith(
        "Codex App任务失败",
        expect.stringContaining("App 任务"),
        "appServer",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat notLoaded as complete and notifies after a later idle transition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-updated-notify-"));
    const sendNotification = vi.fn(async () => undefined);
    const updatedAt = Math.floor(Date.now() / 1_000);
    let threads: CodexThread[] = [{
      id: "thr-cli-updated",
      source: "cli",
      status: { type: "active" },
      preview: "短任务",
      updatedAt,
    }];
    const watcher = new LocalCodexNotificationWatcher({
      createClient: () => ({
        listThreads: async () => ({ data: threads, nextCursor: null, backwardsCursor: null }),
        close: async () => undefined,
      }),
      statePath: join(directory, "state.json"),
      sendNotification,
    });
    try {
      await watcher.pollOnce();
      threads = [{ ...threads[0], status: { type: "notLoaded" }, updatedAt: updatedAt + 1 }];
      await watcher.pollOnce();
      expect(sendNotification).not.toHaveBeenCalled();

      threads = [{ ...threads[0], status: { type: "active" }, updatedAt: updatedAt + 2 }];
      await watcher.pollOnce();
      threads = [{ ...threads[0], status: { type: "idle" }, updatedAt: updatedAt + 3 }];
      await watcher.pollOnce();
      threads = [{ ...threads[0], updatedAt: updatedAt + 4 }];
      await watcher.pollOnce();
      expect(sendNotification).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("escapes local notification text for JXA", () => {
    expect(buildMacNotificationScript('Codex "完成"', "第一行\n第二行\\路径")).toBe(
      'const app = Application.currentApplication();\n'
        + 'app.includeStandardAdditions = true;\n'
        + 'app.displayNotification("第一行 第二行\\\\路径", { withTitle: "Codex \\"完成\\"" });',
    );
  });
});
