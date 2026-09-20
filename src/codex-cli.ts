import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isDirectExecutionMode, loadConfig, parseExecutionMode } from "./config.js";
import {
  CODEX_THREAD_SOURCE_KINDS,
  CODEX_THREAD_STATUS_TYPES,
  buildCodexAppServerEnvironment,
  CodexAppServerClient,
  codexThreadSourceLabel,
  codexThreadStatusType,
  codexThreadTimestampMs,
  type CodexThread,
  type CodexAppServerQueryClient,
  type CodexThreadListParams,
  type CodexThreadSortDirection,
  type CodexThreadSortKey,
  type CodexThreadSourceKind,
  type CodexThreadStatusType,
} from "./codex-app-server.js";
import { DIRECT_RUNTIME_LEASE_NAME } from "./feishu-sqlite-codex.js";
import { resolveSharedFeishuCredentials, type FeishuCredentialSource } from "./feishu-credentials.js";
import { LocalCodexNotificationWatcher } from "./local-codex-notifications.js";
import { StateDatabase, type OutboxSummary, type RuntimeLeaseRecord } from "./db.js";
import {
  DIRECT_TASK_STATUSES,
  type BridgeConfig,
  type DirectTaskStatus,
  type ExecutionMode,
  type StoredBridgeTask,
  type StoredBridgeTaskAttachment,
  type StoredBridgeTaskEvent,
  type OutboxEntry,
} from "./types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_SERVICE_LABEL = "com.local.feishu-codex-bridge";
const CODEX_SERVICE_PLIST_NAME = `${CODEX_SERVICE_LABEL}.plist`;
const MIN_NODE_VERSION = [22, 13, 1] as const;
const DEFAULT_CODEX_EXECUTION_MODE: ExecutionMode = "feishu-sqlite-codex";
const DEFAULT_LOG_LINE_COUNT = 80;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_CODEX_THREAD_LIMIT = 20;
const CODEX_THREAD_PAGE_SIZE = 200;
const MAX_CODEX_THREAD_SCAN = 10_000;
const LAUNCHD_BOOTSTRAP_ATTEMPTS = 6;
const LAUNCHD_RETRY_INITIAL_DELAY_MS = 250;
const LAUNCHD_RETRY_MAX_DELAY_MS = 4_000;
const LAUNCHD_OPERATION_LOCK_PATH = join(
  homedir(),
  "Library",
  "Caches",
  "feishu-codex-bridge",
  "launchd-control.lock",
);
const LAUNCHD_LOCK_TIMEOUT_MS = 30_000;
const LAUNCHD_LOCK_STALE_MS = 120_000;

export interface CodexCliArguments {
  configPath: string;
  dbPath: string;
  executionMode?: ExecutionMode;
  nodePath?: string;
  command: string[];
  help: boolean;
}

export interface CodexLaunchAgentOptions {
  label?: string;
  nodePath: string;
  projectRoot: string;
  configPath: string;
  dbPath: string;
  executionMode?: ExecutionMode;
  stdoutPath: string;
  stderrPath: string;
  pathEntries?: string[];
}

export interface CodexLaunchAgentPaths {
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  configPath: string;
  dbPath: string;
}

export interface LaunchdStatus {
  supported: boolean;
  loaded: boolean;
  running: boolean;
  pid?: number;
  detail?: string;
}

export interface DirectRecentFormatOptions {
  fullMessage?: boolean;
  databasePath?: string;
}

export interface CodexThreadQuery {
  sourceKinds: CodexThreadSourceKind[];
  modelProviders?: string[];
  cwd?: string[];
  searchTerm?: string;
  archived: boolean;
  statuses: CodexThreadStatusType[];
  sinceMs?: number;
  untilMs?: number;
  sortKey: CodexThreadSortKey;
  sortDirection: CodexThreadSortDirection;
  limit: number;
  cursor?: string;
}

export interface CodexThreadQueryResult {
  items: CodexThread[];
  total?: number;
  nextCursor: string | null;
  backwardsCursor: string | null;
  scanned?: number;
}

export function parseCodexCliArguments(
  argv: string[],
  cwd = process.cwd(),
): CodexCliArguments {
  let configPath = resolve(cwd, "config.json");
  let dbPath = resolve(cwd, "runtime", "bridge.db");
  let executionMode: ExecutionMode | undefined;
  let nodePath: string | undefined;
  const command: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--config" || arg.startsWith("--config=")) {
      const value = arg.startsWith("--config=") ? arg.slice("--config=".length) : argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--config requires a path");
      configPath = resolve(cwd, value);
      if (arg === "--config") index += 1;
      continue;
    }
    if (arg === "--db" || arg.startsWith("--db=")) {
      const value = arg.startsWith("--db=") ? arg.slice("--db=".length) : argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--db requires a path");
      dbPath = resolve(cwd, value);
      if (arg === "--db") index += 1;
      continue;
    }
    if (
      arg === "--mode"
      || arg === "--execution-mode"
      || arg.startsWith("--mode=")
      || arg.startsWith("--execution-mode=")
    ) {
      const inlinePrefix = arg.startsWith("--execution-mode=")
        ? "--execution-mode="
        : arg.startsWith("--mode=")
          ? "--mode="
          : undefined;
      const value = inlinePrefix
        ? arg.slice(inlinePrefix.length)
        : argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${inlinePrefix ? inlinePrefix.slice(0, -1) : arg} requires an execution mode`);
      }
      executionMode = parseExecutionMode(value);
      if (!inlinePrefix) index += 1;
      continue;
    }
    if (arg === "--node" || arg === "--node-path" || arg.startsWith("--node=") || arg.startsWith("--node-path=")) {
      const inlinePrefix = arg.startsWith("--node-path=")
        ? "--node-path="
        : arg.startsWith("--node=")
          ? "--node="
          : undefined;
      const value = inlinePrefix
        ? arg.slice(inlinePrefix.length)
        : argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${inlinePrefix ? inlinePrefix.slice(0, -1) : arg} requires a Node executable path`);
      }
      nodePath = resolve(cwd, value);
      if (!inlinePrefix) index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    command.push(arg);
  }
  return { configPath, dbPath, executionMode, nodePath, command, help };
}

export async function runCodexCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCodexCliArguments(argv);
  if (args.help || args.command.length === 0) {
    printCodexUsage();
    return;
  }

  const [name, ...commandArgs] = args.command;
  if (name === "update") {
    await runCodexUpdate(commandArgs, args.configPath);
    return;
  }
  // Stopping and reading logs must remain available even when a user has
  // temporarily broken or switched config.json while repairing the service.
  if (name === "stop") {
    await stopCodexLaunchAgent();
    return;
  }
  if (name === "uninstall" || name === "remove") {
    await uninstallCodexLaunchAgent();
    return;
  }
  if (name === "logs") {
    await runCodexLogs(args, commandArgs);
    return;
  }

  // Installing the plist only needs paths and the selected execution mode.
  // Keep it usable while config.json still describes the AAMP runtime; the
  // commands that actually start or inspect the direct runtime validate the
  // direct project/mode settings below.
  if (name === "install" || name === "setup") {
    assertDirectExecutionMode(resolveCodexExecutionMode(args));
    await installCodexLaunchAgent(args, commandArgs);
    return;
  }

  const config = loadConfig(args.configPath, {
    executionMode: resolveCodexExecutionMode(args),
  });
  assertDirectMode(config);

  switch (name) {
    case "start":
      await startCodexLaunchAgent(args);
      return;
    case "restart":
      await restartCodexLaunchAgent(args);
      return;
    case "status":
      await withDatabase(args.dbPath, (db) => runCodexStatus(config, args, db, commandArgs));
      return;
    case "recent":
    case "list":
      await withDatabase(args.dbPath, (db) => runCodexRecent(db, args, commandArgs));
      return;
    case "notify":
      await runCodexLocalNotifications(config, commandArgs);
      return;
    case "threads":
    case "sessions":
      await runCodexThreads(config, commandArgs);
      return;
    case "thread":
    case "session":
      await runCodexThread(config, commandArgs);
      return;
    case "task":
    case "inspect":
      await withDatabase(args.dbPath, (db) => runCodexTask(db, commandArgs));
      return;
    case "attachments":
      await withDatabase(args.dbPath, (db) => runCodexAttachments(db, commandArgs));
      return;
    case "outbox":
      await withDatabase(args.dbPath, (db) => runCodexOutbox(db, commandArgs));
      return;
    case "cancel":
      await withDatabase(args.dbPath, (db) => runCodexCancel(db, commandArgs));
      return;
    case "retry":
      await withDatabase(args.dbPath, (db) => runCodexRetry(db, commandArgs));
      return;
    case "recover":
      await withDatabase(args.dbPath, (db) => runCodexRecover(db, commandArgs));
      return;
    case "worktrees":
      await runCodexWorktrees(config, commandArgs);
      return;
    case "doctor":
      await withDatabase(args.dbPath, (db) => runCodexDoctor(config, args, db));
      return;
    default:
      throw new Error(`未知 Codex 命令：${name}。使用 codex --help 查看帮助。`);
  }
}

