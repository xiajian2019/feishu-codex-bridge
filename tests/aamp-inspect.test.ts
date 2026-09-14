import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectAampTasks,
  findAampTask,
  formatAampTask,
  formatAampRecent,
} from "../src/aamp-inspect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AAMP task inspection", () => {
  it("uses the newest event when state is older than the ACP log", () => {
    const root = mkdtempSync(join(tmpdir(), "aamp-inspect-"));
    roots.push(root);
    const metadataDir = join(root, "metadata");
    const taskDir = join(root, "tasks");
    const logDir = join(root, "logs");
    const runDir = join(logDir, "runs", "20260909T100000-123");
    const stateHome = join(root, "state");
    mkdirSync(metadataDir, { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(stateHome, "runtime-v1", "im"), { recursive: true });

    const taskId = "task-12345678";
    writeFileSync(join(metadataDir, `${taskId}.json`), JSON.stringify({
      taskId,
      title: "mapped task",
      projectName: "food",
      repositoryRoot: "/tmp/food",
      createdAt: "2026-09-09T10:00:00.000Z",
      execution: { status: "running" },
    }));
    writeFileSync(join(runDir, "acp-bridge-test.jsonl"), [
      JSON.stringify({
        timestamp: "2026-09-09T10:01:00.000Z",
        type: "task.received",
        taskId,
        title: "mapped task",
      }),
      JSON.stringify({
        timestamp: "2026-09-09T10:05:00.000Z",
        type: "task.completed",
        taskId,
        status: "completed",
      }),
    ].join("\n"));
    writeFileSync(join(stateHome, "runtime-v1", "im", "state.json"), JSON.stringify({
      tasks: {
        [taskId]: {
          taskId,
          title: "mapped task",
          status: "streaming",
          updatedAt: "2026-09-09T10:03:00.000Z",
          createdAt: "2026-09-09T10:00:00.000Z",
          userMessageText: "项目：food / 任务：mapped task",
        },
      },
    }));

    const snapshot = collectAampTasks({ metadataDir, taskDir, logDir, stateHome });
    const task = findAampTask(snapshot, "task-1234");

    expect(task.status).toBe("COMPLETED");
    expect(task.latestEvent).toBe("task.completed");
    expect(task.lastEventAt).toBe("2026-09-09T10:05:00.000Z");
    expect(formatAampRecent(snapshot, 1)).toContain("[COMPLETED] task-12345678");
    expect(formatAampRecent(snapshot, 1)).toContain("原始消息：");
    expect(formatAampRecent(snapshot, 1)).toContain("项目：food / 任务：mapped task");
    expect(formatAampTask(task)).toContain("task.completed [COMPLETED]");
  });
});
