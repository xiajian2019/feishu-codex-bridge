import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveBridgeDataRoot, isSingleBinaryRuntime } from "./portable-runtime.js";
import { DirectBridgeSshBackend } from "./ssh-session-direct.js";

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
  cwd?: string;
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
  for (const field of ["path", "root", "home", "cwd"] as const) {
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
    return { name: object(result.session).name, ...(result.source === "ssh-fallback" ? { source: result.source } : {}) };
  }
  const identityResult = await backend.request("GET", `${prefix}/identity`, undefined, createdAt, action);
  const session = object(identityResult.session);
  const name = text(session.name, "Session 名称");
  if (action === "save" || action === "suspend") {
    const result = await backend.request("POST", `${prefix}/${action === "save" ? "resurrect/save" : "suspend"}`, {}, createdAt, action);
    return { name, ...(result.source === "ssh-fallback" ? { source: result.source } : {}) };
  }
  if (action === "end") {
    const result = await backend.request("DELETE", prefix, undefined, createdAt, action);
    return { name, ...(result.source === "ssh-fallback" ? { source: result.source } : {}) };
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
    return { selected: object(result.session).codexHomeId, ...(result.source === "ssh-fallback" ? { source: result.source } : {}) };
  }
  if (action === "refresh_account") {
    const result = await backend.request("POST", `${prefix}/codex-account/check`, {}, createdAt, action);
    if (result.status === "matched") return { selected: object(result.home).id, ...(result.source === "ssh-fallback" ? { source: result.source } : {}) };
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
  // Keep accepting --db and the legacy environment variable for existing
  // callers, but the SSH fallback never checks, opens or writes that path.
  const databasePath = dbPath;
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

export async function runBridgeSshSessionCli(argv = process.argv.slice(2)): Promise<void> {
  let backend: BridgeSshBackend | null = null;
  try {
    const options = parseCliOptions(argv);
    // The App tries the paired Bridge API first. Its SSH fallback uses tmux,
    // Git, Codex app-server and scoped snapshot files, never the Bridge DB.
    backend = new DirectBridgeSshBackend(options.request, options.configPath);
    const result = await executeBridgeSshSessionRequest(options.request, backend);
    console.log(RESULT_PREFIX + JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(RESULT_PREFIX + JSON.stringify({ ok: false, error: safeFailureMessage(error) || "Bridge SSH 操作失败。" }));
  } finally { await backend?.close?.(); }
}

if (!isSingleBinaryRuntime() && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runBridgeSshSessionCli();
}