export function printCodexUsage(): void {
  console.log(
    [
      "Usage: pnpm run codex -- <command> [options]",
      "",
      "服务生命周期：",
      "  install|setup       生成当前项目的 LaunchAgent（不自动启动）",
      "  uninstall|remove    停止并删除当前项目的 LaunchAgent plist",
      "  start               安装并启动原生 Feishu/Codex 后台服务",
      "  stop                停止原生 Feishu/Codex LaunchAgent",
      "  restart             重载 plist 并重启原生后台服务",
      "  status              查看 LaunchAgent、租约、任务和 outbox 状态",
      "  logs                查看桥接 stdout/stderr 日志",
      "  doctor              检查配置、Node、Codex CLI、凭据和 LaunchAgent",
      "  update              更新 @openai/codex-sdk（--check 只检查版本）",
      "",
      "任务与持久化状态：",
      "  recent|list         查看最近任务（--limit N --status STATUS --json）",
      "  notify              轮询并发送 macOS 系统完成通知（--interval N --once）",
      "  task|inspect ID     查看任务、事件、附件和 outbox（支持唯一前缀）",
      "  threads|sessions    只读查询 Codex App/CLI threads（支持筛选）",
      "  thread|session ID   只读查看 Codex thread（--turns 展开轮次）",
      "  attachments ID      查看任务附件及本地缓存路径",
      "  outbox              查看 durable outbox（--pending --task ID）",
      "  cancel ID           请求取消任务（--reason TEXT）",
      "  retry ID            重排队 FAILED/CANCELLED 任务（--reason TEXT）",
      "  recover             接管已过期租约（--force 需先停止服务）",
      "  worktrees           查看配置仓库的 Git worktree（直连模式不自动创建）",
      "",
      "全局选项：",
      "  --config path       配置文件（默认：./config.json）",
      "  --db path           SQLite 文件（默认：./runtime/bridge.db）",
      `  --mode MODE         覆盖 execution.mode（默认：${DEFAULT_CODEX_EXECUTION_MODE}）`,
      "  --execution-mode    --mode 的别名",
      "  --node path         LaunchAgent 使用的 Node 可执行文件（默认自动选择 Node 22）",
      "",
      "示例：",
      "  pnpm run codex:status",
      "  pnpm run codex:recent -- --limit 10",
      "  pnpm run codex:threads -- --project food --source cli,appServer",
      "  pnpm run codex:threads -- --search 'fix' --status active --json",
      "  pnpm run codex:thread -- thr_123 --turns",
      "  pnpm run codex:task -- bridge_20260910 --json",
      "  pnpm run codex:cancel -- bridge_20260910 --reason '不再需要'",
      "  pnpm run codex:restart",
    ].join("\n"),
  );
}

