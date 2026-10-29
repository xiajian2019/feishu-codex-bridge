import { constants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, realpath, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DownloadUploadError, DownloadUploadsService } from "./download-uploads.js";
import {
  tmuxResurrectController,
  TmuxResurrectUnavailableError,
  type TmuxResurrectController,
} from "./tmux-resurrect.js";

import { getBunRuntime, type BunSubprocess, type BunTerminal } from "./bun-runtime.js";
import { isNativeAppOrigin } from "./mobile-auth.js";
import { discoverCodexHistoryHomes, type CodexHistoryHome } from "./codex-history.js";
import { codexSkillScopeKeys, discoverCodexSkills, type CodexSkillScope } from "./codex-skills.js";
import { GitWorkspaceError, inspectGitChanges, openGitChangeFile, previewGitChangeFile, inspectTaskSourceDirectory, resolveGitCommonDirectory, resolveGitRoot, verifyTaskWorkspace } from "./git-workspaces.js";
import type { StateDatabase } from "./db.js";
import type { Logger, StoredTask, StoredTmuxSessionAction, WebTaskSubmission } from "./types.js";
import {
  parseTmuxReviewAnchor,
  parseTmuxReviewTarget,
  reviewAnchorMismatch,
  tmuxReviewTargetMismatch,
  type TmuxReviewAnchor,
  type TmuxReviewTarget,
} from "./tmux-review.js";
import * as tmux from "./tmux-dashboard.js";

const API_PREFIX = "/tmux-dashboard/api";
const MAX_SESSION_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SUBMISSION_BYTES = 32 * 1024;
const MAX_CODEX_WORKTREE_TASK_DESCRIPTION_LENGTH = 20_000;
const MAX_GIT_REVIEW_ANCHORS = 20;
const MAX_SCROLL_DIAGNOSTIC_EXPORT_BYTES = 5 * 1024 * 1024;
const MAX_SCROLL_DIAGNOSTIC_ENTRIES = 2_000;
const CODEX_SKILL_SOURCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CODEX_SKILL_REFRESH_RETRY_MS = 60 * 1_000;
const CODEX_HOME_OPTIONS_CACHE_MS = 30 * 1_000;
const SUBMIT_FAST_FLUSH_WINDOW_MS = 5_000;
const SUBMIT_FAST_FLUSH_IDLE_MS = 250;
const MAX_TERMINAL_INPUT_BYTES = 32 * 1024;
// Codex's paste-burst handler suppresses Enter briefly after rapid pasted input.
// Keep the synthetic submit outside that window so it is handled as submit.
const TERMINAL_PASTE_SETTLE_MS = 180;
const TERMINAL_HEARTBEAT_INTERVAL_MS = 30_000;
const CODEX_WORKTREE_TASK_DIRECTORY = join(tmpdir(), "feishu-codex-bridge", "codex-worktree-tasks");
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
  "codex-answer": "\u001b[1;2D",
  "codex-prompt-back": "\u001b[1;2C",
  "codex-warnings": "\u001bOQ",
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

function resolveCodexWorktreeExecutable(configured?: string): string {
  const requested = configured?.trim() || process.env.CODEX_WORKTREE_CLI?.trim();
  if (requested) return requested;
  const personalExecutable = join(homedir(), ".codex", "bin", "codex-worktree");
  return existsSync(personalExecutable) ? personalExecutable : "codex-worktree";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
  isAuthorized: () => boolean;
}

export interface TmuxDashboardApiOptions {
  db: StateDatabase;
  logger?: Logger;
  /** Internal deadline override for isolated stalled-query tests. */
  sessionListTimeoutMs?: number;
  /** Isolated attachment storage for fixture servers. */
  attachmentDirectory?: string;
  createTaskFromSession?: (input: WebTaskSubmission, source: {
    directory: string;
    tmuxSessionId: string;
    expectedDirectory: string;
    expectedBaseSha: string;
  }) => Promise<StoredTask>;
  operations?: Pick<typeof tmux, "createSession" | "findSession" | "killSession" | "listSessions">
    & Partial<Pick<typeof tmux, "getCurrentPanePath" | "inspectCodexHome" | "setCodexHomeForSession" | "capturePane" | "inspectReviewPane" | "pasteTextToPane" | "sendEnterToPane">>;
  terminalRuntime?: Pick<ReturnType<typeof getBunRuntime>, "spawn">;
  /** Internal interval override for bounded connection-liveness tests. */
  heartbeatIntervalMs?: number;
  /** Injectable for tests; production discovers the local Codex homes. */
  discoverCodexHomes?: () => CodexHistoryHome[];
  /** Absolute path or executable name used for the optional initial Session task. */
  codexWorktreeExecutable?: string;
  /** Injectable for tests; production delegates complete Session snapshots to tmux-resurrect. */
  resurrect?: TmuxResurrectController;
  /** Isolated fixture servers must not restore the user's real tmux snapshots. */
  autoRestoreSessions?: boolean;
}

export interface TerminalHeartbeatPeer {
  readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
  off(event: "pong", listener: () => void): unknown;
}

export function startTerminalHeartbeat(
  peer: TerminalHeartbeatPeer,
  intervalMs = TERMINAL_HEARTBEAT_INTERVAL_MS,
  schedule: typeof setInterval = setInterval,
  cancel: typeof clearInterval = clearInterval,
  isAuthorized: () => boolean = () => true,
): () => void {
  let stopped = false;
  let awaitingPong = false;
  let timer: ReturnType<typeof setInterval>;
  const onPong = (): void => { awaitingPong = false; };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancel(timer);
    peer.off("pong", onPong);
  };
  peer.on("pong", onPong);
  timer = schedule(() => {
    if (stopped) return;
    if (peer.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    if (!isAuthorized()) {
      stop();
      peer.terminate();
      return;
    }
    if (awaitingPong) {
      stop();
      peer.terminate();
      return;
    }
    awaitingPong = true;
    try { peer.ping(); }
    catch {
      stop();
      peer.terminate();
    }
  }, intervalMs);
  return stop;
}

export class TmuxDashboardApi {
  private readonly db: StateDatabase;
  private readonly operations: NonNullable<TmuxDashboardApiOptions["operations"]>;
  private readonly terminalRuntime?: TmuxDashboardApiOptions["terminalRuntime"];
  private readonly heartbeatIntervalMs: number;
  private readonly createTaskFromSession?: TmuxDashboardApiOptions["createTaskFromSession"];
  private readonly discoverCodexHomes: () => CodexHistoryHome[];
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private readonly clientAuthorizationChecks = new Map<WebSocket, () => boolean>();
  private readonly skillRefreshes = new Map<string, Promise<void>>();
  private readonly skillRefreshAttempts = new Map<string, number>();
  private codexHomeOptionsCache: { at: number; homes: CodexHistoryHome[] } | null = null;
  private sessionListRefresh: Promise<tmux.TmuxSession[]> | null = null;
  private sessionListGeneration = 0;
  private sessionListController?: AbortController;
  private readonly sessionListTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly codexWorktreeExecutable: string;
  private readonly resurrect: TmuxResurrectController;
  private readonly autoRestoreSessions: boolean;
  private readonly manageSessionSnapshots: boolean;
  private stopped = false;
  private attachmentStorageReady: Promise<void> | null = null;
  private readonly attachmentDirectory: string;
  private readonly attachmentDirectories: string[];
  private readonly attachmentUploads: DownloadUploadsService;

