import type { CodexHistoryItem, CodexThread, ProjectRecord } from "./types.js";
import { getActionToken, getJson } from "./api.js";

export interface HistoryWorkbenchTarget {
  kind: "history";
  homeId: string;
  id: string;
}

export interface HistoryWorkbenchPreference {
  target: HistoryWorkbenchTarget;
  pinned: boolean;
  tags: string[];
  unread: boolean;
  keepAttention: boolean;
}

export type HistoryWorkbenchPreferencePatch = Partial<
  Pick<HistoryWorkbenchPreference, "pinned" | "tags" | "unread" | "keepAttention">
>;

export interface HistoryWorkbenchTemplate {
  id: string;
  title: string;
  text: string;
  projectKey?: string;
  model?: string;
  reasoningEffort?: string;
}

export type HistoryQueueStatus = "queued" | "sending" | "sent" | "failed" | "unconfirmed";

export interface HistoryQueueMessage {
  id: string;
  text: string;
  status: HistoryQueueStatus;
  error?: string;
  createdAt?: number;
  model?: string;
  reasoningEffort?: string;
}

export interface HistoryWorkbenchAction {
  id: string;
  kind?: string;
  type?: string;
  method?: string;
  status?: string;
  title?: string;
  summary?: string;
  text?: string;
  prompt?: string;
  question?: string;
  command?: string;
  params?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  questions?: unknown[];
  [key: string]: unknown;
}

export interface HistoryActionQuestion {
  id: string;
  prompt: string;
  options: Array<{ value: string; label: string }>;
}

export type HistoryActionResponse =
  | { decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { answers: Record<string, string | string[]> }
  | { permissions: Record<string, unknown>; scope: "turn" }
  | { action: "accept"; content: unknown }
  | { action: "decline" | "cancel"; content: null };

export interface HistorySelectableMessage {
  id: string;
  role: "user" | "assistant";
  turnIndex: number;
  text: string;
}

export interface HistoryTaskDraftNavigationState {
  newTaskDraft: {
    source: "history";
    projectKey: string;
    description: "";
  };
}

export type HistoryOrganizationFilter = "all" | "pinned" | "unread" | "attention";
export type HistoryOrganizationSort = "recent" | "pinned";

export function historyTarget(homeId: string, id: string): HistoryWorkbenchTarget {
  return { kind: "history", homeId, id };
}

export function historyPreferenceKey(target: HistoryWorkbenchTarget): string {
  return JSON.stringify([target.kind, target.homeId, target.id]);
}

export function normalizeHistoryTags(input: string | string[]): string[] {
  const values = Array.isArray(input) ? input : input.split(",");
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const tag = value.trim().replace(/\s+/g, " ").slice(0, 40);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 12) break;
  }
  return tags;
}

export function extractHistoryTemplateVariables(text: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = match[1]?.trim() ?? "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    variables.push(name);
  }
  return variables;
}

export function fillHistoryTemplate(text: string, values: Readonly<Record<string, string>>): string | null {
  const variables = extractHistoryTemplateVariables(text);
  if (variables.some((name) => !values[name]?.trim())) return null;
  const filled = text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (placeholder, rawName: string) => {
    const name = rawName.trim();
    return name ? values[name]?.trim() ?? placeholder : placeholder;
  });
  return /\{\{[^{}]*\}\}/.test(filled) ? null : filled;
}

export function normalizeProjectPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function exactHistoryProjectMatches(cwd: string | undefined, projects: ProjectRecord[]): ProjectRecord[] {
  const exactPath = cwd ? normalizeProjectPath(cwd) : "";
  if (!exactPath) return [];
  return projects.filter((project) => project.available
    && project.status === "available"
    && normalizeProjectPath(project.path) === exactPath);
}

export function historyTaskDraftNavigationState(projectKey: string): HistoryTaskDraftNavigationState {
  return { newTaskDraft: { source: "history", projectKey, description: "" } };
}

export function normalizeHistoryPreference(
  target: HistoryWorkbenchTarget,
  value?: Partial<HistoryWorkbenchPreference> | null,
): HistoryWorkbenchPreference {
  return {
    target,
    pinned: value?.pinned === true,
    tags: normalizeHistoryTags(Array.isArray(value?.tags) ? value.tags : []),
    unread: value?.unread === true,
    keepAttention: value?.keepAttention === true,
  };
}