export function buildCodexLaunchAgentPlist(options: CodexLaunchAgentOptions): string {
  const label = options.label ?? CODEX_SERVICE_LABEL;
  const pathEntries = uniqueStrings([
    dirname(options.nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(options.pathEntries ?? []),
  ]);
  const values = {
    label,
    nodePath: resolve(options.nodePath),
    mainPath: join(resolve(options.projectRoot), "dist", "main.js"),
    configPath: resolve(options.configPath),
    dbPath: resolve(options.dbPath),
    executionMode: options.executionMode ?? DEFAULT_CODEX_EXECUTION_MODE,
    stdoutPath: resolve(options.stdoutPath),
    stderrPath: resolve(options.stderrPath),
    path: pathEntries.join(":"),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(values.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(values.nodePath)}</string>
    <string>${xmlEscape(values.mainPath)}</string>
    <string>--config</string>
    <string>${xmlEscape(values.configPath)}</string>
    <string>--db</string>
    <string>${xmlEscape(values.dbPath)}</string>
    <string>--execution-mode</string>
    <string>${xmlEscape(values.executionMode)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(resolve(options.projectRoot))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(values.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(values.stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(values.path)}</string>
  </dict>
</dict>
</plist>
`;
}

export function formatDirectRecent(
  result: { items: StoredBridgeTask[]; total: number },
  options: DirectRecentFormatOptions = {},
): string {
  const lines = [
    `Codex 最近任务（${result.items.length}/${result.total}）`,
    ...(options.databasePath ? [`数据库：${options.databasePath}`] : []),
    "",
  ];
  if (result.items.length === 0) {
    lines.push("没有发现原生直连任务。收到飞书消息后，任务会先写入 SQLite。");
    return lines.join("\n");
  }
  for (const [index, task] of result.items.entries()) {
    lines.push(`${index + 1}. [${task.status}] ${task.bridge_task_id}`);
    lines.push(`   会话：${task.session_key}；发送者：${task.sender_name || task.sender_id}`);
    lines.push(`   创建：${task.created_at}；更新：${task.updated_at}`);
    lines.push(`   卡片：${task.card_state}${task.card_message_id ? ` (${task.card_message_id})` : ""}`);
    if (task.recovery_count > 0) lines.push(`   恢复：第 ${task.recovery_count} 次`);
    if (task.last_progress_text) lines.push(`   进度：${truncateText(task.last_progress_text, 500)}`);
    const message = options.fullMessage ? task.text : truncateText(task.text, 1_200);
    lines.push("   消息：", ...message.split(/\r?\n/).map((line) => `      ${line}`));
    if (!options.fullMessage && task.text.length > message.length) {
      lines.push("      （消息较长，使用 codex:task 查看完整内容）");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatDirectTask(
  task: StoredBridgeTask,
  attachments: StoredBridgeTaskAttachment[],
  events: StoredBridgeTaskEvent[],
  outbox: OutboxEntry[],
): string {
  const lines = [
    `Codex 任务：${task.bridge_task_id}`,
    `状态：${task.status}`,
    `消息：${task.message_id}`,
    `会话：${task.session_key}`,
    `聊天：${task.chat_id} (${task.chat_type})`,
    `发送者：${task.sender_name || task.sender_id}`,
    `Codex thread：${task.thread_id || "(尚未创建)"}`,
    `尝试次数：${task.attempt}`,
    `租约：${formatLease(task.lease_owner, task.lease_expires_at)}`,
    `卡片：${task.card_state}${task.card_message_id ? ` (${task.card_message_id})` : ""}`,
    `卡片更新时间：${task.card_updated_at || "(无)"}`,
    `创建时间：${task.created_at}`,
    `更新时间：${task.updated_at}`,
    `恢复次数：${task.recovery_count}`,
  ];
  if (task.cancel_requested_at) {
    lines.push(`取消请求：${task.cancel_requested_at} ${task.cancel_reason || ""}`.trimEnd());
  }
  if (task.last_progress_text) {
    lines.push(`最近进度：${task.last_progress_at || "(unknown)"} ${task.last_progress_event || ""}`.trimEnd());
    lines.push(`进度内容：${task.last_progress_text}`);
  }
  if (task.final_response) lines.push("", "最终响应：", task.final_response);
  if (task.error) lines.push("", "错误：", task.error);
  lines.push("", "用户消息：", task.text);
  lines.push(
    "",
    `附件（${attachments.length}）：`,
    ...(attachments.length > 0 ? attachments.map(formatAttachmentLine) : ["  (无)"]),
    "",
    `事件（${events.length}）：`,
    ...(events.length > 0 ? events.map(formatEventLine) : ["  (无)"]),
    "",
    `Outbox（${outbox.length}）：`,
    ...(outbox.length > 0 ? outbox.map(formatOutboxLine) : ["  (无)"]),
  );
  return lines.join("\n");
}

export async function runCodexThreads(
  config: BridgeConfig,
  commandArgs: string[],
): Promise<void> {
  const query = parseCodexThreadQuery(commandArgs, config.projects);
  const client = new CodexAppServerClient({
    executable: config.codex.cliPath,
    cwd: PROJECT_ROOT,
    env: buildCodexAppServerEnvironment(config),
    clientName: "feishu_codex_bridge_readonly",
    clientTitle: "Feishu Codex Bridge (read-only)",
  });
  try {
    const result = await queryCodexThreads(client, query);
    if (hasFlag(commandArgs, "--json")) {
      console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        dataSource: "codex-app-server",
        filters: serializeCodexThreadFilters(query),
        ...result,
      }, null, 2));
      return;
    }
    console.log(formatCodexThreads(result, query));
  } finally {
    await client.close();
  }
}

export async function runCodexThread(
  config: BridgeConfig,
  commandArgs: string[],
): Promise<void> {
  const selector = firstPositional(commandArgs);
  if (!selector) throw new Error("thread/session requires a Codex thread ID");
  const includeTurns = hasFlag(commandArgs, "--turns") || hasFlag(commandArgs, "--full");
  const client = new CodexAppServerClient({
    executable: config.codex.cliPath,
    cwd: PROJECT_ROOT,
    env: buildCodexAppServerEnvironment(config),
    clientName: "feishu_codex_bridge_readonly",
    clientTitle: "Feishu Codex Bridge (read-only)",
  });
  try {
    const result = await client.readThread(selector, includeTurns);
    if (hasFlag(commandArgs, "--json")) {
      console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        dataSource: "codex-app-server",
        includeTurns,
        thread: result.thread,
      }, null, 2));
      return;
    }
    console.log(formatCodexThread(result.thread, includeTurns));
  } finally {
    await client.close();
  }
}

export function parseCodexThreadQuery(
  args: string[],
  projects: Record<string, { repo: string }> = {},
): CodexThreadQuery {
  const rawSources = parseCsvOptions(args, ["--source", "--source-kind"]);
  const sourceKinds = rawSources.length > 0
    ? parseCodexThreadSources(rawSources)
    : ["cli", "appServer"] as CodexThreadSourceKind[];
  const rawProviders = parseCsvOptions(args, ["--provider", "--model-provider"]);
  const projectKeys = optionValues(args, "--project").map((value) => value.trim()).filter(Boolean);
  const rawCwds = optionValues(args, "--cwd").map((value) => value.trim()).filter(Boolean);
  if (projectKeys.length > 0 && rawCwds.length > 0) {
    throw new Error("--project and --cwd cannot be used together; choose one exact cwd filter");
  }
  const cwd = projectKeys.length > 0
    ? uniqueStrings(projectKeys.map((projectKey) => {
        const project = projects[projectKey];
        if (!project) throw new Error(`未找到项目：${projectKey}`);
        return resolve(project.repo);
      }))
    : uniqueStrings(rawCwds.map((value) => resolve(value)));
  const searchTerm = optionValue(args, "--search")?.trim() || undefined;
  const statuses = parseCodexThreadStatuses(args);
  const sinceMs = parseCodexThreadDateOption(args, "--since");
  const untilMs = parseCodexThreadDateOption(args, "--until");
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new Error("--since must be earlier than or equal to --until");
  }
  const sortKey = parseEnumOption(
    args,
    "--sort",
    ["created_at", "updated_at", "recency_at"] as const,
    "recency_at",
    "Codex thread 排序字段",
  );
  const sortDirection = parseEnumOption(
    args,
    "--direction",
    ["asc", "desc"] as const,
    "desc",
    "Codex thread 排序方向",
  );
  return {
    sourceKinds,
    modelProviders: rawProviders.length > 0 ? rawProviders : undefined,
    cwd: cwd.length > 0 ? cwd : undefined,
    searchTerm,
    archived: hasFlag(args, "--archived"),
    statuses,
    sinceMs,
    untilMs,
    sortKey,
    sortDirection,
    limit: parsePositiveIntegerOption(args, "--limit", DEFAULT_CODEX_THREAD_LIMIT, 1, 200),
    cursor: optionValue(args, "--cursor"),
  };
}

export function parseCodexThreadSources(values: string[]): CodexThreadSourceKind[] {
  const sources: CodexThreadSourceKind[] = [];
  for (const value of values.flatMap((item) => item.split(","))) {
    const source = value.trim();
    if (!source) continue;
    if (!CODEX_THREAD_SOURCE_KINDS.includes(source as CodexThreadSourceKind)) {
      throw new Error(`未知 Codex thread 来源：${source}；可选值：${CODEX_THREAD_SOURCE_KINDS.join(", ")}`);
    }
    const typed = source as CodexThreadSourceKind;
    if (!sources.includes(typed)) sources.push(typed);
  }
  if (sources.length === 0) throw new Error("Codex thread 来源不能为空");
  return sources;
}

export function parseCodexThreadStatuses(args: string[]): CodexThreadStatusType[] {
  const values = parseCsvOptions(args, ["--status"]);
  const statuses: CodexThreadStatusType[] = [];
  for (const value of values) {
    if (!CODEX_THREAD_STATUS_TYPES.includes(value as CodexThreadStatusType)) {
      throw new Error(`未知 Codex thread 状态：${value}；可选值：${CODEX_THREAD_STATUS_TYPES.join(", ")}`);
    }
    const status = value as CodexThreadStatusType;
    if (!statuses.includes(status)) statuses.push(status);
  }
  return statuses;
}

export function filterCodexThreads(
  threads: CodexThread[],
  query: Pick<CodexThreadQuery, "statuses" | "sinceMs" | "untilMs">,
): CodexThread[] {
  return threads.filter((thread) => {
    const status = codexThreadStatusType(thread.status);
    if (query.statuses.length > 0 && !query.statuses.includes(status as CodexThreadStatusType)) {
      return false;
    }
    if (query.sinceMs !== undefined || query.untilMs !== undefined) {
      const timestamp = codexThreadTimestampMs(thread);
      if (timestamp === null) return false;
      if (query.sinceMs !== undefined && timestamp < query.sinceMs) return false;
      if (query.untilMs !== undefined && timestamp > query.untilMs) return false;
    }
    return true;
  });
}

export function formatCodexThreads(
  result: CodexThreadQueryResult,
  query: CodexThreadQuery,
): string {
  const count = result.total === undefined
    ? `${result.items.length}${result.nextCursor ? "+" : ""}`
    : `${result.items.length}/${result.total}`;
  const lines = [
    `Codex Threads（${count}）`,
    `来源：${query.sourceKinds.join(", ")}；归档：${query.archived ? "仅归档" : "未归档"}`,
    `排序：${query.sortKey} ${query.sortDirection}`,
  ];
  if (query.cwd?.length) lines.push(`工作目录：${query.cwd.join(", ")}`);
  if (query.modelProviders?.length) lines.push(`模型提供方：${query.modelProviders.join(", ")}`);
  if (query.searchTerm) lines.push(`标题搜索：${query.searchTerm}`);
  if (query.statuses.length) lines.push(`运行状态：${query.statuses.join(", ")}`);
  if (query.sinceMs !== undefined) lines.push(`更新时间起点：${new Date(query.sinceMs).toISOString()}`);
  if (query.untilMs !== undefined) lines.push(`更新时间终点：${new Date(query.untilMs).toISOString()}`);
  if (result.scanned !== undefined) lines.push(`扫描线程：${result.scanned}（状态/时间筛选在本地完成）`);
  lines.push("");
  if (result.items.length === 0) {
    lines.push("没有找到匹配的 Codex thread。可以尝试去掉 --project、--search 或 --status 筛选。");
    return lines.join("\n");
  }
  for (const [index, thread] of result.items.entries()) {
    const title = thread.name?.trim() || thread.preview?.trim() || "（无标题）";
    const source = codexThreadSourceLabel(thread.source ?? thread.threadSource);
    const status = codexThreadStatusType(thread.status);
    lines.push(`${index + 1}. [${status}] ${title}`);
    lines.push(`   Thread：${thread.id}`);
    lines.push(`   来源：${source}；目录：${thread.cwd || "—"}`);
    lines.push(`   创建：${formatCodexThreadTimestamp(thread.createdAt)}；更新：${formatCodexThreadTimestamp(thread.updatedAt)}`);
    if (thread.modelProvider || thread.model) {
      lines.push(`   模型：${thread.modelProvider || "—"}${thread.model ? ` / ${thread.model}` : ""}`);
    }
    if (thread.cliVersion) lines.push(`   CLI 版本：${thread.cliVersion}`);
    if (Array.isArray(thread.turns)) lines.push(`   轮次：${thread.turns.length}`);
    lines.push("");
  }
  if (result.nextCursor) lines.push(`还有更多结果，使用 --cursor '${result.nextCursor}' 查询下一页。`);
  return lines.join("\n").trimEnd();
}

export function formatCodexThread(thread: CodexThread, includeTurns = false): string {
  const lines = [
    `Codex Thread：${thread.id}`,
    `标题：${thread.name?.trim() || thread.preview?.trim() || "（无标题）"}`,
    `状态：${codexThreadStatusType(thread.status)}`,
    `来源：${codexThreadSourceLabel(thread.source ?? thread.threadSource)}`,
    `目录：${thread.cwd || "—"}`,
    `模型：${thread.modelProvider || "—"}${thread.model ? ` / ${thread.model}` : ""}`,
    `创建时间：${formatCodexThreadTimestamp(thread.createdAt)}`,
    `更新时间：${formatCodexThreadTimestamp(thread.updatedAt)}`,
    `Session：${thread.sessionId || "—"}`,
  ];
  if (thread.forkedFromId) lines.push(`Fork 来源：${thread.forkedFromId}`);
  if (thread.parentThreadId) lines.push(`父 Thread：${thread.parentThreadId}`);
  if (thread.cliVersion) lines.push(`CLI 版本：${thread.cliVersion}`);
  if (includeTurns) {
    lines.push("", "轮次详情：", JSON.stringify(thread.turns || [], null, 2));
  } else if (Array.isArray(thread.turns)) {
    lines.push(`轮次：${thread.turns.length}（使用 --turns 展开）`);
  }
  return lines.join("\n");
}

function parseCodexThreadDateOption(args: string[], name: string): number | undefined {
  const value = optionValue(args, name);
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO date/time, for example 2026-09-01T00:00:00+08:00`);
  return timestamp;
}

function parseEnumOption<T extends string>(
  args: string[],
  name: string,
  values: readonly T[],
  defaultValue: T,
  label: string,
): T {
  const value = optionValue(args, name) || defaultValue;
  if (!values.includes(value as T)) throw new Error(`未知${label}：${value}；可选值：${values.join(", ")}`);
  return value as T;
}

function parseCsvOptions(args: string[], names: string[]): string[] {
  const values = names.flatMap((name) => optionValues(args, name));
  return uniqueStrings(values.flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean)));
}

export async function queryCodexThreads(
  client: CodexAppServerQueryClient,
  query: CodexThreadQuery,
): Promise<CodexThreadQueryResult> {
  const requiresLocalFiltering = query.statuses.length > 0
    || query.sinceMs !== undefined
    || query.untilMs !== undefined;
  if (!requiresLocalFiltering) {
    const page = await client.listThreads(buildCodexThreadListParams(query));
    return {
      items: page.data,
      nextCursor: page.nextCursor,
      backwardsCursor: page.backwardsCursor,
    };
  }

  const items: CodexThread[] = [];
  let cursor = query.cursor;
  let backwardsCursor: string | null = null;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await client.listThreads(buildCodexThreadListParams(query, cursor, CODEX_THREAD_PAGE_SIZE));
    if (backwardsCursor === null) backwardsCursor = page.backwardsCursor;
    items.push(...page.data);
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) throw new Error("Codex app-server returned a repeated pagination cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (items.length >= MAX_CODEX_THREAD_SCAN) {
      throw new Error(`本地状态/时间筛选最多扫描 ${MAX_CODEX_THREAD_SCAN} 个线程；请先增加 --project、--cwd 或 --search 缩小范围`);
    }
  }
  const filtered = filterCodexThreads(items, query);
  return {
    items: filtered.slice(0, query.limit),
    total: filtered.length,
    nextCursor: null,
    backwardsCursor,
    scanned: items.length,
  };
}

