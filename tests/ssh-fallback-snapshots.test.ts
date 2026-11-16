import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshFallbackSnapshots } from "../src/ssh-session-fallback-snapshots.js";
import type { TmuxResurrectController } from "../src/tmux-resurrect.js";

describe("SSH fallback snapshot locking", () => {
  it("serializes same-Session writes across independent fallback instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-ssh-snapshot-lock-"));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const controller = { saveSession: async (name: string) => {
      started(); await wait;
      return { action: "save", sessionName: name, snapshot: { sessionName: name, savedAt: "2026-11-03T00:00:00.000Z" }, output: "" };
    } } as unknown as TmuxResurrectController;
    const session = { id: "$7", name: "alpha", cwd: "/fixture", createdAt: 42, windows: 1, attachedClients: 0 };
    const first = new SshFallbackSnapshots(root, controller);
    const second = new SshFallbackSnapshots(root, controller);
    try {
      const saving = first.save(session, false);
      await entered;
      await expect(second.save(session, false)).rejects.toThrow("正在进行");
      release();
      await saving;
      const lock = join(root, "locks", `${createHash("sha256").update("alpha").digest("hex")}.lock`);
      expect(existsSync(lock)).toBe(false);
    } finally { release(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not automatically delete a lock left by a crashed process", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-ssh-stale-lock-"));
    const locks = join(root, "locks");
    mkdirSync(locks);
    const path = join(locks, `${createHash("sha256").update("alpha").digest("hex")}.lock`);
    writeFileSync(path, "99999999");
    const store = new SshFallbackSnapshots(root, {} as TmuxResurrectController);
    try {
      await expect(store.save({ id: "$7", name: "alpha", cwd: "/fixture", createdAt: 42, windows: 1, attachedClients: 0 }, false))
        .rejects.toThrow("异常中断");
      expect(existsSync(path)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
