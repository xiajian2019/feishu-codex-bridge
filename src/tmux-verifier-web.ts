import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, relative, resolve, dirname } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { TmuxVerifier, type TmuxStartResult, type TmuxTerminalProcess } from "./tmux-verifier.js";
import { loadTmuxProjectCatalog, resolveTmuxProject } from "./tmux-projects.js";
import type { TmuxProjectCatalog } from "./tmux-projects.js";
import type { TmuxEvent, TmuxSessionRecord } from "./tmux-verifier-store.js";
import { PairingRateLimitError, WebPairingAuth } from "./web-auth.js";

export interface TmuxVerifierWebServerOptions {
  verifier: TmuxVerifier;
  host: string;
  port: number;
  projectMapPath: string;
  bridgeDashboardUrl?: string;
  webRoot?: string;
  auth?: WebPairingAuth;
  logger?: TmuxVerifierWebLogger;
}

export interface TmuxVerifierWebLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export class TmuxVerifierWebServer {
  private readonly options: TmuxVerifierWebServerOptions;
  private readonly actionToken = randomUUID();
  private readonly auth: WebPairingAuth;
  private readonly webRoot: string;
  private readonly bridgeDashboardUrl: string;
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly terminalClients = new Set<WebSocket>();
  private server: Server | null = null;

  constructor(options: TmuxVerifierWebServerOptions) {
    this.options = options;
    this.auth = options.auth ?? new WebPairingAuth({ allowLocalRequests: true });
    this.webRoot = options.webRoot ?? findWebRoot();
    this.bridgeDashboardUrl = options.bridgeDashboardUrl ?? "http://127.0.0.1:7310/";
  }

