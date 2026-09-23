import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Duplex } from "node:stream";

import { StateDatabase } from "./db.js";
import { writeProjectRegistrySnapshot } from "./project-registry.js";
import type { TmuxDashboardApi } from "./tmux-dashboard-api.js";
import { resolveBridgeProjectRoot } from "./portable-runtime.js";
import { parseTaskInput } from "./fingerprint.js";
import { PairingRateLimitError, WebPairingAuth } from "./web-auth.js";
import {
  AAMP_TASK_STATUSES,
  PROJECT_STATUSES,
  TASK_STATES,
  type AampTaskStatus,
  type DatabaseChange,
  type Logger,
  type ProjectStatus,
  type TaskState,
  type StoredProject,
  type StoredWebTaskAttachment,
  type StoredTask,
  type WebTaskSubmission,
} from "./types.js";

const MAX_TASK_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_STAGED_TASK_ATTACHMENTS = 100;
const MAX_STAGED_TASK_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_TASK_ATTACHMENTS = 10;

export interface DashboardServerOptions {
  db: StateDatabase;
  host: string;
  port: number;
  modes: string[];
  projectRegistrySnapshotPath?: string;
  taskAttachmentsDirectory?: string;
  webRoot?: string;
  auth?: WebPairingAuth;
  tmuxDashboard?: TmuxDashboardApi;
  actions?: DashboardActions;
  logger?: Logger;
}

export interface DashboardActions {
  createTask?(input: WebTaskSubmission): Promise<StoredTask>;
  interruptTask(taskGuid: string, reason?: string): Promise<{ ok: boolean; message?: string }>;
  appendFeedback(taskGuid: string, details: string): Promise<{ ok: boolean; state: string }>;
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
    await this.cleanupExpiredStagedAttachments().catch((error) => {
      this.options.logger?.warn("failed to clean expired staged task attachments", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
    if (request.method === "GET" && url.pathname === "/api/projects") {
      sendJson(response, 200, { projects: this.listProjects() });
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
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      this.listTasks(url, response);
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
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") {
      response.setHeader("Allow", "GET, POST, PATCH, DELETE");
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
      sendJson(response, 422, { error: error instanceof Error ? error.message : "task creation failed" });
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
      runs: this.options.db.listRunsForTask(taskGuid).map((run) => ({
        ...run,
        events: this.options.db.listRunEvents(run.run_id),
      })),
      attachments: this.options.db.listWebTaskAttachments(taskGuid).map(publicWebTaskAttachment),
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

  private listProjects(): Array<StoredProject & { available: boolean }> {
    return this.options.db.listProjects().map((project) => ({
      ...project,
      available: this.options.db.getAvailableProject(project.name) !== null,
    }));
  }

  private requireActionAuthorization(request: IncomingMessage, response: ServerResponse): boolean {
    const token = request.headers["x-bridge-action-token"];
    if (!constantTimeTokenMatches(typeof token === "string" ? token : "", this.actionToken)) {
      sendJson(response, 403, { error: "invalid action token" });
      return false;
    }
    const origin = request.headers.origin;
    if (origin && !this.isSameOrigin(origin)) {
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

function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && PROJECT_STATUSES.includes(value as ProjectStatus);
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
