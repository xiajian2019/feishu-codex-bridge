import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import { DatabaseSync as DatabaseSyncConstructor, type SqliteDatabase } from "./sqlite.js";
import { DIRECT_FOLLOWUP_STATUSES, DIRECT_TASK_STATUSES } from "./types.js";
import type {
  DatabaseChange,
  DirectMessageInput,
  OutboxEntry,
  RoutedTask,
  StoredRun,
  StoredRunEvent,
  StoredAampTask,
  StoredBridgeTask,
  StoredBridgeTaskAttachment,
  StoredBridgeTaskEvent,
  StoredBridgeTaskFollowup,
  StoredInboundEvent,
  AampTaskStatus,
  DirectTaskStatus,
  StoredTask,
  TaskState,
  WorkerProgress,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    task_guid TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    repo TEXT NOT NULL,
    state TEXT NOT NULL,
    input_text TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    thread_id TEXT,
    active_run_id TEXT,
    completed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    worker_pid INTEGER,
    service_instance_id TEXT,
    progress_event TEXT,
    progress_text TEXT,
    progress_updated_at TEXT
);

-- AAMP tasks are intentionally separate from the legacy Feishu task-list
-- state machine. The AAMP task id is the durable cross-process primary key;
-- this table is a business-state journal, not a dispatch queue.
CREATE TABLE IF NOT EXISTS aamp_tasks (
    aamp_task_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_text TEXT,
    image_local_paths TEXT NOT NULL DEFAULT '[]',
    card_id TEXT,
    card_message_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error_msg TEXT,
    last_delta_text TEXT NOT NULL DEFAULT '',
    approval_state TEXT,
    session_snapshot TEXT,
    relay_status_json TEXT,
    last_event_type TEXT,
    last_event_json TEXT
);

-- Shared visibility preference for the global task cards. The historical
-- column name is retained so existing AAMP databases remain compatible; it
-- may contain either an AAMP task id or a direct bridge task id.
CREATE TABLE IF NOT EXISTS aamp_hidden_tasks (
    chat_id TEXT NOT NULL,
    aamp_task_id TEXT NOT NULL,
    hidden_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, aamp_task_id)
);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    task_guid TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    input_text TEXT NOT NULL DEFAULT '',
    previous_input_text TEXT,
    prompt_text TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    state TEXT NOT NULL,
    final_response TEXT,
    usage_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    worker_pid INTEGER,
    service_instance_id TEXT,
    progress_event TEXT,
    progress_text TEXT,
    progress_updated_at TEXT,
    FOREIGN KEY(task_guid) REFERENCES tasks(task_guid)
);

CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_guid TEXT NOT NULL,
    event_type TEXT NOT NULL,
    item_type TEXT,
    item_id TEXT,
    message TEXT NOT NULL,
    usage_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id),
    FOREIGN KEY(task_guid) REFERENCES tasks(task_guid)
);

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_guid TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task_guid ON runs(task_guid);
CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(completed_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_aamp_tasks_status ON aamp_tasks(status, updated_at);

-- Direct Feishu + Codex SDK mode. These tables deliberately do not share the
-- legacy task-list state machine: an unrelated message starts a task, while a
-- reply is stored as a follow-up turn on the existing task.
CREATE TABLE IF NOT EXISTS inbound_events (
    source_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT
);

CREATE TABLE IF NOT EXISTS bridge_tasks (
    bridge_task_id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    chat_type TEXT NOT NULL CHECK (chat_type IN ('p2p', 'group')),
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    text TEXT NOT NULL,
    session_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'CANCELLED'
    )),
    thread_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    last_progress_event TEXT,
    last_progress_text TEXT,
    last_progress_at TEXT,
    card_message_id TEXT,
    card_state TEXT NOT NULL DEFAULT 'PENDING',
    card_content TEXT,
    card_updated_at TEXT,
    cancel_requested_at TEXT,
    cancel_reason TEXT,
    recovery_count INTEGER NOT NULL DEFAULT 0,
    last_recovered_at TEXT,
    final_response TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(source_event_id) REFERENCES inbound_events(source_event_id)
);

CREATE TABLE IF NOT EXISTS bridge_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bridge_task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(bridge_task_id) REFERENCES bridge_tasks(bridge_task_id)
);

CREATE INDEX IF NOT EXISTS idx_bridge_tasks_due
  ON bridge_tasks(status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_bridge_task_events_task
  ON bridge_task_events(bridge_task_id, id);

CREATE TABLE IF NOT EXISTS bridge_task_attachments (
    attachment_id TEXT PRIMARY KEY,
    bridge_task_id TEXT NOT NULL,
    followup_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('image', 'file', 'audio', 'video', 'sticker')),
    file_key TEXT NOT NULL,
    file_name TEXT,
    duration_ms INTEGER,
    cover_image_key TEXT,
    local_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'DOWNLOADED', 'FAILED')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(bridge_task_id) REFERENCES bridge_tasks(bridge_task_id)
);

CREATE INDEX IF NOT EXISTS idx_bridge_task_attachments_task
  ON bridge_task_attachments(bridge_task_id, created_at);

-- A reply to an existing direct task is a new Codex turn, not a new task.
-- Keep each message durable for idempotency and audit while the parent task
-- remains the single task/card/thread shown to the user.
CREATE TABLE IF NOT EXISTS bridge_task_followups (
    followup_id TEXT PRIMARY KEY,
    bridge_task_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL UNIQUE,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
    )),
    attempt INTEGER NOT NULL DEFAULT 0,
    final_response TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(bridge_task_id) REFERENCES bridge_tasks(bridge_task_id)
);

CREATE INDEX IF NOT EXISTS idx_bridge_task_followups_due
  ON bridge_task_followups(bridge_task_id, status, created_at);

