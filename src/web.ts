import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import type { Duplex } from "node:stream";

import { StateDatabase } from "./db.js";
import type { TmuxDashboardApi } from "./tmux-dashboard-api.js";
import { resolveBridgeProjectRoot } from "./portable-runtime.js";
import { parseTaskInput } from "./fingerprint.js";
import type { TmuxVerifierWebServer } from "./tmux-verifier-web.js";
import { PairingRateLimitError, WebPairingAuth } from "./web-auth.js";
import {
  AAMP_TASK_STATUSES,
  TASK_STATES,
  type AampTaskStatus,
  type DatabaseChange,
  type Logger,
  type TaskState,
} from "./types.js";

export interface DashboardServerOptions {
  db: StateDatabase;
  host: string;
  port: number;
  projects: string[];
  modes: string[];
  webRoot?: string;
  auth?: WebPairingAuth;
  tmuxVerifier?: TmuxVerifierWebServer;
  tmuxDashboard?: TmuxDashboardApi;
  actions?: DashboardActions;
  logger?: Logger;
}

export interface DashboardActions {
  interruptTask(taskGuid: string, reason?: string): Promise<{ ok: boolean; message?: string }>;
  appendFeedback(taskGuid: string, details: string): Promise<{ ok: boolean; state: string }>;
}

export class DashboardServer {
  private readonly options: DashboardServerOptions;
  private readonly actionToken = randomUUID();
  private readonly auth: WebPairingAuth;
  private readonly webRoot: string;
  private readonly eventClients = new Set<ServerResponse>();
  private server: Server | null = null;
  private unsubscribeFromDatabase: (() => void) | null = null;
  private eventSequence = 0;

  constructor(options: DashboardServerOptions) {
    this.options = options;
    this.auth = options.auth
      ?? new WebPairingAuth({ db: options.db, allowLocalRequests: true });
    this.webRoot = options.webRoot ?? findWebRoot();
  }

