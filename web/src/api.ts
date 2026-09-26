import type {
  DashboardChange,
  CodexHistoryDetailResponse,
  CodexHistoryListResponse,
  CreateTaskInput,
  CreateTaskResponse,
  ProjectRecord,
  ProjectStatus,
  TaskAttachment,
  TaskDetailResponse,
  TaskListResponse,
} from "./types.js";

export interface TaskQuery {
  q?: string;
  state?: string;
  project?: string;
  mode?: string;
  limit: number;
  offset: number;
}

export interface CodexHistoryQuery {
  home?: string;
  q?: string;
  status?: string;
  archived: "active" | "archived" | "all";
  limit: number;
  offset: number;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.text();
  let payload: unknown = null;
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { error: body };
    }
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String(payload.error)
      : `请求失败：${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export function fetchTasks(query: TaskQuery, signal?: AbortSignal): Promise<TaskListResponse> {
  const params = new URLSearchParams({
    limit: String(query.limit),
    offset: String(query.offset),
  });
  for (const [key, value] of Object.entries(query)) {
    if (key === "limit" || key === "offset" || !value) continue;
    params.set(key, value);
  }
  return getJson<TaskListResponse>(`/api/tasks?${params.toString()}`, { signal });
}

export function fetchCodexHistory(
  query: CodexHistoryQuery,
  signal?: AbortSignal,
): Promise<CodexHistoryListResponse> {
  const params = new URLSearchParams({
    archived: query.archived,
    limit: String(query.limit),
    offset: String(query.offset),
  });
  if (query.home) params.set("home", query.home);
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  return getJson<CodexHistoryListResponse>(`/api/codex/threads?${params.toString()}`, { signal });
}

export function fetchCodexThreadDetail(
  homeId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<CodexHistoryDetailResponse> {
  return getJson<CodexHistoryDetailResponse>(
    `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}?turns=1`,
    { signal },
  );
}

export async function fetchProjects(): Promise<ProjectRecord[]> {
  const result = await getJson<{ projects: ProjectRecord[] }>("/api/projects");
  return result.projects;
}

export async function createProject(input: { name: string; path: string; status: ProjectStatus }): Promise<ProjectRecord> {
  const token = await getActionToken();
  const result = await getJson<{ project: ProjectRecord }>("/api/projects", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
    },
    body: JSON.stringify(input),
  });
  return result.project;
}

export async function updateProject(
  name: string,
  input: { path?: string; status?: ProjectStatus },
): Promise<ProjectRecord> {
  const token = await getActionToken();
  const result = await getJson<{ project: ProjectRecord }>(`/api/projects/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
    },
    body: JSON.stringify(input),
  });
  return result.project;
}

export function fetchTaskDetail(taskGuid: string, signal?: AbortSignal): Promise<TaskDetailResponse> {
  return getJson<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(taskGuid)}`, { signal });
}

export async function uploadTaskAttachment(file: File): Promise<TaskAttachment> {
  const token = await getActionToken();
  const result = await getJson<{ attachment: TaskAttachment }>("/api/tasks/attachments", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Bridge-Action-Token": token,
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  return result.attachment;
}

export async function deleteTaskAttachment(attachmentId: string): Promise<void> {
  const token = await getActionToken();
  await getJson(`/api/tasks/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
    headers: { "X-Bridge-Action-Token": token },
  });
}

export function taskAttachmentUrl(taskGuid: string, attachmentId: string): string {
  return `/api/tasks/${encodeURIComponent(taskGuid)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export async function createTask(input: CreateTaskInput): Promise<CreateTaskResponse> {
  const token = await getActionToken();
  return getJson<CreateTaskResponse>("/api/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
    },
    body: JSON.stringify(input),
  });
}

export async function postTaskAction(
  taskGuid: string,
  action: "interrupt" | "feedback",
  details?: string,
): Promise<{ ok: boolean; state?: string; message?: string }> {
  const token = await getActionToken();
  return getJson(`/api/tasks/${encodeURIComponent(taskGuid)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
    },
    body: JSON.stringify(action === "feedback" ? { action, details } : { action }),
  });
}

async function getActionToken(): Promise<string> {
  const meta = document.querySelector<HTMLMetaElement>("meta[name=bridge-action-token]");
  const embedded = meta?.content;
  if (embedded && embedded !== "__BRIDGE_ACTION_TOKEN__") return embedded;
  const session = await getJson<{ actionToken: string }>("/api/session");
  return session.actionToken;
}

export type EventStreamStatus = "connecting" | "connected" | "disconnected";

export function subscribeToChanges(
  onChange: (change: DashboardChange) => void,
  onStatus: (status: EventStreamStatus) => void,
): () => void {
  if (typeof EventSource === "undefined") {
    onStatus("disconnected");
    return () => undefined;
  }
  onStatus("connecting");
  const source = new EventSource("/api/events");
  const handleChange = (event: MessageEvent<string>): void => {
    try {
      onChange(JSON.parse(event.data) as DashboardChange);
    } catch {
      // Ignore malformed events; the next snapshot refresh will reconcile state.
    }
  };
  source.addEventListener("task.updated", handleChange);
  source.onopen = () => onStatus("connected");
  source.onerror = () => onStatus("disconnected");
  return () => {
    source.removeEventListener("task.updated", handleChange);
    source.close();
  };
}
