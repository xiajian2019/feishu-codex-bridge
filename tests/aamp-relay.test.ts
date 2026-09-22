import { describe, expect, it } from "bun:test";

import { AampRelayClient, reconcileRunningAampTasks } from "../src/aamp-relay.js";
import { StateDatabase } from "../src/db.js";

describe("AAMP Relay compensation", () => {
  it("queries the internal status endpoint and aligns running SQLite tasks once", async () => {
    const db = new StateDatabase(":memory:");
    db.initializeAampTask({ aampTaskId: "relay-task-1", chatId: "chat-1", status: "running" });
    db.initializeAampTask({ aampTaskId: "relay-task-2", chatId: "chat-2", status: "running" });
    const requests: string[] = [];
    const relay = new AampRelayClient(
      {
        enabled: true,
        aampHost: "http://relay.internal:8787",
        statusUrl: "http://relay.internal:8787/api/tasks",
        authToken: "secret",
      },
      {
        http: async (url, options) => {
          requests.push(`${url}|${options?.headers?.Authorization ?? ""}`);
          const taskId = url.split("/").at(-1);
          return {
            ok: true,
            status: 200,
            json: async () => taskId === "relay-task-1"
              ? { data: { task: { status: "completed", output: "done", message: "accepted" } } }
              : { status: "failed", error_msg: "ACP exited" },
            text: async () => "",
          };
        },
      },
    );

    await expect(reconcileRunningAampTasks(db, relay)).resolves.toEqual({
      inspected: 2,
      aligned: 2,
      skipped: 0,
      failed: 0,
    });
    expect(requests.sort()).toEqual([
      "http://relay.internal:8787/api/tasks/relay-task-1|Bearer secret",
      "http://relay.internal:8787/api/tasks/relay-task-2|Bearer secret",
    ].sort());
    expect(db.getAampTask("relay-task-1")).toMatchObject({
      status: "done",
      last_delta_text: "done",
      error_msg: null,
    });
    expect(db.getAampTask("relay-task-2")).toMatchObject({
      status: "failed",
      error_msg: "ACP exited",
    });
    db.close();
  });

  it("leaves the database untouched when the Relay has no status endpoint", async () => {
    const db = new StateDatabase(":memory:");
    db.initializeAampTask({ aampTaskId: "relay-task-3", chatId: "chat-3", status: "running" });
    const relay = new AampRelayClient({ enabled: true, aampHost: "http://relay.internal:8787" });
    await expect(reconcileRunningAampTasks(db, relay)).resolves.toMatchObject({
      inspected: 1,
      aligned: 0,
      skipped: 1,
    });
    expect(db.getAampTask("relay-task-3")?.status).toBe("running");
    db.close();
  });
});
