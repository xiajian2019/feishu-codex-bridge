import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { getBunRuntime, type BunSubprocess, type BunTerminal } from "./bun-runtime.js";
import { getProjectMapPath, parseProjectMap } from "./tmux-dashboard-projects.js";
import * as tmux from "./tmux-dashboard.js";

const API_PREFIX = "/tmux-dashboard/api";

interface TerminalData {
  sessionId: string;
  cols: number;
  rows: number;
  terminal?: BunTerminal;
  proc?: BunSubprocess;
}

export interface TmuxDashboardApiOptions {
  projectMapPath?: string;
  operations?: Pick<typeof tmux, "createSession" | "findSession" | "killSession" | "listSessions">;
}

export class TmuxDashboardApi {
  private readonly projectMapPath: string;
  private readonly operations: NonNullable<TmuxDashboardApiOptions["operations"]>;
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private stopped = false;

  constructor(options: TmuxDashboardApiOptions = {}) {
    this.projectMapPath = options.projectMapPath
      ?? getProjectMapPath(homedir(), process.env.TMUX_DASHBOARD_PROJECT_MAP);
    this.operations = options.operations ?? tmux;
  }

  public async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const apiPath = url.pathname.slice(API_PREFIX.length);
    if (request.method === "GET" && apiPath === "/projects") {
      try {
        sendJson(response, 200, { projects: parseProjectMap(await readFile(this.projectMapPath, "utf8")) });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    if (request.method === "GET" && apiPath === "/sessions") {
      try {
        sendJson(response, 200, { sessions: await this.operations.listSessions() });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    if (request.method === "POST" && apiPath === "/sessions") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Expected a JSON request body." });
        return;
      }
      if (typeof body.name !== "string") {
        sendJson(response, 400, { error: "A session name is required." });
        return;
      }
      try {
        const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
        sendJson(response, 201, { session: await this.operations.createSession(body.name.trim(), cwd) });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const deleteMatch = /^\/sessions\/(.+)$/.exec(apiPath);
    if (request.method === "DELETE" && deleteMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(deleteMatch[1]);
      } catch {
        sendJson(response, 400, { error: "Invalid tmux session id." });
        return;
      }
      try {
        await this.operations.killSession(sessionId);
        sendEmpty(response, 204);
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  }

  public async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/tmux-dashboard/terminal") {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    try {
      if (!origin || new URL(origin).host !== request.headers.host) {
        rejectUpgrade(socket, 403, "Cross-origin terminal connections are not allowed.");
        return;
      }
    } catch {
      rejectUpgrade(socket, 403, "Cross-origin terminal connections are not allowed.");
      return;
    }

    const sessionId = url.searchParams.get("session") || "";
    if (!tmux.isSessionId(sessionId) || !(await this.operations.findSession(sessionId))) {
      rejectUpgrade(socket, 404, "tmux session not found.");
      return;
    }
    const cols = clampDimension(Number(url.searchParams.get("cols")), 20, 400) || 80;
    const rows = clampDimension(Number(url.searchParams.get("rows")), 5, 200) || 24;
    this.websocketServer.handleUpgrade(request, socket, head, (client) => {
      this.clients.add(client);
      this.openTerminal(client, { sessionId, cols, rows });
    });
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const client of this.clients) client.close(1001, "Server shutting down");
    this.clients.clear();
    this.websocketServer.close();
  }

  private openTerminal(client: WebSocket, data: TerminalData): void {
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.clients.delete(client);
      if (data.proc && !data.proc.killed) data.proc.kill("SIGTERM");
      data.terminal?.close();
    };
    client.once("close", cleanup);
    client.once("error", cleanup);
    client.on("message", (message, isBinary) => {
      if (isBinary) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message.toString());
      } catch {
        return;
      }
      if (typeof payload !== "object" || payload === null) return;
      const control = payload as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
      if (control.type === "input" && typeof control.data === "string") {
        data.terminal?.write(control.data);
        return;
      }
      if (control.type === "resize") {
        const cols = clampDimension(control.cols, 20, 400);
        const rows = clampDimension(control.rows, 5, 200);
        if (!cols || !rows) return;
        data.terminal?.resize(cols, rows);
        if (data.proc && !data.proc.killed) {
          try {
            data.proc.kill("SIGWINCH");
          } catch {
            return;
          }
        }
      }
    });

    try {
      const child = getBunRuntime().spawn(["tmux", "attach-session", "-t", data.sessionId], {
        env: {
          ...process.env,
          TMUX: undefined,
          TMUX_PANE: undefined,
          TERM: "xterm-256color",
        },
        terminal: {
          cols: data.cols,
          rows: data.rows,
          name: "xterm-256color",
          data: (_terminal, output) => {
            if (client.readyState === WebSocket.OPEN) client.send(output);
          },
        },
      });
      data.proc = child;
      data.terminal = child.terminal;
      void child.exited.then((exitCode) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "exit", code: exitCode }));
          client.close();
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not attach to tmux session.";
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "error", message }));
        client.close(1011, "Could not attach to tmux session.");
      }
    }
  }
}

function clampDimension(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > 64 * 1024) throw new Error("request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sendDashboardError(response: ServerResponse, error: unknown): void {
  const status = error instanceof tmux.ValidationError ? 400 : error instanceof tmux.SessionNotFoundError ? 404 : 500;
  sendJson(response, status, { error: error instanceof Error ? error.message : "Unexpected server error." });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.statusCode = status;
  response.end();
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}
