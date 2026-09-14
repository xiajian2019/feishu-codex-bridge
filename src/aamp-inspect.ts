import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AampInspectOptions {
  metadataDir: string;
  taskDir: string;
  logDir?: string;
  stateHome?: string;
}

export interface AampTaskEvent {
  at?: string;
  type: string;
  status?: string;
  runDir: string;
  detail?: string;
}

export interface AampTaskRecord {
  taskId: string;
  title?: string;
  status: string;
  projectName?: string;
  repositoryRoot?: string;
  taskFile?: string;
  worktreePath?: string;
  branch?: string;
  baseRef?: string;
  baseSha?: string;
  dirtyBase?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastEventAt?: string;
  latestEvent?: string;
  metadataFile?: string;
  metadataExecution?: Record<string, unknown>;
  taskFileExists: boolean;
  worktreeExists: boolean;
  worktreeHead?: string;
  worktreeStatus?: "clean" | "modified" | "unavailable";
  worktreeChanges?: string[];
  logRunDirs: string[];
  stateFiles: string[];
  userMessageText?: string;
  outputText?: string;
  toolTraceText?: string;
  events: AampTaskEvent[];
}

export interface AampInspectionSnapshot {
  generatedAt: string;
  metadataDir: string;
  taskDir: string;
  logDir: string;
  stateHome: string;
  tasks: AampTaskRecord[];
  runErrors: Array<{ at?: string; runDir: string; message: string }>;
}

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_TASK_TEXT = 8_000;
const MAX_RECENT_MESSAGE = 1_200;

export function collectAampTasks(options: AampInspectOptions): AampInspectionSnapshot {
  const metadataDir = resolve(options.metadataDir);
  const taskDir = resolve(options.taskDir);
  const logDir = resolve(options.logDir || process.env.AAMP_LOG_DIR || join(homedir(), ".aamp", "logs"));
  const stateHome = resolve(options.stateHome || process.env.AAMP_TASK_STATE_HOME || join(homedir(), ".aamp", "feishu-task-agent"));
  const records = new Map<string, AampTaskRecord>();
  const runErrors: AampInspectionSnapshot["runErrors"] = [];

  readMetadataRecords(records, metadataDir, taskDir);
  readAampRunLogs(records, runErrors, logDir);
  readAampState(records, stateHome, taskDir);

  const tasks = [...records.values()]
    .map((record) => finalizeRecord(record, taskDir))
    .sort(compareRecentTasks);
  return {
    generatedAt: new Date().toISOString(),
    metadataDir,
    taskDir,
    logDir,
    stateHome,
    tasks,
    runErrors,
  };
}

export function findAampTask(
  snapshot: AampInspectionSnapshot,
  selector: string,
): AampTaskRecord {
  const normalized = selector.trim();
  if (!normalized) throw new Error("task id or prefix is required");
  const matches = snapshot.tasks.filter((task) => task.taskId === normalized || task.taskId.startsWith(normalized));
  if (matches.length === 0) throw new Error(`AAMP task not found: ${normalized}`);
  if (matches.length > 1) {
    throw new Error(`AAMP task selector is ambiguous: ${normalized}; matches: ${matches.map((task) => task.taskId).join(", ")}`);
  }
  return matches[0];
}

