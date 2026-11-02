import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "bun:test";

import {
  NOTIFICATION_SUPPRESSION_WINDOW_MS,
  NotificationSuppressionStore,
  notificationSuppressionKey,
} from "../src/notification-suppression.js";

describe("notification suppression", () => {
  it("allows the same notification once per minute across store instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-notification-suppression-"));
    let now = 1_000_000;
    const path = join(directory, "suppression.json");
    const key = notificationSuppressionKey({
      threadId: "thread-1",
      turnId: "turn-1",
      source: "cli",
      detail: "任务完成",
    });
    try {
      const first = new NotificationSuppressionStore({ path, now: () => now });
      const second = new NotificationSuppressionStore({ path, now: () => now });
      expect((await Promise.all([first.claim(key), second.claim(key)])).sort()).toEqual([false, true]);

      now += NOTIFICATION_SUPPRESSION_WINDOW_MS - 1;
      expect(await first.claim(key)).toBe(false);
      now += 1;
      expect(await second.claim(key)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
