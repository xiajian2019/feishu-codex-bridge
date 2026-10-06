import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { DIRECT_RUNTIME_LEASE_NAME } from "../src/feishu-sqlite-codex.js";
import { DatabaseSync } from "../src/sqlite.js";
import { readSystemHealth } from "../src/system-health.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

describe("read-only system health", () => {
  it("separates task execution errors from Feishu delivery and reports queue age without changing state", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-health-test-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "bridge.db");
    const now = new Date("2026-10-05T10:00:00.000Z");
    const db = new StateDatabase(path, () => now);
    cleanup.push(() => db.close());
    const direct = db.ingestDirectMessage({
      sourceEventId: "health-event", eventType: "im.message.receive_v1", messageId: "health-message",
      chatId: "health-chat", chatType: "p2p", senderId: "health-user", text: "health task", sessionKey: "chat:health-chat",
    }).task;
    const directQueued = db.ingestDirectMessage({
      sourceEventId: "health-queued-event", eventType: "im.message.receive_v1", messageId: "health-queued-message",
      chatId: "health-chat", chatType: "p2p", senderId: "health-user", text: "queued task", sessionKey: "chat:health-queued",
    }).task;
    db.initializeAampTask({ aampTaskId: "aamp-health", chatId: "health-chat", userText: "hello" });
    db.updateAampTask("aamp-health", { status: "failed", errorMsg: "relay error" });
    db.initializeAampTask({ aampTaskId: "aamp-pending", chatId: "health-chat", userText: "pending task" });
    db.createCodexHistoryRun({
      runId: "history-run", homeId: "home", threadId: "thread", requestFingerprint: "a".repeat(64),
      turnIndex: 0, attachments: [{ attachmentId: "history-file", fileName: "image.png", mimeType: "image/png", sizeBytes: 2048 }],
      createdAt: now.getTime(), updatedAt: now.getTime(), state: "completed", cursor: 1,
    });
    db.acquireRuntimeLease(DIRECT_RUNTIME_LEASE_NAME, "health-worker", 30_000);
    db.createStagedWebTaskAttachment({ attachmentId: "staged", fileName: "staged.txt", mimeType: "text/plain", sizeBytes: 1024, localPath: join(root, "staged.txt") });
    const sql = new DatabaseSync(path);
    try {
      sql.prepare(`INSERT INTO tasks
        (task_guid, origin, project_key, mode, repo, state, input_text, input_hash, created_at, updated_at)
        VALUES (?, 'web', 'fixture', 'implement', ?, 'QUEUED', 'queued', 'hash', ?, ?)`)
        .run("desk-queued", root, "2026-10-05T08:00:00.000Z", "2026-10-05T09:30:00.000Z");
      sql.prepare("UPDATE bridge_tasks SET status = 'FAILED', error = 'execution error' WHERE bridge_task_id = ?")
        .run(direct.bridge_task_id);
      sql.prepare("UPDATE bridge_tasks SET created_at = ?, updated_at = ? WHERE bridge_task_id = ?")
        .run("2026-10-05T08:00:00.000Z", "2026-10-05T09:45:00.000Z", directQueued.bridge_task_id);
      sql.prepare("UPDATE aamp_tasks SET created_at = ?, updated_at = ? WHERE aamp_task_id = ?")
        .run("2026-10-05T08:00:00.000Z", "2026-10-05T09:50:00.000Z", "aamp-pending");
      sql.prepare("UPDATE aamp_tasks SET image_local_paths = ? WHERE aamp_task_id = ?")
        .run(JSON.stringify([join(root, "one.png")]), "aamp-pending");
      sql.prepare("UPDATE web_task_attachments SET created_at = ? WHERE attachment_id = 'staged'")
        .run("2026-10-03T09:00:00.000Z");
      const before = (sql.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
      const snapshot = await readSystemHealth({ databasePath: path, mode: "feishu-sqlite-codex", version: "fixture", codexCliPath: join(root, "missing-codex"), now });
      const after = (sql.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
      expect(snapshot.mode).toBe("feishu-sqlite-codex");
      expect(snapshot.version).toBe("fixture");
      expect(snapshot.database.available).toBe(true);
      expect(snapshot.dependencies).toEqual({ configuredCodexCli: "unavailable", feishuNetwork: "not_checked" });
      expect(snapshot.tasks.desk.QUEUED).toBe(1);
      expect(snapshot.tasks.direct.FAILED).toBe(1);
      expect(snapshot.tasks.aamp.failed).toBe(1);
      expect(snapshot.tasks.oldestDeskQueuedAt).toBe("2026-10-05T09:30:00.000Z");
      expect(snapshot.tasks.oldestDirectQueuedAt).toBe("2026-10-05T09:45:00.000Z");
      expect(snapshot.tasks.oldestAampPendingAt).toBe("2026-10-05T09:50:00.000Z");
      expect(snapshot.runtimeLease.state).toBe("active");
      expect(snapshot.recentErrors.map((error) => error.source).sort()).toEqual(["aamp", "direct"]);
      expect(snapshot.outbox.pending).toBeGreaterThan(0);
      expect(snapshot.storage.webStaged).toEqual({ count: 1, bytes: 1024, expiredCount: 1, expiredBytes: 1024 });
      expect(snapshot.storage.historyRetained).toEqual({ count: 1, declaredBytes: 2048, truncated: false });
      expect(snapshot.storage.aampReferencedImageCount).toBe(1);
      expect(after).toBe(before);
    } finally {
      sql.close();
    }
  });
});