CREATE TABLE IF NOT EXISTS bridge_runtime_leases (
    lease_name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

export interface ClaimRunArgs {
  task: RoutedTask;
  inputText: string;
  promptText: string;
  startedComment: string | ((runId: string) => string);
}

export interface AampTaskInit {
  aampTaskId: string;
  chatId: string;
  userText?: string | null;
  imageLocalPaths?: string[];
  cardId?: string | null;
  cardMessageId?: string | null;
  status?: AampTaskStatus;
  errorMsg?: string | null;
  lastDeltaText?: string;
  approvalState?: string | null;
  sessionSnapshot?: unknown;
  relayStatus?: unknown;
  eventType?: string | null;
  event?: unknown;
}

export interface AampTaskPatch {
  chatId?: string;
  userText?: string | null;
  imageLocalPaths?: string[];
  cardId?: string | null;
  cardMessageId?: string | null;
  status?: AampTaskStatus;
  errorMsg?: string | null;
  lastDeltaText?: string;
  approvalState?: string | null;
  sessionSnapshot?: unknown;
  relayStatus?: unknown;
  eventType?: string | null;
  event?: unknown;
}

export interface AampTaskQuery {
  statuses?: AampTaskStatus[];
  chatId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface BridgeTaskQuery {
  statuses?: DirectTaskStatus[];
  chatId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface BridgeTaskIngestResult {
  created: boolean;
  task: StoredBridgeTask;
  /** True when the message was attached as a follow-up turn to this task. */
  continued?: boolean;
}

export interface BridgeRecoveryReport {
  requeued: number;
  cancelled: number;
}

export interface RuntimeLeaseRecord {
  lease_name: string;
  owner: string;
  lease_expires_at: string;
  updated_at: string;
}

export interface OutboxSummary {
  total: number;
  pending: number;
  due: number;
  delivered: number;
}

export interface RunClaim {
  runId: string;
  taskGuid: string;
  resumedThreadId: string | null;
}

export interface BlockedConfigArgs {
  taskGuid: string;
  projectKey?: string;
  mode?: string;
  repo?: string;
  inputHash: string;
  inputText: string;
  message: string;
  /** Preserve the first project/repository after a thread has been created. */
  preserveProject?: boolean;
  comment: string;
}

export interface FinishRunArgs {
  status: "succeeded" | "failed" | "canceled";
  finalResponse?: string;
  usage?: unknown;
  error?: string;
  comment?: string;
}

export interface RecoveredRun {
  runId: string;
  taskGuid: string;
  error: string;
  comment: string;
}

export interface TaskQuery {
  states?: TaskState[];
  projectKey?: string;
  mode?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export class StateDatabase {
  private readonly db: SqliteDatabase;
  private readonly now: () => Date;
  private readonly changeListeners = new Set<(change: DatabaseChange) => void>();
  private pendingChanges: DatabaseChange[] | null = null;
  private transactionDepth = 0;

  constructor(filePath: string, now: () => Date = () => new Date()) {
    if (filePath !== ":memory:") {
      mkdirSync(dirname(resolve(filePath)), { recursive: true });
    }
    this.db = new DatabaseSyncConstructor(filePath);
    this.now = now;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.runMigrations();
  }

  public transaction<T>(callback: () => T): T {
    const isOuterTransaction = this.transactionDepth === 0;
    const savepoint = `bridge_tx_${this.transactionDepth}`;
    if (isOuterTransaction) this.pendingChanges = [];
    try {
      if (isOuterTransaction) this.db.exec("BEGIN");
      else this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
    } catch (error) {
      if (isOuterTransaction) this.pendingChanges = null;
      throw error;
    }
    try {
      const result = callback();
      this.transactionDepth -= 1;
      if (isOuterTransaction) {
        this.db.exec("COMMIT");
        this.flushChanges();
      } else {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (isOuterTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } finally {
          this.pendingChanges = null;
        }
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }

  public subscribe(listener: (change: DatabaseChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  public getTask(taskGuid: string): StoredTask | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE task_guid = ?")
      .get(taskGuid) as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  public getAampTask(aampTaskId: string): StoredAampTask | null {
    const row = this.db
      .prepare("SELECT * FROM aamp_tasks WHERE aamp_task_id = ?")
      .get(aampTaskId) as Record<string, unknown> | undefined;
    return row ? mapAampTask(row) : null;
  }

  public getGlobalHiddenTaskIds(chatId: string): string[] {
    const normalizedChatId = requireNonEmpty(chatId, "chatId");
    const rows = this.db
      .prepare("SELECT aamp_task_id FROM aamp_hidden_tasks WHERE chat_id = ? ORDER BY hidden_at DESC")
      .all(normalizedChatId) as Array<{ aamp_task_id: string }>;
    return rows.map((row) => String(row.aamp_task_id));
  }

  public hideGlobalTask(taskId: string, chatId: string): boolean {
    const normalizedTaskId = requireNonEmpty(taskId, "taskId");
    const normalizedChatId = requireNonEmpty(chatId, "chatId");
    const result = this.db
      .prepare(
        `INSERT INTO aamp_hidden_tasks (chat_id, aamp_task_id, hidden_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id, aamp_task_id) DO UPDATE SET hidden_at = excluded.hidden_at`,
      )
      .run(normalizedChatId, normalizedTaskId, this.timestamp());
    return result.changes > 0;
  }

  public getInboundEvent(sourceEventId: string): StoredInboundEvent | null {
    const row = this.db
      .prepare("SELECT * FROM inbound_events WHERE source_event_id = ?")
      .get(sourceEventId) as Record<string, unknown> | undefined;
    return row ? mapInboundEvent(row) : null;
  }

  public getBridgeTask(bridgeTaskId: string): StoredBridgeTask | null {
    const row = this.db
      .prepare("SELECT * FROM bridge_tasks WHERE bridge_task_id = ?")
      .get(bridgeTaskId) as Record<string, unknown> | undefined;
    return row ? mapBridgeTask(row) : null;
  }

  public getBridgeTaskBySourceEvent(sourceEventId: string): StoredBridgeTask | null {
    const row = this.db
      .prepare("SELECT * FROM bridge_tasks WHERE source_event_id = ?")
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row) return mapBridgeTask(row);
    const followup = this.db
      .prepare(
        `SELECT t.* FROM bridge_tasks t
         INNER JOIN bridge_task_followups f ON f.bridge_task_id = t.bridge_task_id
         WHERE f.source_event_id = ?
         LIMIT 1`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    return followup ? mapBridgeTask(followup) : null;
  }

  public getBridgeTaskByMessage(messageId: string): StoredBridgeTask | null {
    const row = this.db
      .prepare("SELECT * FROM bridge_tasks WHERE message_id = ?")
      .get(messageId) as Record<string, unknown> | undefined;
    if (row) return mapBridgeTask(row);
    const followup = this.db
      .prepare(
        `SELECT t.* FROM bridge_tasks t
         INNER JOIN bridge_task_followups f ON f.bridge_task_id = t.bridge_task_id
         WHERE f.message_id = ?
         LIMIT 1`,
      )
      .get(messageId) as Record<string, unknown> | undefined;
    return followup ? mapBridgeTask(followup) : null;
  }

  public getBridgeTaskByCardMessage(messageId: string): StoredBridgeTask | null {
    const row = this.db
      .prepare("SELECT * FROM bridge_tasks WHERE card_message_id = ?")
      .get(messageId) as Record<string, unknown> | undefined;
    return row ? mapBridgeTask(row) : null;
  }

  /** Find the direct task whose Feishu message a new message replies to. */
  public getBridgeTaskForReply(
    input: Pick<DirectMessageInput, "chatId" | "replyToMessageId" | "rootMessageId" | "threadId">,
  ): StoredBridgeTask | null {
    const chatId = requireNonEmpty(input.chatId, "chatId");
    const references = [...new Set(
      [input.replyToMessageId, input.rootMessageId]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    )];
    for (const messageId of references) {
      const root = this.db
        .prepare(
          `SELECT * FROM bridge_tasks
           WHERE chat_id = ? AND (message_id = ? OR card_message_id = ?)
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(chatId, messageId, messageId) as Record<string, unknown> | undefined;
      if (root) return mapBridgeTask(root);
      const followup = this.db
        .prepare(
          `SELECT t.* FROM bridge_tasks t
           INNER JOIN bridge_task_followups f ON f.bridge_task_id = t.bridge_task_id
           WHERE t.chat_id = ? AND f.message_id = ?
           ORDER BY t.updated_at DESC LIMIT 1`,
        )
        .get(chatId, messageId) as Record<string, unknown> | undefined;
      if (followup) return mapBridgeTask(followup);
    }

    const threadId = input.threadId?.trim();
    if (!threadId) return null;
    const threadTask = this.db
      .prepare(
        `SELECT * FROM bridge_tasks
         WHERE chat_id = ? AND session_key = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(chatId, `chat:${chatId}:thread:${threadId}`) as Record<string, unknown> | undefined;
    return threadTask ? mapBridgeTask(threadTask) : null;
  }

  public findBridgeTasksById(selector: string, limit = 200): StoredBridgeTask[] {
    const normalizedSelector = requireNonEmpty(selector, "selector");
    const boundedLimit = Math.min(500, Math.max(1, limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM bridge_tasks
         WHERE bridge_task_id = ? OR bridge_task_id LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(normalizedSelector, `${normalizedSelector}%`, boundedLimit) as Record<string, unknown>[];
    return rows.map(mapBridgeTask);
  }

  public getActiveBridgeTaskForSession(sessionKey: string): StoredBridgeTask | null {
    const normalizedSessionKey = requireNonEmpty(sessionKey, "sessionKey");
    const row = this.db
      .prepare(
        `SELECT * FROM bridge_tasks
         WHERE session_key = ? AND status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
         ORDER BY CASE WHEN status IN ('RUNNING', 'CANCEL_REQUESTED') THEN 0 ELSE 1 END,
                  created_at DESC LIMIT 1`,
      )
      .get(normalizedSessionKey) as Record<string, unknown> | undefined;
    return row ? mapBridgeTask(row) : null;
  }

  /** Return the most recent task with a Codex thread for route-aware resume. */
  public getLatestBridgeTaskForSession(
    sessionKey: string,
    excludingTaskId?: string,
  ): StoredBridgeTask | null {
    const normalizedSessionKey = requireNonEmpty(sessionKey, "sessionKey");
    const row = excludingTaskId
      ? this.db
        .prepare(
          `SELECT * FROM bridge_tasks
           WHERE session_key = ? AND bridge_task_id <> ? AND thread_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(normalizedSessionKey, excludingTaskId) as Record<string, unknown> | undefined
      : this.db
        .prepare(
          `SELECT * FROM bridge_tasks
           WHERE session_key = ? AND thread_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(normalizedSessionKey) as Record<string, unknown> | undefined;
    return row ? mapBridgeTask(row) : null;
  }

  public getBridgeTaskAttachments(
    bridgeTaskId: string,
    followupId?: string | null,
  ): StoredBridgeTaskAttachment[] {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const rows = followupId === undefined
      ? this.db
        .prepare(
          `SELECT * FROM bridge_task_attachments
           WHERE bridge_task_id = ?
           ORDER BY created_at ASC, attachment_id ASC`,
        )
        .all(taskId) as Record<string, unknown>[]
      : followupId === null
        ? this.db
          .prepare(
            `SELECT * FROM bridge_task_attachments
             WHERE bridge_task_id = ? AND followup_id IS NULL
             ORDER BY created_at ASC, attachment_id ASC`,
          )
          .all(taskId) as Record<string, unknown>[]
        : this.db
        .prepare(
          `SELECT * FROM bridge_task_attachments
           WHERE bridge_task_id = ? AND followup_id = ?
           ORDER BY created_at ASC, attachment_id ASC`,
        )
        .all(taskId, requireNonEmpty(followupId, "followupId")) as Record<string, unknown>[];
    return rows.map(mapBridgeTaskAttachment);
  }

  public getNextBridgeTaskFollowup(bridgeTaskId: string): StoredBridgeTaskFollowup | null {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const row = this.db
      .prepare(
        `SELECT * FROM bridge_task_followups
         WHERE bridge_task_id = ? AND status = 'QUEUED'
         ORDER BY created_at ASC, followup_id ASC LIMIT 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? mapBridgeTaskFollowup(row) : null;
  }

  public claimBridgeTaskFollowup(followupId: string): StoredBridgeTaskFollowup | null {
    const id = requireNonEmpty(followupId, "followupId");
    return this.transaction(() => {
      const now = this.timestamp();
      const result = this.db
        .prepare(
          `UPDATE bridge_task_followups SET status = 'RUNNING', attempt = attempt + 1,
             updated_at = ? WHERE followup_id = ? AND status = 'QUEUED'`,
        )
        .run(now, id);
      if (result.changes === 0) return null;
      const row = this.db
        .prepare("SELECT * FROM bridge_task_followups WHERE followup_id = ?")
        .get(id) as Record<string, unknown> | undefined;
      return row ? mapBridgeTaskFollowup(row) : null;
    });
  }

  public finishBridgeTaskFollowup(
    followupId: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    finalResponse?: string,
    error?: string,
  ): StoredBridgeTaskFollowup | null {
    const id = requireNonEmpty(followupId, "followupId");
    return this.transaction(() => {
      const now = this.timestamp();
      const result = this.db
        .prepare(
          `UPDATE bridge_task_followups SET status = ?, final_response = ?, error = ?, updated_at = ?
           WHERE followup_id = ? AND status IN ('QUEUED', 'RUNNING')`,
        )
        .run(status, finalResponse?.trim() || null, error?.trim() || null, now, id);
      if (result.changes === 0) return null;
      const row = this.db
        .prepare("SELECT * FROM bridge_task_followups WHERE followup_id = ?")
        .get(id) as Record<string, unknown> | undefined;
      return row ? mapBridgeTaskFollowup(row) : null;
    });
  }

  public hasPendingBridgeTaskFollowups(bridgeTaskId: string): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const row = this.db
      .prepare(
        `SELECT 1 FROM bridge_task_followups
         WHERE bridge_task_id = ? AND status IN ('QUEUED', 'RUNNING') LIMIT 1`,
      )
      .get(taskId);
    return Boolean(row);
  }

  public getLatestBridgeThreadId(
    sessionKey: string,
    excludingTaskId?: string,
  ): string | null {
    const normalizedSessionKey = requireNonEmpty(sessionKey, "sessionKey");
    const row = excludingTaskId
      ? this.db
        .prepare(
          `SELECT thread_id FROM bridge_tasks
           WHERE session_key = ? AND bridge_task_id <> ? AND thread_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(normalizedSessionKey, excludingTaskId) as { thread_id?: unknown } | undefined
      : this.db
        .prepare(
          `SELECT thread_id FROM bridge_tasks
           WHERE session_key = ? AND thread_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(normalizedSessionKey) as { thread_id?: unknown } | undefined;
    return row?.thread_id ? String(row.thread_id) : null;
  }

  public listBridgeTasks(
    query: BridgeTaskQuery = {},
  ): { items: StoredBridgeTask[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.statuses && query.statuses.length > 0) {
      clauses.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      params.push(...query.statuses);
    }
    if (query.chatId) {
      clauses.push("chat_id = ?");
      params.push(query.chatId);
    }
    if (query.search) {
      const pattern = `%${query.search}%`;
      clauses.push(
        "(bridge_task_id LIKE ? OR message_id LIKE ? OR sender_id LIKE ? OR text LIKE ? OR COALESCE(error, '') LIKE ?)",
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM bridge_tasks${where}`)
      .get(...params) as { total: number };
    const rows = this.db
      .prepare(`SELECT * FROM bridge_tasks${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(mapBridgeTask), total: countRow.total };
  }

  public getBridgeTaskStatusCounts(): Record<DirectTaskStatus, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS total FROM bridge_tasks GROUP BY status")
      .all() as Array<{ status: string; total: number }>;
    const counts = Object.fromEntries(DIRECT_TASK_STATUSES.map((status) => [status, 0])) as Record<DirectTaskStatus, number>;
    for (const row of rows) {
      if (DIRECT_TASK_STATUSES.includes(row.status as DirectTaskStatus)) {
        counts[row.status as DirectTaskStatus] = Number(row.total);
      }
    }
    return counts;
  }

  /**
   * Persist an incoming Feishu message atomically. A reply to a known direct
   * task becomes a follow-up turn on that task; unrelated messages create a
   * new task. Source event IDs and message IDs make both paths idempotent.
   */
  public ingestDirectMessage(input: DirectMessageInput): BridgeTaskIngestResult {
    const sourceEventId = requireNonEmpty(input.sourceEventId, "sourceEventId");
    const eventType = requireNonEmpty(input.eventType, "eventType");
    const messageId = requireNonEmpty(input.messageId, "messageId");
    const chatId = requireNonEmpty(input.chatId, "chatId");
    const senderId = requireNonEmpty(input.senderId, "senderId");
    const text = requireNonEmpty(input.text, "text");
    const sessionKey = requireNonEmpty(input.sessionKey, "sessionKey");
    const attachments = (input.attachments ?? []).map((attachment) => ({
      ...attachment,
      fileKey: requireNonEmpty(attachment.fileKey, "attachment.fileKey"),
    }));

    return this.transaction(() => {
      const existing = this.getBridgeTaskBySourceEvent(sourceEventId)
        ?? this.getBridgeTaskByMessage(messageId);
      if (existing) {
        return { created: false, task: existing };
      }

      const now = this.timestamp();
      const continuation = this.getBridgeTaskForReply(input);
      if (continuation && continuation.chat_id === chatId) {
        const followupId = makeBridgeFollowupId();
        this.db
          .prepare(
            `INSERT INTO inbound_events
              (source_event_id, event_type, message_id, chat_id, sender_id,
               payload_json, received_at, processed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceEventId,
            eventType,
            messageId,
            chatId,
            senderId,
            encodeJson(input.payload ?? {}),
            now,
            now,
          );
        this.db
          .prepare(
            `INSERT INTO bridge_task_followups
              (followup_id, bridge_task_id, source_event_id, message_id,
               sender_id, sender_name, text, status, attempt, final_response,
               error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, NULL, NULL, ?, ?)`,
          )
          .run(
            followupId,
            continuation.bridge_task_id,
            sourceEventId,
            messageId,
            senderId,
            input.senderName ?? null,
            text,
            now,
            now,
          );
        for (const attachment of attachments) {
          this.db
            .prepare(
              `INSERT INTO bridge_task_attachments
                (attachment_id, bridge_task_id, followup_id, type, file_key,
                 file_name, duration_ms, cover_image_key, local_path, status,
                 error, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'PENDING', NULL, ?, ?)`,
            )
            .run(
              makeBridgeAttachmentId(),
              continuation.bridge_task_id,
              followupId,
              attachment.type,
              attachment.fileKey,
              attachment.fileName ?? null,
              attachment.durationMs ?? null,
              attachment.coverImageKey ?? null,
              now,
              now,
            );
        }

        const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(continuation.status);
        if (terminal) {
          this.db
            .prepare(
              `UPDATE bridge_tasks SET status = 'QUEUED', next_attempt_at = ?,
                 lease_owner = NULL, lease_expires_at = NULL,
                 last_progress_event = 'followup.queued',
                 last_progress_text = ?, last_progress_at = ?,
                 card_state = CASE WHEN card_message_id IS NULL THEN 'PENDING' ELSE 'STREAMING' END,
                 card_content = NULL, card_updated_at = ?,
                 cancel_requested_at = NULL, cancel_reason = NULL,
                 final_response = NULL, error = NULL, updated_at = ?
               WHERE bridge_task_id = ?`,
            )
            .run(
              now,
              "已收到续问，等待继续处理。",
              now,
              now,
              now,
              continuation.bridge_task_id,
            );
        } else {
          this.db
            .prepare(
              `UPDATE bridge_tasks SET last_progress_event = 'followup.queued',
                 last_progress_text = ?, last_progress_at = ?, updated_at = ?
               WHERE bridge_task_id = ?`,
            )
            .run("已收到续问，当前任务完成后继续处理。", now, now, continuation.bridge_task_id);
        }

        const updated = this.getBridgeTask(continuation.bridge_task_id)!;
        this.ensureBridgeCardOutboxInTransaction(updated, now);
        this.db
          .prepare(
            `INSERT INTO bridge_task_events
              (bridge_task_id, event_type, payload_json, created_at)
             VALUES (?, 'followup.queued', ?, ?)`,
          )
          .run(
            continuation.bridge_task_id,
            encodeJson({ followupId, messageId, replyToMessageId: input.replyToMessageId }),
            now,
          );
        this.noteChange({ kind: "inbound_event", taskGuid: continuation.bridge_task_id, at: now });
        this.noteChange({ kind: "bridge_task", taskGuid: continuation.bridge_task_id, at: now });
        return { created: true, continued: true, task: updated };
      }

      const bridgeTaskId = makeBridgeTaskId(now);
      this.db
        .prepare(
          `INSERT INTO inbound_events
            (source_event_id, event_type, message_id, chat_id, sender_id,
             payload_json, received_at, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sourceEventId,
          eventType,
          messageId,
          chatId,
          senderId,
          encodeJson(input.payload ?? {}),
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO bridge_tasks
            (bridge_task_id, source_event_id, message_id, chat_id, chat_type,
             sender_id, sender_name, text, session_key, status, thread_id, attempt,
             next_attempt_at, lease_owner, lease_expires_at, last_progress_event,
             last_progress_text, last_progress_at, card_message_id, card_state,
             card_content, card_updated_at, cancel_requested_at, cancel_reason,
             recovery_count, last_recovered_at, final_response, error,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, 0, ?, NULL, NULL,
                   NULL, NULL, NULL, NULL, 'PENDING', NULL, NULL, NULL, NULL,
                   0, NULL, NULL, NULL, ?, ?)`
        )
        .run(
          bridgeTaskId,
          sourceEventId,
          messageId,
          chatId,
          input.chatType,
          senderId,
          input.senderName ?? null,
          text,
          sessionKey,
          now,
          now,
          now,
        );
      for (const attachment of attachments) {
        this.db
          .prepare(
            `INSERT INTO bridge_task_attachments
              (attachment_id, bridge_task_id, followup_id, type, file_key, file_name,
               duration_ms, cover_image_key, local_path, status, error,
               created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'PENDING', NULL, ?, ?)`,
          )
          .run(
            makeBridgeAttachmentId(),
            bridgeTaskId,
            attachment.type,
            attachment.fileKey,
            attachment.fileName ?? null,
            attachment.durationMs ?? null,
            attachment.coverImageKey ?? null,
            now,
            now,
          );
      }
      this.enqueueOutboxInTransaction(
        bridgeTaskId,
        "feishu.stream_card",
        { bridgeTaskId, chatId, replyTo: messageId },
        now,
      );
      this.noteChange({ kind: "inbound_event", taskGuid: bridgeTaskId, at: now });
      this.noteChange({ kind: "bridge_task", taskGuid: bridgeTaskId, at: now });
      return { created: true, task: this.getBridgeTask(bridgeTaskId)! };
    });
  }

  /** Persist a control/permission event without creating a Codex task. */
  public ingestDirectControl(input: DirectMessageInput, replyText: string): boolean {
    const reply = requireNonEmpty(replyText, "replyText");
    return this.ingestDirectControlOutbox(input, "feishu.send_text", {
      chatId: input.chatId,
      text: reply,
      replyTo: input.messageId,
    });
  }

  /**
   * Persist a slash command or card-action response through the durable outbox.
   * When updateMessageId is present, the delivery worker updates that existing
   * Feishu card instead of sending a second card.
   */
  public ingestDirectControlCard(
    input: DirectMessageInput,
    card: object,
    updateMessageId?: string,
  ): boolean {
    return this.ingestDirectControlOutbox(input, "feishu.send_card", {
      chatId: input.chatId,
      card,
      ...(updateMessageId?.trim() ? { updateMessageId: updateMessageId.trim() } : {}),
    });
  }

  /** Claim one queued task, or reclaim a task whose worker lease expired. */
  public claimDueBridgeTask(workerId: string, leaseMs: number): StoredBridgeTask | null {
    const owner = requireNonEmpty(workerId, "workerId");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("leaseMs must be positive");
    }
    return this.transaction(() => {
      const now = this.timestamp();
      const candidate = this.db
        .prepare(
          `SELECT * FROM bridge_tasks
           WHERE (status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(now, now) as Record<string, unknown> | undefined;
      if (!candidate) return null;

      const bridgeTaskId = String(candidate.bridge_task_id);
      const leaseExpiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
      const result = this.db
        .prepare(
          `UPDATE bridge_tasks SET status = 'RUNNING', attempt = attempt + 1,
             next_attempt_at = NULL, lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE bridge_task_id = ?
             AND ((status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
               OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`,
        )
        .run(owner, leaseExpiresAt, now, bridgeTaskId, now, now);
      if (result.changes === 0) return null;
      this.noteChange({ kind: "bridge_task", taskGuid: bridgeTaskId, at: now });
      return this.getBridgeTask(bridgeTaskId);
    });
  }

  public renewBridgeTaskLease(
    bridgeTaskId: string,
    workerId: string,
    leaseMs: number,
  ): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const owner = requireNonEmpty(workerId, "workerId");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("leaseMs must be positive");
    }
    const now = this.timestamp();
    const leaseExpiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE bridge_tasks SET lease_expires_at = ?, updated_at = ?
         WHERE bridge_task_id = ? AND lease_owner = ?
           AND status IN ('RUNNING', 'CANCEL_REQUESTED')`,
      )
      .run(leaseExpiresAt, now, taskId, owner);
    if (result.changes > 0) this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
    return result.changes > 0;
  }

  /** Put a task back into the durable queue when this worker is stopping. */
  public requeueBridgeTask(
    bridgeTaskId: string,
    workerId: string,
    reason = "桥接服务正在停止，任务已重新排队。",
  ): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const owner = requireNonEmpty(workerId, "workerId");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (!task || task.lease_owner !== owner || task.status === "CANCEL_REQUESTED") {
        return false;
      }
      const now = this.timestamp();
      const result = this.db
        .prepare(
          `UPDATE bridge_tasks SET status = 'QUEUED', next_attempt_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, last_progress_event = ?,
             last_progress_text = ?, last_progress_at = ?, updated_at = ?
           WHERE bridge_task_id = ? AND lease_owner = ? AND status = 'RUNNING'`,
        )
        .run(now, "runtime.requeued", reason, now, now, taskId, owner);
      if (result.changes > 0) {
        this.db
          .prepare(
            `UPDATE bridge_task_followups SET status = 'QUEUED', updated_at = ?
             WHERE bridge_task_id = ? AND status = 'RUNNING'`,
          )
          .run(now, taskId);
        this.db
          .prepare(
            `INSERT INTO bridge_task_events
              (bridge_task_id, event_type, payload_json, created_at)
             VALUES (?, 'runtime.requeued', ?, ?)`,
          )
          .run(taskId, encodeJson({ reason }), now);
        this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      }
      return result.changes > 0;
    });
  }

  /** Schedule a transient Codex/runtime failure for a later durable retry. */
  public scheduleBridgeTaskRetry(
    bridgeTaskId: string,
    workerId: string,
    reason: string,
    nextAttemptAt: string,
  ): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const owner = requireNonEmpty(workerId, "workerId");
    const normalizedReason = requireNonEmpty(reason, "reason");
    const retryAt = requireNonEmpty(nextAttemptAt, "nextAttemptAt");
    if (!Number.isFinite(Date.parse(retryAt))) throw new Error("nextAttemptAt must be an ISO timestamp");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (!task || task.lease_owner !== owner || task.status !== "RUNNING") return false;
      const now = this.timestamp();
      const result = this.db
        .prepare(
          `UPDATE bridge_tasks SET status = 'QUEUED', next_attempt_at = ?,
             lease_owner = NULL, lease_expires_at = NULL,
             last_progress_event = 'retry.scheduled', last_progress_text = ?,
             last_progress_at = ?, updated_at = ?
           WHERE bridge_task_id = ? AND lease_owner = ? AND status = 'RUNNING'`,
        )
        .run(retryAt, normalizedReason, now, now, taskId, owner);
      if (result.changes === 0) return false;
      this.db
        .prepare(
          `UPDATE bridge_task_followups SET status = 'QUEUED', updated_at = ?
           WHERE bridge_task_id = ? AND status = 'RUNNING'`,
        )
        .run(now, taskId);
      this.db
        .prepare(
          `INSERT INTO bridge_task_events
            (bridge_task_id, event_type, payload_json, created_at)
           VALUES (?, 'retry.scheduled', ?, ?)`,
        )
        .run(taskId, encodeJson({
          reason: normalizedReason,
          nextAttemptAt: retryAt,
          attempt: task.attempt,
        }), now);
      this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      return true;
    });
  }

  /** Request cancellation without killing the worker from inside SQLite. */
  public requestBridgeTaskCancellation(
    bridgeTaskId: string,
    reason = "用户请求取消当前任务。",
  ): StoredBridgeTask | null {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const normalizedReason = requireNonEmpty(reason, "reason");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (!task) return null;
      if (task.status === "SUCCEEDED" || task.status === "FAILED" || task.status === "CANCELLED") {
        return task;
      }
      const now = this.timestamp();
      const nextStatus = task.status === "QUEUED" ? "CANCELLED" : "CANCEL_REQUESTED";
      this.db
        .prepare(
          `UPDATE bridge_tasks SET status = ?, cancel_requested_at = ?, cancel_reason = ?,
             lease_owner = CASE WHEN ? = 'CANCELLED' THEN NULL ELSE lease_owner END,
             lease_expires_at = CASE WHEN ? = 'CANCELLED' THEN NULL ELSE lease_expires_at END,
             next_attempt_at = CASE WHEN ? = 'CANCELLED' THEN NULL ELSE next_attempt_at END,
             updated_at = ? WHERE bridge_task_id = ?`,
        )
        .run(
          nextStatus,
          now,
          normalizedReason,
          nextStatus,
          nextStatus,
          nextStatus,
          now,
          taskId,
        );
      this.db
        .prepare(
          `INSERT INTO bridge_task_events
            (bridge_task_id, event_type, payload_json, created_at)
           VALUES (?, 'cancel.requested', ?, ?)`,
        )
        .run(taskId, encodeJson({ reason: normalizedReason }), now);
      if (nextStatus === "CANCELLED") {
        this.db
          .prepare(
            `INSERT INTO bridge_task_events
              (bridge_task_id, event_type, payload_json, created_at)
             VALUES (?, 'cancelled', ?, ?)`,
          )
          .run(taskId, encodeJson({ reason: normalizedReason }), now);
        if (task.card_state === "DELIVERY_FAILED") {
          this.enqueueOutboxInTransaction(
            taskId,
            "feishu.send_text",
            { chatId: task.chat_id, text: `任务已取消：${normalizedReason}`, replyTo: task.message_id },
            now,
          );
        }
      }
      this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      return this.getBridgeTask(taskId);
    });
  }

  public saveBridgeThreadId(
    bridgeTaskId: string,
    threadId: string,
    workerId?: string,
  ): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const normalizedThreadId = requireNonEmpty(threadId, "threadId");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (!task) return false;
      const now = this.timestamp();
      const ownerClause = workerId ? " AND lease_owner = ?" : "";
      const params = workerId
        ? [normalizedThreadId, now, taskId, workerId]
        : [normalizedThreadId, now, taskId];
      const result = this.db
        .prepare(
          `UPDATE bridge_tasks SET thread_id = ?, updated_at = ?
           WHERE bridge_task_id = ?${ownerClause}`,
        )
        .run(...params);
      if (result.changes > 0) {
        this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      }
      return result.changes > 0;
    });
  }

  public recordBridgeTaskProgress(
    bridgeTaskId: string,
    eventType: string,
    message: string,
    payload: unknown = {},
    workerId?: string,
  ): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const type = requireNonEmpty(eventType, "eventType");
    const progress = requireNonEmpty(message, "message");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (
        !task
        || task.status === "SUCCEEDED"
        || task.status === "FAILED"
        || task.status === "CANCELLED"
        || (workerId && task.lease_owner !== workerId)
      ) return false;
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO bridge_task_events
            (bridge_task_id, event_type, payload_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(taskId, type, encodeJson(payload), now);
      const ownerClause = workerId ? " AND lease_owner = ?" : "";
      const params = workerId
        ? [type, progress, now, now, taskId, workerId]
        : [type, progress, now, now, taskId];
      this.db
        .prepare(
          `UPDATE bridge_tasks SET last_progress_event = ?, last_progress_text = ?,
             last_progress_at = ?, updated_at = ? WHERE bridge_task_id = ?${ownerClause}`,
        )
        .run(...params);
      this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      return true;
    });
  }

  public listBridgeTaskEvents(bridgeTaskId: string, limit = 500): StoredBridgeTaskEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM bridge_task_events WHERE bridge_task_id = ? ORDER BY id ASC LIMIT ?",
      )
      .all(bridgeTaskId, Math.min(1000, Math.max(1, limit))) as Record<string, unknown>[];
    return rows.map(mapBridgeTaskEvent);
  }

  public markBridgeCardStreaming(bridgeTaskId: string, messageId: string): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const cardMessageId = requireNonEmpty(messageId, "messageId");
    const now = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE bridge_tasks SET card_message_id = ?, card_state = 'STREAMING',
           card_updated_at = ?, updated_at = ?
         WHERE bridge_task_id = ? AND card_state <> 'DELIVERY_FAILED'`,
      )
      .run(cardMessageId, now, now, taskId);
    if (result.changes > 0) this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
    return result.changes > 0;
  }

  public saveBridgeCardContent(bridgeTaskId: string, content: string): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const normalizedContent = requireNonEmpty(content, "content");
    const now = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE bridge_tasks SET card_content = ?, card_updated_at = ?, updated_at = ?
         WHERE bridge_task_id = ? AND card_state <> 'DELIVERY_FAILED'`,
      )
      .run(normalizedContent, now, now, taskId);
    if (result.changes > 0) this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
    return result.changes > 0;
  }

  public markBridgeCardCompleted(bridgeTaskId: string): boolean {
    return this.updateBridgeCardState(bridgeTaskId, "COMPLETED");
  }

  public markBridgeCardDeliveryFailed(bridgeTaskId: string, error: string): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const normalizedError = requireNonEmpty(error, "error");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (!task || task.card_state === "COMPLETED") return false;
      const now = this.timestamp();
      const result = this.db
        .prepare(
          `UPDATE bridge_tasks SET card_state = 'DELIVERY_FAILED', error = COALESCE(error, ?),
             card_updated_at = ?, updated_at = ? WHERE bridge_task_id = ?`,
        )
        .run(normalizedError, now, now, taskId);
      if (result.changes > 0) {
        this.db
          .prepare(
            `INSERT INTO bridge_task_events
              (bridge_task_id, event_type, payload_json, created_at)
             VALUES (?, 'card.delivery_failed', ?, ?)`,
          )
          .run(taskId, encodeJson({ error: normalizedError }), now);
        this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      }
      return result.changes > 0;
    });
  }

  public markAttachmentDownloaded(attachmentId: string, localPath: string): boolean {
    const id = requireNonEmpty(attachmentId, "attachmentId");
    const path = requireNonEmpty(localPath, "localPath");
    const now = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE bridge_task_attachments SET local_path = ?, status = 'DOWNLOADED',
           error = NULL, updated_at = ? WHERE attachment_id = ?`,
      )
      .run(path, now, id);
    if (result.changes > 0) {
      const row = this.db
        .prepare("SELECT bridge_task_id FROM bridge_task_attachments WHERE attachment_id = ?")
        .get(id) as { bridge_task_id?: string } | undefined;
      if (row?.bridge_task_id) {
        this.noteChange({ kind: "bridge_task", taskGuid: row.bridge_task_id, at: now });
      }
    }
    return result.changes > 0;
  }

  public markAttachmentFailed(attachmentId: string, error: string): boolean {
    const id = requireNonEmpty(attachmentId, "attachmentId");
    const normalizedError = requireNonEmpty(error, "error");
    const now = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE bridge_task_attachments SET status = 'FAILED', error = ?, updated_at = ?
         WHERE attachment_id = ?`,
      )
      .run(normalizedError, now, id);
    if (result.changes > 0) {
      const row = this.db
        .prepare("SELECT bridge_task_id FROM bridge_task_attachments WHERE attachment_id = ?")
        .get(id) as { bridge_task_id?: string } | undefined;
      if (row?.bridge_task_id) {
        this.noteChange({ kind: "bridge_task", taskGuid: row.bridge_task_id, at: now });
      }
    }
    return result.changes > 0;
  }

  public finishBridgeTask(
    bridgeTaskId: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    finalResponse?: string,
    error?: string,
    workerId?: string,
  ): StoredBridgeTask | null {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (!task) return null;
      if (
        task.status === "SUCCEEDED"
        || task.status === "FAILED"
        || task.status === "CANCELLED"
        || (workerId && task.lease_owner !== workerId)
      ) return task;
      const now = this.timestamp();
      const cancelled = task.status === "CANCEL_REQUESTED";
      const hasPendingFollowup = !cancelled
        && status === "SUCCEEDED"
        && this.hasPendingBridgeTaskFollowups(taskId);
      const finalStatus = cancelled ? "CANCELLED" : hasPendingFollowup ? "QUEUED" : status;
      const response = cancelled || hasPendingFollowup ? null : finalResponse?.trim() || null;
      const failure = cancelled
        ? task.cancel_reason ?? error?.trim() ?? "用户已取消任务。"
        : hasPendingFollowup ? null : error?.trim() || null;
      this.db
        .prepare(
          `UPDATE bridge_tasks SET status = ?, final_response = ?, error = ?,
             lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?,
             updated_at = ? WHERE bridge_task_id = ?`,
        )
        .run(finalStatus, response, failure, finalStatus === "QUEUED" ? now : null, now, taskId);
      if (hasPendingFollowup) {
        this.db
          .prepare(
            `INSERT INTO bridge_task_events
              (bridge_task_id, event_type, payload_json, created_at)
             VALUES (?, 'turn.completed', ?, ?)`,
          )
          .run(taskId, encodeJson({ status: "SUCCEEDED", followupPending: true }), now);
      }
      if (task.card_state === "DELIVERY_FAILED" && finalStatus !== "QUEUED") {
        const text = finalStatus === "SUCCEEDED"
          ? response ?? "Codex 已完成，但没有返回文本。"
          : finalStatus === "CANCELLED"
            ? `任务已取消：${failure ?? "用户请求取消。"}`
            : `Codex 执行失败：${failure ?? "未知错误"}`;
        this.enqueueOutboxInTransaction(
          taskId,
          "feishu.send_text",
          { chatId: task.chat_id, text, replyTo: task.message_id },
          now,
        );
      }
      this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      return this.getBridgeTask(taskId);
    });
  }

  /** Finish one Codex turn while keeping the parent task as the single task. */
  public finishBridgeTaskTurn(
    bridgeTaskId: string,
    followupId: string | undefined,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    finalResponse?: string,
    error?: string,
    workerId?: string,
  ): StoredBridgeTask | null {
    if (!followupId) {
      return this.finishBridgeTask(bridgeTaskId, status, finalResponse, error, workerId);
    }
    const followup = this.finishBridgeTaskFollowup(followupId, status, finalResponse, error);
    if (!followup) return this.getBridgeTask(bridgeTaskId);
    return this.finishBridgeTask(bridgeTaskId, status, finalResponse, error, workerId);
  }

  /** Requeue a terminal direct task after an explicit operator retry request. */
  public retryBridgeTask(
    bridgeTaskId: string,
    reason = "管理员请求重试任务。",
  ): StoredBridgeTask | null {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const normalizedReason = requireNonEmpty(reason, "reason");
    return this.transaction(() => {
      const task = this.getBridgeTask(taskId);
      if (!task || (task.status !== "FAILED" && task.status !== "CANCELLED")) return task;
      const now = this.timestamp();
      const cardState = task.card_message_id ? "STREAMING" : "PENDING";
      this.db
        .prepare(
          `UPDATE bridge_tasks SET status = 'QUEUED', next_attempt_at = ?,
             lease_owner = NULL, lease_expires_at = NULL,
             last_progress_event = 'retry.requested', last_progress_text = ?,
             last_progress_at = ?, card_state = ?, card_content = NULL,
             card_updated_at = ?, cancel_requested_at = NULL, cancel_reason = NULL,
             final_response = NULL, error = NULL, updated_at = ?
           WHERE bridge_task_id = ? AND status IN ('FAILED', 'CANCELLED')`,
        )
        .run(now, normalizedReason, now, cardState, now, now, taskId);
      // A previous card delivery failure may have queued a final text
      // fallback. Retrying the task should make the new card authoritative,
      // otherwise the stale failure text could be delivered after the retry.
      this.db
        .prepare(
          `UPDATE outbox SET completed_at = ?
           WHERE task_guid = ? AND operation = 'feishu.send_text' AND completed_at IS NULL`,
        )
        .run(now, taskId);
      this.db
        .prepare(
          `INSERT INTO bridge_task_events
            (bridge_task_id, event_type, payload_json, created_at)
           VALUES (?, 'retry.requested', ?, ?)`,
        )
        .run(taskId, encodeJson({ reason: normalizedReason }), now);
      const retried = this.getBridgeTask(taskId)!;
      this.ensureBridgeCardOutboxInTransaction(retried, now);
      this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
      return retried;
    });
  }

  /** Recover work left by a previous direct runtime before taking new work. */
  public recoverExpiredBridgeTasks(force = false): BridgeRecoveryReport {
    return this.transaction(() => {
      const now = this.timestamp();
      const condition = force
        ? "status IN ('RUNNING', 'CANCEL_REQUESTED')"
        : "status IN ('RUNNING', 'CANCEL_REQUESTED') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?";
      const rows = (force
        ? this.db.prepare(`SELECT * FROM bridge_tasks WHERE ${condition}`).all()
        : this.db.prepare(`SELECT * FROM bridge_tasks WHERE ${condition}`).all(now)) as Record<string, unknown>[];
      let requeued = 0;
      let cancelled = 0;
      for (const row of rows) {
        const task = mapBridgeTask(row);
        const isCancellation = task.status === "CANCEL_REQUESTED";
        const nextStatus = isCancellation ? "CANCELLED" : "QUEUED";
        const recoveryText = isCancellation
          ? "上次进程中断，取消请求已完成。"
          : "上次进程中断，任务已重新排队，将复用已保存的 Codex 会话。";
        this.db
          .prepare(
            `UPDATE bridge_tasks SET status = ?, next_attempt_at = ?,
               lease_owner = NULL, lease_expires_at = NULL,
               recovery_count = recovery_count + 1, last_recovered_at = ?,
               last_progress_event = 'runtime.recovered', last_progress_text = ?,
               last_progress_at = ?, updated_at = ?
             WHERE bridge_task_id = ? AND status = ?`,
          )
          .run(
            nextStatus,
            isCancellation ? null : now,
            now,
            recoveryText,
            now,
            now,
            task.bridge_task_id,
            task.status,
          );
        this.db
          .prepare(
            `UPDATE bridge_task_followups SET status = ?, updated_at = ?
             WHERE bridge_task_id = ? AND status = 'RUNNING'`,
          )
          .run(isCancellation ? "CANCELLED" : "QUEUED", now, task.bridge_task_id);
        this.db
          .prepare(
            `INSERT INTO bridge_task_events
              (bridge_task_id, event_type, payload_json, created_at)
             VALUES (?, 'runtime.recovered', ?, ?)`,
          )
          .run(task.bridge_task_id, encodeJson({ from: task.status, force }), now);
        if (task.card_state !== "COMPLETED") {
          this.ensureBridgeCardOutboxInTransaction(task, now);
        }
        if (isCancellation) cancelled += 1;
        else requeued += 1;
        this.noteChange({ kind: "bridge_task", taskGuid: task.bridge_task_id, at: now });
      }
      return { requeued, cancelled };
    });
  }

  /** Backfill the card outbox for queued/running tasks created by an older direct build. */
  public ensureDirectCardOutboxes(): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM bridge_tasks
           WHERE card_state IN ('PENDING', 'STREAMING')`,
        )
        .all() as Record<string, unknown>[];
      let created = 0;
      const now = this.timestamp();
      for (const row of rows) {
        const before = this.db
          .prepare(
            `SELECT 1 FROM outbox
             WHERE task_guid = ? AND operation = 'feishu.stream_card' AND completed_at IS NULL
             LIMIT 1`,
          )
          .get(String(row.bridge_task_id));
        if (before) continue;
        this.ensureBridgeCardOutboxInTransaction(mapBridgeTask(row), now);
        created += 1;
      }
      return created;
    });
  }

  public acquireRuntimeLease(leaseName: string, owner: string, leaseMs: number): boolean {
    const name = requireNonEmpty(leaseName, "leaseName");
    const leaseOwner = requireNonEmpty(owner, "owner");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
    return this.transaction(() => {
      const now = this.timestamp();
      const expires = new Date(this.now().getTime() + leaseMs).toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO bridge_runtime_leases
            (lease_name, owner, lease_expires_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(lease_name) DO UPDATE SET owner = excluded.owner,
             lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
           WHERE bridge_runtime_leases.owner = excluded.owner
              OR bridge_runtime_leases.lease_expires_at <= excluded.updated_at`,
        )
        .run(name, leaseOwner, expires, now);
      return result.changes > 0;
    });
  }

  public renewRuntimeLease(leaseName: string, owner: string, leaseMs: number): boolean {
    const name = requireNonEmpty(leaseName, "leaseName");
    const leaseOwner = requireNonEmpty(owner, "owner");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
    const now = this.timestamp();
    const expires = new Date(this.now().getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE bridge_runtime_leases SET lease_expires_at = ?, updated_at = ?
         WHERE lease_name = ? AND owner = ?`,
      )
      .run(expires, now, name, leaseOwner);
    return result.changes > 0;
  }

  public releaseRuntimeLease(leaseName: string, owner: string): boolean {
    const name = requireNonEmpty(leaseName, "leaseName");
    const leaseOwner = requireNonEmpty(owner, "owner");
    const result = this.db
      .prepare("DELETE FROM bridge_runtime_leases WHERE lease_name = ? AND owner = ?")
      .run(name, leaseOwner);
    return result.changes > 0;
  }

  public getRuntimeLease(leaseName: string): RuntimeLeaseRecord | null {
    const name = requireNonEmpty(leaseName, "leaseName");
    const row = this.db
      .prepare("SELECT * FROM bridge_runtime_leases WHERE lease_name = ?")
      .get(name) as RuntimeLeaseRecord | undefined;
    return row ?? null;
  }

  public listAampTasks(query: AampTaskQuery = {}): { items: StoredAampTask[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.statuses && query.statuses.length > 0) {
      clauses.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      params.push(...query.statuses);
    }
    if (query.chatId) {
      clauses.push("chat_id = ?");
      params.push(query.chatId);
    }
    if (query.search) {
      const pattern = `%${query.search}%`;
      clauses.push(
        "(aamp_task_id LIKE ? OR chat_id LIKE ? OR COALESCE(user_text, '') LIKE ? OR COALESCE(error_msg, '') LIKE ?)",
      );
      params.push(pattern, pattern, pattern, pattern);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM aamp_tasks${where}`)
      .get(...params) as { total: number };
    const rows = this.db
      .prepare(`SELECT * FROM aamp_tasks${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(mapAampTask), total: countRow.total };
  }

  public listRunningAampTasks(): StoredAampTask[] {
    return this.listAampTasks({ statuses: ["running"], limit: 200 }).items;
  }

  /**
   * Persist the AAMP dispatch before the transport/agent is invoked.
   * Replayed dispatches reuse the same task id and never create a second row.
   */
  public initializeAampTask(args: AampTaskInit): StoredAampTask {
    const taskId = requireNonEmpty(args.aampTaskId, "aampTaskId");
    const chatId = requireNonEmpty(args.chatId, "chatId");
    return this.transaction(() => {
      const existing = this.getAampTask(taskId);
      const now = this.timestamp();
      if (existing) {
        this.db
          .prepare(
            `UPDATE aamp_tasks SET chat_id = ?, user_text = COALESCE(?, user_text),
               image_local_paths = CASE WHEN ? = '[]' THEN image_local_paths ELSE ? END,
               card_id = COALESCE(?, card_id), card_message_id = COALESCE(?, card_message_id),
               session_snapshot = COALESCE(?, session_snapshot), updated_at = ?
             WHERE aamp_task_id = ?`,
          )
          .run(
            chatId,
            args.userText ?? null,
            encodeJson(args.imageLocalPaths ?? []),
            encodeJson(args.imageLocalPaths ?? []),
            args.cardId ?? null,
            args.cardMessageId ?? null,
            encodeOptionalJson(args.sessionSnapshot),
            now,
            taskId,
          );
        this.noteAampTaskChange(taskId, now);
        return this.getAampTask(taskId)!;
      }

      this.db
        .prepare(
          `INSERT INTO aamp_tasks
            (aamp_task_id, chat_id, user_text, image_local_paths, card_id, card_message_id,
             status, created_at, updated_at, error_msg, last_delta_text, approval_state,
             session_snapshot, relay_status_json, last_event_type, last_event_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          chatId,
          args.userText ?? null,
          encodeJson(args.imageLocalPaths ?? []),
          args.cardId ?? null,
          args.cardMessageId ?? null,
          args.status ?? "pending",
          now,
          now,
          args.errorMsg ?? null,
          args.lastDeltaText ?? "",
          args.approvalState ?? null,
          encodeOptionalJson(args.sessionSnapshot),
          encodeOptionalJson(args.relayStatus),
          args.eventType ?? "task.dispatch",
          encodeOptionalJson(args.event),
        );
      this.noteAampTaskChange(taskId, now);
      return this.getAampTask(taskId)!;
    });
  }

  public updateAampTask(aampTaskId: string, patch: AampTaskPatch): StoredAampTask | null {
    return this.transaction(() => {
      const existing = this.getAampTask(aampTaskId);
      if (!existing) return null;
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE aamp_tasks SET chat_id = ?, user_text = ?, image_local_paths = ?,
             card_id = ?, card_message_id = ?, status = ?, updated_at = ?, error_msg = ?,
             last_delta_text = ?, approval_state = ?, session_snapshot = ?,
             relay_status_json = ?, last_event_type = ?, last_event_json = ?
           WHERE aamp_task_id = ?`,
        )
        .run(
          patch.chatId ?? existing.chat_id,
          patch.userText === undefined ? existing.user_text : patch.userText,
          patch.imageLocalPaths === undefined
            ? encodeJson(existing.image_local_paths)
            : encodeJson(patch.imageLocalPaths),
          patch.cardId === undefined ? existing.card_id : patch.cardId,
          patch.cardMessageId === undefined ? existing.card_message_id : patch.cardMessageId,
          patch.status ?? existing.status,
          now,
          patch.errorMsg === undefined ? existing.error_msg : patch.errorMsg,
          patch.lastDeltaText ?? existing.last_delta_text,
          patch.approvalState === undefined ? existing.approval_state : patch.approvalState,
          patch.sessionSnapshot === undefined
            ? existing.session_snapshot
            : encodeOptionalJson(patch.sessionSnapshot),
          patch.relayStatus === undefined
            ? existing.relay_status_json
            : encodeOptionalJson(patch.relayStatus),
          patch.eventType === undefined ? existing.last_event_type : patch.eventType,
          patch.event === undefined ? existing.last_event_json : encodeOptionalJson(patch.event),
          aampTaskId,
        );
      this.noteAampTaskChange(aampTaskId, now);
      return this.getAampTask(aampTaskId);
    });
  }

  public listTrackedTasks(): StoredTask[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapTask);
  }

  public queryTasks(query: TaskQuery = {}): { items: StoredTask[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.states && query.states.length > 0) {
      clauses.push(`state IN (${query.states.map(() => "?").join(", ")})`);
      params.push(...query.states);
    }
    if (query.projectKey) {
      clauses.push("project_key = ?");
      params.push(query.projectKey);
    }
    if (query.mode) {
      clauses.push("mode = ?");
      params.push(query.mode);
    }
    if (query.search) {
      clauses.push(
        "(task_guid LIKE ? OR input_text LIKE ? OR COALESCE(thread_id, '') LIKE ? OR COALESCE(last_error, '') LIKE ?)",
      );
      const pattern = `%${query.search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM tasks${where}`)
      .get(...params) as { total: number };
    const rows = this.db
      .prepare(`SELECT * FROM tasks${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(mapTask), total: countRow.total };
  }

  public getRun(runId: string): StoredRun | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  public getLatestRun(taskGuid: string): StoredRun | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE task_guid = ? ORDER BY started_at DESC LIMIT 1")
      .get(taskGuid) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  public listRunsForTask(taskGuid: string): StoredRun[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE task_guid = ? ORDER BY started_at DESC")
      .all(taskGuid) as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  public listRunEvents(runId: string, limit = 500): StoredRunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC LIMIT ?")
      .all(runId, Math.min(1000, Math.max(1, limit))) as Record<string, unknown>[];
    return rows.map(mapRunEvent);
  }

  public getRunEvent(eventId: number): StoredRunEvent | null {
    const row = this.db
      .prepare("SELECT * FROM run_events WHERE id = ?")
      .get(eventId) as Record<string, unknown> | undefined;
    return row ? mapRunEvent(row) : null;
  }

  public listOutboxForTask(taskGuid: string): OutboxEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE task_guid = ? ORDER BY id DESC")
      .all(taskGuid) as Record<string, unknown>[];
    return rows.map(mapOutbox);
  }

  public recordRunProgress(runId: string, progress: WorkerProgress): boolean {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!run || (run.state !== "QUEUED" && run.state !== "RUNNING")) {
        return false;
      }
      const task = this.getTask(run.task_guid);
      if (!task) return false;
      const at = progress.at || this.timestamp();
      const usageJson = progress.usage === undefined ? null : JSON.stringify(progress.usage);
      const insertResult = this.db
        .prepare(
          `INSERT INTO run_events
            (run_id, task_guid, event_type, item_type, item_id, message, usage_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          run.task_guid,
          progress.eventType,
          progress.itemType ?? null,
          progress.itemId ?? null,
          progress.message,
          usageJson,
          at,
        );
      this.db
        .prepare(
          `UPDATE runs SET progress_event = ?, progress_text = ?, progress_updated_at = ?
           WHERE run_id = ?`,
        )
        .run(progress.eventType, progress.message, at, runId);
      this.db
        .prepare(
          `UPDATE tasks SET progress_event = ?, progress_text = ?, progress_updated_at = ?, updated_at = ?
           WHERE task_guid = ? AND active_run_id = ?`,
        )
        .run(progress.eventType, progress.message, at, this.timestamp(), run.task_guid, runId);
      this.noteChange({
        kind: "run_event",
        taskGuid: run.task_guid,
        runId,
        eventId: Number(insertResult.lastInsertRowid),
        at,
      });
      return true;
    });
  }

  public claimRun(args: ClaimRunArgs): RunClaim | null {
    return this.transaction(() => {
      const existing = this.getTask(args.task.taskGuid);
      if (existing && (existing.state === "RUNNING" || existing.state === "QUEUED")) {
        return null;
      }

      const now = this.timestamp();
      const runId = makeRunId(now);
      const previousInputText = existing?.input_text ?? null;
      const resumedThreadId = existing?.thread_id ?? null;

      if (existing) {
        this.db
          .prepare(
            `UPDATE tasks SET
              project_key = ?, mode = ?, repo = ?, state = 'QUEUED',
              input_text = ?, input_hash = ?, active_run_id = ?,
              completed_at = NULL, last_error = NULL, worker_pid = NULL, service_instance_id = NULL,
              progress_event = NULL, progress_text = NULL, progress_updated_at = NULL,
              updated_at = ?
             WHERE task_guid = ?`,
          )
          .run(
            args.task.projectKey,
            args.task.mode,
            args.task.repo,
            args.inputText,
            args.task.inputHash,
            runId,
            now,
            args.task.taskGuid,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO tasks (
              task_guid, project_key, mode, repo, state, input_text, input_hash,
              thread_id, active_run_id, completed_at, last_error, created_at, updated_at,
              worker_pid, service_instance_id
            ) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, NULL, ?, NULL, NULL, ?, ?, NULL, NULL)`,
          )
          .run(
            args.task.taskGuid,
            args.task.projectKey,
            args.task.mode,
            args.task.repo,
            args.inputText,
            args.task.inputHash,
            runId,
            now,
            now,
          );
      }

      this.db
        .prepare(
          `INSERT INTO runs (
            run_id, task_guid, input_hash, input_text, previous_input_text, prompt_text,
            thread_id, state, final_response, usage_json, started_at, finished_at,
            worker_pid, service_instance_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, NULL, ?, NULL, NULL, NULL)`,
        )
        .run(
          runId,
          args.task.taskGuid,
          args.task.inputHash,
          args.inputText,
          previousInputText,
          args.promptText,
          resumedThreadId,
          now,
        );

      this.enqueueOutboxInTransaction(
        args.task.taskGuid,
        "comment",
        {
          content: typeof args.startedComment === "function"
            ? args.startedComment(runId)
            : args.startedComment,
        },
        now,
      );

      this.noteChange({
        kind: "task",
        taskGuid: args.task.taskGuid,
        runId,
        at: now,
      });

      return {
        runId,
        taskGuid: args.task.taskGuid,
        resumedThreadId,
      };
    });
  }

  /** Update an unstarted queued run instead of creating a duplicate run. */
  public updateQueuedRun(args: ClaimRunArgs): boolean {
    return this.transaction(() => {
      const task = this.getTask(args.task.taskGuid);
      if (!task || task.state !== "QUEUED" || !task.active_run_id) {
        return false;
      }
      const run = this.getRun(task.active_run_id);
      if (!run || run.state !== "QUEUED") {
        return false;
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE tasks SET project_key = ?, mode = ?, repo = ?, input_text = ?,
             input_hash = ?, last_error = NULL, updated_at = ? WHERE task_guid = ?`,
        )
        .run(
          args.task.projectKey,
          args.task.mode,
          args.task.repo,
          args.inputText,
          args.task.inputHash,
          now,
          args.task.taskGuid,
        );
      this.db
        .prepare(
          `UPDATE runs SET input_hash = ?, input_text = ?, previous_input_text = ?,
             prompt_text = ? WHERE run_id = ?`,
        )
        .run(
          args.task.inputHash,
          args.inputText,
          task.input_text,
          args.promptText,
          task.active_run_id,
        );
      this.noteChange({
        kind: "task",
        taskGuid: args.task.taskGuid,
        runId: task.active_run_id,
        at: now,
      });
      return true;
    });
  }

  public recordBlockedConfig(args: BlockedConfigArgs): boolean {
    return this.transaction(() => {
      const existing = this.getTask(args.taskGuid);
      const now = this.timestamp();
      const changed =
        !existing ||
        existing.state !== "BLOCKED_CONFIG" ||
        existing.last_error !== args.message;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO tasks (
              task_guid, project_key, mode, repo, state, input_text, input_hash,
              thread_id, active_run_id, completed_at, last_error, created_at, updated_at,
              worker_pid, service_instance_id
            ) VALUES (?, ?, ?, ?, 'BLOCKED_CONFIG', ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            args.taskGuid,
            args.projectKey ?? "__unconfigured__",
            args.mode ?? "__unconfigured__",
            args.repo ?? "",
            args.inputText,
            args.inputHash,
            args.message,
            now,
            now,
          );
      } else {
        const projectKey = args.preserveProject
          ? existing.project_key
          : args.projectKey ?? existing.project_key;
        const mode = args.preserveProject
          ? existing.mode
          : args.mode ?? existing.mode;
        const repo = args.preserveProject
          ? existing.repo
          : args.repo ?? existing.repo;
        const inputText = args.preserveProject ? existing.input_text : args.inputText;
        const inputHash = args.preserveProject ? existing.input_hash : args.inputHash;
        this.db
          .prepare(
            `UPDATE tasks SET project_key = ?, mode = ?, repo = ?, state = 'BLOCKED_CONFIG',
              input_text = ?, input_hash = ?, active_run_id = NULL, last_error = ?,
              worker_pid = NULL, service_instance_id = NULL, updated_at = ?
             WHERE task_guid = ?`,
          )
          .run(
            projectKey,
            mode,
            repo,
            inputText,
            inputHash,
            args.message,
            now,
            args.taskGuid,
          );
      }

      if (changed) {
        this.enqueueOutboxInTransaction(
          args.taskGuid,
          "comment",
          { content: args.comment },
          now,
        );
        this.noteChange({
          kind: "task",
          taskGuid: args.taskGuid,
          at: now,
        });
      }
      return changed;
    });
  }

  public markRunRunning(
    runId: string,
    workerPid: number,
    serviceInstanceId: string,
  ): boolean {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!run || run.state !== "QUEUED") {
        return false;
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE runs SET state = 'RUNNING', worker_pid = ?, service_instance_id = ?,
             progress_event = 'worker.started', progress_text = ?, progress_updated_at = ?
           WHERE run_id = ? AND state = 'QUEUED'`,
        )
        .run(workerPid, serviceInstanceId, "Worker 已启动，等待 Codex 事件。", now, runId);
      this.db
        .prepare(
          `UPDATE tasks SET state = 'RUNNING', worker_pid = ?, service_instance_id = ?,
             progress_event = 'worker.started', progress_text = ?, progress_updated_at = ?,
             updated_at = ? WHERE task_guid = ? AND active_run_id = ?`,
        )
        .run(
          workerPid,
          serviceInstanceId,
          "Worker 已启动，等待 Codex 事件。",
          now,
          now,
          run.task_guid,
          runId,
        );
      const insertResult = this.db
        .prepare(
          `INSERT INTO run_events
            (run_id, task_guid, event_type, item_type, item_id, message, usage_json, created_at)
           VALUES (?, ?, 'worker.started', NULL, NULL, ?, NULL, ?)`,
        )
        .run(runId, run.task_guid, "Worker 已启动，等待 Codex 事件。", now);
      this.noteChange({
        kind: "run_event",
        taskGuid: run.task_guid,
        runId,
        eventId: Number(insertResult.lastInsertRowid),
        at: now,
      });
      return true;
    });
  }

  public saveThreadId(runId: string, threadId: string): void {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) {
        return;
      }
      const now = this.timestamp();
      this.db.prepare("UPDATE runs SET thread_id = ? WHERE run_id = ?").run(threadId, runId);
      this.db
        .prepare(
          `UPDATE tasks SET thread_id = ?, updated_at = ?
           WHERE task_guid = ? AND (active_run_id = ? OR (active_run_id IS NULL AND thread_id IS NULL))`,
        )
        .run(threadId, now, run.task_guid, runId);
      this.noteChange({
        kind: "task",
        taskGuid: run.task_guid,
        runId,
        at: now,
      });
    });
  }

  public finishRun(runId: string, args: FinishRunArgs): StoredRun | null {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) {
        return null;
      }
      if (run.state === "CANCELED" && args.status !== "canceled") {
        return run;
      }

      const taskState: TaskState =
        args.status === "succeeded"
          ? "WAITING_REVIEW"
          : args.status === "canceled"
            ? "CANCELED"
            : "FAILED";
      const runState = taskState;
      const finishedAt = this.timestamp();
      const usageJson = args.usage === undefined ? null : JSON.stringify(args.usage);
      this.db
        .prepare(
          `UPDATE runs SET state = ?, final_response = ?, usage_json = ?, finished_at = ?,
             worker_pid = NULL, service_instance_id = NULL WHERE run_id = ?`,
        )
        .run(
          runState,
          args.finalResponse ?? null,
          usageJson,
          finishedAt,
          runId,
        );
      this.db
        .prepare(
          `UPDATE tasks SET state = ?, active_run_id = NULL, last_error = ?,
             worker_pid = NULL, service_instance_id = NULL, updated_at = ?
           WHERE task_guid = ? AND active_run_id = ?`,
        )
        .run(
          taskState,
          args.error ?? null,
          finishedAt,
          run.task_guid,
          runId,
        );
      if (args.comment) {
        this.enqueueOutboxInTransaction(
          run.task_guid,
          "comment",
          { content: args.comment },
          finishedAt,
        );
      }
      this.noteChange({
        kind: "task",
        taskGuid: run.task_guid,
        runId,
        at: finishedAt,
      });
      return this.getRun(runId);
    });
  }

  public enqueueComment(taskGuid: string, content: string): void {
    this.enqueueOutboxInTransaction(
      taskGuid,
      "comment",
      { content },
      this.timestamp(),
    );
  }

  public acceptTask(taskGuid: string): boolean {
    const now = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE tasks SET state = 'ACCEPTED', completed_at = ?,
           active_run_id = NULL, worker_pid = NULL, service_instance_id = NULL,
           updated_at = ? WHERE task_guid = ?`,
      )
      .run(now, now, taskGuid);
    if (result.changes > 0) this.noteChange({ kind: "task", taskGuid, at: now });
    return result.changes > 0;
  }

  public cancelTask(taskGuid: string, reason?: string): string | null {
    return this.transaction(() => {
      const task = this.getTask(taskGuid);
      if (!task) {
        return null;
      }
      const now = this.timestamp();
      if (task.active_run_id) {
        this.db
          .prepare(
            `UPDATE runs SET state = 'CANCELED', finished_at = ?, final_response = ?,
               worker_pid = NULL, service_instance_id = NULL
             WHERE run_id = ? AND state IN ('QUEUED', 'RUNNING')`,
          )
          .run(now, reason ?? null, task.active_run_id);
      }
      this.db
        .prepare(
          `UPDATE tasks SET state = 'CANCELED', active_run_id = NULL, last_error = ?,
             worker_pid = NULL, service_instance_id = NULL, updated_at = ?
           WHERE task_guid = ?`,
        )
        .run(reason ?? null, now, taskGuid);
      this.noteChange({
        kind: "task",
        taskGuid,
        runId: task.active_run_id ?? undefined,
        at: now,
      });
      return task.active_run_id;
    });
  }

  public recoverInterruptedRuns(
    error = "桥接服务上次退出时 Codex worker 未完成，本轮未自动重跑。",
    commentForTask: (taskGuid: string, error: string) => string = (_, message) =>
      `[Codex] 服务中断，运行已标记失败\n\n${message}`,
  ): RecoveredRun[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT run_id, task_guid FROM runs WHERE state = 'RUNNING'")
        .all() as Array<{ run_id: string; task_guid: string }>;
      const recovered: RecoveredRun[] = [];
      for (const row of rows) {
        const now = this.timestamp();
        this.db
          .prepare(
            `UPDATE runs SET state = 'FAILED', final_response = NULL, usage_json = NULL,
               finished_at = ?, worker_pid = NULL, service_instance_id = NULL
             WHERE run_id = ? AND state = 'RUNNING'`,
          )
          .run(now, row.run_id);
        this.db
          .prepare(
            `UPDATE tasks SET state = 'FAILED', active_run_id = NULL, last_error = ?,
               worker_pid = NULL, service_instance_id = NULL, updated_at = ?
             WHERE task_guid = ? AND active_run_id = ?`,
          )
          .run(error, now, row.task_guid, row.run_id);
        const comment = commentForTask(row.task_guid, error);
        this.enqueueOutboxInTransaction(
          row.task_guid,
          "comment",
          { content: comment },
          now,
        );
        this.noteChange({
          kind: "task",
          taskGuid: row.task_guid,
          runId: row.run_id,
          at: now,
        });
        recovered.push({ runId: row.run_id, taskGuid: row.task_guid, error, comment });
      }
      return recovered;
    });
  }

  public getDueOutbox(limit = 50, operations?: string[]): OutboxEntry[] {
    const now = this.timestamp();
    const operationClause = operations && operations.length > 0
      ? ` AND operation IN (${operations.map(() => "?").join(", ")})`
      : "";
    const params: Array<string | number> = [now];
    if (operations && operations.length > 0) params.push(...operations);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE completed_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ${operationClause}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapOutbox);
  }

  public listOutbox(query: {
    taskGuid?: string;
    operations?: string[];
    pendingOnly?: boolean;
    limit?: number;
  } = {}): OutboxEntry[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.taskGuid) {
      clauses.push("task_guid = ?");
      params.push(query.taskGuid);
    }
    if (query.operations && query.operations.length > 0) {
      clauses.push(`operation IN (${query.operations.map(() => "?").join(", ")})`);
      params.push(...query.operations);
    }
    if (query.pendingOnly) clauses.push("completed_at IS NULL");
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM outbox${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(mapOutbox);
  }

  public getOutboxSummary(operations?: string[]): OutboxSummary {
    const operationClause = operations && operations.length > 0
      ? ` AND operation IN (${operations.map(() => "?").join(", ")})`
      : "";
    const params = operations ?? [];
    const now = this.timestamp();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN completed_at IS NULL
                     AND (next_attempt_at IS NULL OR next_attempt_at <= ?) THEN 1 ELSE 0 END) AS due,
           SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
         FROM outbox WHERE 1 = 1${operationClause}`,
      )
      .get(now, ...params) as Record<string, unknown>;
    return {
      total: Number(row.total ?? 0),
      pending: Number(row.pending ?? 0),
      due: Number(row.due ?? 0),
      delivered: Number(row.delivered ?? 0),
    };
  }

  public enqueueDirectTextReply(
    taskGuid: string,
    chatId: string,
    text: string,
    replyTo?: string,
  ): number {
    const owner = requireNonEmpty(taskGuid, "taskGuid");
    const target = requireNonEmpty(chatId, "chatId");
    const content = requireNonEmpty(text, "text");
    return this.transaction(() => this.enqueueOutboxInTransaction(
      owner,
      "feishu.send_text",
      { chatId: target, text: content, replyTo },
      this.timestamp(),
    ));
  }

  public markOutboxDelivered(id: number): void {
    const entry = this.db
      .prepare("SELECT task_guid FROM outbox WHERE id = ?")
      .get(id) as { task_guid: string } | undefined;
    const now = this.timestamp();
    const result = this.db
      .prepare("UPDATE outbox SET completed_at = ? WHERE id = ? AND completed_at IS NULL")
      .run(now, id);
    if (result.changes > 0 && entry) this.noteChange({ kind: "outbox", taskGuid: entry.task_guid, at: now });
  }

  public markOutboxFailed(id: number): number {
    const entry = this.db
      .prepare("SELECT attempts, task_guid FROM outbox WHERE id = ? AND completed_at IS NULL")
      .get(id) as { attempts: number; task_guid: string } | undefined;
    if (!entry) {
      return 0;
    }
    const attempts = entry.attempts + 1;
    const delayMs = Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(attempts - 1, 10));
    const nextAttempt = new Date(this.now().getTime() + delayMs).toISOString();
    this.db
      .prepare("UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?")
      .run(attempts, nextAttempt, id);
    this.noteChange({ kind: "outbox", taskGuid: entry.task_guid, at: this.timestamp() });
    return attempts;
  }

  public close(): void {
    try {
      this.db.close();
    } catch (error) {
      if (!(error instanceof Error) || !/database is not open/i.test(error.message)) throw error;
    }
  }

  private enqueueOutboxInTransaction(
    taskGuid: string,
    operation: string,
    payload: unknown,
    now: string,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO outbox
          (task_guid, operation, payload_json, attempts, next_attempt_at, completed_at)
          VALUES (?, ?, ?, 0, ?, NULL)`,
      )
      .run(taskGuid, operation, JSON.stringify(payload), now);
    this.noteChange({ kind: "outbox", taskGuid, at: now });
    return Number(result.lastInsertRowid);
  }

  private ingestDirectControlOutbox(
    input: DirectMessageInput,
    operation: string,
    payload: unknown,
  ): boolean {
    const sourceEventId = requireNonEmpty(input.sourceEventId, "sourceEventId");
    const eventType = requireNonEmpty(input.eventType, "eventType");
    const messageId = requireNonEmpty(input.messageId, "messageId");
    const chatId = requireNonEmpty(input.chatId, "chatId");
    const senderId = requireNonEmpty(input.senderId, "senderId");
    requireNonEmpty(input.text, "text");
    return this.transaction(() => {
      if (this.getInboundEvent(sourceEventId) || this.getBridgeTaskByMessage(messageId)) {
        return false;
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO inbound_events
            (source_event_id, event_type, message_id, chat_id, sender_id,
             payload_json, received_at, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceEventId,
          eventType,
          messageId,
          chatId,
          senderId,
          encodeJson(input.payload ?? {}),
          now,
          now,
        );
      this.enqueueOutboxInTransaction(
        `direct:${sourceEventId}`,
        operation,
        payload,
        now,
      );
      this.noteChange({ kind: "inbound_event", taskGuid: `direct:${sourceEventId}`, at: now });
      return true;
    });
  }

  private ensureBridgeCardOutboxInTransaction(task: StoredBridgeTask, now: string): void {
    const pending = this.db
      .prepare(
        `SELECT 1 FROM outbox
         WHERE task_guid = ? AND operation = 'feishu.stream_card' AND completed_at IS NULL
         LIMIT 1`,
      )
      .get(task.bridge_task_id);
    if (pending) return;
    this.enqueueOutboxInTransaction(
      task.bridge_task_id,
      "feishu.stream_card",
      { bridgeTaskId: task.bridge_task_id, chatId: task.chat_id, replyTo: task.message_id },
      now,
    );
  }

  private updateBridgeCardState(
    bridgeTaskId: string,
    state: "COMPLETED" | "DELIVERY_FAILED",
  ): boolean {
    const taskId = requireNonEmpty(bridgeTaskId, "bridgeTaskId");
    const now = this.timestamp();
    const terminalClause = state === "COMPLETED"
      ? " AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')"
      : "";
    const result = this.db
      .prepare(
        `UPDATE bridge_tasks SET card_state = ?, card_updated_at = ?, updated_at = ?
         WHERE bridge_task_id = ?${terminalClause}`,
      )
      .run(state, now, now, taskId);
    if (result.changes > 0) this.noteChange({ kind: "bridge_task", taskGuid: taskId, at: now });
    return result.changes > 0;
  }

  private noteAampTaskChange(aampTaskId: string, at: string): void {
    this.noteChange({
      kind: "aamp_task",
      taskGuid: `aamp:${aampTaskId}`,
      aampTaskId,
      at,
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private noteChange(change: DatabaseChange): void {
    if (this.pendingChanges) {
      this.pendingChanges.push(change);
      return;
    }
    this.emitChange(change);
  }

  private flushChanges(): void {
    const changes = this.pendingChanges ?? [];
    this.pendingChanges = null;
    for (const change of changes) this.emitChange(change);
  }

  private emitChange(change: DatabaseChange): void {
    for (const listener of this.changeListeners) {
      try {
        listener(change);
      } catch {
        // Observers must not break a successful database mutation.
      }
    }
  }

  private runMigrations(): void {
    // These columns were added after the minimal schema in the design document.
    // Keeping the migration additive lets an operator upgrade an existing database.
    addColumnIfMissing(this.db, "tasks", "worker_pid", "INTEGER");
    addColumnIfMissing(this.db, "tasks", "service_instance_id", "TEXT");
    addColumnIfMissing(this.db, "tasks", "progress_event", "TEXT");
    addColumnIfMissing(this.db, "tasks", "progress_text", "TEXT");
    addColumnIfMissing(this.db, "tasks", "progress_updated_at", "TEXT");
    addColumnIfMissing(this.db, "runs", "input_text", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.db, "runs", "previous_input_text", "TEXT");
    addColumnIfMissing(this.db, "runs", "prompt_text", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.db, "runs", "worker_pid", "INTEGER");
    addColumnIfMissing(this.db, "runs", "service_instance_id", "TEXT");
    addColumnIfMissing(this.db, "runs", "progress_event", "TEXT");
    addColumnIfMissing(this.db, "runs", "progress_text", "TEXT");
    addColumnIfMissing(this.db, "runs", "progress_updated_at", "TEXT");
    // The first direct-mode schema only allowed four task states. Add the
    // progress columns before a possible table rebuild so old databases can
    // be copied without losing those fields.
    addColumnIfMissing(this.db, "bridge_tasks", "last_progress_event", "TEXT");
    addColumnIfMissing(this.db, "bridge_tasks", "last_progress_text", "TEXT");
    addColumnIfMissing(this.db, "bridge_tasks", "last_progress_at", "TEXT");
    migrateBridgeTaskStatusConstraint(this.db);
    addColumnIfMissing(this.db, "bridge_tasks", "card_message_id", "TEXT");
    addColumnIfMissing(this.db, "bridge_tasks", "card_state", "TEXT NOT NULL DEFAULT 'PENDING'");
    addColumnIfMissing(this.db, "bridge_tasks", "card_content", "TEXT");
    addColumnIfMissing(this.db, "bridge_tasks", "card_updated_at", "TEXT");
    addColumnIfMissing(this.db, "bridge_tasks", "cancel_requested_at", "TEXT");
    addColumnIfMissing(this.db, "bridge_tasks", "cancel_reason", "TEXT");
    addColumnIfMissing(this.db, "bridge_tasks", "recovery_count", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(this.db, "bridge_tasks", "last_recovered_at", "TEXT");
    addColumnIfMissing(this.db, "bridge_task_attachments", "followup_id", "TEXT");
  }
}

function makeRunId(date: string): string {
  const compact = date.replace(/[-:TZ.]/g, "").slice(0, 14);
  return `run_${compact}_${randomUUID().slice(0, 8)}`;
}

function makeBridgeTaskId(date: string): string {
  const compact = date.replace(/[-:TZ.]/g, "").slice(0, 14);
  return `bridge_${compact}_${randomUUID().slice(0, 8)}`;
}

function makeBridgeAttachmentId(): string {
  return `attachment_${randomUUID()}`;
}

function makeBridgeFollowupId(): string {
  return `followup_${randomUUID()}`;
}

function migrateBridgeTaskStatusConstraint(db: SqliteDatabase): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bridge_tasks'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("CANCEL_REQUESTED")) return;

  // SQLite cannot alter a CHECK constraint. Rebuild only this small direct
  // table and keep its child event rows; foreign keys are disabled for the
  // short, atomic schema migration and restored immediately afterwards.
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE bridge_tasks_migrating (
      bridge_task_id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL CHECK (chat_type IN ('p2p', 'group')),
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      text TEXT NOT NULL,
      session_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'CANCELLED'
      )),
      thread_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_progress_event TEXT,
      last_progress_text TEXT,
      last_progress_at TEXT,
      card_message_id TEXT,
      card_state TEXT NOT NULL DEFAULT 'PENDING',
      card_content TEXT,
      card_updated_at TEXT,
      cancel_requested_at TEXT,
      cancel_reason TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      last_recovered_at TEXT,
      final_response TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(source_event_id) REFERENCES inbound_events(source_event_id)
    );
    INSERT INTO bridge_tasks_migrating (
      bridge_task_id, source_event_id, message_id, chat_id, chat_type,
      sender_id, sender_name, text, session_key, status, thread_id, attempt,
      next_attempt_at, lease_owner, lease_expires_at, last_progress_event,
      last_progress_text, last_progress_at, final_response, error,
      created_at, updated_at
    )
    SELECT bridge_task_id, source_event_id, message_id, chat_id, chat_type,
      sender_id, sender_name, text, session_key, status, thread_id, attempt,
      next_attempt_at, lease_owner, lease_expires_at, last_progress_event,
      last_progress_text, last_progress_at, final_response, error,
      created_at, updated_at
    FROM bridge_tasks;
    DROP TABLE bridge_tasks;
    ALTER TABLE bridge_tasks_migrating RENAME TO bridge_tasks;
    CREATE INDEX IF NOT EXISTS idx_bridge_tasks_due
      ON bridge_tasks(status, next_attempt_at, lease_expires_at, created_at);
    PRAGMA foreign_keys = ON;
  `);
}

