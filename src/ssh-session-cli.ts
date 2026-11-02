import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { buildCodexAppServerEnvironment } from "./codex-app-server.js";
import { CodexHistoryService } from "./codex-history.js";
import { isExecutableCodexPath, resolveCodexCliPath } from "./codex-path.js";
import { loadConfig } from "./config.js";
import { StateDatabase } from "./db.js";
import { DatabaseSync, type SqliteDatabase } from "./sqlite.js";
import { resolveBridgeDataRoot, resolveBridgeProjectRoot, isSingleBinaryRuntime } from "./portable-runtime.js";
import { TmuxDashboardApi } from "./tmux-dashboard-api.js";

const RESULT_PREFIX = "BRIDGE_SSH_RESULT:";
const DASHBOARD_PREFIX = "/tmux-dashboard/api";
const DEFAULT_PORTS = [17310, 7310];
const MAX_REQUEST_BYTES = 32 * 1024;

type JsonObject = Record<string, unknown>;
interface SshSessionRequest {
  action: string;
  id?: string;
  createdAt?: number;
  path?: string;
  root?: string;
  home?: string;
}

export interface BridgeSshBackend {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: JsonObject, createdAt?: number, operation?: string): Promise<JsonObject>;
  close?(): Promise<void> | void;
}

export interface BridgeSshCliOptions {
  request: SshSessionRequest;
  databasePath: string;
  configPath: string;
  ports: number[];
  offline: boolean;
}