export function organizeHistoryItems(
  items: CodexHistoryItem[],
  preferences: ReadonlyMap<string, HistoryWorkbenchPreference>,
  options: {
    filter?: HistoryOrganizationFilter;
    sort?: HistoryOrganizationSort;
    tag?: string;
  } = {},
): CodexHistoryItem[] {
  const filter = options.filter ?? "all";
  const tag = options.tag?.trim().toLocaleLowerCase() ?? "";
  const visible = items.filter((item) => {
    const target = historyTarget(item.preferredHomeId || item.home.id, item.thread.id);
    const preference = preferences.get(historyPreferenceKey(target));
    if (filter === "pinned" && !preference?.pinned) return false;
    if (filter === "unread" && !preference?.unread) return false;
    if (filter === "attention" && !preference?.keepAttention) return false;
    return !tag || preference?.tags.some((candidate) => candidate.toLocaleLowerCase() === tag) === true;
  });
  if (options.sort !== "pinned") return visible;
  return visible.sort((left, right) => {
    const leftTarget = historyTarget(left.preferredHomeId || left.home.id, left.thread.id);
    const rightTarget = historyTarget(right.preferredHomeId || right.home.id, right.thread.id);
    const leftPinned = preferences.get(historyPreferenceKey(leftTarget))?.pinned ? 1 : 0;
    const rightPinned = preferences.get(historyPreferenceKey(rightTarget))?.pinned ? 1 : 0;
    return rightPinned - leftPinned;
  });
}

export function extractHistoryMessages(thread: CodexThread, extraTurns: unknown[] = []): HistorySelectableMessage[] {
  const turns = [...(Array.isArray(thread.turns) ? thread.turns : []), ...extraTurns];
  const messages: HistorySelectableMessage[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const record = asRecord(turn);
    const items = Array.isArray(record.items) ? record.items : [];
    const users = items.filter(isHistoryUserMessage);
    const assistants = items.filter(isHistoryAssistantMessage);
    users.forEach((item, itemIndex) => {
      const text = formatHistoryUserMessage(item);
      if (!text) return;
      messages.push({
        id: `${thread.id}-turn-${turnIndex}-user-${itemIndex}`,
        role: "user",
        turnIndex,
        text,
      });
    });
    if (assistants.length > 0) {
      const text = assistants.map((item) => formatHistoryItem(item, itemType(item) || "agentMessage"))
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (text) {
        messages.push({
          id: `${thread.id}-turn-${turnIndex}-assistant`,
          role: "assistant",
          turnIndex,
          text,
        });
      }
    }
  }
  return messages;
}

export function buildForwardedHistoryText(
  messages: HistorySelectableMessage[],
  selectedIds: ReadonlySet<string>,
  sourceTitle: string,
): string {
  const selected = messages.filter((message) => selectedIds.has(message.id));
  if (selected.length === 0) return "";
  const body = selected.map((message) => `${message.role === "user" ? "用户" : "Codex"}：\n${message.text}`)
    .join("\n\n---\n\n");
  return `转发自会话「${sourceTitle.trim() || "（无标题）"}」\n\n${body}`;
}

const HISTORY_BOOKMARK_PREFIX = "feishu-codex-bridge:history-bookmarks:v1:";

export function historyBookmarkStorageKey(scope: string | null, target: HistoryWorkbenchTarget): string | null {
  if (!scope) return null;
  return `${HISTORY_BOOKMARK_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(historyPreferenceKey(target))}`;
}

export function loadHistoryBookmarks(
  scope: string | null,
  target: HistoryWorkbenchTarget,
  storage: Pick<Storage, "getItem"> | null = browserLocalStorage(),
): Set<string> {
  const key = historyBookmarkStorageKey(scope, target);
  if (!key || !storage) return new Set();
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(-500) : []);
  } catch {
    return new Set();
  }
}

export function saveHistoryBookmarks(
  scope: string | null,
  target: HistoryWorkbenchTarget,
  bookmarks: ReadonlySet<string>,
  storage: Pick<Storage, "setItem"> | null = browserLocalStorage(),
): void {
  const key = historyBookmarkStorageKey(scope, target);
  if (!key || !storage) return;
  try {
    storage.setItem(key, JSON.stringify([...bookmarks].slice(-500)));
  } catch {
    // Bookmarks are a local convenience and must not block the transcript.
  }
}

export function toggleHistoryBookmark(bookmarks: ReadonlySet<string>, messageId: string): Set<string> {
  const next = new Set(bookmarks);
  if (next.has(messageId)) next.delete(messageId);
  else next.add(messageId);
  return next;
}

export async function fetchHistoryPreferences(signal?: AbortSignal): Promise<HistoryWorkbenchPreference[]> {
  const response = await getJson<{ preferences: HistoryWorkbenchPreference[] }>("/api/workbench/preferences", { signal });
  return response.preferences;
}

export async function saveHistoryPreference(
  target: HistoryWorkbenchTarget,
  patch: HistoryWorkbenchPreferencePatch,
): Promise<HistoryWorkbenchPreference> {
  return patchJson<{ preference: HistoryWorkbenchPreference }>("/api/workbench/preferences", { target, patch })
    .then((result) => result.preference);
}

