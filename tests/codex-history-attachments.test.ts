import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexHistoryService } from "../src/codex-history.js";

interface Fixture {
  root: string;
  home: string;
  attachments: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "bridge-codex-history-lifecycle-"));
  const home = join(root, "codex-home");
  const attachments = join(root, "attachments");
  await mkdir(home, { recursive: true });
  await mkdir(attachments, { recursive: true });
  return { root, home, attachments };
}

function createService(
  fixture: Fixture,
  options: {
    now: () => number;
    attachmentRetentionMs?: number;
    stagedAttachmentRetentionMs?: number;
    heldThread?: string;
    failRun?: boolean;
    heldRun?: Promise<void>;
    readThreadGate?: (threadId: string) => Promise<void>;
  },
): CodexHistoryService {
  const canonicalHome = realpathSync.native(fixture.home);
  return new CodexHistoryService({
    executable: "unused-in-test",
    environment: { CODEX_HOME: canonicalHome },
    homePaths: [canonicalHome],
    attachmentsDirectory: fixture.attachments,
    attachmentRetentionMs: options.attachmentRetentionMs,
    stagedAttachmentRetentionMs: options.stagedAttachmentRetentionMs,
    now: options.now,
    createClient: () => ({
      listThreads: async () => ({ data: [], nextCursor: null, backwardsCursor: null }),
      readThread: async (threadId) => {
        await options.readThreadGate?.(threadId);
        return { thread: { id: threadId, cwd: canonicalHome, turns: [] } };
      },
      close: async () => undefined,
    }),
    createAgent: () => ({
      resumeThread: (threadId) => ({
        id: threadId,
        runStreamed: async () => ({
          events: (async function* () {
            if (threadId === options.heldThread) await options.heldRun;
            if (options.failRun) throw new Error("fixture failure");
            yield { type: "turn.completed", usage: { output_tokens: 1 } } as never;
          })(),
        }),
      }),
    }),
  });
}

async function waitForRun(
  service: CodexHistoryService,
  homeId: string,
  threadId: string,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const updates = service.getMessageUpdates(homeId, threadId, runId, 0);
    if (updates.state !== "running" && updates.state !== "cancelling") return;
    await Promise.resolve();
  }
  throw new Error(`Codex History test run did not finish: ${threadId}`);
}

async function sendWithAttachment(
  service: CodexHistoryService,
  homeId: string,
  threadId: string,
) {
  const attachment = await service.stageAttachment({
    fileName: `${threadId}.png`,
    mimeType: "image/png",
    data: Buffer.from(threadId),
  });
  const run = await service.sendMessage(homeId, threadId, {
    text: `inspect ${threadId}`,
    attachmentIds: [attachment.attachmentId],
  });
  return { attachment, run };
}