function buildCodexThreadListParams(
  query: CodexThreadQuery,
  cursor = query.cursor,
  limit = query.limit,
): CodexThreadListParams {
  return {
    cursor,
    limit,
    sortKey: query.sortKey,
    sortDirection: query.sortDirection,
    sourceKinds: query.sourceKinds,
    modelProviders: query.modelProviders,
    archived: query.archived,
    cwd: query.cwd?.length === 1 ? query.cwd[0] : query.cwd,
    searchTerm: query.searchTerm,
    // A read-only bridge query must not ask app-server to scan JSONL and
    // repair its state database as a side effect.
    useStateDbOnly: true,
  };
}

function serializeCodexThreadFilters(query: CodexThreadQuery): Record<string, unknown> {
  return {
    sourceKinds: query.sourceKinds,
    modelProviders: query.modelProviders,
    cwd: query.cwd,
    searchTerm: query.searchTerm,
    archived: query.archived,
    statuses: query.statuses,
    since: query.sinceMs === undefined ? undefined : new Date(query.sinceMs).toISOString(),
    until: query.untilMs === undefined ? undefined : new Date(query.untilMs).toISOString(),
    sortKey: query.sortKey,
    sortDirection: query.sortDirection,
    limit: query.limit,
    cursor: query.cursor,
  };
}

function formatCodexThreadTimestamp(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1_000).toISOString()
    : "—";
}

export function parseDirectTaskStatuses(args: string[]): DirectTaskStatus[] | undefined {
  const rawValues = optionValues(args, "--status");
  if (rawValues.length === 0) return undefined;
  const statuses: DirectTaskStatus[] = [];
  for (const value of rawValues.flatMap((item) => item.split(","))) {
    if (!DIRECT_TASK_STATUSES.includes(value as DirectTaskStatus)) {
      throw new Error(`未知直连任务状态：${value}；可选值：${DIRECT_TASK_STATUSES.join(", ")}`);
    }
    const status = value as DirectTaskStatus;
    if (!statuses.includes(status)) statuses.push(status);
  }
  return statuses;
}

async function installCodexLaunchAgent(
  args: CodexCliArguments,
  commandArgs: string[],
): Promise<void> {
  const paths = await writeCodexLaunchAgent(args);
  if (hasFlag(commandArgs, "--print")) {
    console.log(await readFile(paths.plistPath, "utf8"));
    return;
  }
  console.log(`已生成 Codex LaunchAgent：${paths.plistPath}`);
  console.log("下一步执行：pnpm run codex:start");
  if (hasFlag(commandArgs, "--start")) {
    const config = loadConfig(args.configPath, {
      executionMode: resolveCodexExecutionMode(args),
    });
    assertDirectMode(config);
    await startCodexLaunchAgent(args);
  }
}

async function writeCodexLaunchAgent(
  args: CodexCliArguments,
): Promise<CodexLaunchAgentPaths> {
  if (process.platform !== "darwin") {
    throw new Error("codex:install 目前只支持 macOS LaunchAgent；Linux 请使用 systemd 或前台进程管理器。");
  }
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  const logDir = join(PROJECT_ROOT, "runtime", "logs");
  const attachmentsDir = join(PROJECT_ROOT, "runtime", "direct", "attachments");
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
  const paths: CodexLaunchAgentPaths = {
    plistPath: join(launchAgentsDir, CODEX_SERVICE_PLIST_NAME),
    stdoutPath: join(logDir, "bridge.stdout.log"),
    stderrPath: join(logDir, "bridge.stderr.log"),
    configPath: resolve(args.configPath),
    dbPath: resolve(args.dbPath),
  };
  const plist = buildCodexLaunchAgentPlist({
    nodePath: resolveLaunchAgentNodePath(args.nodePath),
    projectRoot: PROJECT_ROOT,
    configPath: paths.configPath,
    dbPath: paths.dbPath,
    executionMode: resolveCodexExecutionMode(args),
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  });
  await writeFile(paths.plistPath, plist, { encoding: "utf8", mode: 0o600 });
  await chmod(paths.plistPath, 0o600);
  return paths;
}

async function startCodexLaunchAgent(args: CodexCliArguments): Promise<void> {
  await withLaunchdOperationLock(async () => {
    await assertBuiltRuntime();
    const paths = await writeCodexLaunchAgent(args);
    assertDarwinLaunchd();
    const target = launchdTarget();
    const current = await launchctl(["print", target]);
    if (current.exitCode === 0) {
      const kicked = await kickstartLaunchAgentWithRetry(target);
      if (kicked.exitCode !== 0) throw launchctlError("启动 Codex LaunchAgent 失败", kicked);
      console.log(`Codex LaunchAgent 已重启：${target}`);
      return;
    }
    const bootstrapped = await bootstrapLaunchAgentWithRetry(paths.plistPath, target);
    if (bootstrapped.exitCode !== 0) {
      throw launchctlError("加载 Codex LaunchAgent 失败", bootstrapped);
    }
    console.log(`Codex LaunchAgent 已启动：${target}`);
  });
}

async function uninstallCodexLaunchAgent(): Promise<void> {
  assertDarwinLaunchd();
  await stopCodexLaunchAgent();
  const plistPath = join(homedir(), "Library", "LaunchAgents", CODEX_SERVICE_PLIST_NAME);
  try {
    await unlink(plistPath);
    console.log(`已删除 Codex LaunchAgent：${plistPath}`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      console.log(`Codex LaunchAgent plist 不存在：${plistPath}`);
      return;
    }
    throw error;
  }
}

async function stopCodexLaunchAgent(): Promise<void> {
  assertDarwinLaunchd();
  const target = launchdTarget();
  const current = await launchctl(["print", target]);
  if (current.exitCode !== 0) {
    console.log(`Codex LaunchAgent 未加载：${target}`);
    return;
  }
  const stopped = await launchctl(["bootout", target]);
  if (stopped.exitCode !== 0 && !isLaunchdNotLoaded(stopped)) {
    throw launchctlError("停止 Codex LaunchAgent 失败", stopped);
  }
  console.log(`Codex LaunchAgent 已停止：${target}`);
}