  constructor(options: TmuxDashboardApiOptions) {
    if (!options.db) throw new Error("TmuxDashboardApi requires the Bridge state database.");
    this.db = options.db;
    this.logger = options.logger;
    this.sessionListTimeoutMs = options.sessionListTimeoutMs ?? 5_000;
    this.attachmentDirectory = options.attachmentDirectory ?? ATTACHMENT_DIRECTORY;
    this.attachmentDirectories = options.attachmentDirectory ? [this.attachmentDirectory] : [ATTACHMENT_DIRECTORY, LEGACY_ATTACHMENT_DIRECTORY];
    this.attachmentUploads = new DownloadUploadsService({ directory: this.attachmentDirectory });
    this.terminalRuntime = options.terminalRuntime;
    this.heartbeatIntervalMs = Number.isSafeInteger(options.heartbeatIntervalMs) && (options.heartbeatIntervalMs ?? 0) >= 10
      ? options.heartbeatIntervalMs!
      : TERMINAL_HEARTBEAT_INTERVAL_MS;
    this.createTaskFromSession = options.createTaskFromSession;
    this.discoverCodexHomes = options.discoverCodexHomes ?? (() => discoverCodexHistoryHomes());
    this.codexWorktreeExecutable = resolveCodexWorktreeExecutable(options.codexWorktreeExecutable);
    this.resurrect = options.resurrect ?? tmuxResurrectController;
    this.autoRestoreSessions = options.autoRestoreSessions ?? !options.operations;
    this.manageSessionSnapshots = options.autoRestoreSessions ?? (!options.operations || Boolean(options.resurrect));
    this.operations = { ...tmux, ...options.operations };
  }

