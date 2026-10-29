import type { CodexHistoryUsageDailyBucket, CodexHistoryUsageSnapshot } from "./codex-history.js";
import type { SqliteDatabase } from "./sqlite.js";

// Keep this function self-contained: its JavaScript is also embedded in the
// background worker, including when Bridge is compiled into a single binary.
export function writeCodexUsageSnapshotRows(
  db: SqliteDatabase,
  homeId: string,
  snapshot: CodexHistoryUsageSnapshot,
  finalizedDailyBuckets: CodexHistoryUsageDailyBucket[],
): void {
  const upsertBucket = db.prepare(
    `INSERT INTO codex_account_usage_daily_buckets
       (home_id, usage_date, tokens, captured_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(home_id, usage_date) DO UPDATE SET
       tokens = excluded.tokens, captured_at = excluded.captured_at
     WHERE excluded.captured_at >= codex_account_usage_daily_buckets.captured_at`,
  );
  for (const bucket of finalizedDailyBuckets) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)
      || bucket.startDate >= snapshot.snapshotDate
      || !Number.isSafeInteger(bucket.tokens) || bucket.tokens < 0) continue;
    upsertBucket.run(homeId, bucket.startDate, bucket.tokens, snapshot.capturedAt);
  }
  db.prepare(
    `INSERT INTO codex_account_usage_snapshots (home_id, snapshot_date, captured_at, payload_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(home_id, snapshot_date) DO UPDATE SET
       captured_at = excluded.captured_at, payload_json = excluded.payload_json
     WHERE excluded.captured_at >= codex_account_usage_snapshots.captured_at`,
  ).run(homeId, snapshot.snapshotDate, snapshot.capturedAt, JSON.stringify(snapshot));
}