async function restartCodexLaunchAgent(args: CodexCliArguments): Promise<void> {
  await withLaunchdOperationLock(async () => {
    await assertBuiltRuntime();
    const paths = await writeCodexLaunchAgent(args);
    assertDarwinLaunchd();
    const target = launchdTarget();
    const current = await launchctl(["print", target]);
    if (current.exitCode === 0) {
      const stopped = await launchctl(["bootout", target]);
      if (stopped.exitCode !== 0 && !isLaunchdNotLoaded(stopped)) {
        throw launchctlError("重启前停止 Codex LaunchAgent 失败", stopped);
      }
      await waitForLaunchdUnloaded(target);
    }
    const started = await bootstrapLaunchAgentWithRetry(paths.plistPath, target);
    if (started.exitCode !== 0) throw launchctlError("重载 Codex LaunchAgent 失败", started);
    const kicked = await kickstartLaunchAgentWithRetry(target);
    if (kicked.exitCode !== 0) throw launchctlError("启动 Codex LaunchAgent 失败", kicked);
    console.log(`Codex LaunchAgent 已重启：${target}`);
  });
}

async function runCodexStatus(
  config: BridgeConfig,
  args: CodexCliArguments,
  db: StateDatabase,
  commandArgs: string[],
): Promise<void> {
  const launchd = await getLaunchdStatus();
  const lease = db.getRuntimeLease(DIRECT_RUNTIME_LEASE_NAME);
  const counts = db.getBridgeTaskStatusCounts();
  const outbox = db.getOutboxSummary(["feishu.send_text", "feishu.stream_card"]);
  const credentials = inspectCredentials(config);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    mode: config.execution.mode,
    projectKey: config.direct.projectKey,
    modeKey: config.direct.mode,
    configPath: resolve(args.configPath),
    databasePath: resolve(args.dbPath),
    launchd: {
      label: CODEX_SERVICE_LABEL,
      ...launchd,
    },
    credentials,
    runtimeLease: lease ? formatRuntimeLease(lease) : null,
    taskCounts: counts,
    outbox,
  };
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(formatCodexStatus(snapshot));
}

export function formatCodexStatus(snapshot: {
  mode: string;
  projectKey?: string;
  modeKey?: string;
  configPath: string;
  databasePath: string;
  launchd: LaunchdStatus & { label: string };
  credentials: { appId: boolean; appSecret: boolean; source?: FeishuCredentialSource; error?: string };
  runtimeLease: ReturnType<typeof formatRuntimeLease> | null;
  taskCounts: Record<DirectTaskStatus, number>;
  outbox: OutboxSummary;
}): string {
  const lines = [
    "Codex 原生直连状态",
    `模式：${snapshot.mode}`,
    `项目/执行模式：${snapshot.projectKey || "(未配置)"}/${snapshot.modeKey || "(未配置)"}`,
    `配置：${snapshot.configPath}`,
    `数据库：${snapshot.databasePath}`,
    `LaunchAgent：${snapshot.launchd.label} · ${formatLaunchdStatus(snapshot.launchd)}`,
    `飞书凭据：appId=${snapshot.credentials.appId ? "已配置" : "缺失"} appSecret=${snapshot.credentials.appSecret ? "已配置" : "缺失"}${snapshot.credentials.source ? `（来源：${formatCredentialSource(snapshot.credentials.source)}）` : ""}`,
    `运行时租约：${snapshot.runtimeLease ? formatRuntimeLeaseText(snapshot.runtimeLease) : "无"}`,
    "任务：",
    ...DIRECT_TASK_STATUSES.map((status) => `  ${status}: ${snapshot.taskCounts[status]}`),
    `Outbox：pending=${snapshot.outbox.pending} due=${snapshot.outbox.due} delivered=${snapshot.outbox.delivered}`,
  ];
  if (snapshot.credentials.error) lines.push(`凭据检查：${snapshot.credentials.error}`);
  if (snapshot.launchd.detail) lines.push(`LaunchAgent 详情：${snapshot.launchd.detail}`);
  return lines.join("\n");
}

async function runCodexLogs(
  args: CodexCliArguments,
  commandArgs: string[],
): Promise<void> {
  const lineCount = parsePositiveIntegerOption(commandArgs, "--lines", DEFAULT_LOG_LINE_COUNT, 1, 10_000);
  const selected = hasFlag(commandArgs, "--stderr")
    ? [{ name: "stderr", path: join(PROJECT_ROOT, "runtime", "logs", "bridge.stderr.log") }]
    : hasFlag(commandArgs, "--stdout")
      ? [{ name: "stdout", path: join(PROJECT_ROOT, "runtime", "logs", "bridge.stdout.log") }]
      : [
          { name: "stdout", path: join(PROJECT_ROOT, "runtime", "logs", "bridge.stdout.log") },
          { name: "stderr", path: join(PROJECT_ROOT, "runtime", "logs", "bridge.stderr.log") },
        ];
  if (hasFlag(commandArgs, "--json")) {
    const entries = await Promise.all(selected.map(async (entry) => ({
      ...entry,
      content: await readTail(entry.path, lineCount),
    })));
    console.log(JSON.stringify({ configPath: resolve(args.configPath), entries }, null, 2));
    return;
  }
  await printLogTails(selected, lineCount);
  if (hasFlag(commandArgs, "--follow")) await followLogs(selected);
}

async function runCodexRecent(
  db: StateDatabase,
  args: CodexCliArguments,
  commandArgs: string[],
): Promise<void> {
  const statuses = parseDirectTaskStatuses(commandArgs);
  const result = db.listBridgeTasks({
    statuses,
    chatId: optionValue(commandArgs, "--chat"),
    search: optionValue(commandArgs, "--search"),
    limit: parsePositiveIntegerOption(commandArgs, "--limit", 20, 1, 200),
    offset: parsePositiveIntegerOption(commandArgs, "--offset", 0, 0, 100_000),
  });
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
    return;
  }
  console.log(formatDirectRecent(result, {
    fullMessage: hasFlag(commandArgs, "--full-message"),
    databasePath: args.dbPath,
  }));
}

async function runCodexLocalNotifications(
  config: BridgeConfig,
  commandArgs: string[],
): Promise<void> {
  const intervalSeconds = parsePositiveIntegerOption(commandArgs, "--interval", 60, 10, 3_600);
  const statePath = resolve(
    optionValue(commandArgs, "--state") || join(PROJECT_ROOT, "runtime", "codex-local-notifications.json"),
  );
  const watcher = new LocalCodexNotificationWatcher({
    createClient: () => new CodexAppServerClient({
      executable: config.codex.cliPath,
      cwd: PROJECT_ROOT,
      env: buildCodexAppServerEnvironment(config),
      clientName: "feishu_codex_bridge_notifications",
      clientTitle: "Feishu Codex Bridge Notifications",
    }),
    statePath,
    logger: {
      info: (message, details) => console.log(JSON.stringify({ level: "info", message, details })),
      warn: (message, details) => console.warn(JSON.stringify({ level: "warn", message, details })),
      error: (message, details) => console.error(JSON.stringify({ level: "error", message, details })),
    },
  });
  let stopped = false;
  let resolveStopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await watcher.stop();
    resolveStopped?.();
  };
  const onSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await watcher.start(intervalSeconds);
    if (hasFlag(commandArgs, "--once")) return;
    await stoppedPromise;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await stop();
  }
}

async function runCodexTask(db: StateDatabase, commandArgs: string[]): Promise<void> {
  const selector = firstPositional(commandArgs);
  if (!selector) throw new Error("task/inspect requires a task id or unique prefix");
  const task = resolveDirectTask(db, selector);
  const attachments = db.getBridgeTaskAttachments(task.bridge_task_id);
  const events = db.listBridgeTaskEvents(task.bridge_task_id);
  const outbox = db.listOutbox({ taskGuid: task.bridge_task_id, limit: 500 });
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify({ task, attachments, events, outbox }, null, 2));
    return;
  }
  console.log(formatDirectTask(task, attachments, events, outbox));
}

async function runCodexAttachments(db: StateDatabase, commandArgs: string[]): Promise<void> {
  const selector = firstPositional(commandArgs);
  if (!selector) throw new Error("attachments requires a task id or unique prefix");
  const task = resolveDirectTask(db, selector);
  const attachments = db.getBridgeTaskAttachments(task.bridge_task_id);
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify({ bridgeTaskId: task.bridge_task_id, attachments }, null, 2));
    return;
  }
  console.log(`Codex 任务附件：${task.bridge_task_id}`);
  if (attachments.length === 0) {
    console.log("没有附件。");
    return;
  }
  console.log(attachments.map(formatAttachmentLine).join("\n"));
}

