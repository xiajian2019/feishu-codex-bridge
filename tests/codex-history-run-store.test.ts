import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import type { CodexHistoryStoredRun } from "../src/codex-history.js";

function storedRun(runId: string, requestFingerprint = "fingerprint-a"): CodexHistoryStoredRun {
  return {
    runId,
    homeId: "home-a",
    threadId: "thread-a",
    requestFingerprint,
    turnIndex: 2,
    attachments: [],
    createdAt: 100,
    updatedAt: 100,
    state: "running",
    cursor: 0,
  };
}

describe("Codex History run receipts", () => {
  it("keeps an accepted key across a database restart and rejects changed content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-history-run-store-"));
    const path = join(directory, "bridge.db");
    const first = new StateDatabase(path);
    try {
      const run = storedRun("run-a");
      expect(first.createCodexHistoryRun(run, "hashed-key").kind).toBe("created");
      first.saveCodexHistoryRun({ ...run, state: "completed", cursor: 3, updatedAt: 200, finishedAt: 200 });
    } finally {
      first.close();
    }
    const reopened = new StateDatabase(path);
    try {
      expect(reopened.findCodexHistoryRunByKey("home-a", "thread-a", "hashed-key")?.run)
        .toMatchObject({ runId: "run-a", state: "completed", cursor: 3 });
      expect(reopened.createCodexHistoryRun(storedRun("run-b"), "hashed-key"))
        .toMatchObject({ kind: "existing", run: { runId: "run-a" } });
      expect(reopened.createCodexHistoryRun(storedRun("run-c", "different"), "hashed-key").kind)
        .toBe("conflict");
      expect(reopened.listCodexHistoryRuns(10)).toHaveLength(1);
    } finally {
      reopened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a tombstone so expiry cannot execute the same key again", () => {
    const db = new StateDatabase(":memory:");
    try {
      db.createCodexHistoryRun(storedRun("run-a"), "hashed-key");
      db.expireCodexHistoryRun("run-a");
      expect(db.findCodexHistoryRunByKey("home-a", "thread-a", "hashed-key"))
        .toMatchObject({ runId: "run-a", requestFingerprint: "fingerprint-a" });
      expect(db.findCodexHistoryRunByKey("home-a", "thread-a", "hashed-key")?.run).toBeUndefined();
      expect(db.createCodexHistoryRun(storedRun("run-b"), "hashed-key").kind).toBe("expired");
      expect(db.listCodexHistoryRuns(10)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
