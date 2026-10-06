import { stat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DIRECT_RUNTIME_LEASE_NAME } from "./feishu-sqlite-codex.js";
import { isExecutableCodexPath } from "./codex-path.js";
import { resolveBridgeProjectRoot } from "./portable-runtime.js";
import { DatabaseSync, type SqliteDatabase } from "./sqlite.js";

export interface SystemHealthSnapshot {
  generatedAt: string;
  mode: string;
  version: string;
  database: { available: boolean; sizeBytes: number | null };
  dependencies: { configuredCodexCli: "available" | "unavailable" | "unknown"; feishuNetwork: "not_checked" };
  tasks: {
    desk: Record<string, number>;
    direct: Record<string, number>;
    aamp: Record<string, number>;
    oldestDeskQueuedAt: string | null;
    oldestDirectQueuedAt: string | null;
    oldestAampPendingAt: string | null;
  };
  runtimeLease: { state: "active" | "expired" | "absent"; expiresAt: string | null };
  outbox: { pending: number; due: number; delivered: number; deliveryFailedCards: number };
  storage: {
    webStaged: { count: number; bytes: number; expiredCount: number; expiredBytes: number };
    webBound: { count: number; bytes: number };
    directDownloadedCount: number;
    historyRetained: { count: number; declaredBytes: number; truncated: boolean };
    aampReferencedImageCount: number;
    aampReferenceScanTruncated: boolean;
  };
  recentErrors: Array<{ source: "desk" | "direct" | "aamp"; id: string; message: string; updatedAt: string }>;
}

type ReadonlySqliteConstructor = new (path: string, options: { readonly?: boolean; readOnly?: boolean }) => SqliteDatabase;
const Sqlite = DatabaseSync as unknown as ReadonlySqliteConstructor;
const MAX_STORAGE_REFERENCE_ROWS = 10_000;

function historyAttachmentSummary(db: SqliteDatabase): { count: number; declaredBytes: number; truncated: boolean } {
  const rows = db.prepare("SELECT payload_json FROM codex_history_runs WHERE payload_json IS NOT NULL LIMIT ?")
    .all(MAX_STORAGE_REFERENCE_ROWS + 1) as Array<{ payload_json: string }>;
  const ids = new Set<string>();
  let declaredBytes = 0;
  let truncated = rows.length > MAX_STORAGE_REFERENCE_ROWS;
  for (const row of rows.slice(0, MAX_STORAGE_REFERENCE_ROWS)) {
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    const attachments = (payload as { attachments?: unknown } | null)?.attachments;
    if (!Array.isArray(attachments)) continue;
    if (attachments.length > 100) truncated = true;
    for (const item of attachments.slice(0, 100)) {
      if (!item || typeof item !== "object") continue;
      const attachment = item as { attachmentId?: unknown; sizeBytes?: unknown };
      if (typeof attachment.attachmentId !== "string" || ids.has(attachment.attachmentId)) continue;
      if (typeof attachment.sizeBytes !== "number" || !Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes < 0) continue;
      if (ids.size >= MAX_STORAGE_REFERENCE_ROWS) { truncated = true; break; }
      ids.add(attachment.attachmentId);
      declaredBytes += attachment.sizeBytes;
    }
  }
  return { count: ids.size, declaredBytes, truncated };
}

function aampImageReferenceSummary(db: SqliteDatabase): { count: number; truncated: boolean } {
  const rows = db.prepare("SELECT image_local_paths FROM aamp_tasks LIMIT ?")
    .all(MAX_STORAGE_REFERENCE_ROWS + 1) as Array<{ image_local_paths: string }>;
  const paths = new Set<string>();
  let truncated = rows.length > MAX_STORAGE_REFERENCE_ROWS;
  for (const row of rows.slice(0, MAX_STORAGE_REFERENCE_ROWS)) {
    let value: unknown;
    try { value = JSON.parse(row.image_local_paths); } catch { continue; }
    if (!Array.isArray(value)) continue;
    if (value.length > 100) truncated = true;
    for (const path of value.slice(0, 100)) {
      if (paths.size >= MAX_STORAGE_REFERENCE_ROWS) { truncated = true; break; }
      if (typeof path === "string" && path) paths.add(path);
    }
  }
  return { count: paths.size, truncated };
}

function statusCounts(db: SqliteDatabase, table: "tasks" | "bridge_tasks" | "aamp_tasks", column: "state" | "status"): Record<string, number> {
  const rows = db.prepare(`SELECT ${column} AS status, COUNT(*) AS total FROM ${table} GROUP BY ${column}`)
    .all() as Array<{ status: string; total: number }>;
  return Object.fromEntries(rows.map(({ status, total }) => [status, Number(total)]));
}

/**
 * Reports the oldest last-update timestamp among rows currently in a queue state.
 * Queue transitions update updated_at, while created_at can predate retries/follow-ups.
 */
function oldestQueueUpdatedAt(
  db: SqliteDatabase,
  table: "tasks" | "bridge_tasks" | "aamp_tasks",
  column: "state" | "status",
  state: "QUEUED" | "pending",
): string | null {
  const row = db.prepare(`SELECT MIN(updated_at) AS oldest FROM ${table} WHERE ${column} = ?`)
    .get(state) as { oldest: string | null };
  return row.oldest;
}

export async function readBridgeVersion(): Promise<string> {
  const root = resolveBridgeProjectRoot(import.meta.url);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(moduleDirectory, "..", "package.json"), join(root, "package.json")]) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
      if (typeof value.version === "string" && value.version) return value.version;
    } catch {
      // A portable build may not include package.json.
    }
  }
  return "unknown";
}