async function runCodexOutbox(db: StateDatabase, commandArgs: string[]): Promise<void> {
  const taskSelector = optionValue(commandArgs, "--task");
  const task = taskSelector ? resolveDirectTask(db, taskSelector) : null;
  const operations = optionValues(commandArgs, "--operation");
  const entries = db.listOutbox({
    taskGuid: task?.bridge_task_id,
    operations: operations.length > 0 ? operations : undefined,
    pendingOnly: hasFlag(commandArgs, "--pending"),
    limit: parsePositiveIntegerOption(commandArgs, "--limit", 100, 1, 500),
  });
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.log(`Codex Outbox（${entries.length}）`);
  if (entries.length === 0) {
    console.log("没有匹配的 outbox 条目。");
    return;
  }
  console.log(entries.map(formatOutboxLine).join("\n"));
}

async function runCodexCancel(db: StateDatabase, commandArgs: string[]): Promise<void> {
  const selector = firstPositional(commandArgs);
  if (!selector) throw new Error("cancel requires a task id or unique prefix");
  const task = resolveDirectTask(db, selector);
  const reason = optionValue(commandArgs, "--reason") || "命令行请求取消任务。";
  const updated = db.requestBridgeTaskCancellation(task.bridge_task_id, reason);
  if (!updated) throw new Error(`任务不存在：${selector}`);
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.log(`任务 ${updated.bridge_task_id} 当前状态：${updated.status}`);
  if (updated.status === "CANCEL_REQUESTED") {
    console.log("取消请求已持久化；正在运行的原生 runtime 会通过 SQLite 观察并中止 Codex。");
  } else if (updated.status === "CANCELLED") {
    console.log("任务已取消。");
  } else {
    console.log("任务已经是终态，无需取消。");
  }
}

async function runCodexRetry(db: StateDatabase, commandArgs: string[]): Promise<void> {
  const selector = firstPositional(commandArgs);
  if (!selector) throw new Error("retry requires a task id or unique prefix");
  const task = resolveDirectTask(db, selector);
  const reason = optionValue(commandArgs, "--reason") || "命令行请求重试任务。";
  if (task.status !== "FAILED" && task.status !== "CANCELLED") {
    throw new Error(`只有 FAILED/CANCELLED 任务可以重试，当前状态为 ${task.status}`);
  }
  const retried = db.retryBridgeTask(task.bridge_task_id, reason);
  if (!retried) throw new Error(`任务不存在：${selector}`);
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify(retried, null, 2));
    return;
  }
  console.log(`任务已重新排队：${retried.bridge_task_id}`);
  console.log("如果原卡片仍存在，runtime 会继续更新原卡片；否则会创建新的流式卡片。");
}

async function runCodexRecover(db: StateDatabase, commandArgs: string[]): Promise<void> {
  const force = hasFlag(commandArgs, "--force");
  if (force) {
    const lease = db.getRuntimeLease(DIRECT_RUNTIME_LEASE_NAME);
    if (lease && Date.parse(lease.lease_expires_at) > Date.now()) {
      throw new Error("当前仍有活跃的 Codex runtime 租约；请先执行 codex:stop，再使用 codex:recover --force。");
    }
  }
  const recovery = db.recoverExpiredBridgeTasks(force);
  const backfilledCards = db.ensureDirectCardOutboxes();
  const result = { ...recovery, backfilledCards };
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`已恢复任务：重新排队 ${recovery.requeued}，完成取消 ${recovery.cancelled}。`);
  console.log(`补齐流式卡片 outbox：${backfilledCards} 条。`);
}

async function runCodexWorktrees(config: BridgeConfig, commandArgs: string[]): Promise<void> {
  const projectFilter = optionValue(commandArgs, "--project");
  const projects = Object.entries(config.projects)
    .filter(([projectKey]) => !projectFilter || projectKey === projectFilter);
  if (projects.length === 0) throw new Error(`未找到项目：${projectFilter}`);
  const result = [] as Array<{ projectKey: string; repository: string; worktrees: GitWorktree[]; error?: string }>;
  for (const [projectKey, project] of projects) {
    const command = await runCaptured("git", ["-C", project.repo, "worktree", "list", "--porcelain"]);
    if (command.exitCode !== 0) {
      result.push({ projectKey, repository: project.repo, worktrees: [], error: command.stderr.trim() || command.stdout.trim() });
      continue;
    }
    result.push({ projectKey, repository: project.repo, worktrees: parseGitWorktrees(command.stdout) });
  }
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const lines = ["Codex 配置仓库 worktree", "（原生直连模式不会为每条 Feishu 消息自动创建隔离 worktree）", ""];
  for (const project of result) {
    lines.push(`${project.projectKey} · ${project.repository}`);
    if (project.error) {
      lines.push(`  错误：${project.error}`);
    } else if (project.worktrees.length === 0) {
      lines.push("  (无)");
    } else {
      for (const worktree of project.worktrees) {
        lines.push(`  ${worktree.path}${worktree.branch ? ` · ${worktree.branch}` : ""}${worktree.commit ? ` @ ${worktree.commit.slice(0, 12)}` : ""}`);
      }
    }
    lines.push("");
  }
  console.log(lines.join("\n").trimEnd());
}

async function runCodexDoctor(config: BridgeConfig, args: CodexCliArguments, db: StateDatabase): Promise<void> {
  const checks: DoctorCheck[] = [];
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "Node.js",
    status: compareVersions([major, minor, patch], MIN_NODE_VERSION) >= 0 ? "ok" : "fail",
    detail: `${process.versions.node}（要求 >= ${MIN_NODE_VERSION.join(".")}）`,
  });
  checks.push({
    name: "execution.mode",
    status: isDirectExecutionMode(config.execution.mode) ? "ok" : "fail",
    detail: config.execution.mode,
  });
  checks.push({
    name: "Codex CLI",
    ...(await checkExecutable(config.codex.cliPath)),
  });
  const credentials = inspectCredentials(config);
  checks.push({
    name: "Feishu appId",
    status: credentials.appId ? "ok" : "fail",
    detail: credentials.appId
      ? `已配置${credentials.source ? `（来源：${formatCredentialSource(credentials.source)}）` : ""}`
      : `缺失（${config.direct.feishu.appIdEnv} 或 AAMP binding）`,
  });
  checks.push({
    name: "Feishu appSecret",
    status: credentials.appSecret ? "ok" : "fail",
    detail: credentials.appSecret
      ? `已配置${credentials.source ? `（来源：${formatCredentialSource(credentials.source)}）` : ""}`
      : `缺失（${config.direct.feishu.appSecretEnv} 或 AAMP binding）`,
  });
  checks.push({
    name: "任务路由",
    status: config.direct.projectKey && config.direct.mode ? "ok" : "warn",
    detail: [
      `默认=${config.direct.projectKey || "(任务指定)"}/${config.direct.mode || "(任务指定)"}`,
      `可选项目=${Object.keys(config.projects).join(", ") || "(未配置)"}`,
      `可选模式=${Object.keys(config.modes).join(", ") || "(未配置)"}`,
    ].join("；"),
  });
  checks.push({
    name: "编译产物",
    ...(await checkPath(join(PROJECT_ROOT, "dist", "main.js"), false)),
  });
  checks.push({
    name: "SQLite schema",
    status: Object.values(db.getBridgeTaskStatusCounts()).every((value) => Number.isInteger(value)) ? "ok" : "fail",
    detail: `${args.dbPath}`,
  });
  const plistPath = codexLaunchAgentPaths(args).plistPath;
  checks.push({
    name: "LaunchAgent plist",
    ...(await checkPath(plistPath, false, true)),
  });
  const launchd = await getLaunchdStatus();
  checks.push({
    name: "LaunchAgent 状态",
    status: !launchd.supported ? "warn" : launchd.running ? "ok" : launchd.loaded ? "warn" : "warn",
    detail: !launchd.supported ? "当前系统不是 macOS" : formatLaunchdStatus(launchd),
  });
  const activeLease = db.getRuntimeLease(DIRECT_RUNTIME_LEASE_NAME);
  if (activeLease && Date.parse(activeLease.lease_expires_at) <= Date.now()) {
    checks.push({ name: "运行时租约", status: "warn", detail: `已过期：${activeLease.owner}` });
  } else {
    checks.push({ name: "运行时租约", status: "ok", detail: activeLease ? `活动：${activeLease.owner}` : "无活动租约" });
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  console.log(formatDoctorChecks(checks));
  if (failed > 0) throw new Error(`codex:doctor 发现 ${failed} 个阻塞问题`);
}

