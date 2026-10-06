import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexHistoryService,
  discoverCodexHomePaths,
  type CodexHistoryHome,
} from "../src/codex-history.js";
import type { CodexAppServerQueryClient } from "../src/codex-app-server.js";

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
});
