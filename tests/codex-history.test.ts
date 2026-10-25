import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexHistoryService,
  discoverCodexHomePaths,
  type CodexHistoryHome,
  type CodexHistoryUsageSnapshotStore,
} from "../src/codex-history.js";
import type { CodexAppServerQueryClient } from "../src/codex-app-server.js";
import type {
  CodexAppServerInteractiveAction,
  CodexAppServerInteractiveClient,
  CodexAppServerInteractiveTurnInput,
} from "../src/codex-interactive.js";

describe("CodexHistoryService", () => {
  it("discovers account homes and merges paginated read-only histories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-codex-history-"));
    const secondHome = join(directory, "accounts", "second");
    await mkdir(join(secondHome, "sqlite"), { recursive: true });
    await writeFile(join(directory, "state_5.sqlite"), "");
    await writeFile(join(secondHome, "sqlite", "state_5.sqlite"), "");
    const normalizedDirectory = realpathSync.native(directory);
    const normalizedSecondHome = realpathSync.native(secondHome);

    try {
      expect(discoverCodexHomePaths({ CODEX_HOME: directory }, directory)).toEqual([normalizedDirectory, normalizedSecondHome]);
      const calls: Array<{ path: string; sqliteHome?: string }> = [];
      const service = new CodexHistoryService({
        executable: "unused-in-test",
        environment: { CODEX_HOME: directory },
        createClient: (home) => {
          calls.push({ path: home.path, sqliteHome: home.sqliteHome });
          const firstPage = home.path === normalizedDirectory
            ? [{ id: "default-2", preview: "default newer", updatedAt: 200, source: "cli", status: { type: "idle" } }]
            : [{ id: "second-1", preview: "second history", updatedAt: 150, source: "cli", status: { type: "notLoaded" } }];
          const secondPage = [{ id: "default-1", preview: "default older", updatedAt: 100, source: "appServer", status: { type: "idle" } }];
          return {
            listThreads: async (params) => ({
              data: params.cursor ? secondPage : firstPage,
              nextCursor: home.path === normalizedDirectory && !params.cursor ? "page-2" : null,
              backwardsCursor: null,
            }),
            readThread: async (threadId) => ({ thread: { id: threadId, preview: "detail", turns: [{ items: [{ type: "userMessage" }] }] } }),
            close: async () => undefined,
          } satisfies CodexAppServerQueryClient;
        },
      });

      const result = await service.listThreads({
        sourceKinds: ["cli", "appServer"],
        archived: "active",
        sortKey: "recency_at",
        sortDirection: "desc",
        limit: 10,
        offset: 0,
      });

      expect(result.total).toBe(3);
      expect(result.items.map((item) => item.thread.id)).toEqual(["default-2", "second-1", "default-1"]);
      expect(result.homes.map((home) => home.label)).toEqual(["默认", "second"]);
      expect(calls).toEqual([
        { path: normalizedDirectory, sqliteHome: normalizedDirectory },
        { path: normalizedSecondHome, sqliteHome: join(normalizedSecondHome, "sqlite") },
      ]);

      const selectedHome = result.homes.find((home) => home.label === "second") as CodexHistoryHome;
      const selectedResult = await service.listThreads({
        homeId: selectedHome.id,
        sourceKinds: ["cli", "appServer"],
        archived: "active",
        sortKey: "recency_at",
        sortDirection: "desc",
        limit: 10,
        offset: 0,
      });
      expect(selectedResult.homes.map((home) => home.label)).toEqual(["默认", "second"]);
      const detail = await service.readThread(selectedHome.id, "second-1");
      expect(detail).toMatchObject({ home: { label: "second" }, thread: { id: "second-1", preview: "detail" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a failed home visible while returning threads from another home", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-codex-history-errors-"));
    const brokenHome = join(directory, "broken");
    await mkdir(brokenHome, { recursive: true });
    const normalizedBrokenHome = realpathSync.native(brokenHome);
    try {
      const service = new CodexHistoryService({
        executable: "unused-in-test",
        homePaths: [directory, brokenHome],
        environment: { CODEX_HOME: directory },
        createClient: (home) => {
          if (home.path === normalizedBrokenHome) {
            return {
              listThreads: async () => { throw new Error("state database locked"); },
              close: async () => undefined,
            };
          }
          return {
            listThreads: async () => ({ data: [{ id: "healthy", updatedAt: 1, status: { type: "idle" } }], nextCursor: null, backwardsCursor: null }),
            close: async () => undefined,
          };
        },
      });
      const result = await service.listThreads({
        sourceKinds: ["cli", "appServer"],
        archived: "active",
        sortKey: "recency_at",
        sortDirection: "desc",
        limit: 10,
        offset: 0,
      });
      expect(result.items.map((item) => item.thread.id)).toEqual(["healthy"]);
      expect(result.homes.find((home) => home.path === normalizedBrokenHome)).toMatchObject({ available: true, error: "state database locked" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent quota reads when the daily token snapshot is already cached", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-codex-history-usage-"));
    await writeFile(join(directory, "state_5.sqlite"), "");
    let quotaCalls = 0;
    const now = Date.parse("2026-10-23T08:00:00.000Z");
    const snapshotStore: CodexHistoryUsageSnapshotStore = {
      getCodexUsageSnapshot: () => ({
        snapshotDate: "2026-10-23",
        capturedAt: new Date(now - 1_000).toISOString(),
        tokenUsage: {
          summary: { lifetimeTokens: 42 },
          dailyUsageBuckets: [{ startDate: "2026-10-23", tokens: 42 }],
        },
      }),
      saveCodexUsageSnapshot: () => undefined,
      listCodexUsageDailyBuckets: () => [],
    };
    try {
      const service = new CodexHistoryService({
        executable: "unused-in-test",
        environment: { CODEX_HOME: directory },
        now: () => now,
        usageSnapshotStore: snapshotStore,
        createClient: () => ({
          listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
          readAccountRateLimits: async () => {
            quotaCalls += 1;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
            return { rateLimits: { limitId: "primary", primary: { usedPercent: 10 } } };
          },
          close: async () => undefined,
        }),
      });
      const homeId = service.listHomes()[0]!.id;
      const [first, second] = await Promise.all([service.readUsage(homeId), service.readUsage(homeId)]);
      expect(first.accounts[0]?.tokenUsage?.summary?.lifetimeTokens).toBe(42);
      expect(second.accounts[0]?.tokenUsage?.summary?.lifetimeTokens).toBe(42);
      expect(quotaCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes same-day token usage and replaces a backfilled daily bucket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-codex-history-usage-refresh-"));
    await writeFile(join(directory, "state_5.sqlite"), "");
    const now = Date.parse("2026-10-23T11:00:00.000Z");
    const previousSnapshot = {
      snapshotDate: "2026-10-23",
      capturedAt: "2026-10-23T00:07:31.497Z",
      tokenUsage: {
        summary: { lifetimeTokens: 8_100_000_000, peakDailyTokens: 250_000_000 },
        dailyUsageBuckets: [{ startDate: "2026-10-22", tokens: 72_700_228 }],
      },
    };
    let tokenUsageCalls = 0;
    let savedBuckets: Array<{ startDate: string; tokens: number }> = [];
    const snapshotStore: CodexHistoryUsageSnapshotStore = {
      getCodexUsageSnapshot: () => previousSnapshot,
      saveCodexUsageSnapshot: (_homeId, _snapshot, finalizedDailyBuckets) => {
        savedBuckets = finalizedDailyBuckets;
      },
      listCodexUsageDailyBuckets: () => [{ startDate: "2026-10-22", tokens: 72_700_228 }],
    };
    try {
      const service = new CodexHistoryService({
        executable: "unused-in-test",
        environment: { CODEX_HOME: directory },
        now: () => now,
        usageSnapshotStore: snapshotStore,
        createClient: () => ({
          listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
          readAccountRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 10 } } }),
          readAccountTokenUsage: async () => {
            tokenUsageCalls += 1;
            return {
              summary: { lifetimeTokens: 8_645_935_965, peakDailyTokens: 561_232_128 },
              dailyUsageBuckets: [
                { startDate: "2026-10-22", tokens: 561_232_128 },
              ],
            };
          },
          close: async () => undefined,
        }),
      });
      const homeId = service.listHomes()[0]!.id;
      const result = await service.readUsage(homeId);
      const account = result.accounts[0]!;

      expect(tokenUsageCalls).toBe(1);
      expect(account.tokenUsage?.summary?.peakDailyTokens).toBe(561_232_128);
      expect(account.tokenUsage?.dailyUsageBuckets).toEqual([
        { startDate: "2026-10-22", tokens: 561_232_128 },
      ]);
      expect(savedBuckets).toEqual([
        { startDate: "2026-10-22", tokens: 561_232_128 },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes a selected thread through the Codex SDK and exposes incremental turn events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-codex-history-send-"));
    await writeFile(join(directory, "state_5.sqlite"), "");
    const attachmentDirectory = await mkdtemp(join(tmpdir(), "bridge-codex-history-attachments-"));
    const normalizedDirectory = realpathSync.native(directory);
    const sent: Array<{ threadId: string; options?: Record<string, unknown>; input: unknown }> = [];
    try {
      const service = new CodexHistoryService({
        executable: "unused-in-test",
        environment: { CODEX_HOME: directory },
        attachmentsDirectory: attachmentDirectory,
        createClient: () => ({
          listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
          readThread: async (threadId) => ({
            thread: { id: threadId, cwd: normalizedDirectory, turns: [] },
          }),
          close: async () => undefined,
        }),
        createAgent: (_home, environment) => ({
          resumeThread: (threadId, options) => {
            sent.push({ threadId, options: options as Record<string, unknown> | undefined, input: environment });
            return {
              id: threadId,
              runStreamed: async (input) => ({
                events: (async function* () {
                  sent[sent.length - 1]!.input = input;
                  yield { type: "thread.started", thread_id: threadId };
                  yield { type: "item.updated", item: { id: "agent-1", type: "agent_message", text: "增量回复" } };
                  yield { type: "item.completed", item: { id: "agent-1", type: "agent_message", text: "增量回复" } };
                  yield { type: "turn.completed", usage: { output_tokens: 3 } };
                })(),
              }),
            };
          },
        }),
      });
      const home = service.listHomes()[0]!;
      const attachment = await service.stageAttachment({
        fileName: "截图.png",
        mimeType: "image/png",
        data: Buffer.from("fake-image"),
      });
      const accepted = await service.sendMessage(home.id, "thread-1", {
        text: "请查看截图",
        attachmentIds: [attachment.attachmentId],
      });
      expect(accepted).toMatchObject({ threadId: "thread-1", state: "running", cursor: 0 });

      let updates = await service.getMessageUpdates(home.id, "thread-1", accepted.runId, 0);
      for (let attempt = 0; attempt < 20 && updates.state === "running"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
        updates = await service.getMessageUpdates(home.id, "thread-1", accepted.runId, updates.cursor);
      }
      const allUpdates = await service.getMessageUpdates(home.id, "thread-1", accepted.runId, 0);
      expect(allUpdates.state).toBe("completed");
      expect(allUpdates.events.map((event) => event.type)).toContain("item.completed");
      expect(allUpdates.finalResponse).toBe("增量回复");
      expect((await service.getMessageUpdates(home.id, "thread-1", accepted.runId, allUpdates.cursor)).events).toEqual([]);
      expect(sent[0]).toMatchObject({
        threadId: "thread-1",
        options: {
          workingDirectory: normalizedDirectory,
          additionalDirectories: [realpathSync.native(attachmentDirectory)],
        },
      });
      expect(sent[0]!.input).toEqual([
        { type: "text", text: expect.stringContaining("请查看截图") },
        { type: "local_image", path: expect.stringContaining(".png") },
      ]);
      await expect(readdir(attachmentDirectory)).resolves.toHaveLength(1);
      expect(service.getRunAttachment(home.id, "thread-1", accepted.runId, attachment.attachmentId)).toMatchObject({
        fileName: "截图.png",
        mimeType: "image/png",
        sizeBytes: Buffer.byteLength("fake-image"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(attachmentDirectory, { recursive: true, force: true });
    }
  });

  it("binds native actions, fork, and steer to the selected Home and run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-codex-history-interactive-"));
    await writeFile(join(directory, "state_5.sqlite"), "");
    const normalizedDirectory = realpathSync.native(directory);
    const clients: CodexAppServerInteractiveClient[] = [];
    const turnInputs: CodexAppServerInteractiveTurnInput[] = [];
    const completeTurns: Array<(result: { turnId: string; status: "completed" | "interrupted" | "failed" }) => void> = [];
    const responses: Array<{ actionId: string; response: unknown }> = [];
    const steers: string[] = [];
    const forks: Array<{ threadId: string; lastTurnId?: string }> = [];
    const restoredPolicies: unknown[] = [];

    try {
      const service = new CodexHistoryService({
        executable: "unused-in-test",
        homePaths: [directory],
        environment: { CODEX_HOME: directory },
        createClient: () => ({
          listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
          readThread: async (threadId) => ({
            thread: { id: threadId, cwd: normalizedDirectory, model: "fixture-model", turns: [] },
          }),
          close: async () => undefined,
        }),
        createAgent: () => {
          throw new Error("The explicit interactive run must not use the SDK path.");
        },
        createInteractiveClient: () => {
          let activeInput: CodexAppServerInteractiveTurnInput | undefined;
          let finishTurn: ((result: { turnId: string; status: "completed" | "interrupted" | "failed" }) => void) | undefined;
          const client: CodexAppServerInteractiveClient = {
            runTurn: async (input) => {
              activeInput = input;
              turnInputs.push(input);
              input.onApprovalPolicy?.("never");
              input.onEvent({ type: "turn.started", thread_id: input.threadId, turn_id: "turn-native" });
              const action: CodexAppServerInteractiveAction = {
                id: `${input.runId}:1`,
                actionId: `${input.runId}:1`,
                type: "item/tool/requestUserInput",
                payload: {
                  threadId: input.threadId,
                  turnId: "turn-native",
                  questions: [{ id: "q1", question: "Continue?" }],
                },
                status: "pending",
              };
              input.onAction(action);
              return await new Promise((resolvePromise) => {
                finishTurn = resolvePromise;
                completeTurns.push(resolvePromise);
                input.signal?.addEventListener("abort", () => {
                  input.onEvent({
                    type: "turn.completed",
                    turn: { id: "turn-native", status: "interrupted" },
                  });
                  finishTurn?.({ turnId: "turn-native", status: "interrupted" });
                }, { once: true });
              });
            },
            steer: async (text) => {
              steers.push(text);
              return "turn-native";
            },
            interrupt: async () => undefined,
            restoreApprovalPolicy: async (_threadId, policy) => { restoredPolicies.push(policy); },
            respondAction: async (actionId, response) => {
              responses.push({ actionId, response });
              activeInput?.onActionStatus(actionId, "responded");
            },
            forkThread: async (threadId, lastTurnId) => {
              forks.push({ threadId, lastTurnId });
              return "thread-forked";
            },
            listActions: () => [],
            close: async () => undefined,
          };
          clients.push(client);
          return client;
        },
      });

      const home = service.listHomes()[0]!;
      const accepted = await service.sendMessage(home.id, "thread-1", { text: "continue", interactive: true });
      for (let attempt = 0; attempt < 40 && turnInputs.length === 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      expect(turnInputs[0]).toMatchObject({
        runId: accepted.runId,
        threadId: "thread-1",
        cwd: normalizedDirectory,
        input: [{ type: "text", text: "continue" }],
      });

      const [action] = service.getPendingActions(home.id, "thread-1");
      expect(action).toMatchObject({
        id: `${accepted.runId}:1`,
        homeId: home.id,
        threadId: "thread-1",
        runId: accepted.runId,
        status: "pending",
      });
      expect(service.listWorkbenchRuns()).toContainEqual(expect.objectContaining({
        homeId: home.id,
        threadId: "thread-1",
        runId: accepted.runId,
        state: "running",
      }));
      await expect(service.getWriterStatus(home.id, "thread-1")).resolves.toMatchObject({
        state: "busy",
        localRun: { runId: accepted.runId, interactive: true },
      });
      await expect(service.respondAction(home.id, "other-thread", accepted.runId, action!.id, {
        answers: { q1: "yes" },
      })).rejects.toThrow(/原生 History run/);
      await expect(service.respondAction(home.id, "thread-1", "other-run", action!.id, {
        answers: { q1: "yes" },
      })).rejects.toThrow(/原生 History run/);
      await expect(service.respondAction(home.id, "thread-1", accepted.runId, action!.id, {
        answers: { q1: "yes" },
      })).resolves.toEqual({ ok: true, status: "responded" });
      await expect(service.respondAction(home.id, "thread-1", accepted.runId, action!.id, {
        answers: { q1: "yes" },
      })).rejects.toThrow(/过期或已响应/);
      await expect(service.steerMessage(home.id, "wrong-thread", accepted.runId, "steer"))
        .rejects.toThrow(/原生 Codex turn/);
      await expect(service.steerMessage(home.id, "thread-1", accepted.runId, "focus tests"))
        .resolves.toEqual({ runId: accepted.runId, threadId: "thread-1", turnId: "turn-native" });
      expect(steers).toEqual(["focus tests"]);

      await expect(service.forkThread(home.id, "thread-1", { lastTurnId: "turn-before" }))
        .resolves.toEqual({ homeId: home.id, threadId: "thread-forked" });
      expect(forks).toEqual([{ threadId: "thread-1", lastTurnId: "turn-before" }]);

      turnInputs[0]!.onEvent({ type: "turn.completed", turn: { id: "turn-native", status: "completed" } });
      completeTurns[0]!({ turnId: "turn-native", status: "completed" });
      for (let attempt = 0; attempt < 40 && service.listWorkbenchRuns().find((run) => run.runId === accepted.runId)?.state === "running"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      for (let attempt = 0; attempt < 40 && restoredPolicies.length < 1; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      expect(service.listWorkbenchRuns().find((run) => run.runId === accepted.runId)?.state).toBe("completed");
      expect(service.listPendingActions().find((item) => item.id === action!.id)?.status).toBe("responded");
      expect(restoredPolicies).toEqual(["never"]);

      const interrupted = await service.sendMessage(home.id, "thread-1", { text: "stop me", interactive: true });
      for (let attempt = 0; attempt < 40 && turnInputs.length < 2; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      expect(turnInputs[1]?.runId).toBe(interrupted.runId);
      expect(service.interruptMessage(home.id, "thread-1", interrupted.runId)).toEqual({
        ok: true,
        state: "cancelling",
      });
      for (let attempt = 0; attempt < 40
        && service.listPendingActions().find((item) => item.runId === interrupted.runId)?.status === "pending";
        attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      expect(turnInputs[1]?.signal?.aborted).toBe(true);
      expect(service.listWorkbenchRuns().find((run) => run.runId === interrupted.runId)?.state).toBe("cancelled");
      expect(service.listPendingActions().find((item) => item.runId === interrupted.runId)?.status).toBe("expired");
      expect(restoredPolicies).toEqual(["never", "never"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
