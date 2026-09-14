import { Dispatcher } from "./dispatcher.js";
import { isTerminalState } from "./state-machine.js";
import type { LarkClient } from "./lark.js";
import type { Logger } from "./types.js";
import { StateDatabase } from "./db.js";

export interface PollerOptions {
  lark: LarkClient;
  db: StateDatabase;
  dispatcher: Dispatcher;
  intervalSeconds: number;
  logger?: Logger;
}

export interface PollReport {
  listed: number;
  fetched: number;
  failed: number;
}

export class Poller {
  private readonly lark: LarkClient;
  private readonly db: StateDatabase;
  private readonly dispatcher: Dispatcher;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private stopped = false;
  private waitTimer: NodeJS.Timeout | undefined;
  private resolveWait: (() => void) | undefined;

  constructor(options: PollerOptions) {
    this.lark = options.lark;
    this.db = options.db;
    this.dispatcher = options.dispatcher;
    this.intervalMs = options.intervalSeconds * 1000;
    this.logger = options.logger ?? consoleLogger;
  }

  public async pollOnce(): Promise<PollReport> {
    const seen = new Set<string>();
    let summaries: Awaited<ReturnType<LarkClient["listIncompleteTasks"]>> = [];
    let failed = 0;
    try {
      summaries = await this.lark.listIncompleteTasks();
    } catch (error) {
      failed += 1;
      this.logger.warn("failed to list Feishu tasks", { error: safeMessage(error) });
    }

    let fetched = 0;
    for (const summary of summaries) {
      if (!summary.guid || seen.has(summary.guid)) continue;
      seen.add(summary.guid);
      try {
        const task = await this.lark.getTask(summary.guid);
        if (task.guid !== summary.guid) {
          throw new Error("lark-cli returned a task with a mismatched guid");
        }
        fetched += 1;
        await this.dispatcher.observe(task);
      } catch (error) {
        failed += 1;
        this.logger.warn("failed to process Feishu task", {
          taskGuid: summary.guid,
          error: safeMessage(error),
        });
      }
    }

    // The incomplete-task list cannot tell us when a task was completed. Fetch
    // locally tracked non-terminal tasks that disappeared from that list.
    for (const stored of this.db.listTrackedTasks()) {
      if (seen.has(stored.task_guid) || isTerminalState(stored.state)) continue;
      try {
        const task = await this.lark.getTask(stored.task_guid);
        if (task.guid !== stored.task_guid) {
          throw new Error("lark-cli returned a task with a mismatched guid");
        }
        fetched += 1;
        await this.dispatcher.observe(task);
      } catch (error) {
        failed += 1;
        this.logger.warn("failed to reconcile tracked Feishu task", {
          taskGuid: stored.task_guid,
          error: safeMessage(error),
        });
      }
    }

    await this.dispatcher.flushOutbox();
    return { listed: summaries.length, fetched, failed };
  }

  public async run(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      await this.pollOnce();
      if (!this.stopped) {
        await this.waitForNextPoll();
      }
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
    this.resolveWait?.();
    this.resolveWait = undefined;
  }

  private waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveWait = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = undefined;
        this.resolveWait = undefined;
        resolve();
      }, this.intervalMs);
    });
  }
}

const consoleLogger: Logger = {
  info(message, details) {
    console.info(message, details ?? "");
  },
  warn(message, details) {
    console.warn(message, details ?? "");
  },
  error(message, details) {
    console.error(message, details ?? "");
  },
};

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
