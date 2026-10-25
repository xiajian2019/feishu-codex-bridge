import { afterEach, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { CodexHistoryService } from "../src/codex-history.js";
import { DashboardServer } from "../src/web.js";
import type { CodexAppServerInteractiveTurnInput, CodexAppServerInteractiveTurnResult } from "../src/codex-interactive.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("binds HTTP human responses to the original interactive History run and refuses replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-workbench-actions-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const db = new StateDatabase(":memory:"); cleanups.push(() => db.close());
  let input: CodexAppServerInteractiveTurnInput | undefined;
  let resolveTurn: ((result: CodexAppServerInteractiveTurnResult) => void) | undefined;
  const responses: unknown[] = [];
  const forks: unknown[] = [];
  const history = new CodexHistoryService({ executable: "unused-fixture", homePaths: [root], runStore: db,
    environment: { CODEX_HOME: root },
    createClient: () => ({ listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
      readThread: async (id) => ({ thread: { id, cwd: root, turns: [] } }), close: async () => {} }),
    createAgent: () => { throw new Error("interactive mode must not start the SDK"); },
    createInteractiveClient: () => ({
      runTurn: async (value) => {
        input = value;
        value.onAction({ id: "native-action", actionId: "native-action", type: "item/commandExecution/requestApproval",
          payload: { threadId: value.threadId, turnId: "native-turn", command: "pwd", cwd: root }, status: "pending" });
        return new Promise((resolve) => { resolveTurn = resolve; });
      },
      respondAction: async (id, response) => { responses.push({ id, response }); input!.onActionStatus(id, "responded"); resolveTurn!({ turnId: "native-turn", status: "completed" }); },
      forkThread: async (...args) => { forks.push(args); return "forked-thread"; },
      listActions: () => [], steer: async () => "native-turn", interrupt: async () => {}, restoreApprovalPolicy: async () => {}, close: async () => {},
    }),
  });
  const homes = history.listHomes();
  expect(homes).toHaveLength(1);
  const home = homes[0]!;
  expect(home).toMatchObject({ path: realpathSync.native(root), available: true });
  const server = new DashboardServer({ db, codexHistory: history, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  cleanups.push(() => server.stop());
  const url = await server.start();
  const { actionToken } = await (await fetch(url + "/api/session")).json() as { actionToken: string };
  const headers = { "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken, Origin: url };
  const prefix = `/api/codex/threads/${home.id}/original-thread`;
  const sent = await fetch(url + prefix + "/messages", { method: "POST", headers,
    body: JSON.stringify({ text: "check", interactive: true, idempotencyKey: "interactive-once" }) });
  expect(sent.status).toBe(202);
  const run = await sent.json() as { runId: string };
  for (let i = 0; i < 30 && !input; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(input?.threadId).toBe("original-thread");
  const inbox = await (await fetch(url + "/api/workbench/inbox")).json() as { actions: Array<{ id: string; runId: string; target: unknown; params: unknown }> };
  expect(inbox.actions).toHaveLength(1);
  expect(inbox.actions[0]).toMatchObject({ runId: run.runId, target: { kind: "history", homeId: home.id, id: "original-thread" }, params: { command: "pwd" } });
  const endpoint = url + `/api/workbench/actions/${inbox.actions[0]!.id}/respond`;
  const denied = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "accept" }) });
  expect(denied.status).toBe(403); expect(responses).toEqual([]);
  const answered = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ decision: "decline" }) });
  expect(answered.status).toBe(200);
  expect(responses).toEqual([{ id: "native-action", response: { decision: "decline" } }]);
  const replay = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ decision: "accept" }) });
  expect(replay.status).toBe(409); expect(responses).toHaveLength(1);
  const forked = await fetch(url + prefix + "/fork", { method: "POST", headers, body: JSON.stringify({ lastTurnId: "turn-earlier" }) });
  expect(forked.status).toBe(201); expect(await forked.json()).toEqual({ homeId: home.id, threadId: "forked-thread" });
  expect(forks).toEqual([["original-thread", "turn-earlier"]]);
});
