import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

import { sendMacLocalNotification, type CodexNotificationSource } from "./local-codex-notifications.js";
import type { Logger } from "./types.js";

export interface CodexNotificationInboxEvent {
  id: string;
  title: string;
  body: string;
  source: CodexNotificationSource;
  createdAt: string;
}

export function resolveCodexNotificationInboxPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(resolve(codexHome), "feishu-codex-bridge", "notify-inbox");
}

export async function enqueueCodexNotification(event: CodexNotificationInboxEvent): Promise<void> {
  const directory = resolveCodexNotificationInboxPath();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${event.id}-${randomUUID()}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(event, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export class LocalCodexNotificationInbox {
  private readonly directory: string;
  private readonly logger?: Logger;
  private watcher: FSWatcher | undefined;
  private drainPromise: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(options: { directory?: string; logger?: Logger } = {}) {
    this.directory = options.directory || resolveCodexNotificationInboxPath();
    this.logger = options.logger;
  }

  public async start(): Promise<void> {
    if (this.watcher) return;
    this.stopped = false;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.watcher = watch(this.directory, () => {
      void this.drain().catch((error) => this.warn("notification inbox drain failed", error));
    });
    this.watcher.on("error", (error) => this.warn("notification inbox watcher failed", error));
    await this.drain();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
    await this.drainPromise;
  }

  public async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainInternal();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = undefined;
    }
  }

  private async drainInternal(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      this.warn("notification inbox read failed", error);
      return;
    }

    let failed = false;
    for (const name of names) {
      const path = join(this.directory, name);
      try {
        const event = JSON.parse(await readFile(path, "utf8")) as CodexNotificationInboxEvent;
        if (!event.title || !event.body || (event.source !== "cli" && event.source !== "appServer")) {
          throw new Error("invalid notification inbox event");
        }
        await sendMacLocalNotification(event.title, event.body, event.source);
        await unlink(path);
      } catch (error) {
        failed = true;
        this.warn("notification inbox event failed; keeping it for retry", error, { path });
      }
    }
    if (failed && !this.stopped && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.drain().catch((error) => this.warn("notification inbox retry failed", error));
      }, 10_000);
    }
  }

  private warn(message: string, error: unknown, details?: Record<string, unknown>): void {
    this.logger?.warn(message, {
      ...(details || {}),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