export function formatAampRecent(
  snapshot: AampInspectionSnapshot,
  limit: number,
  options: { fullMessage?: boolean } = {},
): string {
  const tasks = snapshot.tasks.slice(0, limit);
  const lines = [
    `AAMP 最近任务（${tasks.length}/${snapshot.tasks.length}）`,
    `日志：${snapshot.logDir}`,
    `任务元数据：${snapshot.metadataDir}`,
    "",
  ];
  if (tasks.length === 0) {
    lines.push("没有发现任务。映射任务执行后会在这里留下任务文件和 worktree 元数据。");
    return lines.join("\n");
  }
  for (const [index, task] of tasks.entries()) {
    lines.push(`${index + 1}. [${task.status}] ${task.taskId}`);
    lines.push(`   标题：${task.title || "(unknown)"}`);
    if (task.projectName) lines.push(`   项目：${task.projectName}`);
    if (task.repositoryRoot) lines.push(`   仓库：${task.repositoryRoot}`);
    if (task.branch) lines.push(`   分支：${task.branch}`);
    if (task.worktreePath) lines.push(`   worktree：${task.worktreePath}${task.worktreeExists ? "" : " [不存在]"}`);
    if (task.worktreeStatus && task.worktreeStatus !== "unavailable") {
      lines.push(`   Git：${task.worktreeStatus === "clean" ? "clean" : `modified (${task.worktreeChanges?.length || 0})`}${task.worktreeHead ? ` @ ${task.worktreeHead}` : ""}`);
    }
    if (task.userMessageText) {
      lines.push(...formatRecentMessage(task, options.fullMessage === true));
    }
    if (task.lastEventAt) lines.push(`   最近事件：${task.lastEventAt} ${task.latestEvent || ""}`.trimEnd());
    if (task.logRunDirs.length > 0) lines.push(`   日志：${task.logRunDirs.at(-1)}`);
    lines.push("");
  }
  if (snapshot.runErrors.length > 0) {
    lines.push(`最近 run 错误：${snapshot.runErrors.length} 条（详情用 aamp task <id> 或查看日志）`);
  }
  return lines.join("\n").trimEnd();
}

function formatRecentMessage(task: AampTaskRecord, fullMessage: boolean): string[] {
  const message = task.userMessageText?.trim();
  if (!message) return [];
  const visible = fullMessage || message.length <= MAX_RECENT_MESSAGE
    ? message
    : `${message.slice(0, MAX_RECENT_MESSAGE)}…`;
  const lines = [
    `   原始消息${visible.length < message.length ? "（截取）" : ""}：`,
    ...visible.split(/\r?\n/).map((line) => `      ${line}`),
  ];
  if (visible.length < message.length) {
    lines.push(`      （消息较长，使用 aamp:task ${task.taskId} 查看完整内容）`);
  }
  return lines;
}

export function formatAampTask(task: AampTaskRecord): string {
  const lines = [
    `AAMP 任务：${task.taskId}`,
    `状态：${task.status}`,
    `标题：${task.title || "(unknown)"}`,
    `项目：${task.projectName || "(未解析)"}`,
    `仓库：${task.repositoryRoot || "(未解析)"}`,
    `任务文件：${task.taskFile || "(未生成)"}${task.taskFileExists ? "" : " [不存在]"}`,
    `分支：${task.branch || "(未生成)"}`,
    `worktree：${task.worktreePath || "(未生成)"}${task.worktreeExists ? "" : " [不存在]"}`,
    `Git：${formatWorktreeGitState(task)}`,
    `基线：${task.baseRef || "(unknown)"}${task.baseSha ? ` (${task.baseSha})` : ""}`,
    `源仓库有未提交修改：${task.dirtyBase === undefined ? "unknown" : task.dirtyBase ? "是" : "否"}`,
    `创建时间：${task.createdAt || "(unknown)"}`,
    `最近事件：${task.lastEventAt || "(unknown)"} ${task.latestEvent || ""}`.trimEnd(),
    `元数据：${task.metadataFile || "(未生成)"}`,
    "",
    `日志目录（${task.logRunDirs.length}）：`,
    ...(task.logRunDirs.length > 0 ? task.logRunDirs.map((path) => `  ${path}`) : ["  (无)"]),
    "",
    `事件（${task.events.length}）：`,
    ...(task.events.length > 0
      ? task.events.map((event) => `  ${event.at || "?"} ${event.type}${event.status ? ` [${event.status}]` : ""}${event.detail ? ` — ${event.detail}` : ""}`)
      : ["  (无)"]),
  ];
  if (task.userMessageText) {
    lines.push("", "用户消息：", task.userMessageText);
  }
  if (task.outputText) {
    lines.push("", "输出摘要：", task.outputText);
  }
  if (task.toolTraceText) {
    lines.push("", "工具轨迹摘要：", task.toolTraceText);
  }
  if (task.worktreeChanges && task.worktreeChanges.length > 0) {
    lines.push("", `worktree 改动文件（${task.worktreeChanges.length}）：`, ...task.worktreeChanges.map((path) => `  ${path}`));
  }
  return lines.join("\n");
}