async function runCodexUpdate(commandArgs: string[], configPath: string): Promise<void> {
  const checkOnly = hasFlag(commandArgs, "--check");
  const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  const sdkVersion = String(packageJson.dependencies?.["@openai/codex-sdk"] ?? "(未配置)");
  const configuredCliPath = await readConfiguredCliPath(configPath);
  const cli = configuredCliPath ? await runCaptured(configuredCliPath, ["--version"]) : undefined;
  if (checkOnly) {
    console.log(`@openai/codex-sdk：${sdkVersion}`);
    console.log(`Codex CLI：${configuredCliPath || "(无法从 config.json 读取)"}`);
    if (cli) console.log(`Codex CLI 版本：${(cli.stdout || cli.stderr).trim() || "(无版本输出)"}`);
    console.log("系统 Codex CLI 的安装方式由本机管理；本命令不会擅自执行 brew/npm 更新。");
    return;
  }
  if (process.env.FEISHU_CODEX_BRIDGE_PORTABLE_ROOT) {
    throw new Error(
      "Portable Runtime Lite 不支持在包内更新 @openai/codex-sdk；请下载新版 Portable Runtime Lite 后替换整个目录。",
    );
  }
  const update = await runInherited(process.env.PNPM_BIN || "pnpm", ["update", "@openai/codex-sdk"], PROJECT_ROOT);
  if (update !== 0) throw new Error(`更新 @openai/codex-sdk 失败，退出码：${update}`);
  console.log("@openai/codex-sdk 已更新；请重新执行 pnpm run build 并重启 codex LaunchAgent。");
  console.log("系统 Codex CLI 未自动更新，请按本机安装方式单独更新。");
}

async function withDatabase(
  dbPath: string,
  callback: (db: StateDatabase) => Promise<void> | void,
): Promise<void> {
  const db = new StateDatabase(resolve(dbPath));
  try {
    await callback(db);
  } finally {
    db.close();
  }
}

function assertDirectMode(config: BridgeConfig): void {
  assertDirectExecutionMode(config.execution.mode);
}

function resolveCodexExecutionMode(args: CodexCliArguments): ExecutionMode {
  const mode = args.executionMode ?? DEFAULT_CODEX_EXECUTION_MODE;
  assertDirectExecutionMode(mode);
  return mode;
}

function assertDirectExecutionMode(mode: ExecutionMode): void {
  if (!isDirectExecutionMode(mode)) {
    throw new Error(
      `codex: 命令只支持原生直连 execution mode，当前为 ${mode}；可使用 --mode feishu-sqlite-codex（或 feishu-sqlite-acp）。`,
    );
  }
}

function codexLaunchAgentPaths(args: CodexCliArguments): CodexLaunchAgentPaths {
  return {
    plistPath: join(homedir(), "Library", "LaunchAgents", CODEX_SERVICE_PLIST_NAME),
    stdoutPath: join(PROJECT_ROOT, "runtime", "logs", "bridge.stdout.log"),
    stderrPath: join(PROJECT_ROOT, "runtime", "logs", "bridge.stderr.log"),
    configPath: resolve(args.configPath),
    dbPath: resolve(args.dbPath),
  };
}

function resolveDirectTask(db: StateDatabase, selector: string): StoredBridgeTask {
  const normalized = selector.trim();
  if (!normalized) throw new Error("task id or prefix is required");
  const matches = db.findBridgeTasksById(normalized, 200);
  if (matches.length === 0) throw new Error(`Codex task not found: ${normalized}`);
  if (matches.length > 1) {
    throw new Error(`Codex task selector is ambiguous: ${normalized}; matches: ${matches.map((task) => task.bridge_task_id).join(", ")}`);
  }
  return matches[0];
}

