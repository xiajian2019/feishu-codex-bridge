import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import { DatabaseSync as DatabaseSyncConstructor, type SqliteDatabase } from "./sqlite.js";
import { DEFAULT_SHORTCUT_GROUPS, DEFAULT_SHORTCUTS } from "./tmux-shortcut-defaults.js";
import {
  WebTaskSubmissionConflictError,
  DIRECT_FOLLOWUP_STATUSES,
  DIRECT_TASK_STATUSES,
  SHORTCUT_DISPLAY_MODES,
  SHORTCUT_GROUP_LAYOUTS,
  SHORTCUT_KINDS,
  SHORTCUT_SURFACES,
  TASK_STATES,
} from "./types.js";
import type { WebAuthPairingRecord, WebAuthSessionRecord } from "./web-auth.js";
import type {
  DatabaseChange,
  DirectMessageInput,
  StoredExecutionBackend,
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
  StoredProject,
  StoredWebTaskAttachment,
  ProjectStatus,
  TaskOrigin,
  AampTaskStatus,
  DirectTaskStatus,
  StoredTask,
  TaskState,
  WorkerProgress,
  ShortcutDisplayMode,
  ShortcutGroupLayout,
  ShortcutKind,
  ShortcutSurface,
  StoredShortcut,
  StoredShortcutGroup,
  StoredTmuxSession,
  StoredTmuxSessionAction,
  TmuxSessionActionQuery,
  TmuxSessionActionStatus,
  TmuxSessionActionType,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status_name ON projects(status, name);

CREATE TABLE IF NOT EXISTS tasks (
    task_guid TEXT PRIMARY KEY,
    origin TEXT NOT NULL DEFAULT 'feishu',
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

CREATE TABLE IF NOT EXISTS web_task_attachments (
    attachment_id TEXT PRIMARY KEY,
    task_guid TEXT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    local_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_guid) REFERENCES tasks(task_guid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_task_attachments_task
  ON web_task_attachments(task_guid, created_at);

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
    execution_backend TEXT NOT NULL DEFAULT 'codex-sdk',
    tmux_session_id TEXT,
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

CREATE TABLE IF NOT EXISTS web_task_submissions (
    idempotency_key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    normalized_request_json TEXT NOT NULL,
    task_guid TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_guid) REFERENCES tasks(task_guid),
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
);

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
    initial_final_response TEXT,
    final_response TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(source_event_id) REFERENCES inbound_events(source_event_id)
);

CREATE TABLE IF NOT EXISTS codex_history_list_cache (
    home_id TEXT NOT NULL,
    filter_key TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    refreshed_at TEXT NOT NULL,
    PRIMARY KEY(home_id, filter_key)
);

CREATE INDEX IF NOT EXISTS idx_codex_history_list_cache_refreshed
  ON codex_history_list_cache(home_id, refreshed_at DESC);

CREATE TABLE IF NOT EXISTS codex_history_thread_home_preferences (
    thread_id TEXT PRIMARY KEY,
    preferred_home_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_history_thread_home_preferences_home
  ON codex_history_thread_home_preferences(preferred_home_id, updated_at DESC);

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

CREATE TABLE IF NOT EXISTS shortcut_groups (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '⌘',
    description TEXT NOT NULL DEFAULT '',
    surface TEXT NOT NULL DEFAULT 'palette' CHECK (surface IN ('palette', 'composer')),
    layout TEXT NOT NULL DEFAULT 'grid' CHECK (layout IN ('grid', 'keyboard')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shortcuts (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('terminal', 'insert', 'send', 'sequence')),
    value TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
    dangerous INTEGER NOT NULL DEFAULT 0 CHECK (dangerous IN (0, 1)),
    action_key TEXT,
    display_mode TEXT NOT NULL DEFAULT 'closed' CHECK (display_mode IN ('closed', 'expanded', 'both')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    operation_count INTEGER NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(group_id) REFERENCES shortcut_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shortcut_groups_order
  ON shortcut_groups(enabled, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_shortcuts_group_order
  ON shortcuts(group_id, enabled, operation_count DESC, title COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS web_auth_pairings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_auth_sessions (
    session_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    user_agent TEXT,
    remote_address TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_web_auth_sessions_active
  ON web_auth_sessions(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS tmux_sessions (
    record_id TEXT PRIMARY KEY,
    tmux_session_id TEXT NOT NULL,
    session_name TEXT NOT NULL,
    project_key TEXT,
    working_directory TEXT NOT NULL,
    tmux_created_at INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    created_by_device_id TEXT,
    FOREIGN KEY(created_by_device_id) REFERENCES web_auth_sessions(session_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tmux_sessions_active
  ON tmux_sessions(ended_at, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS tmux_session_actions (
    action_id TEXT PRIMARY KEY,
    session_record_id TEXT NOT NULL,
    tmux_session_id TEXT NOT NULL,
    session_name TEXT NOT NULL,
    project_key TEXT,
    working_directory TEXT NOT NULL,
    device_id TEXT,
    action_type TEXT NOT NULL CHECK (action_type IN ('task_submit', 'terminal_command', 'shortcut', 'control_sequence')),
    request_id TEXT,
    submission_fingerprint TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'confirmed', 'unconfirmed', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(session_record_id) REFERENCES tmux_sessions(record_id) ON DELETE CASCADE,
    FOREIGN KEY(device_id) REFERENCES web_auth_sessions(session_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tmux_session_actions_session
  ON tmux_session_actions(session_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmux_session_actions_created
  ON tmux_session_actions(created_at DESC);
`;

export interface ClaimRunArgs {
  task: RoutedTask;
  inputText: string;
  promptText: string;
  startedComment?: string | ((runId: string) => string);
  attachmentIds?: string[];
}

export interface ClaimWebTaskSubmissionArgs extends ClaimRunArgs {
  idempotencyKey: string;
  normalizedRequestJson: string;
}

export interface StoredWebTaskSubmission {
  idempotency_key: string;
  request_hash: string;
  normalized_request_json: string;
  task_guid: string;
  run_id: string;
  created_at: string;
}

export type ClaimWebTaskSubmissionResult =
  | { status: "created"; claim: RunClaim }
  | { status: "existing"; submission: StoredWebTaskSubmission };

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

export interface TaskPanelQuery {
  source?: "all" | "desk" | "direct";
  states?: string[];
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
    this.seedShortcutDefaults();
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

  public listProjects(): StoredProject[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapProject);
  }

  public listAvailableProjects(): StoredProject[] {
    return this.listProjects().filter((project) =>
      project.status === "available" && isProjectDirectory(project.path)
    );
  }

  public getAvailableProject(name: string): StoredProject | null {
    const project = this.getProject(name);
    return project?.status === "available" && isProjectDirectory(project.path) ? project : null;
  }

  public getProject(name: string): StoredProject | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return row ? mapProject(row) : null;
  }

  public createProject(input: { name: string; path: string; status?: ProjectStatus }): StoredProject {
    const name = input.name.trim();
    const path = input.path.trim();
    if (!name || name.length > 120) throw new Error("项目名称不能为空且不能超过 120 个字符。");
    if (!isAbsolute(path)) throw new Error("项目路径必须是绝对路径。");
    const now = this.timestamp();
    this.db.prepare(
      "INSERT INTO projects (name, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(name, resolve(path), input.status ?? "available", now, now);
    return this.getProject(name)!;
  }

  public updateProject(
    name: string,
    input: { path?: string; status?: ProjectStatus },
  ): StoredProject | null {
    const existing = this.getProject(name);
    if (!existing) return null;
    const path = input.path?.trim();
    if (path !== undefined && !isAbsolute(path)) throw new Error("项目路径必须是绝对路径。");
    this.db.prepare(
      "UPDATE projects SET path = ?, status = ?, updated_at = ? WHERE name = ?",
    ).run(path === undefined ? existing.path : resolve(path), input.status ?? existing.status, this.timestamp(), name);
    return this.getProject(name);
  }

  public ensureProject(input: { name: string; path: string; status?: ProjectStatus }): StoredProject {
    const name = input.name.trim();
    const path = input.path.trim();
    if (!name || name.length > 120) throw new Error("项目名称不能为空且不能超过 120 个字符。");
    if (!isAbsolute(path)) throw new Error("项目路径必须是绝对路径。");
    const now = this.timestamp();
    this.db.prepare(
      "INSERT OR IGNORE INTO projects (name, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(name, resolve(path), input.status ?? "available", now, now);
    return this.getProject(name)!;
  }

  public getShortcutConfig(): { groups: StoredShortcutGroup[]; shortcuts: StoredShortcut[] } {
    return { groups: this.listShortcutGroups(), shortcuts: this.listShortcuts() };
  }

  public listShortcutGroups(includeDisabled = true): StoredShortcutGroup[] {
    const rows = this.db.prepare(
      `SELECT * FROM shortcut_groups${includeDisabled ? "" : " WHERE enabled = 1"}
       ORDER BY sort_order ASC, id COLLATE NOCASE ASC`,
    ).all() as Record<string, unknown>[];
    return rows.map(mapShortcutGroup);
  }

  public listShortcuts(groupId?: string, includeDisabled = true): StoredShortcut[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (groupId) {
      conditions.push("group_id = ?");
      params.push(groupId);
    }
    if (!includeDisabled) conditions.push("enabled = 1");
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM shortcuts${where}
       ORDER BY group_id COLLATE NOCASE ASC, sort_order ASC, title COLLATE NOCASE ASC, id ASC`,
    ).all(...params) as Record<string, unknown>[];
    return rows.map(mapShortcut);
  }

  public getShortcut(id: string): StoredShortcut | null {
    const row = this.db.prepare("SELECT * FROM shortcuts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapShortcut(row) : null;
  }

  public createShortcutGroup(input: {
    id?: string;
    title: string;
    icon?: string;
    description?: string;
    surface?: ShortcutSurface;
    layout?: ShortcutGroupLayout;
    sortOrder?: number;
    enabled?: boolean;
    builtIn?: boolean;
  }): StoredShortcutGroup {
    const id = input.id?.trim() || `group-${randomUUID()}`;
    const title = normalizeShortcutText(input.title, "分组名称", 64);
    const icon = normalizeShortcutText(input.icon ?? "⌘", "分组图标", 8);
    const description = normalizeShortcutText(input.description ?? "", "分组说明", 160, false);
    const surface = normalizeShortcutSurface(input.surface ?? "palette");
    const layout = normalizeShortcutLayout(input.layout ?? "grid");
    const sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder! : this.nextShortcutGroupOrder();
    const now = this.timestamp();
    this.db.prepare(
      `INSERT INTO shortcut_groups
        (id, title, icon, description, surface, layout, sort_order, enabled, built_in, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, icon, description, surface, layout, sortOrder, input.enabled === false ? 0 : 1, input.builtIn ? 1 : 0, now, now);
    return this.getShortcutGroup(id)!;
  }

  public getShortcutGroup(id: string): StoredShortcutGroup | null {
    const row = this.db.prepare("SELECT * FROM shortcut_groups WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapShortcutGroup(row) : null;
  }

  public updateShortcutGroup(id: string, input: {
    title?: string;
    icon?: string;
    description?: string;
    surface?: ShortcutSurface;
    layout?: ShortcutGroupLayout;
    sortOrder?: number;
    enabled?: boolean;
  }): StoredShortcutGroup | null {
    const existing = this.getShortcutGroup(id);
    if (!existing) return null;
    const title = input.title === undefined ? existing.title : normalizeShortcutText(input.title, "分组名称", 64);
    const icon = input.icon === undefined ? existing.icon : normalizeShortcutText(input.icon, "分组图标", 8);
    const description = input.description === undefined ? existing.description : normalizeShortcutText(input.description, "分组说明", 160, false);
    const surface = input.surface === undefined ? existing.surface : normalizeShortcutSurface(input.surface);
    const layout = input.layout === undefined ? existing.layout : normalizeShortcutLayout(input.layout);
    const sortOrder = input.sortOrder === undefined ? existing.sort_order : input.sortOrder;
    if (!Number.isSafeInteger(sortOrder)) throw new Error("分组排序必须是整数。");
    this.db.prepare(
      `UPDATE shortcut_groups SET title = ?, icon = ?, description = ?, surface = ?, layout = ?, sort_order = ?,
       enabled = ?, updated_at = ? WHERE id = ?`,
    ).run(title, icon, description, surface, layout, sortOrder, input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0, this.timestamp(), id);
    return this.getShortcutGroup(id);
  }

  public deleteShortcutGroup(id: string): boolean {
    const group = this.getShortcutGroup(id);
    if (!group || group.built_in) return false;
    const shortcutCount = this.db.prepare("SELECT COUNT(*) AS count FROM shortcuts WHERE group_id = ?").get(id) as { count: number };
    if (shortcutCount.count > 0) throw new Error("请先移除该分组中的快捷键。");
    return this.db.prepare("DELETE FROM shortcut_groups WHERE id = ? AND built_in = 0").run(id).changes > 0;
  }

  public createShortcut(input: {
    id?: string;
    groupId: string;
    title: string;
    detail?: string;
    kind: ShortcutKind;
    value: string;
    enabled?: boolean;
    builtIn?: boolean;
    dangerous?: boolean;
    actionKey?: string;
    displayMode?: ShortcutDisplayMode;
    sortOrder?: number;
  }): StoredShortcut {
    if (!this.getShortcutGroup(input.groupId)) throw new Error("快捷键分组不存在。");
    const id = input.id?.trim() || `shortcut-${randomUUID()}`;
    const title = normalizeShortcutText(input.title, "快捷键名称", 64);
    const detail = normalizeShortcutText(input.detail ?? "", "快捷键说明", 120, false);
    const kind = normalizeShortcutKind(input.kind);
    const actionKey = input.actionKey?.trim() || null;
    const value = normalizeShortcutText(input.value, "快捷键内容", 8_000, !actionKey);
    const displayMode = normalizeShortcutDisplayMode(input.displayMode ?? "closed");
    const sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder! : this.nextShortcutOrder(input.groupId);
    const now = this.timestamp();
    this.db.prepare(
      `INSERT INTO shortcuts
        (id, group_id, title, detail, kind, value, enabled, built_in, dangerous, action_key, display_mode, sort_order, operation_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, input.groupId, title, detail, kind, value, input.enabled === false ? 0 : 1, input.builtIn ? 1 : 0, input.dangerous ? 1 : 0, actionKey, displayMode, sortOrder, now, now);
    return this.getShortcut(id)!;
  }

  public updateShortcut(id: string, input: {
    groupId?: string;
    title?: string;
    detail?: string;
    kind?: ShortcutKind;
    value?: string;
    enabled?: boolean;
    dangerous?: boolean;
    actionKey?: string | null;
    displayMode?: ShortcutDisplayMode;
    sortOrder?: number;
  }): StoredShortcut | null {
    const existing = this.getShortcut(id);
    if (!existing) return null;
    const groupId = input.groupId ?? existing.group_id;
    if (!this.getShortcutGroup(groupId)) throw new Error("快捷键分组不存在。");
    const title = input.title === undefined ? existing.title : normalizeShortcutText(input.title, "快捷键名称", 64);
    const detail = input.detail === undefined ? existing.detail : normalizeShortcutText(input.detail, "快捷键说明", 120, false);
    const kind = input.kind === undefined ? existing.kind : normalizeShortcutKind(input.kind);
    const actionKey = input.actionKey === undefined ? existing.action_key : input.actionKey?.trim() || null;
    const value = input.value === undefined ? existing.value : normalizeShortcutText(input.value, "快捷键内容", 8_000, !actionKey);
    const displayMode = input.displayMode === undefined ? existing.display_mode : normalizeShortcutDisplayMode(input.displayMode);
    const sortOrder = input.sortOrder === undefined ? existing.sort_order : input.sortOrder;
    if (!Number.isSafeInteger(sortOrder)) throw new Error("快捷键排序必须是整数。");
    this.db.prepare(
      `UPDATE shortcuts SET group_id = ?, title = ?, detail = ?, kind = ?, value = ?, enabled = ?, dangerous = ?, action_key = ?, display_mode = ?, sort_order = ?,
       updated_at = ? WHERE id = ?`,
    ).run(groupId, title, detail, kind, value, input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0, input.dangerous === undefined ? (existing.dangerous ? 1 : 0) : input.dangerous ? 1 : 0, actionKey, displayMode, sortOrder, this.timestamp(), id);
    return this.getShortcut(id);
  }

  public moveShortcutToEdge(id: string, position: "start" | "end"): StoredShortcut | null {
    const existing = this.getShortcut(id);
    if (!existing) return null;
    if (position !== "start" && position !== "end") throw new Error("快捷键位置必须是 start 或 end。");

    return this.transaction(() => {
      const bounds = this.db.prepare(
        `SELECT MIN(sort_order) AS min_order, MAX(sort_order) AS max_order
         FROM shortcuts WHERE group_id = ? AND id <> ?`,
      ).get(existing.group_id, id) as { min_order: number | null; max_order: number | null };
      const sortOrder = position === "start"
        ? (bounds.min_order === null ? 0 : Number(bounds.min_order) - 1)
        : (bounds.max_order === null ? 0 : Number(bounds.max_order) + 1);
      this.db.prepare(
        "UPDATE shortcuts SET sort_order = ?, updated_at = ? WHERE id = ?",
      ).run(sortOrder, this.timestamp(), id);
      return this.getShortcut(id);
    });
  }

  public deleteShortcut(id: string): boolean {
    const shortcut = this.getShortcut(id);
    if (!shortcut || shortcut.built_in) return false;
    return this.db.prepare("DELETE FROM shortcuts WHERE id = ? AND built_in = 0").run(id).changes > 0;
  }

  public recordShortcutUse(id: string): StoredShortcut | null {
    const result = this.db.prepare(
      "UPDATE shortcuts SET operation_count = operation_count + 1, updated_at = ? WHERE id = ?",
    ).run(this.timestamp(), id);
    return result.changes > 0 ? this.getShortcut(id) : null;
  }

  public createStagedWebTaskAttachment(input: {
    attachmentId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    localPath: string;
  }): StoredWebTaskAttachment {
    const now = this.timestamp();
    this.db.prepare(
      `INSERT INTO web_task_attachments
        (attachment_id, task_guid, file_name, mime_type, size_bytes, local_path, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run(input.attachmentId, input.fileName, input.mimeType, input.sizeBytes, input.localPath, now);
    return this.getStagedWebTaskAttachment(input.attachmentId)!;
  }

  public getStagedWebTaskAttachment(attachmentId: string): StoredWebTaskAttachment | null {
    const row = this.db.prepare(
      "SELECT * FROM web_task_attachments WHERE attachment_id = ? AND task_guid IS NULL",
    ).get(attachmentId) as Record<string, unknown> | undefined;
    return row ? mapWebTaskAttachment(row) : null;
  }

  public getStagedWebTaskAttachments(attachmentIds: string[]): StoredWebTaskAttachment[] {
    if (attachmentIds.length === 0) return [];
    const uniqueIds = [...new Set(attachmentIds)];
    const rows = this.db.prepare(
      `SELECT * FROM web_task_attachments WHERE task_guid IS NULL
       AND attachment_id IN (${uniqueIds.map(() => "?").join(", ")})`,
    ).all(...uniqueIds) as Record<string, unknown>[];
    const byId = new Map(rows.map((row) => [String(row.attachment_id), mapWebTaskAttachment(row)]));
    return uniqueIds.flatMap((attachmentId) => {
      const attachment = byId.get(attachmentId);
      return attachment ? [attachment] : [];
    });
  }

  public countStagedWebTaskAttachments(since?: string): number {
    const row = since
      ? this.db.prepare(
          "SELECT COUNT(*) AS total FROM web_task_attachments WHERE task_guid IS NULL AND created_at >= ?",
        ).get(since) as { total: number }
      : this.db.prepare(
          "SELECT COUNT(*) AS total FROM web_task_attachments WHERE task_guid IS NULL",
        ).get() as { total: number };
    return row.total;
  }

  public stagedWebTaskAttachmentBytes(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM web_task_attachments WHERE task_guid IS NULL",
    ).get() as { total: number };
    return row.total;
  }

  public listWebTaskAttachments(taskGuid: string): StoredWebTaskAttachment[] {
    const rows = this.db.prepare(
      "SELECT * FROM web_task_attachments WHERE task_guid = ? ORDER BY created_at ASC",
    ).all(taskGuid) as Record<string, unknown>[];
    return rows.map(mapWebTaskAttachment);
  }

  public getWebTaskAttachment(taskGuid: string, attachmentId: string): StoredWebTaskAttachment | null {
    const row = this.db.prepare(
      "SELECT * FROM web_task_attachments WHERE task_guid = ? AND attachment_id = ?",
    ).get(taskGuid, attachmentId) as Record<string, unknown> | undefined;
    return row ? mapWebTaskAttachment(row) : null;
  }

  public deleteStagedWebTaskAttachment(attachmentId: string): StoredWebTaskAttachment | null {
    return this.transaction(() => {
      const attachment = this.getStagedWebTaskAttachment(attachmentId);
      if (!attachment) return null;
      this.db.prepare(
        "DELETE FROM web_task_attachments WHERE attachment_id = ? AND task_guid IS NULL",
      ).run(attachmentId);
      return attachment;
    });
  }

  public deleteExpiredStagedWebTaskAttachments(olderThan: string): StoredWebTaskAttachment[] {
    return this.transaction(() => {
      const rows = this.db.prepare(
        "SELECT * FROM web_task_attachments WHERE task_guid IS NULL AND created_at < ?",
      ).all(olderThan) as Record<string, unknown>[];
      if (rows.length > 0) {
        this.db.prepare(
          "DELETE FROM web_task_attachments WHERE task_guid IS NULL AND created_at < ?",
        ).run(olderThan);
      }
      return rows.map(mapWebTaskAttachment);
    });
  }

  public getTask(taskGuid: string): StoredTask | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE task_guid = ?")
      .get(taskGuid) as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  public getWebTaskSubmission(idempotencyKey: string): StoredWebTaskSubmission | null {
    const row = this.db
      .prepare("SELECT * FROM web_task_submissions WHERE idempotency_key = ?")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      idempotency_key: String(row.idempotency_key),
      request_hash: String(row.request_hash),
      normalized_request_json: String(row.normalized_request_json),
      task_guid: String(row.task_guid),
      run_id: String(row.run_id),
      created_at: String(row.created_at),
    };
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

  public getCodexHistoryListCache(homeId: string, filterKey: string): {
    sourceFingerprint: string;
    payloadJson: string;
    refreshedAt: string;
  } | null {
    const row = this.db.prepare(
      `SELECT source_fingerprint, payload_json, refreshed_at
       FROM codex_history_list_cache WHERE home_id = ? AND filter_key = ?`,
    ).get(homeId, filterKey) as Record<string, unknown> | undefined;
    return row ? {
      sourceFingerprint: String(row.source_fingerprint),
      payloadJson: String(row.payload_json),
      refreshedAt: String(row.refreshed_at),
    } : null;
  }

  public saveCodexHistoryListCache(
    homeId: string,
    filterKey: string,
    sourceFingerprint: string,
    payloadJson: string,
  ): void {
    const refreshedAt = this.timestamp();
    this.db.prepare(
      `INSERT INTO codex_history_list_cache
         (home_id, filter_key, source_fingerprint, payload_json, refreshed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(home_id, filter_key) DO UPDATE SET
         source_fingerprint = excluded.source_fingerprint,
         payload_json = excluded.payload_json,
         refreshed_at = excluded.refreshed_at`,
    ).run(homeId, filterKey, sourceFingerprint, payloadJson, refreshedAt);
    this.db.prepare(
      `DELETE FROM codex_history_list_cache
       WHERE home_id = ? AND filter_key IN (
         SELECT filter_key FROM codex_history_list_cache
         WHERE home_id = ? ORDER BY refreshed_at DESC, filter_key ASC LIMIT -1 OFFSET 24
       )`,
    ).run(homeId, homeId);
  }

  public getCodexHistoryThreadHomePreferences(threadIds: string[]): Map<string, string> {
    const uniqueThreadIds = [...new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean))];
    if (uniqueThreadIds.length === 0) return new Map();
    const preferences = new Map<string, string>();
    for (let offset = 0; offset < uniqueThreadIds.length; offset += 500) {
      const batch = uniqueThreadIds.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT thread_id, preferred_home_id
         FROM codex_history_thread_home_preferences
         WHERE thread_id IN (${placeholders})`,
      ).all(...batch) as Array<{ thread_id: string; preferred_home_id: string }>;
      for (const row of rows) preferences.set(String(row.thread_id), String(row.preferred_home_id));
    }
    return preferences;
  }

  public saveCodexHistoryThreadHomePreference(threadId: string, preferredHomeId: string): string {
    const normalizedThreadId = requireNonEmpty(threadId, "threadId");
    const normalizedHomeId = requireNonEmpty(preferredHomeId, "preferredHomeId");
    if (normalizedThreadId.length > 200 || normalizedHomeId.length > 200) {
      throw new Error("threadId and preferredHomeId must be 200 characters or fewer");
    }
    const updatedAt = this.timestamp();
    this.db.prepare(
      `INSERT INTO codex_history_thread_home_preferences (thread_id, preferred_home_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         preferred_home_id = excluded.preferred_home_id,
         updated_at = excluded.updated_at`,
    ).run(normalizedThreadId, normalizedHomeId, updatedAt);
    return updatedAt;
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
      .prepare(`SELECT * FROM bridge_tasks${where} ORDER BY updated_at DESC, bridge_task_id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(mapBridgeTask), total: countRow.total };
  }

  public readBridgeTaskPage(taskId: string, limit: number, offset: number, includeEvents = true): {
    followups: { items: StoredBridgeTaskFollowup[]; total: number };
    attachments: { items: StoredBridgeTaskAttachment[]; total: number };
    events: { items: StoredBridgeTaskEvent[]; total: number };
  } {
    const page = <T>(table: string, order: string, map: (row: Record<string, unknown>) => T, includeItems = true) => {
      const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE bridge_task_id = ?`)
        .get(taskId) as { total: number }).total;
      const rows = includeItems ? this.db.prepare(`SELECT * FROM ${table} WHERE bridge_task_id = ? ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(taskId, limit, offset) as Record<string, unknown>[] : [];
      return { total, items: rows.map(map) };
    };
    return {
      followups: page("bridge_task_followups", "created_at DESC, followup_id DESC", mapBridgeTaskFollowup),
      attachments: page("bridge_task_attachments", "created_at DESC, attachment_id DESC", mapBridgeTaskAttachment),
      events: page("bridge_task_events", "id DESC", mapBridgeTaskEvent, includeEvents),
    };
  }

  public appendWebDirectFollowup(taskId: string, text: string, idempotencyKey: string): StoredBridgeTask {
    const normalizedTaskId = requireNonEmpty(taskId, "taskId");
    const normalizedText = requireNonEmpty(text.trim(), "text");
    const key = requireNonEmpty(idempotencyKey.trim(), "idempotencyKey");
    if (normalizedText.length > 2000) throw new Error("补充内容不能超过 2000 个字符。");
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new Error("无效的幂等键。");
    const sourceEventId = `web-task-followup:${key}`;
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT bridge_task_id, text FROM bridge_task_followups WHERE source_event_id = ?",
      ).get(sourceEventId) as { bridge_task_id: string; text: string } | undefined;
      if (existing) {
        if (existing.bridge_task_id !== normalizedTaskId || existing.text !== normalizedText) {
          throw new WebTaskSubmissionConflictError();
        }
        return this.getBridgeTask(normalizedTaskId)!;
      }
      const task = this.getBridgeTask(normalizedTaskId);
      if (!task) throw new Error("Direct 任务不存在。");
      if (!task.thread_id) throw new Error("该任务尚无可续接的 Codex thread。");
      if (task.status === "CANCEL_REQUESTED") throw new Error("任务正在取消，请稍后再追加。");
      const result = this.ingestDirectMessage({
        sourceEventId,
        eventType: "web.task.followup",
        messageId: sourceEventId,
        chatId: task.chat_id,
        chatType: task.chat_type,
        senderId: task.sender_id,
        senderName: "Bridge Web",
        text: normalizedText,
        sessionKey: task.session_key,
        replyToMessageId: task.message_id,
        payload: { source: "web-task-panel" },
        attachments: [],
      });
      if (!result.continued || result.task.bridge_task_id !== normalizedTaskId) {
        throw new Error("续问没有关联到原 Direct 任务。");
      }
      return result.task;
    });
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
    initialTurn = true,
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
             initial_final_response = CASE WHEN ? THEN COALESCE(initial_final_response, ?) ELSE initial_final_response END,
             lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?,
             updated_at = ? WHERE bridge_task_id = ?`,
        )
        .run(finalStatus, response, failure, initialTurn ? 1 : 0, finalResponse?.trim() || null,
          finalStatus === "QUEUED" ? now : null, now, taskId);
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
    return this.finishBridgeTask(bridgeTaskId, status, finalResponse, error, workerId, false);
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

  public queryTaskPanel(query: TaskPanelQuery = {}): {
    items: Array<{ source: "desk"; task: StoredTask } | { source: "direct"; task: StoredBridgeTask }>;
    total: number;
  } {
    const candidates: string[] = [];
    const params: Array<string | number> = [];
    const deskStates = query.states?.filter((state) => TASK_STATES.includes(state as TaskState)) ?? [];
    const directStates = query.states?.filter((state) => DIRECT_TASK_STATUSES.includes(state as DirectTaskStatus)) ?? [];
    if (query.source !== "direct" && (!query.states?.length || deskStates.length)) {
      const clauses: string[] = [];
      if (deskStates.length) { clauses.push(`state IN (${deskStates.map(() => "?").join(", ")})`); params.push(...deskStates); }
      if (query.projectKey) { clauses.push("project_key = ?"); params.push(query.projectKey); }
      if (query.mode) { clauses.push("mode = ?"); params.push(query.mode); }
      if (query.search) {
        clauses.push("(task_guid LIKE ? OR input_text LIKE ? OR COALESCE(thread_id, '') LIKE ? OR COALESCE(last_error, '') LIKE ?)");
        params.push(...Array(4).fill(`%${query.search}%`));
      }
      candidates.push(`SELECT 'desk' AS source, task_guid AS id, updated_at FROM tasks${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`);
    }
    if (query.source !== "desk" && !query.projectKey && !query.mode
      && (!query.states?.length || directStates.length)) {
      const clauses: string[] = [];
      if (directStates.length) { clauses.push(`status IN (${directStates.map(() => "?").join(", ")})`); params.push(...directStates); }
      if (query.search) {
        clauses.push("(bridge_task_id LIKE ? OR text LIKE ? OR COALESCE(thread_id, '') LIKE ? OR COALESCE(error, '') LIKE ?)");
        params.push(...Array(4).fill(`%${query.search}%`));
      }
      candidates.push(`SELECT 'direct' AS source, bridge_task_id AS id, updated_at FROM bridge_tasks${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`);
    }
    if (!candidates.length) return { items: [], total: 0 };
    const union = candidates.join(" UNION ALL ");
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM (${union})`).get(...params) as { total: number }).total;
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const rows = this.db.prepare(`SELECT source, id FROM (${union}) ORDER BY updated_at DESC, source, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ source: "desk" | "direct"; id: string }>;
    const items: Array<{ source: "desk"; task: StoredTask } | { source: "direct"; task: StoredBridgeTask }> = [];
    for (const row of rows) {
      if (row.source === "desk") {
        const task = this.getTask(row.id);
        if (task) items.push({ source: "desk", task });
      } else {
        const task = this.getBridgeTask(row.id);
        if (task) items.push({ source: "direct", task });
      }
    }
    return { total, items };
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

  public claimWebTaskSubmission(args: ClaimWebTaskSubmissionArgs): ClaimWebTaskSubmissionResult {
    return this.transaction(() => {
      const existing = this.getWebTaskSubmission(args.idempotencyKey);
      const requestHash = createHash("sha256").update(args.normalizedRequestJson).digest("hex");
      if (existing) {
        if (existing.request_hash !== requestHash || existing.normalized_request_json !== args.normalizedRequestJson) {
          throw new WebTaskSubmissionConflictError();
        }
        return { status: "existing", submission: existing };
      }
      const claim = this.claimRun(args);
      if (!claim) throw new Error("任务暂时无法排队，请稍后重试。");
      this.db.prepare(`INSERT INTO web_task_submissions
        (idempotency_key, request_hash, normalized_request_json, task_guid, run_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
          args.idempotencyKey, requestHash, args.normalizedRequestJson, claim.taskGuid, claim.runId, this.timestamp(),
        );
      return { status: "created", claim };
    });
  }

  public listQueuedWebRunIds(): string[] {
    return (this.db.prepare(`SELECT r.run_id FROM runs r JOIN tasks t ON t.task_guid = r.task_guid
      WHERE t.origin = 'web' AND t.active_run_id = r.run_id AND t.state = 'QUEUED' AND r.state = 'QUEUED'
      ORDER BY r.started_at, r.run_id`).all() as Array<{ run_id: string }>).map((row) => row.run_id);
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
              origin = ?, project_key = ?, mode = ?, repo = ?, state = 'QUEUED',
              input_text = ?, input_hash = ?, active_run_id = ?,
              completed_at = NULL, last_error = NULL, worker_pid = NULL, service_instance_id = NULL,
              progress_event = NULL, progress_text = NULL, progress_updated_at = NULL,
              updated_at = ?
             WHERE task_guid = ?`,
          )
          .run(
            args.task.origin ?? "feishu",
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
              task_guid, origin, project_key, mode, repo, state, input_text, input_hash,
              thread_id, active_run_id, completed_at, last_error, created_at, updated_at,
              worker_pid, service_instance_id
            ) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, NULL, ?, NULL, NULL, ?, ?, NULL, NULL)`,
          )
          .run(
            args.task.taskGuid,
            args.task.origin ?? "feishu",
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
            thread_id, execution_backend, tmux_session_id, state, final_response, usage_json, started_at, finished_at,
            worker_pid, service_instance_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, NULL, ?, NULL, NULL, NULL)`,
        )
        .run(
          runId,
          args.task.taskGuid,
          args.task.inputHash,
          args.inputText,
          previousInputText,
          args.promptText,
          resumedThreadId,
          "codex-sdk",
          null,
          now,
        );

      const attachmentIds = [...new Set(args.attachmentIds ?? [])];
      if (attachmentIds.length > 0) {
        if ((args.task.origin ?? "feishu") !== "web") {
          throw new Error("only web tasks can attach local task files");
        }
        const stagedAttachments = this.getStagedWebTaskAttachments(attachmentIds);
        if (stagedAttachments.length !== attachmentIds.length) {
          throw new Error("任务附件已失效或已绑定其他任务，请重新选择附件。");
        }
        const attach = this.db.prepare(
          "UPDATE web_task_attachments SET task_guid = ? WHERE attachment_id = ? AND task_guid IS NULL",
        );
        for (const attachmentId of attachmentIds) {
          if (attach.run(args.task.taskGuid, attachmentId).changes !== 1) {
            throw new Error("任务附件已被其他请求绑定，请重新选择附件。");
          }
        }
      }

      if (args.startedComment !== undefined) {
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
      }

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
    workerPid: number | null,
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
        .prepare(
          `SELECT r.run_id, r.task_guid, t.origin FROM runs r
           INNER JOIN tasks t ON t.task_guid = r.task_guid
           WHERE r.state = 'RUNNING'`,
        )
        .all() as Array<{ run_id: string; task_guid: string; origin: string }>;
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
        const comment = row.origin === "web" ? "" : commentForTask(row.task_guid, error);
        if (comment) {
          this.enqueueOutboxInTransaction(
            row.task_guid,
            "comment",
            { content: comment },
            now,
          );
        }
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

  public getWebAuthPairing(): WebAuthPairingRecord | null {
    const row = this.db
      .prepare("SELECT code_hash, expires_at FROM web_auth_pairings WHERE id = 1")
      .get() as { code_hash: string; expires_at: string } | undefined;
    if (!row) return null;
    const expiresAt = Date.parse(row.expires_at);
    return Number.isFinite(expiresAt)
      ? { codeHash: row.code_hash, expiresAt }
      : null;
  }

  public saveWebAuthPairing(record: WebAuthPairingRecord): void {
    this.db
      .prepare(
        `INSERT INTO web_auth_pairings (id, code_hash, expires_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
      )
      .run(record.codeHash, new Date(record.expiresAt).toISOString());
  }

  public clearWebAuthPairing(): void {
    this.db.prepare("DELETE FROM web_auth_pairings WHERE id = 1").run();
  }

  public createWebAuthSession(record: WebAuthSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO web_auth_sessions
          (session_id, token_hash, device_name, user_agent, remote_address,
           created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionId,
        record.tokenHash,
        record.deviceName,
        record.userAgent,
        record.remoteAddress,
        record.createdAt,
        record.lastSeenAt,
        record.expiresAt,
        record.revokedAt,
      );
  }

  public getWebAuthSession(tokenHash: string): WebAuthSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM web_auth_sessions WHERE token_hash = ?")
      .get(tokenHash) as Record<string, unknown> | undefined;
    return row ? mapWebAuthSession(row) : null;
  }

  public touchWebAuthSession(
    sessionId: string,
    lastSeenAt: string,
    userAgent: string | null,
    remoteAddress: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE web_auth_sessions SET last_seen_at = ?, user_agent = ?, remote_address = ? WHERE session_id = ? AND revoked_at IS NULL",
      )
      .run(lastSeenAt, userAgent, remoteAddress, sessionId);
  }

  public listWebAuthSessions(): WebAuthSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM web_auth_sessions ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map(mapWebAuthSession);
  }

  public updateWebAuthSessionDeviceName(sessionId: string, deviceName: string): void {
    this.db
      .prepare("UPDATE web_auth_sessions SET device_name = ? WHERE session_id = ? AND revoked_at IS NULL")
      .run(deviceName, sessionId);
  }

  public revokeWebAuthSession(sessionId: string, revokedAt: string): void {
    this.db
      .prepare(
        "UPDATE web_auth_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
      )
      .run(revokedAt, sessionId);
  }

  public revokeAllWebAuthSessions(revokedAt: string): void {
    this.db
      .prepare("UPDATE web_auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL")
      .run(revokedAt);
  }

  public recordTmuxSession(
    session: { id: string; name: string; cwd: string; createdAt: number },
    options: { projectKey?: string | null; createdByDeviceId?: string | null } = {},
  ): StoredTmuxSession {
    const resolvedCwd = resolve(session.cwd);
    const inferredProject = this.db.prepare(
      "SELECT name FROM projects WHERE path = ? AND status = 'available' LIMIT 1",
    ).get(resolvedCwd) as { name: string } | undefined;
    const projectKey = options.projectKey ?? inferredProject?.name ?? null;
    const existing = this.db.prepare(
      `SELECT record_id, session_name, project_key, working_directory, last_seen_at, ended_at, created_by_device_id
       FROM tmux_sessions WHERE tmux_session_id = ? AND tmux_created_at = ? AND ended_at IS NULL
       ORDER BY first_seen_at DESC LIMIT 1`,
    ).get(session.id, session.createdAt) as {
      record_id: string;
      session_name: string;
      project_key: string | null;
      working_directory: string;
      last_seen_at: string;
      ended_at: string | null;
      created_by_device_id: string | null;
    } | undefined;
    const now = this.timestamp();
    if (existing) {
      const current = existing;
      const refreshAfter = new Date(this.now().getTime() - 60_000).toISOString();
      const refreshedLastSeen = current.last_seen_at <= refreshAfter ? now : current.last_seen_at;
      const nextProjectKey = projectKey ?? current.project_key;
      const nextDeviceId = current.created_by_device_id ?? options.createdByDeviceId ?? null;
      if (
        current.session_name !== session.name
        || current.project_key !== nextProjectKey
        || current.working_directory !== session.cwd
        || current.last_seen_at !== refreshedLastSeen
        || current.ended_at !== null
        || current.created_by_device_id !== nextDeviceId
      ) {
        this.db.prepare(`UPDATE tmux_sessions SET
          session_name = ?, project_key = ?, working_directory = ?, last_seen_at = ?,
          ended_at = NULL, created_by_device_id = ? WHERE record_id = ?`).run(
            session.name,
            nextProjectKey,
            session.cwd,
            refreshedLastSeen,
            nextDeviceId,
            current.record_id,
          );
      }
      return this.getTmuxSession(current.record_id)!;
    }

    const recordId = randomUUID();
    this.db.prepare(`INSERT INTO tmux_sessions
      (record_id, tmux_session_id, session_name, project_key, working_directory,
       tmux_created_at, first_seen_at, last_seen_at, ended_at, created_by_device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
        recordId,
        session.id,
        session.name,
        projectKey,
        session.cwd,
        session.createdAt,
        now,
        now,
        options.createdByDeviceId ?? null,
      );
    return this.getTmuxSession(recordId)!;
  }

  public syncTmuxSessions(sessions: Array<{ id: string; name: string; cwd: string; createdAt: number }>): void {
    const currentKeys = new Set(sessions.map((session) => `${session.id}\u0000${session.createdAt}`));
    const endedAt = this.timestamp();
    this.transaction(() => {
      const active = this.db.prepare(
        "SELECT record_id, tmux_session_id, tmux_created_at FROM tmux_sessions WHERE ended_at IS NULL",
      ).all() as Array<{ record_id: string; tmux_session_id: string; tmux_created_at: number }>;
      for (const record of active) {
        if (!currentKeys.has(`${record.tmux_session_id}\u0000${record.tmux_created_at}`)) {
          this.db.prepare("UPDATE tmux_sessions SET ended_at = ? WHERE record_id = ? AND ended_at IS NULL")
            .run(endedAt, record.record_id);
        }
      }
      for (const session of sessions) this.recordTmuxSession(session);
    });
  }

  public getTmuxSession(recordId: string): StoredTmuxSession | null {
    const row = this.db.prepare("SELECT * FROM tmux_sessions WHERE record_id = ?")
      .get(recordId) as Record<string, unknown> | undefined;
    return row ? mapTmuxSession(row) : null;
  }

  public getLatestTmuxSession(tmuxSessionId: string): StoredTmuxSession | null {
    const row = this.db.prepare(`SELECT * FROM tmux_sessions
      WHERE tmux_session_id = ?
      ORDER BY (ended_at IS NULL) DESC, first_seen_at DESC
      LIMIT 1`).get(tmuxSessionId) as Record<string, unknown> | undefined;
    return row ? mapTmuxSession(row) : null;
  }

  public markTmuxSessionEnded(tmuxSessionId: string): void {
    this.db.prepare("UPDATE tmux_sessions SET ended_at = ? WHERE tmux_session_id = ? AND ended_at IS NULL")
      .run(this.timestamp(), tmuxSessionId);
  }

  public beginTmuxSessionAction(input: {
    sessionRecordId: string;
    deviceId: string | null;
    actionType: TmuxSessionActionType;
    requestId: string | null;
    content: string;
    submissionFingerprint?: string;
  }): { actionId: string; duplicate: boolean } {
    const session = this.getTmuxSession(input.sessionRecordId);
    if (!session) throw new Error("tmux session record not found");
    return this.transaction(() => {
      if (input.actionType === "task_submit" && input.submissionFingerprint) {
        const recent = this.db.prepare(`SELECT action_id FROM tmux_session_actions
          WHERE session_record_id = ? AND submission_fingerprint = ?
            AND status IN ('sending', 'confirmed', 'unconfirmed') AND created_at >= ?
          LIMIT 1`).get(
            session.record_id,
            input.submissionFingerprint,
            new Date(this.now().getTime() - 5 * 60_000).toISOString(),
          );
        if (recent) return { actionId: "", duplicate: true };
      }
      const actionId = randomUUID();
      this.db.prepare(`INSERT INTO tmux_session_actions
      (action_id, session_record_id, tmux_session_id, session_name, project_key, working_directory,
       device_id, action_type, request_id, content, submission_fingerprint, status, error, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', NULL, ?, NULL)`).run(
        actionId,
        session.record_id,
        session.tmux_session_id,
        session.session_name,
        session.project_key,
        session.working_directory,
        input.deviceId,
        input.actionType,
        input.requestId,
        input.content,
        input.submissionFingerprint ?? null,
        this.timestamp(),
      );
      return { actionId, duplicate: false };
    });
  }

  public finishTmuxSessionAction(
    actionId: string,
    status: Exclude<TmuxSessionActionStatus, "sending">,
    error: string | null = null,
  ): boolean {
    const result = this.db.prepare(`UPDATE tmux_session_actions
      SET status = ?, error = ?, completed_at = ?
      WHERE action_id = ? AND status = 'sending'`).run(status, error, this.timestamp(), actionId);
    return result.changes > 0;
  }

  public listTmuxSessionActions(query: TmuxSessionActionQuery = {}): { items: StoredTmuxSessionAction[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (query.tmuxSessionId) {
      clauses.push("(s.tmux_session_id = ? OR s.record_id = ?)");
      params.push(query.tmuxSessionId, query.tmuxSessionId);
    }
    if (query.search?.trim()) {
      const pattern = `%${query.search.trim().slice(0, 500)}%`;
      clauses.push("(a.content LIKE ? OR a.session_name LIKE ? OR a.working_directory LIKE ? OR COALESCE(d.device_name, '') LIKE ?)");
      params.push(pattern, pattern, pattern, pattern);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const count = this.db.prepare(`SELECT COUNT(*) AS total
      FROM tmux_session_actions a
      JOIN tmux_sessions s ON s.record_id = a.session_record_id
      LEFT JOIN web_auth_sessions d ON d.session_id = a.device_id${where}`)
      .get(...params) as { total: number };
    const rows = this.db.prepare(`SELECT
      a.action_id, a.session_record_id, a.tmux_session_id, a.session_name, a.project_key,
      a.working_directory, s.ended_at AS session_ended_at, a.device_id, d.device_name,
      a.action_type, a.request_id, a.content, a.status, a.error, a.created_at, a.completed_at
      FROM tmux_session_actions a
      JOIN tmux_sessions s ON s.record_id = a.session_record_id
      LEFT JOIN web_auth_sessions d ON d.session_id = a.device_id${where}
      ORDER BY a.created_at DESC, a.action_id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(mapTmuxSessionAction), total: count.total };
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
    addColumnIfMissing(this.db, "tmux_session_actions", "tmux_session_id", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.db, "tmux_session_actions", "session_name", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.db, "tmux_session_actions", "project_key", "TEXT");
    addColumnIfMissing(this.db, "tmux_session_actions", "working_directory", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.db, "tmux_session_actions", "submission_fingerprint", "TEXT");
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tmux_session_actions_fingerprint
      ON tmux_session_actions(session_record_id, submission_fingerprint, created_at DESC)`);
    this.db.exec(`UPDATE tmux_session_actions
      SET tmux_session_id = COALESCE(NULLIF(tmux_session_id, ''), (
            SELECT tmux_session_id FROM tmux_sessions WHERE record_id = tmux_session_actions.session_record_id
          )),
          session_name = COALESCE(NULLIF(session_name, ''), (
            SELECT session_name FROM tmux_sessions WHERE record_id = tmux_session_actions.session_record_id
          )),
          project_key = COALESCE(project_key, (
            SELECT project_key FROM tmux_sessions WHERE record_id = tmux_session_actions.session_record_id
          )),
          working_directory = COALESCE(NULLIF(working_directory, ''), (
            SELECT working_directory FROM tmux_sessions WHERE record_id = tmux_session_actions.session_record_id
          ))
      WHERE EXISTS (
        SELECT 1 FROM tmux_sessions WHERE record_id = tmux_session_actions.session_record_id
      ) AND (
        tmux_session_id = '' OR session_name = '' OR working_directory = ''
      )`);
    addColumnIfMissing(this.db, "tasks", "worker_pid", "INTEGER");
    addColumnIfMissing(this.db, "tasks", "origin", "TEXT NOT NULL DEFAULT 'feishu'");
    addColumnIfMissing(this.db, "tasks", "service_instance_id", "TEXT");
    addColumnIfMissing(this.db, "tasks", "progress_event", "TEXT");
    addColumnIfMissing(this.db, "tasks", "progress_text", "TEXT");
    addColumnIfMissing(this.db, "tasks", "progress_updated_at", "TEXT");
    addColumnIfMissing(this.db, "runs", "input_text", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.db, "runs", "previous_input_text", "TEXT");
    addColumnIfMissing(this.db, "runs", "prompt_text", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.db, "runs", "worker_pid", "INTEGER");
    addColumnIfMissing(this.db, "runs", "execution_backend", "TEXT NOT NULL DEFAULT 'codex-sdk'");
    addColumnIfMissing(this.db, "runs", "tmux_session_id", "TEXT");
    addColumnIfMissing(this.db, "runs", "service_instance_id", "TEXT");
    addColumnIfMissing(this.db, "runs", "progress_event", "TEXT");
    addColumnIfMissing(this.db, "runs", "progress_text", "TEXT");
    addColumnIfMissing(this.db, "runs", "progress_updated_at", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_tmux_target_state ON runs(tmux_session_id, state)");
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
    addColumnIfMissing(this.db, "bridge_tasks", "initial_final_response", "TEXT");
    this.db.exec(`UPDATE bridge_tasks SET initial_final_response = final_response
      WHERE initial_final_response IS NULL AND final_response IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bridge_task_followups f WHERE f.bridge_task_id = bridge_tasks.bridge_task_id)`);
    addColumnIfMissing(this.db, "bridge_task_attachments", "followup_id", "TEXT");
    addColumnIfMissing(this.db, "shortcuts", "sort_order", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(this.db, "shortcut_groups", "surface", "TEXT NOT NULL DEFAULT 'palette'");
    addColumnIfMissing(this.db, "shortcuts", "action_key", "TEXT");
    addColumnIfMissing(this.db, "shortcuts", "display_mode", "TEXT NOT NULL DEFAULT 'closed'");
  }

  private seedShortcutDefaults(): void {
    this.transaction(() => {
      const now = this.timestamp();
      const insertGroup = this.db.prepare(
        `INSERT OR IGNORE INTO shortcut_groups
          (id, title, icon, description, surface, layout, sort_order, enabled, built_in, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      );
      for (const group of DEFAULT_SHORTCUT_GROUPS) {
        insertGroup.run(group.id, group.title, group.icon, group.description, group.surface, group.layout, group.sortOrder, now, now);
      }
      const insertShortcut = this.db.prepare(
        `INSERT OR IGNORE INTO shortcuts
          (id, group_id, title, detail, kind, value, enabled, built_in, dangerous, action_key, display_mode, sort_order, operation_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 0, ?, ?)`,
      );
      for (const [sortOrder, shortcut] of DEFAULT_SHORTCUTS.entries()) {
        insertShortcut.run(
          shortcut.id,
          shortcut.groupId,
          shortcut.title,
          shortcut.detail,
          shortcut.kind,
          shortcut.value,
          shortcut.dangerous ? 1 : 0,
          shortcut.actionKey ?? null,
          shortcut.displayMode ?? "closed",
          shortcut.sortOrder ?? sortOrder,
          now,
          now,
        );
      }
      this.db.prepare("UPDATE shortcut_groups SET surface = 'composer', updated_at = ? WHERE id = 'composer' AND built_in = 1").run(now);
      const repairComposerShortcut = this.db.prepare(
        `UPDATE shortcuts SET action_key = ?, display_mode = ?, updated_at = ?
         WHERE id = ? AND group_id = 'composer' AND built_in = 1 AND (action_key IS NULL OR action_key = '')`,
      );
      for (const shortcut of DEFAULT_SHORTCUTS) {
        if (shortcut.groupId === "composer" && shortcut.actionKey) {
          repairComposerShortcut.run(shortcut.actionKey, shortcut.displayMode ?? "closed", now, shortcut.id);
        }
      }

      // The first alias implementation used a separate command-line group.
      // Keep its counts, enabled state and any user edits, but place the four
      // built-in aliases into the existing Tmux/Codex groups instead.
      const legacyCommandShortcutTargets = new Map<string, string>([
        ["command-tmuxctl", "tmux"],
        ["command-s", "tmux"],
        ["command-proxyctl", "codex"],
        ["command-jump", "codex"],
      ]);
      const migrateLegacyCommandShortcut = this.db.prepare(
        `UPDATE shortcuts SET group_id = ?, sort_order = ?, updated_at = ?
         WHERE id = ? AND group_id = 'command-line' AND built_in = 1`,
      );
      for (const [sortOrder, shortcut] of DEFAULT_SHORTCUTS.entries()) {
        const targetGroupId = legacyCommandShortcutTargets.get(shortcut.id);
        if (targetGroupId) migrateLegacyCommandShortcut.run(targetGroupId, shortcut.sortOrder ?? sortOrder, now, shortcut.id);
      }
      this.db.prepare(
        `DELETE FROM shortcut_groups
         WHERE id = 'command-line' AND built_in = 1
           AND NOT EXISTS (SELECT 1 FROM shortcuts WHERE group_id = 'command-line')`,
      ).run();
    });
  }

  private nextShortcutGroupOrder(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM shortcut_groups").get() as { max_order: number };
    return Number(row.max_order) + 1;
  }

  private nextShortcutOrder(groupId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM shortcuts WHERE group_id = ?").get(groupId) as { max_order: number };
    return Number(row.max_order) + 1;
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
  table: "tasks" | "runs" | "bridge_tasks" | "bridge_task_attachments" | "shortcuts" | "shortcut_groups" | "tmux_session_actions",
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapShortcutGroup(row: Record<string, unknown>): StoredShortcutGroup {
  const layout = String(row.layout);
  const surface = String(row.surface ?? "palette");
  return {
    id: String(row.id),
    title: String(row.title),
    icon: String(row.icon ?? "⌘"),
    description: String(row.description ?? ""),
    surface: SHORTCUT_SURFACES.includes(surface as ShortcutSurface) ? surface as ShortcutSurface : "palette",
    layout: SHORTCUT_GROUP_LAYOUTS.includes(layout as ShortcutGroupLayout) ? layout as ShortcutGroupLayout : "grid",
    sort_order: Number(row.sort_order ?? 0),
    enabled: Number(row.enabled) === 1,
    built_in: Number(row.built_in) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapShortcut(row: Record<string, unknown>): StoredShortcut {
  const kind = String(row.kind);
  const displayMode = String(row.display_mode ?? "closed");
  return {
    id: String(row.id),
    group_id: String(row.group_id),
    title: String(row.title),
    detail: String(row.detail ?? ""),
    kind: SHORTCUT_KINDS.includes(kind as ShortcutKind) ? kind as ShortcutKind : "send",
    value: String(row.value),
    enabled: Number(row.enabled) === 1,
    built_in: Number(row.built_in) === 1,
    dangerous: Number(row.dangerous) === 1,
    action_key: row.action_key === null || row.action_key === undefined ? null : String(row.action_key),
    display_mode: SHORTCUT_DISPLAY_MODES.includes(displayMode as ShortcutDisplayMode) ? displayMode as ShortcutDisplayMode : "closed",
    sort_order: Number(row.sort_order ?? 0),
    operation_count: Number(row.operation_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function normalizeShortcutText(value: string, field: string, maxLength: number, required = true): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (required && !normalized) throw new Error(`${field}不能为空。`);
  if (normalized.length > maxLength) throw new Error(`${field}不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function normalizeShortcutKind(value: ShortcutKind): ShortcutKind {
  if (!SHORTCUT_KINDS.includes(value)) throw new Error("快捷键类型无效。");
  return value;
}

function normalizeShortcutSurface(value: ShortcutSurface): ShortcutSurface {
  if (!SHORTCUT_SURFACES.includes(value)) throw new Error("快捷键作用面无效。");
  return value;
}

function normalizeShortcutDisplayMode(value: ShortcutDisplayMode): ShortcutDisplayMode {
  if (!SHORTCUT_DISPLAY_MODES.includes(value)) throw new Error("快捷键展示状态无效。");
  return value;
}

function normalizeShortcutLayout(value: ShortcutGroupLayout): ShortcutGroupLayout {
  if (!SHORTCUT_GROUP_LAYOUTS.includes(value)) throw new Error("分组布局无效。");
  return value;
}

function mapTask(row: Record<string, unknown>): StoredTask {
  return {
    task_guid: String(row.task_guid),
    origin: String(row.origin ?? "feishu") as TaskOrigin,
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

function mapProject(row: Record<string, unknown>): StoredProject {
  return {
    name: String(row.name),
    path: String(row.path),
    status: String(row.status) as ProjectStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapWebTaskAttachment(row: Record<string, unknown>): StoredWebTaskAttachment {
  return {
    attachment_id: String(row.attachment_id),
    task_guid: nullableString(row.task_guid),
    file_name: String(row.file_name),
    mime_type: String(row.mime_type),
    size_bytes: Number(row.size_bytes),
    local_path: String(row.local_path),
    created_at: String(row.created_at),
  };
}

function isProjectDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
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
    initial_final_response: nullableString(row.initial_final_response),
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
    execution_backend: String(row.execution_backend ?? "codex-sdk") as StoredExecutionBackend,
    tmux_session_id: nullableString(row.tmux_session_id),
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

function mapWebAuthSession(row: Record<string, unknown>): WebAuthSessionRecord {
  return {
    sessionId: String(row.session_id),
    tokenHash: String(row.token_hash),
    deviceName: String(row.device_name),
    userAgent: nullableString(row.user_agent),
    remoteAddress: nullableString(row.remote_address),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
    revokedAt: nullableString(row.revoked_at),
  };
}

function mapTmuxSession(row: Record<string, unknown>): StoredTmuxSession {
  return {
    record_id: String(row.record_id),
    tmux_session_id: String(row.tmux_session_id),
    session_name: String(row.session_name),
    project_key: nullableString(row.project_key),
    working_directory: String(row.working_directory),
    tmux_created_at: Number(row.tmux_created_at),
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
    ended_at: nullableString(row.ended_at),
    created_by_device_id: nullableString(row.created_by_device_id),
  };
}

function mapTmuxSessionAction(row: Record<string, unknown>): StoredTmuxSessionAction {
  return {
    action_id: String(row.action_id),
    session_record_id: String(row.session_record_id),
    tmux_session_id: String(row.tmux_session_id),
    session_name: String(row.session_name),
    project_key: nullableString(row.project_key),
    working_directory: String(row.working_directory),
    session_ended_at: nullableString(row.session_ended_at),
    device_id: nullableString(row.device_id),
    device_name: nullableString(row.device_name),
    action_type: String(row.action_type) as StoredTmuxSessionAction["action_type"],
    request_id: nullableString(row.request_id),
    content: String(row.content),
    status: String(row.status) as StoredTmuxSessionAction["status"],
    error: nullableString(row.error),
    created_at: String(row.created_at),
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