function newRecord(taskId: string): AampTaskRecord {
  return {
    taskId,
    status: "UNKNOWN",
    taskFileExists: false,
    worktreeExists: false,
    logRunDirs: [],
    stateFiles: [],
    events: [],
  };
}

function recordFor(records: Map<string, AampTaskRecord>, taskId: unknown): AampTaskRecord | undefined {
  if (typeof taskId !== "string" || !taskId.trim()) return undefined;
  const normalized = taskId.trim();
  const existing = records.get(normalized);
  if (existing) return existing;
  const created = newRecord(normalized);
  records.set(normalized, created);
  return created;
}

function readMetadataRecords(
  records: Map<string, AampTaskRecord>,
  metadataDir: string,
  taskDir: string,
): void {
  for (const fileName of directoryFiles(metadataDir, ".json")) {
    const filePath = join(metadataDir, fileName);
    const metadata = readJson(filePath);
    const record = recordFor(records, metadata?.taskId);
    if (!record) continue;
    record.metadataFile = filePath;
    record.title = stringValue(metadata?.title) || record.title;
    record.projectName = stringValue(metadata?.projectName) || record.projectName;
    record.repositoryRoot = stringValue(metadata?.repositoryRoot) || record.repositoryRoot;
    record.taskFile = stringValue(metadata?.taskFile) || record.taskFile;
    record.worktreePath = stringValue(metadata?.worktreePath) || record.worktreePath;
    record.branch = stringValue(metadata?.branch) || record.branch;
    record.baseRef = stringValue(metadata?.baseRef) || record.baseRef;
    record.baseSha = stringValue(metadata?.baseSha) || record.baseSha;
    record.dirtyBase = booleanValue(metadata?.dirtyBase) ?? record.dirtyBase;
    record.createdAt = stringValue(metadata?.createdAt) || record.createdAt;
    record.metadataExecution = objectValue(metadata?.execution) || record.metadataExecution;
    const executionStatus = normalizeStatus(stringValue(record.metadataExecution?.status));
    if (executionStatus) record.status = executionStatus;
    if (!record.taskFile && record.projectName) {
      record.taskFile = findTaskFile(taskDir, record.taskId, record.projectName);
    }
  }
}

function readAampRunLogs(
  records: Map<string, AampTaskRecord>,
  runErrors: AampInspectionSnapshot["runErrors"],
  logDir: string,
): void {
  const runsDir = join(logDir, "runs");
  for (const runName of directoryEntries(runsDir).sort()) {
    const runDir = join(runsDir, runName);
    const manifest = readJson(join(runDir, "manifest.json"));
    const acpFiles = directoryFiles(runDir, "acp-bridge-").filter((name) => name.endsWith(".jsonl"));
    for (const fileName of acpFiles) {
      for (const line of readLines(join(runDir, fileName))) {
        applyLogLine(records, line, runDir);
      }
    }
    for (const line of readLines(join(runDir, "errors.jsonl"))) {
      const error = parseJsonLine(line);
      if (!error) continue;
      const taskId = stringValue(error.taskId);
      const message = stringValue(error.message) || line.trim();
      if (taskId) {
        const record = recordFor(records, taskId);
        if (record) addEvent(record, {
          at: stringValue(error.timestamp),
          type: "run.error",
          status: "ERROR",
          runDir,
          detail: message,
        });
      } else if (message) {
        runErrors.push({ at: stringValue(error.timestamp), runDir, message });
      }
    }
    if (manifest) {
      const manifestError = stringValue(manifest.error);
      if (manifestError) runErrors.push({ at: stringValue(manifest.started_at), runDir, message: manifestError });
    }
  }
}

