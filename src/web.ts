import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";

import { StateDatabase } from "./db.js";
import {
  checkBridgeBackupUpgradeCompatibility,
  createBridgeBackup,
  inspectBridgeBackupMetadata,
  listBridgeBackups,
  restoreBridgeBackup,
  verifyBridgeBackup,
  type BridgeBackupMetadata,
  type BridgeBackupVerification,
  type BridgeAttachmentRoots,
} from "./bridge-backup.js";
import {
  CODEX_HISTORY_DEFAULT_SOURCE_KINDS,
  CODEX_HISTORY_MAX_ATTACHMENT_BYTES,
  isCodexHistoryReasoningEffort,
  CODEX_HISTORY_SOURCE_KINDS,
  CODEX_HISTORY_STATUS_TYPES,
  CodexHistoryService,
  type CodexHistoryArchivedFilter,
} from "./codex-history.js";
import { writeProjectRegistrySnapshot } from "./project-registry.js";
import type { TmuxDashboardApi } from "./tmux-dashboard-api.js";
import { resolveBridgeProjectRoot } from "./portable-runtime.js";
import { readSystemHealth } from "./system-health.js";
import { parseTaskInput } from "./fingerprint.js";
import { PairingRateLimitError, WebPairingAuth } from "./web-auth.js";
import {
  WebTaskSubmissionConflictError,
  DIRECT_TASK_STATUSES,
  type DirectTaskStatus,
  type StoredBridgeTask,
  AAMP_TASK_STATUSES,
  PROJECT_STATUSES,
  SHORTCUT_DISPLAY_MODES,
  SHORTCUT_GROUP_LAYOUTS,
  SHORTCUT_KINDS,
  SHORTCUT_SURFACES,
  TASK_STATES,
  type AampTaskStatus,
  type DatabaseChange,
  type Logger,
  type ProjectStatus,
  type ShortcutDisplayMode,
  type ShortcutGroupLayout,
  type ShortcutKind,
  type ShortcutSurface,
  type StoredShortcut,
  type StoredShortcutGroup,
  type TaskState,
  type StoredProject,
  type StoredWebTaskAttachment,
  type StoredTask,
  type StoredAampTask,
  type WebTaskSubmission,
} from "./types.js";

const MAX_TASK_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_STAGED_TASK_ATTACHMENTS = 100;
const MAX_STAGED_TASK_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_TASK_ATTACHMENTS = 10;
const TASK_FILE_TEXT_EXTENSIONS = new Set([
  "c", "cc", "conf", "cpp", "css", "csv", "go", "h", "hpp", "html", "ini", "java", "js", "json", "jsx",
  "log", "lua", "md", "markdown", "mjs", "py", "rb", "rs", "sh", "sql", "svg", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
]);

interface TaskFileContext {
  rootPath: string;
  absolutePath: string;
  path: string;
}

class TaskFileRequestError extends Error {
  public constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface DashboardServerOptions {
  db: StateDatabase;
  databasePath?: string;
  backupRoot?: string;
  backupAttachmentRoots?: BridgeAttachmentRoots;
  executionMode?: string;
  codexCliPath?: string;
  host: string;
  port: number;
  modes: string[];
  projectRegistrySnapshotPath?: string;
  taskAttachmentsDirectory?: string;
  webRoot?: string;
  auth?: WebPairingAuth;
  tmuxDashboard?: TmuxDashboardApi;
  codexHistory?: CodexHistoryService;
  cleanupExpiredStagedAttachments?: boolean;
  actions?: DashboardActions;
  logger?: Logger;
}

export interface DashboardActions {
  createTask?(input: WebTaskSubmission): Promise<StoredTask>;
  retryWebTask?(taskGuid: string, idempotencyKey: string): Promise<StoredTask>;
  interruptTask(taskGuid: string, reason?: string): Promise<{ ok: boolean; message?: string }>;
  appendFeedback(taskGuid: string, details: string): Promise<{ ok: boolean; state: string }>;
  appendWebFollowup?(taskGuid: string, details: string, idempotencyKey: string): Promise<StoredTask>;
  appendDirectFollowup?(taskId: string, details: string, idempotencyKey: string): Promise<StoredBridgeTask>;
}

export class DashboardServer {
  private readonly options: DashboardServerOptions;
  private readonly actionToken = randomUUID();
  private readonly auth: WebPairingAuth;
  private readonly webRoot: string;
  private readonly taskAttachmentsDirectory: string;
  private readonly eventClients = new Set<ServerResponse>();
  private server: Server | null = null;
  private unsubscribeFromDatabase: (() => void) | null = null;
  private eventSequence = 0;

  constructor(options: DashboardServerOptions) {
    this.options = options;
    this.auth = options.auth
      ?? new WebPairingAuth({ db: options.db, allowLocalRequests: true });
    this.webRoot = options.webRoot ?? findWebRoot();
    this.taskAttachmentsDirectory = resolve(
      options.taskAttachmentsDirectory ?? join(process.cwd(), "runtime", "task-attachments"),
    );
  }

