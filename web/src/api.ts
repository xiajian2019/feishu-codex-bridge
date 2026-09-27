import type {
  DashboardChange,
  CodexHistoryAttachment,
  CodexHistoryDetailResponse,
  CodexHistoryInterruptResponse,
  CodexHistoryListResponse,
  CodexHistoryMessageResponse,
  CodexHistoryUpdatesResponse,
  CodexHistoryWriterStatus,
  CreateTaskInput,
  CreateTaskResponse,
  ProjectRecord,
  ProjectStatus,
  TaskAttachment,
  TaskDetailResponse,
  TaskListResponse,
} from "./types.js";
import type { ShortcutDefinition, ShortcutGroup, ShortcutKind, ShortcutStore } from "./tmux-shortcuts.js";

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

export async function uploadCodexHistoryAttachment(file: File): Promise<CodexHistoryAttachment> {
  const token = await getActionToken();
  const result = await getJson<{ attachment: CodexHistoryAttachment }>("/api/codex/attachments", {
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

export async function deleteCodexHistoryAttachment(attachmentId: string): Promise<void> {
  const token = await getActionToken();
  await getJson(`/api/codex/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
    headers: { "X-Bridge-Action-Token": token },
  });
}

export async function sendCodexThreadMessage(
  homeId: string,
  threadId: string,
  input: { text: string; attachmentIds?: string[]; turnIndex: number },
): Promise<CodexHistoryMessageResponse> {
  const token = await getActionToken();
  return getJson<CodexHistoryMessageResponse>(
    `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Action-Token": token,
      },
      body: JSON.stringify(input),
    },
  );
}

export function codexHistoryRunAttachmentUrl(
  homeId: string,
  threadId: string,
  runId: string,
  attachmentId: string,
): string {
  return `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export function fetchCodexThreadUpdates(
  homeId: string,
  threadId: string,
  runId: string,
  after: number,
  signal?: AbortSignal,
): Promise<CodexHistoryUpdatesResponse> {
  const params = new URLSearchParams({ runId, after: String(after) });
  return getJson<CodexHistoryUpdatesResponse>(
    `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/updates?${params.toString()}`,
    { signal },
  );
}

export function fetchCodexThreadWriterStatus(
  homeId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<CodexHistoryWriterStatus> {
  return getJson<CodexHistoryWriterStatus>(
    `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/writer-status`,
    { signal },
  );
}

export async function interruptCodexThreadMessage(
  homeId: string,
  threadId: string,
  runId: string,
): Promise<CodexHistoryInterruptResponse> {
  const token = await getActionToken();
  return getJson<CodexHistoryInterruptResponse>(
    `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/interrupt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Action-Token": token,
      },
      body: JSON.stringify({}),
    },
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

export async function fetchShortcutConfig(): Promise<ShortcutStore> {
  const result = await getJson<{ groups: ShortcutGroup[]; shortcuts: ShortcutDefinition[] }>("/api/shortcut-config");
  return {
    groups: Array.isArray(result.groups) ? result.groups : [],
    shortcuts: Array.isArray(result.shortcuts) ? result.shortcuts : [],
  };
}

export async function createShortcutGroup(input: {
  title: string;
  icon: string;
  description: string;
  layout: "grid" | "keyboard";
}): Promise<ShortcutGroup> {
  const token = await getActionToken();
  const result = await getJson<{ group: ShortcutGroup }>("/api/shortcut-groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  return result.group;
}

export async function updateShortcutGroup(
  id: string,
  input: Partial<Pick<ShortcutGroup, "title" | "icon" | "description" | "layout" | "sortOrder" | "enabled">>,
): Promise<ShortcutGroup> {
  const token = await getActionToken();
  const result = await getJson<{ group: ShortcutGroup }>(`/api/shortcut-groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  return result.group;
}

export async function deleteShortcutGroup(id: string): Promise<void> {
  const token = await getActionToken();
  await getJson(`/api/shortcut-groups/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Bridge-Action-Token": token },
  });
}

export async function createShortcut(input: {
  groupId: string;
  title: string;
  detail: string;
  kind: ShortcutKind;
  value: string;
  enabled: boolean;
  dangerous: boolean;
}): Promise<ShortcutDefinition> {
  const token = await getActionToken();
  const result = await getJson<{ shortcut: ShortcutDefinition }>("/api/shortcuts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  return result.shortcut;
}

export async function updateShortcut(
  id: string,
  input: Partial<Pick<ShortcutDefinition, "groupId" | "title" | "detail" | "kind" | "value" | "enabled" | "dangerous" | "sortOrder">>,
): Promise<ShortcutDefinition> {
  const token = await getActionToken();
  const result = await getJson<{ shortcut: ShortcutDefinition }>(`/api/shortcuts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  return result.shortcut;
}

export async function deleteShortcut(id: string): Promise<void> {
  const token = await getActionToken();
  await getJson(`/api/shortcuts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Bridge-Action-Token": token },
  });
}

export async function recordShortcutUse(id: string): Promise<ShortcutDefinition> {
  const token = await getActionToken();
  const result = await getJson<{ shortcut: ShortcutDefinition }>(`/api/shortcuts/${encodeURIComponent(id)}/use`, {
    method: "POST",
    headers: { "X-Bridge-Action-Token": token },
  });
  return result.shortcut;
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