function addColumnIfMissing(
  db: SqliteDatabase,
  table: "tasks" | "runs" | "bridge_tasks" | "bridge_task_attachments",
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapTask(row: Record<string, unknown>): StoredTask {
  return {
    task_guid: String(row.task_guid),
    project_key: String(row.project_key),
    mode: String(row.mode),
    repo: String(row.repo),
    state: String(row.state) as TaskState,
    input_text: String(row.input_text ?? ""),
    input_hash: String(row.input_hash),
    thread_id: nullableString(row.thread_id),
    active_run_id: nullableString(row.active_run_id),
    completed_at: nullableString(row.completed_at),
    last_error: nullableString(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    worker_pid: nullableNumber(row.worker_pid),
    service_instance_id: nullableString(row.service_instance_id),
    progress_event: nullableString(row.progress_event),
    progress_text: nullableString(row.progress_text),
    progress_updated_at: nullableString(row.progress_updated_at),
  };
}

function mapAampTask(row: Record<string, unknown>): StoredAampTask {
  return {
    aamp_task_id: String(row.aamp_task_id),
    chat_id: String(row.chat_id),
    user_text: nullableString(row.user_text),
    image_local_paths: decodeStringArray(row.image_local_paths),
    card_id: nullableString(row.card_id),
    card_message_id: nullableString(row.card_message_id),
    status: String(row.status) as AampTaskStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    error_msg: nullableString(row.error_msg),
    last_delta_text: String(row.last_delta_text ?? ""),
    approval_state: nullableString(row.approval_state),
    session_snapshot: nullableString(row.session_snapshot),
    relay_status_json: nullableString(row.relay_status_json),
    last_event_type: nullableString(row.last_event_type),
    last_event_json: nullableString(row.last_event_json),
  };
}

function mapInboundEvent(row: Record<string, unknown>): StoredInboundEvent {
  return {
    source_event_id: String(row.source_event_id),
    event_type: String(row.event_type),
    message_id: String(row.message_id),
    chat_id: String(row.chat_id),
    sender_id: String(row.sender_id),
    payload_json: String(row.payload_json),
    received_at: String(row.received_at),
    processed_at: nullableString(row.processed_at),
  };
}

function mapBridgeTask(row: Record<string, unknown>): StoredBridgeTask {
  return {
    bridge_task_id: String(row.bridge_task_id),
    source_event_id: String(row.source_event_id),
    message_id: String(row.message_id),
    chat_id: String(row.chat_id),
    chat_type: String(row.chat_type) as StoredBridgeTask["chat_type"],
    sender_id: String(row.sender_id),
    sender_name: nullableString(row.sender_name),
    text: String(row.text),
    session_key: String(row.session_key),
    status: String(row.status) as StoredBridgeTask["status"],
    thread_id: nullableString(row.thread_id),
    attempt: Number(row.attempt),
    next_attempt_at: nullableString(row.next_attempt_at),
    lease_owner: nullableString(row.lease_owner),
    lease_expires_at: nullableString(row.lease_expires_at),
    last_progress_event: nullableString(row.last_progress_event),
    last_progress_text: nullableString(row.last_progress_text),
    last_progress_at: nullableString(row.last_progress_at),
    card_message_id: nullableString(row.card_message_id),
    card_state: String(row.card_state ?? "PENDING") as StoredBridgeTask["card_state"],
    card_content: nullableString(row.card_content),
    card_updated_at: nullableString(row.card_updated_at),
    cancel_requested_at: nullableString(row.cancel_requested_at),
    cancel_reason: nullableString(row.cancel_reason),
    recovery_count: Number(row.recovery_count ?? 0),
    last_recovered_at: nullableString(row.last_recovered_at),
    final_response: nullableString(row.final_response),
    error: nullableString(row.error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapBridgeTaskAttachment(row: Record<string, unknown>): StoredBridgeTaskAttachment {
  return {
    attachment_id: String(row.attachment_id),
    bridge_task_id: String(row.bridge_task_id),
    followup_id: nullableString(row.followup_id),
    type: String(row.type) as StoredBridgeTaskAttachment["type"],
    file_key: String(row.file_key),
    file_name: nullableString(row.file_name),
    duration_ms: nullableNumber(row.duration_ms),
    cover_image_key: nullableString(row.cover_image_key),
    local_path: nullableString(row.local_path),
    status: String(row.status) as StoredBridgeTaskAttachment["status"],
    error: nullableString(row.error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapBridgeTaskFollowup(row: Record<string, unknown>): StoredBridgeTaskFollowup {
  const status = String(row.status);
  return {
    followup_id: String(row.followup_id),
    bridge_task_id: String(row.bridge_task_id),
    source_event_id: String(row.source_event_id),
    message_id: String(row.message_id),
    sender_id: String(row.sender_id),
    sender_name: nullableString(row.sender_name),
    text: String(row.text),
    status: DIRECT_FOLLOWUP_STATUSES.includes(status as (typeof DIRECT_FOLLOWUP_STATUSES)[number])
      ? status as StoredBridgeTaskFollowup["status"]
      : "FAILED",
    attempt: Number(row.attempt ?? 0),
    final_response: nullableString(row.final_response),
    error: nullableString(row.error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapBridgeTaskEvent(row: Record<string, unknown>): StoredBridgeTaskEvent {
  return {
    id: Number(row.id),
    bridge_task_id: String(row.bridge_task_id),
    event_type: String(row.event_type),
    payload_json: String(row.payload_json),
    created_at: String(row.created_at),
  };
}

function mapRun(row: Record<string, unknown>): StoredRun {
  return {
    run_id: String(row.run_id),
    task_guid: String(row.task_guid),
    input_hash: String(row.input_hash),
    input_text: String(row.input_text ?? ""),
    previous_input_text: nullableString(row.previous_input_text),
    prompt_text: String(row.prompt_text ?? ""),
    thread_id: nullableString(row.thread_id),
    state: String(row.state) as TaskState,
    final_response: nullableString(row.final_response),
    usage_json: nullableString(row.usage_json),
    started_at: String(row.started_at),
    finished_at: nullableString(row.finished_at),
    worker_pid: nullableNumber(row.worker_pid),
    service_instance_id: nullableString(row.service_instance_id),
    progress_event: nullableString(row.progress_event),
    progress_text: nullableString(row.progress_text),
    progress_updated_at: nullableString(row.progress_updated_at),
  };
}

function mapRunEvent(row: Record<string, unknown>): StoredRunEvent {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    task_guid: String(row.task_guid),
    event_type: String(row.event_type),
    item_type: nullableString(row.item_type),
    item_id: nullableString(row.item_id),
    message: String(row.message),
    usage_json: nullableString(row.usage_json),
    created_at: String(row.created_at),
  };
}

function mapOutbox(row: Record<string, unknown>): OutboxEntry {
  return {
    id: Number(row.id),
    task_guid: String(row.task_guid),
    operation: String(row.operation),
    payload_json: String(row.payload_json),
    attempts: Number(row.attempts),
    next_attempt_at: nullableString(row.next_attempt_at),
    completed_at: nullableString(row.completed_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function encodeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (error) {
    throw new Error(`cannot serialize SQLite JSON value: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodeOptionalJson(value: unknown): string | null {
  return value === undefined || value === null ? null : encodeJson(value);
}

function decodeStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
