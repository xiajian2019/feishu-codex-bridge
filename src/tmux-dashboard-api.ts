import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { getBunRuntime, type BunSubprocess, type BunTerminal } from "./bun-runtime.js";
import type { StateDatabase } from "./db.js";
import * as tmux from "./tmux-dashboard.js";

const API_PREFIX = "/tmux-dashboard/api";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SUBMISSION_BYTES = 32 * 1024;
const TERMINAL_SHORTCUT_SEQUENCES: Readonly<Record<string, string>> = Object.freeze({
  "codex-escape": "\u001b",
  "codex-interrupt": "\u0003",
  "codex-enter": "\r",
  "codex-tab": "\t",
  "codex-home": "\u001b[H",
  "codex-shift-tab": "\u001b[Z",
  "codex-up": "\u001b[A",
  "codex-down": "\u001b[B",
  "codex-left": "\u001b[D",
  "codex-right": "\u001b[C",
  "ctrl-d": "\u0004",
  "ctrl-z": "\u001a",
  "ctrl-l": "\u000c",
  "ctrl-a": "\u0001",
  "ctrl-e": "\u0005",
  "ctrl-r": "\u0012",
  "ctrl-w": "\u0017",
  "tmux-new-window": "\u0002c",
  "tmux-next-window": "\u0002n",
  "tmux-previous-window": "\u0002p",
  "tmux-window-list": "\u0002w",
  "tmux-zoom-pane": "\u0002z",
  "tmux-detach": "\u0002d",
  "tmux-window-1": "\u00021",
  "tmux-window-2": "\u00022",
  "tmux-window-3": "\u00023",
  "tmux-window-4": "\u00024",
  "tmux-window-5": "\u00025",
  "tmux-window-6": "\u00026",
  "tmux-window-7": "\u00027",
});
const IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);
const IMAGE_DIRECTORY = join(tmpdir(), "feishu-codex-bridge", "tmux-dashboard-images");

class DashboardBodyError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

interface TerminalData {
  sessionId: string;
  cols: number;
  rows: number;
  terminal?: BunTerminal;
  proc?: BunSubprocess;
}

export interface TmuxDashboardApiOptions {
  db: StateDatabase;
  operations?: Pick<typeof tmux, "createSession" | "findSession" | "killSession" | "listSessions">;
}

export class TmuxDashboardApi {
  private readonly db: StateDatabase;
  private readonly operations: NonNullable<TmuxDashboardApiOptions["operations"]>;
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private stopped = false;

  constructor(options: TmuxDashboardApiOptions) {
    if (!options.db) throw new Error("TmuxDashboardApi requires the Bridge state database.");
    this.db = options.db;
    this.operations = options.operations ?? tmux;
  }

