import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeBackupScheduler, bridgeBackupSchedule } from "../src/backup-scheduler.js";
import { createBridgeBackup, listBridgeBackups } from "../src/bridge-backup.js";
import { StateDatabase } from "../src/db.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(initial = new Date(2026, 9, 20, 1)) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-backup-scheduler-test-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "bridge.db");
  const database = new StateDatabase(databasePath);
  database.createProject({ name: "fixture", path: join(root, "project") });
  database.close();
  const backupRoot = join(root, "backups");
  let now = initial;
  const options = { databasePath, backupRoot, now: () => now };
  const scheduler = new BridgeBackupScheduler(options);
  cleanup.push(() => scheduler.stop());
  return { root, databasePath, backupRoot, scheduler, options, setNow: (next: Date) => { now = next; } };
}

function slotId(date: Date): string {
  const due = new Date(date);
  due.setHours(1, 0, 0, 0);
  return `scheduled-${due.toISOString().replaceAll(/[-:.]/g, "")}`;
}

describe("scheduled SQLite backups", () => {
  it("waits until host-local 01:00 and deduplicates repeated checks and restarts", async () => {
    const f = fixture(new Date(2026, 9, 20, 0, 59, 59));
    expect(await f.scheduler.runDueBackup()).toBeNull();
    expect(existsSync(f.backupRoot)).toBe(false);
    const due = new Date(2026, 9, 20, 1);
    f.setNow(due);
    const result = await f.scheduler.runDueBackup();
    expect(result).toMatchObject({ backupId: slotId(due), created: true, removedBackupIds: [] });
    const backupDirectory = join(f.backupRoot, result!.backupId);
    expect(readdirSync(backupDirectory).sort()).toEqual(["bridge.db", "manifest.json"]);
    const before = readFileSync(join(backupDirectory, "bridge.db"));
    expect(JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8")))
      .toMatchObject({ scope: "sqlite", source: "scheduled", createdAt: due.toISOString(), attachments: [] });
    expect(await f.scheduler.runDueBackup()).toBeNull();
    f.setNow(new Date(2026, 9, 20, 9));
    const restarted = new BridgeBackupScheduler(f.options);
    cleanup.push(() => restarted.stop());
    expect(await restarted.runDueBackup()).toMatchObject({ backupId: result!.backupId, created: false });
    expect(readdirSync(f.backupRoot)).toEqual([result!.backupId]);
    expect(readFileSync(join(backupDirectory, "bridge.db"))).toEqual(before);
  });

  it("catches up today's missed slot without creating a backlog for skipped days", async () => {
    const f = fixture(new Date(2026, 9, 20, 9, 45));
    expect(await f.scheduler.runDueBackup()).toMatchObject({ backupId: slotId(new Date(2026, 9, 20)), created: true });
    f.setNow(new Date(2026, 9, 24, 12));
    expect(await f.scheduler.runDueBackup()).toMatchObject({ backupId: slotId(new Date(2026, 9, 24)), created: true });
    expect(readdirSync(f.backupRoot).sort()).toEqual([slotId(new Date(2026, 9, 20)), slotId(new Date(2026, 9, 24))].sort());
  });

  it("keeps the last three successful scheduled copies and leaves manual backups intact", async () => {
    const f = fixture();
    const manualDirectory = join(f.backupRoot, "backup-manual");
    await createBridgeBackup({ databasePath: f.databasePath, outputDirectory: manualDirectory,
      now: () => new Date(2026, 8, 1) });
    // Even a manually created backup with a scheduled-looking name is not eligible for deletion.
    const manualSlotDirectory = join(f.backupRoot, slotId(new Date(2026, 8, 2)));
    await createBridgeBackup({ databasePath: f.databasePath, outputDirectory: manualSlotDirectory,
      now: () => new Date(2026, 8, 2) });
    const results = [];
    for (let day = 20; day <= 24; day += 1) {
      f.setNow(new Date(2026, 9, day, 1));
      results.push(await f.scheduler.runDueBackup());
    }
    expect(results[3]?.removedBackupIds).toEqual([slotId(new Date(2026, 9, 20))]);
    expect(results[4]?.removedBackupIds).toEqual([slotId(new Date(2026, 9, 21))]);
    const entries = await listBridgeBackups(f.backupRoot);
    expect(entries.filter((entry) => entry.status === "metadata" && entry.metadata.source === "scheduled")
      .map((entry) => entry.backupDirectory).sort()).toEqual([22, 23, 24].map((day) => join(f.backupRoot, slotId(new Date(2026, 9, day)))).sort());
    expect(existsSync(manualDirectory)).toBe(true);
    expect(existsSync(manualSlotDirectory)).toBe(true);
  });

  it("cleans by host-local date when an older daily backup ran late", async () => {
    const f = fixture(new Date(2026, 9, 20, 23));
    await f.scheduler.runDueBackup();
    for (const day of [21, 22, 23]) {
      f.setNow(new Date(2026, 9, day, 1));
      await f.scheduler.runDueBackup();
    }
    expect(readdirSync(f.backupRoot).sort()).toEqual([21, 22, 23].map((day) => slotId(new Date(2026, 9, day))).sort());
  });

  it("preserves three successful copies even when the older copies are over three days old", async () => {
    const f = fixture();
    for (const day of [20, 21, 22, 30]) {
      f.setNow(new Date(2026, 9, day, 1));
      await f.scheduler.runDueBackup();
    }
    expect(readdirSync(f.backupRoot).sort()).toEqual([21, 22, 30].map((day) => slotId(new Date(2026, 9, day))).sort());
  });

  it("does not clean old copies on failure and retries the same slot after recovery", async () => {
    const f = fixture();
    for (const day of [10, 11, 12, 13]) {
      const date = new Date(2026, 9, day, 1);
      await createBridgeBackup({ databasePath: f.databasePath, outputDirectory: join(f.backupRoot, slotId(date)),
        source: "scheduled", now: () => date });
    }
    const before = readdirSync(f.backupRoot).sort();
    const savedDatabasePath = join(f.root, "temporarily-unavailable.db");
    renameSync(f.databasePath, savedDatabasePath);
    await expect(f.scheduler.runDueBackup()).rejects.toThrow("source database");
    expect(readdirSync(f.backupRoot).sort()).toEqual(before);
    renameSync(savedDatabasePath, f.databasePath);
    const result = await f.scheduler.runDueBackup();
    expect(result?.created).toBe(true);
    expect(result?.removedBackupIds).toHaveLength(2);
    expect(readdirSync(f.backupRoot)).toHaveLength(3);
  });

  it("does not count invalid backups toward the three protected successful copies", async () => {
    const f = fixture();
    for (const day of [10, 11, 12]) {
      const date = new Date(2026, 9, day, 1);
      await createBridgeBackup({ databasePath: f.databasePath, outputDirectory: join(f.backupRoot, slotId(date)),
        source: "scheduled", now: () => date });
    }
    const invalidPath = join(f.backupRoot, slotId(new Date(2026, 9, 12)), "bridge.db");
    writeFileSync(invalidPath, "damaged");
    const result = await f.scheduler.runDueBackup();
    expect(result?.removedBackupIds).toEqual([]);
    expect(readdirSync(f.backupRoot)).toHaveLength(4);
    expect(readFileSync(invalidPath, "utf8")).toBe("damaged");
  });

  it("publishes one slot across concurrent schedulers sharing a database and backup directory", async () => {
    const f = fixture();
    const second = new BridgeBackupScheduler(f.options);
    cleanup.push(() => second.stop());
    await Promise.allSettled([f.scheduler.runDueBackup(), second.runDueBackup()]);
    // A peer observing an in-progress publication can retry without overwriting it.
    await f.scheduler.runDueBackup();
    await second.runDueBackup();
    expect(readdirSync(f.backupRoot)).toEqual([slotId(new Date(2026, 9, 20))]);
    expect((await listBridgeBackups(f.backupRoot))[0]?.status).toBe("metadata");
  });

  it("starts once and waits for the current backup during shutdown", async () => {
    const f = fixture();
    f.scheduler.start();
    f.scheduler.start();
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(f.backupRoot, slotId(new Date(2026, 9, 20)), "manifest.json")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await f.scheduler.stop();
    expect(readdirSync(f.backupRoot)).toEqual([slotId(new Date(2026, 9, 20))]);
    expect((await listBridgeBackups(f.backupRoot))[0]?.status).toBe("metadata");
  });

  it("reports the next host-local 01:00 across the date boundary", () => {
    const before = bridgeBackupSchedule(new Date(2026, 9, 20, 0, 59));
    expect(new Date(before.nextRunAt)).toEqual(new Date(2026, 9, 20, 1));
    const after = bridgeBackupSchedule(new Date(2026, 9, 20, 1));
    expect(new Date(after.nextRunAt)).toEqual(new Date(2026, 9, 21, 1));
    expect(after).toMatchObject({ hour: 1, minute: 0, retentionDays: 3, minimumBackups: 3,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });
});
