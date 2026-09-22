import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "bun:test";

import { ChildWorkerRunner } from "../src/worker-runner.js";

describe("ChildWorkerRunner", () => {
  it("receives structured events from an isolated child process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "feishu-codex-bridge-"));
    const script = join(directory, "fake-worker.mjs");
    writeFileSync(
      script,
      [
        "console.log(JSON.stringify({type: 'thread.started', thread_id: 'thread-test'}));",
        "console.log(JSON.stringify({type: 'worker.progress', progress: {eventType: 'item.started', message: '命令已开始', at: '2026-09-01T00:00:00.000Z'}}));",
        "console.log(JSON.stringify({type: 'worker.finished', result: {status: 'succeeded', threadId: 'thread-test', finalResponse: 'ok'}}));",
      ].join("\n"),
      "utf8",
    );
    const events: string[] = [];
    try {
      const runner = new ChildWorkerRunner({
        workerScript: script,
        dbPath: join(directory, "state.db"),
        configPath: join(directory, "config.json"),
        executable: process.execPath,
        onEvent: (_runId, event) => events.push(event.type),
      });
      const handle = runner.start("run-test");
      await expect(handle.result).resolves.toMatchObject({
        status: "succeeded",
        threadId: "thread-test",
      });
      expect(handle.pid).toBeGreaterThan(0);
      expect(events).toEqual(["thread.started", "worker.progress", "worker.finished"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
