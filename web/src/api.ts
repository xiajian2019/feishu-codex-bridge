import type {
  DashboardChange,
  CodexHistoryAttachment,
  CodexHistoryDetailResponse,
  CodexHistoryHome,
  CodexHistoryInterruptResponse,
  CodexHistoryListResponse,
  CodexHistoryMessageResponse,
  CodexHistoryReasoningEffort,
  CodexHistoryUpdatesResponse,
  CodexHistoryWriterStatus,
  CodexResetCreditConsumeResponse,
  CodexUsageResponse,
  CreateTaskInput,
  CreateTaskResponse,
  ProjectRecord,
  ProjectStatus,
  TaskAttachment,
  TaskDetailResponse,
  TaskListResponse,
} from "./types.js";
import { DEFAULT_COMPOSER_SHORTCUTS, type ShortcutDefinition, type ShortcutDisplayMode, type ShortcutGroup, type ShortcutKind, type ShortcutStore, type ShortcutSurface } from "./tmux-shortcuts.js";
import { invalidateShortcutConfigCache, loadShortcutConfig, readShortcutConfigCache, readShortcutConfigRevision, writeShortcutConfigCache } from "./shortcut-config-cache.js";
import { clearCodexSkillCache, readCodexSkillCache, writeCodexSkillCache } from "./skill-cache.js";
import { isMobileApp, mobileStreamUrl, MOBILE_RESUME_EVENT } from "./mobile-runtime.js";
import { subscribeToTicketedEvents } from "./mobile-stream.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import { BridgeResponseError, readBridgeJson } from "./bridge-json.js";
import { assertBridgeApiSupported } from "./client-capabilities.js";
import {
  cacheBridgeJson,
  clearBridgeJsonCache,
  isTransientBridgeFailure,
  markBridgeCacheFallback,
  markBridgeRequestFailure,
  markBridgeRequestSettled,
  markBridgeRequestStart,
  markBridgeRequestSuccess,
  readCachedBridgeJson,
} from "./connection-state.js";

export interface TaskQuery {
  q?: string;
  state?: string;
  source?: string;
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

export interface CodexSkillRecord {
  id: string;
  skillName: string;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  scope: "project" | "codex_home" | "user" | "system" | "plugin";
  pinned: boolean;
  sortOrder: number;
}

export interface CodexSkillPreference {
  skillName: string;
  pinned: boolean;
  sortOrder: number;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  assertBridgeApiSupported(new URL(url, "http://bridge.invalid").pathname);
  const scope = getLocalDraftScope();
  const method = (init?.method ?? "GET").toUpperCase();
  const cached = method === "GET" ? readCachedBridgeJson<T>(url) : undefined;
  markBridgeRequestStart();
  let requestEnded = false;
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const payload = response.status === 204 ? null : await readBridgeJson<unknown>(response);
    if (scope !== getLocalDraftScope()) throw new DOMException("Bridge identity changed", "AbortError");
    if (!response.ok) {
      const message = response.status === 404 ? "当前后端不支持该接口，请升级后端或切换环境。" : typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error)
        : `请求失败：${response.status}`;
      markBridgeRequestFailure(new Error(message), response.status);
      requestEnded = true;
      if (response.status === 401) clearBridgeJsonCache();
      if (cached !== undefined && response.status >= 500) {
        markBridgeCacheFallback();
        return cached;
      }
      throw new Error(message);
    }
    markBridgeRequestSuccess();
    requestEnded = true;
    if (method === "GET" && payload !== null) cacheBridgeJson(url, payload);
    return payload as T;
  } catch (error) {
    if (scope !== getLocalDraftScope()) {
      if (!requestEnded) markBridgeRequestSettled();
      throw new DOMException("Bridge identity changed", "AbortError");
    }
    if (requestEnded) throw error;
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      markBridgeRequestSettled();
      throw error;
    }
    const transient = isTransientBridgeFailure(error, error instanceof BridgeResponseError ? error.status : undefined);
    if (transient) markBridgeRequestFailure(error, error instanceof BridgeResponseError ? error.status : undefined);
    else markBridgeRequestSettled();
    if (cached !== undefined && transient) {
      markBridgeCacheFallback();
      return cached;
    }
    throw error;
  }
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
  return getJson<TaskListResponse>(`/api/task-panel?${params.toString()}`, { signal });
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

export async function fetchCodexHistoryHomes(signal?: AbortSignal): Promise<CodexHistoryHome[]> {
  const result = await getJson<{ homes: CodexHistoryHome[] }>("/api/codex/homes", { signal });
  return result.homes;
}