/** Read-only diagnostic snapshot. It never claims, retries, or sends a task. */
export async function readSystemHealth(options: {
  databasePath: string;
  mode: string;
  version?: string;
  codexCliPath?: string;
  now?: Date;
}): Promise<SystemHealthSnapshot> {
  const now = options.now ?? new Date();
  const path = await realpath(resolve(options.databasePath));
  const isBun = typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== "undefined";
  const db = new Sqlite(path, isBun ? { readonly: true } : { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    const desk = statusCounts(db, "tasks", "state");
    const direct = statusCounts(db, "bridge_tasks", "status");
    const aamp = statusCounts(db, "aamp_tasks", "status");
    const lease = db.prepare("SELECT lease_expires_at FROM bridge_runtime_leases WHERE lease_name = ?")
      .get(DIRECT_RUNTIME_LEASE_NAME) as { lease_expires_at: string } | undefined;
    const outboxRow = db.prepare(`SELECT
      SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN completed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
      FROM outbox WHERE operation LIKE 'feishu.%'`).get(now.toISOString()) as Record<string, number | null>;
    const expiry = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const webStorage = db.prepare(`SELECT
      SUM(CASE WHEN task_guid IS NULL THEN 1 ELSE 0 END) AS staged_count,
      SUM(CASE WHEN task_guid IS NULL THEN size_bytes ELSE 0 END) AS staged_bytes,
      SUM(CASE WHEN task_guid IS NULL AND created_at <= ? THEN 1 ELSE 0 END) AS expired_count,
      SUM(CASE WHEN task_guid IS NULL AND created_at <= ? THEN size_bytes ELSE 0 END) AS expired_bytes,
      SUM(CASE WHEN task_guid IS NOT NULL THEN 1 ELSE 0 END) AS bound_count,
      SUM(CASE WHEN task_guid IS NOT NULL THEN size_bytes ELSE 0 END) AS bound_bytes
      FROM web_task_attachments`).get(expiry, expiry) as Record<string, number | null>;
    const directStorage = db.prepare("SELECT COUNT(*) AS total FROM bridge_task_attachments WHERE status = 'DOWNLOADED' AND local_path IS NOT NULL")
      .get() as { total: number };
    const historyStorage = historyAttachmentSummary(db);
    const aampStorage = aampImageReferenceSummary(db);
    const deliveryFailedCards = db.prepare("SELECT COUNT(*) AS total FROM bridge_tasks WHERE card_state = 'DELIVERY_FAILED'")
      .get() as { total: number };
    const errorRows = db.prepare(`SELECT source, id, message, updated_at FROM (
      SELECT 'desk' AS source, task_guid AS id, last_error AS message, updated_at FROM tasks WHERE state IN ('FAILED', 'BLOCKED_CONFIG') AND last_error IS NOT NULL AND last_error != ''
      UNION ALL SELECT 'direct', bridge_task_id, error, updated_at FROM bridge_tasks WHERE status = 'FAILED' AND error IS NOT NULL AND error != ''
      UNION ALL SELECT 'aamp', aamp_task_id, error_msg, updated_at FROM aamp_tasks WHERE status = 'failed' AND error_msg IS NOT NULL AND error_msg != ''
    ) ORDER BY updated_at DESC LIMIT 10`).all() as Array<{ source: "desk" | "direct" | "aamp"; id: string; message: string; updated_at: string }>;
    const [mainStat, walStat] = await Promise.all([
      stat(path).catch(() => null),
      stat(`${path}-wal`).catch(() => null),
    ]);
    return {
      generatedAt: now.toISOString(),
      mode: options.mode,
      version: options.version ?? await readBridgeVersion(),
      database: { available: true, sizeBytes: mainStat ? mainStat.size + (walStat?.size ?? 0) : null },
      dependencies: {
        configuredCodexCli: options.codexCliPath ? isExecutableCodexPath(options.codexCliPath) ? "available" : "unavailable" : "unknown",
        feishuNetwork: "not_checked",
      },
      tasks: {
        desk, direct, aamp,
        oldestDeskQueuedAt: oldestQueueUpdatedAt(db, "tasks", "state", "QUEUED"),
        oldestDirectQueuedAt: oldestQueueUpdatedAt(db, "bridge_tasks", "status", "QUEUED"),
        oldestAampPendingAt: oldestQueueUpdatedAt(db, "aamp_tasks", "status", "pending"),
      },
      runtimeLease: {
        state: !lease ? "absent" : Date.parse(lease.lease_expires_at) > now.getTime() ? "active" : "expired",
        expiresAt: lease?.lease_expires_at ?? null,
      },
      outbox: {
        pending: Number(outboxRow.pending ?? 0),
        due: Number(outboxRow.due ?? 0),
        delivered: Number(outboxRow.delivered ?? 0),
        deliveryFailedCards: Number(deliveryFailedCards.total),
      },
      storage: {
        webStaged: {
          count: Number(webStorage.staged_count ?? 0), bytes: Number(webStorage.staged_bytes ?? 0),
          expiredCount: Number(webStorage.expired_count ?? 0), expiredBytes: Number(webStorage.expired_bytes ?? 0),
        },
        webBound: { count: Number(webStorage.bound_count ?? 0), bytes: Number(webStorage.bound_bytes ?? 0) },
        directDownloadedCount: Number(directStorage.total),
        historyRetained: historyStorage,
        aampReferencedImageCount: aampStorage.count,
        aampReferenceScanTruncated: aampStorage.truncated,
      },
      recentErrors: errorRows.map((row) => ({ source: row.source, id: row.id, message: row.message.slice(0, 400), updatedAt: row.updated_at })),
    };
  } finally {
    db.close();
  }
}
