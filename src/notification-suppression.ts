import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const NOTIFICATION_SUPPRESSION_WINDOW_MS = 60_000;

const STATE_VERSION = 1;
const MAX_ENTRIES = 500;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

interface NotificationSuppressionState {
  version: typeof STATE_VERSION;
  entries: Record<string, number>;
}

export function resolveNotificationSuppressionPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(resolve(codexHome), "feishu-codex-bridge", "notify-suppression.json");
}

export function notificationSuppressionKey(input: {
  threadId: string;
  turnId?: string;
  source: string;
  detail: string;
}): string {
  const turnId = input.turnId?.trim();
  if (turnId) return `turn:${turnId}`;
  return ["content", input.threadId.trim(), input.source, input.detail].join("\u001f");
}

export class NotificationSuppressionStore {
  private readonly path: string;
  private readonly now: () => number;

  constructor(options: { path?: string; now?: () => number } = {}) {
    this.path = options.path || resolveNotificationSuppressionPath();
    this.now = options.now || Date.now;
  }

  /** Atomically claim a notification key for the current suppression window. */
  public async claim(key: string): Promise<boolean> {
    const claimedAt = this.now();
    const hashedKey = createHash("sha256").update(key).digest("hex");
    const result = await this.withLock(async () => {
      const state = await this.readState();
      const previousAt = state.entries[hashedKey];
      if (previousAt !== undefined && claimedAt - previousAt < NOTIFICATION_SUPPRESSION_WINDOW_MS) {
        return false;
      }
      state.entries[hashedKey] = claimedAt;
      this.trim(state, claimedAt);
      await this.writeState(state);
      return true;
    });
    // If the lock is contended or stale, suppress rather than risk duplicate
    // desktop notifications during a notification storm.
    return result ?? false;
  }

  private trim(state: NotificationSuppressionState, now: number): void {
    const cutoff = now - NOTIFICATION_SUPPRESSION_WINDOW_MS * 10;
    for (const [key, timestamp] of Object.entries(state.entries)) {
      if (timestamp < cutoff) delete state.entries[key];
    }
    const entries = Object.entries(state.entries);
    if (entries.length <= MAX_ENTRIES) return;
    entries
      .sort((left, right) => left[1] - right[1])
      .slice(0, entries.length - MAX_ENTRIES)
      .forEach(([key]) => delete state.entries[key]);
  }

  private async readState(): Promise<NotificationSuppressionState> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<NotificationSuppressionState>;
      if (raw.version !== STATE_VERSION || !raw.entries || typeof raw.entries !== "object") {
        return { version: STATE_VERSION, entries: {} };
      }
      const entries = Object.fromEntries(
        Object.entries(raw.entries).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
      ) as Record<string, number>;
      return { version: STATE_VERSION, entries };
    } catch {
      return { version: STATE_VERSION, entries: {} };
    }
  }

  private async writeState(state: NotificationSuppressionState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T | undefined> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) return undefined;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch {
          // The owner may have released the lock between stat and rm.
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    try {
      return await action();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}