export async function updateCodexThreadHomePreference(
  threadId: string,
  preferredHomeId: string,
): Promise<{ threadId: string; preferredHomeId: string; updatedAt: string }> {
  const token = await getActionToken();
  return getJson<{ threadId: string; preferredHomeId: string; updatedAt: string }>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/home`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Action-Token": token,
      },
      body: JSON.stringify({ preferredHomeId }),
    },
  );
}

export function fetchCodexUsage(options: { homeId?: string; signal?: AbortSignal } = {}): Promise<CodexUsageResponse> {
  const params = new URLSearchParams();
  if (options.homeId) params.set("home", options.homeId);
  const query = params.toString();
  return getJson<CodexUsageResponse>(`/api/codex/usage${query ? `?${query}` : ""}`, { signal: options.signal });
}

export async function consumeCodexResetCredit(input: {
  homeId: string;
  creditId: string;
  idempotencyKey: string;
}): Promise<CodexResetCreditConsumeResponse> {
  const token = await getActionToken();
  return getJson<CodexResetCreditConsumeResponse>("/api/codex/usage/reset-credit/consume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
    },
    body: JSON.stringify(input),
  });
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
  input: {
    text: string;
    attachmentIds?: string[];
    turnIndex: number;
    idempotencyKey: string;
    model?: string;
    reasoningEffort?: CodexHistoryReasoningEffort;
    interactive?: boolean;
  },
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

const CODEX_SKILLS_CACHE_KEY = "global";

function isCodexSkillRecordList(value: unknown): value is CodexSkillRecord[] {
  return Array.isArray(value) && value.every((item) => (
    typeof item === "object"
    && item !== null
    && typeof (item as { skillName?: unknown }).skillName === "string"
  ));
}

export async function fetchProjects(): Promise<ProjectRecord[]> {
  const result = await getJson<{ projects: ProjectRecord[] }>("/api/projects");
  return result.projects;
}

export async function fetchCodexSkills(options: { force?: boolean } = {}): Promise<CodexSkillRecord[]> {
  const scope = getLocalDraftScope();
  const cached = options.force ? null : readCodexSkillCache(CODEX_SKILLS_CACHE_KEY, isCodexSkillRecordList);
  if (cached) return cached;
  const result = await getJson<{ skills: CodexSkillRecord[] }>("/api/skills");
  if (scope !== getLocalDraftScope()) throw new DOMException("Bridge identity changed", "AbortError");
  const skills = Array.isArray(result.skills) ? result.skills : [];
  if (skills.length > 0) writeCodexSkillCache(CODEX_SKILLS_CACHE_KEY, skills, scope);
  return skills;
}

export async function updateCodexSkillPreferences(skills: CodexSkillPreference[]): Promise<void> {
  const token = await getActionToken();
  await getJson("/api/skills/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify({ skills }),
  });
  clearCodexSkillCache(CODEX_SKILLS_CACHE_KEY);
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

export function fetchShortcutConfig(options: { force?: boolean } = {}): Promise<ShortcutStore> {
  return loadShortcutConfig(readShortcutConfig, options.force);
}

async function readShortcutConfig(): Promise<ShortcutStore> {
  const result = await getJson<{ groups: ShortcutGroup[]; shortcuts: ShortcutDefinition[]; revision?: string }>("/api/shortcut-config");
  const composerDefaults = new Map(DEFAULT_COMPOSER_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));
  const shortcuts = Array.isArray(result.shortcuts)
    ? result.shortcuts.map((shortcut) => {
      const fallback = shortcut.groupId === "composer" && !shortcut.actionKey
        ? composerDefaults.get(shortcut.id)
        : undefined;
      return fallback
        ? { ...fallback, ...shortcut, actionKey: fallback.actionKey, displayMode: fallback.displayMode }
        : shortcut;
    })
    : [];
  const store: ShortcutStore = {
    groups: Array.isArray(result.groups)
      ? result.groups.map((group) => group.id === "composer" && group.surface !== "composer" ? { ...group, surface: "composer" } : group)
      : [],
    shortcuts,
  };
  return store;
}

export async function createShortcutGroup(input: {
  title: string;
  icon: string;
  description: string;
  surface?: ShortcutSurface;
  layout: "grid" | "keyboard";
}): Promise<ShortcutGroup> {
  const token = await getActionToken();
  const result = await getJson<{ group: ShortcutGroup }>("/api/shortcut-groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  invalidateShortcutConfigCache();
  return result.group;
}

export async function updateShortcutGroup(
  id: string,
  input: Partial<Pick<ShortcutGroup, "title" | "icon" | "description" | "surface" | "layout" | "sortOrder" | "enabled">>,
): Promise<ShortcutGroup> {
  const token = await getActionToken();
  const result = await getJson<{ group: ShortcutGroup }>(`/api/shortcut-groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  invalidateShortcutConfigCache();
  return result.group;
}