function firstPositional(args: string[]): string | undefined {
  const valueOptions = new Set([
    "--reason",
    "--status",
    "--chat",
    "--search",
    "--limit",
    "--offset",
    "--task",
    "--operation",
    "--project",
    "--source",
    "--source-kind",
    "--provider",
    "--model-provider",
    "--cwd",
    "--since",
    "--until",
    "--sort",
    "--direction",
    "--cursor",
    "--lines",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (valueOptions.has(value)) {
      index += 1;
      continue;
    }
    if ([...valueOptions].some((option) => value.startsWith(`${option}=`))) continue;
    if (!value.startsWith("--")) return value;
  }
  return undefined;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const argument = args[index];
  const value = argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a value`);
      values.push(value);
    }
  }
  return values;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveIntegerOption(
  args: string[],
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = optionValue(args, name);
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function formatAttachmentLine(attachment: StoredBridgeTaskAttachment): string {
  return `  ${attachment.type} [${attachment.status}] ${attachment.file_name || attachment.file_key}${attachment.local_path ? ` -> ${attachment.local_path}` : ""}${attachment.error ? ` · ${attachment.error}` : ""}`;
}

function formatEventLine(event: StoredBridgeTaskEvent): string {
  return `  ${event.created_at} ${event.event_type} · ${truncateText(event.payload_json, 1_200)}`;
}

function formatOutboxLine(entry: OutboxEntry): string {
  return `  #${entry.id} ${entry.operation} task=${entry.task_guid} attempts=${entry.attempts} ${entry.completed_at ? `delivered=${entry.completed_at}` : `next=${entry.next_attempt_at || "now"}`}`;
}

function formatLease(owner: string | null, expires: string | null): string {
  return owner ? `${owner} until ${expires || "(unknown)"}` : "无";
}

function formatRuntimeLease(lease: RuntimeLeaseRecord): RuntimeLeaseRecord & { active: boolean } {
  return {
    ...lease,
    active: Date.parse(lease.lease_expires_at) > Date.now(),
  };
}

function formatRuntimeLeaseText(lease: ReturnType<typeof formatRuntimeLease>): string {
  return `${lease.active ? "活动" : "已过期"} · ${lease.owner} until ${lease.lease_expires_at}`;
}

function formatLaunchdStatus(status: LaunchdStatus): string {
  if (!status.supported) return "不支持（非 macOS）";
  if (!status.loaded) return "未加载";
  return `${status.running ? "running" : "已加载但未运行"}${status.pid ? ` pid=${status.pid}` : ""}`;
}

function inspectCredentials(config: BridgeConfig): {
  appId: boolean;
  appSecret: boolean;
  source?: FeishuCredentialSource;
  error?: string;
} {
  try {
    const credentials = resolveSharedFeishuCredentials(config);
    return {
      appId: Boolean(credentials.appId),
      appSecret: Boolean(credentials.appSecret),
      source: credentials.source,
    };
  } catch (error) {
    return {
      appId: Boolean(config.direct.feishu.appId || process.env[config.direct.feishu.appIdEnv]),
      appSecret: Boolean(config.direct.feishu.appSecret || process.env[config.direct.feishu.appSecretEnv]),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatCredentialSource(source: FeishuCredentialSource): string {
  switch (source) {
    case "direct-config":
      return "direct.feishu";
    case "environment":
      return "环境变量";
    case "aamp-binding":
      return "AAMP binding";
    case "mixed":
      return "配置与环境/AAMP binding";
  }
}

async function checkExecutable(path: string): Promise<Omit<DoctorCheck, "name">> {
  try {
    await access(path, fsConstants.X_OK);
    return { status: "ok", detail: path };
  } catch (error) {
    return { status: "fail", detail: `${path}：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkPath(path: string, executable: boolean, optional = false): Promise<Omit<DoctorCheck, "name">> {
  try {
    await access(path, executable ? fsConstants.X_OK : fsConstants.F_OK);
    return { status: "ok", detail: path };
  } catch {
    return { status: optional ? "warn" : "fail", detail: `${path}（不存在）` };
  }
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function formatDoctorChecks(checks: DoctorCheck[]): string {
  return [
    "Codex doctor",
    ...checks.map((check) => `${check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"} ${check.name}: ${check.detail}`),
  ].join("\n");
}

interface GitWorktree {
  path: string;
  commit?: string;
  branch?: string;
}

function parseGitWorktrees(output: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      records.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.commit = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return records;
}

async function getLaunchdStatus(): Promise<LaunchdStatus> {
  if (process.platform !== "darwin") return { supported: false, loaded: false, running: false };
  const result = await launchctl(["print", launchdTarget()]);
  if (result.exitCode !== 0) {
    return {
      supported: true,
      loaded: false,
      running: false,
      detail: (result.stderr || result.stdout).trim() || undefined,
    };
  }
  const pidMatch = result.stdout.match(/(?:^|\n)\s*pid\s*=\s*(\d+)/);
  return {
    supported: true,
    loaded: true,
    running: /(?:^|\n)\s*state\s*=\s*running\b/.test(result.stdout),
    pid: pidMatch ? Number(pidMatch[1]) : undefined,
  };
}

function assertDarwinLaunchd(): void {
  if (process.platform !== "darwin") throw new Error("Codex LaunchAgent 命令目前只支持 macOS");
}

function launchdTarget(): string {
  return `gui/${currentUid()}/${CODEX_SERVICE_LABEL}`;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

interface CapturedProcess {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function launchctl(args: string[]): Promise<CapturedProcess> {
  return runCaptured("/bin/launchctl", args);
}

function launchctlError(prefix: string, result: CapturedProcess): Error {
  return new Error(`${prefix}：${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
}

function isLaunchdNotLoaded(result: CapturedProcess): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return text.includes("could not find service")
    || text.includes("no such process")
    || text.includes("service is not loaded")
    || text.includes("failed to find service");
}

async function bootstrapLaunchAgentWithRetry(
  plistPath: string,
  target: string,
): Promise<CapturedProcess> {
  let last: CapturedProcess = {
    exitCode: 1,
    stdout: "",
    stderr: "bootstrap was not attempted",
  };
  for (let attempt = 1; attempt <= LAUNCHD_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    const current = await launchctl(["print", target]);
    if (current.exitCode === 0) return current;

    last = await launchctl(["bootstrap", `gui/${currentUid()}`, plistPath]);
    if (last.exitCode === 0) return last;
    if (!isLaunchdRetryable(last) || attempt === LAUNCHD_BOOTSTRAP_ATTEMPTS) return last;

    const delayMs = Math.min(
      LAUNCHD_RETRY_MAX_DELAY_MS,
      LAUNCHD_RETRY_INITIAL_DELAY_MS * 2 ** (attempt - 1),
    );
    await delay(delayMs);
  }
  return last;
}

async function kickstartLaunchAgentWithRetry(target: string): Promise<CapturedProcess> {
  let last: CapturedProcess = {
    exitCode: 1,
    stdout: "",
    stderr: "kickstart was not attempted",
  };
  for (let attempt = 1; attempt <= LAUNCHD_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    last = await launchctl(["kickstart", "-k", target]);
    if (last.exitCode === 0) return last;
    if (!isLaunchdRetryable(last) || attempt === LAUNCHD_BOOTSTRAP_ATTEMPTS) return last;
    const delayMs = Math.min(
      LAUNCHD_RETRY_MAX_DELAY_MS,
      LAUNCHD_RETRY_INITIAL_DELAY_MS * 2 ** (attempt - 1),
    );
    await delay(delayMs);
  }
  return last;
}

function isLaunchdRetryable(result: CapturedProcess): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return result.exitCode === 37
    || text.includes("operation already in progress")
    || text.includes("try again")
    || text.includes("temporarily unavailable");
}

async function withLaunchdOperationLock<T>(callback: () => Promise<T>): Promise<T> {
  const lockParent = dirname(LAUNCHD_OPERATION_LOCK_PATH);
  await mkdir(lockParent, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LAUNCHD_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let acquired = false;
    try {
      await mkdir(LAUNCHD_OPERATION_LOCK_PATH, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      if (await isStaleLaunchdOperationLock()) {
        await rm(LAUNCHD_OPERATION_LOCK_PATH, { recursive: true, force: true });
        continue;
      }
      await delay(250);
      continue;
    }
    try {
      await writeFile(
        join(LAUNCHD_OPERATION_LOCK_PATH, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        { encoding: "utf8", mode: 0o600 },
      );
      return await callback();
    } finally {
      if (acquired) await rm(LAUNCHD_OPERATION_LOCK_PATH, { recursive: true, force: true });
    }
  }
  throw new Error("另一个 Codex LaunchAgent 操作仍在进行，请稍后重试。");
}

async function isStaleLaunchdOperationLock(): Promise<boolean> {
  try {
    const ownerPath = join(LAUNCHD_OPERATION_LOCK_PATH, "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
    const pid = Number(owner.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === "EPERM") return false;
      }
    }
  } catch {
    // The owner file can be between mkdir and write; use the age fallback.
  }
  try {
    const lock = await stat(LAUNCHD_OPERATION_LOCK_PATH);
    return Date.now() - lock.mtimeMs > LAUNCHD_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function waitForLaunchdUnloaded(target: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await launchctl(["print", target]);
    if (result.exitCode !== 0 && isLaunchdNotLoaded(result)) return;
    await delay(250);
  }
  throw new Error(`等待 LaunchAgent 卸载超时：${target}`);
}

async function assertBuiltRuntime(): Promise<void> {
  try {
    await access(join(PROJECT_ROOT, "dist", "main.js"), fsConstants.F_OK);
  } catch {
    throw new Error("尚未找到 dist/main.js，请先执行 pnpm run build");
  }
}

/**
 * launchd does not source .zshrc or nvm.sh. Resolve an actual Node binary
 * instead of putting the shell's transient PATH choice into the plist.
 */
export function resolveLaunchAgentNodePath(
  requestedPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (requestedPath) {
    if (!existsSync(requestedPath)) {
      throw new Error(`指定的 Node 不存在：${requestedPath}`);
    }
    if (!isSupportedNodeExecutable(requestedPath)) {
      throw new Error(`指定的 Node 不满足要求：${requestedPath}（需要 >= ${MIN_NODE_VERSION.join(".")}）`);
    }
    return resolve(requestedPath);
  }
  const nvmDir = environment.NVM_DIR || join(home, ".nvm");
  const exactNvmNode = join(
    nvmDir,
    "versions",
    "node",
    `v${MIN_NODE_VERSION.join(".")}`,
    "bin",
    "node",
  );
  const candidates = uniqueStrings([
    requestedPath,
    environment.CODEX_NODE_PATH,
    isSupportedNodeExecutable(process.execPath) ? process.execPath : undefined,
    exactNvmNode,
    join(home, ".nvm", "versions", "node", `v${MIN_NODE_VERSION.join(".")}`, "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ]);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (isSupportedNodeExecutable(candidate)) return resolve(candidate);
  }
  throw new Error(
    `找不到满足要求的 Node.js >= ${MIN_NODE_VERSION.join(".")}；`
      + `请执行 nvm alias default ${MIN_NODE_VERSION.join(".")}，或使用 --node /path/to/node`,
  );
}

function isSupportedNodeExecutable(path: string): boolean {
  try {
    const version = execFileSync(path, ["-p", "process.versions.node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const numbers = version.replace(/^v/, "").split(".").slice(0, 3).map(Number);
    if (numbers.some((value) => !Number.isInteger(value))) return false;
    return compareVersions(numbers, MIN_NODE_VERSION) >= 0;
  } catch {
    return false;
  }
}

function runCaptured(file: string, args: string[]): Promise<CapturedProcess> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: CapturedProcess): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    let child;
    try {
      child = spawn(file, args, { cwd: PROJECT_ROOT, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ exitCode: 127, stdout: "", stderr: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => finish({ exitCode: 127, stdout, stderr: `${stderr}${String(error)}` }));
    child.once("close", (exitCode) => finish({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function runInherited(file: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(file, args, { cwd, shell: false, stdio: "inherit", env: process.env });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise(exitCode ?? 1));
  });
}

async function readTail(path: string, lineCount: number): Promise<string> {
  try {
    const content = await readFile(path);
    const bytes = content.length > MAX_LOG_BYTES ? content.subarray(content.length - MAX_LOG_BYTES) : content;
    const text = bytes.toString("utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(-lineCount - 1).join("\n").trimEnd();
  } catch (error) {
    return `(无法读取 ${path}：${error instanceof Error ? error.message : String(error)})`;
  }
}

async function printLogTails(
  entries: Array<{ name: string; path: string }>,
  lineCount: number,
): Promise<void> {
  for (const entry of entries) {
    console.log(`===== ${entry.name}: ${entry.path} =====`);
    console.log(await readTail(entry.path, lineCount));
  }
}

async function followLogs(entries: Array<{ name: string; path: string }>): Promise<void> {
  const offsets = new Map<string, number>();
  for (const entry of entries) {
    try {
      const metadata = await stat(entry.path);
      offsets.set(entry.path, metadata.size);
    } catch {
      offsets.set(entry.path, 0);
    }
  }
  let stopped = false;
  const stop = (): void => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      await delay(500);
      for (const entry of entries) {
        let content: Buffer;
        try {
          content = await readFile(entry.path);
        } catch {
          continue;
        }
        const previousOffset = offsets.get(entry.path) ?? 0;
        const offset = content.length < previousOffset ? 0 : previousOffset;
        if (content.length > offset) {
          const delta = content.subarray(offset).toString("utf8");
          for (const line of delta.split(/\r?\n/)) {
            if (line) console.log(`[${entry.name}] ${line}`);
          }
        }
        offsets.set(entry.path, content.length);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function readConfiguredCliPath(configPath: string): Promise<string | undefined> {
  try {
    const config = loadConfig(resolve(configPath));
    return config.codex.cliPath;
  } catch {
    return undefined;
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function compareVersions(left: number[], right: readonly number[]): number {
  for (let index = 0; index < right.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  runCodexCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