  public async start(): Promise<string> {
    if (this.server) {
      return Promise.reject(new Error("dashboard server is already running"));
    }
    if (this.options.cleanupExpiredStagedAttachments !== false) {
      await this.cleanupExpiredStagedAttachments().catch((error) => {
        this.options.logger?.warn("failed to clean expired staged task attachments", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
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
    const deviceUpdateMatch = /^\/api\/auth\/devices\/([^/]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && deviceUpdateMatch) {
      if (!this.auth.isAuthorized(request)) {
        sendJson(response, 401, { error: "pairing required" });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
        return;
      }
      if (typeof body.deviceName !== "string" || !body.deviceName.trim()) {
        sendJson(response, 400, { error: "device name is required" });
        return;
      }
      const sessionId = decodeURIComponent(deviceUpdateMatch[1]);
      if (!this.auth.renameDevice(request, sessionId, body.deviceName)) {
        sendJson(response, 404, { error: "device not found or name is invalid" });
        return;
      }
      sendJson(response, 200, { ok: true });
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
    if (request.method === "POST" && url.pathname === "/api/auth/pairing/start") {
      if (!this.auth.isAuthorized(request)) {
        sendJson(response, 401, { error: "pairing required" });
        return;
      }
      const pairing = this.auth.startPairing();
      sendJson(response, 200, {
        pairingUrl: buildPairingUrl(request, pairing.code),
        expiresAt: pairing.expiresAt,
      });
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
    if (url.pathname.startsWith("/tmux-dashboard/api/") && this.options.tmuxDashboard) {
      if (!this.requireAuthorization(request, response)) return;
      if (
        request.method === "POST"
        && (/^\/tmux-dashboard\/api\/sessions\/[^/]+\/files\/upload$/.test(url.pathname)
          || /^\/tmux-dashboard\/api\/sessions\/[^/]+\/codex-account(?:\/check)?$/.test(url.pathname))
        && !this.requireActionAuthorization(request, response)
      ) return;
      await this.options.tmuxDashboard.handleRequest(request, response, this.auth.currentDeviceId(request));
      return;
    }
    if (request.method === "GET" && isSpaRoute(url.pathname)) {
      if (
        !this.auth.isAuthorized(request)
        && url.pathname !== "/"
        && url.pathname !== "/index.html"
        && url.pathname !== "/pair-admin"
        && url.pathname !== "/system-management"
        && url.pathname !== "/system-management/devices"
        && url.pathname !== "/system-management/shortcuts"
        && url.pathname !== "/system-management/backups"
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
    if (request.method === "GET" && url.pathname === "/api/shortcut-config") {
      this.sendShortcutConfig(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/shortcut-config/revision") {
      sendJson(response, 200, { revision: this.shortcutConfigRevision() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/shortcut-groups") {
      await this.createShortcutGroup(request, response);
      return;
    }
    const shortcutGroupMatch = /^\/api\/shortcut-groups\/([^/]+)$/.exec(url.pathname);
    if (shortcutGroupMatch) {
      const groupId = decodeURIComponent(shortcutGroupMatch[1]!);
      if (request.method === "PATCH") {
        await this.updateShortcutGroup(groupId, request, response);
        return;
      }
      if (request.method === "DELETE") {
        if (!this.requireActionAuthorization(request, response)) return;
        try {
          if (!this.options.db.deleteShortcutGroup(groupId)) {
            sendJson(response, 404, { error: "shortcut group not found or cannot be deleted" });
            return;
          }
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendJson(response, 409, { error: error instanceof Error ? error.message : "shortcut group cannot be deleted" });
        }
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/shortcuts") {
      await this.createShortcut(request, response);
      return;
    }
    const shortcutMatch = /^\/api\/shortcuts\/([^/]+)$/.exec(url.pathname);
    if (shortcutMatch) {
      const shortcutId = decodeURIComponent(shortcutMatch[1]!);
      if (request.method === "PATCH") {
        await this.updateShortcut(shortcutId, request, response);
        return;
      }
      if (request.method === "DELETE") {
        if (!this.requireActionAuthorization(request, response)) return;
        if (!this.options.db.deleteShortcut(shortcutId)) {
          sendJson(response, 404, { error: "shortcut not found or cannot be deleted" });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
    }
    const shortcutMoveMatch = /^\/api\/shortcuts\/([^/]+)\/move$/.exec(url.pathname);
    if (request.method === "POST" && shortcutMoveMatch) {
      await this.moveShortcutToEdge(decodeURIComponent(shortcutMoveMatch[1]!), request, response);
      return;
    }
    const shortcutUseMatch = /^\/api\/shortcuts\/([^/]+)\/use$/.exec(url.pathname);
    if (request.method === "POST" && shortcutUseMatch) {
      if (!this.requireActionAuthorization(request, response)) return;
      const shortcut = this.options.db.recordShortcutUse(decodeURIComponent(shortcutUseMatch[1]!));
      if (!shortcut) {
        sendJson(response, 404, { error: "shortcut not found" });
        return;
      }
      sendJson(response, 200, { shortcut: publicShortcut(shortcut) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      sendJson(response, 200, { projects: this.listProjects() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/codex/usage") {
      if (!this.options.codexHistory) {
        sendJson(response, 501, { error: "Codex usage is not configured" });
        return;
      }
      try {
        const homeId = url.searchParams.get("home")?.trim();
        sendJson(response, 200, await this.options.codexHistory.readUsage(homeId || undefined));
      } catch {
        sendJson(response, 502, { error: "Codex usage could not be loaded" });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex/usage/reset-credit/consume") {
      const history = this.options.codexHistory;
      if (!history) {
        sendJson(response, 501, { error: "Codex usage is not configured" });
        return;
      }
      if (!this.requireActionAuthorization(request, response)) return;
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
        return;
      }
      const homeId = typeof body.homeId === "string" ? body.homeId.trim() : "";
      const creditId = typeof body.creditId === "string" ? body.creditId.trim() : "";
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
      if (!homeId || !creditId || !idempotencyKey || idempotencyKey.length > 200) {
        sendJson(response, 400, { error: "homeId, creditId and idempotencyKey are required" });
        return;
      }
      try {
        const result = await history.consumeResetCredit(homeId, creditId, idempotencyKey);
        sendJson(response, 200, result);
      } catch {
        sendJson(response, 502, { error: "重置卡消费结果未确认，请使用相同请求重试或刷新账户状态。" });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/codex/homes") {
      if (!this.options.codexHistory) {
        sendJson(response, 501, { error: "Codex history is not configured" });
        return;
      }
      sendJson(response, 200, { homes: this.options.codexHistory.listHomes() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex/attachments") {
      await this.uploadCodexHistoryAttachment(request, response);
      return;
    }
    const codexThreadHomePreferenceMatch = /^\/api\/codex\/threads\/([^/]+)\/home$/.exec(url.pathname);
    if (request.method === "PATCH" && codexThreadHomePreferenceMatch) {
      await this.updateCodexThreadHomePreference(codexThreadHomePreferenceMatch[1]!, request, response);
      return;
    }
    const codexAttachmentMatch = /^\/api\/codex\/attachments\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && codexAttachmentMatch) {
      let attachmentId: string;
      try {
        attachmentId = decodeURIComponent(codexAttachmentMatch[1]);
      } catch {
        sendJson(response, 400, { error: "invalid Codex attachment id" });
        return;
      }
      await this.deleteCodexHistoryAttachment(attachmentId, request, response);
      return;
    }
    const codexWriterStatusMatch = /^\/api\/codex\/threads\/([^/]+)\/([^/]+)\/writer-status$/.exec(url.pathname);
    if (request.method === "GET" && codexWriterStatusMatch) {
      let homeId: string;
      let threadId: string;
      try {
        homeId = decodeURIComponent(codexWriterStatusMatch[1]);
        threadId = decodeURIComponent(codexWriterStatusMatch[2]);
      } catch {
        sendJson(response, 400, { error: "invalid Codex thread selector" });
        return;
      }
      await this.getCodexThreadWriterStatus(homeId, threadId, response);
      return;
    }
    const codexRunInterruptMatch = /^\/api\/codex\/threads\/([^/]+)\/([^/]+)\/runs\/([^/]+)\/interrupt$/.exec(url.pathname);
    if (request.method === "POST" && codexRunInterruptMatch) {
      let selectors: string[];
      try {
        selectors = codexRunInterruptMatch.slice(1).map((value) => decodeURIComponent(value));
      } catch {
        sendJson(response, 400, { error: "invalid Codex run selector" });
        return;
      }
      await this.interruptCodexThreadMessage(selectors[0]!, selectors[1]!, selectors[2]!, request, response);
      return;
    }
    const codexRunAttachmentMatch = /^\/api\/codex\/threads\/([^/]+)\/([^/]+)\/runs\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && codexRunAttachmentMatch) {
      let selectors: string[];
      try {
        selectors = codexRunAttachmentMatch.slice(1).map((value) => decodeURIComponent(value));
      } catch {
        sendJson(response, 400, { error: "invalid Codex attachment selector" });
        return;
      }
      await this.getCodexThreadAttachment(selectors[0]!, selectors[1]!, selectors[2]!, selectors[3]!, response);
      return;
    }
    const codexThreadFilePreviewMatch = /^\/api\/codex\/threads\/([^/]+)\/([^/]+)\/files\/preview$/.exec(url.pathname);
    if (request.method === "GET" && codexThreadFilePreviewMatch) {
      let selectors: string[];
      try {
        selectors = codexThreadFilePreviewMatch.slice(1).map((value) => decodeURIComponent(value));
      } catch {
        sendJson(response, 400, { error: "invalid Codex file selector" });
        return;
      }
      await this.getCodexThreadFilePreview(
        selectors[0]!,
        selectors[1]!,
        url.searchParams.get("path") ?? "",
        response,
      );
      return;
    }
    const codexThreadMessagesMatch = /^\/api\/codex\/threads\/([^/]+)\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method === "POST" && codexThreadMessagesMatch) {
      let homeId: string;
      let threadId: string;
      try {
        homeId = decodeURIComponent(codexThreadMessagesMatch[1]);
        threadId = decodeURIComponent(codexThreadMessagesMatch[2]);
      } catch {
        sendJson(response, 400, { error: "invalid Codex thread selector" });
        return;
      }
      await this.sendCodexThreadMessage(
        homeId,
        threadId,
        request,
        response,
      );
      return;
    }
    const codexThreadUpdatesMatch = /^\/api\/codex\/threads\/([^/]+)\/([^/]+)\/updates$/.exec(url.pathname);
    if (request.method === "GET" && codexThreadUpdatesMatch) {
      let homeId: string;
      let threadId: string;
      try {
        homeId = decodeURIComponent(codexThreadUpdatesMatch[1]);
        threadId = decodeURIComponent(codexThreadUpdatesMatch[2]);
      } catch {
        sendJson(response, 400, { error: "invalid Codex thread selector" });
        return;
      }
      await this.getCodexThreadUpdates(
        homeId,
        threadId,
        url,
        response,
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/codex/threads") {
      await this.listCodexThreads(url, response);
      return;
    }
    const codexThreadMatch = /^\/api\/codex\/threads\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && codexThreadMatch) {
      let homeId: string;
      let threadId: string;
      try {
        homeId = decodeURIComponent(codexThreadMatch[1]);
        threadId = decodeURIComponent(codexThreadMatch[2]);
      } catch {
        sendJson(response, 400, { error: "invalid Codex thread selector" });
        return;
      }
      await this.getCodexThread(homeId, threadId, url, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      await this.createProject(request, response);
      return;
    }
    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
    if (projectMatch && request.method === "PATCH") {
      let name: string;
      try {
        name = decodeURIComponent(projectMatch[1]);
      } catch {
        sendJson(response, 400, { error: "invalid project name" });
        return;
      }
      await this.updateProject(name, request, response);
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
    if (request.method === "GET" && url.pathname === "/api/system/health") {
      if (!this.options.databasePath) {
        sendJson(response, 503, { error: "运行状态暂不可用" });
        return;
      }
      try {
        sendJson(response, 200, await readSystemHealth({
          databasePath: this.options.databasePath,
          tmuxAttachmentRoots: this.options.backupAttachmentRoots?.tmux,
          mode: this.options.executionMode ?? "unknown",
          codexCliPath: this.options.codexCliPath,
        }));
      } catch (error) {
        this.options.logger?.warn("could not read system health", { error: error instanceof Error ? error.message : String(error) });
        sendJson(response, 503, { error: "运行状态暂不可用" });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/system/backups") {
      await this.listSystemBackups(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/system/backups/create") {
      await this.createSystemBackup(request, response);
      return;
    }
    const systemBackupMatch = /^\/api\/system\/backups\/([^/]+)\/(verify|check-upgrade|restore)$/.exec(url.pathname);
    if (systemBackupMatch && request.method === "POST") {
      let backupId: string;
      try { backupId = decodeURIComponent(systemBackupMatch[1]!); }
      catch { sendJson(response, 400, { error: "无效的备份标识" }); return; }
      await this.runSystemBackupAction(
        backupId,
        systemBackupMatch[2] as "verify" | "check-upgrade" | "restore",
        request,
        response,
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      this.listTasks(url, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/task-panel") {
      this.listTaskPanel(url, response);
      return;
    }
    const taskPanelAampMatch = /^\/api\/task-panel\/aamp\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && taskPanelAampMatch) {
      let taskId: string;
      try { taskId = decodeURIComponent(taskPanelAampMatch[1]!); }
      catch { sendJson(response, 400, { error: "invalid AAMP task selector" }); return; }
      this.getTaskPanelAampTask(taskId, response);
      return;
    }
    const taskPanelFollowupMatch = /^\/api\/task-panel\/(desk|direct)\/([^/]+)\/followups$/.exec(url.pathname);
    if (request.method === "POST" && taskPanelFollowupMatch) {
      let taskId: string;
      try { taskId = decodeURIComponent(taskPanelFollowupMatch[2]!); }
      catch { sendJson(response, 400, { error: "invalid task selector" }); return; }
      await this.appendTaskPanelFollowup(taskPanelFollowupMatch[1] as "desk" | "direct", taskId, request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tasks") {
      await this.createTask(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tasks/attachments") {
      await this.uploadTaskAttachment(request, response);
      return;
    }
    const stagedAttachmentMatch = /^\/api\/tasks\/attachments\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && stagedAttachmentMatch) {
      await this.deleteStagedTaskAttachment(decodeURIComponent(stagedAttachmentMatch[1]), request, response);
      return;
    }
    const taskAttachmentMatch = /^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && taskAttachmentMatch) {
      await this.getTaskAttachment(
        decodeURIComponent(taskAttachmentMatch[1]),
        decodeURIComponent(taskAttachmentMatch[2]),
        response,
      );
      return;
    }
    const taskFilesMatch = /^\/api\/tasks\/([^/]+)\/files$/.exec(url.pathname);
    if (request.method === "GET" && taskFilesMatch) {
      let taskGuid: string;
      try {
        taskGuid = decodeURIComponent(taskFilesMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "invalid task selector" });
        return;
      }
      await this.listTaskFiles(
        taskGuid,
        url.searchParams.get("path") ?? "",
        response,
      );
      return;
    }
    const taskFileMatch = /^\/api\/tasks\/([^/]+)\/files\/(content|download)$/.exec(url.pathname);
    if (request.method === "GET" && taskFileMatch) {
      let taskGuid: string;
      try {
        taskGuid = decodeURIComponent(taskFileMatch[1]!);
      } catch {
        sendJson(response, 400, { error: "invalid task selector" });
        return;
      }
      const path = url.searchParams.get("path") ?? "";
      if (taskFileMatch[2] === "content") {
        await this.previewTaskFile(taskGuid, path, response);
      } else {
        await this.downloadTaskFile(taskGuid, path, response);
      }
      return;
    }
    const runReviewMatch = /^\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/review$/.exec(url.pathname);
    if (request.method === "PUT" && runReviewMatch) {
      let taskGuid: string;
      let runId: string;
      try {
        taskGuid = decodeURIComponent(runReviewMatch[1]!);
        runId = decodeURIComponent(runReviewMatch[2]!);
      } catch {
        sendJson(response, 400, { error: "invalid run selector" });
        return;
      }
      await this.saveWebRunReview(taskGuid, runId, request, response);
      return;
    }
    const webRetryMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);
    if (request.method === "POST" && webRetryMatch) {
      let taskGuid: string;
      try { taskGuid = decodeURIComponent(webRetryMatch[1]!); }
      catch { sendJson(response, 400, { error: "invalid task selector" }); return; }
      await this.retryWebTask(taskGuid, request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/direct/tasks") {
      this.listDirectTasks(url, response);
      return;
    }
    const directTaskMatch = /^\/api\/direct\/tasks\/([^/]+)$/.exec(url.pathname);
    if (directTaskMatch && request.method === "GET") {
      let taskId: string;
      try { taskId = decodeURIComponent(directTaskMatch[1]!); }
      catch { sendJson(response, 400, { error: "invalid Direct task id" }); return; }
      this.getDirectTask(taskId, url, response);
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
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH" && request.method !== "DELETE") {
      response.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE");
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
        projects: this.options.db.listAvailableProjects().map((project) => project.name),
        modes: this.options.modes,
      },
    });
  }

  private listTaskPanel(url: URL, response: ServerResponse): void {
    const rawStates = url.searchParams.getAll("state")
      .flatMap((value) => value.split(","))
      .filter(Boolean);
    const states = rawStates.filter((state) => state === "ATTENTION" || isTaskState(state) || DIRECT_TASK_STATUSES.includes(state as DirectTaskStatus) || isAampTaskStatus(state));
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
    const source = url.searchParams.get("source") ?? "all";
    if (source !== "all" && source !== "desk" && source !== "direct" && source !== "aamp") {
      sendJson(response, 400, { error: "invalid task source" });
      return;
    }
    const result = this.options.db.queryTaskPanel({
      source,
      states,
      projectKey: cleanParam(url.searchParams.get("project")),
      mode: cleanParam(url.searchParams.get("mode")),
      search: cleanParam(url.searchParams.get("q")),
      limit,
      offset,
    });
    sendJson(response, 200, {
      items: result.items.map((entry) => entry.source === "direct"
        ? directTaskView(entry.task)
        : entry.source === "aamp"
          ? aampTaskView(entry.task)
          : {
          ...entry.task,
          source: "desk" as const,
          input: parseTaskInput(entry.task.input_text),
          latest_run: this.options.db.getLatestRun(entry.task.task_guid),
          latest_review: this.options.db.getLatestWebRunReview(entry.task.task_guid),
        }),
      total: result.total,
      limit,
      offset,
      filters: {
        states: ["ATTENTION", ...TASK_STATES, ...DIRECT_TASK_STATUSES.filter((state) => !TASK_STATES.includes(state as TaskState)), ...AAMP_TASK_STATUSES],
        projects: this.options.db.listAvailableProjects().map((project) => project.name),
        modes: this.options.modes,
      },
    });
  }

  private async listCodexThreads(url: URL, response: ServerResponse): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    const limit = parseInteger(url.searchParams.get("limit"), 50, 1, 200);
    const offset = parseInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
    if (limit === null || offset === null) {
      sendJson(response, 400, { error: "invalid Codex history pagination" });
      return;
    }
    try {
      const result = await history.listThreads({
        homeId: cleanParam(url.searchParams.get("home")),
        searchTerm: cleanParam(url.searchParams.get("q")),
        statuses: parseCodexHistoryStatuses(url.searchParams.getAll("status")),
        sourceKinds: parseCodexHistorySources(url.searchParams.getAll("source")),
        modelProviders: parseCodexHistoryValues(url.searchParams.getAll("provider")),
        cwd: parseCodexHistoryCwds(url.searchParams.getAll("cwd")),
        archived: parseCodexHistoryArchived(url.searchParams.get("archived")),
        sortKey: parseCodexHistorySortKey(url.searchParams.get("sort")),
        sortDirection: parseCodexHistorySortDirection(url.searchParams.get("direction")),
        limit,
        offset,
      });
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        dataSource: "codex-app-server",
        ...result,
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid Codex history query" });
    }
  }

  private async updateCodexThreadHomePreference(
    encodedThreadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    if (!this.requireActionAuthorization(request, response)) return;
    let threadId: string;
    let body: Record<string, unknown>;
    try {
      threadId = decodeURIComponent(encodedThreadId);
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
      return;
    }
    const preferredHomeId = typeof body.preferredHomeId === "string" ? body.preferredHomeId.trim() : "";
    if (!threadId.trim() || !preferredHomeId) {
      sendJson(response, 400, { error: "threadId and preferredHomeId are required" });
      return;
    }
    try {
      sendJson(response, 200, history.setThreadHomePreference(threadId, preferredHomeId));
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : "Codex Home preference could not be saved" });
    }
  }

  private async getCodexThread(
    homeId: string,
    threadId: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    try {
      const result = await history.readThread(homeId, threadId, url.searchParams.get("turns") !== "0");
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.startsWith("找不到 Codex home") ? 404 : 502, { error: message });
    }
  }

  private async getCodexThreadFilePreview(
    homeId: string,
    threadId: string,
    requestedPath: string,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }

    let workingDirectory: string | undefined;
    try {
      const detail = await history.readThread(homeId, threadId, false);
      workingDirectory = detail.thread.cwd;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.startsWith("找不到 Codex home") ? 404 : 502, { error: message });
      return;
    }
    if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) {
      sendJson(response, 404, { error: "Codex thread working directory is unavailable" });
      return;
    }

    try {
      const rootPath = await realpath(workingDirectory);
      const relativePath = normalizeTaskRelativePath(requestedPath);
      if (!relativePath) throw new TaskFileRequestError(400, "Select a file to preview.");
      const candidatePath = resolve(rootPath, relativePath);
      if (!isTaskPathInside(rootPath, candidatePath)) {
        throw new TaskFileRequestError(400, "The requested path is outside the Codex thread directory.");
      }
      const absolutePath = await realpath(candidatePath);
      if (!isTaskPathInside(rootPath, absolutePath)) {
        throw new TaskFileRequestError(403, "The requested path is outside the Codex thread directory.");
      }
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) throw new TaskFileRequestError(400, "Select a file to preview.");
      const extension = extname(absolutePath).slice(1).toLowerCase();
      const imageContentType = taskImageContentType(extension);
      const isImage = imageContentType !== null;
      if (!isImage && !TASK_FILE_TEXT_EXTENSIONS.has(extension)) {
        throw new TaskFileRequestError(415, "This file type does not support preview.");
      }
      const sizeLimit = isImage ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
      if (fileStat.size > sizeLimit) {
        throw new TaskFileRequestError(413, isImage ? "Images larger than 20 MiB cannot be previewed here." : "Text files larger than 2 MiB cannot be previewed here.");
      }
      const contents = await readFile(absolutePath);
      setSecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", imageContentType ?? "text/plain; charset=utf-8");
      response.setHeader("Content-Length", String(contents.length));
      response.setHeader("Content-Disposition", attachmentDisposition(basename(absolutePath), true));
      response.end(contents);
    } catch (error) {
      sendTaskFileError(response, error);
    }
  }

  private async uploadCodexHistoryAttachment(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      request.resume();
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    if (!this.requireActionAuthorization(request, response)) return;
    const fileNameHeader = request.headers["x-file-name"];
    if (typeof fileNameHeader !== "string") {
      request.resume();
      sendJson(response, 400, { error: "x-file-name is required" });
      return;
    }
    let fileName: string;
    try {
      fileName = decodeURIComponent(fileNameHeader);
    } catch {
      request.resume();
      sendJson(response, 400, { error: "invalid file name" });
      return;
    }
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > CODEX_HISTORY_MAX_ATTACHMENT_BYTES) {
      request.resume();
      sendJson(response, 413, { error: "单个附件不能超过 25 MiB。" });
      return;
    }
    let data: Buffer;
    try {
      data = await readBinaryBody(request, CODEX_HISTORY_MAX_ATTACHMENT_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message === "attachment exceeds size limit" ? 413 : 400, { error: message });
      return;
    }
    try {
      const attachment = await history.stageAttachment({
        fileName,
        mimeType: normalizeAttachmentMimeType(request.headers["content-type"]),
        data,
      });
      sendJson(response, 201, { attachment });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.includes("25 MiB") ? 413 : 422, { error: message });
    }
  }

  private async deleteCodexHistoryAttachment(
    attachmentId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    if (!this.requireActionAuthorization(request, response)) return;
    if (!await history.deleteStagedAttachment(attachmentId)) {
      sendJson(response, 404, { error: "Codex history attachment not found or already in use" });
      return;
    }
    response.statusCode = 204;
    response.end();
  }

  private async getCodexThreadAttachment(
    homeId: string,
    threadId: string,
    runId: string,
    attachmentId: string,
    response: ServerResponse,
  ): Promise<void> {
    const attachment = this.options.codexHistory?.getRunAttachment(homeId, threadId, runId, attachmentId);
    if (!attachment) {
      sendJson(response, 404, { error: "Codex thread attachment not found or expired" });
      return;
    }
    let fileStat;
    try {
      fileStat = await stat(attachment.localPath);
    } catch {
      sendJson(response, 410, { error: "Codex thread attachment file is no longer available" });
      return;
    }
    setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", attachment.mimeType);
    response.setHeader("Content-Length", String(fileStat.size));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Disposition", attachmentDisposition(
      attachment.fileName,
      isPreviewableImage(attachment.mimeType),
    ));
    const stream = createReadStream(attachment.localPath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  private async getCodexThreadWriterStatus(
    homeId: string,
    threadId: string,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    try {
      sendJson(response, 200, await history.getWriterStatus(homeId, threadId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.startsWith("找不到 Codex home") ? 404 : 502, { error: message });
    }
  }

  private async interruptCodexThreadMessage(
    homeId: string,
    threadId: string,
    runId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    if (!this.requireActionAuthorization(request, response)) return;
    const result = history.interruptMessage(homeId, threadId, runId);
    sendJson(response, result.ok ? 202 : 409, result);
  }

  private async sendCodexThreadMessage(
    homeId: string,
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    if (!this.requireActionAuthorization(request, response)) return;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
      return;
    }
    if (body.text !== undefined && typeof body.text !== "string") {
      sendJson(response, 400, { error: "text must be a string" });
      return;
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      sendJson(response, 400, { error: "model must be a string" });
      return;
    }
    if (body.reasoningEffort !== undefined
      && (typeof body.reasoningEffort !== "string"
        || !isCodexHistoryReasoningEffort(body.reasoningEffort))) {
      sendJson(response, 400, { error: "reasoningEffort is invalid" });
      return;
    }
    if (body.turnIndex !== undefined && (!Number.isSafeInteger(body.turnIndex) || Number(body.turnIndex) < 0)) {
      sendJson(response, 400, { error: "turnIndex must be a non-negative integer" });
      return;
    }
    if (body.idempotencyKey !== undefined
      && (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim().length < 1
        || body.idempotencyKey.length > 200)) {
      sendJson(response, 400, { error: "idempotencyKey must contain 1 to 200 characters" });
      return;
    }
    const attachmentIds = body.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== "string")) {
      sendJson(response, 400, { error: "attachmentIds must be an array of strings" });
      return;
    }
    try {
      const result = await history.sendMessage(homeId, threadId, {
        text: typeof body.text === "string" ? body.text : "",
        attachmentIds: attachmentIds as string[],
        ...(typeof body.turnIndex === "number" ? { turnIndex: body.turnIndex } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(typeof body.reasoningEffort === "string"
          ? { reasoningEffort: body.reasoningEffort }
          : {}),
        ...(typeof body.idempotencyKey === "string"
          ? { idempotencyKey: body.idempotencyKey.trim() }
          : {}),
      });
      sendJson(response, 202, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("找不到 Codex home") ? 404
        : message.includes("正在处理") || message.includes("幂等") || message.includes("冲突") ? 409
          : 422;
      sendJson(response, status, { error: message });
    }
  }

  private async getCodexThreadUpdates(
    homeId: string,
    threadId: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const history = this.options.codexHistory;
    if (!history) {
      sendJson(response, 501, { error: "Codex history is not configured" });
      return;
    }
    const after = parseInteger(url.searchParams.get("after"), 0, 0, 1_000_000_000);
    if (after === null) {
      sendJson(response, 400, { error: "invalid Codex update cursor" });
      return;
    }
    try {
      const result = await history.getMessageUpdates(
        homeId,
        threadId,
        cleanParam(url.searchParams.get("runId")),
        after,
      );
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 404, { error: message });
    }
  }

  private listDirectTasks(url: URL, response: ServerResponse): void {
    const status = url.searchParams.get("status") || "";
    if (status && !DIRECT_TASK_STATUSES.includes(status as DirectTaskStatus)) {
      sendJson(response, 400, { error: "invalid Direct task status" });
      return;
    }
    const page = this.directPage(url, response);
    if (!page) return;
    const result = this.options.db.listBridgeTasks({
      statuses: status ? [status as DirectTaskStatus] : undefined,
      search: url.searchParams.get("q")?.trim().slice(0, 500), ...page,
    });
    sendJson(response, 200, { ...result, ...page, items: result.items.map(directTaskView) });
  }

  private getDirectTask(taskId: string, url: URL, response: ServerResponse): void {
    const page = this.directPage(url, response);
    if (!page) return;
    const eventsParam = url.searchParams.get("events");
    if (eventsParam !== null && eventsParam !== "0" && eventsParam !== "1") {
      sendJson(response, 400, { error: "invalid events option" });
      return;
    }
    const task = this.options.db.getBridgeTask(taskId);
    if (!task) {
      sendJson(response, 404, { error: "Direct task not found" });
      return;
    }
    const related = this.options.db.readBridgeTaskPage(taskId, page.limit, page.offset, eventsParam !== "0");
    const inbound = this.options.db.getInboundEvent(task.source_event_id);
    sendJson(response, 200, {
      task: directTaskView(task), ...page,
      can_followup: Boolean(this.options.actions?.appendDirectFollowup && task.thread_id && task.status !== "CANCEL_REQUESTED"),
      inbound: inbound ? { event_type: inbound.event_type, received_at: inbound.received_at, processed_at: inbound.processed_at } : null,
      followups: related.followups,
      attachments: { ...related.attachments, items: related.attachments.items.map((attachment) => ({
        attachment_id: attachment.attachment_id, followup_id: attachment.followup_id,
        file_name: attachment.file_name, type: attachment.type, status: attachment.status, error: attachment.error,
      })) },
      events: { ...related.events, items: related.events.items.map((event) => ({
        id: event.id, event_type: event.event_type, created_at: event.created_at,
      })) },
    });
  }

  private directPage(url: URL, response: ServerResponse): { limit: number; offset: number } | null {
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      sendJson(response, 400, { error: "limit must be 1..100 and offset a non-negative integer" });
      return null;
    }
    return { limit, offset };
  }

  private async createTask(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const create = this.options.actions?.createTask;
    if (!create) {
      sendJson(response, 501, { error: "task creation is not configured" });
      return;
    }
    if (!this.requireActionAuthorization(request, response)) return;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
      return;
    }
    if (typeof body.projectKey !== "string" || typeof body.description !== "string" || !body.description.trim()) {
      sendJson(response, 400, { error: "projectKey and non-empty description are required" });
      return;
    }
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string"
      || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200)) {
      sendJson(response, 400, { error: "idempotencyKey must contain 1 to 200 characters" });
      return;
    }
    if (body.summary !== undefined && typeof body.summary !== "string") {
      sendJson(response, 400, { error: "summary must be a string" });
      return;
    }
    if (body.mode !== undefined && typeof body.mode !== "string") {
      sendJson(response, 400, { error: "mode must be a string" });
      return;
    }
    if ("executionBackend" in body || "tmuxSessionId" in body) {
      sendJson(response, 400, { error: "task execution target selection is no longer supported" });
      return;
    }
    const attachmentIds = body.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds)
      || attachmentIds.length > MAX_TASK_ATTACHMENTS
      || attachmentIds.some((attachmentId) => typeof attachmentId !== "string")
      || new Set(attachmentIds).size !== attachmentIds.length) {
      sendJson(response, 400, { error: "attachmentIds must contain up to 10 unique ids" });
      return;
    }
    try {
      const input: WebTaskSubmission = {
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
        summary: typeof body.summary === "string" ? body.summary : undefined,
        description: body.description,
        projectKey: body.projectKey,
        mode: typeof body.mode === "string" ? body.mode : undefined,
        attachmentIds: attachmentIds as string[],
      };
      const task = await create(input);
      sendJson(response, 201, {
        task: { ...task, input: parseTaskInput(task.input_text) },
        latest_run: this.options.db.getLatestRun(task.task_guid),
      });
    } catch (error) {
      sendJson(response, error instanceof WebTaskSubmissionConflictError ? 409 : 422,
        { error: error instanceof Error ? error.message : "task creation failed" });
    }
  }

  private async uploadTaskAttachment(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    const fileNameHeader = request.headers["x-file-name"];
    if (typeof fileNameHeader !== "string") {
      request.resume();
      sendJson(response, 400, { error: "x-file-name is required" });
      return;
    }
    let decodedFileName: string;
    try {
      decodedFileName = decodeURIComponent(fileNameHeader);
    } catch {
      request.resume();
      sendJson(response, 400, { error: "invalid file name" });
      return;
    }
    const fileName = sanitizeAttachmentFileName(decodedFileName);
    if (!fileName) {
      request.resume();
      sendJson(response, 400, { error: "invalid file name" });
      return;
    }
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_TASK_ATTACHMENT_BYTES) {
      request.resume();
      sendJson(response, 413, { error: "单个附件不能超过 25 MiB。" });
      return;
    }
    let data: Buffer;
    try {
      data = await readBinaryBody(request, MAX_TASK_ATTACHMENT_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message === "attachment exceeds size limit" ? 413 : 400, { error: message });
      return;
    }
    if (data.length === 0) {
      sendJson(response, 400, { error: "附件不能为空。" });
      return;
    }

    await this.cleanupExpiredStagedAttachments();
    if (this.options.db.countStagedWebTaskAttachments() >= MAX_STAGED_TASK_ATTACHMENTS) {
      sendJson(response, 429, { error: "待提交附件过多，请先提交或移除旧附件。" });
      return;
    }
    if (this.options.db.stagedWebTaskAttachmentBytes() + data.length > MAX_STAGED_TASK_ATTACHMENT_BYTES) {
      sendJson(response, 429, { error: "待提交附件总容量超过 100 MiB，请先提交或移除旧附件。" });
      return;
    }

    const attachmentId = randomUUID();
    const mimeType = normalizeAttachmentMimeType(request.headers["content-type"]);
    const localPath = join(this.taskAttachmentsDirectory, `${attachmentId}${attachmentFileExtension(fileName, mimeType)}`);
    const temporaryPath = `${localPath}.tmp`;
    try {
      await mkdir(this.taskAttachmentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, data, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, localPath);
      const attachment = this.options.db.createStagedWebTaskAttachment({
        attachmentId,
        fileName,
        mimeType,
        sizeBytes: data.length,
        localPath,
      });
      sendJson(response, 201, { attachment: publicWebTaskAttachment(attachment) });
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      await unlink(localPath).catch(() => undefined);
      sendJson(response, 500, { error: error instanceof Error ? error.message : "附件保存失败。" });
    }
  }

  private async deleteStagedTaskAttachment(
    attachmentId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    const attachment = this.options.db.deleteStagedWebTaskAttachment(attachmentId);
    if (!attachment) {
      sendJson(response, 404, { error: "staged attachment not found" });
      return;
    }
    await unlink(attachment.local_path).catch(() => undefined);
    response.statusCode = 204;
    response.end();
  }

  private async getTaskAttachment(
    taskGuid: string,
    attachmentId: string,
    response: ServerResponse,
  ): Promise<void> {
    const attachment = this.options.db.getWebTaskAttachment(taskGuid, attachmentId);
    if (!attachment) {
      sendJson(response, 404, { error: "task attachment not found" });
      return;
    }
    let fileStat;
    try {
      fileStat = await stat(attachment.local_path);
    } catch {
      sendJson(response, 410, { error: "attachment file is no longer available" });
      return;
    }
    setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", attachment.mime_type);
    response.setHeader("Content-Length", String(fileStat.size));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Disposition", attachmentDisposition(
      attachment.file_name,
      isPreviewableImage(attachment.mime_type),
    ));
    const stream = createReadStream(attachment.local_path);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  private async getTaskFileContext(taskGuid: string, requestedPath: string): Promise<TaskFileContext> {
    const task = this.options.db.getTask(taskGuid);
    if (!task) throw new TaskFileRequestError(404, "task not found");
    if (!this.options.db.getProject(task.project_key) || !task.repo || !isAbsolute(task.repo)) {
      throw new TaskFileRequestError(404, "task working directory is unavailable");
    }

    const rootPath = await realpath(task.repo).catch(() => {
      throw new TaskFileRequestError(404, "task working directory is unavailable");
    });
    const relativePath = normalizeTaskRelativePath(requestedPath);
    const candidatePath = resolve(rootPath, relativePath);
    if (!isTaskPathInside(rootPath, candidatePath)) {
      throw new TaskFileRequestError(400, "The requested path is outside the task directory.");
    }
    const absolutePath = await realpath(candidatePath);
    if (!isTaskPathInside(rootPath, absolutePath)) {
      throw new TaskFileRequestError(403, "The requested path is outside the task directory.");
    }
    return {
      rootPath,
      absolutePath,
      path: relative(rootPath, absolutePath).split(sep).join("/"),
    };
  }

  private async listTaskFiles(taskGuid: string, requestedPath: string, response: ServerResponse): Promise<void> {
    try {
      const context = await this.getTaskFileContext(taskGuid, requestedPath);
      if (!(await stat(context.absolutePath)).isDirectory()) {
        throw new TaskFileRequestError(400, "The selected path is not a directory.");
      }
      const names = await readdir(context.absolutePath);
      const entries: Array<{ name: string; type: "directory" | "file"; size: number; modifiedAt: number }> = [];
      for (const name of names.slice(0, 2_000)) {
        const entryStat = await lstat(join(context.absolutePath, name)).catch(() => null);
        if (!entryStat || entryStat.isSymbolicLink()) continue;
        if (entryStat.isDirectory()) {
          entries.push({ name, type: "directory", size: 0, modifiedAt: entryStat.mtimeMs });
        } else if (entryStat.isFile()) {
          entries.push({ name, type: "file", size: entryStat.size, modifiedAt: entryStat.mtimeMs });
        }
      }
      entries.sort((left, right) => Number(right.type === "directory") - Number(left.type === "directory")
        || left.name.localeCompare(right.name));
      sendJson(response, 200, {
        root: context.rootPath,
        path: context.path,
        entries,
      });
    } catch (error) {
      sendTaskFileError(response, error);
    }
  }

  private async previewTaskFile(taskGuid: string, requestedPath: string, response: ServerResponse): Promise<void> {
    try {
      const context = await this.getTaskFileContext(taskGuid, requestedPath);
      const fileStat = await stat(context.absolutePath);
      if (!fileStat.isFile()) throw new TaskFileRequestError(400, "Select a file to preview.");
      const extension = extname(context.absolutePath).slice(1).toLowerCase();
      const imageContentType = taskImageContentType(extension);
      const isImage = imageContentType !== null;
      if (!isImage && !TASK_FILE_TEXT_EXTENSIONS.has(extension)) {
        throw new TaskFileRequestError(415, "This file type does not support preview.");
      }
      const sizeLimit = isImage ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
      if (fileStat.size > sizeLimit) {
        throw new TaskFileRequestError(413, isImage ? "Images larger than 20 MiB must be downloaded." : "Text files larger than 2 MiB must be downloaded.");
      }
      const contents = await readFile(context.absolutePath);
      setSecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", imageContentType ?? "text/plain; charset=utf-8");
      response.setHeader("Content-Length", String(contents.length));
      response.setHeader("Content-Disposition", attachmentDisposition(basename(context.absolutePath), true));
      response.end(contents);
    } catch (error) {
      sendTaskFileError(response, error);
    }
  }

  private async downloadTaskFile(taskGuid: string, requestedPath: string, response: ServerResponse): Promise<void> {
    try {
      const context = await this.getTaskFileContext(taskGuid, requestedPath);
      const fileStat = await stat(context.absolutePath);
      if (!fileStat.isFile()) throw new TaskFileRequestError(400, "Select a file to download.");
      setSecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(fileStat.size));
      response.setHeader("Content-Disposition", attachmentDisposition(basename(context.absolutePath), false));
      const stream = createReadStream(context.absolutePath);
      stream.on("error", () => {
        if (!response.headersSent) sendJson(response, 404, { error: "File is no longer available." });
        else response.destroy();
      });
      stream.pipe(response);
    } catch (error) {
      sendTaskFileError(response, error);
    }
  }

