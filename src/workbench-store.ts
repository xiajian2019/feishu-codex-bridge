import { randomUUID } from "node:crypto";

import type { SqliteDatabase } from "./sqlite.js";

export type WorkbenchTarget =
  | { kind: "task"; id: string; source?: "desk" | "direct" | "aamp" }
  | { kind: "history"; id: string; homeId?: string };

export type WorkbenchPreferencePatch = Partial<{
  pinned: boolean;
  tags: string[];
  unread: boolean;
  keepAttention: boolean;
  title: string | null;
}>;

export interface WorkbenchPreferences {
  target: WorkbenchTarget;
  pinned: boolean;
  tags: string[];
  unread: boolean;
  keepAttention: boolean;
  title?: string;
  updatedAt: number;
}

export interface NewWorkbenchTemplate {
  title: string;
  text: string;
  projectKey?: string;
  model?: string;
  reasoningEffort?: string;
}

export type WorkbenchTemplatePatch = Partial<{
  title: string;
  text: string;
  projectKey: string | null;
  model: string | null;
  reasoningEffort: string | null;
}>;

export interface WorkbenchTemplate {
  id: string;
  title: string;
  text: string;
  projectKey?: string;
  model?: string;
  reasoningEffort?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewWorkbenchQueueMessage {
  idempotencyKey: string;
  text: string;
  model?: string;
  reasoningEffort?: string;
}

export type WorkbenchQueueMessagePatch = Partial<{
  text: string;
  model: string | null;
  reasoningEffort: string | null;
}>;

export type WorkbenchQueueMessageStatus = "queued" | "sending" | "sent" | "failed" | "unconfirmed";

export interface WorkbenchQueueMessage {
  id: string;
  target: WorkbenchTarget;
  text: string;
  model?: string;
  reasoningEffort?: string;
  idempotencyKey: string;
  status: WorkbenchQueueMessageStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  finishedAt?: number;
}

export interface WorkbenchQueueTarget {
  target: WorkbenchTarget;
  queuedCount: number;
  sendingCount: number;
  uncertainCount: number;
  latestUpdatedAt: number;
}

export type WorkbenchNotificationCategory = "completion" | "failure" | "action";

export interface NewWorkbenchNotification {
  eventKey: string;
  target: WorkbenchTarget;
  category: WorkbenchNotificationCategory;
  title: string;
  body?: string;
}

export interface WorkbenchNotification {
  id: string;
  eventKey: string;
  target: WorkbenchTarget;
  category: WorkbenchNotificationCategory;
  title: string;
  body?: string;
  route: string;
  createdAt: number;
  dismissedAt?: number;
}

export interface WorkbenchNotificationSettings {
  completion: boolean;
  failure: boolean;
  action: boolean;
  system: boolean;
  updatedAt: number;
}

export type WorkbenchAutomationReference =
  | { target: WorkbenchTarget; projectKey?: never }
  | { projectKey: string; target?: never };

export type NewWorkbenchAutomation = WorkbenchAutomationReference & {
  prompt: string;
  intervalMinutes: number;
  timeZone: string;
  enabled: boolean;
  nextRunAt?: number | null;
};

export type WorkbenchAutomationPatch = Partial<{
  target: WorkbenchTarget | null;
  projectKey: string | null;
  prompt: string;
  intervalMinutes: number;
  timeZone: string;
  enabled: boolean;
  nextRunAt: number | null;
}>;

export interface WorkbenchAutomation {
  id: string;
  target?: WorkbenchTarget;
  projectKey?: string;
  prompt: string;
  intervalMinutes: number;
  timeZone: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkbenchAutomationClaim {
  claimToken: string;
  runId: string;
  idempotencyKey: string;
  trigger: WorkbenchAutomationTrigger;
  run: WorkbenchAutomationRun;
  automation: WorkbenchAutomation;
  claimedAt: number;
  leaseUntil: number;
}

export type WorkbenchAutomationTrigger = "scheduled" | "manual";
export type WorkbenchAutomationSubmissionStatus = "pending" | "accepted" | "failed" | "unconfirmed";
export type WorkbenchAutomationExecutionStatus = "not_started" | "running" | "completed" | "failed" | "unconfirmed";

export interface WorkbenchAutomationRun {
  id: string;
  automationId: string;
  idempotencyKey: string;
  trigger: WorkbenchAutomationTrigger;
  submissionStatus: WorkbenchAutomationSubmissionStatus;
  executionStatus: WorkbenchAutomationExecutionStatus;
  scheduledFor: number | null;
  taskTarget?: WorkbenchTarget;
  executionTarget?: WorkbenchTarget;
  executionId?: string;
  queueMessageId?: string;
  submissionError?: string;
  executionError?: string;
  startedAt: number;
  submissionFinishedAt?: number;
  executionFinishedAt?: number;
}

export interface NewWorkbenchMachineProfile {
  name: string;
  url?: string;
}

export type WorkbenchMachineProfilePatch = Partial<{
  name: string;
  url: string | null;
}>;

export interface WorkbenchMachineProfile {
  id: string;
  name: string;
  kind: "local" | "remote";
  url?: string;
  execution: "local" | "metadata-only";
  createdAt: number;
  updatedAt: number;
}

export type WorkbenchPendingActionType = "approval" | "question";
export type WorkbenchPendingActionStatus = "pending" | "resolved" | "expired";

export interface NewWorkbenchPendingAction {
  runId: string;
  requestId: string;
  target: WorkbenchTarget;
  type: WorkbenchPendingActionType;
  payload: Record<string, unknown>;
  expiresAt?: number;
}

export interface WorkbenchPendingAction {
  id: string;
  runId: string;
  requestId: string;
  target: WorkbenchTarget;
  type: WorkbenchPendingActionType;
  payload: Record<string, unknown>;
  status: WorkbenchPendingActionStatus;
  response?: unknown;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workbench_preferences (
  target_key TEXT PRIMARY KEY,
  target_json TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  tags_json TEXT NOT NULL DEFAULT '[]',
  unread INTEGER NOT NULL DEFAULT 0 CHECK (unread IN (0, 1)),
  keep_attention INTEGER NOT NULL DEFAULT 0 CHECK (keep_attention IN (0, 1)),
  title TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_templates (
  template_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  project_key TEXT,
  model TEXT,
  reasoning_effort TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_queue_messages (
  queue_id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  target_json TEXT NOT NULL,
  text TEXT NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unconfirmed')),
  error TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  finished_at INTEGER,
  UNIQUE (target_key, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workbench_notifications (
  notification_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  target_key TEXT NOT NULL,
  target_json TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('completion', 'failure', 'action')),
  title TEXT NOT NULL,
  body TEXT,
  route TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER
);

CREATE TABLE IF NOT EXISTS workbench_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completion INTEGER NOT NULL CHECK (completion IN (0, 1)),
  failure INTEGER NOT NULL CHECK (failure IN (0, 1)),
  action INTEGER NOT NULL CHECK (action IN (0, 1)),
  system INTEGER NOT NULL CHECK (system IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_automations (
  automation_id TEXT PRIMARY KEY,
  target_key TEXT,
  target_json TEXT,
  project_key TEXT,
  prompt TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 525600),
  time_zone TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((target_key IS NOT NULL AND target_json IS NOT NULL AND project_key IS NULL)
      OR (target_key IS NULL AND target_json IS NULL AND project_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS workbench_automation_runs (
  run_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  submission_status TEXT NOT NULL CHECK (submission_status IN ('pending', 'accepted', 'failed', 'unconfirmed')),
  execution_status TEXT NOT NULL CHECK (execution_status IN ('not_started', 'running', 'completed', 'failed', 'unconfirmed')),
  scheduled_for INTEGER,
  task_target_key TEXT,
  task_target_json TEXT,
  execution_target_key TEXT,
  execution_target_json TEXT,
  execution_id TEXT,
  queue_message_id TEXT,
  submission_error TEXT,
  execution_error TEXT,
  started_at INTEGER NOT NULL,
  submission_finished_at INTEGER,
  execution_finished_at INTEGER,
  UNIQUE (automation_id, idempotency_key),
  UNIQUE (automation_id, scheduled_for),
  CHECK ((task_target_key IS NULL AND task_target_json IS NULL)
      OR (task_target_key IS NOT NULL AND task_target_json IS NOT NULL)),
  CHECK ((execution_target_key IS NULL AND execution_target_json IS NULL)
      OR (execution_target_key IS NOT NULL AND execution_target_json IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS workbench_automation_claims (
  claim_token TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL UNIQUE REFERENCES workbench_automations(automation_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  claimed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_machine_profiles (
  profile_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
  url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'local' AND profile_id = 'local' AND url IS NULL)
      OR (kind = 'remote' AND profile_id <> 'local'))
);

CREATE TABLE IF NOT EXISTS workbench_pending_actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_json TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('approval', 'question')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'expired')),
  response_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (run_id, request_id)
);

CREATE TABLE IF NOT EXISTS workbench_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

const INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_workbench_templates_updated ON workbench_templates(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbench_queue_order ON workbench_queue_messages(target_key, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_workbench_queue_claim ON workbench_queue_messages(target_key, status, sort_order);
CREATE INDEX IF NOT EXISTS idx_workbench_notifications_created ON workbench_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbench_automations_due ON workbench_automations(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_workbench_automation_runs_recent ON workbench_automation_runs(automation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbench_automation_runs_key ON workbench_automation_runs(automation_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workbench_automation_runs_schedule
  ON workbench_automation_runs(automation_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workbench_automation_runs_execution
  ON workbench_automation_runs(execution_target_key, execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workbench_automation_claim_expiry ON workbench_automation_claims(lease_until);
CREATE INDEX IF NOT EXISTS idx_workbench_actions_status_expiry ON workbench_pending_actions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_workbench_actions_target ON workbench_pending_actions(target_key, created_at DESC);
`;

const WORKBENCH_SCHEMA_VERSION = 1;

const MAX_TARGET_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 20_000;
const MAX_COMPOSER_TEXT_LENGTH = 8_000;
const MAX_TITLE_LENGTH = 160;
const MAX_TAG_LENGTH = 40;
const MAX_TAG_COUNT = 20;
const MAX_MODEL_LENGTH = 160;
const MAX_PROJECT_KEY_LENGTH = 120;
const MAX_ERROR_LENGTH = 2_000;
const MAX_NOTIFICATION_LIST_LIMIT = 500;
const MAX_AUTOMATION_CLAIM_LIMIT = 500;
const MAX_AUTOMATION_LEASE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ACTION_TTL_MS = 15 * 60 * 1_000;
let savepointSequence = 0;

type SqlRow = Record<string, unknown>;

function automationQueueIdempotencyKey(runId: string): string {
  return `automation:${runId}`;
}

function legacySubmissionStatus(status: "accepted" | "failed" | "unconfirmed"): "succeeded" | "failed" | "unconfirmed" {
  return status === "accepted" ? "succeeded" : status;
}

export function parseWorkbenchTarget(value: unknown): WorkbenchTarget {
  const target = asRecord(value, "target");
  assertOnlyKeys(target, ["kind", "id", "source", "homeId"], "target");
  const id = normalizeIdentifier(target.id, "target.id", MAX_TARGET_ID_LENGTH);
  if (target.kind === "task") {
    if (target.homeId !== undefined) throw new Error("Task targets cannot include homeId.");
    const source = target.source === undefined ? undefined : normalizeEnum(target.source, ["desk", "direct", "aamp"], "target.source");
    return { kind: "task", id, ...(source ? { source } : {}) };
  }
  if (target.kind === "history") {
    if (target.source !== undefined) throw new Error("History targets cannot include source.");
    const homeId = target.homeId === undefined ? undefined : normalizeIdentifier(target.homeId, "target.homeId", MAX_TARGET_ID_LENGTH);
    return { kind: "history", id, ...(homeId ? { homeId } : {}) };
  }
  throw new Error("target.kind must be 'task' or 'history'.");
}

export function workbenchTargetKey(target: WorkbenchTarget): string {
  const normalized = parseWorkbenchTarget(target);
  return JSON.stringify([
    normalized.kind,
    normalized.kind === "task" ? normalized.source ?? null : null,
    normalized.kind === "history" ? normalized.homeId ?? null : null,
    normalized.id,
  ]);
}

export function parseWorkbenchTargetKey(value: string): WorkbenchTarget {
  if (typeof value !== "string") throw new Error("target key must be a string.");
  const tuple = parseJson(value, "target key");
  if (!Array.isArray(tuple) || tuple.length !== 4) throw new Error("target key is malformed.");
  let target: WorkbenchTarget;
  if (tuple[0] === "task") {
    if (tuple[2] !== null) throw new Error("Task target key contains a history home.");
    target = parseWorkbenchTarget({ kind: "task", source: tuple[1] ?? undefined, id: tuple[3] });
  } else if (tuple[0] === "history") {
    if (tuple[1] !== null) throw new Error("History target key contains a task source.");
    target = parseWorkbenchTarget({ kind: "history", homeId: tuple[2] ?? undefined, id: tuple[3] });
  } else {
    throw new Error("target key has an unknown target kind.");
  }
  if (workbenchTargetKey(target) !== value) throw new Error("target key is not canonical.");
  return target;
}

export function workbenchTargetRoute(target: WorkbenchTarget): string {
  const normalized = parseWorkbenchTarget(target);
  if (normalized.kind === "task") {
    return normalized.source
      ? `/tasks/${normalized.source}/${encodeURIComponent(normalized.id)}`
      : "/";
  }
  return normalized.homeId
    ? `/codex-history/${encodeURIComponent(normalized.homeId)}/${encodeURIComponent(normalized.id)}`
    : "/codex-history";
}

export class WorkbenchStore {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly legacyAutomationRunStatus: boolean;

  constructor(db: SqliteDatabase, now: () => number = () => Date.now()) {
    this.db = db;
    this.now = now;
    this.db.exec(SCHEMA);
    const timestamp = this.timestamp();
    this.legacyAutomationRunStatus = migrateWorkbenchSchema(this.db, timestamp);
    this.db.exec(INDEX_SCHEMA);
    this.db.prepare(`INSERT OR IGNORE INTO workbench_settings
      (id, completion, failure, action, system, updated_at) VALUES (1, 1, 1, 1, 0, ?)`)
      .run(timestamp);
    this.db.prepare(`INSERT OR IGNORE INTO workbench_machine_profiles
      (profile_id, name, kind, url, created_at, updated_at) VALUES ('local', 'Local Bridge host', 'local', NULL, ?, ?)`)
      .run(timestamp, timestamp);
  }

  public getPreferences(target: WorkbenchTarget): WorkbenchPreferences {
    const normalized = parseWorkbenchTarget(target);
    const row = this.db.prepare("SELECT * FROM workbench_preferences WHERE target_key = ?")
      .get(workbenchTargetKey(normalized)) as SqlRow | undefined;
    return row ? mapPreferences(row) : defaultPreferences(normalized);
  }

  public updatePreferences(target: WorkbenchTarget, patch: WorkbenchPreferencePatch): WorkbenchPreferences {
    const normalized = parseWorkbenchTarget(target);
    const input = asRecord(patch, "preference patch");
    assertOnlyKeys(input, ["pinned", "tags", "unread", "keepAttention", "title"], "preference patch");
    const current = this.getPreferences(normalized);
    const pinned = input.pinned === undefined ? current.pinned : requireBoolean(input.pinned, "pinned");
    const unread = input.unread === undefined ? current.unread : requireBoolean(input.unread, "unread");
    const keepAttention = input.keepAttention === undefined ? current.keepAttention : requireBoolean(input.keepAttention, "keepAttention");
    const tags = input.tags === undefined ? current.tags : normalizeTags(input.tags);
    const title = input.title === undefined ? current.title ?? null : normalizeNullableText(input.title, "title", MAX_TITLE_LENGTH);
    const timestamp = this.timestamp();
    this.db.prepare(`INSERT INTO workbench_preferences
      (target_key, target_json, pinned, tags_json, unread, keep_attention, title, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_key) DO UPDATE SET target_json=excluded.target_json, pinned=excluded.pinned,
        tags_json=excluded.tags_json, unread=excluded.unread, keep_attention=excluded.keep_attention,
        title=excluded.title, updated_at=excluded.updated_at`)
      .run(workbenchTargetKey(normalized), JSON.stringify(normalized), Number(pinned), JSON.stringify(tags), Number(unread), Number(keepAttention), title, timestamp);
    return this.getPreferences(normalized);
  }

  public listPreferences(): WorkbenchPreferences[] {
    const rows = this.db.prepare("SELECT * FROM workbench_preferences ORDER BY updated_at DESC, target_key ASC")
      .all() as SqlRow[];
    return rows.map(mapPreferences);
  }

  public listTemplates(): WorkbenchTemplate[] {
    const rows = this.db.prepare("SELECT * FROM workbench_templates ORDER BY updated_at DESC, template_id ASC")
      .all() as SqlRow[];
    return rows.map(mapTemplate);
  }

  public createTemplate(input: NewWorkbenchTemplate): WorkbenchTemplate {
    const value = asRecord(input, "template");
    assertOnlyKeys(value, ["title", "text", "projectKey", "model", "reasoningEffort"], "template");
    const title = normalizeText(value.title, "title", MAX_TITLE_LENGTH);
    const text = normalizeText(value.text, "text", MAX_TEXT_LENGTH);
    const projectKey = value.projectKey === undefined ? null : this.normalizeAvailableProjectKey(value.projectKey);
    const model = normalizeOptionalModel(value.model, "model");
    const reasoningEffort = normalizeOptionalReasoningEffort(value.reasoningEffort);
    const id = randomUUID();
    const timestamp = this.timestamp();
    this.db.prepare(`INSERT INTO workbench_templates
      (template_id, title, text, project_key, model, reasoning_effort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, title, text, projectKey, model, reasoningEffort, timestamp, timestamp);
    return this.getTemplate(id);
  }

  public updateTemplate(id: string, patch: WorkbenchTemplatePatch): WorkbenchTemplate {
    const templateId = normalizeIdentifier(id, "template id", MAX_TARGET_ID_LENGTH);
    const input = asRecord(patch, "template patch");
    assertOnlyKeys(input, ["title", "text", "projectKey", "model", "reasoningEffort"], "template patch");
    const current = this.getTemplate(templateId);
    const title = input.title === undefined ? current.title : normalizeText(input.title, "title", MAX_TITLE_LENGTH);
    const text = input.text === undefined ? current.text : normalizeText(input.text, "text", MAX_TEXT_LENGTH);
    const projectKey = input.projectKey === undefined
      ? current.projectKey ?? null
      : input.projectKey === null ? null : this.normalizeAvailableProjectKey(input.projectKey);
    const model = input.model === undefined ? current.model ?? null : normalizeOptionalModel(input.model, "model");
    const reasoningEffort = input.reasoningEffort === undefined
      ? current.reasoningEffort ?? null
      : normalizeOptionalReasoningEffort(input.reasoningEffort);
    this.db.prepare(`UPDATE workbench_templates SET title=?, text=?, project_key=?, model=?, reasoning_effort=?, updated_at=?
      WHERE template_id=?`).run(title, text, projectKey, model, reasoningEffort, this.timestamp(), templateId);
    return this.getTemplate(templateId);
  }

  public deleteTemplate(id: string): boolean {
    const templateId = normalizeIdentifier(id, "template id", MAX_TARGET_ID_LENGTH);
    const exists = this.db.prepare("SELECT 1 AS present FROM workbench_templates WHERE template_id=?")
      .get(templateId) as SqlRow | undefined;
    if (!exists) return false;
    this.db.prepare("DELETE FROM workbench_templates WHERE template_id=?").run(templateId);
    return true;
  }

  public listQueueMessages(target: WorkbenchTarget): WorkbenchQueueMessage[] {
    const normalized = parseWorkbenchTarget(target);
    const rows = this.db.prepare(`SELECT * FROM workbench_queue_messages WHERE target_key=?
      ORDER BY sort_order ASC, created_at ASC, queue_id ASC`).all(workbenchTargetKey(normalized)) as SqlRow[];
    return rows.map(mapQueueMessage);
  }

  public listQueueTargets(): WorkbenchQueueTarget[] {
    const rows = this.db.prepare(`SELECT target_key, target_json,
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending_count,
      SUM(CASE WHEN status IN ('failed', 'unconfirmed') THEN 1 ELSE 0 END) AS uncertain_count,
      MAX(updated_at) AS latest_updated_at
      FROM workbench_queue_messages GROUP BY target_key ORDER BY latest_updated_at DESC, target_key ASC`).all() as SqlRow[];
    return rows.map((row) => {
      const target = parseStoredTarget(row.target_json, "queue target");
      if (workbenchTargetKey(target) !== String(row.target_key)) throw new Error("Stored queue target key does not match its target.");
      return {
        target,
        queuedCount: asNumber(row.queued_count),
        sendingCount: asNumber(row.sending_count),
        uncertainCount: asNumber(row.uncertain_count),
        latestUpdatedAt: asNumber(row.latest_updated_at),
      };
    });
  }

  public getQueueMessage(id: string): WorkbenchQueueMessage | null {
    const queueId = normalizeIdentifier(id, "queue message id", MAX_TARGET_ID_LENGTH);
    const row = this.db.prepare("SELECT * FROM workbench_queue_messages WHERE queue_id=?").get(queueId) as SqlRow | undefined;
    return row ? mapQueueMessage(row) : null;
  }

  public markStaleQueueMessagesUnconfirmed(before: number): number {
    const threshold = requireTimestamp(before, "before");
    if (!this.db.prepare(`SELECT 1 FROM workbench_queue_messages
      WHERE status='sending' AND claimed_at IS NOT NULL AND claimed_at<? LIMIT 1`).get(threshold)) return 0;
    return Number(this.db.prepare(`UPDATE workbench_queue_messages SET status='unconfirmed',
      error='Delivery status is unknown after the sending claim became stale.', finished_at=?, updated_at=?
      WHERE status='sending' AND claimed_at IS NOT NULL AND claimed_at<?`)
      .run(this.timestamp(), this.timestamp(), threshold).changes);
  }

  public enqueueQueueMessage(target: WorkbenchTarget, input: NewWorkbenchQueueMessage): WorkbenchQueueMessage {
    const normalized = parseWorkbenchTarget(target);
    const value = asRecord(input, "queue message");
    assertOnlyKeys(value, ["idempotencyKey", "text", "model", "reasoningEffort"], "queue message");
    const idempotencyKey = normalizeIdentifier(value.idempotencyKey, "idempotencyKey", 200);
    const text = normalizeText(value.text, "text", MAX_COMPOSER_TEXT_LENGTH);
    const model = normalizeOptionalModel(value.model, "model");
    const reasoningEffort = normalizeOptionalReasoningEffort(value.reasoningEffort);
    const targetKey = workbenchTargetKey(normalized);
    const existing = this.findQueueMessageByIdempotencyKey(targetKey, idempotencyKey);
    if (existing) return assertQueueIdempotency(existing, { text, model, reasoningEffort });
    const id = randomUUID();
    const timestamp = this.timestamp();
    withSavepoint(this.db, () => {
      this.db.prepare(`INSERT INTO workbench_queue_messages
        (queue_id, target_key, target_json, text, model, reasoning_effort, idempotency_key, status,
         error, sort_order, created_at, updated_at, claimed_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL,
          COALESCE((SELECT MAX(sort_order) + 1024 FROM workbench_queue_messages WHERE target_key=?), 0),
          ?, ?, NULL, NULL)
        ON CONFLICT(target_key, idempotency_key) DO NOTHING`)
        .run(id, targetKey, JSON.stringify(normalized), text, model, reasoningEffort, idempotencyKey, targetKey, timestamp, timestamp);
    });
    const insertedOrExisting = this.findQueueMessageByIdempotencyKey(targetKey, idempotencyKey);
    if (!insertedOrExisting) throw new Error("Queue message could not be stored.");
    return assertQueueIdempotency(insertedOrExisting, { text, model, reasoningEffort });
  }

  public updateQueueMessage(target: WorkbenchTarget, id: string, patch: WorkbenchQueueMessagePatch): WorkbenchQueueMessage {
    const normalized = parseWorkbenchTarget(target);
    const queueId = normalizeIdentifier(id, "queue message id", MAX_TARGET_ID_LENGTH);
    const input = asRecord(patch, "queue message patch");
    assertOnlyKeys(input, ["text", "model", "reasoningEffort"], "queue message patch");
    const current = this.requireQueueMessage(normalized, queueId);
    if (current.status !== "queued") throw new Error("Only queued messages can be edited.");
    const text = input.text === undefined ? current.text : normalizeText(input.text, "text", MAX_COMPOSER_TEXT_LENGTH);
    const model = input.model === undefined ? current.model ?? null : normalizeOptionalModel(input.model, "model");
    const reasoningEffort = input.reasoningEffort === undefined
      ? current.reasoningEffort ?? null
      : normalizeOptionalReasoningEffort(input.reasoningEffort);
    const result = this.db.prepare(`UPDATE workbench_queue_messages SET text=?, model=?, reasoning_effort=?, updated_at=?
      WHERE queue_id=? AND target_key=? AND status='queued'`)
      .run(text, model, reasoningEffort, this.timestamp(), queueId, workbenchTargetKey(normalized));
    if (Number(result.changes) !== 1) throw new Error("Only queued messages can be edited.");
    return this.requireQueueMessage(normalized, queueId);
  }

  public removeQueueMessage(target: WorkbenchTarget, id: string): boolean {
    const normalized = parseWorkbenchTarget(target);
    const queueId = normalizeIdentifier(id, "queue message id", MAX_TARGET_ID_LENGTH);
    const current = this.findQueueMessageById(workbenchTargetKey(normalized), queueId);
    if (!current) return false;
    if (current.status !== "queued") throw new Error("Only queued messages can be removed.");
    const result = this.db.prepare("DELETE FROM workbench_queue_messages WHERE queue_id=? AND target_key=? AND status='queued'")
      .run(queueId, workbenchTargetKey(normalized));
    if (Number(result.changes) !== 1) throw new Error("Only queued messages can be removed.");
    return true;
  }

  public moveQueueMessage(target: WorkbenchTarget, id: string, toIndex: number): WorkbenchQueueMessage[] {
    const normalized = parseWorkbenchTarget(target);
    const queueId = normalizeIdentifier(id, "queue message id", MAX_TARGET_ID_LENGTH);
    if (!Number.isInteger(toIndex) || toIndex < 0) throw new Error("toIndex must be a non-negative integer.");
    const targetKey = workbenchTargetKey(normalized);
    return withSavepoint(this.db, () => {
      this.db.prepare(`UPDATE workbench_queue_messages SET sort_order=sort_order
        WHERE target_key=? AND status='queued'`).run(targetKey);
      const rows = this.db.prepare(`SELECT queue_id FROM workbench_queue_messages
        WHERE target_key=? AND status='queued' ORDER BY sort_order, created_at, queue_id`).all(targetKey) as SqlRow[];
      const ids = rows.map((row) => String(row.queue_id));
      const oldIndex = ids.indexOf(queueId);
      if (oldIndex < 0) {
        const found = this.findQueueMessageById(targetKey, queueId);
        if (found) throw new Error("Only queued messages can be moved.");
        throw new Error("Queue message was not found for this target.");
      }
      if (toIndex >= ids.length) throw new Error("toIndex is outside the queued message list.");
      ids.splice(oldIndex, 1);
      ids.splice(toIndex, 0, queueId);
      const update = this.db.prepare("UPDATE workbench_queue_messages SET sort_order=?, updated_at=? WHERE queue_id=? AND target_key=? AND status='queued'");
      ids.forEach((itemId, index) => update.run((index + 1) * 1024, this.timestamp(), itemId, targetKey));
      return this.listQueueMessages(normalized);
    });
  }

  public claimNextQueueMessage(target: WorkbenchTarget): WorkbenchQueueMessage | null {
    const normalized = parseWorkbenchTarget(target);
    const targetKey = workbenchTargetKey(normalized);
    return withSavepoint(this.db, () => {
      // The no-op write acquires SQLite's writer lock before selecting, including with a deferred outer savepoint.
      this.db.prepare(`UPDATE workbench_queue_messages SET sort_order=sort_order
        WHERE target_key=? AND status='queued'`).run(targetKey);
      const sending = this.db.prepare(`SELECT 1 AS present FROM workbench_queue_messages
        WHERE target_key=? AND status='sending' LIMIT 1`).get(targetKey) as SqlRow | undefined;
      if (sending) return null;
      const row = this.db.prepare(`SELECT queue_id FROM workbench_queue_messages
        WHERE target_key=? AND status='queued' ORDER BY sort_order, created_at, queue_id LIMIT 1`).get(targetKey) as SqlRow | undefined;
      if (!row) return null;
      const id = String(row.queue_id);
      const claimResult = this.db.prepare(`UPDATE workbench_queue_messages SET status='sending', claimed_at=?, updated_at=?
        WHERE queue_id=? AND target_key=? AND status='queued'`).run(this.timestamp(), this.timestamp(), id, targetKey);
      if (Number(claimResult.changes) !== 1) return null;
      return this.requireQueueMessage(normalized, id);
    });
  }

  public finishQueueMessage(
    target: WorkbenchTarget,
    id: string,
    result: { status: "sent" | "failed" | "unconfirmed"; error?: string },
  ): WorkbenchQueueMessage {
    const normalized = parseWorkbenchTarget(target);
    const queueId = normalizeIdentifier(id, "queue message id", MAX_TARGET_ID_LENGTH);
    const input = asRecord(result, "queue result");
    assertOnlyKeys(input, ["status", "error"], "queue result");
    const status = normalizeEnum(input.status, ["sent", "failed", "unconfirmed"], "queue result status");
    const error = input.error === undefined ? null : normalizeText(input.error, "error", MAX_ERROR_LENGTH);
    const current = this.requireQueueMessage(normalized, queueId);
    if (current.status !== "sending") throw new Error("Only sending messages can be finished.");
    const timestamp = this.timestamp();
    const updateResult = this.db.prepare(`UPDATE workbench_queue_messages SET status=?, error=?, finished_at=?, updated_at=?
      WHERE queue_id=? AND target_key=? AND status='sending'`)
      .run(status, status === "sent" ? null : error, timestamp, timestamp, queueId, workbenchTargetKey(normalized));
    if (Number(updateResult.changes) !== 1) throw new Error("Only sending messages can be finished.");
    return this.requireQueueMessage(normalized, queueId);
  }

  public listNotifications(options: { limit?: number; includeDismissed?: boolean } = {}): WorkbenchNotification[] {
    const value = asRecord(options, "notification options");
    assertOnlyKeys(value, ["limit", "includeDismissed"], "notification options");
    const limit = value.limit === undefined ? 100 : requireInteger(value.limit, "limit", 1, MAX_NOTIFICATION_LIST_LIMIT);
    const includeDismissed = value.includeDismissed === undefined ? false : requireBoolean(value.includeDismissed, "includeDismissed");
    const rows = this.db.prepare(`SELECT * FROM workbench_notifications
      ${includeDismissed ? "" : "WHERE dismissed_at IS NULL"}
      ORDER BY created_at DESC, notification_id DESC LIMIT ?`).all(limit) as SqlRow[];
    return rows.map(mapNotification);
  }

  public hasNotification(eventKey: string): boolean {
    const key = normalizeIdentifier(eventKey, "eventKey", 512);
    return Boolean(this.db.prepare(`SELECT 1 AS present FROM workbench_notifications
      WHERE event_key=? LIMIT 1`).get(key));
  }

  public recordNotification(input: NewWorkbenchNotification): WorkbenchNotification {
    const value = asRecord(input, "notification");
    assertOnlyKeys(value, ["eventKey", "target", "category", "title", "body"], "notification");
    const eventKey = normalizeIdentifier(value.eventKey, "eventKey", 512);
    const target = parseWorkbenchTarget(value.target);
    const category = normalizeEnum(value.category, ["completion", "failure", "action"], "category");
    const title = normalizeText(value.title, "title", MAX_TITLE_LENGTH);
    const body = value.body === undefined ? null : normalizeText(value.body, "body", 2_000);
    const route = workbenchTargetRoute(target);
    const id = randomUUID();
    const timestamp = this.timestamp();
    this.db.prepare(`INSERT INTO workbench_notifications
      (notification_id, event_key, target_key, target_json, category, title, body, route, created_at, dismissed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(event_key) DO NOTHING`)
      .run(id, eventKey, workbenchTargetKey(target), JSON.stringify(target), category, title, body, route, timestamp);
    const row = this.db.prepare("SELECT * FROM workbench_notifications WHERE event_key=?").get(eventKey) as SqlRow | undefined;
    if (!row) throw new Error("Notification could not be stored.");
    const stored = mapNotification(row);
    if (stored.target && (workbenchTargetKey(stored.target) !== workbenchTargetKey(target)
      || stored.category !== category || stored.title !== title || (stored.body ?? null) !== body)) {
      throw new Error("eventKey is already associated with different notification content.");
    }
    return stored;
  }

  public dismissNotification(id: string): WorkbenchNotification | null {
    const notificationId = normalizeIdentifier(id, "notification id", MAX_TARGET_ID_LENGTH);
    const row = this.db.prepare("SELECT * FROM workbench_notifications WHERE notification_id=?")
      .get(notificationId) as SqlRow | undefined;
    if (!row) return null;
    if (row.dismissed_at === null || row.dismissed_at === undefined) {
      this.db.prepare("UPDATE workbench_notifications SET dismissed_at=? WHERE notification_id=? AND dismissed_at IS NULL")
        .run(this.timestamp(), notificationId);
    }
    return this.getNotification(notificationId);
  }

  public getNotificationSettings(): WorkbenchNotificationSettings {
    const row = this.db.prepare("SELECT * FROM workbench_settings WHERE id=1").get() as SqlRow | undefined;
    if (!row) throw new Error("Workbench notification settings row is missing.");
    return mapSettings(row);
  }

  public updateNotificationSettings(patch: Partial<WorkbenchNotificationSettings>): WorkbenchNotificationSettings {
    const input = asRecord(patch, "notification settings patch");
    assertOnlyKeys(input, ["completion", "failure", "action", "system"], "notification settings patch");
    const current = this.getNotificationSettings();
    const next = {
      completion: input.completion === undefined ? current.completion : requireBoolean(input.completion, "completion"),
      failure: input.failure === undefined ? current.failure : requireBoolean(input.failure, "failure"),
      action: input.action === undefined ? current.action : requireBoolean(input.action, "action"),
      system: input.system === undefined ? current.system : requireBoolean(input.system, "system"),
    };
    this.db.prepare(`UPDATE workbench_settings SET completion=?, failure=?, action=?, system=?, updated_at=? WHERE id=1`)
      .run(Number(next.completion), Number(next.failure), Number(next.action), Number(next.system), this.timestamp());
    return this.getNotificationSettings();
  }

  public listAutomations(): WorkbenchAutomation[] {
    const rows = this.db.prepare("SELECT * FROM workbench_automations ORDER BY updated_at DESC, automation_id ASC")
      .all() as SqlRow[];
    return rows.map(mapAutomation);
  }

  public createAutomation(input: NewWorkbenchAutomation): WorkbenchAutomation {
    const value = asRecord(input, "automation");
    assertOnlyKeys(value, ["target", "projectKey", "prompt", "intervalMinutes", "timeZone", "enabled", "nextRunAt"], "automation");
    const reference = this.normalizeAutomationReference(value.target, value.projectKey);
    const prompt = normalizeText(value.prompt, "prompt", MAX_TEXT_LENGTH);
    const intervalMinutes = normalizeInterval(value.intervalMinutes);
    const timeZone = normalizeTimeZone(value.timeZone);
    const enabled = requireBoolean(value.enabled, "enabled");
    const timestamp = this.timestamp();
    const nextRunAt = value.nextRunAt === undefined
      ? timestamp + intervalMinutes * 60_000
      : value.nextRunAt === null ? null : requireTimestamp(value.nextRunAt, "nextRunAt");
    const id = randomUUID();
    this.db.prepare(`INSERT INTO workbench_automations
      (automation_id, target_key, target_json, project_key, prompt, interval_minutes, time_zone, enabled,
       next_run_at, last_run_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
      .run(id, reference.target ? workbenchTargetKey(reference.target) : null,
        reference.target ? JSON.stringify(reference.target) : null, reference.projectKey ?? null,
        prompt, intervalMinutes, timeZone, Number(enabled), nextRunAt, timestamp, timestamp);
    return this.getAutomation(id);
  }

  public updateAutomation(id: string, patch: WorkbenchAutomationPatch): WorkbenchAutomation {
    const automationId = normalizeIdentifier(id, "automation id", MAX_TARGET_ID_LENGTH);
    const value = asRecord(patch, "automation patch");
    assertOnlyKeys(value, ["target", "projectKey", "prompt", "intervalMinutes", "timeZone", "enabled", "nextRunAt"], "automation patch");
    const current = this.getAutomation(automationId);
    const targetInput = value.target !== undefined
      ? value.target === null ? null : parseWorkbenchTarget(value.target)
      : value.projectKey !== undefined && value.projectKey !== null ? null : current.target ?? null;
    const projectKeyInput = value.projectKey !== undefined
      ? value.projectKey === null ? null : this.normalizeAvailableProjectKey(value.projectKey)
      : value.target !== undefined && value.target !== null ? null : current.projectKey ?? null;
    const reference = this.normalizeAutomationReference(targetInput, projectKeyInput);
    const prompt = value.prompt === undefined ? current.prompt : normalizeText(value.prompt, "prompt", MAX_TEXT_LENGTH);
    const intervalMinutes = value.intervalMinutes === undefined ? current.intervalMinutes : normalizeInterval(value.intervalMinutes);
    const timeZone = value.timeZone === undefined ? current.timeZone : normalizeTimeZone(value.timeZone);
    const enabled = value.enabled === undefined ? current.enabled : requireBoolean(value.enabled, "enabled");
    const nextRunAt = value.nextRunAt === undefined
      ? value.intervalMinutes === undefined ? current.nextRunAt : this.timestamp() + intervalMinutes * 60_000
      : value.nextRunAt === null ? null : requireTimestamp(value.nextRunAt, "nextRunAt");
    this.db.prepare(`UPDATE workbench_automations SET target_key=?, target_json=?, project_key=?, prompt=?,
      interval_minutes=?, time_zone=?, enabled=?, next_run_at=?, updated_at=? WHERE automation_id=?`)
      .run(reference.target ? workbenchTargetKey(reference.target) : null,
        reference.target ? JSON.stringify(reference.target) : null, reference.projectKey ?? null, prompt,
        intervalMinutes, timeZone, Number(enabled), nextRunAt, this.timestamp(), automationId);
    return this.getAutomation(automationId);
  }

  public deleteAutomation(id: string): boolean {
    const automationId = normalizeIdentifier(id, "automation id", MAX_TARGET_ID_LENGTH);
    const exists = this.db.prepare("SELECT 1 AS present FROM workbench_automations WHERE automation_id=?")
      .get(automationId) as SqlRow | undefined;
    if (!exists) return false;
    withSavepoint(this.db, () => {
      const timestamp = this.timestamp();
      const claims = this.db.prepare("SELECT run_id FROM workbench_automation_claims WHERE automation_id=?")
        .all(automationId) as SqlRow[];
      const mark = this.db.prepare(`UPDATE workbench_automation_runs SET submission_status='unconfirmed',
        execution_status='unconfirmed', submission_error='Automation was deleted while scheduler submission was unresolved.', submission_finished_at=?
        WHERE run_id=? AND submission_status='pending'`);
      for (const claim of claims) {
        const runId = String(claim.run_id);
        mark.run(timestamp, runId);
        this.setLegacyAutomationRunStatus(runId, "unconfirmed");
      }
      this.db.prepare("DELETE FROM workbench_automation_claims WHERE automation_id=?").run(automationId);
      this.db.prepare("DELETE FROM workbench_automations WHERE automation_id=?").run(automationId);
    });
    return true;
  }

  public claimDueAutomations(limit = 10, leaseMs = 60_000): WorkbenchAutomationClaim[] {
    const claimLimit = requireInteger(limit, "limit", 1, MAX_AUTOMATION_CLAIM_LIMIT);
    const leaseDuration = requireInteger(leaseMs, "leaseMs", 1_000, MAX_AUTOMATION_LEASE_MS);
    const timestamp = this.timestamp();
    // Idle ticks must remain reads: even an UPDATE affecting zero rows needs the SQLite writer lock.
    const expiredClaim = this.db.prepare("SELECT 1 FROM workbench_automation_claims WHERE lease_until<=? LIMIT 1").get(timestamp);
    const dueAutomation = this.db.prepare(`SELECT 1 FROM workbench_automations
      WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
        AND NOT EXISTS (SELECT 1 FROM workbench_automation_claims c WHERE c.automation_id=workbench_automations.automation_id)
        AND NOT EXISTS (SELECT 1 FROM workbench_automation_runs r
          WHERE r.automation_id=workbench_automations.automation_id AND r.scheduled_for=workbench_automations.next_run_at)
      LIMIT 1`).get(timestamp);
    if (!expiredClaim && !dueAutomation) return [];
    return withSavepoint(this.db, () => {
      this.db.prepare(`UPDATE workbench_automation_claims SET lease_until=lease_until WHERE lease_until<=?`).run(timestamp);
      this.recoverExpiredAutomationClaims(timestamp);
      const due = this.db.prepare(`SELECT automation_id FROM workbench_automations
        WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
          AND NOT EXISTS (SELECT 1 FROM workbench_automation_claims c WHERE c.automation_id=workbench_automations.automation_id)
          AND NOT EXISTS (SELECT 1 FROM workbench_automation_runs r
            WHERE r.automation_id=workbench_automations.automation_id AND r.scheduled_for=workbench_automations.next_run_at)
        ORDER BY next_run_at ASC, automation_id ASC LIMIT ?`).all(timestamp, claimLimit) as SqlRow[];
      const claims: WorkbenchAutomationClaim[] = [];
      for (const row of due) {
        const automationId = String(row.automation_id);
        const automation = this.getAutomation(automationId);
        if (automation.nextRunAt === null) continue;
        // Reserve the (automation, scheduledAt) slot before publishing its claim.
        // The unique slot remains after lease expiry, so this tick can never auto-replay.
        claims.push(this.createAutomationClaim(
          automationId,
          `scheduled:${automation.nextRunAt}`,
          "scheduled",
          automation.nextRunAt,
          timestamp,
          leaseDuration,
        ));
      }
      return claims;
    });
  }

  public claimAutomation(id: string, idempotencyKey: string = randomUUID(), leaseMs = 60_000): WorkbenchAutomationClaim {
    const automationId = normalizeIdentifier(id, "automation id", MAX_TARGET_ID_LENGTH);
    const key = normalizeIdentifier(idempotencyKey, "idempotencyKey", 512);
    const leaseDuration = requireInteger(leaseMs, "leaseMs", 1_000, MAX_AUTOMATION_LEASE_MS);
    const timestamp = this.timestamp();
    return withSavepoint(this.db, () => {
      this.db.prepare("UPDATE workbench_automations SET updated_at=updated_at WHERE automation_id=?")
        .run(automationId);
      this.recoverExpiredAutomationClaims(timestamp, automationId);
      const current = this.db.prepare("SELECT * FROM workbench_automation_claims WHERE automation_id=?")
        .get(automationId) as SqlRow | undefined;
      if (current) {
        if (String(current.idempotency_key) === key) return this.mapAutomationClaim(current);
        throw new Error("Automation already has an active claim.");
      }
      const existingRun = this.db.prepare(`SELECT 1 AS present FROM workbench_automation_runs
        WHERE automation_id=? AND idempotency_key=?`).get(automationId, key) as SqlRow | undefined;
      if (existingRun) throw new Error("idempotencyKey has already been used for this automation.");
      return this.createAutomationClaim(automationId, key, "manual", null, timestamp, leaseDuration);
    });
  }

  public listAutomationRuns(automationId: string, limit = 50): WorkbenchAutomationRun[] {
    const id = normalizeIdentifier(automationId, "automation id", MAX_TARGET_ID_LENGTH);
    const boundedLimit = requireInteger(limit, "limit", 1, MAX_NOTIFICATION_LIST_LIMIT);
    const rows = this.db.prepare(`SELECT * FROM workbench_automation_runs WHERE automation_id=?
      ORDER BY started_at DESC, run_id DESC LIMIT ?`).all(id, boundedLimit) as SqlRow[];
    return rows.map(mapAutomationRun);
  }

  public findAutomationRunByExecution(target: WorkbenchTarget, executionId: string): WorkbenchAutomationRun | null {
    const normalized = parseWorkbenchTarget(target);
    const id = normalizeIdentifier(executionId, "executionId", MAX_TARGET_ID_LENGTH);
    const row = this.db.prepare(`SELECT * FROM workbench_automation_runs
      WHERE execution_target_key=? AND execution_id=? ORDER BY started_at DESC LIMIT 1`)
      .get(workbenchTargetKey(normalized), id) as SqlRow | undefined;
    return row ? mapAutomationRun(row) : null;
  }

  public finishAutomationClaim(
    claimToken: string,
    result: { status?: "accepted" | "failed" | "unconfirmed"; taskTarget?: WorkbenchTarget; error?: string } = {},
  ): WorkbenchAutomation {
    const token = normalizeIdentifier(claimToken, "claimToken", MAX_TARGET_ID_LENGTH);
    const input = asRecord(result, "automation result");
    assertOnlyKeys(input, ["status", "taskTarget", "error"], "automation result");
    const status = input.status === undefined ? "accepted" : normalizeEnum(input.status, ["accepted", "failed", "unconfirmed"], "automation result status");
    const taskTarget = input.taskTarget === undefined ? undefined : parseWorkbenchTarget(input.taskTarget);
    if (taskTarget && taskTarget.kind !== "task") throw new Error("taskTarget must be a task target.");
    const error = input.error === undefined ? null : normalizeText(input.error, "error", MAX_ERROR_LENGTH);
    const timestamp = this.timestamp();
    let expired = false;
    const automation = withSavepoint(this.db, () => {
      this.db.prepare("UPDATE workbench_automation_claims SET claim_token=claim_token WHERE claim_token=?").run(token);
      const claim = this.db.prepare("SELECT * FROM workbench_automation_claims WHERE claim_token=?")
        .get(token) as SqlRow | undefined;
      if (!claim) throw new Error("Automation claim was not found or has already been finished.");
      if (asNumber(claim.lease_until) <= timestamp) {
        this.recoverExpiredAutomationClaims(timestamp, String(claim.automation_id));
        expired = true;
        return null;
      }
      const automationId = String(claim.automation_id);
      const runId = String(claim.run_id);
      const automation = this.getAutomation(automationId);
      const nextRunAt = timestamp + automation.intervalMinutes * 60_000;
      const executionTarget = status === "failed" ? undefined : taskTarget ?? automation.target;
      const matchingQueue = executionTarget
        ? this.db.prepare(`SELECT queue_id FROM workbench_queue_messages
          WHERE target_key=? AND idempotency_key=?`).get(workbenchTargetKey(executionTarget), automationQueueIdempotencyKey(String(claim.run_id))) as SqlRow | undefined
        : undefined;
      const runUpdate = this.db.prepare(`UPDATE workbench_automation_runs SET submission_status=?,
        execution_status=?, task_target_key=?, task_target_json=?, execution_target_key=?, execution_target_json=?,
        queue_message_id=?, submission_error=?, submission_finished_at=?
        WHERE run_id=? AND submission_status='pending'`)
        .run(status, status === "accepted" ? taskTarget ? "running" : "not_started" : status === "unconfirmed" ? "unconfirmed" : "not_started",
            taskTarget ? workbenchTargetKey(taskTarget) : null, taskTarget ? JSON.stringify(taskTarget) : null,
            executionTarget ? workbenchTargetKey(executionTarget) : null, executionTarget ? JSON.stringify(executionTarget) : null,
            matchingQueue ? String(matchingQueue.queue_id) : null,
            status === "accepted" ? null : error ?? (status === "failed" ? "Scheduler submission failed." : "Scheduler submission status is unknown."),
            timestamp, runId);
      let actualStatus = status;
      if (Number(runUpdate.changes) !== 1) {
        const run = this.db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(runId) as SqlRow | undefined;
        if (!run || mapAutomationRun(run).submissionStatus !== "accepted") {
          throw new Error("Automation run submission was already finalized differently.");
        }
        actualStatus = "accepted";
      }
      this.setLegacyAutomationRunStatus(runId, legacySubmissionStatus(actualStatus));
      this.db.prepare(`UPDATE workbench_automations SET last_run_at=?, next_run_at=?, last_error=?, updated_at=?
        WHERE automation_id=?`).run(timestamp, nextRunAt,
        actualStatus === "failed" || actualStatus === "unconfirmed"
          ? error ?? (actualStatus === "failed" ? "Scheduler submission failed." : "Scheduler submission status is unknown.") : null,
        timestamp, automationId);
      this.db.prepare("DELETE FROM workbench_automation_claims WHERE claim_token=?").run(token);
      return this.getAutomation(automationId);
    });
    if (expired) throw new Error("Automation claim lease has expired; its scheduled tick was marked unconfirmed.");
    if (!automation) throw new Error("Automation claim could not be finished.");
    return automation;
  }

  public linkAutomationRun(runId: string, target: WorkbenchTarget, executionId: string): WorkbenchAutomationRun {
    const id = normalizeIdentifier(runId, "run id", MAX_TARGET_ID_LENGTH);
    const normalizedTarget = parseWorkbenchTarget(target);
    const normalizedExecutionId = normalizeIdentifier(executionId, "executionId", MAX_TARGET_ID_LENGTH);
    return withSavepoint(this.db, () => {
      this.db.prepare("UPDATE workbench_automation_runs SET run_id=run_id WHERE run_id=?").run(id);
      const row = this.db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(id) as SqlRow | undefined;
      if (!row) throw new Error("Automation run was not found.");
      const current = mapAutomationRun(row);
      if (!["pending", "accepted", "unconfirmed"].includes(current.submissionStatus)) {
        throw new Error("Automation run cannot link an execution after a failed scheduler submission.");
      }
      if (current.executionStatus === "completed" || current.executionStatus === "failed") {
        if (current.executionId === normalizedExecutionId && current.executionTarget
          && workbenchTargetKey(current.executionTarget) === workbenchTargetKey(normalizedTarget)) return current;
        throw new Error("Automation run execution has already finished.");
      }
      if (current.executionTarget && workbenchTargetKey(current.executionTarget) !== workbenchTargetKey(normalizedTarget)) {
        throw new Error("Execution target does not match the accepted automation target.");
      }
      if (current.executionId && current.executionId !== normalizedExecutionId) {
        throw new Error("Automation run is already linked to a different execution.");
      }
      const matchingQueue = this.db.prepare(`SELECT queue_id FROM workbench_queue_messages
        WHERE target_key=? AND idempotency_key=?`).get(workbenchTargetKey(normalizedTarget), automationQueueIdempotencyKey(current.id)) as SqlRow | undefined;
      this.db.prepare(`UPDATE workbench_automation_runs SET submission_status='accepted', submission_error=NULL,
        submission_finished_at=COALESCE(submission_finished_at, ?), execution_status='running',
        execution_target_key=?, execution_target_json=?, execution_id=?, queue_message_id=COALESCE(?, queue_message_id)
        WHERE run_id=? AND submission_status IN ('pending', 'accepted', 'unconfirmed')
          AND execution_status IN ('not_started', 'running', 'unconfirmed')`)
        .run(this.timestamp(), workbenchTargetKey(normalizedTarget), JSON.stringify(normalizedTarget), normalizedExecutionId,
          matchingQueue ? String(matchingQueue.queue_id) : null, id);
      if (normalizedTarget.kind === "task") {
        this.db.prepare(`UPDATE workbench_automation_runs SET task_target_key=?, task_target_json=?
          WHERE run_id=? AND task_target_key IS NULL`)
          .run(workbenchTargetKey(normalizedTarget), JSON.stringify(normalizedTarget), id);
      }
      this.setLegacyAutomationRunStatus(id, "succeeded");
      const updated = this.db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(id) as SqlRow;
      return mapAutomationRun(updated);
    });
  }

  public completeAutomationRun(
    runId: string,
    result: { status: "completed" | "failed"; taskTarget?: WorkbenchTarget; error?: string },
  ): WorkbenchAutomationRun {
    const id = normalizeIdentifier(runId, "run id", MAX_TARGET_ID_LENGTH);
    const input = asRecord(result, "automation execution result");
    assertOnlyKeys(input, ["status", "taskTarget", "error"], "automation execution result");
    const status = normalizeEnum(input.status, ["completed", "failed"], "automation execution status");
    const taskTarget = input.taskTarget === undefined ? undefined : parseWorkbenchTarget(input.taskTarget);
    if (taskTarget && taskTarget.kind !== "task") throw new Error("taskTarget must be a task target.");
    const error = input.error === undefined ? null : normalizeText(input.error, "error", MAX_ERROR_LENGTH);
    const timestamp = this.timestamp();
    return withSavepoint(this.db, () => {
      this.db.prepare("UPDATE workbench_automation_runs SET run_id=run_id WHERE run_id=?").run(id);
      const current = this.db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?")
        .get(id) as SqlRow | undefined;
      if (!current) throw new Error("Automation run was not found.");
      const existing = mapAutomationRun(current);
      if (existing.executionStatus === "completed" || existing.executionStatus === "failed") {
        const sameTarget = taskTarget === undefined || (existing.taskTarget !== undefined
          && workbenchTargetKey(existing.taskTarget) === workbenchTargetKey(taskTarget));
        if (existing.executionStatus === status && sameTarget
          && (existing.executionError ?? null) === (status === "failed" ? error ?? "Automation execution failed." : null)) return existing;
        throw new Error("Automation run execution has already been completed differently.");
      }
      if (existing.submissionStatus !== "accepted" && existing.submissionStatus !== "unconfirmed") {
        throw new Error("Automation execution cannot finish before scheduler submission is accepted or unconfirmed.");
      }
      const finalTarget = taskTarget ?? existing.taskTarget;
      const executionError = status === "failed" ? error ?? "Automation execution failed." : null;
      this.db.prepare(`UPDATE workbench_automation_runs SET execution_status=?, task_target_key=?, task_target_json=?,
        execution_error=?, execution_finished_at=? WHERE run_id=?`)
        .run(status, finalTarget ? workbenchTargetKey(finalTarget) : null, finalTarget ? JSON.stringify(finalTarget) : null,
          executionError, timestamp, id);
      this.setLegacyAutomationRunStatus(id, status === "completed" ? "succeeded" : "failed");
      this.db.prepare("UPDATE workbench_automations SET last_error=?, updated_at=? WHERE automation_id=?")
        .run(executionError, timestamp, existing.automationId);
      const updated = this.db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(id) as SqlRow;
      return mapAutomationRun(updated);
    });
  }

  public releaseAutomationClaim(claimToken: string): boolean {
    const token = normalizeIdentifier(claimToken, "claimToken", MAX_TARGET_ID_LENGTH);
    const timestamp = this.timestamp();
    return withSavepoint(this.db, () => {
      this.db.prepare("UPDATE workbench_automation_claims SET claim_token=claim_token WHERE claim_token=?").run(token);
      const claim = this.db.prepare("SELECT * FROM workbench_automation_claims WHERE claim_token=?")
        .get(token) as SqlRow | undefined;
      if (!claim) return false;
      const automationId = String(claim.automation_id);
      const runId = String(claim.run_id);
      const run = this.db.prepare("SELECT submission_status FROM workbench_automation_runs WHERE run_id=?")
        .get(runId) as SqlRow | undefined;
      const pending = run?.submission_status === "pending";
      if (pending) {
        this.db.prepare(`UPDATE workbench_automation_runs SET submission_status='unconfirmed',
        execution_status='unconfirmed', submission_error='Automation claim was released before submission was confirmed.',
        submission_finished_at=? WHERE run_id=? AND submission_status='pending'`).run(timestamp, runId);
        this.setLegacyAutomationRunStatus(runId, "unconfirmed");
      }
      const automation = this.getAutomation(automationId);
      if (String(claim.trigger) === "scheduled") {
        this.db.prepare(`UPDATE workbench_automations SET last_run_at=?, next_run_at=?,
          last_error=?, updated_at=? WHERE automation_id=?`)
          .run(timestamp, timestamp + automation.intervalMinutes * 60_000,
            pending ? "Automation tick was released with an unknown submission outcome." : null, timestamp, automationId);
      }
      this.db.prepare("DELETE FROM workbench_automation_claims WHERE claim_token=?").run(token);
      return true;
    });
  }

  private createAutomationClaim(
    automationId: string,
    idempotencyKey: string,
    trigger: WorkbenchAutomationTrigger,
    scheduledFor: number | null,
    timestamp: number,
    leaseMs: number,
  ): WorkbenchAutomationClaim {
    const automation = this.getAutomation(automationId);
    const runId = randomUUID();
    const claimToken = randomUUID();
    const runColumns = [
      "run_id", "automation_id", "idempotency_key", "trigger", "submission_status", "execution_status",
      "scheduled_for", "task_target_key", "task_target_json", "submission_error", "execution_error",
      "started_at", "submission_finished_at", "execution_finished_at",
    ];
    const runValues: (string | number | null)[] = [
      runId, automationId, idempotencyKey, trigger, "pending", "not_started", scheduledFor,
      null, null, null, null, timestamp, null, null,
    ];
    if (this.legacyAutomationRunStatus) {
      runColumns.push("status");
      runValues.push("running");
    }
    this.db.prepare(`INSERT INTO workbench_automation_runs (${runColumns.join(", ")})
      VALUES (${runColumns.map(() => "?").join(", ")})`).run(...runValues);
    this.db.prepare(`INSERT INTO workbench_automation_claims
      (claim_token, automation_id, run_id, idempotency_key, trigger, claimed_at, lease_until)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(claimToken, automationId, runId, idempotencyKey, trigger, timestamp, timestamp + leaseMs);
    const runRow = this.db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(runId) as SqlRow;
    return {
      claimToken,
      runId,
      idempotencyKey,
      trigger,
      run: mapAutomationRun(runRow),
      automation,
      claimedAt: timestamp,
      leaseUntil: timestamp + leaseMs,
    };
  }

  private mapAutomationClaim(row: SqlRow): WorkbenchAutomationClaim {
    const runId = String(row.run_id);
    const automationId = String(row.automation_id);
    const runRow = this.db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(runId) as SqlRow | undefined;
    if (!runRow) throw new Error("Stored automation claim references a missing run.");
    return {
      claimToken: String(row.claim_token),
      runId,
      idempotencyKey: String(row.idempotency_key),
      trigger: normalizeEnum(row.trigger, ["scheduled", "manual"], "stored claim trigger"),
      run: mapAutomationRun(runRow),
      automation: this.getAutomation(automationId),
      claimedAt: asNumber(row.claimed_at),
      leaseUntil: asNumber(row.lease_until),
    };
  }

  private recoverExpiredAutomationClaims(timestamp: number, automationId?: string): void {
    const claims = this.db.prepare(`SELECT * FROM workbench_automation_claims
      WHERE lease_until<=? ${automationId ? "AND automation_id=?" : ""}`)
      .all(...(automationId ? [timestamp, automationId] : [timestamp])) as SqlRow[];
    const updateRun = this.db.prepare(`UPDATE workbench_automation_runs SET submission_status='unconfirmed',
      execution_status='unconfirmed', submission_error='Claim lease expired before scheduler submission was confirmed.',
      submission_finished_at=? WHERE run_id=? AND submission_status='pending'`);
    for (const claim of claims) {
      const currentAutomationId = String(claim.automation_id);
      const runId = String(claim.run_id);
      const run = this.db.prepare("SELECT submission_status FROM workbench_automation_runs WHERE run_id=?")
        .get(runId) as SqlRow | undefined;
      const pending = run?.submission_status === "pending";
      if (pending) {
        updateRun.run(timestamp, runId);
        this.setLegacyAutomationRunStatus(runId, "unconfirmed");
      }
      const automation = this.getAutomation(currentAutomationId);
      if (String(claim.trigger) === "scheduled") {
        this.db.prepare(`UPDATE workbench_automations SET last_run_at=?, next_run_at=?,
          last_error=?, updated_at=? WHERE automation_id=?`)
          .run(timestamp, timestamp + automation.intervalMinutes * 60_000,
            pending ? "Automation tick has an unconfirmed scheduler submission." : null, timestamp, currentAutomationId);
      } else {
        this.db.prepare("UPDATE workbench_automations SET last_error=?, updated_at=? WHERE automation_id=?")
          .run(pending ? "Manual run submission is unconfirmed." : null, timestamp, currentAutomationId);
      }
      this.db.prepare("DELETE FROM workbench_automation_claims WHERE claim_token=?").run(String(claim.claim_token));
    }
  }

  public listMachineProfiles(): WorkbenchMachineProfile[] {
    const rows = this.db.prepare(`SELECT * FROM workbench_machine_profiles
      ORDER BY CASE kind WHEN 'local' THEN 0 ELSE 1 END, name COLLATE NOCASE, profile_id`).all() as SqlRow[];
    return rows.map(mapMachineProfile);
  }

  public createMachineProfile(input: NewWorkbenchMachineProfile): WorkbenchMachineProfile {
    const value = asRecord(input, "machine profile");
    assertOnlyKeys(value, ["name", "url"], "machine profile");
    const name = normalizeText(value.name, "name", MAX_TITLE_LENGTH);
    const url = value.url === undefined ? null : normalizeRemoteUrl(value.url);
    const id = randomUUID();
    const timestamp = this.timestamp();
    this.db.prepare(`INSERT INTO workbench_machine_profiles
      (profile_id, name, kind, url, created_at, updated_at) VALUES (?, ?, 'remote', ?, ?, ?)`)
      .run(id, name, url, timestamp, timestamp);
    return this.getMachineProfile(id);
  }

  public updateMachineProfile(id: string, patch: WorkbenchMachineProfilePatch): WorkbenchMachineProfile {
    const profileId = normalizeIdentifier(id, "machine profile id", MAX_TARGET_ID_LENGTH);
    const value = asRecord(patch, "machine profile patch");
    assertOnlyKeys(value, ["name", "url"], "machine profile patch");
    const current = this.getMachineProfile(profileId);
    const name = value.name === undefined ? current.name : normalizeText(value.name, "name", MAX_TITLE_LENGTH);
    let url: string | null;
    if (current.kind === "local") {
      if (value.url !== undefined && value.url !== null) throw new Error("The local machine profile cannot have a URL.");
      url = null;
    } else {
      url = value.url === undefined ? current.url ?? null : value.url === null ? null : normalizeRemoteUrl(value.url);
    }
    this.db.prepare("UPDATE workbench_machine_profiles SET name=?, url=?, updated_at=? WHERE profile_id=?")
      .run(name, url ?? null, this.timestamp(), profileId);
    return this.getMachineProfile(profileId);
  }

  public deleteMachineProfile(id: string): boolean {
    const profileId = normalizeIdentifier(id, "machine profile id", MAX_TARGET_ID_LENGTH);
    if (profileId === "local") return false;
    const exists = this.db.prepare("SELECT 1 AS present FROM workbench_machine_profiles WHERE profile_id=?")
      .get(profileId) as SqlRow | undefined;
    if (!exists) return false;
    this.db.prepare("DELETE FROM workbench_machine_profiles WHERE profile_id=?").run(profileId);
    return true;
  }

  public recordPendingAction(input: NewWorkbenchPendingAction): WorkbenchPendingAction {
    const value = asRecord(input, "pending action");
    assertOnlyKeys(value, ["runId", "requestId", "target", "type", "payload", "expiresAt"], "pending action");
    const runId = normalizeIdentifier(value.runId, "runId", MAX_TARGET_ID_LENGTH);
    const requestId = normalizeIdentifier(value.requestId, "requestId", MAX_TARGET_ID_LENGTH);
    const target = parseWorkbenchTarget(value.target);
    const type = normalizeEnum(value.type, ["approval", "question"], "type");
    const payload = requireJsonRecord(value.payload, "payload");
    const payloadJson = stringifyJson(payload, "payload");
    const timestamp = this.timestamp();
    const previous = this.db.prepare("SELECT * FROM workbench_pending_actions WHERE run_id=? AND request_id=?")
      .get(runId, requestId) as SqlRow | undefined;
    const expiresAt = value.expiresAt === undefined
      ? previous ? asNumber(previous.expires_at) : timestamp + DEFAULT_ACTION_TTL_MS
      : requireTimestamp(value.expiresAt, "expiresAt");
    const id = randomUUID();
    if (!previous) this.db.prepare(`INSERT INTO workbench_pending_actions
      (action_id, run_id, request_id, target_key, target_json, type, payload_json, status,
       response_json, created_at, expires_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(run_id, request_id) DO NOTHING`)
      .run(id, runId, requestId, workbenchTargetKey(target), JSON.stringify(target), type, payloadJson,
        expiresAt <= timestamp ? "expired" : "pending", timestamp, expiresAt, expiresAt <= timestamp ? timestamp : null);
    const row = previous ?? this.db.prepare("SELECT * FROM workbench_pending_actions WHERE run_id=? AND request_id=?")
      .get(runId, requestId) as SqlRow | undefined;
    if (!row) throw new Error("Pending action could not be stored.");
    const stored = mapPendingAction(row);
    if (stored.target && (workbenchTargetKey(stored.target) !== workbenchTargetKey(target)
      || stored.type !== type || stringifyJson(stored.payload, "stored payload") !== payloadJson
      || (value.expiresAt !== undefined && stored.expiresAt !== expiresAt))) {
      throw new Error("runId/requestId is already associated with a different pending action.");
    }
    return stored;
  }

  public listPendingActions(options: {
    target?: WorkbenchTarget;
    statuses?: WorkbenchPendingActionStatus[];
  } = {}): WorkbenchPendingAction[] {
    const value = asRecord(options, "pending action options");
    assertOnlyKeys(value, ["target", "statuses"], "pending action options");
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (value.target !== undefined) {
      const target = parseWorkbenchTarget(value.target);
      clauses.push("target_key=?");
      parameters.push(workbenchTargetKey(target));
    }
    if (value.statuses !== undefined) {
      if (!Array.isArray(value.statuses)) throw new Error("statuses must be an array.");
      const statuses = [...new Set(value.statuses.map((status) => normalizeEnum(status, ["pending", "resolved", "expired"], "status")))];
      if (statuses.length === 0) return [];
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    }
    const rows = this.db.prepare(`SELECT * FROM workbench_pending_actions
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, action_id DESC`).all(...parameters) as SqlRow[];
    return rows.map(mapPendingAction);
  }

  public resolvePendingAction(id: string, response: unknown): WorkbenchPendingAction {
    const actionId = normalizeIdentifier(id, "pending action id", MAX_TARGET_ID_LENGTH);
    const responseJson = stringifyJson(response, "response");
    const timestamp = this.timestamp();
    let expired = false;
    const resolved = withSavepoint(this.db, () => {
      this.db.prepare("UPDATE workbench_pending_actions SET action_id=action_id WHERE action_id=?").run(actionId);
      const row = this.db.prepare("SELECT * FROM workbench_pending_actions WHERE action_id=?")
        .get(actionId) as SqlRow | undefined;
      if (!row) throw new Error("Pending action was not found.");
      if (row.status !== "pending") throw new Error("Pending action has already been resolved or expired.");
      if (asNumber(row.expires_at) <= timestamp) {
        this.db.prepare("UPDATE workbench_pending_actions SET status='expired', resolved_at=? WHERE action_id=? AND status='pending'")
          .run(timestamp, actionId);
        expired = true;
        return null;
      }
      const result = this.db.prepare(`UPDATE workbench_pending_actions SET status='resolved', response_json=?, resolved_at=?
        WHERE action_id=? AND status='pending' AND expires_at>?`).run(responseJson, timestamp, actionId, timestamp);
      if (Number(result.changes) !== 1) throw new Error("Pending action was resolved by another request.");
      return this.getPendingAction(actionId);
    });
    if (expired) throw new Error("Pending action has expired.");
    if (!resolved) throw new Error("Pending action could not be resolved.");
    return resolved;
  }

  public expirePendingActions(at?: number): number {
    const timestamp = at === undefined ? this.timestamp() : requireTimestamp(at, "at");
    if (!this.db.prepare(`SELECT 1 FROM workbench_pending_actions
      WHERE status='pending' AND expires_at<=? LIMIT 1`).get(timestamp)) return 0;
    return Number(this.db.prepare(`UPDATE workbench_pending_actions SET status='expired', resolved_at=?
      WHERE status='pending' AND expires_at<=?`).run(timestamp, timestamp).changes);
  }

  public expirePendingAction(id: string): WorkbenchPendingAction | null {
    const actionId = normalizeIdentifier(id, "pending action id", MAX_TARGET_ID_LENGTH);
    const timestamp = this.timestamp();
    return withSavepoint(this.db, () => {
      this.db.prepare("UPDATE workbench_pending_actions SET action_id=action_id WHERE action_id=?").run(actionId);
      const current = this.db.prepare("SELECT status FROM workbench_pending_actions WHERE action_id=?")
        .get(actionId) as SqlRow | undefined;
      if (!current) return null;
      if (current.status === "pending") {
        const result = this.db.prepare(`UPDATE workbench_pending_actions SET status='expired', resolved_at=?
          WHERE action_id=? AND status='pending'`).run(timestamp, actionId);
        if (Number(result.changes) !== 1) throw new Error("Pending action changed while it was being expired.");
      }
      return this.getPendingAction(actionId);
    });
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Workbench clock must return a non-negative epoch millisecond integer.");
    return value;
  }

  private getTemplate(id: string): WorkbenchTemplate {
    const row = this.db.prepare("SELECT * FROM workbench_templates WHERE template_id=?").get(id) as SqlRow | undefined;
    if (!row) throw new Error("Template was not found.");
    return mapTemplate(row);
  }

  private findQueueMessageByIdempotencyKey(targetKey: string, idempotencyKey: string): WorkbenchQueueMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM workbench_queue_messages
      WHERE target_key=? AND idempotency_key=?`).get(targetKey, idempotencyKey) as SqlRow | undefined;
    return row ? mapQueueMessage(row) : undefined;
  }

  private findQueueMessageById(targetKey: string, id: string): WorkbenchQueueMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM workbench_queue_messages
      WHERE target_key=? AND queue_id=?`).get(targetKey, id) as SqlRow | undefined;
    return row ? mapQueueMessage(row) : undefined;
  }

  private requireQueueMessage(target: WorkbenchTarget, id: string): WorkbenchQueueMessage {
    const row = this.db.prepare("SELECT * FROM workbench_queue_messages WHERE queue_id=? AND target_key=?")
      .get(id, workbenchTargetKey(target)) as SqlRow | undefined;
    if (!row) throw new Error("Queue message was not found for this target.");
    return mapQueueMessage(row);
  }

  private getNotification(id: string): WorkbenchNotification {
    const row = this.db.prepare("SELECT * FROM workbench_notifications WHERE notification_id=?").get(id) as SqlRow | undefined;
    if (!row) throw new Error("Notification was not found.");
    return mapNotification(row);
  }

  private getAutomation(id: string): WorkbenchAutomation {
    const row = this.db.prepare("SELECT * FROM workbench_automations WHERE automation_id=?").get(id) as SqlRow | undefined;
    if (!row) throw new Error("Automation was not found.");
    return mapAutomation(row);
  }

  private normalizeAvailableProjectKey(value: unknown): string {
    const projectKey = normalizeIdentifier(value, "projectKey", MAX_PROJECT_KEY_LENGTH);
    const table = this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='projects'")
      .get() as SqlRow | undefined;
    if (!table) throw new Error("The registered project table is unavailable.");
    const project = this.db.prepare("SELECT 1 AS present FROM projects WHERE name=? AND status='available'")
      .get(projectKey) as SqlRow | undefined;
    if (!project) throw new Error("projectKey must identify an available registered project.");
    return projectKey;
  }

  private normalizeAutomationReference(targetValue: unknown, projectKeyValue: unknown): { target?: WorkbenchTarget; projectKey?: string } {
    const hasTarget = targetValue !== undefined && targetValue !== null;
    const hasProjectKey = projectKeyValue !== undefined && projectKeyValue !== null;
    if (hasTarget === hasProjectKey) throw new Error("Automation must reference exactly one target or projectKey.");
    if (hasTarget) return { target: parseWorkbenchTarget(targetValue) };
    return { projectKey: this.normalizeAvailableProjectKey(projectKeyValue) };
  }

  private getMachineProfile(id: string): WorkbenchMachineProfile {
    const row = this.db.prepare("SELECT * FROM workbench_machine_profiles WHERE profile_id=?").get(id) as SqlRow | undefined;
    if (!row) throw new Error("Machine profile was not found.");
    return mapMachineProfile(row);
  }

  private getPendingAction(id: string): WorkbenchPendingAction {
    const row = this.db.prepare("SELECT * FROM workbench_pending_actions WHERE action_id=?").get(id) as SqlRow | undefined;
    if (!row) throw new Error("Pending action was not found.");
    return mapPendingAction(row);
  }

  private setLegacyAutomationRunStatus(id: string, status: "running" | "succeeded" | "failed" | "unconfirmed"): void {
    if (!this.legacyAutomationRunStatus) return;
    this.db.prepare("UPDATE workbench_automation_runs SET status=? WHERE run_id=?").run(status, id);
  }
}

function migrateWorkbenchSchema(db: SqliteDatabase, timestamp: number): boolean {
  const originalRunColumns = sqliteTableColumns(db, "workbench_automation_runs");
  const originalClaimColumns = sqliteTableColumns(db, "workbench_automation_claims");
  const hasLegacyStatus = originalRunColumns.has("status");
  const runColumnsNeeded = [
    "idempotency_key", "trigger", "submission_status", "execution_status", "scheduled_for",
    "task_target_key", "task_target_json", "execution_target_key", "execution_target_json",
    "execution_id", "queue_message_id", "submission_error", "execution_error", "started_at",
    "submission_finished_at", "execution_finished_at",
  ];
  const claimColumnsNeeded = ["run_id", "idempotency_key", "trigger"];
  const migrationNeeded = hasLegacyStatus
    || runColumnsNeeded.some((column) => !originalRunColumns.has(column))
    || claimColumnsNeeded.some((column) => !originalClaimColumns.has(column));
  const migrationVersionRow = db.prepare("SELECT MAX(version) AS version FROM workbench_schema_migrations").get() as SqlRow | undefined;
  const migrationVersion = migrationVersionRow?.version == null ? 0 : asNumber(migrationVersionRow.version);

  withSavepoint(db, () => {
    const columns = sqliteTableColumns(db, "workbench_automation_runs");
    const runAdditions: Array<[string, string]> = [
      ["idempotency_key", "TEXT NOT NULL DEFAULT ''"],
      ["trigger", "TEXT NOT NULL DEFAULT 'scheduled'"],
      ["submission_status", "TEXT NOT NULL DEFAULT 'unconfirmed'"],
      ["execution_status", "TEXT NOT NULL DEFAULT 'unconfirmed'"],
      ["scheduled_for", "INTEGER"],
      ["task_target_key", "TEXT"],
      ["task_target_json", "TEXT"],
      ["execution_target_key", "TEXT"],
      ["execution_target_json", "TEXT"],
      ["execution_id", "TEXT"],
      ["queue_message_id", "TEXT"],
      ["submission_error", "TEXT"],
      ["execution_error", "TEXT"],
      ["started_at", "INTEGER NOT NULL DEFAULT 0"],
      ["submission_finished_at", "INTEGER"],
      ["execution_finished_at", "INTEGER"],
    ];
    for (const [name, definition] of runAdditions) addColumnIfMissing(db, "workbench_automation_runs", columns, name, definition);

    const claims = sqliteTableColumns(db, "workbench_automation_claims");
    addColumnIfMissing(db, "workbench_automation_claims", claims, "run_id", "TEXT");
    addColumnIfMissing(db, "workbench_automation_claims", claims, "idempotency_key", "TEXT");
    addColumnIfMissing(db, "workbench_automation_claims", claims, "trigger", "TEXT NOT NULL DEFAULT 'scheduled'");

    let repairedSlots: Array<{ automationId: string; scheduledFor: number }> = [];
    if (migrationVersion < WORKBENCH_SCHEMA_VERSION && migrationNeeded) {
      if (hasLegacyStatus) migrateLegacyAutomationRunStatuses(db, originalRunColumns);
      repairedSlots = normalizeDuplicateAutomationScheduleSlots(db, timestamp);
      migrateLegacyAutomationClaims(db, timestamp, hasLegacyStatus, originalRunColumns.has("finished_at"));
      advanceLegacyAutomationScheduleSlots(db, timestamp);
    } else {
      repairedSlots = normalizeDuplicateAutomationScheduleSlots(db, timestamp);
      if (repairedSlots.length > 0) advanceLegacyAutomationScheduleSlots(db, timestamp, repairedSlots);
    }
    db.prepare("INSERT OR IGNORE INTO workbench_schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(WORKBENCH_SCHEMA_VERSION, timestamp);
  });
  return hasLegacyStatus;
}

function sqliteTableColumns(db: SqliteDatabase, table: "workbench_automation_runs" | "workbench_automation_claims"): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
  return new Set(rows.map((row) => String(row.name)));
}

function addColumnIfMissing(
  db: SqliteDatabase,
  table: "workbench_automation_runs" | "workbench_automation_claims",
  columns: Set<string>,
  name: string,
  definition: string,
): void {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

function migrateLegacyAutomationRunStatuses(db: SqliteDatabase, columns: Set<string>): void {
  const finishedAt = columns.has("finished_at") ? "finished_at" : "NULL";
  db.exec(`UPDATE workbench_automation_runs SET
    submission_status='unconfirmed',
    execution_status='unconfirmed',
    submission_error=COALESCE(submission_error, 'Legacy run state cannot distinguish scheduler acceptance from Codex completion.'),
    submission_finished_at=COALESCE(submission_finished_at, ${finishedAt})`);
}

function normalizeDuplicateAutomationScheduleSlots(
  db: SqliteDatabase,
  timestamp: number,
): Array<{ automationId: string; scheduledFor: number }> {
  const duplicates = db.prepare(`SELECT automation_id, scheduled_for FROM workbench_automation_runs
    WHERE scheduled_for IS NOT NULL GROUP BY automation_id, scheduled_for HAVING COUNT(*) > 1`).all() as SqlRow[];
  const list = db.prepare(`SELECT run_id FROM workbench_automation_runs WHERE automation_id=? AND scheduled_for=?
    ORDER BY started_at ASC, run_id ASC`);
  const markDuplicate = db.prepare(`UPDATE workbench_automation_runs SET scheduled_for=NULL,
    submission_status=CASE WHEN submission_status='pending' THEN 'unconfirmed' ELSE submission_status END,
    execution_status=CASE WHEN execution_status IN ('not_started', 'running') THEN 'unconfirmed' ELSE execution_status END,
    submission_error=COALESCE(submission_error, 'Legacy duplicate schedule slot has an unknown outcome.'),
    submission_finished_at=COALESCE(submission_finished_at, ?)
    WHERE run_id=?`);
  for (const duplicate of duplicates) {
    const automationId = String(duplicate.automation_id);
    const scheduledFor = asNumber(duplicate.scheduled_for);
    const rows = list.all(automationId, scheduledFor) as SqlRow[];
    for (const row of rows.slice(1)) markDuplicate.run(timestamp, String(row.run_id));
  }
  return duplicates.map((row) => ({ automationId: String(row.automation_id), scheduledFor: asNumber(row.scheduled_for) }));
}

function migrateLegacyAutomationClaims(
  db: SqliteDatabase,
  timestamp: number,
  legacyStatusColumn: boolean,
  legacyFinishedAtColumn: boolean,
): void {
  const claims = db.prepare("SELECT * FROM workbench_automation_claims ORDER BY claimed_at, claim_token").all() as SqlRow[];
  for (const claim of claims) {
    const automationId = String(claim.automation_id);
    const automation = db.prepare("SELECT * FROM workbench_automations WHERE automation_id=?").get(automationId) as SqlRow | undefined;
    const claimedAt = asNumber(claim.claimed_at);
    const scheduledFor = automation?.next_run_at == null ? claimedAt : asNumber(automation.next_run_at);
    const derivedKey = `scheduled:${scheduledFor}`;
    const existingClaimRunId = claim.run_id == null ? undefined : String(claim.run_id);
    let run = existingClaimRunId
      ? db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(existingClaimRunId) as SqlRow | undefined
      : undefined;
    const oldKey = claim.idempotency_key == null ? derivedKey : String(claim.idempotency_key);
    if (!run) {
      run = db.prepare(`SELECT * FROM workbench_automation_runs
        WHERE automation_id=? AND (scheduled_for=? OR idempotency_key=?)
        ORDER BY CASE WHEN scheduled_for=? THEN 0 ELSE 1 END, started_at, run_id LIMIT 1`)
        .get(automationId, scheduledFor, oldKey, scheduledFor) as SqlRow | undefined;
    }
    if (!run) {
      const runId = randomUUID();
      insertLegacyAutomationRun(db, {
        runId,
        automationId,
        idempotencyKey: derivedKey,
        scheduledFor,
        startedAt: claimedAt,
        finishedAt: timestamp,
        legacyStatusColumn,
        legacyFinishedAtColumn,
      });
      run = db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(runId) as SqlRow;
    } else if (String(run.submission_status) === "pending") {
      db.prepare(`UPDATE workbench_automation_runs SET submission_status='unconfirmed', execution_status='unconfirmed',
        submission_error=COALESCE(submission_error, 'Legacy scheduler claim outcome is unknown.'),
        submission_finished_at=COALESCE(submission_finished_at, ?)
        WHERE run_id=?`).run(timestamp, String(run.run_id));
      if (legacyStatusColumn) db.prepare("UPDATE workbench_automation_runs SET status='unconfirmed' WHERE run_id=?").run(String(run.run_id));
      run = db.prepare("SELECT * FROM workbench_automation_runs WHERE run_id=?").get(String(run.run_id)) as SqlRow;
    }
    const runId = String(run.run_id);
    const trigger = run.trigger === "manual" ? "manual" : "scheduled";
    const idempotencyKey = String(run.idempotency_key || (trigger === "scheduled" ? derivedKey : oldKey));
    const runScheduledFor: number | null = run.scheduled_for == null
      ? trigger === "scheduled" ? scheduledFor : null
      : asNumber(run.scheduled_for);
    db.prepare(`UPDATE workbench_automation_runs SET idempotency_key=?, trigger=?, scheduled_for=COALESCE(scheduled_for, ?)
      WHERE run_id=?`).run(idempotencyKey, trigger, runScheduledFor, runId);
    db.prepare(`UPDATE workbench_automation_claims SET run_id=?, idempotency_key=?, trigger=? WHERE claim_token=?`)
      .run(runId, idempotencyKey, trigger, String(claim.claim_token));
    if (automation && runScheduledFor != null && automation.next_run_at != null
      && asNumber(automation.next_run_at) === asNumber(runScheduledFor)) {
      const intervalMinutes = asNumber(automation.interval_minutes);
      db.prepare(`UPDATE workbench_automations SET last_run_at=?, next_run_at=?,
        last_error=COALESCE(last_error, 'Legacy scheduler claim outcome is unknown.'), updated_at=?
        WHERE automation_id=? AND next_run_at=?`)
        .run(timestamp, timestamp + intervalMinutes * 60_000, timestamp, automationId, asNumber(runScheduledFor));
    }
  }
}

function insertLegacyAutomationRun(
  db: SqliteDatabase,
  input: {
    runId: string;
    automationId: string;
    idempotencyKey: string;
    scheduledFor: number;
    startedAt: number;
    finishedAt: number;
    legacyStatusColumn: boolean;
    legacyFinishedAtColumn: boolean;
  },
): void {
  const columns = [
    "run_id", "automation_id", "idempotency_key", "trigger", "submission_status", "execution_status",
    "scheduled_for", "submission_error", "execution_error", "started_at", "submission_finished_at",
  ];
  const values: (string | number | null)[] = [
    input.runId, input.automationId, input.idempotencyKey, "scheduled", "unconfirmed", "unconfirmed",
    input.scheduledFor, "Legacy scheduler claim outcome is unknown.", null, input.startedAt, input.finishedAt,
  ];
  if (input.legacyStatusColumn) {
    columns.push("status");
    values.push("unconfirmed");
  }
  if (input.legacyFinishedAtColumn) {
    columns.push("finished_at");
    values.push(input.finishedAt);
  }
  db.prepare(`INSERT INTO workbench_automation_runs (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
}

function advanceLegacyAutomationScheduleSlots(
  db: SqliteDatabase,
  timestamp: number,
  slots?: Array<{ automationId: string; scheduledFor: number }>,
): void {
  const rows: Array<{ automation_id: string; scheduled_for: number }> = slots
    ? slots.map((slot) => ({ automation_id: slot.automationId, scheduled_for: slot.scheduledFor }))
    : db.prepare(`SELECT automation_id, scheduled_for FROM workbench_automation_runs
        WHERE scheduled_for IS NOT NULL`).all() as Array<{ automation_id: string; scheduled_for: number }>;
  for (const row of rows) {
    const automationId = row.automation_id;
    const scheduledFor = row.scheduled_for;
    const automation = db.prepare(`SELECT interval_minutes FROM workbench_automations
      WHERE automation_id=? AND next_run_at=?`).get(automationId, scheduledFor) as SqlRow | undefined;
    if (!automation) continue;
    db.prepare(`UPDATE workbench_automations SET last_run_at=?, next_run_at=?,
      last_error=COALESCE(last_error, 'Legacy automation schedule outcome is unknown.'), updated_at=?
      WHERE automation_id=? AND next_run_at=?`)
      .run(timestamp, timestamp + asNumber(automation.interval_minutes) * 60_000, timestamp, automationId, scheduledFor);
  }
}

function withSavepoint<T>(db: SqliteDatabase, callback: () => T): T {
  const name = `workbench_sp_${++savepointSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = callback();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    } finally {
      db.exec(`RELEASE SAVEPOINT ${name}`);
    }
    throw error;
  }
}

function mapPreferences(row: SqlRow): WorkbenchPreferences {
  const target = parseStoredTarget(row.target_json, "preference target");
  if (workbenchTargetKey(target) !== String(row.target_key)) throw new Error("Stored preference target key does not match its target.");
  const tagsValue = parseJson(String(row.tags_json), "preference tags");
  if (!Array.isArray(tagsValue)) throw new Error("Stored preference tags are malformed.");
  const tags = tagsValue.map((tag) => normalizeText(tag, "stored tag", MAX_TAG_LENGTH));
  const title = row.title === null || row.title === undefined ? undefined : normalizeText(row.title, "stored title", MAX_TITLE_LENGTH);
  return {
    target,
    pinned: asBoolean(row.pinned),
    tags,
    unread: asBoolean(row.unread),
    keepAttention: asBoolean(row.keep_attention),
    ...(title ? { title } : {}),
    updatedAt: asNumber(row.updated_at),
  };
}

function defaultPreferences(target: WorkbenchTarget): WorkbenchPreferences {
  return { target, pinned: false, tags: [], unread: false, keepAttention: false, updatedAt: 0 };
}

function mapTemplate(row: SqlRow): WorkbenchTemplate {
  return {
    id: String(row.template_id),
    title: String(row.title),
    text: String(row.text),
    ...(row.project_key == null ? {} : { projectKey: String(row.project_key) }),
    ...(row.model == null ? {} : { model: String(row.model) }),
    ...(row.reasoning_effort == null ? {} : { reasoningEffort: String(row.reasoning_effort) }),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function mapQueueMessage(row: SqlRow): WorkbenchQueueMessage {
  const target = parseStoredTarget(row.target_json, "queue target");
  if (workbenchTargetKey(target) !== String(row.target_key)) throw new Error("Stored queue target key does not match its target.");
  const status = normalizeEnum(row.status, ["queued", "sending", "sent", "failed", "unconfirmed"], "stored queue status");
  return {
    id: String(row.queue_id),
    target,
    text: String(row.text),
    ...(row.model == null ? {} : { model: String(row.model) }),
    ...(row.reasoning_effort == null ? {} : { reasoningEffort: String(row.reasoning_effort) }),
    idempotencyKey: String(row.idempotency_key),
    status,
    ...(row.error == null ? {} : { error: String(row.error) }),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
    ...(row.claimed_at == null ? {} : { claimedAt: asNumber(row.claimed_at) }),
    ...(row.finished_at == null ? {} : { finishedAt: asNumber(row.finished_at) }),
  };
}

function assertQueueIdempotency(
  existing: WorkbenchQueueMessage,
  expected: { text: string; model: string | null; reasoningEffort: string | null },
): WorkbenchQueueMessage {
  if (existing.text !== expected.text || (existing.model ?? null) !== expected.model
    || (existing.reasoningEffort ?? null) !== expected.reasoningEffort) {
    throw new Error("idempotencyKey is already associated with different queue message content.");
  }
  return existing;
}

function mapNotification(row: SqlRow): WorkbenchNotification {
  const target = parseStoredTarget(row.target_json, "notification target");
  if (workbenchTargetKey(target) !== String(row.target_key)) throw new Error("Stored notification target key does not match its target.");
  const route = String(row.route);
  if (route !== workbenchTargetRoute(target)) throw new Error("Stored notification route does not match its target.");
  return {
    id: String(row.notification_id),
    eventKey: String(row.event_key),
    target,
    category: normalizeEnum(row.category, ["completion", "failure", "action"], "stored notification category"),
    title: String(row.title),
    ...(row.body == null ? {} : { body: String(row.body) }),
    route,
    createdAt: asNumber(row.created_at),
    ...(row.dismissed_at == null ? {} : { dismissedAt: asNumber(row.dismissed_at) }),
  };
}

function mapSettings(row: SqlRow): WorkbenchNotificationSettings {
  return {
    completion: asBoolean(row.completion),
    failure: asBoolean(row.failure),
    action: asBoolean(row.action),
    system: asBoolean(row.system),
    updatedAt: asNumber(row.updated_at),
  };
}

function mapAutomation(row: SqlRow): WorkbenchAutomation {
  const target = row.target_json == null ? undefined : parseStoredTarget(row.target_json, "automation target");
  if (target && workbenchTargetKey(target) !== String(row.target_key)) throw new Error("Stored automation target key does not match its target.");
  if ((target === undefined) === (row.project_key == null)) throw new Error("Stored automation must have exactly one target reference.");
  return {
    id: String(row.automation_id),
    ...(target ? { target } : { projectKey: String(row.project_key) }),
    prompt: String(row.prompt),
    intervalMinutes: asNumber(row.interval_minutes),
    timeZone: String(row.time_zone),
    enabled: asBoolean(row.enabled),
    nextRunAt: row.next_run_at == null ? null : asNumber(row.next_run_at),
    lastRunAt: row.last_run_at == null ? null : asNumber(row.last_run_at),
    ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function mapAutomationRun(row: SqlRow): WorkbenchAutomationRun {
  const taskTarget = row.task_target_json == null ? undefined : parseStoredTarget(row.task_target_json, "automation task target");
  const executionTarget = row.execution_target_json == null ? undefined : parseStoredTarget(row.execution_target_json, "automation execution target");
  if (taskTarget && taskTarget.kind !== "task") throw new Error("Stored automation task target is not a task.");
  if (taskTarget && workbenchTargetKey(taskTarget) !== String(row.task_target_key)) {
    throw new Error("Stored automation task target key does not match its target.");
  }
  if ((taskTarget === undefined) !== (row.task_target_key == null && row.task_target_json == null)) {
    throw new Error("Stored automation task target fields are inconsistent.");
  }
  if (executionTarget && workbenchTargetKey(executionTarget) !== String(row.execution_target_key)) {
    throw new Error("Stored automation execution target key does not match its target.");
  }
  if ((executionTarget === undefined) !== (row.execution_target_key == null && row.execution_target_json == null)) {
    throw new Error("Stored automation execution target fields are inconsistent.");
  }
  if (row.execution_id != null && executionTarget === undefined) throw new Error("Stored automation execution id has no target.");
  return {
    id: String(row.run_id),
    automationId: String(row.automation_id),
    idempotencyKey: String(row.idempotency_key),
    trigger: normalizeEnum(row.trigger, ["scheduled", "manual"], "stored automation run trigger"),
    submissionStatus: normalizeEnum(row.submission_status, ["pending", "accepted", "failed", "unconfirmed"], "stored automation submission status"),
    executionStatus: normalizeEnum(row.execution_status, ["not_started", "running", "completed", "failed", "unconfirmed"], "stored automation execution status"),
    scheduledFor: row.scheduled_for == null ? null : asNumber(row.scheduled_for),
    ...(taskTarget ? { taskTarget } : {}),
    ...(executionTarget ? { executionTarget } : {}),
    ...(row.execution_id == null ? {} : { executionId: String(row.execution_id) }),
    ...(row.queue_message_id == null ? {} : { queueMessageId: String(row.queue_message_id) }),
    ...(row.submission_error == null ? {} : { submissionError: String(row.submission_error) }),
    ...(row.execution_error == null ? {} : { executionError: String(row.execution_error) }),
    startedAt: asNumber(row.started_at),
    ...(row.submission_finished_at == null ? {} : { submissionFinishedAt: asNumber(row.submission_finished_at) }),
    ...(row.execution_finished_at == null ? {} : { executionFinishedAt: asNumber(row.execution_finished_at) }),
  };
}

function mapMachineProfile(row: SqlRow): WorkbenchMachineProfile {
  const kind = normalizeEnum(row.kind, ["local", "remote"], "stored machine profile kind");
  if (kind === "local" && String(row.profile_id) !== "local") throw new Error("Stored local machine profile id is invalid.");
  if (kind === "local" && row.url != null) throw new Error("Stored local machine profile cannot contain a URL.");
  const url = row.url == null ? undefined : normalizeRemoteUrl(String(row.url));
  return {
    id: String(row.profile_id),
    name: String(row.name),
    kind,
    ...(url ? { url } : {}),
    execution: kind === "local" ? "local" : "metadata-only",
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function mapPendingAction(row: SqlRow): WorkbenchPendingAction {
  const target = parseStoredTarget(row.target_json, "pending action target");
  if (workbenchTargetKey(target) !== String(row.target_key)) throw new Error("Stored pending action target key does not match its target.");
  const payload = requireJsonRecord(parseJson(String(row.payload_json), "pending action payload"), "stored payload");
  const response = row.response_json == null ? undefined : parseJson(String(row.response_json), "pending action response");
  return {
    id: String(row.action_id),
    runId: String(row.run_id),
    requestId: String(row.request_id),
    target,
    type: normalizeEnum(row.type, ["approval", "question"], "stored pending action type"),
    payload,
    status: normalizeEnum(row.status, ["pending", "resolved", "expired"], "stored pending action status"),
    ...(response === undefined ? {} : { response }),
    createdAt: asNumber(row.created_at),
    expiresAt: asNumber(row.expires_at),
    ...(row.resolved_at == null ? {} : { resolvedAt: asNumber(row.resolved_at) }),
  };
}

function parseStoredTarget(value: unknown, label: string): WorkbenchTarget {
  const parsed = parseJson(String(value), label);
  return parseWorkbenchTarget(parsed);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field '${key}'.`);
  }
}

function normalizeIdentifier(value: unknown, field: string, maxLength: number): string {
  const text = normalizeText(value, field, maxLength);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${field} contains a control character.`);
  return text;
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} cannot be empty.`);
  if (normalized.length > maxLength) throw new Error(`${field} cannot exceed ${maxLength} characters.`);
  if (normalized.includes("\0")) throw new Error(`${field} contains a null character.`);
  return normalized;
}

function normalizeNullableText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  return normalizeText(value, field, maxLength);
}

function normalizeOptionalModel(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null.`);
  if (value.trim() === "") return null;
  return normalizeText(value, field, MAX_MODEL_LENGTH);
}

function normalizeOptionalReasoningEffort(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw new Error("reasoningEffort is invalid.");
  }
  return value;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("tags must be an array.");
  if (value.length > MAX_TAG_COUNT) throw new Error(`tags cannot contain more than ${MAX_TAG_COUNT} items.`);
  const tags = value.map((tag) => normalizeText(tag, "tag", MAX_TAG_LENGTH));
  if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length) throw new Error("tags cannot contain duplicates.");
  return tags;
}

function normalizeEnum<const T extends readonly string[]>(value: unknown, choices: T, field: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${field} is invalid.`);
  return value as T[number];
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

function requireTimestamp(value: unknown, field: string): number {
  return requireInteger(value, field, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeInterval(value: unknown): number {
  return requireInteger(value, "intervalMinutes", 1, 525_600);
}

function normalizeTimeZone(value: unknown): string {
  const timeZone = normalizeText(value, "timeZone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new Error("timeZone must be a valid IANA time zone.");
  }
  return timeZone;
}

function normalizeRemoteUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("url must be a URL string.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be an absolute http or https URL.");
  }
  if (url.username || url.password) throw new Error("url cannot contain credentials.");
  if (url.protocol === "https:") {
    if (!url.hostname || url.hash || url.search) throw new Error("https URL is invalid or contains URL credentials.");
  } else if (url.protocol === "http:") {
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLocalhost = hostname === "localhost" || hostname.endsWith(".localhost");
    const ipv4Parts = hostname.split(".");
    const isIpv4Loopback = ipv4Parts.length === 4 && ipv4Parts[0] === "127"
      && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    const isIpv6Loopback = hostname === "::1";
    if (!(isLocalhost || isIpv4Loopback || isIpv6Loopback) || url.hash || url.search) {
      throw new Error("http URLs are allowed only for loopback hosts and cannot contain URL credentials or fragments.");
    }
  } else {
    throw new Error("url protocol must be https, or http for a loopback host.");
  }
  return url.toString();
}

function requireJsonRecord(value: unknown, label: string): Record<string, unknown> {
  return asRecord(value, label);
}

function stringifyJson(value: unknown, label: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (encoded === undefined) throw new Error(`${label} must be JSON serializable.`);
  return encoded;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains malformed JSON.`);
  }
}

function asNumber(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Stored numeric field is invalid.");
  return number;
}

function asBoolean(value: unknown): boolean {
  if (value === 1 || value === 1n || value === true) return true;
  if (value === 0 || value === 0n || value === false) return false;
  throw new Error("Stored boolean field is invalid.");
}