describe("Codex History attachment lifecycle", () => {
  for (const terminal of ["failed", "cancelled"] as const) {
    it(`retains ${terminal} run attachments until expiry and protects cancelling runs`, async () => {
      const fixture = await createFixture();
      let now = 0;
      let release!: () => void;
      const heldRun = new Promise<void>((resolve) => { release = resolve; });
      const service = createService(fixture, {
        now: () => now, attachmentRetentionMs: 100, stagedAttachmentRetentionMs: 10,
        heldThread: "terminal", heldRun, failRun: true,
      });
      try {
        const homeId = service.listHomes()[0]!.id;
        const { run, attachment } = await sendWithAttachment(service, homeId, "terminal");
        if (terminal === "cancelled") service.interruptMessage(homeId, "terminal", run.runId);
        now = 500;
        await service.cleanupExpiredAttachments();
        expect(service.getRunAttachment(homeId, "terminal", run.runId, attachment.attachmentId)).not.toBeNull();
        release();
        await waitForRun(service, homeId, "terminal", run.runId);
        expect(service.getMessageUpdates(homeId, "terminal", run.runId, 0).state).toBe(terminal);
        expect(service.getRunAttachment(homeId, "terminal", run.runId, attachment.attachmentId)).not.toBeNull();
        now = 600;
        await service.cleanupExpiredAttachments();
        expect(await readdir(fixture.attachments)).toEqual([]);
      } finally {
        release();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it("keeps a completed attachment previewable until its retention deadline", async () => {
    const fixture = await createFixture();
    let now = 1_000;
    const service = createService(fixture, {
      now: () => now,
      attachmentRetentionMs: 100,
      stagedAttachmentRetentionMs: 1_000,
    });
    try {
      const homeId = service.listHomes()[0]!.id;
      const { attachment, run } = await sendWithAttachment(service, homeId, "preview-thread");
      await waitForRun(service, homeId, "preview-thread", run.runId);

      const retainedFile = service.getRunAttachment(homeId, "preview-thread", run.runId, attachment.attachmentId);
      expect(retainedFile).toMatchObject({ fileName: "preview-thread.png", mimeType: "image/png" });
      expect(await readdir(fixture.attachments)).toHaveLength(1);

      now = 1_099;
      await service.cleanupExpiredAttachments();
      expect(service.getRunAttachment(homeId, "preview-thread", run.runId, attachment.attachmentId)).not.toBeNull();

      now = 1_100;
      await service.cleanupExpiredAttachments();
      expect(service.getRunAttachment(homeId, "preview-thread", run.runId, attachment.attachmentId)).toBeNull();
      expect(await readdir(fixture.attachments)).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("evicts terminal runs at per-thread and global bounds while keeping active files", async () => {
    const fixture = await createFixture();
    let now = 2_000;
    let releaseHeldRun!: () => void;
    const heldRun = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
    const service = createService(fixture, {
      now: () => now,
      attachmentRetentionMs: 60_000,
      stagedAttachmentRetentionMs: 60_000,
      heldThread: "active-thread",
      heldRun,
    });
    try {
      const homeId = service.listHomes()[0]!.id;
      const perThreadRuns: Array<Awaited<ReturnType<typeof sendWithAttachment>>> = [];
      for (let index = 0; index < 5; index += 1) {
        const result = await sendWithAttachment(service, homeId, "bounded-thread");
        await waitForRun(service, homeId, "bounded-thread", result.run.runId);
        perThreadRuns.push(result);
        now += 1;
      }
      expect(service.getRunAttachment(
        homeId,
        "bounded-thread",
        perThreadRuns[0]!.run.runId,
        perThreadRuns[0]!.attachment.attachmentId,
      )).toBeNull();
      for (const result of perThreadRuns.slice(1)) {
        expect(service.getRunAttachment(
          homeId,
          "bounded-thread",
          result.run.runId,
          result.attachment.attachmentId,
        )).not.toBeNull();
      }

      const activeAttachment = await service.stageAttachment({
        fileName: "active.png",
        mimeType: "image/png",
        data: Buffer.from("active"),
      });
      const activeRun = await service.sendMessage(homeId, "active-thread", {
        text: "keep this file while Codex is running",
        attachmentIds: [activeAttachment.attachmentId],
      });
      expect(activeRun.state).toBe("running");

      const globalRuns: Array<Awaited<ReturnType<typeof sendWithAttachment>>> = [];
      for (let index = 0; index < 41; index += 1) {
        const result = await sendWithAttachment(service, homeId, `global-${index}`);
        await waitForRun(service, homeId, `global-${index}`, result.run.runId);
        globalRuns.push(result);
        now += 1;
      }
      expect(service.getRunAttachment(
        homeId,
        "global-0",
        globalRuns[0]!.run.runId,
        globalRuns[0]!.attachment.attachmentId,
      )).toBeNull();
      expect(service.getRunAttachment(
        homeId,
        "active-thread",
        activeRun.runId,
        activeAttachment.attachmentId,
      )).not.toBeNull();

      releaseHeldRun();
      await waitForRun(service, homeId, "active-thread", activeRun.runId);
    } finally {
      releaseHeldRun();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("expires staged files but preserves another instance's files and restart orphans", async () => {
    const fixture = await createFixture();
    let now = 0;
    let releaseOtherActive!: () => void;
    const otherActiveGate = new Promise<void>((resolve) => { releaseOtherActive = resolve; });
    const service = createService(fixture, {
      now: () => now,
      attachmentRetentionMs: 100,
      stagedAttachmentRetentionMs: 10,
    });
    try {
      const staged = await service.stageAttachment({
        fileName: "draft.png",
        mimeType: "image/png",
        data: Buffer.from("draft"),
      });
      now = 10;
      await service.cleanupExpiredAttachments();
      expect(await readdir(fixture.attachments)).toEqual([]);
      expect(await service.deleteStagedAttachment(staged.attachmentId)).toBe(false);

      const otherService = createService(fixture, {
        now: () => now,
        attachmentRetentionMs: 60_000,
        stagedAttachmentRetentionMs: 10,
        heldThread: "other-active",
        heldRun: otherActiveGate,
      });
      const homeId = otherService.listHomes()[0]!.id;
      const remoteAttachment = await otherService.stageAttachment({
        fileName: "other-instance.png",
        mimeType: "image/png",
        data: Buffer.from("remote"),
      });
      const remoteRun = await otherService.sendMessage(homeId, "other-active", {
        text: "another active instance owns this",
        attachmentIds: [remoteAttachment.attachmentId],
      });
      now = 1_000;
      await service.cleanupExpiredAttachments();
      expect(otherService.getRunAttachment(
        homeId,
        "other-active",
        remoteRun.runId,
        remoteAttachment.attachmentId,
      )).not.toBeNull();
      releaseOtherActive();
      await waitForRun(otherService, homeId, "other-active", remoteRun.runId);

      // A UUID-shaped legacy file has no durable owner record; its name alone is not proof it is safe to delete.
      const legacyOrphan = "11111111-1111-4111-8111-111111111111.png";
      await writeFile(join(fixture.attachments, legacyOrphan), "unknown owner");
      const restartedService = createService(fixture, {
        now: () => now,
        attachmentRetentionMs: 100,
        stagedAttachmentRetentionMs: 10,
      });
      await restartedService.cleanupExpiredAttachments();
      expect((await readdir(fixture.attachments)).sort()).toEqual([
        `${remoteAttachment.attachmentId}.png`,
        legacyOrphan,
      ].sort());
      expect(otherService.getRunAttachment(
        homeId,
        "other-active",
        remoteRun.runId,
        remoteAttachment.attachmentId,
      )).not.toBeNull();
    } finally {
      releaseOtherActive();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reserves expired staged records before awaiting file deletion so a concurrent send cannot claim one", async () => {
    const fixture = await createFixture();
    let now = 0;
    const service = createService(fixture, {
      now: () => now,
      stagedAttachmentRetentionMs: 10,
    });
    let releaseFirstUnlink!: () => void;
    let signalFirstUnlink!: () => void;
    const firstUnlinkStarted = new Promise<void>((resolve) => { signalFirstUnlink = resolve; });
    const firstUnlinkGate = new Promise<void>((resolve) => { releaseFirstUnlink = resolve; });
    try {
      const homeId = service.listHomes()[0]!.id;
      const first = await service.stageAttachment({
        fileName: "first.png",
        mimeType: "image/png",
        data: Buffer.from("first"),
      });
      const second = await service.stageAttachment({
        fileName: "second.png",
        mimeType: "image/png",
        data: Buffer.from("second"),
      });
      const mutableService = service as unknown as {
        unlinkOwnedAttachment: (attachment: { attachmentId: string; localPath: string }) => Promise<boolean>;
      };
      const unlinkOwnedAttachment = mutableService.unlinkOwnedAttachment.bind(service);
      mutableService.unlinkOwnedAttachment = async (attachment) => {
        if (attachment.attachmentId === first.attachmentId) {
          signalFirstUnlink();
          await firstUnlinkGate;
        }
        return unlinkOwnedAttachment(attachment);
      };

      now = 10;
      const cleanup = service.cleanupExpiredAttachments();
      await firstUnlinkStarted;
      now = 0;
      await expect(service.sendMessage(homeId, "concurrent-claim", {
        text: "try to claim the second staged file",
        attachmentIds: [second.attachmentId],
      })).rejects.toThrow("历史会话附件已失效");
      releaseFirstUnlink();
      await cleanup;
      expect(await readdir(fixture.attachments)).toEqual([]);
    } finally {
      releaseFirstUnlink();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects binding one staged attachment to two concurrent runs", async () => {
    const fixture = await createFixture();
    let now = 0;
    let releaseFirstRead!: () => void;
    let releaseSecondRead!: () => void;
    let signalBothReads!: () => void;
    let enteredReads = 0;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const secondReadGate = new Promise<void>((resolve) => { releaseSecondRead = resolve; });
    const bothReadsEntered = new Promise<void>((resolve) => { signalBothReads = resolve; });
    let releaseActiveRun!: () => void;
    const activeRun = new Promise<void>((resolve) => { releaseActiveRun = resolve; });
    const service = createService(fixture, {
      now: () => now,
      attachmentRetentionMs: 100,
      stagedAttachmentRetentionMs: 10,
      heldThread: "first-thread",
      heldRun: activeRun,
      readThreadGate: async (threadId) => {
        if (threadId !== "first-thread" && threadId !== "second-thread") return;
        enteredReads += 1;
        if (enteredReads === 2) signalBothReads();
        await (threadId === "first-thread" ? firstReadGate : secondReadGate);
      },
    });
    try {
      const homeId = service.listHomes()[0]!.id;
      const attachment = await service.stageAttachment({
        fileName: "shared.png",
        mimeType: "image/png",
        data: Buffer.from("shared"),
      });
      const firstSend = service.sendMessage(homeId, "first-thread", {
        text: "first owner",
        attachmentIds: [attachment.attachmentId],
      });
      const secondSend = service.sendMessage(homeId, "second-thread", {
        text: "second owner",
        attachmentIds: [attachment.attachmentId],
      });
      await bothReadsEntered;
      releaseFirstRead();
      const accepted = await firstSend;
      releaseSecondRead();
      await expect(secondSend).rejects.toThrow("已被另一轮 Codex 消息使用");

      now = 10;
      await service.cleanupExpiredAttachments();
      expect(service.getRunAttachment(homeId, "first-thread", accepted.runId, attachment.attachmentId)).not.toBeNull();
      expect(await readdir(fixture.attachments)).toHaveLength(1);

      releaseActiveRun();
      await waitForRun(service, homeId, "first-thread", accepted.runId);
    } finally {
      releaseFirstRead();
      releaseSecondRead();
      releaseActiveRun();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not follow an attachment symlink while cleaning up", async () => {
    const fixture = await createFixture();
    let now = 0;
    const service = createService(fixture, {
      now: () => now,
      stagedAttachmentRetentionMs: 5,
    });
    const outsideTarget = join(fixture.root, "outside.txt");
    try {
      const staged = await service.stageAttachment({
        fileName: "linked.png",
        mimeType: "image/png",
        data: Buffer.from("inside"),
      });
      const attachmentPath = join(realpathSync.native(fixture.attachments), `${staged.attachmentId}.png`);
      await writeFile(outsideTarget, "outside remains intact");
      await unlink(attachmentPath);
      await symlink(outsideTarget, attachmentPath);

      now = 5;
      await service.cleanupExpiredAttachments();
      expect(await readFile(outsideTarget, "utf8")).toBe("outside remains intact");
      expect(await readdir(fixture.attachments)).toEqual([`${staged.attachmentId}.png`]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