  private async cleanupExpiredStagedAttachments(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const expired = this.options.db.deleteExpiredStagedWebTaskAttachments(cutoff);
    await Promise.all(expired.map((attachment) => unlink(attachment.local_path).catch(() => undefined)));
  }

  private getTask(taskGuid: string, response: ServerResponse): void {
    const task = this.options.db.getTask(taskGuid);
    if (!task) {
      sendJson(response, 404, { error: "task not found" });
      return;
    }
    sendJson(response, 200, {
      task: { ...task, input: parseTaskInput(task.input_text) },
      can_followup: task.origin === "web"
        ? Boolean(this.options.actions?.appendWebFollowup && task.state !== "RUNNING" && task.state !== "QUEUED")
        : Boolean(this.options.actions?.appendFeedback),
      can_retry: task.origin === "web" && (task.state === "FAILED" || task.state === "CANCELED")
        && Boolean(this.options.actions?.retryWebTask),
      runs: this.options.db.listRunsForTask(taskGuid).map((run) => ({
        ...run,
        events: this.options.db.listRunEvents(run.run_id),
      })),
      attachments: this.options.db.listWebTaskAttachments(taskGuid).map(publicWebTaskAttachment),
      outbox: this.options.db.listOutboxForTask(taskGuid),
      reviews: task.origin === "web" ? this.options.db.listWebRunReviews(taskGuid) : [],
      workspace_snapshots: task.origin === "web" ? this.options.db.listRunWorkspaceSnapshots(taskGuid) : [],
    });
  }

