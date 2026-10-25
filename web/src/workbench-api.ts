import { getActionToken, getJson } from "./api.js";

export type WorkbenchTaskSource = "desk" | "direct" | "aamp";

export interface WorkbenchNewTaskDraft {
  source: "task" | "history";
  projectKey?: string;
  mode?: string;
  description: string;
  model?: string;
  homeId?: string;
}

export type WorkbenchTarget =
  | { kind: "task"; source: WorkbenchTaskSource; id: string }
  | { kind: "history"; id: string; homeId?: string };

export interface WorkbenchPreference {
  target: WorkbenchTarget;
  pinned: boolean;
  tags: string[];
  unread: boolean;
  keepAttention: boolean;
  title?: string;
  updatedAt?: number;
}

export interface WorkbenchTemplate {
  id: string;
  title: string;
  text: string;
  projectKey?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface WorkbenchQueueMessage {
  id: string;
  target: WorkbenchTarget;
  text: string;
  model?: string;
  reasoningEffort?: string;
  idempotencyKey: string;
  status: "queued" | "sending" | "sent" | "failed" | "unconfirmed";
  error?: string;
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number;
}

export interface WorkbenchNotification {
  id: string;
  eventKey?: string;
  target: WorkbenchTarget;
  category: "completion" | "failure" | "action";
  title: string;
  body?: string;
  route: string;
  createdAt: number;
  dismissedAt?: number;
}

export interface WorkbenchPendingAction {
  id: string;
  title?: string;
  body?: string;
  type?: "approval" | "question" | string;
  method?: string;
  params?: Record<string, unknown>;
  status?: "pending" | "resolved" | "expired" | string;
  target?: WorkbenchTarget;
  route?: string;
  runId?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
  expiresAt?: number;
  createdAt?: number;
}

export interface WorkbenchInbox {
  actions: WorkbenchPendingAction[];
  notifications: WorkbenchNotification[];
  connection: { state: "connected" | "connecting" | "disconnected" | string; [key: string]: unknown };
}

export interface WorkbenchNotificationSettings {
  completion: boolean;
  failure: boolean;
  action: boolean;
  browser: boolean;
}

export interface WorkbenchAutomation {
  id: string;
  title: string;
  text: string;
  target?: WorkbenchTarget;
  projectKey?: string;
  intervalMinutes: number;
  timeZone: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError?: string;
}

export interface WorkbenchAutomationRun {
  id?: string;
  automationId?: string;
  trigger?: "scheduled" | "manual" | string;
  submissionStatus: "pending" | "accepted" | "failed" | "unconfirmed" | string;
  executionStatus: "not_started" | "running" | "completed" | "failed" | "unconfirmed" | string;
  taskTarget?: WorkbenchTarget;
  startedAt?: number;
  submissionFinishedAt?: number;
  executionFinishedAt?: number;
  submissionError?: string;
  executionError?: string;
  [key: string]: unknown;
}

export interface WorkbenchMachine {
  id: string;
  name: string;
  kind: "local" | "remote";
  url?: string;
  status: "local" | "unconnected" | string;
  capabilities: string[] | Record<string, unknown>;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const token = method === "GET" ? undefined : await getActionToken();
  const hasBody = init.body !== undefined;
  return getJson<T>(url, {
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Bridge-Action-Token": token } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function targetQuery(target: WorkbenchTarget): string {
  const params = new URLSearchParams({ kind: target.kind, id: target.id });
  if (target.kind === "task") params.set("source", target.source);
  if (target.kind === "history" && target.homeId) params.set("homeId", target.homeId);
  return params.toString();
}

export function fetchWorkbenchInbox(signal?: AbortSignal): Promise<WorkbenchInbox> {
  return request<WorkbenchInbox>("/api/workbench/inbox", { signal });
}

export function fetchWorkbenchPreferences(signal?: AbortSignal): Promise<{ preferences: WorkbenchPreference[] }> {
  return request("/api/workbench/preferences", { signal });
}

export function patchWorkbenchPreference(
  target: WorkbenchTarget,
  patch: Partial<Omit<WorkbenchPreference, "target" | "title">> & { title?: string | null },
): Promise<{ preference: WorkbenchPreference }> {
  return request("/api/workbench/preferences", { method: "PATCH", body: JSON.stringify({ target, patch }) });
}

export function fetchWorkbenchQueue(target: WorkbenchTarget, signal?: AbortSignal): Promise<{ messages: WorkbenchQueueMessage[] }> {
  return request(`/api/workbench/queue?${targetQuery(target)}`, { signal });
}

export function addWorkbenchQueueMessage(target: WorkbenchTarget, text: string, idempotencyKey: string): Promise<{ message: WorkbenchQueueMessage }> {
  return request("/api/workbench/queue", { method: "POST", body: JSON.stringify({ target, text, idempotencyKey }) });
}

export function patchWorkbenchQueueMessage(id: string, patch: { text?: string; move?: "up" | "down" }): Promise<{ message: WorkbenchQueueMessage }> {
  return request(`/api/workbench/queue/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteWorkbenchQueueMessage(id: string): Promise<void> {
  return request(`/api/workbench/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function sendWorkbenchQueueMessage(id: string): Promise<{ message?: WorkbenchQueueMessage; status?: string }> {
  return request(`/api/workbench/queue/${encodeURIComponent(id)}/send`, { method: "POST", body: JSON.stringify({}) });
}

export function fetchWorkbenchTemplates(signal?: AbortSignal): Promise<{ templates: WorkbenchTemplate[] }> {
  return request("/api/workbench/templates", { signal });
}

export function createWorkbenchTemplate(input: Omit<WorkbenchTemplate, "id">): Promise<{ template: WorkbenchTemplate }> {
  return request("/api/workbench/templates", { method: "POST", body: JSON.stringify(input) });
}

export function updateWorkbenchTemplate(id: string, patch: Partial<Omit<WorkbenchTemplate, "id">>): Promise<{ template: WorkbenchTemplate }> {
  return request(`/api/workbench/templates/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteWorkbenchTemplate(id: string): Promise<void> {
  return request(`/api/workbench/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchWorkbenchSettings(signal?: AbortSignal): Promise<{ settings: { notifications: WorkbenchNotificationSettings } }> {
  return request("/api/workbench/settings", { signal });
}

export function updateWorkbenchSettings(patch: Partial<WorkbenchNotificationSettings>): Promise<{ settings: { notifications: WorkbenchNotificationSettings } }> {
  return request("/api/workbench/settings", { method: "PATCH", body: JSON.stringify({ notifications: patch }) });
}

export function dismissWorkbenchNotification(id: string): Promise<void> {
  return request(`/api/workbench/notifications/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: JSON.stringify({}) });
}

export type WorkbenchActionResponse =
  | { decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { answers: Record<string, string | string[]> }
  | { permissions: Record<string, unknown>; scope: "turn" }
  | { action: "accept"; content: unknown }
  | { action: "decline" | "cancel"; content: null };

export function respondWorkbenchAction(id: string, response: WorkbenchActionResponse): Promise<{ ok: boolean }> {
  return request(`/api/workbench/actions/${encodeURIComponent(id)}/respond`, { method: "POST", body: JSON.stringify(response) });
}

export function fetchWorkbenchAutomations(signal?: AbortSignal): Promise<{ automations: WorkbenchAutomation[] }> {
  return request("/api/workbench/automations", { signal });
}

export function createWorkbenchAutomation(input: {
  text: string;
  target?: WorkbenchTarget;
  projectKey?: string;
  intervalMinutes: number;
  timeZone: string;
  enabled: boolean;
}): Promise<{ automation: WorkbenchAutomation }> {
  return request("/api/workbench/automations", { method: "POST", body: JSON.stringify(input) });
}

export function updateWorkbenchAutomation(id: string, patch: Partial<{
  text: string;
  target: WorkbenchTarget | null;
  projectKey: string | null;
  intervalMinutes: number;
  timeZone: string;
  enabled: boolean;
}>): Promise<{ automation: WorkbenchAutomation }> {
  return request(`/api/workbench/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteWorkbenchAutomation(id: string): Promise<void> {
  return request(`/api/workbench/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function runWorkbenchAutomation(id: string, idempotencyKey: string): Promise<{ run?: WorkbenchAutomationRun; status?: string }> {
  return request(`/api/workbench/automations/${encodeURIComponent(id)}/run`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  });
}

export function fetchWorkbenchAutomationRuns(id: string, signal?: AbortSignal): Promise<{ runs: WorkbenchAutomationRun[] }> {
  return request(`/api/workbench/automations/${encodeURIComponent(id)}/runs`, { signal });
}

export function fetchWorkbenchMachines(signal?: AbortSignal): Promise<{ machines: WorkbenchMachine[]; localId: string }> {
  return request("/api/workbench/machines", { signal });
}

export function createWorkbenchMachine(input: { name: string; kind: "remote"; url?: string }): Promise<{ machine: WorkbenchMachine }> {
  return request("/api/workbench/machines", { method: "POST", body: JSON.stringify(input) });
}

export function updateWorkbenchMachine(id: string, patch: { name?: string; url?: string | null }): Promise<{ machine: WorkbenchMachine }> {
  return request(`/api/workbench/machines/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteWorkbenchMachine(id: string): Promise<void> {
  return request(`/api/workbench/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
}