  public start(): Promise<string> {
    if (this.server) {
      return Promise.reject(new Error("dashboard server is already running"));
    }
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.logger?.error("dashboard request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) sendJson(response, 500, { error: "internal server error" });
        else response.destroy();
      });
    });
    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.server = server;
    this.unsubscribeFromDatabase = this.options.db.subscribe((change) => this.publishChange(change));
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server = null;
        this.unsubscribeFromDatabase?.();
        this.unsubscribeFromDatabase = null;
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onError);
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : this.options.port;
        resolve(`http://${this.options.host}:${port}`);
      });
    });
  }

  public stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.unsubscribeFromDatabase?.();
    this.unsubscribeFromDatabase = null;
    for (const client of this.eventClients) client.end();
    this.eventClients.clear();
    this.options.tmuxDashboard?.stop();
    const verifierStop = this.options.tmuxVerifier?.stop() ?? Promise.resolve();
    if (!server) return verifierStop;
    return verifierStop.then(() => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/auth/status") {
      sendJson(response, 200, this.auth.status(request));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/devices") {
      const devices = this.auth.listDevices(request);
      if (!devices) {
        sendJson(response, 401, { error: "pairing required" });
        return;
      }
      sendJson(response, 200, { devices });
      return;
    }
    const deviceRevokeMatch = /^\/api\/auth\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
    if (request.method === "POST" && deviceRevokeMatch) {
      const sessionId = decodeURIComponent(deviceRevokeMatch[1]);
      if (!this.auth.revokeDevice(request, sessionId)) {
        sendJson(response, 404, { error: "device not found" });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/pairing/claim") {
      await this.claimPairing(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      this.auth.clearSession(request, response);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/revoke-all") {
      if (!this.auth.isAuthorized(request)) {
        sendJson(response, 401, { error: "pairing required" });
        return;
      }
      this.auth.revokeAll();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/tmux/") && this.options.tmuxVerifier) {
      if (!this.requireAuthorization(request, response)) return;
      await this.options.tmuxVerifier.handleApiRequest(request, response);
      return;
    }
    if (url.pathname.startsWith("/tmux-dashboard/api/") && this.options.tmuxDashboard) {
      if (!this.requireAuthorization(request, response)) return;
      await this.options.tmuxDashboard.handleRequest(request, response);
      return;
    }
    if (request.method === "GET" && isSpaRoute(url.pathname)) {
      if (
        !this.auth.isAuthorized(request)
        && url.pathname !== "/"
        && url.pathname !== "/index.html"
        && url.pathname !== "/pair-admin"
      ) {
        sendJson(response, 401, { error: "pairing required" });
        return;
      }
      await this.serveIndex(request, response);
      return;
    }
    const publicWebRequest = request.method === "GET" && !url.pathname.startsWith("/api/");
    if (!this.requireAuthorization(
      request,
      response,
      publicWebRequest || url.pathname === "/healthz",
    )) return;
    if (request.method === "GET" && url.pathname === "/api/session") {
      sendJson(response, 200, { actionToken: this.actionToken });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      this.openEventStream(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      this.listTasks(url, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/aamp/tasks") {
      this.listAampTasks(url, response);
      return;
    }
    const aampTaskMatch = /^\/api\/aamp\/tasks\/([^/]+)$/.exec(url.pathname);
    if (aampTaskMatch && request.method === "GET") {
      this.getAampTask(decodeURIComponent(aampTaskMatch[1]), response);
      return;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskMatch) {
      const taskGuid = decodeURIComponent(taskMatch[1]);
      if (request.method === "GET") {
        this.getTask(taskGuid, response);
        return;
      }
      if (request.method === "POST") {
        await this.mutateTask(taskGuid, request, response);
        return;
      }
    }
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      await this.serveAsset(url.pathname, response);
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.setHeader("Allow", "GET, POST");
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }

  private async claimPairing(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
      return;
    }
    if (typeof body.code !== "string" || !body.code.trim()) {
      sendJson(response, 400, { error: "pairing code is required" });
      return;
    }
    try {
      const token = this.auth.claimPairing(request, body.code);
      this.auth.setSessionCookie(request, response, token);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      if (error instanceof PairingRateLimitError) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
        sendJson(response, 429, { error: "too many pairing attempts" });
        return;
      }
      sendJson(response, 403, { error: error instanceof Error ? error.message : "pairing failed" });
    }
  }

  private requireAuthorization(
    request: IncomingMessage,
    response: ServerResponse,
    allowUnauthenticated = false,
  ): boolean {
    if (allowUnauthenticated || this.auth.isAuthorized(request)) return true;
    sendJson(response, 401, { error: "pairing required" });
    return false;
  }

  private listTasks(url: URL, response: ServerResponse): void {
    const rawStates = url.searchParams.getAll("state")
      .flatMap((value) => value.split(","))
      .filter(Boolean);
    const states = rawStates.filter(isTaskState);
    if (states.length !== rawStates.length) {
      sendJson(response, 400, { error: "invalid task state" });
      return;
    }
    const limit = parseInteger(url.searchParams.get("limit"), 50, 1, 200);
    const offset = parseInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
    if (limit === null || offset === null) {
      sendJson(response, 400, { error: "invalid pagination" });
      return;
    }
    const result = this.options.db.queryTasks({
      states,
      projectKey: cleanParam(url.searchParams.get("project")),
      mode: cleanParam(url.searchParams.get("mode")),
      search: cleanParam(url.searchParams.get("q")),
      limit,
      offset,
    });
    sendJson(response, 200, {
      items: result.items.map((task) => ({
        ...task,
        input: parseTaskInput(task.input_text),
        latest_run: this.options.db.getLatestRun(task.task_guid),
      })),
      total: result.total,
      limit,
      offset,
      filters: {
        states: TASK_STATES,
        projects: this.options.projects,
        modes: this.options.modes,
      },
    });
  }

  private getTask(taskGuid: string, response: ServerResponse): void {
    const task = this.options.db.getTask(taskGuid);
    if (!task) {
      sendJson(response, 404, { error: "task not found" });
      return;
    }
    sendJson(response, 200, {
      task: { ...task, input: parseTaskInput(task.input_text) },
      runs: this.options.db.listRunsForTask(taskGuid).map((run) => ({
        ...run,
        events: this.options.db.listRunEvents(run.run_id),
      })),
      outbox: this.options.db.listOutboxForTask(taskGuid),
    });
  }

  private listAampTasks(url: URL, response: ServerResponse): void {
    const rawStatuses = url.searchParams.getAll("status")
      .flatMap((value) => value.split(","))
      .filter(Boolean);
    const statuses = rawStatuses.filter(isAampTaskStatus);
    if (statuses.length !== rawStatuses.length) {
      sendJson(response, 400, { error: "invalid AAMP task status" });
      return;
    }
    const limit = parseInteger(url.searchParams.get("limit"), 50, 1, 200);
    const offset = parseInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
    if (limit === null || offset === null) {
      sendJson(response, 400, { error: "invalid pagination" });
      return;
    }
    const result = this.options.db.listAampTasks({
      statuses,
      search: cleanParam(url.searchParams.get("q")),
      limit,
      offset,
    });
    sendJson(response, 200, {
      items: result.items,
      total: result.total,
      limit,
      offset,
      statuses: AAMP_TASK_STATUSES,
    });
  }

  private getAampTask(taskId: string, response: ServerResponse): void {
    const task = this.options.db.getAampTask(taskId);
    if (!task) {
      sendJson(response, 404, { error: "AAMP task not found" });
      return;
    }
    sendJson(response, 200, { task });
  }

  private async mutateTask(
    taskGuid: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.options.actions) {
      sendJson(response, 501, { error: "dashboard actions are not configured" });
      return;
    }
    const token = request.headers["x-bridge-action-token"];
    if (!constantTimeTokenMatches(typeof token === "string" ? token : "", this.actionToken)) {
      sendJson(response, 403, { error: "invalid action token" });
      return;
    }
    const origin = request.headers.origin;
    if (origin && !this.isSameOrigin(origin)) {
      sendJson(response, 403, { error: "cross-origin action rejected" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
      return;
    }
    const action = body.action;
    if (action === "interrupt") {
      const reason = typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : "用户通过 Bridge 看板请求中断本轮执行。";
      try {
        const result = await this.options.actions.interruptTask(taskGuid, reason);
        sendJson(response, result.ok ? 200 : 409, result);
      } catch (error) {
        sendJson(response, 422, { error: error instanceof Error ? error.message : "interrupt failed" });
      }
      return;
    }
    if (action === "feedback") {
      if (typeof body.details !== "string" || !body.details.trim()) {
        sendJson(response, 400, { error: "details is required" });
        return;
      }
      try {
        const result = await this.options.actions.appendFeedback(taskGuid, body.details);
        sendJson(response, result.ok ? 200 : 409, result);
      } catch (error) {
        sendJson(response, 422, { error: error instanceof Error ? error.message : "feedback failed" });
      }
      return;
    }
    sendJson(response, 400, { error: "unknown task action" });
  }

  private async serveIndex(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const content = await readFile(resolve(this.webRoot, "index.html"), "utf8");
      const actionToken = this.auth.isAuthorized(request) ? this.actionToken : "";
      sendHtml(response, content.replace("__BRIDGE_ACTION_TOKEN__", actionToken));
    } catch (error) {
      this.options.logger?.error("dashboard assets are not built", {
        webRoot: this.webRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(response, 503, {
        error: "dashboard frontend is not built; run `bun run build` first",
      });
    }
  }

  private async serveAsset(requestPath: string, response: ServerResponse): Promise<void> {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestPath);
    } catch {
      sendJson(response, 400, { error: "invalid asset path" });
      return;
    }
    const relativePath = decodedPath.replace(/^\/+/, "");
    const filePath = resolve(this.webRoot, relativePath);
    const relativeToRoot = relative(this.webRoot, filePath);
    if (!relativeToRoot || relativeToRoot.startsWith("..") || relativeToRoot.includes("/../")) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const body = await readFile(filePath);
      setStaticHeaders(response, contentTypeFor(filePath));
      response.statusCode = 200;
      response.end(body);
    } catch {
      sendJson(response, 404, { error: "not found" });
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.auth.isAuthorized(request)) {
      socket.destroy();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname.startsWith("/api/tmux/sessions/") && this.options.tmuxVerifier) {
      void this.options.tmuxVerifier.handleApiUpgrade(request, socket, head).catch((error: unknown) => {
        this.options.logger?.warn("tmux verifier websocket failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      });
      return;
    }
    if (pathname === "/tmux-dashboard/terminal" && this.options.tmuxDashboard) {
      void this.options.tmuxDashboard.handleUpgrade(request, socket, head).catch((error: unknown) => {
        this.options.logger?.warn("tmux dashboard websocket failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      });
      return;
    }
    socket.destroy();
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse): void {
    setEventStreamHeaders(response);
    response.statusCode = 200;
    response.flushHeaders();
    response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    this.eventClients.add(response);

    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) {
        clearInterval(heartbeat);
        this.eventClients.delete(response);
        return;
      }
      response.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      this.eventClients.delete(response);
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
  }

  private publishChange(change: DatabaseChange): void {
    if (this.eventClients.size === 0) return;
    const task = this.options.db.getTask(change.taskGuid);
    const aampTask = change.aampTaskId
      ? this.options.db.getAampTask(change.aampTaskId)
      : null;
    const payload = {
      kind: change.kind,
      task: task ? { ...task, input: parseTaskInput(task.input_text) } : null,
      latest_run: task ? this.options.db.getLatestRun(change.taskGuid) : null,
      run_event: change.eventId ? this.options.db.getRunEvent(change.eventId) : null,
      outbox: task ? this.options.db.listOutboxForTask(change.taskGuid) : [],
      aamp_task: aampTask,
    };
    const message = `id: ${++this.eventSequence}\nevent: task.updated\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.eventClients) {
      if (client.writableEnded || client.destroyed) {
        this.eventClients.delete(client);
        continue;
      }
      try {
        client.write(message);
      } catch {
        this.eventClients.delete(client);
      }
    }
  }

  private isSameOrigin(origin: string): boolean {
    const server = this.server;
    const address = server?.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return origin === `http://${this.options.host}:${port}`;
  }
}

function isSpaRoute(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/index.html"
    || pathname === "/pair-admin"
    || pathname === "/tmux"
    || pathname.startsWith("/tmux/")
    || pathname === "/tmux-dashboard"
    || (pathname.startsWith("/tmux-dashboard/")
      && !pathname.startsWith("/tmux-dashboard/api/")
      && pathname !== "/tmux-dashboard/terminal");
}

function isTaskState(value: string): value is TaskState {
  return TASK_STATES.includes(value as TaskState);
}

function isAampTaskStatus(value: string): value is AampTaskStatus {
  return AAMP_TASK_STATUSES.includes(value as AampTaskStatus);
}

function cleanParam(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

function parseInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function constantTimeTokenMatches(value: string, expected: string): boolean {
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > 32 * 1024) {
    throw new Error("request body too large");
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (Buffer.byteLength(body, "utf8") > 32 * 1024) {
      throw new Error("request body too large");
    }
  }
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
}

function setStaticHeaders(response: ServerResponse, contentType: string): void {
  setSecurityHeaders(response);
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
}

function setEventStreamHeaders(response: ServerResponse): void {
  setSecurityHeaders(response);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-store");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, value: string): void {
  setSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(value);
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function findWebRoot(): string {
  const projectRoot = resolveBridgeProjectRoot(import.meta.url);
  const candidates = [
    resolve(projectRoot, "dist", "web"),
    resolve(process.cwd(), "dist", "web"),
    resolve(projectRoot, "web"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? candidates[0];
}
