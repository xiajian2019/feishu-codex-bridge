import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { createBridgeBackup, listBridgeBackups, verifyBridgeBackup, type BridgeBackupVerification } from "./bridge-backup.js";
import type { Logger } from "./types.js";

const RETENTION_DAYS = 3;
const MINIMUM_BACKUPS = 3;
const SCHEDULED_BACKUP_ID = /^scheduled-\d{8}T\d{9}Z$/;

export function bridgeBackupSchedule(now = new Date()) {
  const next = scheduledTime(now);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return {
    hour: 1,
    minute: 0,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    nextRunAt: next.toISOString(),
    retentionDays: RETENTION_DAYS,
    minimumBackups: MINIMUM_BACKUPS,
  };
}

export interface BridgeBackupSchedulerOptions {
  databasePath: string;
  backupRoot: string;
  logger?: Logger;
  now?: () => Date;
}

export interface ScheduledBackupResult {
  backupId: string;
  created: boolean;
  removedBackupIds: string[];
}

/** Daily host-local 01:00 snapshots. A stable slot ID deduplicates restarts and shared-DB processes. */
export class BridgeBackupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running: Promise<ScheduledBackupResult | null> | null = null;
  private completedSlot: string | null = null;

  constructor(private readonly options: BridgeBackupSchedulerOptions) {}

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Catch up today's slot after a restart or host sleep; do not replay every missed day.
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Also exposed for deterministic clock-driven verification without starting a timer. */
  public runDueBackup(): Promise<ScheduledBackupResult | null> {
    if (this.running) return this.running;
    const now = this.options.now?.() ?? new Date();
    this.running = this.performBackup(now).finally(() => { this.running = null; });
    return this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDueBackup().catch((error: unknown) => {
        this.options.logger?.warn("scheduled SQLite backup failed; will retry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        const now = this.options.now?.() ?? new Date();
        const next = new Date(bridgeBackupSchedule(now).nextRunAt).getTime();
        // Re-evaluate at least once a minute for retries, clock changes and host sleep.
        this.schedule(Math.min(60_000, Math.max(1, next - now.getTime())));
      });
    }, delay);
    this.timer.unref?.();
  }

  private async performBackup(now: Date): Promise<ScheduledBackupResult | null> {
    const due = scheduledTime(now);
    const backupId = `scheduled-${due.toISOString().replaceAll(/[-:.]/g, "")}`;
    if (now.getTime() < due.getTime() || this.completedSlot === backupId) return null;
    const root = resolve(this.options.backupRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error("scheduled backup root must be a real directory without symlinks");
    }
    const backupDirectory = join(root, backupId);
    let created = false;
    if (!await lstat(backupDirectory).catch(() => null)) {
      try {
        await createBridgeBackup({ databasePath: this.options.databasePath, outputDirectory: backupDirectory,
          source: "scheduled", now: () => now });
        created = true;
      } catch (error) {
        // Another process can publish the same slot first. Never overwrite its directory.
        if (!await lstat(backupDirectory).catch(() => null)) throw error;
      }
    }
    const saved = await verifyBridgeBackup(backupDirectory);
    if (saved.source !== "scheduled" || saved.formatVersion !== 3) {
      throw new Error("scheduled backup slot is occupied by a different backup");
    }
    // Cleanup runs only after a complete, verified snapshot is available.
    const removedBackupIds = await pruneScheduledBackups(root, now);
    this.completedSlot = backupId;
    this.options.logger?.info("scheduled SQLite backup completed", { backupId, created, removedBackupIds });
    return { backupId, created, removedBackupIds };
  }
}

function scheduledTime(now: Date): Date {
  const due = new Date(now);
  due.setHours(1, 0, 0, 0);
  return due;
}

async function pruneScheduledBackups(root: string, now: Date): Promise<string[]> {
  const successful: Array<{ verification: BridgeBackupVerification; dev: number; ino: number }> = [];
  for (const entry of await listBridgeBackups(root)) {
    if (entry.status !== "metadata" || entry.metadata.source !== "scheduled"
      || !SCHEDULED_BACKUP_ID.test(basename(entry.backupDirectory))) continue;
    try {
      const before = await lstat(entry.backupDirectory);
      const verification = await verifyBridgeBackup(entry.backupDirectory);
      const after = await lstat(entry.backupDirectory);
      if (verification.source === "scheduled" && verification.formatVersion === 3
        && before.dev === after.dev && before.ino === after.ino && after.isDirectory() && !after.isSymbolicLink()) {
        successful.push({ verification, dev: before.dev, ino: before.ino });
      }
    } catch {
      // Invalid backups do not count toward the three successful copies and are left for inspection.
    }
  }
  successful.sort((a, b) => Date.parse(b.verification.createdAt) - Date.parse(a.verification.createdAt)
    || b.verification.backupDirectory.localeCompare(a.verification.backupDirectory));
  // Keep today's and the preceding two host-local dates. A late catch-up must not
  // leave a fourth daily copy simply because fewer than 72 hours have elapsed.
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS + 1);
  const removed: string[] = [];
  for (const candidate of successful.slice(MINIMUM_BACKUPS)) {
    if (Date.parse(candidate.verification.createdAt) >= cutoff.getTime()) continue;
    const directory = candidate.verification.backupDirectory;
    const info = await lstat(directory).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink() || info.dev !== candidate.dev || info.ino !== candidate.ino) continue;
    await rm(directory, { recursive: true, force: true });
    removed.push(basename(directory));
  }
  return removed;
}