function applyLogLine(
  records: Map<string, AampTaskRecord>,
  line: string,
  runDir: string,
): void {
  const parsed = parseJsonLine(line);
  if (parsed) {
    const type = stringValue(parsed.type);
    const taskId = stringValue(parsed.taskId);
    if (!type || !taskId || !type.startsWith("task.")) return;
    const record = recordFor(records, taskId);
    if (!record) return;
    record.title = stringValue(parsed.title) || record.title;
    const status = stringValue(parsed.status);
    const normalizedStatus = normalizeStatus(status || statusForEvent(type));
    if (normalizedStatus) record.status = normalizedStatus;
    addEvent(record, {
      at: stringValue(parsed.timestamp),
      type,
      status: normalizedStatus,
      runDir,
    });
    return;
  }

  const ready = /AAMP task worktree ready:\s+task=([^\s]+)\s+branch=([^\s]+)\s+cwd=(\S+)/.exec(line);
  if (ready) {
    const record = recordFor(records, ready[1]);
    if (record) {
      record.branch = ready[2];
      record.worktreePath = ready[3];
      record.status = record.status === "UNKNOWN" ? "RUNNING" : record.status;
      addEvent(record, { type: "worktree.ready", runDir, detail: `branch=${ready[2]} cwd=${ready[3]}` });
    }
    return;
  }
  const dispatch = /task\.dispatch\s+([^\s]+)\s+"([^"]*)"/.exec(line);
  if (dispatch) {
    const record = recordFor(records, dispatch[1]);
    if (record) {
      record.title = record.title || dispatch[2];
      if (record.status === "UNKNOWN") record.status = "DISPATCHED";
      addEvent(record, { type: "task.dispatch", runDir });
    }
    return;
  }
  const result = /->\s+task\.(result|help_needed|cancel|rejected)\s+([^\s]+)(?:\s+([^\s]+))?/.exec(line);
  if (result) {
    const record = recordFor(records, result[2]);
    if (record) {
      const status = normalizeStatus(result[1] === "result" ? (result[3] || "completed") : statusForEvent(`task.${result[1]}`));
      record.status = status || record.status;
      addEvent(record, { type: `task.${result[1]}`, status, runDir });
    }
  }
}

function readAampState(
  records: Map<string, AampTaskRecord>,
  stateHome: string,
  taskDir: string,
): void {
  const runtimeHome = join(stateHome, "runtime-v1");
  for (const statePath of findFilesNamed(runtimeHome, "state.json")) {
    const state = readJson(statePath);
    const tasks = objectValue(state?.tasks);
    if (!tasks) continue;
    for (const value of Object.values(tasks)) {
      const task = objectValue(value);
      const record = recordFor(records, task?.taskId);
      if (!record) continue;
      record.stateFiles.push(statePath);
      record.title = stringValue(task?.title) || record.title;
      const stateStatus = normalizeStateStatus(stringValue(task?.status));
      record.status = stateStatus || record.status;
      record.updatedAt = stringValue(task?.updatedAt) || record.updatedAt;
      record.createdAt = stringValue(task?.createdAt) || record.createdAt;
      record.userMessageText = truncate(stringValue(task?.userMessageText));
      record.outputText = truncate(stringValue(task?.outputText));
      record.toolTraceText = truncate(stringValue(task?.toolTraceText), 4_000);
      addEvent(record, {
        at: record.updatedAt,
        type: `state.${stateStatus || record.status}`,
        status: stateStatus,
        runDir: statePath,
      });
      if (!record.taskFile) record.taskFile = findTaskFile(taskDir, record.taskId, record.projectName);
    }
  }
}

function finalizeRecord(record: AampTaskRecord, taskDir: string): AampTaskRecord {
  record.taskFile = record.taskFile || findTaskFile(taskDir, record.taskId, record.projectName);
  record.taskFileExists = Boolean(record.taskFile && existsSync(record.taskFile));
  record.worktreeExists = Boolean(record.worktreePath && existsSync(record.worktreePath));
  readWorktreeGitState(record);
  record.events.sort((left, right) => (left.at || "").localeCompare(right.at || ""));
  const latest = record.events.at(-1);
  record.lastEventAt = latest?.at || record.updatedAt || record.createdAt;
  record.latestEvent = latest?.type;
  const latestStatus = normalizeStatus(latest?.status || (latest ? statusForEvent(latest.type) : undefined));
  if (latestStatus) record.status = latestStatus;
  if (record.status === "UNKNOWN" && record.events.length > 0) record.status = "DISPATCHED";
  if (record.status === "DISPATCHED" && record.events.some((event) => event.type === "worktree.ready")) {
    record.status = "RUNNING";
  }
  return record;
}