  public start(): Promise<string> {
    if (this.server) return Promise.reject(new Error("tmux verifier server is already running"));
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.logger?.error("tmux verifier request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) sendJson(response, 500, { error: "internal server error" });
        else response.destroy();
      });
    });
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).catch((error: unknown) => {
        this.options.logger?.warn("tmux terminal websocket failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      });
    });
    this.server = server;
    return new Promise((resolvePromise, reject) => {
      const onError = (error: Error): void => {
        this.server = null;
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onError);
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : this.options.port;
        resolvePromise(`http://${this.options.host}:${port}`);
      });
    });
  }

  public stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const client of this.terminalClients) client.close();
    this.terminalClients.clear();
    this.websocketServer.close();
    if (!server) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
      server.closeIdleConnections();
    });
  }

  public getActionToken(): string {
    return this.actionToken;
  }

  public handleApiRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    return this.handle(request, response);
  }

  public handleApiUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    return this.handleUpgrade(request, socket, head);
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
    if (
      request.method === "GET"
      && (url.pathname === "/"
        || url.pathname === "/pair-admin"
        || url.pathname === "/tmux"
        || url.pathname === "/tmux/")
    ) {
      if (
        !this.auth.isAuthorized(request)
        && url.pathname !== "/"
        && url.pathname !== "/pair-admin"
      ) {
        sendJson(response, 401, { error: "pairing required" });
        return;
      }
      await this.serveIndex(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "tmux-verifier" });
      return;
    }
    if (!this.auth.isAuthorized(request) && url.pathname.startsWith("/api/")) {
      sendJson(response, 401, { error: "pairing required" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tmux/session") {
      const projectCatalog = this.projectCatalog();
      sendJson(response, 200, {
        actionToken: this.actionToken,
        tmuxSocket: this.options.verifier.getTmuxSocket(),
        bridgeDashboardUrl: this.bridgeDashboardUrl,
        projects: projectCatalog.items,
        projectMapError: projectCatalog.error ?? null,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tmux/sessions") {
      sendJson(response, 200, { items: this.publicSessions() });
      return;
    }

    const sessionMatch = /^\/api\/tmux\/sessions\/([^/]+)(?:\/(events|messages|stop))?$/.exec(url.pathname);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const subresource = sessionMatch[2];
      if (request.method === "GET" && !subresource) {
        this.getSession(sessionId, response);
        return;
      }
      if (request.method === "GET" && subresource === "events") {
        this.getEvents(sessionId, url, response);
        return;
      }
      if (request.method === "GET" && subresource === "messages") {
        this.getMessages(sessionId, response);
        return;
      }
      if (request.method === "POST" && !subresource) {
        await this.postMessage(sessionId, request, response);
        return;
      }
      if (request.method === "POST" && subresource === "stop") {
        await this.stopSession(sessionId, request, response);
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/tmux/sessions") {
      await this.startSession(request, response);
      return;
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

  private async startSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) return sendJson(response, 403, { error: "invalid action token" });
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
    }
    try {
      const result = await this.options.verifier.startSession({
        machine: stringValue(body.machine, "local"),
        cwd: resolveTmuxProject(this.options.projectMapPath, stringValue(body.projectKey)),
        initialPrompt: optionalString(body.initialPrompt),
        clientRequestId: optionalString(body.clientRequestId)
          ?? headerValue(request, "idempotency-key"),
      });
      sendJson(response, result.created ? 201 : 200, publicStartResult(result, this.options.verifier));
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private getSession(sessionId: string, response: ServerResponse): void {
    const session = this.options.verifier.getSession(sessionId);
    if (!session) {
      sendJson(response, 404, { error: "session not found" });
      return;
    }
    sendJson(response, 200, {
      session: publicSession(session, this.options.verifier),
      messages: this.options.verifier.listMessages(sessionId),
      events: this.options.verifier.listEvents(sessionId, 0, 500),
    });
  }

  private getEvents(sessionId: string, url: URL, response: ServerResponse): void {
    if (!this.options.verifier.getSession(sessionId)) {
      sendJson(response, 404, { error: "session not found" });
      return;
    }
    const after = parseInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (after === null) {
      sendJson(response, 400, { error: "invalid after cursor" });
      return;
    }
    sendJson(response, 200, {
      events: this.options.verifier.listEvents(sessionId, after, 2_000),
      next: this.options.verifier.getSession(sessionId)?.last_event_id ?? after,
    });
  }

  private getMessages(sessionId: string, response: ServerResponse): void {
    if (!this.options.verifier.getSession(sessionId)) {
      sendJson(response, 404, { error: "session not found" });
      return;
    }
    sendJson(response, 200, { messages: this.options.verifier.listMessages(sessionId) });
  }

  private async postMessage(
    sessionId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.authorized(request)) return sendJson(response, 403, { error: "invalid action token" });
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
    }
    const clientMessageId = optionalString(body.clientMessageId) ?? headerValue(request, "idempotency-key");
    if (!clientMessageId) return sendJson(response, 400, { error: "clientMessageId is required" });
    const text = optionalString(body.text);
    if (!text) return sendJson(response, 400, { error: "text is required" });
    const result = await this.options.verifier.sendMessage(sessionId, {
      clientMessageId,
      text,
      source: "web",
    });
    sendJson(response, result.accepted ? 200 : 409, result);
  }

  private async stopSession(
    sessionId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.authorized(request)) return sendJson(response, 403, { error: "invalid action token" });
    try {
      const session = await this.options.verifier.stopSession(sessionId);
      sendJson(response, 200, { session: publicSession(session, this.options.verifier) });
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.auth.isAuthorized(request)) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/api\/tmux\/sessions\/([^/]+)\/terminal$/.exec(url.pathname);
    const token = url.searchParams.get("token") ?? "";
    if (!match || !constantTimeTokenMatches(token, this.actionToken)) {
      socket.destroy();
      return;
    }
    const sessionId = decodeURIComponent(match[1]);
    if (!this.options.verifier.getSession(sessionId)) {
      socket.destroy();
      return;
    }
    const after = parseInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    this.websocketServer.handleUpgrade(request, socket, head, (client) => {
      this.terminalClients.add(client);
      void this.openTerminal(client, sessionId, after);
    });
  }

  private async openTerminal(client: WebSocket, sessionId: string, after: number): Promise<void> {
    let cursor = after;
    let terminal: TmuxTerminalProcess | null = null;
    let cleanedUp = false;
    const send = (payload: unknown): void => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
    };
    const sendEvent = (event: TmuxEvent): void => {
      if (event.event_id <= cursor) return;
      cursor = event.event_id;
      send({ type: "event", event: wireEvent(event) });
    };
    const unsubscribe = this.options.verifier.subscribe(sessionId, sendEvent);
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      unsubscribe();
      this.terminalClients.delete(client);
      terminal?.kill();
    };
    client.once("close", cleanup);
    client.once("error", cleanup);
    for (const event of this.options.verifier.listEvents(sessionId, cursor, 2_000)) sendEvent(event);
    send({
      type: "ready",
      session: publicSession(this.options.verifier.getSession(sessionId)!, this.options.verifier),
      cursor,
    });

    try {
      terminal = this.options.verifier.attachTerminal(sessionId, 80, 24);
      terminal.onData((data) => send({ type: "output", data }));
      terminal.onExit((event) => send({ type: "exit", code: event.exitCode, signal: event.signal ?? null }));
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }

    client.on("message", (raw) => {
      try {
        const parsed = parseWebSocketMessage(raw.toString());
        if (parsed.type === "input") terminal?.write(parsed.data);
        if (parsed.type === "resize") terminal?.resize(parsed.cols, parsed.rows);
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private authorized(request: IncomingMessage): boolean {
    return constantTimeTokenMatches(headerValue(request, "x-bridge-action-token") ?? "", this.actionToken);
  }

  private publicSessions(): Array<Record<string, unknown>> {
    return this.options.verifier.listSessions().map((session) => publicSession(session, this.options.verifier));
  }

  private projectCatalog(): TmuxProjectCatalog {
    return loadTmuxProjectCatalog(this.options.projectMapPath);
  }

  private async serveIndex(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const content = await readFile(resolve(this.webRoot, "index.html"), "utf8");
      const actionToken = this.auth.isAuthorized(request) ? this.actionToken : "";
      sendHtml(
        response,
        content
          .replace("__BRIDGE_ACTION_TOKEN__", actionToken)
          .replace('content="dashboard"', 'content="tmux-verifier"'),
      );
    } catch (error) {
      this.options.logger?.error("tmux verifier frontend is not built", {
        webRoot: this.webRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(response, 503, { error: "frontend is not built; run `bun run build` first" });
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
    const filePath = resolve(this.webRoot, decodedPath.replace(/^\/+/, ""));
    const relativeToRoot = relative(this.webRoot, filePath);
    if (!relativeToRoot || relativeToRoot.startsWith("..") || relativeToRoot.includes("/../")) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return sendJson(response, 404, { error: "not found" });
      setStaticHeaders(response, contentTypeFor(filePath));
      response.statusCode = 200;
      response.end(await readFile(filePath));
    } catch {
      sendJson(response, 404, { error: "not found" });
    }
  }
}

function publicStartResult(result: TmuxStartResult, verifier: TmuxVerifier): Record<string, unknown> {
  return {
    created: result.created,
    session: publicSession(result.session, verifier),
  };
}

function publicSession(session: TmuxSessionRecord, verifier: TmuxVerifier): Record<string, unknown> {
  const { codex_path: _codexPath, ...safeSession } = session;
  return {
    ...safeSession,
    attach_command: verifier.attachCommand(session.session_id),
  };
}

function parseWebSocketMessage(raw: string):
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "unknown" } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === "object"
      && value !== null
      && "type" in value
      && value.type === "input"
      && "data" in value
      && typeof value.data === "string"
    ) {
      return { type: "input", data: value.data };
    }
    if (
      typeof value === "object"
      && value !== null
      && "type" in value
      && value.type === "resize"
      && "cols" in value
      && "rows" in value
      && typeof value.cols === "number"
      && typeof value.rows === "number"
    ) {
      return {
        type: "resize",
        cols: clampTerminalDimension(value.cols),
        rows: clampTerminalDimension(value.rows),
      };
    }
  } catch {
    // The terminal client can simply ignore malformed messages.
  }
  return { type: "unknown" };
}

function wireEvent(event: TmuxEvent): TmuxEvent {
  if (event.kind !== "terminal.snapshot") return event;
  return { ...event, payload: {} };
}

function clampTerminalDimension(value: number): number {
  return Number.isFinite(value) ? Math.min(400, Math.max(2, Math.floor(value))) : 80;
}

function findWebRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "web"),
    resolve(moduleDirectory, "../dist/web"),
    resolve(moduleDirectory, "../web"),
    resolve(process.cwd(), "dist/web"),
    resolve(process.cwd(), "web"),
  ];
  return candidates.find((candidate) => {
    try {
      return requireIndex(candidate);
    } catch {
      return false;
    }
  }) ?? candidates[0];
}

function requireIndex(directory: string): boolean {
  return Boolean(directory) && existsSync(resolve(directory, "index.html"));
}

function stringValue(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error("value is required");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function parseInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > 64 * 1024) throw new Error("request body too large");
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (Buffer.byteLength(body, "utf8") > 64 * 1024) throw new Error("request body too large");
  }
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function constantTimeTokenMatches(value: string, expected: string): boolean {
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
  );
}

function setStaticHeaders(response: ServerResponse, contentType: string): void {
  setSecurityHeaders(response);
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
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
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