export async function fetchHistoryTemplates(signal?: AbortSignal): Promise<HistoryWorkbenchTemplate[]> {
  const response = await getJson<{ templates: HistoryWorkbenchTemplate[] }>("/api/workbench/templates", { signal });
  return response.templates;
}

export async function fetchHistoryQueue(
  target: HistoryWorkbenchTarget,
  signal?: AbortSignal,
): Promise<HistoryQueueMessage[]> {
  const query = new URLSearchParams({ kind: target.kind, homeId: target.homeId, id: target.id });
  const response = await getJson<{ messages: HistoryQueueMessage[] }>(`/api/workbench/queue?${query}`, { signal });
  return response.messages;
}

export function addHistoryQueueMessage(input: {
  target: HistoryWorkbenchTarget;
  text: string;
  model?: string;
  reasoningEffort?: string;
  idempotencyKey: string;
}): Promise<{ message: HistoryQueueMessage }> {
  return postJson("/api/workbench/queue", input);
}

/** Keep an unconfirmed draft's key so a retry cannot enqueue it twice. */
export function createHistoryQueueDraftSubmitter(
  enqueue: typeof addHistoryQueueMessage = addHistoryQueueMessage,
): (target: HistoryWorkbenchTarget, draft: string) => ReturnType<typeof addHistoryQueueMessage> {
  type QueueResponse = Awaited<ReturnType<typeof addHistoryQueueMessage>>;
  const pending = new Map<string, { idempotencyKey: string; inFlight?: Promise<QueueResponse> }>();
  return (target, draft) => {
    const text = draft.trim();
    const draftKey = JSON.stringify([historyPreferenceKey(target), text]);
    let submission = pending.get(draftKey);
    if (!submission) {
      submission = { idempotencyKey: globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
      pending.set(draftKey, submission);
    }
    if (submission.inFlight) return submission.inFlight;
    const attempt = submission;
    attempt.inFlight = Promise.resolve()
      .then(() => enqueue({ target, text, idempotencyKey: attempt.idempotencyKey }))
      .then((result) => {
        pending.delete(draftKey);
        return result;
      })
      .finally(() => { attempt.inFlight = undefined; });
    return attempt.inFlight;
  };
}

export function updateHistoryQueueMessage(
  id: string,
  patch: { text?: string; move?: "up" | "down" },
): Promise<{ message: HistoryQueueMessage }> {
  return patchJson(`/api/workbench/queue/${encodeURIComponent(id)}`, patch);
}

export async function deleteHistoryQueueMessage(id: string): Promise<void> {
  await actionJson(`/api/workbench/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function sendHistoryQueueMessage(id: string): Promise<{ message: HistoryQueueMessage }> {
  return postJson(`/api/workbench/queue/${encodeURIComponent(id)}/send`, {});
}

export async function fetchHistoryActions(
  target: HistoryWorkbenchTarget,
  signal?: AbortSignal,
): Promise<HistoryWorkbenchAction[]> {
  const query = new URLSearchParams({ kind: target.kind, homeId: target.homeId, id: target.id });
  const response = await getJson<{ actions?: unknown[]; items?: unknown[] }>(`/api/workbench/actions?${query}`, { signal });
  const values = Array.isArray(response.actions) ? response.actions : Array.isArray(response.items) ? response.items : [];
  return values.flatMap((value): HistoryWorkbenchAction[] => {
    const record = asRecord(value);
    const id = typeof record.id === "string"
      ? record.id
      : typeof record.actionId === "string"
        ? record.actionId
        : typeof record.requestId === "string"
          ? record.requestId
          : "";
    return id ? [{ ...record, id }] : [];
  });
}

export function respondToHistoryAction(id: string, body: HistoryActionResponse): Promise<unknown> {
  return postJson(`/api/workbench/actions/${encodeURIComponent(id)}/respond`, body);
}

export function historyActionKind(action: HistoryWorkbenchAction): "approval" | "question" | "permissions" | "elicitation" | "other" {
  const payload = asRecord(action.payload);
  const details = asRecord(payload.params);
  const marker = [action.kind, action.type, action.method, action.title, payload.method]
    .filter((value) => typeof value === "string").join(" ").toLowerCase();
  if (marker.includes("elicitation")) return "elicitation";
  if (Object.keys(asRecord(payload.permissions)).length > 0
    || Object.keys(asRecord(details.permissions)).length > 0
    || marker.includes("permissions")) return "permissions";
  if (marker.includes("approval") || marker.includes("approve") || marker.includes("permission")) return "approval";
  if (marker.includes("question") || marker.includes("input") || marker.includes("clarif")) return "question";
  return "other";
}

export function historyActionPermissions(action: HistoryWorkbenchAction): Record<string, unknown> | null {
  const payload = asRecord(action.payload);
  const details = asRecord(payload.params);
  const permissions = Object.keys(asRecord(details.permissions)).length > 0
    ? details.permissions
    : payload.permissions;
  return Object.keys(asRecord(permissions)).length > 0 ? asRecord(permissions) : null;
}

export function historyActionElicitationSchema(action: HistoryWorkbenchAction): unknown {
  const payload = asRecord(action.payload);
  const details = asRecord(payload.params);
  return details.requestedSchema ?? details.schema ?? payload.requestedSchema ?? payload.schema ?? null;
}

export function historyActionQuestions(action: HistoryWorkbenchAction): HistoryActionQuestion[] {
  const params = asRecord(action.params);
  const payload = asRecord(action.payload);
  const payloadParams = asRecord(payload.params);
  const values = Array.isArray(action.questions)
    ? action.questions
    : Array.isArray(params.questions)
      ? params.questions
      : Array.isArray(payload.questions)
        ? payload.questions
        : Array.isArray(payloadParams.questions)
          ? payloadParams.questions
      : [];
  return values.flatMap((value): HistoryActionQuestion[] => {
    const question = asRecord(value);
    if (typeof question.id !== "string" || !question.id) return [];
    const id = question.id;
    const prompt = [question.question, question.prompt, question.text, question.header]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim() ?? "请输入答案";
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option, optionIndex) => {
          const record = asRecord(option);
          const value = typeof option === "string"
            ? option
            : typeof record.value === "string"
              ? record.value
              : typeof record.label === "string"
                ? record.label
                : "";
          if (!value) return [];
          const label = typeof record.label === "string" ? record.label : value;
          return [{ value: value || String(optionIndex), label }];
        })
      : [];
    return [{ id, prompt, options }];
  });
}

export function historyActionSummary(action: HistoryWorkbenchAction): string {
  const params = asRecord(action.params);
  const payload = asRecord(action.payload);
  const payloadParams = asRecord(payload.params);
  for (const candidate of [
    action.summary,
    action.title,
    action.body,
    action.prompt,
    action.question,
    action.text,
    action.command,
    params.command,
    payload.command,
    payload.filePath,
    payload.path,
    payload.prompt,
    payload.description,
    payloadParams.command,
    payloadParams.filePath,
    payloadParams.path,
    payloadParams.prompt,
    payloadParams.description,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return action.method || action.type || action.kind || "Codex 请求用户处理一项操作";
}

export function forkCodexHistoryThread(
  homeId: string,
  threadId: string,
  lastTurnId?: string,
): Promise<{ threadId: string; homeId: string }> {
  return postJson(`/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/fork`, {
    ...(lastTurnId ? { lastTurnId } : {}),
  });
}

export function steerCodexHistoryRun(
  homeId: string,
  threadId: string,
  runId: string,
  text: string,
): Promise<unknown> {
  return postJson(
    `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/steer`,
    { text },
  );
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return actionJson<T>(url, { method: "POST", body: JSON.stringify(body) });
}

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  return actionJson<T>(url, { method: "PATCH", body: JSON.stringify(body) });
}

async function actionJson<T>(url: string, init: RequestInit): Promise<T> {
  const token = await getActionToken();
  return getJson<T>(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
    },
  });
}

function itemType(item: unknown): string {
  const type = asRecord(item).type;
  return typeof type === "string" ? type : "";
}

function isHistoryUserMessage(item: unknown): boolean {
  return ["userMessage", "user_message"].includes(itemType(item));
}

function isHistoryAssistantMessage(item: unknown): boolean {
  return ["agentMessage", "assistantMessage", "agent_message", "assistant_message"].includes(itemType(item));
}

function formatHistoryUserMessage(item: unknown): string {
  return formatHistoryItem(item, itemType(item) || "userMessage")
    .replace(/\n*请打开并查看我附上的图片，再结合上面的文字处理：\n(?:<image name=\[Image #\d+\] path="[^"]*">\n?)+/g, "")
    .replace(/\n*请读取我附上的文件，再结合上面的文字处理：\n(?:<file name="[^"]*" path="[^"]*">\n?)+/g, "")
    .trim();
}

function formatHistoryItem(item: unknown, type: string): string {
  const record = asRecord(item);
  const parts: string[] = [];
  if ((type === "commandExecution" || type === "command_execution") && typeof record.command === "string") {
    parts.push(`$ ${record.command}`);
  }
  for (const key of ["text", "summary", "content", "aggregatedOutput", "aggregated_output", "output", "error"]) {
    const text = flattenHistoryText(record[key]);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : typeof record.message === "string" && record.message ? record.message : "（无文本输出）";
}

function flattenHistoryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenHistoryText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = asRecord(value);
  if (typeof record.text === "string") return record.text;
  if (typeof record.value === "string") return record.value;
  return record.type === "image" ? "[图片]" : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function browserLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