function readWorktreeGitState(record: AampTaskRecord): void {
  if (!record.worktreePath || !record.worktreeExists) {
    record.worktreeStatus = "unavailable";
    return;
  }
  try {
    record.worktreeHead = execFileSync("git", ["-C", record.worktreePath, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["-C", record.worktreePath, "status", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    record.worktreeChanges = status ? status.split(/\r?\n/).filter(Boolean) : [];
    record.worktreeStatus = record.worktreeChanges.length > 0 ? "modified" : "clean";
  } catch {
    record.worktreeStatus = "unavailable";
  }
}

function formatWorktreeGitState(task: AampTaskRecord): string {
  if (task.worktreeStatus === "unavailable") return "unavailable";
  if (!task.worktreeStatus) return "unknown";
  const changes = task.worktreeChanges?.length || 0;
  return `${task.worktreeStatus}${changes > 0 ? ` (${changes} files)` : ""}${task.worktreeHead ? ` @ ${task.worktreeHead}` : ""}`;
}

function addEvent(record: AampTaskRecord, event: AampTaskEvent): void {
  const duplicate = record.events.some((existing) => existing.at === event.at
    && existing.type === event.type
    && existing.runDir === event.runDir);
  if (!duplicate) record.events.push(event);
  if (!record.logRunDirs.includes(event.runDir) && event.runDir.includes(`${join("logs", "runs")}`)) {
    record.logRunDirs.push(event.runDir);
  } else if (!record.logRunDirs.includes(event.runDir) && event.type.startsWith("task.")) {
    record.logRunDirs.push(event.runDir);
  }
}

function compareRecentTasks(left: AampTaskRecord, right: AampTaskRecord): number {
  return (right.lastEventAt || right.updatedAt || right.createdAt || "")
    .localeCompare(left.lastEventAt || left.updatedAt || left.createdAt || "");
}

function statusForEvent(type: string): string | undefined {
  switch (type) {
    case "task.received":
    case "task.dispatch":
      return "DISPATCHED";
    case "task.completed":
    case "task.result":
      return "COMPLETED";
    case "task.help_needed":
      return "HELP_NEEDED";
    case "task.cancel":
      return "CANCELED";
    case "task.rejected":
      return "REJECTED";
    default:
      return undefined;
  }
}

function findTaskFile(taskDir: string, taskId: string, projectName?: string): string | undefined {
  const prefix = projectName ? `aamp-${safeName(projectName)}-` : "aamp-";
  return directoryFiles(taskDir, ".md")
    .map((fileName) => join(taskDir, fileName))
    .find((filePath) => filePath.includes(`${prefix}${safeName(taskId)}-`));
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function directoryEntries(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function directoryFiles(directory: string, suffixOrPrefix: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && (suffixOrPrefix.startsWith(".") ? entry.name.endsWith(suffixOrPrefix) : entry.name.startsWith(suffixOrPrefix)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function findFilesNamed(directory: string, fileName: string): string[] {
  const found: string[] = [];
  try {
    if (statSync(directory).isFile()) {
      if (directory.endsWith(`/${fileName}`)) found.push(directory);
      return found;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isFile() && entry.name === fileName) found.push(entryPath);
      else if (entry.isDirectory()) found.push(...findFilesNamed(entryPath, fileName));
    }
  } catch {
    // Directory disappeared during inspection.
  }
  return found;
}

function normalizeStateStatus(value: string | undefined): string | undefined {
  return normalizeStatus(value);
}

function normalizeStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}

function readLines(filePath: string): string[] {
  try {
    const file = statSync(filePath);
    if (!file.isFile() || file.size > MAX_LOG_BYTES) return [];
    return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncate(value: string | undefined, limit = MAX_TASK_TEXT): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}