  private async saveWebRunReview(taskGuid: string, runId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request); }
    catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" }); return; }
    if (body.decision !== "accepted" && body.decision !== "changes_requested") {
      sendJson(response, 400, { error: "decision must be accepted or changes_requested" });
      return;
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      sendJson(response, 400, { error: "note must be text" });
      return;
    }
    try {
      const review = this.options.db.saveWebRunReview(taskGuid, runId, body.decision, body.note ?? "");
      sendJson(response, 200, { review });
    } catch (error) {
      const message = error instanceof Error ? error.message : "could not save review";
      sendJson(response, message.includes("不存在") ? 404 : message.includes("1000") ? 400 : 409, { error: message });
    }
  }

  private async retryWebTask(taskGuid: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    if (!this.options.actions?.retryWebTask) { sendJson(response, 501, { error: "Web 任务重试当前不可用" }); return; }
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request); }
    catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" }); return; }
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (!key || key.length > 200) { sendJson(response, 400, { error: "idempotencyKey must contain 1 to 200 characters" }); return; }
    try {
      const task = await this.options.actions.retryWebTask(taskGuid, key);
      sendJson(response, 200, { task: { ...task, input: parseTaskInput(task.input_text) }, latest_run: this.options.db.getLatestRun(taskGuid) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "could not retry task";
      sendJson(response, error instanceof WebTaskSubmissionConflictError ? 409 : 422, { error: message });
    }
  }

  private async appendTaskPanelFollowup(
    source: "desk" | "direct", taskId: string, request: IncomingMessage, response: ServerResponse,
  ): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request); }
    catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" }); return; }
    const details = typeof body.text === "string" ? body.text.trim() : "";
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (!details || details.length > 2000 || !key || key.length > 200) {
      sendJson(response, 400, { error: "text and idempotencyKey are required; text is limited to 2000 characters" });
      return;
    }
    try {
      if (source === "direct") {
        if (!this.options.actions?.appendDirectFollowup) { sendJson(response, 501, { error: "Direct 续问当前不可用" }); return; }
        const task = await this.options.actions.appendDirectFollowup(taskId, details, key);
        sendJson(response, 200, { ok: true, state: task.status });
        return;
      }
      const task = this.options.db.getTask(taskId);
      if (!task) { sendJson(response, 404, { error: "task not found" }); return; }
      if (task.origin === "web") {
        if (!this.options.actions?.appendWebFollowup) { sendJson(response, 501, { error: "Bridge 续问当前不可用" }); return; }
        const updated = await this.options.actions.appendWebFollowup(taskId, details, key);
        sendJson(response, 200, { ok: true, state: updated.state });
      } else {
        if (!this.options.actions?.appendFeedback) { sendJson(response, 501, { error: "飞书任务续问当前不可用" }); return; }
        const result = await this.options.actions.appendFeedback(taskId, details);
        sendJson(response, result.ok ? 200 : 409, result);
      }
    } catch (error) {
      sendJson(response, error instanceof WebTaskSubmissionConflictError ? 409 : 422,
        { error: error instanceof Error ? error.message : "追加信息失败" });
    }
  }

  private backupRootPath(): string {
    if (!this.options.backupRoot || !this.options.databasePath || !this.options.backupAttachmentRoots) {
      throw new Error("系统备份未配置");
    }
    return resolve(this.options.backupRoot);
  }

  private async ensureBackupDirectory(path: string, create: boolean): Promise<boolean> {
    const requested = resolve(path);
    let info = await lstat(requested).catch(() => null);
    if (!info && create) {
      await mkdir(requested, { recursive: true, mode: 0o700 });
      info = await lstat(requested).catch(() => null);
    }
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(requested) !== requested) {
      throw new Error("备份目录必须是本机目录，不能是符号链接");
    }
    return true;
  }

  private async listSystemBackups(response: ServerResponse): Promise<void> {
    try {
      const root = this.backupRootPath();
      if (!await this.ensureBackupDirectory(root, false)) {
        sendJson(response, 200, { backups: [], restoreDirectory: "restores/" });
        return;
      }
      const entries = await listBridgeBackups(root);
      sendJson(response, 200, {
        backups: entries.map((entry) => entry.status === "metadata"
          ? { backupId: basename(entry.backupDirectory), status: entry.status, metadata: publicBackupMetadata(entry.metadata) }
          : { backupId: basename(entry.backupDirectory), status: entry.status, error: "无法读取此备份的清单" }),
        restoreDirectory: "restores/",
      });
    } catch (error) {
      this.logBackupFailure("list", error);
      sendJson(response, 503, { error: "无法读取备份列表，请检查备份目录状态" });
    }
  }

  private async createSystemBackup(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    try {
      const root = this.backupRootPath();
      await this.ensureBackupDirectory(root, true);
      const backupId = `backup-${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
      await createBridgeBackup({
        databasePath: this.options.databasePath!,
        outputDirectory: join(root, backupId),
        attachmentRoots: this.options.backupAttachmentRoots!,
      });
      const metadata = await inspectBridgeBackupMetadata(join(root, backupId));
      sendJson(response, 201, {
        backup: {
          backupId,
          status: "metadata",
          metadata: publicBackupMetadata(metadata),
        },
      });
    } catch (error) {
      this.logBackupFailure("create", error);
      sendJson(response, 422, { error: this.publicBackupError(error) });
    }
  }

  private async runSystemBackupAction(
    backupId: string,
    action: "verify" | "check-upgrade" | "restore",
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    if (!isSafeBackupId(backupId)) {
      sendJson(response, 400, { error: "无效的备份标识" });
      return;
    }
    try {
      const root = this.backupRootPath();
      await this.ensureBackupDirectory(root, false);
      const backupDirectory = join(root, backupId);
      if (action === "verify") {
        const verification = await verifyBridgeBackup(backupDirectory);
        sendJson(response, 200, { backupId, verification: publicBackupMetadata(verification) });
        return;
      }
      if (action === "check-upgrade") {
        const compatibility = await checkBridgeBackupUpgradeCompatibility(backupDirectory);
        sendJson(response, 200, {
          backupId,
          verification: publicBackupMetadata(compatibility.verification),
          compatibility: {
            sourceProgramVersion: compatibility.sourceProgramVersion,
            targetProgramVersion: compatibility.targetProgramVersion,
            sourceSchemaFingerprint: compatibility.sourceSchemaFingerprint,
            migratedSchemaFingerprint: compatibility.migratedSchemaFingerprint,
            compatible: compatibility.compatible,
          },
        });
        return;
      }

      const restoreRoot = join(root, "restores");
      await this.ensureBackupDirectory(restoreRoot, true);
      const restoreId = `restore-${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
      const restored = await restoreBridgeBackup({
        backupDirectory,
        outputDirectory: join(restoreRoot, restoreId),
      });
      sendJson(response, 201, {
        verification: publicBackupMetadata(restored.verification),
        restore: {
          restoreId,
          location: `restores/${restoreId}/`,
          attachmentCount: restored.attachmentCount,
          attachmentBytes: restored.attachmentBytes,
          schemaFingerprint: restored.schemaFingerprint,
        },
      });
    } catch (error) {
      this.logBackupFailure(action, error);
      sendJson(response, 422, { error: this.publicBackupError(error) });
    }
  }

  private publicBackupError(error: unknown): string {
    let message = error instanceof Error ? error.message : "备份操作失败";
    const privatePaths = [
      this.options.backupRoot,
      this.options.databasePath,
      ...(this.options.backupAttachmentRoots ? Object.values(this.options.backupAttachmentRoots).flat() : []),
    ].filter((value): value is string => Boolean(value));
    for (const path of privatePaths) message = message.replaceAll(path, "[Bridge 数据目录]");
    return message.slice(0, 500);
  }

  private logBackupFailure(action: string, error: unknown): void {
    this.options.logger?.warn("system backup operation failed", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private getTaskPanelAampTask(taskId: string, response: ServerResponse): void {
    const task = this.options.db.getAampTask(taskId);
    if (!task) {
      sendJson(response, 404, { error: "AAMP task not found" });
      return;
    }
    sendJson(response, 200, { task: aampTaskView(task), can_followup: false });
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

  private listProjects(): Array<StoredProject & { available: boolean }> {
    return this.options.db.listProjects().map((project) => ({
      ...project,
      available: this.options.db.getAvailableProject(project.name) !== null,
    }));
  }

  private sendShortcutConfig(response: ServerResponse): void {
    const config = this.options.db.getShortcutConfig();
    sendJson(response, 200, {
      groups: config.groups.map(publicShortcutGroup),
      shortcuts: config.shortcuts.map(publicShortcut),
      revision: this.shortcutConfigRevision(config),
    });
  }

  private shortcutConfigRevision(config = this.options.db.getShortcutConfig()): string {
    return createHash("sha256").update(JSON.stringify({
      groups: config.groups.map(publicShortcutGroup),
      shortcuts: config.shortcuts.map(publicShortcut),
    })).digest("hex");
  }

  private async createShortcutGroup(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
      const group = this.options.db.createShortcutGroup({
        title: requiredText(body.title, "title"),
        icon: optionalText(body.icon),
        description: optionalText(body.description),
        surface: optionalShortcutSurface(body.surface),
        layout: optionalShortcutGroupLayout(body.layout),
        sortOrder: optionalInteger(body.sortOrder),
        enabled: optionalBoolean(body.enabled),
      });
      sendJson(response, 201, { group: publicShortcutGroup(group) });
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : "shortcut group creation failed" });
    }
  }

  private async updateShortcutGroup(
    groupId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    try {
      const body = await readJsonBody(request);
      const group = this.options.db.updateShortcutGroup(groupId, {
        ...(body.title !== undefined ? { title: requiredText(body.title, "title") } : {}),
        ...(body.icon !== undefined ? { icon: requiredText(body.icon, "icon") } : {}),
        ...(body.description !== undefined ? { description: optionalText(body.description) ?? "" } : {}),
        ...(body.surface !== undefined ? { surface: requiredShortcutSurface(body.surface) } : {}),
        ...(body.layout !== undefined ? { layout: requiredShortcutGroupLayout(body.layout) } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: requiredInteger(body.sortOrder, "sortOrder") } : {}),
        ...(body.enabled !== undefined ? { enabled: requiredBoolean(body.enabled, "enabled") } : {}),
      });
      if (!group) {
        sendJson(response, 404, { error: "shortcut group not found" });
        return;
      }
      sendJson(response, 200, { group: publicShortcutGroup(group) });
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : "shortcut group update failed" });
    }
  }

  private async createShortcut(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    try {
      const body = await readJsonBody(request);
      const actionKey = optionalText(body.actionKey);
      const shortcut = this.options.db.createShortcut({
        groupId: requiredText(body.groupId, "groupId"),
        title: requiredText(body.title, "title"),
        detail: optionalText(body.detail),
        kind: requiredShortcutKind(body.kind),
        value: actionKey ? optionalText(body.value) ?? "" : requiredText(body.value, "value"),
        actionKey,
        displayMode: optionalShortcutDisplayMode(body.displayMode),
        enabled: optionalBoolean(body.enabled),
        dangerous: optionalBoolean(body.dangerous),
      });
      sendJson(response, 201, { shortcut: publicShortcut(shortcut) });
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : "shortcut creation failed" });
    }
  }

  private async updateShortcut(
    shortcutId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    try {
      const body = await readJsonBody(request);
      const actionKey = body.actionKey !== undefined ? optionalText(body.actionKey) : undefined;
      const shortcut = this.options.db.updateShortcut(shortcutId, {
        ...(body.groupId !== undefined ? { groupId: requiredText(body.groupId, "groupId") } : {}),
        ...(body.title !== undefined ? { title: requiredText(body.title, "title") } : {}),
        ...(body.detail !== undefined ? { detail: optionalText(body.detail) ?? "" } : {}),
        ...(body.kind !== undefined ? { kind: requiredShortcutKind(body.kind) } : {}),
        ...(body.value !== undefined ? { value: typeof body.value === "string" ? body.value : requiredText(body.value, "value") } : {}),
        ...(body.actionKey !== undefined ? { actionKey: actionKey ?? null } : {}),
        ...(body.displayMode !== undefined ? { displayMode: requiredShortcutDisplayMode(body.displayMode) } : {}),
        ...(body.enabled !== undefined ? { enabled: requiredBoolean(body.enabled, "enabled") } : {}),
        ...(body.dangerous !== undefined ? { dangerous: requiredBoolean(body.dangerous, "dangerous") } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: requiredInteger(body.sortOrder, "sortOrder") } : {}),
      });
      if (!shortcut) {
        sendJson(response, 404, { error: "shortcut not found" });
        return;
      }
      sendJson(response, 200, { shortcut: publicShortcut(shortcut) });
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : "shortcut update failed" });
    }
  }

  private async moveShortcutToEdge(
    shortcutId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    try {
      const body = await readJsonBody(request);
      const shortcut = this.options.db.moveShortcutToEdge(
        shortcutId,
        requiredShortcutMovePosition(body.position),
      );
      if (!shortcut) {
        sendJson(response, 404, { error: "shortcut not found" });
        return;
      }
      sendJson(response, 200, { shortcut: publicShortcut(shortcut) });
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : "shortcut move failed" });
    }
  }

  private requireActionAuthorization(request: IncomingMessage, response: ServerResponse): boolean {
    const token = request.headers["x-bridge-action-token"];
    if (!constantTimeTokenMatches(typeof token === "string" ? token : "", this.actionToken)) {
      sendJson(response, 403, { error: "invalid action token" });
      return false;
    }
    const origin = request.headers.origin;
    if (origin && !this.isSameOriginAction(origin, request)) {
      sendJson(response, 403, { error: "cross-origin action rejected" });
      return false;
    }
    return true;
  }

  private async createProject(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
      return;
    }
    if (typeof body.name !== "string" || typeof body.path !== "string") {
      sendJson(response, 400, { error: "name and path are required" });
      return;
    }
    const status = body.status === undefined ? "available" : body.status;
    if (!isProjectStatus(status)) {
      sendJson(response, 400, { error: "invalid project status" });
      return;
    }
    const path = normalizeProjectPath(body.path);
    if (!path) {
      sendJson(response, 422, { error: "项目路径必须是绝对路径。" });
      return;
    }
    if (status === "available" && !isDirectory(path)) {
      sendJson(response, 422, { error: "启用的项目路径必须是本机上存在的目录。" });
      return;
    }
    if (this.options.db.getProject(body.name.trim())) {
      sendJson(response, 409, { error: "项目名称已存在。" });
      return;
    }
    try {
      const project = this.options.db.createProject({ name: body.name, path, status });
      this.refreshProjectRegistrySnapshot();
      sendJson(response, 201, { project: { ...project, available: this.options.db.getAvailableProject(project.name) !== null } });
    } catch (error) {
      sendJson(response, 422, { error: error instanceof Error ? error.message : "项目创建失败。" });
    }
  }

  private async updateProject(
    name: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.requireActionAuthorization(request, response)) return;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
      return;
    }
    if (body.path !== undefined && typeof body.path !== "string") {
      sendJson(response, 400, { error: "path must be a string" });
      return;
    }
    if (body.status !== undefined && !isProjectStatus(body.status)) {
      sendJson(response, 400, { error: "invalid project status" });
      return;
    }
    const path = typeof body.path === "string" ? normalizeProjectPath(body.path) : undefined;
    if (body.path !== undefined && !path) {
      sendJson(response, 422, { error: "项目路径必须是绝对路径。" });
      return;
    }
    const existing = this.options.db.getProject(name);
    if (!existing) {
      sendJson(response, 404, { error: "project not found" });
      return;
    }
    const nextStatus = isProjectStatus(body.status) ? body.status : existing.status;
    if (nextStatus === "available" && !isDirectory(path ?? existing.path)) {
      sendJson(response, 422, { error: "启用的项目路径必须是本机上存在的目录。" });
      return;
    }
    const project = this.options.db.updateProject(name, {
      ...(path ? { path } : {}),
      ...(isProjectStatus(body.status) ? { status: body.status } : {}),
    });
    if (!project) {
      sendJson(response, 404, { error: "project not found" });
      return;
    }
    this.refreshProjectRegistrySnapshot();
    sendJson(response, 200, { project: { ...project, available: this.options.db.getAvailableProject(name) !== null } });
  }

  private refreshProjectRegistrySnapshot(): void {
    const path = this.options.projectRegistrySnapshotPath;
    if (!path) return;
    try {
      writeProjectRegistrySnapshot(this.options.db, path);
    } catch (error) {
      this.options.logger?.warn("failed to update AAMP project registry snapshot", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (origin && !this.isSameOriginAction(origin, request)) {
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
    if (pathname === "/tmux-dashboard/terminal" && this.options.tmuxDashboard) {
      void this.options.tmuxDashboard.handleUpgrade(
        request,
        socket,
        head,
        this.auth.currentDeviceId(request),
      ).catch((error: unknown) => {
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

  private isSameOrigin(origin: string, request: IncomingMessage): boolean {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      return false;
    }
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") return false;
    const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
    const requestHost = forwardedHost || firstHeaderValue(request.headers.host);
    const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
    if (requestHost) {
      const expectedProtocol = forwardedProtocol?.toLowerCase() === "https" ? "https:" : "http:";
      try {
        const requestOrigin = new URL(`${expectedProtocol}//${requestHost}/`);
        const forwardedPort = firstHeaderValue(request.headers["x-forwarded-port"]);
        if (forwardedPort) {
          if (!/^\d{1,5}$/.test(forwardedPort) || Number(forwardedPort) > 65_535) return false;
          if (!requestOrigin.port) requestOrigin.port = forwardedPort;
        }
        return parsedOrigin.origin === requestOrigin.origin;
      } catch {
        return false;
      }
    }
    const server = this.server;
    const address = server?.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return parsedOrigin.origin === `http://${this.options.host}:${port}`;
  }

  private isSameOriginAction(origin: string, request: IncomingMessage): boolean {
    if (this.isSameOrigin(origin, request)) return true;
    return firstHeaderValue(request.headers["sec-fetch-site"])?.toLowerCase() === "same-origin";
  }
}

function isSpaRoute(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/index.html"
    || pathname === "/pair-admin"
    || pathname === "/system-management"
    || pathname === "/system-management/devices"
    || pathname === "/system-management/shortcuts"
    || pathname === "/system-management/usage"
    || pathname === "/system-management/health"
    || pathname === "/system-management/backups"
    || pathname === "/direct-tasks"
    || pathname === "/system-management/projects"
    || /^\/tasks\/(?:desk|direct|aamp)\/[^/]+$/.test(pathname)
    || pathname === "/codex-history"
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

function parseCodexHistoryValues(values: string[]): string[] | undefined {
  const parsed = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  return parsed.length > 0 ? [...new Set(parsed)] : undefined;
}

function parseCodexHistorySources(values: string[]): typeof CODEX_HISTORY_DEFAULT_SOURCE_KINDS {
  const parsed = parseCodexHistoryValues(values) ?? [...CODEX_HISTORY_DEFAULT_SOURCE_KINDS];
  const invalid = parsed.find((value) => !CODEX_HISTORY_SOURCE_KINDS.includes(value as typeof CODEX_HISTORY_SOURCE_KINDS[number]));
  if (invalid) {
    throw new Error(`未知 Codex thread 来源：${invalid}；可选值：${CODEX_HISTORY_SOURCE_KINDS.join(", ")}`);
  }
  return parsed as typeof CODEX_HISTORY_DEFAULT_SOURCE_KINDS;
}

function parseCodexHistoryStatuses(values: string[]): string[] | undefined {
  const parsed = parseCodexHistoryValues(values);
  if (!parsed) return undefined;
  const invalid = parsed.find((value) => !CODEX_HISTORY_STATUS_TYPES.includes(value as typeof CODEX_HISTORY_STATUS_TYPES[number]));
  if (invalid) {
    throw new Error(`未知 Codex thread 状态：${invalid}；可选值：${CODEX_HISTORY_STATUS_TYPES.join(", ")}`);
  }
  return parsed;
}

function parseCodexHistoryArchived(value: string | null): CodexHistoryArchivedFilter {
  const normalized = value?.trim() || "active";
  if (normalized !== "active" && normalized !== "archived" && normalized !== "all") {
    throw new Error("archived must be active, archived, or all");
  }
  return normalized;
}

function parseCodexHistorySortKey(value: string | null): "created_at" | "updated_at" | "recency_at" {
  const normalized = value?.trim() || "recency_at";
  if (normalized !== "created_at" && normalized !== "updated_at" && normalized !== "recency_at") {
    throw new Error("sort must be created_at, updated_at, or recency_at");
  }
  return normalized;
}

function parseCodexHistorySortDirection(value: string | null): "asc" | "desc" {
  const normalized = value?.trim() || "desc";
  if (normalized !== "asc" && normalized !== "desc") {
    throw new Error("direction must be asc or desc");
  }
  return normalized;
}

function parseCodexHistoryCwds(values: string[]): string[] | undefined {
  const parsed = parseCodexHistoryValues(values)?.map((value) => resolve(value));
  return parsed && parsed.length > 0 ? parsed : undefined;
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

function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && PROJECT_STATUSES.includes(value as ProjectStatus);
}

function publicShortcutGroup(group: StoredShortcutGroup): Record<string, unknown> {
  return {
    id: group.id,
    title: group.title,
    icon: group.icon,
    description: group.description,
    surface: group.surface,
    layout: group.layout,
    sortOrder: group.sort_order,
    enabled: group.enabled,
    builtIn: group.built_in,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
  };
}

function publicShortcut(shortcut: StoredShortcut): Record<string, unknown> {
  return {
    id: shortcut.id,
    groupId: shortcut.group_id,
    title: shortcut.title,
    detail: shortcut.detail,
    kind: shortcut.kind,
    value: shortcut.value,
    enabled: shortcut.enabled,
    builtIn: shortcut.built_in,
    dangerous: shortcut.dangerous,
    actionKey: shortcut.action_key,
    displayMode: shortcut.display_mode,
    sortOrder: shortcut.sort_order,
    operationCount: shortcut.operation_count,
    createdAt: shortcut.created_at,
    updatedAt: shortcut.updated_at,
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("text value is invalid");
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === undefined ? undefined : requiredBoolean(value, "boolean");
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, "integer");
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value as number;
}

function requiredShortcutKind(value: unknown): ShortcutKind {
  if (typeof value !== "string" || !SHORTCUT_KINDS.includes(value as ShortcutKind)) {
    throw new Error("kind is invalid");
  }
  return value as ShortcutKind;
}

function optionalShortcutSurface(value: unknown): ShortcutSurface | undefined {
  return value === undefined ? undefined : requiredShortcutSurface(value);
}

function requiredShortcutSurface(value: unknown): ShortcutSurface {
  if (typeof value !== "string" || !SHORTCUT_SURFACES.includes(value as ShortcutSurface)) {
    throw new Error("surface is invalid");
  }
  return value as ShortcutSurface;
}

function optionalShortcutDisplayMode(value: unknown): ShortcutDisplayMode | undefined {
  return value === undefined ? undefined : requiredShortcutDisplayMode(value);
}

function requiredShortcutDisplayMode(value: unknown): ShortcutDisplayMode {
  if (typeof value !== "string" || !SHORTCUT_DISPLAY_MODES.includes(value as ShortcutDisplayMode)) {
    throw new Error("displayMode is invalid");
  }
  return value as ShortcutDisplayMode;
}

function requiredShortcutMovePosition(value: unknown): "start" | "end" {
  if (value !== "start" && value !== "end") throw new Error("position must be start or end");
  return value;
}

function optionalShortcutGroupLayout(value: unknown): ShortcutGroupLayout | undefined {
  return value === undefined ? undefined : requiredShortcutGroupLayout(value);
}

function requiredShortcutGroupLayout(value: unknown): ShortcutGroupLayout {
  if (typeof value !== "string" || !SHORTCUT_GROUP_LAYOUTS.includes(value as ShortcutGroupLayout)) {
    throw new Error("layout is invalid");
  }
  return value as ShortcutGroupLayout;
}

function normalizeProjectPath(value: string): string | undefined {
  let path = value.trim();
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : undefined;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
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

function readBinaryBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    let failed = false;
    request.on("data", (chunk: Buffer | string) => {
      if (failed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.length;
      if (sizeBytes > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(new Error("attachment exceeds size limit"));
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (!failed) resolvePromise(Buffer.concat(chunks, sizeBytes));
    });
    request.once("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function sanitizeAttachmentFileName(value: string): string {
  const basename = value.replaceAll("\\", "/").split("/").pop() ?? "";
  return basename.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
}

function normalizeAttachmentMimeType(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const mimeType = raw?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function buildPairingUrl(request: IncomingMessage, code: string): string {
  const protocolHeader = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const protocol = protocolHeader?.toLowerCase() === "https" ? "https" : "http";
  const configuredHost = firstHeaderValue(request.headers["x-forwarded-host"])
    ?? request.headers.host
    ?? "localhost";
  const url = new URL(`${protocol}://${configuredHost}/`);
  url.hash = "pair=" + encodeURIComponent(code);
  return url.toString();
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = raw?.split(",", 1)[0]?.trim();
  return normalized || undefined;
}

function normalizeTaskRelativePath(value: string): string {
  const normalized = value.replaceAll(String.fromCharCode(92), "/");
  if (
    Buffer.byteLength(normalized, "utf8") > 4_096
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes(String.fromCharCode(0))
  ) {
    throw new TaskFileRequestError(400, "Use a path inside the task directory.");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    throw new TaskFileRequestError(400, "Parent directory traversal is not allowed.");
  }
  return parts.filter((part) => part && part !== ".").join(sep);
}

function isTaskPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function taskImageContentType(extension: string): string | null {
  switch (extension) {
    case "apng": return "image/apng";
    case "avif": return "image/avif";
    case "bmp": return "image/bmp";
    case "gif": return "image/gif";
    case "jpeg":
    case "jpg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    default: return null;
  }
}

function sendTaskFileError(response: ServerResponse, error: unknown): void {
  if (error instanceof TaskFileRequestError) {
    sendJson(response, error.statusCode, { error: error.message });
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
  sendJson(response, 500, { error: "Could not read project files." });
}

function attachmentFileExtension(fileName: string, mimeType: string): string {
  const knownExtensions: Record<string, string> = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  const knownExtension = knownExtensions[mimeType];
  if (knownExtension) return knownExtension;
  const extension = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".blob";
}

function isPreviewableImage(mimeType: string): boolean {
  return [
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ].includes(mimeType);
}

function attachmentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function publicWebTaskAttachment(attachment: StoredWebTaskAttachment) {
  return {
    attachment_id: attachment.attachment_id,
    file_name: attachment.file_name,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
  };
}

function publicBackupMetadata(metadata: BridgeBackupMetadata | BridgeBackupVerification) {
  return {
    formatVersion: metadata.formatVersion,
    programVersion: metadata.programVersion,
    createdAt: metadata.createdAt,
    databaseBytes: metadata.databaseBytes,
    attachmentCount: metadata.attachmentCount,
    attachmentBytes: metadata.attachmentBytes,
    attachmentCountsByKind: metadata.attachmentCountsByKind,
    schemaFingerprint: metadata.schemaFingerprint,
    contentHashesVerified: "contentHashesVerified" in metadata ? metadata.contentHashesVerified : true,
  };
}

function isSafeBackupId(value: string): boolean {
  return value.length > 0 && value.length <= 160 && value !== "." && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'",
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

function directTaskView(task: StoredBridgeTask) {
  return {
    source: "direct" as const, id: task.bridge_task_id, text: task.text, status: task.status,
    thread_id: task.thread_id, attempt: task.attempt, sender_name: task.sender_name,
    last_progress_text: task.last_progress_text, last_progress_at: task.last_progress_at,
    card_state: task.card_state, final_response: task.final_response, error: task.error,
    initial_final_response: task.initial_final_response,
    created_at: task.created_at, updated_at: task.updated_at,
  };
}

function aampTaskView(task: StoredAampTask) {
  return {
    source: "aamp" as const,
    id: task.aamp_task_id,
    text: task.user_text,
    status: task.status,
    last_progress_text: task.last_delta_text || null,
    error: task.error_msg,
    image_count: task.image_local_paths.length,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}
