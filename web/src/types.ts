export const TASK_STATES = [
  "DISCOVERED",
  "BLOCKED_CONFIG",
  "QUEUED",
  "RUNNING",
  "WAITING_REVIEW",
  "ACCEPTED",
  "FAILED",
  "CANCELED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type TaskOrigin = "feishu" | "web";
export type ExecutionBackend = "codex-sdk";
export type StoredExecutionBackend = ExecutionBackend | "tmux-session";
export type ProjectStatus = "available" | "disabled";

export interface ProjectRecord {
  name: string;
  path: string;
  status: ProjectStatus;
  available: boolean;
  created_at: string;
  updated_at: string;
}

export const CODEX_THREAD_STATUS_TYPES = ["notLoaded", "idle", "active", "systemError"] as const;
export type CodexThreadStatus = (typeof CODEX_THREAD_STATUS_TYPES)[number] | string;

export interface CodexThread {
  id: string;
  sessionId?: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  path?: string | null;
  modelProvider?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  status?: { type?: CodexThreadStatus; [key: string]: unknown };
  source?: unknown;
  threadSource?: unknown;
  cliVersion?: string;
  turns?: unknown[];
  [key: string]: unknown;
}

export interface CodexHistoryHome {
  id: string;
  label: string;
  path: string;
  available: boolean;
  error?: string;
}

export interface CodexHistoryItem {
  home: CodexHistoryHome;
  thread: CodexThread;
  preferredHomeId?: string;
}

export interface CodexHistoryListResponse {
  items: CodexHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  homes: CodexHistoryHome[];
  generatedAt?: string;
  dataSource?: string;
}

export interface CodexUsageRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexUsageLimitBucket {
  limitId?: string | null;
  limitName?: string | null;
  normalModelSlug?: string | null;
  planType?: string | null;
  primary?: CodexUsageRateLimitWindow | null;
  secondary?: CodexUsageRateLimitWindow | null;
  credits?: {
    balance?: string | null;
    hasCredits?: boolean;
    unlimited?: boolean;
  } | null;
  individualLimit?: {
    limit?: string;
    used?: string;
    remainingPercent?: number;
    resetsAt?: number;
  } | null;
  spendControlReached?: boolean | null;
  rateLimitReachedType?: number | string | null;
}

export interface CodexAccountUsageSummary {
  lifetimeTokens?: number | null;
  peakDailyTokens?: number | null;
  longestRunningTurnSec?: number | null;
  currentStreakDays?: number | null;
  longestStreakDays?: number | null;
}

export interface CodexUsageResetCredit {
  id: string;
  resetType?: string;
  status: string;
  grantedAt: number;
  expiresAt?: number | null;
  title?: string | null;
  description?: string | null;
}

export type CodexResetCreditConsumeOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed"
  | "unknown";

export interface CodexUsageAccount {
  homeId: string;
  label: string;
  available: boolean;
  checkedAt: string;
  quota?: {
    ordinaryUsageAllowed?: boolean | null;
    planType?: string | null;
    buckets: CodexUsageLimitBucket[];
    resetCreditsAvailableCount?: number | null;
    resetCredits?: CodexUsageResetCredit[] | null;
  };
  tokenUsage?: {
    summary?: CodexAccountUsageSummary;
    dailyUsageBuckets?: Array<{ startDate: string; tokens: number }> | null;
  };
  errors?: {
    quota?: string;
    tokenUsage?: string;
  };
  stale?: {
    quota?: boolean;
    tokenUsage?: boolean;
  };
}

export interface CodexResetCreditConsumeResponse {
  outcome: CodexResetCreditConsumeOutcome;
}

export interface CodexUsageResponse {
  generatedAt: string;
  dataSource: "codex-app-server";
  accounts: CodexUsageAccount[];
}

export interface CodexHistoryDetailResponse {
  home: CodexHistoryHome;
  thread: CodexThread;
  imageAttachments?: CodexHistoryTurnAttachments[];
  models?: CodexHistoryModelOption[];
  turnUsages?: CodexHistoryTurnUsageRecord[];
}

export type CodexHistoryReasoningEffort = string;

export interface CodexHistoryModelOption {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort?: CodexHistoryReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: CodexHistoryReasoningEffort;
    description: string;
  }>;
}

export interface CodexHistoryTurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
}

export interface CodexHistoryTurnUsageRecord {
  turnIndex: number;
  usage: CodexHistoryTurnUsage;
}

export interface CodexHistoryAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface CodexHistoryTurnAttachments {
  runId: string;
  turnIndex: number;
  attachments: CodexHistoryAttachment[];
}

export type CodexHistoryRunState = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export interface CodexHistoryWriterStatus {
  state: "available" | "busy" | "unknown";
  checkedAt: string;
  localRun?: {
    runId: string;
    threadId: string;
    userText: string;
    state: "running" | "cancelling";
    cursor: number;
    turnIndex: number;
  };
}

export interface CodexHistoryInterruptResponse {
  ok: boolean;
  state: CodexHistoryRunState;
}

export interface CodexHistoryMessageResponse {
  runId: string;
  threadId: string;
  state: CodexHistoryRunState;
  cursor: number;
  turnIndex: number;
  attachments: CodexHistoryAttachment[];
}

export interface CodexHistoryUpdateEvent {
  cursor: number;
  type: string;
  item?: unknown;
  message?: string;
  usage?: CodexHistoryTurnUsage;
}