  private async submitInitialCodexWorktreeTask(session: tmux.TmuxSession, description: string): Promise<void> {
    const inspectReviewPane = this.operations.inspectReviewPane ?? tmux.inspectReviewPane;
    const pasteTextToPane = this.operations.pasteTextToPane ?? tmux.pasteTextToPane;
    const sendEnterToPane = this.operations.sendEnterToPane ?? tmux.sendEnterToPane;
    const pane = await inspectReviewPane(session.id, session);
    await mkdir(CODEX_WORKTREE_TASK_DIRECTORY, { recursive: true, mode: 0o700 });
    const taskFile = join(CODEX_WORKTREE_TASK_DIRECTORY, `task-${randomUUID()}.md`);
    await writeFile(taskFile, description, { encoding: "utf8", flag: "wx", mode: 0o600 });

    // Passing the textarea through a temporary Markdown file keeps multiline and
    // non-ASCII prompts out of the shell command line. The wrapper removes the
    // file after codex-worktree has read it, while preserving its exit status.
    const quotedTaskFile = shellQuote(taskFile);
    const command = [
      `${shellQuote(this.codexWorktreeExecutable)} --task-file ${quotedTaskFile}`,
      "status=$?",
      `rm -f ${quotedTaskFile}`,
      'exit "$status"',
    ].join("; ");
    let commandBuffered = false;
    try {
      await pasteTextToPane(pane.paneId, command);
      commandBuffered = true;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, TERMINAL_PASTE_SETTLE_MS));
      await sendEnterToPane(pane.paneId);
    } finally {
      // Once paste-buffer succeeds, leave the file for the shell wrapper. If
      // paste itself failed, no shell command can consume it.
      if (!commandBuffered) await unlink(taskFile).catch(() => undefined);
    }
  }

  public async getWorkspaceSessionSnapshot(): Promise<Array<{ sessionId: string; currentPath: string }>> {
    const sessions = await this.listLiveSessions();
    return Promise.all(sessions.map(async (session) => ({
      sessionId: session.id,
      currentPath: this.operations.getCurrentPanePath
        ? await this.operations.getCurrentPanePath(session.id, session)
        : session.cwd,
    })));
  }

  public async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string | null = null,
    isAuthorized: () => boolean = () => true,
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
    const attachmentPart = /^\/attachments\/uploads\/([a-f0-9-]+)\/parts\/(\d+)$/.exec(apiPath);
    const attachmentUpload = /^\/attachments\/uploads(?:\/([a-f0-9-]+)(\/complete)?)?$/.exec(apiPath);
    if (attachmentUpload) {
      const owner = deviceId ?? "local";
      const id = attachmentUpload[1];
      try {
        if (request.method === "POST" && !id) {
          const body = await readJsonBody(request);
          await this.ensureAttachmentStorage();
          const name = attachmentStorageName(typeof body.fileName === "string" ? body.fileName : "", typeof body.contentType === "string" ? body.contentType : "");
          sendJson(response, 201, await this.attachmentUploads.create(owner, name, body.sizeBytes, body.protocol === "parts" ? "parts" : "offset"));
        } else if (id && request.method === "PUT" && !attachmentUpload[2]) {
          const offset = url.searchParams.get("offset");
          if (offset === null || !/^\d+$/.test(offset)) throw new DashboardBodyError("Invalid attachment offset.", 400);
          sendJson(response, 200, await this.attachmentUploads.append(id, owner, Number(offset), request, isAuthorized));
        } else if (id && request.method === "GET" && !attachmentUpload[2]) {
          sendJson(response, 200, this.attachmentUploads.status(id, owner));
        } else if (id && request.method === "POST" && attachmentUpload[2]) {
          await readJsonBody(request);
          sendJson(response, 200, await this.attachmentUploads.complete(id, owner));
        } else if (id && request.method === "DELETE" && !attachmentUpload[2]) {
          await this.attachmentUploads.cancel(id, owner);
          sendJson(response, 200, { ok: true });
        } else sendJson(response, 404, { error: "Attachment upload endpoint not found." });
      } catch (error) { if (!response.destroyed) sendDashboardError(response, error); }
      return;
    }
    if (attachmentPart && request.method === "PUT") {
      const owner = deviceId ?? "local";
      try {
        sendJson(response, 200, await this.attachmentUploads.appendPart(attachmentPart[1], owner, Number(attachmentPart[2]), request, isAuthorized));
      } catch (error) { if (!response.destroyed) sendDashboardError(response, error); }
      return;
    }
    if (request.method === "POST" && apiPath === "/attachments") {
      try {
        const fileNameHeader = request.headers["x-file-name"];
        const encodedFileName = Array.isArray(fileNameHeader) ? fileNameHeader[0] ?? "" : fileNameHeader ?? "";
        let fileName = encodedFileName;
        try {
          fileName = decodeURIComponent(encodedFileName);
        } catch {
          // Fall back to the raw header and still keep only its safe extension.
        }
        const contentTypeHeader = request.headers["content-type"];
        const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader) ?? "";
        await this.ensureAttachmentStorage();
        const attachmentPath = join(this.attachmentDirectory, attachmentStorageName(fileName, contentType));
        try {
          await pipeline(request, createWriteStream(attachmentPath, { flags: "wx", mode: 0o600 }));
          if ((await stat(attachmentPath)).size === 0) throw new DashboardBodyError("The selected attachment is empty.", 400);
        } catch (error) { await unlink(attachmentPath).catch(() => undefined); throw error; }
        sendJson(response, 201, { path: attachmentPath });
      } catch (error) {
        if (response.destroyed) return;
        if (error instanceof DashboardBodyError) {
          sendJson(response, error.statusCode, { error: error.message });
        } else {
          sendJson(response, 500, { error: "Could not store the attachment." });
        }
      }
      return;
    }
    const skillListMatch = /^\/sessions\/([^/]+)\/skills$/.exec(apiPath);
    if (request.method === "GET" && skillListMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(skillListMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "Invalid tmux session id." });
        return;
      }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
        const [codexHomePath, projectCwd] = await Promise.all([
          this.codexHomePathForSession(sessionId, session),
          this.operations.getCurrentPanePath
            ? this.operations.getCurrentPanePath(sessionId, session)
            : Promise.resolve(session.cwd),
        ]);
        const scopeKeys = codexSkillScopeKeys({ codexHomePath, projectCwd });
        const scopeKey = [...scopeKeys].sort().join("\u0000");
        const syncStatus = this.db.codexSkillSourceSyncStatus(scopeKeys, CODEX_SKILL_SOURCE_MAX_AGE_MS);
        const cachedSkills = this.db.listCodexSkills(scopeKeys);
        if (!syncStatus.fresh) {
          const refresh = this.scheduleCodexSkillRefresh(codexHomePath, projectCwd, scopeKeys);
          if (refresh && !syncStatus.initialized && cachedSkills.length === 0) await refresh;
        }
        const skillCacheFresh = this.db.codexSkillSourceSyncStatus(scopeKeys, CODEX_SKILL_SOURCE_MAX_AGE_MS).fresh;
        const scopePriority: Record<CodexSkillScope, number> = {
          project: 0,
          codex_home: 1,
          user: 2,
          plugin: 3,
          system: 4,
        };
        const query = (url.searchParams.get("q") ?? "").trim().slice(0, 160).toLocaleLowerCase();
        const allSkills = url.searchParams.get("all") === "1";
        const resultLimit = allSkills ? 1_000 : query ? 20 : 6;
        const byName = new Map<string, ReturnType<StateDatabase["listCodexSkills"]>[number]>();
        for (const skill of this.db.listCodexSkills(scopeKeys).sort((left, right) =>
          scopePriority[left.scope] - scopePriority[right.scope]
            || left.skillName.localeCompare(right.skillName),
        )) {
          const key = skill.skillName.toLocaleLowerCase("en-US");
          if (!byName.has(key)) byName.set(key, skill);
        }
        const skills = [...byName.values()]
          .filter((skill) => !query || skill.skillName.toLocaleLowerCase().includes(query))
          .sort((left, right) => Number(right.pinned) - Number(left.pinned)
            || left.sortOrder - right.sortOrder
            || left.skillName.localeCompare(right.skillName))
          .slice(0, resultLimit);
        sendJson(response, 200, {
          skills: skills.map((skill) => ({
            skillName: skill.skillName,
            descriptionZh: skill.descriptionZh,
          })),
          fresh: skillCacheFresh,
          refreshing: this.skillRefreshes.has(scopeKey),
        });
      } catch (error) {
        sendDashboardError(response, error);
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
    if (request.method === "GET" && apiPath === "/resurrect/status") {
      sendJson(response, 200, this.resurrect.status());
      return;
    }
    const sessionResurrectMatch = /^\/sessions\/([^/]+)\/resurrect\/save$/.exec(apiPath);
    if (request.method === "POST" && sessionResurrectMatch) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(sessionResurrectMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      try {
        const live = await this.operations.findSession(sessionId);
        const saved = this.db.getLatestTmuxSession(sessionId);
        const sessionName = live?.name ?? saved?.session_name;
        if (!sessionName) throw new tmux.SessionNotFoundError("Session record no longer exists.");
        if (!live) throw new tmux.SessionNotFoundError("Only a running Session can be saved.");
        const result = await this.resurrect.saveSession(sessionName);
        sendJson(response, 200, {
          ok: true,
          action: result.action,
          sessionName: result.sessionName,
          snapshot: result.snapshot,
          output: result.output || null,
        });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const sessionLifecycleMatch = /^\/sessions\/([^/]+)\/(suspend|resume)$/.exec(apiPath);
    if (request.method === "POST" && sessionLifecycleMatch) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(sessionLifecycleMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      const action = sessionLifecycleMatch[2] as "suspend" | "resume";
      try {
        const saved = this.db.getLatestTmuxSession(sessionId);
        if (action === "suspend") {
          const live = await this.operations.findSession(sessionId);
          if (!live) throw new tmux.SessionNotFoundError("Only a running Session can be suspended.");
          const snapshot = await this.resurrect.saveSession(live.name);
          await this.operations.killSession(sessionId);
          const suspended = this.db.markTmuxSessionSuspended(sessionId);
          if (!suspended) throw new tmux.SessionNotFoundError("Session record no longer exists.");
          this.invalidateSessionList();
          sendJson(response, 200, {
            ok: true,
            action,
            session: { id: sessionId, name: live.name, suspendedAt: suspended.suspended_at, snapshot: snapshot.snapshot },
          });
          return;
        }
        if (!saved || saved.ended_at !== null || saved.suspended_at === null) {
          throw new DashboardBodyError("只有已挂起的 Session 可以恢复。", 409);
        }
        const liveSessions = await this.operations.listSessions();
        if (liveSessions.some((session) => session.name === saved.session_name)) {
          throw new DashboardBodyError("同名 Session 已在运行，请先刷新列表。", 409);
        }
        const snapshot = await this.resurrect.restoreSession(saved.session_name);
        const restored = (await this.operations.listSessions()).find((session) => session.name === saved.session_name);
        if (!restored) throw new tmux.SessionNotFoundError("快照已恢复，但没有找到新的 tmux Session。");
        const resumed = this.db.resumeTmuxSession(saved.record_id, restored);
        if (!resumed) throw new tmux.SessionNotFoundError("挂起的 Session 记录已变化，请刷新后重试。");
        this.invalidateSessionList();
        sendJson(response, 200, {
          ok: true,
          action,
          session: { id: restored.id, name: restored.name, suspendedAt: null, snapshot: snapshot.snapshot },
        });
      } catch (error) {
        sendDashboardError(response, error);
      }
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
    if (request.method === "GET" && apiPath === "/codex-homes") {
      try {
        sendJson(response, 200, {
          codexHomes: this.codexHomeOptions().map(({ id, label, available }) => ({ id, label, available })),
        });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    if (request.method === "GET" && apiPath === "/sessions") {
      try {
        const liveSessions = await this.listLiveSessions();
        const includeHomes = url.searchParams.get("includeHomes") !== "0";
        const liveByKey = new Map(liveSessions.map((session) => [`${session.id}\u0000${session.createdAt}`, session]));
        const sessions = this.db.listTmuxSessionsForDashboard().map((saved) => {
          const live = liveByKey.get(`${saved.tmux_session_id}\u0000${saved.tmux_created_at}`);
          const workspace = saved.workspace_id ? this.db.getTaskWorkspaceById(saved.workspace_id) : null;
          return {
            id: saved.tmux_session_id,
            name: live?.name ?? saved.session_name,
            windows: live?.windows ?? 0,
            attachedClients: live?.attachedClients ?? 0,
            cwd: live?.cwd ?? saved.working_directory,
            createdAt: live?.createdAt ?? saved.tmux_created_at,
            endedAt: saved.ended_at,
            suspendedAt: saved.suspended_at,
            openCount: saved.open_count,
            lastOpenedAt: saved.last_opened_at,
            codexHomeId: saved.codex_home_id,
            workspaceId: workspace?.workspace_id ?? null,
            taskGuid: workspace?.task_guid ?? null,
            workspaceBranch: workspace?.branch ?? null,
            workspaceStatus: workspace?.status ?? null,
            snapshot: this.resurrect.snapshotForSession(saved.session_name),
          };
        });
        sendJson(response, 200, includeHomes
          ? {
            sessions,
            codexHomes: this.codexHomeOptions().map(({ id, label, available }) => ({ id, label, available })),
          }
          : { sessions });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const taskContextMatch = /^\/sessions\/([^/]+)\/task-context$/.exec(apiPath);
    if (request.method === "GET" && taskContextMatch) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(taskContextMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
        const directory = this.operations.getCurrentPanePath
          ? await this.operations.getCurrentPanePath(sessionId, session)
          : session.cwd;
        const [project, source] = await Promise.all([
          this.projectForSession(sessionId, directory),
          inspectTaskSourceDirectory(directory),
        ]);
        sendJson(response, 200, {
          sessionId,
          projectKey: project.name,
          projectName: project.name,
          directory: source.directory,
          branch: source.branch,
          baseSha: source.baseSha,
          sourceHeadSha: source.baseSha,
          baseRef: source.targetBaseRef,
          targetBaseSha: source.targetBaseSha,
          dirtyEntryCount: source.dirtyEntryCount,
        });
      } catch (error) {
        if (error instanceof GitWorkspaceError) sendJson(response, error.statusCode, { error: error.message });
        else sendDashboardError(response, error);
      }
      return;
    }
    const reviewContextMatch = /^\/sessions\/([^/]+)\/git-review\/context$/.exec(apiPath);
    if (request.method === "GET" && reviewContextMatch) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(reviewContextMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      try {
        const context = await this.readReviewContext(sessionId);
        const expectedGitRoot = url.searchParams.get("expectedGitRoot");
        if (expectedGitRoot && expectedGitRoot !== context.inspection.gitRoot) {
          sendJson(response, 409, { error: "The session now points to a different Git repository." });
          return;
        }
        const target: TmuxReviewTarget | null = context.pane.foregroundCodex ? {
          sessionId,
          paneId: context.pane.paneId,
          gitRoot: context.inspection.gitRoot,
          foregroundCodex: context.pane.foregroundCodex,
        } : null;
        sendJson(response, 200, {
          sessionId,
          session: { id: context.session.id, name: context.session.name },
          paneId: context.pane.paneId,
          gitRoot: context.inspection.gitRoot,
          foregroundCodex: context.pane.foregroundCodex,
          status: target ? "ready" : "codex-not-running",
          target,
        });
      } catch (error) {
        if (error instanceof GitWorkspaceError) sendJson(response, error.statusCode, { error: error.message });
        else sendDashboardError(response, error);
      }
      return;
    }
    const reviewRevalidateMatch = /^\/sessions\/([^/]+)\/git-review\/revalidate$/.exec(apiPath);
    if (request.method === "POST" && reviewRevalidateMatch) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(reviewRevalidateMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      let body: Record<string, unknown>;
      try { body = await readJsonBody(request); }
      catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid review request." });
        return;
      }
      try {
        const validated = await this.validateReviewRequest(sessionId, body.target, body.anchors);
        sendJson(response, 200, { ok: true, target: validated.target });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const gitFileMatch = /^\/sessions\/([^/]+)\/git-changes\/(content|download)$/.exec(apiPath);
    if (request.method === "GET" && gitFileMatch) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(gitFileMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
        const directory = this.operations.getCurrentPanePath
          ? await this.operations.getCurrentPanePath(sessionId, session)
          : session.cwd;
        const path = url.searchParams.get("path") ?? "";
        const expectedGitRoot = url.searchParams.get("expectedGitRoot") ?? undefined;
        if (gitFileMatch[2] === "content") {
          sendJson(response, 200, await previewGitChangeFile(directory, path, expectedGitRoot));
        } else {
          const file = await openGitChangeFile(directory, path, expectedGitRoot);
          try {
            const fileName = basename(path);
            const fallbackName = fileName.replace(/[^\x20-\x7e]|[\\";]/g, "_") || "download";
            const encodedName = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
            response.setHeader("Cache-Control", "private, no-store");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("Content-Type", "application/octet-stream");
            response.setHeader("Content-Length", String(file.sizeBytes));
            response.setHeader("Content-Disposition", "attachment; filename=\"" + fallbackName + "\"; filename*=UTF-8''" + encodedName);
            const stream = file.handle.createReadStream();
            stream.on("error", () => response.destroy());
            response.on("close", () => stream.destroy());
            stream.pipe(response);
          } catch (error) {
            await file.handle.close();
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof GitWorkspaceError) sendJson(response, error.statusCode, { error: error.message });
        else sendSessionFileError(response, error);
      }
      return;
    }
    const gitChangesPrefix = "/sessions/";
    const gitChangesSuffix = "/git-changes";
    if (request.method === "GET" && apiPath.startsWith(gitChangesPrefix) && apiPath.endsWith(gitChangesSuffix)) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(apiPath.slice(gitChangesPrefix.length, -gitChangesSuffix.length)); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
        const directory = this.operations.getCurrentPanePath
          ? await this.operations.getCurrentPanePath(sessionId, session)
          : session.cwd;
        const inspection = await inspectGitChanges(directory);
        sendJson(response, 200, {
          sessionId,
          session: { id: session.id, name: session.name },
          ...inspection,
        });
      } catch (error) {
        if (error instanceof GitWorkspaceError) sendJson(response, error.statusCode, { error: error.message });
        else sendDashboardError(response, error);
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
      if (body.taskDescription !== undefined
        && (typeof body.taskDescription !== "string" || body.taskDescription.length > MAX_CODEX_WORKTREE_TASK_DESCRIPTION_LENGTH)) {
        sendJson(response, 400, { error: "taskDescription must contain up to 20000 characters." });
        return;
      }
      const taskDescription = typeof body.taskDescription === "string" ? body.taskDescription.trim() : "";
      if (taskDescription.includes("\0")) {
        sendJson(response, 400, { error: "taskDescription cannot contain NUL bytes." });
        return;
      }
      try {
        const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim() : "";
        const project = this.db.getAvailableProject(projectKey);
        if (projectKey && !project) throw new tmux.ValidationError("所选项目不可用，请刷新项目列表。");
        const requestedWorkingDirectory = typeof body.workingDirectory === "string"
          ? body.workingDirectory.trim()
          : typeof body.cwd === "string" ? body.cwd.trim() : "";
        if (requestedWorkingDirectory.length > 4_096) {
          throw new tmux.ValidationError("工作目录路径不能超过 4096 个字符。");
        }
        const workingDirectory = requestedWorkingDirectory || project?.path;
        if (!workingDirectory) {
          throw new tmux.ValidationError("请选择项目或输入工作目录。");
        }
        const normalizedRequestedDirectory = requestedWorkingDirectory.replace(/^~(?=\/|$)/, homedir());
        const recordProjectKey = project && (!requestedWorkingDirectory || resolve(normalizedRequestedDirectory) === resolve(project.path))
          ? project.name
          : null;
        const session = await this.operations.createSession(body.name.trim(), workingDirectory);
        this.invalidateSessionList();
        this.db.recordTmuxSession(session, { projectKey: recordProjectKey, createdByDeviceId: deviceId });
        let initialTask: { status: "submitted" | "failed"; error?: string } | undefined;
        if (taskDescription) {
          try {
            await this.submitInitialCodexWorktreeTask(session, taskDescription);
            initialTask = { status: "submitted" };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.warn("could not submit initial Codex worktree task", {
              sessionId: session.id,
              error: message,
            });
            initialTask = { status: "failed", error: message };
          }
        }
        sendJson(response, 201, {
          session: { ...session, codexHomeId: null },
          ...(initialTask ? { initialTask } : {}),
        });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const workspaceSessionMatch = /^\/workspaces\/([^/]+)\/session$/.exec(apiPath);
    if (request.method === "POST" && workspaceSessionMatch) {
      let workspaceId: string;
      try { workspaceId = decodeURIComponent(workspaceSessionMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid workspace id." }); return; }
      let body: Record<string, unknown>;
      try { body = await readJsonBody(request); }
      catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "Expected a JSON request body." }); return; }
      try {
        const workspace = this.db.getTaskWorkspaceById(workspaceId);
        if (!workspace || workspace.status === "removed") { sendJson(response, 404, { error: "Task workspace not found." }); return; }
        if (workspace.followups_closed_at) {
          sendJson(response, 409, { error: "Task workspace is archived; create a new task to continue editing." });
          return;
        }
        if (workspace.status !== "ready" && workspace.status !== "retained") {
          sendJson(response, 409, { error: "Task workspace is not ready." });
          return;
        }
        const task = this.db.getTask(workspace.task_guid);
        if (!task) { sendJson(response, 404, { error: "Task for this workspace no longer exists." }); return; }
        if (task.state === "QUEUED" || task.state === "RUNNING") {
          sendJson(response, 409, { error: "任务仍在执行；请等待本轮结束后再打开可写 tmux session。" });
          return;
        }
        const existingRecords = this.db.listTmuxSessionsForWorkspace(workspaceId);
        for (const record of existingRecords) {
          if (record.ended_at) continue;
          const live = await this.operations.findSession(record.tmux_session_id);
          if (live) {
            sendJson(response, 200, { session: { ...live, codexHomeId: record.codex_home_id, workspaceId, taskGuid: workspace.task_guid, workspaceBranch: workspace.branch, workspaceStatus: workspace.status } });
            return;
          }
          this.db.markTmuxSessionEnded(record.tmux_session_id);
        }
        const requestedName = typeof body.name === "string" ? body.name.trim() : "";
        const name = requestedName || workspaceSessionName(workspace.branch, workspace.workspace_id);
        const workingDirectory = await verifyTaskWorkspace(workspace);
        const session = await this.operations.createSession(name, workingDirectory);
        this.invalidateSessionList();
        this.db.recordTmuxSession(session, {
          projectKey: workspace.project_key,
          createdByDeviceId: deviceId,
          workspaceId,
        });
        sendJson(response, 201, {
          session: { ...session, codexHomeId: null, workspaceId, taskGuid: workspace.task_guid, workspaceBranch: workspace.branch, workspaceStatus: workspace.status },
        });
      } catch (error) {
        sendDashboardError(response, error);
      }
      return;
    }
    const sessionTaskMatch = /^\/sessions\/([^/]+)\/tasks$/.exec(apiPath);
    if (request.method === "POST" && sessionTaskMatch) {
      if (!this.createTaskFromSession) { sendJson(response, 501, { error: "Bridge Task Desk task creation is unavailable." }); return; }
      let sessionId: string;
      try { sessionId = decodeURIComponent(sessionTaskMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      let body: Record<string, unknown>;
      try { body = await readJsonBody(request); }
      catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "Expected a JSON request body." }); return; }
      if (typeof body.description !== "string" || !body.description.trim() || body.description.length > 20_000) {
        sendJson(response, 400, { error: "description must contain 1 to 20000 characters" });
        return;
      }
      if (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length > 300)) {
        sendJson(response, 400, { error: "summary must be a string up to 300 characters" });
        return;
      }
      if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200)) {
        sendJson(response, 400, { error: "idempotencyKey must contain 1 to 200 characters" });
        return;
      }
      if (typeof body.sourceDirectory !== "string" || !body.sourceDirectory.trim() || body.sourceDirectory.length > 4_096
        || typeof body.expectedBaseSha !== "string" || !/^[a-f\d]{40,64}$/i.test(body.expectedBaseSha)) {
        sendJson(response, 400, { error: "sourceDirectory and expectedBaseSha are required" });
        return;
      }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
        const panePath = this.operations.getCurrentPanePath
          ? await this.operations.getCurrentPanePath(sessionId, session)
          : session.cwd;
        const source = await inspectTaskSourceDirectory(panePath);
        const project = await this.projectForSession(sessionId, panePath);
        this.db.recordTmuxSession(session, { projectKey: project.name, createdByDeviceId: deviceId });
        const task = await this.createTaskFromSession({
          idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
          summary: typeof body.summary === "string" ? body.summary : undefined,
          description: body.description,
          projectKey: project.name,
          createWorktree: true,
        }, {
          directory: source.directory,
          tmuxSessionId: sessionId,
          expectedDirectory: body.sourceDirectory,
          expectedBaseSha: body.expectedBaseSha,
        });
        sendJson(response, 201, { task, latest_run: this.db.getLatestRun(task.task_guid) });
      } catch (error) {
        if (error instanceof GitWorkspaceError) {
          sendJson(response, error.statusCode, { error: error.message });
        } else {
          sendDashboardError(response, error);
        }
      }
      return;
    }
    const sessionOpenMatch = /^\/sessions\/([^/]+)\/open$/.exec(apiPath);
    if (request.method === "POST" && sessionOpenMatch) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(sessionOpenMatch[1]!); }
      catch { sendJson(response, 400, { error: "Invalid tmux session id." }); return; }
      try {
        const session = await this.operations.findSession(sessionId);
        if (!session) throw new tmux.SessionNotFoundError("Session no longer exists.");
        const saved = this.db.recordTmuxSessionOpen(sessionId);
        if (!saved) throw new tmux.SessionNotFoundError("Session record no longer exists.");
        sendJson(response, 200, {
          session: {
            id: session.id,
            name: session.name,
            openCount: saved.open_count,
            lastOpenedAt: saved.last_opened_at,
          },
        });
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
        const live = await this.operations.findSession(sessionId);
        const saved = this.db.getLatestTmuxSession(sessionId);
        const sessionName = live?.name ?? saved?.session_name;
        if (live) await this.operations.killSession(sessionId);
        else if (!saved || saved.ended_at !== null || saved.suspended_at === null) {
          throw new tmux.SessionNotFoundError("Session no longer exists.");
        }
        this.invalidateSessionList();
        this.db.markTmuxSessionEnded(sessionId);
        if (sessionName && this.manageSessionSnapshots) this.resurrect.disableSession(sessionName);
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
    deviceId: string | null,
    isAuthorized: () => boolean,
    verifiedMobileTicket = false,
  ): Promise<void> {
    if (!isAuthorized()) {
      rejectUpgrade(socket, 401, "pairing required");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/tmux-dashboard/terminal") {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    try {
      const nativeTicketOrigin = verifiedMobileTicket && (!origin || isNativeAppOrigin(origin));
      if (!nativeTicketOrigin && (!origin || new URL(origin).host !== request.headers.host)) {
        rejectUpgrade(socket, 403, "Cross-origin terminal connections are not allowed.");
        return;
      }
    } catch {
      rejectUpgrade(socket, 403, "Cross-origin terminal connections are not allowed.");
      return;
    }

    const sessionId = url.searchParams.get("session") || "";
    const session = tmux.isSessionId(sessionId) ? await this.operations.findSession(sessionId) : undefined;
    if (!isAuthorized()) {
      rejectUpgrade(socket, 401, "pairing required");
      return;
    }
    if (!session) {
      rejectUpgrade(socket, 404, "tmux session not found.");
      return;
    }
    const storedSession = this.db.observeTmuxSession(session);
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
        isAuthorized,
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.sessionListController?.abort(new Error("Tmux Dashboard stopped"));
    for (const client of this.clients) client.close(1001, "Server shutting down");
    this.clients.clear();
    this.websocketServer.close();
    await this.attachmentUploads.dispose();
  }

  public revalidateClients(): void {
    for (const check of this.clientAuthorizationChecks.values()) check();
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
    if (this.attachmentDirectory !== ATTACHMENT_DIRECTORY) {
      await mkdir(this.attachmentDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.attachmentDirectory, 0o700);
      return;
    }
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
    for (const directory of this.attachmentDirectories) {
      const filePath = join(directory, fileName);
      const fileInfo = await lstat(filePath).catch(() => null);
      if (fileInfo?.isFile() && !fileInfo.isSymbolicLink()) return filePath;
    }
    return null;
  }

  private scheduleCodexSkillRefresh(
    codexHomePath: string,
    projectCwd: string,
    scopeKeys: string[],
  ): Promise<void> | null {
    const scopeKey = [...scopeKeys].sort().join("\u0000");
    if (!scopeKey) return null;
    const active = this.skillRefreshes.get(scopeKey);
    if (active) return active;

    const now = Date.now();
    const lastAttempt = this.skillRefreshAttempts.get(scopeKey) ?? 0;
    if (now - lastAttempt < CODEX_SKILL_REFRESH_RETRY_MS) return null;
    this.skillRefreshAttempts.set(scopeKey, now);

    const refresh = (async (): Promise<void> => {
      const discovery = await discoverCodexSkills({ codexHomePath, projectCwd });
      this.db.syncCodexSkills(discovery.sources, discovery.skills);
    })();
    this.skillRefreshes.set(scopeKey, refresh);
    void refresh.catch(() => undefined).finally(() => {
      if (this.skillRefreshes.get(scopeKey) === refresh) this.skillRefreshes.delete(scopeKey);
    });
    return refresh;
  }

  private async validateReviewRequest(
    sessionId: string,
    targetValue: unknown,
    rawAnchors: unknown,
  ): Promise<{ target: TmuxReviewTarget; anchors: TmuxReviewAnchor[]; pane: tmux.TmuxReviewPaneSnapshot }> {
    const target = parseTmuxReviewTarget(targetValue);
    if (!target || target.sessionId !== sessionId) {
      throw new DashboardBodyError("A valid original Session review target is required.", 400);
    }
    if (!Array.isArray(rawAnchors) || rawAnchors.length < 1 || rawAnchors.length > MAX_GIT_REVIEW_ANCHORS) {
      throw new DashboardBodyError("A review request requires 1..20 line anchors.", 400);
    }
    const parsedAnchors = rawAnchors.map(parseTmuxReviewAnchor);
    if (parsedAnchors.some((anchor) => anchor === null)) {
      throw new DashboardBodyError("A review anchor is invalid.", 400);
    }
    const anchors = parsedAnchors as TmuxReviewAnchor[];
    const context = await this.readReviewContext(sessionId);
    const mismatch = tmuxReviewTargetMismatch(target, {
      sessionExists: true,
      sessionId,
      paneId: context.pane.paneId,
      gitRoot: context.inspection.gitRoot,
      foregroundCodex: context.pane.foregroundCodex,
    });
    if (mismatch) throw new DashboardBodyError(mismatch, 409);

    for (const anchor of anchors) {
      let untrackedText: string | undefined;
      const file = context.inspection.files.find((candidate) => candidate.path === anchor.path);
      if (file?.status === "untracked") {
        const preview = await previewGitChangeFile(context.pane.cwd, file.path, target.gitRoot);
        if (preview.kind === "text" && !preview.truncated && typeof preview.text === "string") {
          untrackedText = preview.text;
        }
      }
      const anchorMismatch = reviewAnchorMismatch(
        anchor,
        context.inspection.files,
        context.inspection.patch,
        untrackedText,
      );
      if (anchorMismatch) throw new DashboardBodyError(`Review anchor is stale: ${anchorMismatch}`, 409);
    }
    return { target, anchors, pane: context.pane };
  }

  private async readReviewContext(sessionId: string): Promise<{
    session: tmux.TmuxSession;
    pane: tmux.TmuxReviewPaneSnapshot;
    inspection: Awaited<ReturnType<typeof inspectGitChanges>>;
  }> {
    const session = await this.operations.findSession(sessionId);
    if (!session) throw new tmux.SessionNotFoundError("tmux session not found.");
    if (!this.operations.inspectReviewPane) {
      throw new DashboardBodyError("Foreground tmux pane inspection is unavailable.", 503);
    }
    const pane = await this.operations.inspectReviewPane(sessionId, session);
    const inspection = await inspectGitChanges(pane.cwd);
    return { session, pane, inspection };
  }

  private invalidateSessionList(): void {
    this.sessionListGeneration += 1;
    const controller = this.sessionListController;
    this.sessionListController = undefined;
    this.sessionListRefresh = null;
    // A query started before create/delete must not rewrite the newer Session state.
    controller?.abort(new DashboardBodyError("Session 列表已变化，请重新读取。", 503));
  }

  private async listLiveSessions(): Promise<tmux.TmuxSession[]> {
    if (this.sessionListRefresh) return this.sessionListRefresh;
    const generation = this.sessionListGeneration;
    const controller = new AbortController();
    this.sessionListController = controller;
    const started = performance.now();
    let phase = "tmux-enumeration";
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new DashboardBodyError("tmux Session 列表查询超时，请重试。", 503);
        reject(error);
        controller.abort(error);
      }, this.sessionListTimeoutMs);
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const refresh = (async () => {
      let sessions = await Promise.race([this.operations.listSessions({ signal: controller.signal }), timeout]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (generation !== this.sessionListGeneration) throw new DashboardBodyError("Session 列表已变化，请重新读取。", 503);
      const enumerationMs = Math.round(performance.now() - started);
      if (this.autoRestoreSessions) {
        const activeSessionNames = this.db.listTmuxSessionsForDashboard()
          .filter((saved) => saved.ended_at === null && saved.suspended_at === null)
          .map((saved) => saved.session_name);
        const restoreResult = await this.resurrect.restorePendingSessions(
          activeSessionNames,
          sessions.map((session) => session.name),
        );
        for (const failure of restoreResult.failures) {
          this.logger?.warn("could not restore tmux Session snapshot", failure);
        }
        if (restoreResult.restored.length > 0) {
          phase = "tmux-enumeration-after-restore";
          sessions = await this.operations.listSessions({ signal: controller.signal });
        }
      }
      phase = "database-sync";
      this.db.syncTmuxSessions(sessions);
      const elapsedMs = Math.round(performance.now() - started);
      if (elapsedMs >= 1_000) this.logger?.warn("tmux session list query was slow", {
        elapsedMs, enumerationMs, databaseMs: elapsedMs - enumerationMs,
      });
      return sessions;
    })();
    this.sessionListRefresh = refresh;
    try {
      return await refresh;
    } catch (error) {
      if (!this.stopped && generation === this.sessionListGeneration) this.logger?.warn("tmux session list query failed", {
        phase, elapsedMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timer!);
      if (this.sessionListRefresh === refresh) this.sessionListRefresh = null;
      if (this.sessionListController === controller) this.sessionListController = undefined;
    }
  }

  private codexHomeOptions(): CodexHistoryHome[] {
    const now = Date.now();
    if (this.codexHomeOptionsCache && now - this.codexHomeOptionsCache.at < CODEX_HOME_OPTIONS_CACHE_MS) {
      return this.codexHomeOptionsCache.homes;
    }
    const homes = this.discoverCodexHomes();
    this.codexHomeOptionsCache = { at: now, homes };
    return homes;
  }

  private async projectForSession(sessionId: string, directory: string): Promise<{ name: string; path: string }> {
    const sessionRecord = this.db.getLatestTmuxSession(sessionId);
    const registeredProject = sessionRecord?.project_key ? this.db.getAvailableProject(sessionRecord.project_key) : null;
    const sourceRoot = await resolveGitRoot(directory);
    const sourceCommonDirectory = await resolveGitCommonDirectory(sourceRoot);
    const matches: Array<{ name: string; path: string }> = [];
    for (const project of this.db.listAvailableProjects()) {
      try {
        const projectRoot = await resolveGitRoot(project.path);
        if (await resolveGitCommonDirectory(projectRoot) === sourceCommonDirectory) {
          matches.push({ name: project.name, path: project.path });
        }
      } catch {
        // A project can be registered while its Git checkout is unavailable.
      }
    }
    const preferred = registeredProject && matches.find((project) => project.name === registeredProject.name);
    if (preferred) return preferred;
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new GitWorkspaceError("此仓库登记了多个项目名称，请先为 tmux Session 指定项目。", 409);
    }
    throw new GitWorkspaceError("当前 Session 目录不属于任何可用的登记项目。", 409);
  }

  private async codexHomePathForSession(sessionId: string, session?: tmux.TmuxSession): Promise<string> {
    const sessionRecord = this.db.getLatestTmuxSession(sessionId);
    const savedHome = sessionRecord?.codex_home_id
      ? this.codexHomeOptions().find((home) => home.id === sessionRecord.codex_home_id)
      : undefined;
    if (savedHome) return resolve(savedHome.path);

    const inspection = this.operations.inspectCodexHome
      ? await this.operations.inspectCodexHome(sessionId, session).catch(() => null)
      : null;
    if (inspection?.status === "running" && inspection.path) return resolve(inspection.path);
    return resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
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
    let stopHeartbeat: (() => void) | null = null;
    const capturePane = this.operations.capturePane ?? tmux.capturePane;
    let initialScreenReady = false;
    let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let outputBytes = 0;
    let immediateOutputFlushUntil = 0;
    const outputQueue: Array<string | Uint8Array> = [];
    const flushOutput = (): void => {
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
      outputBytes = 0;
      if (!ensureAuthorized() || client.readyState !== WebSocket.OPEN || outputQueue.length === 0) {
        outputQueue.length = 0;
        return;
      }
      const chunks = outputQueue.splice(0);
      client.send(Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
    };
    const queueOutput = (output: string | Uint8Array): void => {
      if (cleanedUp || client.readyState !== WebSocket.OPEN) return;
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
      this.clientAuthorizationChecks.delete(client);
      stopHeartbeat?.();
      stopHeartbeat = null;
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
      outputQueue.length = 0;
      try {
        if (data.proc && !data.proc.killed) data.proc.kill("SIGTERM");
      } catch {
        // The attach client may already have exited; never kill the tmux session.
      }
      try { data.terminal?.close(); } catch { /* Already closed. */ }
    };
    const ensureAuthorized = (): boolean => {
      if (cleanedUp) return false;
      if (data.isAuthorized()) return true;
      cleanup();
      if (client.readyState === WebSocket.OPEN) client.close(1008, "Session authorization expired or revoked");
      return false;
    };
    this.clientAuthorizationChecks.set(client, ensureAuthorized);
    client.once("close", cleanup);
    client.once("error", cleanup);
    stopHeartbeat = startTerminalHeartbeat(client, this.heartbeatIntervalMs, setInterval, clearInterval, ensureAuthorized);
    client.on("message", async (message, isBinary) => {
      if (!ensureAuthorized()) return;
      if (isBinary) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message.toString());
      } catch {
        return;
      }
      if (typeof payload !== "object" || payload === null) return;
      const control = payload as { type?: unknown; data?: unknown; text?: unknown; key?: unknown; requestId?: unknown; cols?: unknown; rows?: unknown; review?: unknown };
      if (control.type === "input") {
        const input = validateTerminalInput(control.data);
        if (!input) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "input-error",
              message: "终端输入单次不能超过 32 KiB。",
            }));
          }
          return;
        }
        if (!data.terminal) return;
        try {
          // Raw terminal data intentionally bypasses the message history. It may
          // contain passwords and is emitted once per key stroke.
          data.terminal.write(input);
        } catch {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "input-error",
              message: "无法写入当前 tmux Session。",
            }));
          }
        }
        return;
      }
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
          if (ensureAuthorized() && client.readyState === WebSocket.OPEN) {
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
        if (Object.hasOwn(control, "review") && control.type !== "submit") {
          reply(false, "A Git review target is valid only for a Codex submit.");
          return;
        }
        if (control.type === "submit" && Object.hasOwn(control, "review")) {
          const review = typeof control.review === "object" && control.review !== null
            ? control.review as Record<string, unknown>
            : {};
          const pasteTextToPane = this.operations.pasteTextToPane;
          const sendEnterToPane = this.operations.sendEnterToPane;
          if (!pasteTextToPane || !sendEnterToPane) {
            reply(false, "Explicit tmux pane-targeted review delivery is unavailable.");
            return;
          }
          let initialReview: Awaited<ReturnType<typeof this.validateReviewRequest>>;
          try {
            initialReview = await this.validateReviewRequest(data.sessionId, review.target, review.anchors);
          } catch (error) {
            reply(false, error instanceof Error ? error.message : "The original Git review target is stale.");
            return;
          }
          if (!ensureAuthorized()) return;

          let actionId: string;
          try {
            const fingerprint = await submissionFingerprint(text, this.attachmentDirectories);
            if (!ensureAuthorized()) return;
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

          let pasteAttempted = false;
          let pasted = false;
          let enterAttempted = false;
          try {
            // The HTTP preflight is advisory. Re-read the original target after
            // buffering and immediately before the explicit pane-targeted paste.
            await pasteTextToPane(initialReview.target.paneId, text, async () => {
              if (!ensureAuthorized()) throw new Error("设备权限已失效，评论未粘贴。");
              await this.validateReviewRequest(data.sessionId, review.target, review.anchors);
              if (!ensureAuthorized()) throw new Error("设备权限已失效，评论未粘贴。");
              pasteAttempted = true;
            });
            pasted = true;
            if (!ensureAuthorized()) {
              finishHistory(actionId, "unconfirmed", "设备权限在评论粘贴后失效；未继续发送回车。");
              return;
            }

            await new Promise<void>((resolve) => setTimeout(resolve, TERMINAL_PASTE_SETTLE_MS));
            if (!ensureAuthorized()) {
              finishHistory(actionId, "unconfirmed", "设备权限在评论粘贴后失效；未继续发送回车。");
              return;
            }
            // Enter is targeted to the original pane as well. If Codex exited,
            // another pane became active, or any anchor moved during the paste,
            // leave the text unsubmitted and report the outcome as unconfirmed.
            await sendEnterToPane(initialReview.target.paneId, async () => {
              if (!ensureAuthorized()) throw new Error("设备权限在评论粘贴后失效；未发送回车。");
              const beforeEnter = await this.validateReviewRequest(data.sessionId, review.target, review.anchors);
              if (!ensureAuthorized()) throw new Error("设备权限在评论粘贴后失效；未发送回车。");
              if (beforeEnter.target.paneId !== initialReview.target.paneId) {
                throw new Error("The review pane changed during paste; Enter was withheld.");
              }
              enterAttempted = true;
            });
            if (!ensureAuthorized()) {
              finishHistory(actionId, "unconfirmed", "回车可能已发送，但设备权限在确认前失效。");
              return;
            }
            finishHistory(actionId, "sent");
            reply(true);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Could not send the Git review to its original pane.";
            const mayHaveReachedPane = pasted || pasteAttempted;
            finishHistory(actionId, mayHaveReachedPane ? "unconfirmed" : "failed", message);
            reply(false, enterAttempted
              ? `${message} 回车是否送达不确定，请检查原 pane 后再决定是否重试。`
              : mayHaveReachedPane
                ? `${message} 评论文本可能已粘贴，但没有发送回车。`
                : message);
          }
          return;
        }
        if (control.type === "command") {
          const actionId = beginHistory("terminal_command", text);
          if (!actionId) return;
          try {
            flushOutput();
            immediateOutputFlushUntil = Date.now() + SUBMIT_FAST_FLUSH_WINDOW_MS;
            if (!await writePastedTextThenEnter(data.terminal, text, ensureAuthorized)) {
              finishHistory(actionId, "unconfirmed", "设备权限已失效；消息可能已部分写入，未继续发送回车。");
              return;
            }
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
          const fingerprint = await submissionFingerprint(text, this.attachmentDirectories);
          if (!ensureAuthorized()) return;
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
        const paneBefore = await capturePane(data.sessionId, 200).catch(() => null);
        if (!ensureAuthorized()) {
          finishHistory(actionId, "failed", "设备权限已失效，消息未发送。");
          return;
        }
        if (paneBefore === null) {
          finishHistory(actionId, "failed", "无法读取 session 当前状态。");
          reply(false, "消息未发送：无法读取 session 当前状态，请稍后重试。");
          return;
        }
        try {
          flushOutput();
          immediateOutputFlushUntil = Date.now() + SUBMIT_FAST_FLUSH_WINDOW_MS;
          if (!await writePastedTextThenEnter(data.terminal, text, ensureAuthorized)) {
            finishHistory(actionId, "unconfirmed", "设备权限已失效；消息可能已部分写入，未继续发送回车。");
            return;
          }
          const confirmed = await waitForPaneChange(data.sessionId, paneBefore, text, capturePane, ensureAuthorized);
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
      if (!ensureAuthorized()) return;
      // LaunchAgents may omit locale variables even when the tmux server is UTF-8.
      // Give this attach client a UTF-8 locale so CJK text is emitted correctly.
      const inheritedUtf8Locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG]
        .find((locale) => locale && /UTF-?8/i.test(locale));
      const terminalLocale = inheritedUtf8Locale ?? "C.UTF-8";
      const child = (this.terminalRuntime ?? getBunRuntime()).spawn(["tmux", "attach-session", "-t", data.sessionId], {
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
      const initialScreen = await captureInitialScreen(data.sessionId, data.rows, capturePane);
      if (!ensureAuthorized() || client.readyState !== WebSocket.OPEN) return;
      initialScreenReady = true;
      client.send(Buffer.from(initialScreen));
      void child.exited.then((exitCode) => {
        if (ensureAuthorized() && client.readyState === WebSocket.OPEN) {
          flushOutput();
          client.send(JSON.stringify({ type: "exit", code: exitCode }));
          client.close();
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not attach to tmux session.";
      if (ensureAuthorized() && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "error", message }));
        client.close(1011, "Could not attach to tmux session.");
      }
    }
  }
}

function workspaceSessionName(branch: string, workspaceId: string): string {
  const branchName = branch.split("/").at(-1)?.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return `task-${branchName.slice(0, 46)}-${workspaceId.slice(0, 6)}`;
}

async function captureInitialScreen(sessionId: string, rows: number, capturePane = tmux.capturePane): Promise<string> {
  // Let tmux finish attaching/resizing before taking the snapshot. PTY output
  // during this settling window is intentionally not forwarded to the client.
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  const snapshotRows = Math.max(rows, 1_000);
  let captured: string;
  try {
    captured = await capturePane(sessionId, snapshotRows, {
      alternateScreen: true,
      includeEscapeSequences: true,
    });
  } catch {
    captured = await capturePane(sessionId, snapshotRows, { includeEscapeSequences: true });
  }
  const screen = captured.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  // Clear xterm's local history and paint only the current server-side screen.
  return "\u001b[3J\u001b[2J\u001b[H" + screen;
}

async function waitForPaneChange(sessionId: string, before: string, submittedText: string, capturePane = tmux.capturePane, shouldContinue = () => true): Promise<boolean> {
  for (const delay of [120, 280, 560, 1_120, 2_240]) {
    if (!shouldContinue()) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (!shouldContinue()) return false;
    try {
      const after = await capturePane(sessionId, 200);
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

export async function writePastedTextThenEnter(terminal: BunTerminal, text: string, shouldContinue = () => true): Promise<boolean> {
  // Codex handles bracketed paste asynchronously. Sending the paste terminator
  // and Enter in one PTY write, or inside its paste-burst suppression window,
  // can make the Enter part of the paste event, so the prompt remains visible
  // until the user presses Enter again.
  // A trailing skill token also opens Codex's own skill popup; the first Enter
  // would select that popup item instead of submitting the prompt. A trailing
  // space dismisses the token popup and is trimmed by Codex on submission.
  const pastedText = /(?:^|\s)\$[^\s$]+$/u.test(text) ? text + " " : text;
  if (!shouldContinue()) return false;
  terminal.write("\u001b[200~" + pastedText + "\u001b[201~");
  await new Promise<void>((resolve) => setTimeout(resolve, TERMINAL_PASTE_SETTLE_MS));
  if (!shouldContinue()) return false;
  terminal.write("\r");
  return true;
}

export function validateTerminalInput(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return Buffer.byteLength(value, "utf8") <= MAX_TERMINAL_INPUT_BYTES ? value : null;
}

function countOccurrences(value: string, snippet: string): number {
  if (!snippet) return 0;
  return value.split(snippet).length - 1;
}

export async function submissionFingerprint(text: string, attachmentDirectories = [ATTACHMENT_DIRECTORY, LEGACY_ATTACHMENT_DIRECTORY]): Promise<string> {
  const hash = createHash("sha256");
  let offset = 0;
  for (const match of text.matchAll(SUBMISSION_ATTACHMENT_TAG)) {
    const tag = match[0];
    const path = match[1]!;
    const index = match.index;
    hash.update(text.slice(offset, index));
    const fileName = basename(path);
    const allowedDirectory = attachmentDirectories
      .find((directory) => path === join(directory, fileName));
    let contentDigest: string | null = null;
    if (allowedDirectory && /^[\da-f-]{36}\.[a-z0-9]{1,12}$/i.test(fileName)) {
      const fileInfo = await lstat(path).catch(() => null);
      if (fileInfo?.isFile() && !fileInfo.isSymbolicLink()) {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(path)) digest.update(chunk);
        contentDigest = digest.digest("hex");
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

function attachmentStorageName(fileName: string, contentType: string): string {
  const requestedExtension = extname(basename(fileName)).toLowerCase();
  const normalizedType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = imageExtensionForContentType(normalizedType)
    ?? (/^\.[a-z0-9]{1,12}$/.test(requestedExtension) ? requestedExtension : ".bin");
  return randomUUID() + extension;
}

function sendDashboardError(response: ServerResponse, error: unknown): void {
  const status = error instanceof tmux.TmuxQueryTimeoutError || error instanceof TmuxResurrectUnavailableError ? 503 : error instanceof DownloadUploadError ? error.statusCode : error instanceof DashboardBodyError
    ? error.statusCode
    : error instanceof GitWorkspaceError
      ? error.statusCode
      : error instanceof tmux.ValidationError ? 400 : error instanceof tmux.SessionNotFoundError ? 404 : 500;
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
