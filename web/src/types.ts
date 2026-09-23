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

export interface TaskInput {
  projectKey: string;
  mode: string;
  summary: string;
  description: string;
}

export interface CreateTaskInput {
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
  items: Array<TaskSummary & { latest_run: StoredRun | null }>;
  total: number;
  limit: number;
  offset: number;
  filters: {
    states: TaskState[];
    projects: string[];
    modes: string[];
  };
}

export interface TaskDetailResponse {
  task: TaskSummary;
  runs: StoredRun[];
  attachments: TaskAttachment[];
  outbox: OutboxEntry[];
}

export interface DashboardChange {
  kind: "task" | "run" | "run_event" | "outbox";
  task: TaskSummary | null;
  latest_run: StoredRun | null;
  run_event: StoredRunEvent | null;
  outbox: OutboxEntry[];
}