export interface CodexHistoryUpdatesResponse {
  runId: string;
  threadId: string;
  userText: string;
  state: CodexHistoryRunState;
  cursor: number;
  events: CodexHistoryUpdateEvent[];
  usage?: CodexHistoryTurnUsage;
  finalResponse?: string;
  error?: string;
  attachments?: CodexHistoryAttachment[];
  resetRequired?: boolean;
  recovery?: { checkedAt: string; codexThreadStatus: string | null; error?: string };
}

export interface TaskInput {
  projectKey: string;
  mode: string;
  summary: string;
  description: string;
}

export interface CreateTaskInput {
  idempotencyKey?: string;
  description: string;
  projectKey: string;
  attachmentIds?: string[];
}

export interface TaskAttachment {
  attachment_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

export interface CreateTaskResponse {
  task: TaskSummary;
  latest_run: StoredRun | null;
}

export interface TaskSummary {
  task_guid: string;
  origin: TaskOrigin;
  project_key: string;
  mode: string;
  repo: string;
  state: TaskState;
  input_text: string;
  input_hash: string;
  input: TaskInput;
  thread_id: string | null;
  active_run_id: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  worker_pid: number | null;
  service_instance_id: string | null;
  progress_event: string | null;
  progress_text: string | null;
  progress_updated_at: string | null;
}

export interface DirectTaskSummary {
  source: "direct";
  id: string;
  text: string;
  status: string;
  thread_id: string | null;
  attempt: number;
  sender_name: string | null;
  last_progress_text: string | null;
  card_state: string;
  final_response: string | null;
  initial_final_response?: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type AampTaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface AampTaskSummary {
  source: "aamp";
  id: string;
  text: string | null;
  status: AampTaskStatus;
  last_progress_text: string | null;
  error: string | null;
  image_count: number;
  created_at: string;
  updated_at: string;
}

export interface AampTaskDetailResponse {
  task: AampTaskSummary;
  can_followup: false;
}

export interface DirectTaskDetailResponse {
  task: DirectTaskSummary;
  can_followup?: boolean;
  inbound: { event_type: string; received_at: string; processed_at: string | null } | null;
  followups: { items: Array<{ followup_id: string; text: string; status: string; final_response: string | null; error: string | null }>; total: number };
  attachments: { items: Array<{ attachment_id: string; file_name: string | null; type: string; status: string; error: string | null }>; total: number };
  events: { items: Array<{ id: number; event_type: string; created_at: string }>; total: number };
}

export interface StoredRun {
  run_id: string;
  task_guid: string;
  input_hash: string;
  input_text: string;
  previous_input_text: string | null;
  prompt_text: string;
  thread_id: string | null;
  execution_backend: StoredExecutionBackend;
  tmux_session_id: string | null;
  state: TaskState;
  final_response: string | null;
  usage_json: string | null;
  started_at: string;
  finished_at: string | null;
  worker_pid: number | null;
  service_instance_id: string | null;
  progress_event: string | null;
  progress_text: string | null;
  progress_updated_at: string | null;
  events?: StoredRunEvent[];
}

export interface WebRunReview {
  run_id: string;
  task_guid: string;
  decision: "accepted" | "changes_requested";
  note: string;
  reviewed_at: string;
}

export interface GitWorkspaceSnapshot {
  capturedAt: string;
  isGitRepository: boolean;
  headCommit: string | null;
  dirtyPaths: string[];
  untrackedPaths: string[];
  fileFingerprints?: WorkspaceFileFingerprint[];
  truncated: boolean;
  taskAttribution: "unattributed-shared-workspace";
  attributionNote: string;
}

export type WorkspaceFileFingerprintReason =
  | "unsafe-path"
  | "symlink"
  | "outside-repository"
  | "non-directory-parent"
  | "not-regular-file"
  | "safe-open-unavailable"
  | "file-too-large"
  | "byte-budget-exceeded"
  | "file-limit-reached"
  | "not-found"
  | "unreadable"
  | "changed-during-read";

export interface WorkspaceFileFingerprint {
  path: string;
  status: "hashed" | "omitted" | "unsafe";
  sizeBytes: number | null;
  sha256?: string;
  reason?: WorkspaceFileFingerprintReason;
}

export interface RunWorkspaceSnapshot {
  run_id: string;
  stage: "before" | "after";
  snapshot: GitWorkspaceSnapshot;
}

export interface StoredRunEvent {
  id: number;
  run_id: string;
  task_guid: string;
  event_type: string;
  item_type: string | null;
  item_id: string | null;
  message: string;
  usage_json: string | null;
  created_at: string;
}

export interface OutboxEntry {
  id: number;
  task_guid: string;
  operation: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: string | null;
  completed_at: string | null;
}

export interface TaskListResponse {
  items: Array<(TaskSummary & { source: "desk"; latest_run: StoredRun | null; latest_review: WebRunReview | null }) | DirectTaskSummary | AampTaskSummary>;
  total: number;
  limit: number;
  offset: number;
  filters: {
    states: string[];
    projects: string[];
    modes: string[];
  };
}

export interface TaskDetailResponse {
  task: TaskSummary;
  can_followup?: boolean;
  can_retry?: boolean;
  runs: StoredRun[];
  attachments: TaskAttachment[];
  outbox: OutboxEntry[];
  reviews: WebRunReview[];
  workspace_snapshots: RunWorkspaceSnapshot[];
}

export interface DashboardChange {
  kind: "task" | "run" | "run_event" | "outbox";
  task: TaskSummary | null;
  latest_run: StoredRun | null;
  run_event: StoredRunEvent | null;
  outbox: OutboxEntry[];
}
