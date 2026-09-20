import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

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
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("escapes local notification text for AppleScript", () => {
    expect(buildMacNotificationScript('Codex "完成"', "第一行\n第二行\\路径")).toBe(
      'display notification "第一行 第二行\\\\路径" with title "Codex \\"完成\\""',
    );
  });
});