  public async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const apiPath = url.pathname.slice(API_PREFIX.length);
    if (request.method === "POST" && apiPath === "/attachments") {
      const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
      const extension = IMAGE_EXTENSIONS.get(contentType);
      if (!extension) {
        sendJson(response, 415, { error: "Choose a PNG, JPEG, GIF, or WebP image." });
        return;
      }
      try {
        const image = await readBinaryBody(request, MAX_IMAGE_BYTES);
        if (image.length === 0) throw new DashboardBodyError("The selected image is empty.", 400);
        await mkdir(IMAGE_DIRECTORY, { recursive: true, mode: 0o700 });
        const imagePath = join(IMAGE_DIRECTORY, randomUUID() + extension);
        await writeFile(imagePath, image, { flag: "wx", mode: 0o600 });
        sendJson(response, 201, { path: imagePath });
      } catch (error) {
        if (error instanceof DashboardBodyError) {
          sendJson(response, error.statusCode, { error: error.message });
        } else {
          sendJson(response, 500, { error: "Could not store the image attachment." });
        }
      }
      return;
    }
    if (request.method === "GET" && apiPath === "/projects") {
      sendJson(response, 200, {
        projects: this.db.listAvailableProjects().map((project) => ({ name: project.name, root: project.path })),
      });
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
        const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim() : "";
        const project = this.db.getAvailableProject(projectKey);
        if (!project) throw new Error("所选项目不可用，请刷新项目列表。");
        sendJson(response, 201, { session: await this.operations.createSession(body.name.trim(), project.path) });
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
    client.on("message", async (message, isBinary) => {
      if (isBinary) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message.toString());
      } catch {
        return;
      }
      if (typeof payload !== "object" || payload === null) return;
      const control = payload as { type?: unknown; data?: unknown; text?: unknown; key?: unknown; requestId?: unknown; cols?: unknown; rows?: unknown };
      if (
        control.type === "scroll"
        && typeof control.data === "string"
        && /^\u001b\[<6[45];\d{1,3};\d{1,3}M$/.test(control.data)
      ) {
        data.terminal?.write(control.data);
        return;
      }
      if (control.type === "submit" || control.type === "key" || control.type === "sequence") {
        const requestId = typeof control.requestId === "string" && control.requestId.length <= 80
          ? control.requestId
          : "";
        const reply = (ok: boolean, message?: string): void => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "submission-result",
              requestId,
              ok,
              ...(message ? { message } : {}),
            }));
          }
        };
        if (control.type === "key") {
          const sequence = typeof control.key === "string" && Object.hasOwn(TERMINAL_SHORTCUT_SEQUENCES, control.key)
            ? TERMINAL_SHORTCUT_SEQUENCES[control.key]
            : undefined;
          if (!sequence) {
            reply(false, "Unsupported terminal shortcut.");
            return;
          }
          if (!data.terminal) {
            reply(false, "The tmux session is not attached.");
            return;
          }
          try {
            data.terminal.write(sequence);
            reply(true);
          } catch {
            reply(false, "Could not send the shortcut to the tmux session.");
          }
          return;
        }
        if (control.type === "sequence") {
          const sequence = typeof control.data === "string"
            && control.data.length <= 80
            && /^[\u0001-\u0009\u000B-\u001F\u0020-\u007E]+$/.test(control.data)
            ? control.data
            : undefined;
          if (!sequence) {
            reply(false, "Unsupported control-key sequence.");
            return;
          }
          if (!data.terminal) {
            reply(false, "The tmux session is not attached.");
            return;
          }
          try {
            data.terminal.write(sequence);
            reply(true);
          } catch {
            reply(false, "Could not send the control-key sequence to the tmux session.");
          }
          return;
        }
        if (typeof control.text !== "string") {
          reply(false, "The message must be text.");
          return;
        }
        const text = control.text
          .replace(/\r\n?/g, "\n")
          .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
        if (!text.trim()) {
          reply(false, "Enter a message or attach an image.");
          return;
        }
        if (Buffer.byteLength(text, "utf8") > MAX_SUBMISSION_BYTES) {
          reply(false, "The message is too long.");
          return;
        }
        if (!data.terminal) {
          reply(false, "The tmux session is not attached.");
          return;
        }
        const paneBefore = await tmux.capturePane(data.sessionId).catch(() => null);
        if (paneBefore === null) {
          reply(false, "消息未发送：无法读取 session 当前状态，请稍后重试。");
          return;
        }
        try {
          data.terminal.write("\u001b[200~" + text + "\u001b[201~\r");
          const confirmed = await waitForPaneChange(data.sessionId, paneBefore, text);
          reply(
            confirmed,
            confirmed
              ? undefined
              : "消息已写入终端，但 session 未确认接收；输入已保留，请检查连接后重试。",
          );
        } catch {
          reply(false, "Could not send the message to the tmux session.");
        }
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

async function waitForPaneChange(sessionId: string, before: string, submittedText: string): Promise<boolean> {
  const messageForEcho = submittedText.split(/<image\s+name=/i, 1)[0].trim() || "请打开并查看我附上的图片";
  const expected = normalizePaneText(messageForEcho);
  const expectedCompact = expected.replace(/\s+/g, "");
  const expectedSnippet = expected.slice(0, 64);
  const expectedCompactSnippet = expectedCompact.slice(0, 64);
  for (const delay of [120, 280, 560, 1_120, 2_240]) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      const after = await tmux.capturePane(sessionId);
      if (
        after !== before
        && (
          normalizePaneText(after).includes(expectedSnippet)
          || normalizePaneText(after).replace(/\s+/g, "").includes(expectedCompactSnippet)
        )
      ) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function normalizePaneText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

async function readBinaryBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new DashboardBodyError("Image must be 10 MB or smaller.", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new DashboardBodyError("Image must be 10 MB or smaller.", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
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
