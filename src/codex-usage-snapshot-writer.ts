import { Worker } from "node:worker_threads";

import type { CodexHistoryUsageDailyBucket, CodexHistoryUsageSnapshot } from "./codex-history.js";
import { writeCodexUsageSnapshotRows } from "./codex-usage-snapshot.js";

export interface CodexUsageSnapshotWriterOptions {
  /** Internal timing overrides for isolated tests. Production defers writes for five seconds. */
  delayMs?: number;
}

interface PendingSnapshot {
  homeId: string;
  snapshot: CodexHistoryUsageSnapshot;
  buckets: CodexHistoryUsageDailyBucket[];
  dueAt: number;
  revision: number;
  onError?: (error: Error) => void;
}

interface WriteResult {
  id: number;
  error?: { message: string; code?: string };
}

const MAX_PENDING_SNAPSHOTS = 64;
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const isBun = typeof Bun !== "undefined";
const sqlite = require(isBun ? "bun:sqlite" : "node:sqlite");
const Database = isBun ? sqlite.Database : sqlite.DatabaseSync;
const writeRows = ${writeCodexUsageSnapshotRows.toString()};
parentPort.on("message", ({ id, homeId, snapshot, buckets }) => {
  let db;
  let error;
  try {
    db = new Database(workerData.databasePath, isBun ? { create: false, readwrite: true } : {});
    db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA wal_autocheckpoint = 0;");
    // Each statement autocommits; an error ends this attempt without rolling back prior rows.
    writeRows(db, homeId, snapshot, buckets);
  } catch (cause) {
    error = { message: cause instanceof Error ? cause.message : String(cause), code: cause?.code };
  } finally {
    try { db?.close(); } catch (cause) {
      error ??= { message: cause instanceof Error ? cause.message : String(cause), code: cause?.code };
    }
  }
  parentPort.postMessage({ id, ...(error ? { error } : {}) });
});
`;

/** A bounded, best-effort queue. No SQLite work runs on the HTTP/terminal thread. */
export class CodexUsageSnapshotWriter {
  private readonly pending = new Map<string, PendingSnapshot>();
  private readonly delayMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private worker?: Worker;
  private active?: { id: number; key: string; revision: number };
  private nextId = 0;
  private stopped = false;

  constructor(private readonly databasePath: string, options: CodexUsageSnapshotWriterOptions = {}) {
    this.delayMs = options.delayMs ?? 5_000;
  }

  public enqueue(
    homeId: string,
    snapshot: CodexHistoryUsageSnapshot,
    buckets: CodexHistoryUsageDailyBucket[],
    onError?: (error: Error) => void,
  ): void {
    if (this.stopped) return;
    const key = `${homeId}\u0000${snapshot.snapshotDate}`;
    const previous = this.pending.get(key);
    if (previous && previous.snapshot.capturedAt > snapshot.capturedAt) return;
    if (!previous && this.pending.size >= MAX_PENDING_SNAPSHOTS) {
      const oldest = [...this.pending.keys()].find((candidate) => candidate !== this.active?.key)!;
      this.pending.delete(oldest);
    }
    const mergedBuckets = new Map(previous?.buckets.map((bucket) => [bucket.startDate, bucket.tokens]));
    for (const bucket of buckets) mergedBuckets.set(bucket.startDate, bucket.tokens);
    this.pending.set(key, {
      homeId, snapshot: structuredClone(snapshot),
      buckets: [...mergedBuckets].map(([startDate, tokens]) => ({ startDate, tokens })),
      dueAt: previous?.dueAt ?? Date.now() + this.delayMs,
      revision: (previous?.revision ?? 0) + 1, onError,
    });
    this.schedule();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.active = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private schedule(): void {
    if (this.stopped || this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return;
    const dueAt = Math.min(...[...this.pending.values()].map((job) => job.dueAt));
    this.timer = setTimeout(() => this.writeNext(), Math.max(0, dueAt - Date.now()));
    this.timer.unref();
  }

  private writeNext(): void {
    this.timer = undefined;
    if (this.stopped || this.active) return;
    const next = [...this.pending.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
    if (!next) return;
    const [key, job] = next;
    if (job.dueAt > Date.now()) { this.schedule(); return; }
    const id = ++this.nextId;
    this.active = { id, key, revision: job.revision };
    try {
      const worker = this.worker ?? this.startWorker();
      worker.postMessage({ id, homeId: job.homeId, snapshot: job.snapshot, buckets: job.buckets });
    } catch (error) {
      this.finish({ id, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private startWorker(): Worker {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { databasePath: this.databasePath } });
    this.worker = worker;
    worker.on("message", (result: WriteResult) => this.finish(result));
    worker.on("error", (error: Error) => this.workerFailed(worker, error));
    worker.on("exit", (code) => this.workerFailed(worker, new Error(`usage snapshot worker exited (${code})`)));
    worker.unref();
    return worker;
  }

  private workerFailed(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    if (this.active) this.finish({ id: this.active.id, error: { message: error.message } });
  }

  private finish(result: WriteResult): void {
    const active = this.active;
    if (!active || result.id !== active.id) return;
    this.active = undefined;
    const job = this.pending.get(active.key);
    if (job) {
      if (result.error) {
        // Drop the failed attempt. A newer refresh is independent; never retry this write.
        if (job.revision === active.revision) this.pending.delete(active.key);
        try { job.onError?.(new Error(result.error.message)); } catch { /* Optional cache diagnostics. */ }
      } else if (job.revision === active.revision) {
        this.pending.delete(active.key);
      }
    }
    this.schedule();
  }
}
