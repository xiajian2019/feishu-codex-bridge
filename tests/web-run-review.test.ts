import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import type { RoutedTask } from "../src/types.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("Web run review", () => {
  it("stores a separate human decision without changing execution state and rejects stale runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-review-test-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const db = new StateDatabase(join(root, "bridge.db"));
    cleanup.push(() => db.close());
    const task: RoutedTask = {
      taskGuid: "web-review", summary: "review", description: "review", projectKey: "fixture", mode: "implement",
      repo: root, sandboxMode: "workspace-write", inputHash: "hash-1", origin: "web", completed: false,
      input: { projectKey: "fixture", mode: "implement", summary: "review", description: "review" },
    };
    const first = db.claimRun({ task, inputText: JSON.stringify(task.input), promptText: "prompt" })!;
    db.markRunRunning(first.runId, 123, "fixture");
    db.finishRun(first.runId, { status: "succeeded", finalResponse: "done" });
    expect(db.getTask(task.taskGuid)?.state).toBe("WAITING_REVIEW");
    expect(db.queryTaskPanel({ states: ["ATTENTION"] }).total).toBe(1);
    expect(() => db.saveWebRunReview(task.taskGuid, first.runId, "changes_requested", "")).toThrow("填写验收意见");
    expect(db.saveWebRunReview(task.taskGuid, first.runId, "changes_requested", "Fix edge case")).toMatchObject({ note: "Fix edge case" });
    expect(db.queryTaskPanel({ states: ["ATTENTION"] }).total).toBe(1);
    expect(db.saveWebRunReview(task.taskGuid, first.runId, "accepted", "")).toMatchObject({ decision: "accepted" });
    expect(db.getTask(task.taskGuid)?.state).toBe("WAITING_REVIEW");
    expect(db.queryTaskPanel({ states: ["ATTENTION"] }).total).toBe(0);

    const auth = new WebPairingAuth({ db });
    const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [] });
    cleanup.push(() => server.stop());
    const url = await server.start();
    expect((await fetch(`${url}/api/tasks/${task.taskGuid}/runs/${first.runId}/review`, { method: "PUT" })).status).toBe(401);
    const pairing = auth.startPairing();
    const request = { headers: { "user-agent": "fixture" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
    const token = auth.claimPairing(request, pairing.code);
    const headers = { Cookie: `bridge_session=${token}` };
    expect((await fetch(`${url}/api/tasks/${task.taskGuid}/runs/${first.runId}/review`, { method: "PUT", headers })).status).toBe(403);
    const actionToken = (await (await fetch(`${url}/api/session`, { headers })).json() as { actionToken: string }).actionToken;
    const reviewed = await fetch(`${url}/api/tasks/${task.taskGuid}/runs/${first.runId}/review`, {
      method: "PUT", headers: { ...headers, Origin: "http://untrusted.example", "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken },
      body: JSON.stringify({ decision: "accepted" }),
    });
    expect(reviewed.status).toBe(403);
    const accepted = await fetch(`${url}/api/tasks/${task.taskGuid}/runs/${first.runId}/review`, {
      method: "PUT", headers: { ...headers, Origin: url, "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken },
      body: JSON.stringify({ decision: "accepted", note: "Looks good" }),
    });
    expect(accepted.status).toBe(200);
    const sharedWorkspaceSnapshot = {
      capturedAt: "2026-10-05T00:00:00.000Z",
      isGitRepository: true,
      headCommit: "b".repeat(40),
      dirtyPaths: ["src/change.ts"],
      untrackedPaths: ["notes.txt"],
      truncated: false,
      taskAttribution: "unattributed-shared-workspace" as const,
      attributionNote: "This is a shared-workspace snapshot; changed paths cannot be attributed to one task.",
    };
    db.saveRunWorkspaceSnapshot(first.runId, "before", sharedWorkspaceSnapshot);
    db.saveRunWorkspaceSnapshot(first.runId, "after", { ...sharedWorkspaceSnapshot, capturedAt: "2026-10-05T00:01:00.000Z" });
    const detail = await (await fetch(`${url}/api/tasks/${task.taskGuid}`, { headers })).json() as {
      reviews: Array<{ decision: string; note: string }>;
      task: { state: string };
      workspace_snapshots: Array<{ run_id: string; stage: string; snapshot: { capturedAt: string; taskAttribution: string } }>;
    };
    expect(detail.reviews).toMatchObject([{ decision: "accepted", note: "Looks good" }]);
    expect(detail.task.state).toBe("WAITING_REVIEW");
    expect(detail.workspace_snapshots).toMatchObject([
      { run_id: first.runId, stage: "after", snapshot: { capturedAt: "2026-10-05T00:01:00.000Z", taskAttribution: "unattributed-shared-workspace" } },
      { run_id: first.runId, stage: "before", snapshot: { capturedAt: "2026-10-05T00:00:00.000Z", taskAttribution: "unattributed-shared-workspace" } },
    ]);
    const panel = await (await fetch(`${url}/api/task-panel?source=desk`, { headers })).json() as { items: Array<{ latest_review: { decision: string } | null }> };
    expect(panel.items[0]?.latest_review?.decision).toBe("accepted");
    expect((await (await fetch(`${url}/api/task-panel?state=ATTENTION`, { headers })).json() as { total: number }).total).toBe(0);

    const secondTask = { ...task, inputHash: "hash-2", input: { ...task.input, description: "revision" } };
    const second = db.claimRun({ task: secondTask, inputText: JSON.stringify(secondTask.input), promptText: "retry" });
    expect(second).not.toBeNull();
    expect(() => db.saveWebRunReview(task.taskGuid, first.runId, "accepted", "stale")).toThrow("最新一轮");
    expect(db.listWebRunReviews(task.taskGuid)).toHaveLength(1);
  });
});