interface GitFile {
  path: string;
  oldPath: string | null;
  status: string;
  staged: boolean;
  unstaged: boolean;
  sizeBytes: number | null;
}

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Bridge 返回了无效数据。");
  return value as JsonObject;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} 无效。`);
  return value;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function validateRequest(input: unknown): SshSessionRequest {
  const value = object(input);
  const action = text(value.action, "操作");
  const allowed = new Set(["git_list", "git_diff", "git_preview", "accounts", "mark_account", "refresh_account", "usage", "save", "suspend", "list_suspended", "restore", "end"]);
  if (!allowed.has(action)) throw new Error("不支持的 SSH Session 操作。");
  const request: SshSessionRequest = { action };
  if (action !== "list_suspended") {
    const id = text(value.id, "Session ID");
    if (!/^\$\d+$/.test(id) || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) {
      throw new Error("Session 标识无效，请刷新后重试。");
    }
    request.id = id;
    request.createdAt = value.createdAt as number;
  }
  for (const field of ["path", "root", "home"] as const) {
    if (value[field] !== undefined) {
      const candidate = text(value[field], field);
      if (candidate.length > 4096 || candidate.includes("\0")) throw new Error(`${field} 无效。`);
      request[field] = candidate;
    }
  }
  return request;
}

/** Translate the native SSH view contract to the same operations used by Web. */
export async function executeBridgeSshSessionRequest(input: unknown, backend: BridgeSshBackend): Promise<JsonObject> {
  const request = validateRequest(input);
  const { action, id, createdAt } = request;
  if (action === "list_suspended") return backend.request("GET", `${DASHBOARD_PREFIX}/sessions/suspended`, undefined, undefined, action);
  const target = encodeURIComponent(id!);
  const prefix = `${DASHBOARD_PREFIX}/sessions/${target}`;
  if (action === "restore") {
    const suspended = await backend.request("GET", `${DASHBOARD_PREFIX}/sessions/suspended`, undefined, undefined, action);
    const record = array(suspended.sessions).map(object).find((item) => item.id === id && item.createdAt === createdAt);
    if (!record) throw new Error("挂起的 Session 已变化，请刷新后重试。");
    const result = await backend.request("POST", `${prefix}/resume`, {}, createdAt, action);
    return { name: object(result.session).name };
  }
  const identityResult = await backend.request("GET", `${prefix}/identity`, undefined, createdAt, action);
  const session = object(identityResult.session);
  const name = text(session.name, "Session 名称");
  if (action === "save" || action === "suspend") {
    await backend.request("POST", `${prefix}/${action === "save" ? "resurrect/save" : "suspend"}`, {}, createdAt, action);
    return { name };
  }
  if (action === "end") {
    await backend.request("DELETE", prefix, undefined, createdAt, action);
    return { name };
  }
  if (action === "accounts") {
    const [options, history] = await Promise.all([
      backend.request("GET", `${DASHBOARD_PREFIX}/codex-homes`, undefined, undefined, action),
      backend.request("GET", "/api/codex/homes", undefined, undefined, action).catch(() => ({ homes: [] })),
    ]);
    const knownPaths = new Map(array(history.homes).map(object)
      .filter((home) => typeof home.id === "string" && typeof home.path === "string")
      .map((home) => [home.id as string, home.path as string]));
    const homes = array(options.codexHomes).map(object).filter((home) => home.available === true)
      .map((home) => ({ id: home.id, path: knownPaths.get(String(home.id)) ?? "", label: home.label }));
    return { homes, selected: typeof session.codexHomeId === "string" ? session.codexHomeId : "" };
  }
  if (action === "mark_account") {
    const home = text(request.home, "Codex 账号");
    const result = await backend.request("POST", `${prefix}/codex-account`, { homeId: home }, createdAt, action);
    return { selected: object(result.session).codexHomeId };
  }
  if (action === "refresh_account") {
    const result = await backend.request("POST", `${prefix}/codex-account/check`, {}, createdAt, action);
    if (result.status === "matched") return { selected: object(result.home).id };
    if (result.status === "not-running") throw new Error("当前 pane 没有运行中的 Codex，请手动选择账号。");
    if (result.status === "unmatched") throw new Error("当前 Codex Home 不在账号列表中，请手动选择。");
    throw new Error("无法读取当前 Codex 的环境，请手动选择账号。");
  }
  if (action === "usage") {
    const home = text(request.home, "Codex 账号");
    if (session.codexHomeId !== home) throw new Error("Session 的 Codex 账号标记已变化，请刷新。 ");
    const result = await backend.request("GET", `/api/codex/usage?home=${encodeURIComponent(home)}`, undefined, undefined, action);
    const account = array(result.accounts).map(object).find((item) => item.homeId === home);
    if (!account) throw new Error("当前账号没有返回用量数据。");
    const errors = account.errors && typeof account.errors === "object" ? object(account.errors) : {};
    if (!account.quota) throw new Error(typeof errors.quota === "string" ? errors.quota : "当前账号没有返回额度数据。");
    const quota = object(account.quota);
    const byId: JsonObject = {};
    for (const item of array(quota.buckets)) {
      const bucket = object(item);
      const key = typeof bucket.limitId === "string" && bucket.limitId ? bucket.limitId : `codex-${Object.keys(byId).length}`;
      byId[key] = { ...bucket, planType: bucket.planType ?? quota.planType };
    }
    return { rateLimitsByLimitId: byId };
  }
  if (action === "git_list" || action === "git_diff" || action === "git_preview") {
    const result = await backend.request("GET", `${prefix}/git-changes`, undefined, createdAt, action);
    const root = text(result.gitRoot, "Git 仓库");
    if (request.root && request.root !== root) throw new Error("Session 的 Git 仓库已变化，请刷新。 ");
    const files = array(result.files).map((item) => object(item) as unknown as GitFile);
    if (action === "git_list") return { root, branch: result.branch ?? "", files: files.map((file) => ({
      path: file.path, oldPath: file.oldPath, status: gitStatusCode(file.status), size: file.sizeBytes,
    })) };
    const path = text(request.path, "文件路径");
    const file = files.find((candidate) => candidate.path === path);
    if (!file) throw new Error("文件已不在当前变更列表中，请刷新。 ");
    if (action === "git_preview") {
      const query = new URLSearchParams({ path, expectedGitRoot: root });
      const preview = await backend.request("GET", `${prefix}/git-changes/content?${query}`, undefined, createdAt, action);
      if (preview.kind !== "text" || typeof preview.text !== "string") throw new Error("此文件不是文本，请下载后打开。 ");
      return { text: preview.text, truncated: preview.truncated === true };
    }
    const patch = typeof result.patch === "string" ? result.patch : "";
    const section = patch.split(/(?=^diff --git )/m).find((candidate) => sectionMatchesFile(candidate, file));
    return { text: section ?? (result.patchTruncated === true ? "Diff 已截断，请刷新或查看文件预览。" : "没有可显示的文本 Diff。"),
      truncated: result.patchTruncated === true };
  }
  throw new Error("不支持的 SSH Session 操作。");
}

function gitStatusCode(status: string): string {
  switch (status) {
    case "untracked": return "??";
    case "added": return " A";
    case "deleted": return " D";
    case "renamed": return " R";
    case "copied": return " C";
    default: return " M";
  }
}

function sectionMatchesFile(section: string, file: GitFile): boolean {
  for (const line of section.split("\n")) {
    if (line.startsWith("@@")) break;
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    let path = line.slice(4).replace(/\t$/, "");
    if (path.startsWith('"')) {
      try { path = JSON.parse(path) as string; } catch { continue; }
    }
    if (path === `b/${file.path}` || path === `a/${file.path}` || (file.oldPath !== null && path === `a/${file.oldPath}`)) return true;
  }
  return false;
}

function parseCliOptions(argv: string[]): BridgeSshCliOptions {
  let encoded = "";
  let dbPath = process.env.FEISHU_CODEX_BRIDGE_SSH_DB?.trim() || "";
  let configPath = process.env.FEISHU_CODEX_BRIDGE_SSH_CONFIG?.trim() || "";
  let portValue = process.env.FEISHU_CODEX_BRIDGE_SSH_PORT?.trim() || "";
  let offline = process.env.FEISHU_CODEX_BRIDGE_SSH_OFFLINE === "1";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--offline") { offline = true; continue; }
    if (arg === "--request" || arg === "--db" || arg === "--config" || arg === "--port") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} 需要一个值。`);
      if (arg === "--request") encoded = value;
      else if (arg === "--db") dbPath = value;
      else if (arg === "--config") configPath = value;
      else portValue = value;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!encoded || encoded.length > MAX_REQUEST_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("SSH 请求编码无效。 ");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length > MAX_REQUEST_BYTES) throw new Error("SSH 请求过大。 ");
  let parsed: unknown;
  try { parsed = JSON.parse(decoded.toString("utf8")); } catch { throw new Error("SSH 请求不是有效 JSON。 "); }
  const request = validateRequest(parsed);
  const dataRoot = resolveBridgeDataRoot(import.meta.url);
  dbPath = resolve(dbPath || join(dataRoot, "runtime", "bridge.db"));
  configPath = resolve(configPath || join(dataRoot, "config.json"));
  if (!existsSync(dbPath)) throw new Error(`Bridge 数据库不存在：${dbPath}；请配置 FEISHU_CODEX_BRIDGE_SSH_DB。`);
  const databasePath = realpathSync(dbPath);
  const port = portValue ? Number(portValue) : undefined;
  if (portValue && (!Number.isSafeInteger(port) || port! < 1 || port! > 65535)) throw new Error("Bridge 端口无效。 ");
  return { request, databasePath, configPath, ports: port ? [port] : DEFAULT_PORTS, offline };
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(password|token|secret|cookie|authorization)\s*([=:])\s*[^\s,;]+/gi, (_match, key: string, separator: string) => `${key}${separator}<redacted>`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isReadonlyCodexOperation(operation?: string): boolean {
  return operation === "accounts" || operation === "usage";
}

