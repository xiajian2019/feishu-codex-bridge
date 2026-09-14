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

export const SANDBOX_MODES = ["read-only", "workspace-write"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const EXECUTION_MODES = [
  "aamp-relay",
  "legacy-polling",
  "feishu-sqlite-codex",
  // Kept as a compatibility alias for the earlier design proposal. It uses
  // the native Codex SDK implementation and does not start ACP/ACPX.
  "feishu-sqlite-acp",
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const DIRECT_TASK_STATUSES = [
  "QUEUED",
  "RUNNING",
  "CANCEL_REQUESTED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type DirectTaskStatus = (typeof DIRECT_TASK_STATUSES)[number];

export const DIRECT_CARD_STATES = [
  "PENDING",
  "STREAMING",
  "COMPLETED",
  "DELIVERY_FAILED",
] as const;
export type DirectCardState = (typeof DIRECT_CARD_STATES)[number];

export const DIRECT_ATTACHMENT_TYPES = ["image", "file", "audio", "video", "sticker"] as const;
export type DirectAttachmentType = (typeof DIRECT_ATTACHMENT_TYPES)[number];

export const AAMP_TASK_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type AampTaskStatus = (typeof AAMP_TASK_STATUSES)[number];

export interface ProjectConfig {
  optionGuid: string;
  repo: string;
}

export interface ModeConfig {
  optionGuid: string;
  sandboxMode: SandboxMode;
}

export interface BridgeConfig {
  pollIntervalSeconds: number;
  maxConcurrency: 1;
  runTimeoutSeconds: number;
  execution: {
    mode: ExecutionMode;
  };
  aamp: {
    /** Let the official AAMP runtime own Feishu Task/IM/card processing. */
    enabled: boolean;
    /** Stop the package-managed background service when this bridge exits. */
    stopOnShutdown: boolean;
    /** Optional per-task Git worktree isolation for local ACP agents. */
    worktree?: {
      enabled: boolean;
      projectMapPath: string;
      globalAgentsPath: string;
      taskDir: string;
      worktreeRoot: string;
      baseRef: string;
      branchPrefix: string;
    };
  };
  relay: {
    /** Route AAMP traffic to the internal Relay instead of the public default. */
    enabled: boolean;
    /** AAMP service base URL consumed by the official SDK/ACP bridge. */
    aampHost?: string;
    /** Optional HTTP endpoint used only by the startup compensation scan. */
    statusUrl?: string;
    /** Optional bearer token for the internal status endpoint. */
    authToken?: string;
  };
  direct: {
    projectKey?: string;
    mode?: string;
    feishu: {
      /** Optional; defaults to the selected AAMP Codex binding in direct mode. */
      appId?: string;
      /** Optional; defaults to the selected AAMP Codex binding in direct mode. */
      appSecret?: string;
      appIdEnv: string;
      appSecretEnv: string;
      domain?: string;
      groupAllowlist: string[];
      dmMode: "open" | "allowlist" | "disabled";
      dmAllowlist: string[];
      allowedSenderOpenIds: string[];
      requireMention: boolean;
      replyInThread: boolean;
    };
    permissions: DirectPermissions;
  };
  web: {
    enabled: boolean;
    host: "127.0.0.1";
    port: number;
  };
  lark: {
    /** Passed verbatim to every lark-cli invocation; never silently falls back. */
    profile: string;
    /** Optional lark-cli config directory, useful for AAMP's isolated profile store. */
    configDir?: string;
    /** Optional absolute path to the lark-cli executable. */
    cliPath?: string;
    tasklistGuid: string;
    projectFieldGuid: string;
    modeFieldGuid: string;
    allowedCreatorOpenIds?: string[];
  };
  codex: {
    cliPath: string;
    env: {
      HTTP_PROXY?: string;
      HTTPS_PROXY?: string;
    };
  };
  projects: Record<string, ProjectConfig>;
  modes: Record<string, ModeConfig>;
}

export interface TaskInput {
  projectKey: string;
  mode: string;
  summary: string;
  description: string;
}

export interface LarkCustomField {
  guid?: string;
  name?: string;
  type?: string;
  single_select_value?: string;
  multi_select_value?: unknown[];
  text_value?: string;
  [key: string]: unknown;
}

export interface LarkTaskListMembership {
  tasklist_guid?: string;
  section_guid?: string;
  [key: string]: unknown;
}

export interface LarkMember {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface LarkTaskSummary {
  guid: string;
  summary?: string;
  status?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface LarkTask {
  guid: string;
  summary?: string;
  description?: string;
  status?: string;
  completed_at?: string;
  updated_at?: string;
  creator?: LarkMember;
  custom_fields?: LarkCustomField[];
  tasklists?: LarkTaskListMembership[];
  url?: string;
  [key: string]: unknown;
}

export interface RoutedTask {
  taskGuid: string;
  summary: string;
  description: string;
  projectKey: string;
  mode: string;
  repo: string;
  sandboxMode: SandboxMode;
  inputHash: string;
  input: TaskInput;
  completed: boolean;
  url?: string;
}

export interface ConfigProblem {
  code:
    | "NOT_IN_TASKLIST"
    | "CREATOR_NOT_ALLOWED"
    | "PROJECT_MISSING"
    | "PROJECT_UNKNOWN"
    | "MODE_MISSING"
    | "MODE_UNKNOWN"
    | "PROJECT_CHANGED"
    | "TASK_INVALID";
  message: string;
}

export interface StoredTask {
  task_guid: string;
  project_key: string;
  mode: string;
  repo: string;
  state: TaskState;
  input_text: string;
  input_hash: string;
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

export interface StoredAampTask {
  aamp_task_id: string;
  chat_id: string;
  user_text: string | null;
  image_local_paths: string[];
  card_id: string | null;
  card_message_id: string | null;
  status: AampTaskStatus;
  created_at: string;
  updated_at: string;
  error_msg: string | null;
  last_delta_text: string;
  approval_state: string | null;
  session_snapshot: string | null;
  relay_status_json: string | null;
  last_event_type: string | null;
  last_event_json: string | null;
}

export interface DirectMessageInput {
  sourceEventId: string;
  eventType: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderName?: string;
  text: string;
  sessionKey: string;
  /** Feishu message relationship metadata used to attach replies to a task. */
  replyToMessageId?: string;
  rootMessageId?: string;
  threadId?: string;
  attachments?: DirectAttachmentInput[];
  payload?: unknown;
}

export interface DirectAttachmentInput {
  type: DirectAttachmentType;
  fileKey: string;
  fileName?: string;
  durationMs?: number;
  coverImageKey?: string;
}

export interface DirectPermissionRule {
  chatId?: string;
  senderOpenId?: string;
  chatType?: "p2p" | "group";
  allow?: boolean;
  allowAttachments?: boolean;
  allowCancel?: boolean;
}

export interface DirectPermissions {
  defaultAllow: boolean;
  allowAttachments: boolean;
  allowCancel: boolean;
  rules: DirectPermissionRule[];
}

export interface StoredInboundEvent {
  source_event_id: string;
  event_type: string;
  message_id: string;
  chat_id: string;
  sender_id: string;
  payload_json: string;
  received_at: string;
  processed_at: string | null;
}

export interface StoredBridgeTask {
  bridge_task_id: string;
  source_event_id: string;
  message_id: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  sender_id: string;
  sender_name: string | null;
  text: string;
  session_key: string;
  status: DirectTaskStatus;
  thread_id: string | null;
  attempt: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_progress_event: string | null;
  last_progress_text: string | null;
  last_progress_at: string | null;
  card_message_id: string | null;
  card_state: DirectCardState;
  card_content: string | null;
  card_updated_at: string | null;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
  recovery_count: number;
  last_recovered_at: string | null;
  final_response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const DIRECT_FOLLOWUP_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type DirectFollowupStatus = (typeof DIRECT_FOLLOWUP_STATUSES)[number];

export interface StoredBridgeTaskFollowup {
  followup_id: string;
  bridge_task_id: string;
  source_event_id: string;
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  text: string;
  status: DirectFollowupStatus;
  attempt: number;
  final_response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredBridgeTaskAttachment {
  attachment_id: string;
  bridge_task_id: string;
  followup_id: string | null;
  type: DirectAttachmentType;
  file_key: string;
  file_name: string | null;
  duration_ms: number | null;
  cover_image_key: string | null;
  local_path: string | null;
  status: "PENDING" | "DOWNLOADED" | "FAILED";
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredBridgeTaskEvent {
  id: number;
  bridge_task_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface StoredRun {
  run_id: string;
  task_guid: string;
  input_hash: string;
  input_text: string;
  previous_input_text: string | null;
  prompt_text: string;
  thread_id: string | null;
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

export interface DatabaseChange {
  kind:
    | "task"
    | "run"
    | "run_event"
    | "outbox"
    | "aamp_task"
    | "inbound_event"
    | "bridge_task";
  taskGuid: string;
  aampTaskId?: string;
  runId?: string;
  eventId?: number;
  at: string;
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

export interface WorkerResult {
  status: "succeeded" | "failed" | "canceled";
  threadId?: string;
  finalResponse?: string;
  usage?: unknown;
  error?: string;
  errorKind?: "proxy" | "timeout" | "crash" | "canceled" | "unknown";
}

export interface WorkerProgress {
  eventType: string;
  message: string;
  itemType?: string;
  itemId?: string;
  usage?: unknown;
  at: string;
}

export interface WorkerHandle {
  pid: number;
  result: Promise<WorkerResult>;
  terminate(): Promise<void>;
}

export interface WorkerRunner {
  start(runId: string): WorkerHandle;
}

export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}
