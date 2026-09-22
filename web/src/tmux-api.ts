import type {
  TmuxEvent,
  TmuxMessage,
  TmuxProjectOption,
  TmuxSession,
  TmuxSessionDetail,
} from "./tmux-types.js";

interface TmuxSessionResponse {
  actionToken: string;
  tmuxSocket: string;
  bridgeDashboardUrl: string;
  projects: TmuxProjectOption[];
  projectMapError: string | null;
}

export interface StartTmuxSessionInput {
  machine: string;
  projectKey: string;
  initialPrompt?: string;
  clientRequestId: string;
}

export interface StartTmuxSessionResponse {
  created: boolean;
  session: TmuxSession;
}

let actionTokenPromise: Promise<string> | null = null;

export async function fetchTmuxSessionConfig(): Promise<TmuxSessionResponse> {
  const response = await fetch("/api/tmux/session", { headers: { Accept: "application/json" } });
  return readJson<TmuxSessionResponse>(response);
}

export async function fetchTmuxActionToken(): Promise<string> {
  if (!actionTokenPromise) {
    actionTokenPromise = fetchTmuxSessionConfig().then((value) => value.actionToken);
  }
  return actionTokenPromise;
}

export async function fetchTmuxSessions(): Promise<TmuxSession[]> {
  const response = await fetch("/api/tmux/sessions", { headers: { Accept: "application/json" } });
  const body = await readJson<{ items: TmuxSession[] }>(response);
  return body.items;
}

export async function fetchTmuxSession(sessionId: string): Promise<TmuxSessionDetail> {
  const response = await fetch(`/api/tmux/sessions/${encodeURIComponent(sessionId)}`);
  return readJson<TmuxSessionDetail>(response);
}

export async function startTmuxSession(
  input: StartTmuxSessionInput,
): Promise<StartTmuxSessionResponse> {
  return postJson<StartTmuxSessionResponse>("/api/tmux/sessions", input, input.clientRequestId);
}

export async function sendTmuxMessage(
  sessionId: string,
  clientMessageId: string,
  text: string,
): Promise<{ accepted: boolean; deduplicated: boolean; message: TmuxMessage }> {
  return postJson(
    `/api/tmux/sessions/${encodeURIComponent(sessionId)}`,
    { clientMessageId, text },
    clientMessageId,
  );
}

export async function stopTmuxSession(sessionId: string): Promise<TmuxSession> {
  const token = await fetchTmuxActionToken();
  const response = await fetch(`/api/tmux/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
    },
    body: "{}",
  });
  return (await readJson<{ session: TmuxSession }>(response)).session;
}

export async function openTmuxTerminal(
  sessionId: string,
  after: number,
): Promise<WebSocket> {
  const token = await fetchTmuxActionToken();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ after: String(after), token });
  return new WebSocket(
    `${protocol}//${window.location.host}/api/tmux/sessions/${encodeURIComponent(sessionId)}/terminal?${query}`,
  );
}

export function parseTmuxWebSocketMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown, idempotencyKey: string): Promise<T> {
  const token = await fetchTmuxActionToken();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Bridge-Action-Token": token,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return readJson<T>(response);
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String(body.error)
      : `请求失败：${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function eventScreen(event: TmuxEvent): string | null {
  if (event.kind !== "terminal.snapshot") return null;
  return typeof event.payload.screen === "string" ? event.payload.screen : null;
}