function createSshSessionFallback(options: BridgeSshCliOptions, operation?: string): BridgeSshBackend {
  return isReadonlyCodexOperation(operation)
    ? new ReadOnlyCodexBridgeSshBackend(options)
    : new OfflineBridgeSshBackend(options);
}

function assertDatabaseUnused(databasePath: string): void {
  try {
    const output = execFileSync("lsof", ["-t", "--", databasePath], { encoding: "utf8", timeout: 4_000, stdio: ["ignore", "pipe", "pipe"] });
    const holders = output.split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    if (holders.length) throw new Error("Bridge 数据库正被其他进程使用，不能执行离线操作。 ");
  } catch (error) {
    if (error instanceof Error && error.message.includes("正被其他进程使用")) throw error;
    const failure = error as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    if (failure.status === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return;
    throw new Error("无法确认 Bridge 数据库是否被占用，请先停止相关服务并检查 lsof。 ");
  }
}

function createCodexHistoryService(
  options: BridgeSshCliOptions,
  usageSnapshotStore?: StateDatabase,
): CodexHistoryService {
  let executable = resolveCodexCliPath()?.path || "codex";
  let environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  if (existsSync(options.configPath)) {
    const config = loadConfig(options.configPath);
    if (isExecutableCodexPath(config.codex.cliPath)) executable = config.codex.cliPath;
    environment = buildCodexAppServerEnvironment(config);
  }
  return new CodexHistoryService({
    executable,
    environment,
    cwd: resolveBridgeProjectRoot(import.meta.url),
    ...(usageSnapshotStore ? { usageSnapshotStore } : {}),
  });
}

function openReadonlyBridgeDatabase(databasePath: string): SqliteDatabase {
  const isBun = typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== "undefined";
  const Sqlite = DatabaseSync as unknown as new (
    path: string,
    options?: { readonly?: boolean; readOnly?: boolean },
  ) => SqliteDatabase;
  const database = new Sqlite(databasePath, isBun ? { readonly: true } : { readOnly: true });
  database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
  return database;
}

export class ReadOnlyCodexBridgeSshBackend implements BridgeSshBackend {
  private readonly db: SqliteDatabase;
  private readonly history: CodexHistoryService;

  public constructor(options: BridgeSshCliOptions) {
    this.db = openReadonlyBridgeDatabase(options.databasePath);
    this.history = createCodexHistoryService(options);
  }

  private readSession(path: string, createdAt?: number): JsonObject {
    const match = /^\/tmux-dashboard\/api\/sessions\/([^/]+)\/identity$/.exec(path);
    const expectedCreatedAt = createdAt;
    if (!match || typeof expectedCreatedAt !== "number" || !Number.isSafeInteger(expectedCreatedAt)) {
      throw new Error("只读 fallback 缺少有效 Session 身份。");
    }
    let sessionId: string;
    try { sessionId = decodeURIComponent(match[1]!); }
    catch { throw new Error("只读 fallback 的 Session 标识无效。"); }
    const row = this.db.prepare(`SELECT tmux_session_id, session_name, working_directory,
        working_directory_override, tmux_created_at, codex_home_id
      FROM tmux_sessions
      WHERE tmux_session_id = ? AND tmux_created_at = ?
      ORDER BY (ended_at IS NULL) DESC, first_seen_at DESC LIMIT 1`).get(sessionId, expectedCreatedAt) as Record<string, unknown> | undefined;
    if (!row) throw new Error("只读 fallback 找不到当前 Session，可能已结束或已重建。");
    return { session: {
      id: row.tmux_session_id,
      name: row.session_name,
      cwd: row.working_directory_override ?? row.working_directory,
      createdAt: row.tmux_created_at,
      codexHomeId: row.codex_home_id,
    } };
  }

  public async request(method: "GET" | "POST" | "DELETE", path: string, _body?: JsonObject, createdAt?: number, _operation?: string): Promise<JsonObject> {
    if (method !== "GET") throw new Error("账号/用量只读 fallback 不执行数据库写操作。");
    if (/^\/tmux-dashboard\/api\/sessions\/[^/]+\/identity$/.test(path)) return this.readSession(path, createdAt);
    if (path === `${DASHBOARD_PREFIX}/codex-homes`) {
      return { codexHomes: this.history.listHomes().map(({ id, label, available }) => ({ id, label, available })) };
    }
    if (path === "/api/codex/homes") return { homes: this.history.listHomes() as unknown as unknown[] };
    if (path.startsWith("/api/codex/usage?")) {
      const home = new URL(path, "http://localhost").searchParams.get("home") || undefined;
      return this.history.readUsage(home) as unknown as JsonObject;
    }
    throw new Error("账号/用量只读 fallback 不支持该操作。");
  }

  public close(): void {
    this.db.close();
  }
}

/** An explicit offline invocation calls the Web API implementation in-process. */
class OfflineBridgeSshBackend implements BridgeSshBackend {
  private readonly db: StateDatabase;
  private readonly api: TmuxDashboardApi;
  private history: CodexHistoryService | null = null;
  constructor(private readonly options: BridgeSshCliOptions) {
    assertDatabaseUnused(options.databasePath);
    this.db = new StateDatabase(options.databasePath);
    this.api = new TmuxDashboardApi({ db: this.db, autoRestoreSessions: false, manageSessionSnapshots: true });
  }
  private getHistory(): CodexHistoryService {
    if (this.history) return this.history;
    this.history = createCodexHistoryService(this.options, this.db);
    return this.history;
  }
  async request(method: "GET" | "POST" | "DELETE", path: string, body?: JsonObject, createdAt?: number, _operation?: string): Promise<JsonObject> {
    if (method === "GET" && path === "/api/codex/homes") return { homes: this.getHistory().listHomes() };
    if (method === "GET" && path.startsWith("/api/codex/usage?")) {
      const home = new URL(path, "http://localhost").searchParams.get("home") || undefined;
      return this.getHistory().readUsage(home) as unknown as JsonObject;
    }
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const request = Readable.from(payload) as unknown as IncomingMessage;
    Object.assign(request, { method, url: path, headers: createdAt === undefined ? {} : { "x-bridge-session-created-at": String(createdAt) } });
    let statusCode = 200;
    let responseBody = "";
    const response = {
      get statusCode() { return statusCode; }, set statusCode(value: number) { statusCode = value; },
      setHeader() { return this; }, end(value?: string | Buffer) { if (value !== undefined) responseBody += value.toString(); return this; },
    } as unknown as ServerResponse;
    await this.api.handleRequest(request, response);
    const value = responseBody ? object(JSON.parse(responseBody)) : {};
    if (statusCode >= 400) throw new Error(typeof value.error === "string" ? value.error : `Bridge 操作失败 (${statusCode})。`);
    return value;
  }
  async close(): Promise<void> { await this.api.stop(); this.db.close(); }
}

export async function runBridgeSshSessionCli(argv = process.argv.slice(2)): Promise<void> {
  let backend: BridgeSshBackend | null = null;
  try {
    const options = parseCliOptions(argv);
    // This process is the SSH fallback itself. The App has already tried the
    // token-authenticated Bridge API before opening this command, so the CLI
    // must use local Codex/SQLite state directly instead of re-entering the
    // Bridge API and creating a second authentication path.
    try {
      backend = createSshSessionFallback(options, options.request.action);
    } catch (error) {
      const prefix = isReadonlyCodexOperation(options.request.action) ? "只读 Codex fallback" : "本地 CLI fallback";
      throw new Error(`${prefix}失败：${safeFailureMessage(error)}`);
    }
    const result = await executeBridgeSshSessionRequest(options.request, backend);
    console.log(RESULT_PREFIX + JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(RESULT_PREFIX + JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Bridge SSH 操作失败。" }));
  } finally { await backend?.close?.(); }
}

if (!isSingleBinaryRuntime() && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runBridgeSshSessionCli();
}