export async function deleteShortcutGroup(id: string): Promise<void> {
  const token = await getActionToken();
  await getJson(`/api/shortcut-groups/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Bridge-Action-Token": token },
  });
  invalidateShortcutConfigCache();
}

export async function createShortcut(input: {
  groupId: string;
  title: string;
  detail: string;
  kind: ShortcutKind;
  value: string;
  actionKey?: string;
  displayMode?: ShortcutDisplayMode;
  enabled: boolean;
  dangerous: boolean;
}): Promise<ShortcutDefinition> {
  const token = await getActionToken();
  const result = await getJson<{ shortcut: ShortcutDefinition }>("/api/shortcuts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  invalidateShortcutConfigCache();
  return result.shortcut;
}

export async function updateShortcut(
  id: string,
  input: Partial<Pick<ShortcutDefinition, "groupId" | "title" | "detail" | "kind" | "value" | "actionKey" | "displayMode" | "enabled" | "dangerous" | "sortOrder">>,
): Promise<ShortcutDefinition> {
  const token = await getActionToken();
  const result = await getJson<{ shortcut: ShortcutDefinition }>(`/api/shortcuts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify(input),
  });
  invalidateShortcutConfigCache();
  return result.shortcut;
}

export async function moveShortcutToEdge(
  id: string,
  position: "start" | "end",
): Promise<ShortcutDefinition> {
  const token = await getActionToken();
  const result = await getJson<{ shortcut: ShortcutDefinition }>(`/api/shortcuts/${encodeURIComponent(id)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify({ position }),
  });
  invalidateShortcutConfigCache();
  return result.shortcut;
}

export async function deleteShortcut(id: string): Promise<void> {
  const token = await getActionToken();
  await getJson(`/api/shortcuts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Bridge-Action-Token": token },
  });
  invalidateShortcutConfigCache();
}

export async function recordShortcutUse(id: string): Promise<ShortcutDefinition> {
  const revision = readShortcutConfigRevision();
  const token = await getActionToken();
  const result = await getJson<{ shortcut: ShortcutDefinition }>(`/api/shortcuts/${encodeURIComponent(id)}/use`, {
    method: "POST",
    headers: { "X-Bridge-Action-Token": token },
  });
  const cached = readShortcutConfigCache();
  if (cached && revision === readShortcutConfigRevision()) {
    writeShortcutConfigCache({ ...cached, shortcuts: cached.shortcuts.map((shortcut) => shortcut.id === id
      ? { ...shortcut, operationCount: Math.max(shortcut.operationCount, result.shortcut.operationCount) }
      : shortcut) });
  }
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

export async function postTaskFollowup(source: "desk" | "direct", taskId: string, text: string, idempotencyKey: string): Promise<{ ok: boolean; state: string }> {
  const token = await getActionToken();
  return getJson(`/api/task-panel/${source}/${encodeURIComponent(taskId)}/followups`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
    body: JSON.stringify({ text, idempotencyKey }),
  });
}

export async function getActionToken(signal?: AbortSignal): Promise<string> {
  const meta = document.querySelector<HTMLMetaElement>("meta[name=bridge-action-token]");
  const embedded = meta?.content;
  if (embedded && embedded !== "__BRIDGE_ACTION_TOKEN__") return embedded;
  const session = await getJson<{ actionToken: string }>("/api/session", { signal });
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
  const handleChange = (event: MessageEvent<string>): void => {
    try {
      onChange(JSON.parse(event.data) as DashboardChange);
    } catch {
      // Ignore malformed events; the next snapshot refresh will reconcile state.
    }
  };
  if (isMobileApp()) {
    return subscribeToTicketedEvents({
      url: () => mobileStreamUrl("/api/events"),
      onChange: handleChange,
      onStatus,
      resumeEvent: MOBILE_RESUME_EVENT,
    });
  }
  onStatus("connecting");
  const source = new EventSource("/api/events");
  source.addEventListener("task.updated", handleChange);
  source.onopen = () => onStatus("connected");
  source.onerror = () => onStatus("disconnected");
  return () => {
    source.removeEventListener("task.updated", handleChange);
    source.close();
  };
}
