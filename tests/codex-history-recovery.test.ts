import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexHistoryService } from "../src/codex-history.js";
import { StateDatabase } from "../src/db.js";

describe("Codex History continuation recovery", () => {
  it("marks a pre-restart active run interrupted and only checks official thread state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-history-interrupted-"));
    const dbPath = join(directory, "bridge.db");
    await writeFile(join(directory, "state_5.sqlite"), "");
    const initial = new StateDatabase(dbPath);
    const homeId = new CodexHistoryService({ executable: "unused-in-test", environment: { CODEX_HOME: directory } })
      .listHomes()[0]!.id;
    initial.createCodexHistoryRun({
      runId: "run-interrupted",
      homeId,
      threadId: "thread-a",
      requestFingerprint: "a".repeat(64),
      turnIndex: 1,
      attachments: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: "running",
      cursor: 2,
    }, "hashed-key");
    initial.close();
    const reopened = new StateDatabase(dbPath);
    let readCalls = 0;
    let sdkCalls = 0;
    try {
      const service = new CodexHistoryService({
        executable: "unused-in-test",
        environment: { CODEX_HOME: directory },
        runStore: reopened,
        createClient: () => ({
          readThread: async (threadId) => {
            readCalls += 1;
            return { thread: { id: threadId, status: { type: "active" } } };
          },
          close: async () => undefined,
        }),
        createAgent: () => {
          sdkCalls += 1;
          throw new Error("SDK must not run during recovery");
        },
      });
      const updates = await service.getMessageUpdates(homeId, "thread-a", "run-interrupted", 0);
      expect(updates).toMatchObject({
        state: "interrupted", resetRequired: true,
        recovery: { codexThreadStatus: "active" },
      });
      expect(readCalls).toBe(1);
      expect(sdkCalls).toBe(0);
      expect(reopened.listCodexHistoryRuns(10)[0]?.state).toBe("interrupted");
    } finally {
      reopened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays one accepted key after restart without calling the SDK again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-history-recovery-"));
    const dbPath = join(directory, "bridge.db");
    await writeFile(join(directory, "state_5.sqlite"), "");
    let sdkCalls = 0;
    let officialReads = 0;
    const options = (runStore: StateDatabase) => ({
      executable: "unused-in-test",
      environment: { CODEX_HOME: directory },
      runStore,
      createClient: () => ({
        readThread: async (threadId: string) => {
          officialReads += 1;
          return { thread: { id: threadId, cwd: directory, status: { type: "idle" }, turns: [] } };
        },
        close: async () => undefined,
      }),
      createAgent: () => ({
        resumeThread: () => ({
          id: "thread-a",
          runStreamed: async () => {
            sdkCalls += 1;
            return { events: (async function* () {
              yield { type: "turn.completed" as const, usage: { output_tokens: 1 } };
            })() };
          },
        }),
      }),
    });
    const firstDb = new StateDatabase(dbPath);
    try {
      const firstService = new CodexHistoryService(options(firstDb));
      const homeId = firstService.listHomes()[0]!.id;
      const input = { text: "private prompt 012345", turnIndex: 0, idempotencyKey: "same-send" };
      const accepted = await firstService.sendMessage(homeId, "thread-a", input);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await firstService.getMessageUpdates(homeId, "thread-a", accepted.runId, 0)).state === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(sdkCalls).toBe(1);
      const raw = new Database(dbPath, { readonly: true });
      try {
        const row = raw.query("SELECT payload_json, idempotency_key_hash FROM codex_history_runs WHERE run_id = ?")
          .get(accepted.runId) as { payload_json: string; idempotency_key_hash: string };
        expect(row.payload_json).not.toContain("private prompt 012345");
        expect(row.idempotency_key_hash).not.toContain("same-send");
      } finally {
        raw.close();
      }
      firstDb.close();

      const reopened = new StateDatabase(dbPath);
      try {
        const service = new CodexHistoryService(options(reopened));
        const replay = await service.sendMessage(homeId, "thread-a", input);
        expect(replay.runId).toBe(accepted.runId);
        expect(sdkCalls).toBe(1);
        const updates = await service.getMessageUpdates(homeId, "thread-a", accepted.runId, 0);
        expect(updates).toMatchObject({ state: "completed", resetRequired: true, recovery: { codexThreadStatus: "idle" } });
        expect(officialReads).toBeGreaterThan(0);
        await expect(service.sendMessage(homeId, "thread-a", { ...input, text: "changed" }))
          .rejects.toThrow("幂等键");
        expect(sdkCalls).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      firstDb.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
