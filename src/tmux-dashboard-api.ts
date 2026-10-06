import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, realpath, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { getBunRuntime, type BunSubprocess, type BunTerminal } from "./bun-runtime.js";
import { discoverCodexHistoryHomes, type CodexHistoryHome } from "./codex-history.js";
import type { StateDatabase } from "./db.js";
import type { StoredTmuxSessionAction } from "./types.js";
import * as tmux from "./tmux-dashboard.js";

const API_PREFIX = "/tmux-dashboard/api";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SUBMISSION_BYTES = 32 * 1024;
const MAX_SCROLL_DIAGNOSTIC_EXPORT_BYTES = 5 * 1024 * 1024;
const MAX_SCROLL_DIAGNOSTIC_ENTRIES = 2_000;
const SUBMIT_FAST_FLUSH_WINDOW_MS = 5_000;
const SUBMIT_FAST_FLUSH_IDLE_MS = 250;
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
  "tmux-send-prefix": "\u0002\u0002",
  "tmux-rotate-pane": "\u0002o",
  "tmux-suspend": "\u0002\u001a",
  "tmux-break-pane": "\u0002!",
  "tmux-split-horizontal": "\u0002\"",
  "tmux-list-buffers": "\u0002#",
  "tmux-rename-session": "\u0002$",
  "tmux-split-vertical": "\u0002%",
  "tmux-kill-window": "\u0002&",
  "tmux-select-window-prompt": "\u0002'",
  "tmux-previous-session": "\u0002(",
  "tmux-next-session": "\u0002)",
  "tmux-new-floating-pane": "\u0002*",
  "tmux-rename-window": "\u0002,",
  "tmux-delete-buffer": "\u0002-",
  "tmux-move-window-prompt": "\u0002.",
  "tmux-window-0": "\u00020",
  "tmux-window-1": "\u00021",
  "tmux-window-2": "\u00022",
  "tmux-window-3": "\u00023",
  "tmux-window-4": "\u00024",
  "tmux-window-5": "\u00025",
  "tmux-window-6": "\u00026",
  "tmux-window-7": "\u00027",
  "tmux-window-8": "\u00028",
  "tmux-window-9": "\u00029",
  "tmux-command-prompt": "\u0002:",
  "tmux-last-pane": "\u0002;",
  "tmux-choose-buffer": "\u0002=",
  "tmux-list-keys": "\u0002?",
  "tmux-detach-client": "\u0002D",
  "tmux-last-session": "\u0002L",
  "tmux-copy-mode": "\u0002[",
  "tmux-paste-buffer": "\u0002]",
  "tmux-find-window": "\u0002f",
  "tmux-display-window-info": "\u0002i",
  "tmux-last-window": "\u0002l",
  "tmux-mark-pane": "\u0002m",
  "tmux-clear-mark": "\u0002M",
  "tmux-display-pane-index": "\u0002q",
  "tmux-refresh-client": "\u0002r",
  "tmux-choose-session": "\u0002s",
  "tmux-display-time": "\u0002t",
  "tmux-set-pane-title": "\u0002T",
  "tmux-kill-pane": "\u0002x",
  "tmux-choose-tree": "\u0002\t",
  "tmux-swap-pane-up": "\u0002{",
  "tmux-swap-pane-down": "\u0002}",
  "tmux-floating-g1": "\u0002g1",
  "tmux-floating-g2": "\u0002g2",
  "tmux-floating-g3": "\u0002g3",
  "tmux-floating-g4": "\u0002g4",
  "tmux-floating-up": "\u0002g\u001b[A",
  "tmux-floating-down": "\u0002g\u001b[B",
  "tmux-floating-left": "\u0002g\u001b[D",
  "tmux-floating-right": "\u0002g\u001b[C",
  "tmux-show-messages": "\u0002~",
  "tmux-copy-mode-page-up": "\u0002\u001b[5~",
  "tmux-select-pane-up": "\u0002\u001b[A",
  "tmux-select-pane-down": "\u0002\u001b[B",
  "tmux-select-pane-left": "\u0002\u001b[D",
  "tmux-select-pane-right": "\u0002\u001b[C",
  "tmux-layout-m1": "\u0002\u001b1",
  "tmux-layout-m2": "\u0002\u001b2",
  "tmux-layout-m3": "\u0002\u001b3",
  "tmux-layout-m4": "\u0002\u001b4",
  "tmux-layout-m5": "\u0002\u001b5",
  "tmux-layout-m6": "\u0002\u001b6",
  "tmux-layout-m7": "\u0002\u001b7",
  "tmux-next-layout": "\u0002 ",
  "tmux-next-alert-window": "\u0002\u001bn",
  "tmux-rotate-pane-backward": "\u0002\u001bo",
  "tmux-previous-alert-window": "\u0002\u001bp",
  "tmux-resize-pane-up": "\u0002\u001b[1;5A",
  "tmux-resize-pane-down": "\u0002\u001b[1;5B",
  "tmux-resize-pane-left": "\u0002\u001b[1;5D",
  "tmux-resize-pane-right": "\u0002\u001b[1;5C",
  "tmux-resize-pane-5-up": "\u0002\u001b[1;3A",
  "tmux-resize-pane-5-down": "\u0002\u001b[1;3B",
  "tmux-resize-pane-5-left": "\u0002\u001b[1;3D",
  "tmux-resize-pane-5-right": "\u0002\u001b[1;3C",
});
const ATTACHMENT_DIRECTORY = join(homedir(), ".feishu-codex-bridge", "tmux-dashboard-attachments");
const LEGACY_ATTACHMENT_DIRECTORY = join(tmpdir(), "feishu-codex-bridge", "tmux-dashboard-attachments");
const IMAGE_ATTACHMENT_FILENAME = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
const IMAGE_ATTACHMENT_TAG = /<image name=\[Image #(\d+)\] path="([^"\r\n]+)">/g;
const SUBMISSION_ATTACHMENT_TAG = /<(?:image name=\[Image #\d+\]|file name="[^"\r\n]*") path="([^"\r\n]+)">/g;

class DashboardBodyError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

interface TerminalData {
  sessionId: string;
  sessionRecordId: string;
  deviceId: string | null;
  cols: number;
  rows: number;
  terminal?: BunTerminal;
  proc?: BunSubprocess;
}

export interface TmuxDashboardApiOptions {
  db: StateDatabase;
  operations?: Pick<typeof tmux, "createSession" | "findSession" | "killSession" | "listSessions">
    & Partial<Pick<typeof tmux, "inspectCodexHome" | "setCodexHomeForSession">>;
}

export class TmuxDashboardApi {
  private readonly db: StateDatabase;
  private readonly operations: NonNullable<TmuxDashboardApiOptions["operations"]>;
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private stopped = false;
  private attachmentStorageReady: Promise<void> | null = null;

  constructor(options: TmuxDashboardApiOptions) {
    if (!options.db) throw new Error("TmuxDashboardApi requires the Bridge state database.");
    this.db = options.db;
    this.operations = { ...tmux, ...options.operations };
  }

  public async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string | null = null,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const apiPath = url.pathname.slice(API_PREFIX.length);
    if (request.method === "POST" && apiPath === "/scroll-diagnostics/export") {
      const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/x-www-form-urlencoded") {
        sendJson(response, 415, { error: "Expected a scroll diagnostic form submission." });
        return;
      }
      let body: Buffer;
      try {
        body = await readBinaryBody(request, MAX_SCROLL_DIAGNOSTIC_EXPORT_BYTES, "Scroll diagnostic export must be 5 MB or smaller.");
      } catch {
        sendJson(response, 413, { error: "Scroll diagnostic export is too large." });
        return;
      }
      const payloadText = new URLSearchParams(body.toString("utf8")).get("payload");
      if (!payloadText) {
        sendJson(response, 400, { error: "Scroll diagnostic payload is missing." });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(payloadText) as unknown;
      } catch {
        sendJson(response, 400, { error: "Scroll diagnostic payload is invalid JSON." });
        return;
      }
      if (
        typeof payload !== "object"
        || payload === null
        || !Array.isArray((payload as Record<string, unknown>).entries)
        || (payload as { entries: unknown[] }).entries.length > MAX_SCROLL_DIAGNOSTIC_ENTRIES
      ) {
        sendJson(response, 400, { error: "Scroll diagnostic payload has an invalid entry list." });
        return;
      }
      const now = new Date();
      const filename = `tmux-scroll-diagnostics-${now.toISOString().replace(/[:.]/g, "-")}.json`;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      response.end(JSON.stringify(payload, null, 2));
      return;
    }
    const imageMatch = /^\/attachments\/images\/([^/]+)$/.exec(apiPath);
    if (request.method === "GET" && imageMatch) {
      let fileName: string;
      try {
        fileName = decodeURIComponent(imageMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "Invalid image attachment." });
        return;
      }
      if (!IMAGE_ATTACHMENT_FILENAME.test(fileName)) {
        sendJson(response, 400, { error: "Invalid image attachment." });
        return;
      }
      try {
        await this.ensureAttachmentStorage();
        const filePath = await this.findImageAttachmentPath(fileName);
        if (!filePath) {
          sendJson(response, 404, { error: "Image attachment not found." });
          return;
        }
        const fileInfo = await lstat(filePath);
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Type", imageContentType(fileName));
        response.setHeader("Content-Length", String(fileInfo.size));
        response.setHeader("Content-Disposition", "inline");
        const stream = createReadStream(filePath);
        stream.on("error", () => {
          if (!response.headersSent) sendJson(response, 404, { error: "Image attachment is no longer available." });
          else response.destroy();
        });
        stream.pipe(response);
      } catch {
        sendJson(response, 500, { error: "Could not read the image attachment." });
      }
      return;
    }
    if (request.method === "POST" && apiPath === "/attachments") {
      try {
        const attachment = await readBinaryBody(request, MAX_ATTACHMENT_BYTES, "Attachment must be 10 MB or smaller.");
        if (attachment.length === 0) throw new DashboardBodyError("The selected attachment is empty.", 400);
        const fileNameHeader = request.headers["x-file-name"];
        const encodedFileName = Array.isArray(fileNameHeader) ? fileNameHeader[0] ?? "" : fileNameHeader ?? "";
        let fileName = encodedFileName;
        try {
          fileName = decodeURIComponent(encodedFileName);
        } catch {
          // Fall back to the raw header and still keep only its safe extension.
        }
        const requestedExtension = extname(basename(fileName)).toLowerCase();
        const contentTypeHeader = request.headers["content-type"];
        const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader)?.split(";")[0]?.trim().toLowerCase() ?? "";
        const extension = imageExtensionForContentType(contentType)
          ?? (/^\.[a-z0-9]{1,12}$/.test(requestedExtension) ? requestedExtension : ".bin");
        await this.ensureAttachmentStorage();
        const attachmentPath = join(ATTACHMENT_DIRECTORY, randomUUID() + extension);
        await writeFile(attachmentPath, attachment, { flag: "wx", mode: 0o600 });
        sendJson(response, 201, { path: attachmentPath });
      } catch (error) {
        if (error instanceof DashboardBodyError) {
          sendJson(response, error.statusCode, { error: error.message });
        } else {
          sendJson(response, 500, { error: "Could not store the attachment." });
        }
      }
      return;
    }
    const fileListMatch = /^\/sessions\/([^/]+)\/files$/.exec(apiPath);
    if (request.method === "GET" && fileListMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(fileListMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "Invalid tmux session id." });
        return;
      }
      try {
        sendJson(response, 200, await this.listSessionFiles(sessionId, url.searchParams.get("path") ?? ""));
      } catch (error) {
        sendSessionFileError(response, error);
      }
      return;
    }
    const uploadMatch = /^\/sessions\/([^/]+)\/files\/upload$/.exec(apiPath);
    if (request.method === "POST" && uploadMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(uploadMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "Invalid tmux session id." });
        return;
      }
      try {
        const uploaded = await readBinaryBody(
          request,
          MAX_SESSION_FILE_UPLOAD_BYTES,
          "File uploads must be 100 MB or smaller.",
        );
        const fileNameHeader = request.headers["x-file-name"];
        const encodedFileName = Array.isArray(fileNameHeader) ? fileNameHeader[0] ?? "" : fileNameHeader ?? "";
        let requestedFileName = encodedFileName;
        try {
          requestedFileName = decodeURIComponent(encodedFileName);
        } catch {
          // Fall back to the raw header, then strip any path components below.
        }
        const fileName = sanitizeSessionFileName(requestedFileName);
        const filePath = url.searchParams.get("path") ?? "";
        const context = await this.getSessionFileContext(sessionId, filePath);
        if (!(await stat(context.absolutePath)).isDirectory()) {
          throw new DashboardBodyError("Choose a directory before uploading.", 400);
        }
        const targetPath = join(context.absolutePath, fileName);
        const temporaryPath = join(context.absolutePath, `.bridge-upload-${randomUUID()}.tmp`);
        try {
          await writeFile(temporaryPath, uploaded, { flag: "wx", mode: 0o600 });
          await link(temporaryPath, targetPath);
        } finally {
          await unlink(temporaryPath).catch(() => undefined);
        }
        sendJson(response, 201, { name: fileName, path: [context.path, fileName].filter(Boolean).join("/") });
      } catch (error) {
        sendSessionFileError(response, error);
      }
      return;
    }
    const downloadMatch = /^\/sessions\/([^/]+)\/files\/download$/.exec(apiPath);
    if (request.method === "GET" && downloadMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(downloadMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "Invalid tmux session id." });
        return;
      }
      try {
        const context = await this.getSessionFileContext(sessionId, url.searchParams.get("path") ?? "");
        const fileStat = await stat(context.absolutePath);
        if (!fileStat.isFile()) throw new DashboardBodyError("Select a file to download.", 400);
        const fileName = basename(context.absolutePath);
        const fallbackName = fileName.replace(/[^\x20-\x7e]|[\\";]/g, "_") || "download";
        const encodedName = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", String(fileStat.size));
        response.setHeader("Content-Disposition", `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
        const stream = createReadStream(context.absolutePath);
        stream.on("error", () => {
          if (!response.headersSent) sendJson(response, 404, { error: "File is no longer available." });
          else response.destroy();
        });
        stream.pipe(response);
      } catch (error) {
        sendSessionFileError(response, error);
      }
      return;
    }
    if (request.method === "GET" && apiPath === "/projects") {
      sendJson(response, 200, {
        projects: this.db.listAvailableProjects().map((project) => ({ name: project.name, root: project.path })),
      });
      return;
    }
    if (request.method === "GET" && apiPath === "/history") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
        || !Number.isSafeInteger(offset) || offset < 0) {
        sendJson(response, 400, { error: "limit must be 1..200 and offset a non-negative integer" });
        return;
      }
      try {
        this.db.syncTmuxSessions(await this.operations.listSessions());
      } catch {
        // Historical records remain readable while the tmux server is unavailable.
      }
      await this.ensureAttachmentStorage().catch(() => undefined);
      const session = url.searchParams.get("session")?.trim();
      const search = url.searchParams.get("q")?.trim();
      const result = this.db.listTmuxSessionActions({
        limit,
        offset,
        tmuxSessionId: session || undefined,
        search: search || undefined,
      });
      const sessionInfo = session ? this.db.getLatestTmuxSession(session) : null;
      sendJson(response, 200, {
        ...result,
        items: await Promise.all(result.items.map((item) => this.tmuxSessionActionView(item))),
        session: sessionInfo ? {
          session_name: sessionInfo.session_name,
          project_key: sessionInfo.project_key,
          working_directory: sessionInfo.working_directory,
          ended_at: sessionInfo.ended_at,
        } : null,
        limit,
        offset,
      });
      return;
    }
    if (request.method === "GET" && apiPath === "/sessions") {
      try {
        const sessions = await this.operations.listSessions();
        this.db.syncTmuxSessions(sessions);
        sendJson(response, 200, {
          sessions: sessions.map((session) => ({
            ...session,
            codexHomeId: this.db.getLatestTmuxSession(session.id)?.codex_home_id ?? null,
          })),
          codexHomes: this.codexHomeOptions().map(({ id, label, available }) => ({ id, label, available })),
        });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const codexAccountCheckMatch = /^\/sessions\/([^/]+)\/codex-account\/check$/.exec(apiPath);
    if (request.method === "POST" && codexAccountCheckMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(codexAccountCheckMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "Invalid tmux session id." });
        return;
      }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
        const inspection = this.operations.inspectCodexHome
          ? await this.operations.inspectCodexHome(sessionId)
          : { status: "unavailable" as const };
        if (inspection.status !== "running" || !inspection.path) {
          sendJson(response, 200, { status: inspection.status, home: null });
          return;
        }
        const home = this.codexHomeOptions().find((candidate) => resolve(candidate.path) === resolve(inspection.path!));
        if (!home || !home.available) {
          sendJson(response, 200, { status: "unmatched", home: null });
          return;
        }
        await this.operations.setCodexHomeForSession?.(sessionId, home.path);
        this.db.recordTmuxSession(session);
        const saved = this.db.setTmuxSessionCodexHome(sessionId, home.id);
        sendJson(response, 200, {
          status: "matched",
          home: { id: home.id, label: home.label },
          session: saved ? { id: session.id, codexHomeId: saved.codex_home_id } : null,
        });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const codexAccountMatch = /^\/sessions\/([^/]+)\/codex-account$/.exec(apiPath);
    if (request.method === "POST" && codexAccountMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(codexAccountMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "Invalid tmux session id." });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Expected a JSON request body." });
        return;
      }
      const homeId = body.homeId === null || body.homeId === ""
        ? null
        : typeof body.homeId === "string" ? body.homeId.trim() : undefined;
      if (homeId === undefined || (homeId !== null && !homeId)) {
        sendJson(response, 400, { error: "Choose a Codex account or clear the account marker." });
        return;
      }
      const home = homeId === null ? null : this.codexHomeOptions().find((candidate) => candidate.id === homeId);
      if (homeId !== null && (!home || !home.available)) {
        sendJson(response, 400, { error: "The selected Codex Home is unavailable." });
        return;
      }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
        await this.operations.setCodexHomeForSession?.(sessionId, home?.path ?? null);
        this.db.recordTmuxSession(session);
        const saved = this.db.setTmuxSessionCodexHome(sessionId, homeId);
        if (!saved) throw new tmux.SessionNotFoundError("tmux session record not found.");
        sendJson(response, 200, {
          session: { id: session.id, codexHomeId: saved.codex_home_id },
          home: home ? { id: home.id, label: home.label } : null,
        });
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
        const session = await this.operations.createSession(body.name.trim(), project.path);
        this.db.recordTmuxSession(session, { projectKey, createdByDeviceId: deviceId });
        sendJson(response, 201, { session: { ...session, codexHomeId: null } });
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
        this.db.markTmuxSessionEnded(sessionId);
        sendEmpty(response, 204);
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  }

  public async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    deviceId: string | null = null,
  ): Promise<void> {
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
    const session = tmux.isSessionId(sessionId) ? await this.operations.findSession(sessionId) : undefined;
    if (!session) {
      rejectUpgrade(socket, 404, "tmux session not found.");
      return;
    }
    const storedSession = this.db.recordTmuxSession(session);
    const cols = clampDimension(Number(url.searchParams.get("cols")), 20, 400) || 80;
    const rows = clampDimension(Number(url.searchParams.get("rows")), 5, 200) || 24;
    this.websocketServer.handleUpgrade(request, socket, head, (client) => {
      this.clients.add(client);
      this.openTerminal(client, {
        sessionId,
        sessionRecordId: storedSession.record_id,
        deviceId,
        cols,
        rows,
      });
    });
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const client of this.clients) client.close(1001, "Server shutting down");
    this.clients.clear();
    this.websocketServer.close();
  }

  private ensureAttachmentStorage(): Promise<void> {
    if (!this.attachmentStorageReady) {
      this.attachmentStorageReady = this.migrateAttachmentStorage().catch((error: unknown) => {
        this.attachmentStorageReady = null;
        throw error;
      });
    }
    return this.attachmentStorageReady;
  }

  private async migrateAttachmentStorage(): Promise<void> {
    const dataDirectory = join(homedir(), ".feishu-codex-bridge");
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    await mkdir(ATTACHMENT_DIRECTORY, { recursive: true, mode: 0o700 });
    await chmod(ATTACHMENT_DIRECTORY, 0o700);
    if (LEGACY_ATTACHMENT_DIRECTORY === ATTACHMENT_DIRECTORY) return;

    const legacyFiles = await readdir(LEGACY_ATTACHMENT_DIRECTORY).catch((error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") return [];
      throw error;
    });
    for (const fileName of legacyFiles) {
      if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.[a-z\d]{1,12}$/i.test(fileName)) continue;
      const sourcePath = join(LEGACY_ATTACHMENT_DIRECTORY, fileName);
      const sourceInfo = await lstat(sourcePath).catch(() => null);
      if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) continue;
      const targetPath = join(ATTACHMENT_DIRECTORY, fileName);
      try {
        await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
        await chmod(targetPath, 0o600);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code !== "EEXIST") throw error;
      }
    }
  }

  private async findImageAttachmentPath(fileName: string): Promise<string | null> {
    for (const directory of [ATTACHMENT_DIRECTORY, LEGACY_ATTACHMENT_DIRECTORY]) {
      const filePath = join(directory, fileName);
      const fileInfo = await lstat(filePath).catch(() => null);
      if (fileInfo?.isFile() && !fileInfo.isSymbolicLink() && fileInfo.size <= MAX_ATTACHMENT_BYTES) return filePath;
    }
    return null;
  }

  private codexHomeOptions(): CodexHistoryHome[] {
    return discoverCodexHistoryHomes();
  }

  private async tmuxSessionActionView(item: StoredTmuxSessionAction): Promise<StoredTmuxSessionAction & {
    imageAttachments: Array<{ name: string; url: string }>;
  }> {
    const candidates: Array<{ name: string; fileName: string }> = [];
    const content = item.content.replace(IMAGE_ATTACHMENT_TAG, (_tag, index: string, path: string) => {
      const fileName = basename(path);
      if (IMAGE_ATTACHMENT_FILENAME.test(fileName)) candidates.push({ name: `Image #${index}`, fileName });
      return "";
    }).replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, "\n\n").trim();
    const imageAttachments = (await Promise.all(candidates.map(async (candidate) => {
      if (!await this.findImageAttachmentPath(candidate.fileName)) return null;
      return {
        name: candidate.name,
        url: `${API_PREFIX}/attachments/images/${encodeURIComponent(candidate.fileName)}`,
      };
    }))).filter((candidate): candidate is { name: string; url: string } => candidate !== null);
    return { ...item, content, imageAttachments };
  }

  private async getSessionFileContext(sessionId: string, requestedPath: string): Promise<SessionFileContext> {
    if (!tmux.isSessionId(sessionId)) throw new DashboardBodyError("Invalid tmux session id.", 400);
    const session = await this.operations.findSession(sessionId);
    if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
    const rootPath = await realpath(session.cwd).catch(() => {
      throw new DashboardBodyError("The session working directory is unavailable.", 404);
    });
    const relativePath = normalizeSessionRelativePath(requestedPath);
    const candidatePath = resolve(rootPath, relativePath);
    if (!isPathInside(rootPath, candidatePath)) {
      throw new DashboardBodyError("The requested path is outside the session directory.", 400);
    }
    const absolutePath = await realpath(candidatePath);
    if (!isPathInside(rootPath, absolutePath)) {
      throw new DashboardBodyError("The requested path is outside the session directory.", 403);
    }
    return {
      session,
      rootPath,
      absolutePath,
      path: relative(rootPath, absolutePath).split(sep).join("/"),
    };
  }

  private async listSessionFiles(sessionId: string, requestedPath: string): Promise<{
    session: { id: string; name: string };
    root: string;
    path: string;
    entries: Array<{ name: string; type: "directory" | "file"; size: number; modifiedAt: number }>;
  }> {
    const context = await this.getSessionFileContext(sessionId, requestedPath);
    if (!(await stat(context.absolutePath)).isDirectory()) {
      throw new DashboardBodyError("The selected path is not a directory.", 400);
    }
    const names = await readdir(context.absolutePath);
    const entries = [] as Array<{ name: string; type: "directory" | "file"; size: number; modifiedAt: number }>;
    for (const name of names.slice(0, 2_000)) {
      const entryPath = join(context.absolutePath, name);
      const entryStat = await lstat(entryPath).catch(() => null);
      if (!entryStat || entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        entries.push({ name, type: "directory", size: 0, modifiedAt: entryStat.mtimeMs });
      } else if (entryStat.isFile()) {
        entries.push({ name, type: "file", size: entryStat.size, modifiedAt: entryStat.mtimeMs });
      }
    }
    entries.sort((left, right) => Number(right.type === "directory") - Number(left.type === "directory")
      || left.name.localeCompare(right.name));
    return {
      session: { id: context.session.id, name: context.session.name },
      root: context.rootPath,
      path: context.path,
      entries,
    };
  }

  private async openTerminal(client: WebSocket, data: TerminalData): Promise<void> {
    let cleanedUp = false;
    let initialScreenReady = false;
    let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let outputBytes = 0;
    let immediateOutputFlushUntil = 0;
    const outputQueue: Array<string | Uint8Array> = [];
    const flushOutput = (): void => {
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
      outputBytes = 0;
      if (client.readyState !== WebSocket.OPEN || outputQueue.length === 0) {
        outputQueue.length = 0;
        return;
      }
      const chunks = outputQueue.splice(0);
      if (chunks.length === 1) {
        client.send(chunks[0]!);
        return;
      }
      client.send(Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
    };
    const queueOutput = (output: string | Uint8Array): void => {
      if (client.readyState !== WebSocket.OPEN) return;
      outputQueue.push(output);
      outputBytes += typeof output === "string" ? Buffer.byteLength(output) : output.byteLength;
      if (Date.now() < immediateOutputFlushUntil) {
        immediateOutputFlushUntil = Math.max(immediateOutputFlushUntil, Date.now() + SUBMIT_FAST_FLUSH_IDLE_MS);
        flushOutput();
        return;
      }
      if (outputBytes >= 256 * 1024) {
        flushOutput();
        return;
      }
      if (!outputFlushTimer) outputFlushTimer = setTimeout(flushOutput, 16);
    };
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.clients.delete(client);
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
      outputQueue.length = 0;
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
        && /^(?:\u001b\[<6[45];\d{1,3};\d{1,3}M){1,32}$/.test(control.data)
      ) {
          data.terminal?.write(control.data);
        return;
      }
      if (control.type === "submit" || control.type === "command" || control.type === "key" || control.type === "sequence") {
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
        const beginHistory = (
          actionType: "task_submit" | "terminal_command" | "shortcut" | "control_sequence",
          content: string,
        ): string | null => {
          try {
            return this.db.beginTmuxSessionAction({
              sessionRecordId: data.sessionRecordId,
              deviceId: data.deviceId,
              actionType,
              requestId: requestId || null,
              content,
            }).actionId;
          } catch {
            reply(false, "Could not save session operation history.");
            return null;
          }
        };
        const finishHistory = (
          actionId: string,
          status: "sent" | "confirmed" | "unconfirmed" | "failed",
          error: string | null = null,
        ): void => {
          try {
            this.db.finishTmuxSessionAction(actionId, status, error);
          } catch {
            // Keep the durable "sending" record when the outcome cannot be saved.
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
          const actionId = beginHistory("shortcut", String(control.key));
          if (!actionId) return;
          try {
            data.terminal.write(sequence);
            finishHistory(actionId, "sent");
            reply(true);
          } catch {
            finishHistory(actionId, "failed", "Could not send the shortcut to the tmux session.");
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
          const actionId = beginHistory("control_sequence", controlSequenceForHistory(sequence));
          if (!actionId) return;
          try {
            data.terminal.write(sequence);
            finishHistory(actionId, "sent");
            reply(true);
          } catch {
            finishHistory(actionId, "failed", "Could not send the control-key sequence to the tmux session.");
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
        if (control.type === "command") {
          const actionId = beginHistory("terminal_command", text);
          if (!actionId) return;
          try {
            flushOutput();
            immediateOutputFlushUntil = Date.now() + SUBMIT_FAST_FLUSH_WINDOW_MS;
            data.terminal.write("\u001b[200~" + text + "\u001b[201~\r");
            finishHistory(actionId, "sent");
            reply(true);
          } catch {
            finishHistory(actionId, "failed", "Could not send the command to the tmux session.");
            reply(false, "Could not send the command to the tmux session.");
          }
          return;
        }
        let actionId: string;
        try {
          const fingerprint = await submissionFingerprint(text);
          const claim = this.db.beginTmuxSessionAction({
            sessionRecordId: data.sessionRecordId,
            deviceId: data.deviceId,
            actionType: "task_submit",
            requestId: requestId || null,
            content: text,
            submissionFingerprint: fingerprint,
          });
          if (claim.duplicate) {
            reply(false, "相同消息近期已提交到此 Session，可能正在处理；请先查看终端或操作历史，避免重复发送。");
            return;
          }
          actionId = claim.actionId;
        } catch {
          reply(false, "Could not save session operation history.");
          return;
        }
        const paneBefore = await tmux.capturePane(data.sessionId, 200).catch(() => null);
        if (paneBefore === null) {
          finishHistory(actionId, "failed", "无法读取 session 当前状态。");
          reply(false, "消息未发送：无法读取 session 当前状态，请稍后重试。");
          return;
        }
        try {
          flushOutput();
          immediateOutputFlushUntil = Date.now() + SUBMIT_FAST_FLUSH_WINDOW_MS;
          data.terminal.write("\u001b[200~" + text + "\u001b[201~\r");
          const confirmed = await waitForPaneChange(data.sessionId, paneBefore, text);
          finishHistory(
            actionId,
            confirmed ? "confirmed" : "unconfirmed",
            confirmed ? null : "未能从终端屏幕确认处理状态；消息可能已被接收。",
          );
          reply(
            confirmed,
            confirmed
              ? undefined
              : "消息已写入终端，但无法从屏幕确认处理状态；可能已开始执行。请先查看 Session，避免直接重发。",
          );
        } catch {
          finishHistory(actionId, "failed", "Could not send the message to the session.");
          reply(false, "Could not send the message to the tmux session.");
        }
        return;
      }
      if (control.type === "resize") {
        const cols = clampDimension(control.cols, 20, 400);
        const rows = clampDimension(control.rows, 5, 200);
        if (!cols || !rows) return;
        data.cols = cols;
        data.rows = rows;
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
      // LaunchAgents may omit locale variables even when the tmux server is UTF-8.
      // Give this attach client a UTF-8 locale so CJK text is emitted correctly.
      const inheritedUtf8Locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG]
        .find((locale) => locale && /UTF-?8/i.test(locale));
      const terminalLocale = inheritedUtf8Locale ?? "C.UTF-8";
      const child = getBunRuntime().spawn(["tmux", "attach-session", "-t", data.sessionId], {
        env: {
          ...process.env,
          LC_ALL: process.env.LC_ALL && /UTF-?8/i.test(process.env.LC_ALL) ? process.env.LC_ALL : undefined,
          LANG: terminalLocale,
          LC_CTYPE: terminalLocale,
          TMUX: undefined,
          TMUX_PANE: undefined,
          TERM: "xterm-256color",
        },
        terminal: {
          cols: data.cols,
          rows: data.rows,
          name: "xterm-256color",
          data: (_terminal, output) => {
            if (initialScreenReady) queueOutput(output);
          },
        },
      });
      data.proc = child;
      data.terminal = child.terminal;
      const initialScreen = await captureInitialScreen(data.sessionId, data.rows);
      if (cleanedUp || client.readyState !== WebSocket.OPEN) return;
      client.send(initialScreen);
      initialScreenReady = true;
      void child.exited.then((exitCode) => {
        if (client.readyState === WebSocket.OPEN) {
          flushOutput();
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

async function captureInitialScreen(sessionId: string, rows: number): Promise<string> {
  // Let tmux finish attaching/resizing before taking the snapshot. PTY output
  // during this settling window is intentionally not forwarded to the client.
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  const snapshotRows = Math.max(rows, 1_000);
  let captured: string;
  try {
    captured = await tmux.capturePane(sessionId, snapshotRows, {
      alternateScreen: true,
      includeEscapeSequences: true,
    });
  } catch {
    captured = await tmux.capturePane(sessionId, snapshotRows, { includeEscapeSequences: true });
  }
  const screen = captured.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  // Clear xterm's local history and paint only the current server-side screen.
  return "\u001b[3J\u001b[2J\u001b[H" + screen;
}

async function waitForPaneChange(sessionId: string, before: string, submittedText: string): Promise<boolean> {
  for (const delay of [120, 280, 560, 1_120, 2_240]) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      const after = await tmux.capturePane(sessionId, 200);
      if (hasNewSubmissionEcho(before, after, submittedText)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function hasNewSubmissionEcho(before: string, after: string, submittedText: string): boolean {
  const messageForEcho = submittedText.split(/<image\s+name=/i, 1)[0].trim() || "请打开并查看我附上的图片";
  const expected = normalizePaneText(messageForEcho);
  const expectedCompact = expected.replace(/\s+/g, "");
  const expectedSnippet = expected.slice(0, 32);
  const expectedCompactSnippet = expectedCompact.slice(0, 32);
  const beforeNormalized = normalizePaneText(before);
  const beforeCompact = beforeNormalized.replace(/\s+/g, "");
  const afterNormalized = normalizePaneText(after);
  const afterCompact = afterNormalized.replace(/\s+/g, "");
  return after !== before && (
    countOccurrences(afterNormalized, expectedSnippet) > countOccurrences(beforeNormalized, expectedSnippet)
    || countOccurrences(afterCompact, expectedCompactSnippet) > countOccurrences(beforeCompact, expectedCompactSnippet)
  );
}

function countOccurrences(value: string, snippet: string): number {
  if (!snippet) return 0;
  return value.split(snippet).length - 1;
}

export async function submissionFingerprint(text: string): Promise<string> {
  const hash = createHash("sha256");
  let offset = 0;
  for (const match of text.matchAll(SUBMISSION_ATTACHMENT_TAG)) {
    const tag = match[0];
    const path = match[1]!;
    const index = match.index;
    hash.update(text.slice(offset, index));
    const fileName = basename(path);
    const allowedDirectory = [ATTACHMENT_DIRECTORY, LEGACY_ATTACHMENT_DIRECTORY]
      .find((directory) => path === join(directory, fileName));
    let contentDigest: string | null = null;
    if (allowedDirectory && /^[\da-f-]{36}\.[a-z0-9]{1,12}$/i.test(fileName)) {
      const fileInfo = await lstat(path).catch(() => null);
      if (fileInfo?.isFile() && !fileInfo.isSymbolicLink() && fileInfo.size <= MAX_ATTACHMENT_BYTES) {
        contentDigest = createHash("sha256").update(await readFile(path)).digest("hex");
      }
    }
    hash.update(contentDigest ? tag.replace(path, `sha256:${contentDigest}`) : tag);
    offset = index + tag.length;
  }
  hash.update(text.slice(offset));
  return hash.digest("hex");
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

async function readBinaryBody(request: IncomingMessage, maxBytes: number, tooLargeMessage: string): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new DashboardBodyError(tooLargeMessage, 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new DashboardBodyError(tooLargeMessage, 413);
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

interface SessionFileContext {
  session: tmux.TmuxSession;
  rootPath: string;
  absolutePath: string;
  path: string;
}

function normalizeSessionRelativePath(value: string): string {
  const normalized = value.replaceAll(String.fromCharCode(92), "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes(String.fromCharCode(0))) {
    throw new DashboardBodyError("Use a path inside the session directory.", 400);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    throw new DashboardBodyError("Parent directory traversal is not allowed.", 400);
  }
  return parts.filter((part) => part && part !== ".").join(sep);
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function sanitizeSessionFileName(value: string): string {
  const fileName = basename(value.replaceAll(String.fromCharCode(92), "/"));
  if (
    !fileName
    || fileName === "."
    || fileName === ".."
    || fileName.includes(String.fromCharCode(0))
    || [...fileName].some((character) => character.charCodeAt(0) === 10 || character.charCodeAt(0) === 13)
    || Buffer.byteLength(fileName, "utf8") > 255
  ) {
    throw new DashboardBodyError("The uploaded file name is invalid.", 400);
  }
  return fileName;
}

function controlSequenceForHistory(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}

function imageContentType(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return contentTypes[extension] ?? "application/octet-stream";
}

function imageExtensionForContentType(contentType: string): string | null {
  const extensions: Readonly<Record<string, string>> = {
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  return extensions[contentType] ?? null;
}

function sendSessionFileError(response: ServerResponse, error: unknown): void {
  if (error instanceof DashboardBodyError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }
  if (error instanceof tmux.SessionNotFoundError) {
    sendJson(response, 404, { error: "tmux session not found." });
    return;
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    sendJson(response, 404, { error: "File or directory not found." });
    return;
  }
  if (code === "EACCES" || code === "EPERM") {
    sendJson(response, 403, { error: "Permission denied for this file or directory." });
    return;
  }
  if (code === "EEXIST") {
    sendJson(response, 409, { error: "A file with that name already exists." });
    return;
  }
  sendJson(response, 500, { error: "Could not access session files." });
}
