import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getBunRuntime } from "./bun-runtime.js";
import { findExecutableInPath } from "./runtime-env.js";

export type TmuxResurrectAction = "save" | "restore";

export interface TmuxResurrectSessionSnapshot {
  sessionName: string;
  savedAt: string;
}

export interface TmuxResurrectPendingRestoreResult {
  restored: string[];
  failures: Array<{ sessionName: string; error: string }>;
}

export interface TmuxResurrectStatus {
  installed: boolean;
  configured: boolean;
  automaticSave: boolean;
  /** Global continuum restore is deliberately disabled; Bridge restores per Session. */
  automaticRestore: boolean;
  perSessionRestore: boolean;
  automaticStart: boolean;
  pluginDirectory: string;
  saveDirectory: string;
  sessionSnapshotDirectory: string;
  configPath: string | null;
  lastSnapshotAt: string | null;
}

export interface TmuxResurrectSessionActionResult {
  action: TmuxResurrectAction;
  sessionName: string;
  snapshot: TmuxResurrectSessionSnapshot;
  output: string;
}

export interface TmuxResurrectController {
  status(): TmuxResurrectStatus;
  saveSession(sessionName: string): Promise<TmuxResurrectSessionActionResult>;
  restoreSession(sessionName: string): Promise<TmuxResurrectSessionActionResult>;
  restorePendingSessions(activeSessionNames: string[], liveSessionNames: string[]): Promise<TmuxResurrectPendingRestoreResult>;
  snapshotForSession(sessionName: string): TmuxResurrectSessionSnapshot | null;
  disableSession(sessionName: string): void;
}

export class TmuxResurrectUnavailableError extends Error {
  constructor() {
    super("tmux-resurrect 尚未安装，请先运行 bun run tmux:setup。");
    this.name = "TmuxResurrectUnavailableError";
  }
}

const DEFAULT_PLUGIN_ROOT = join(homedir(), ".tmux", "plugins");
const CONFIG_FRAGMENT_NAME = "feishu-codex-bridge-resurrect.conf";
const MANAGED_CONFIG_MARKER = "FEISHU_CODEX_BRIDGE_TMUX_RESURRECT";
const SESSION_SNAPSHOT_DIRECTORY_NAME = "bridge-sessions";

let sessionActionQueue: Promise<unknown> = Promise.resolve();

function withSessionActionLock<T>(action: () => Promise<T>): Promise<T> {
  const next = sessionActionQueue.then(action, action);
  sessionActionQueue = next.then(() => undefined, () => undefined);
  return next;
}

function expandPath(value: string): string {
  return resolve(value.trim().replace(/^~(?=\/|$)/, homedir()));
}

function defaultSaveDirectory(): string {
  const traditionalDirectory = join(homedir(), ".tmux", "resurrect");
  if (existsSync(traditionalDirectory)) return traditionalDirectory;
  const dataHome = process.env.XDG_DATA_HOME?.trim()
    ? expandPath(process.env.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  return join(dataHome, "tmux", "resurrect");
}

export function tmuxResurrectPluginDirectory(): string {
  const explicit = process.env.TMUX_RESURRECT_PLUGIN_DIR?.trim();
  if (explicit) return expandPath(explicit);
  const pluginRoot = process.env.TMUX_PLUGIN_MANAGER_PATH?.trim();
  return join(pluginRoot ? expandPath(pluginRoot) : DEFAULT_PLUGIN_ROOT, "tmux-resurrect");
}

function configCandidates(): string[] {
  const explicit = process.env.TMUX_CONFIG_PATH?.trim();
  return [...new Set([
    explicit ? expandPath(explicit) : null,
    join(process.env.XDG_CONFIG_HOME ? expandPath(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config"), "tmux", "tmux.conf"),
    join(homedir(), ".tmux.conf"),
  ].filter((path): path is string => Boolean(path)))];
}

function readConfigText(): { path: string | null } {
  for (const path of configCandidates()) {
    if (!existsSync(path)) continue;
    try {
      readFileSync(path, "utf8");
      return { path };
    } catch {
      // A readable config is useful for status only; plugin execution remains independent.
    }
  }
  return { path: null };
}

function readConfiguredSaveDirectory(configText: string): string {
  const match = /@resurrect-dir\s+['"]([^'"\r\n]+)['"]/.exec(configText);
  if (!match?.[1]) return defaultSaveDirectory();
  return expandPath(match[1].replace(/\$HOME\b/g, homedir()));
}

function optionIsOn(configText: string, option: string): boolean {
  return new RegExp(`${option}\\s+['"]?on['"]?`).test(configText);
}

function optionIsPositiveInteger(configText: string, option: string): boolean {
  const match = new RegExp(`${option}\\s+['"]?(\\d+)['"]?`).exec(configText);
  return Boolean(match && Number(match[1]) > 0);
}

function configFragmentPath(configPath: string | null): string {
  return join(resolve(configPath ? join(configPath, "..") : join(homedir(), ".config", "tmux")), CONFIG_FRAGMENT_NAME);
}

function readAllConfigText(configPath: string | null): string {
  const paths = [configPath, configFragmentPath(configPath)].filter((path): path is string => Boolean(path));
  return paths.map((path) => {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
  }).join("\n");
}

function snapshotDirectoryForSession(saveDirectory: string, sessionName: string): string {
  const key = createHash("sha256").update(sessionName, "utf8").digest("hex").slice(0, 32);
  return join(saveDirectory, SESSION_SNAPSHOT_DIRECTORY_NAME, key);
}

function snapshotFileForSession(saveDirectory: string, sessionName: string): string {
  return join(snapshotDirectoryForSession(saveDirectory, sessionName), "snapshot.txt");
}

function disabledFileForSession(saveDirectory: string, sessionName: string): string {
  return join(snapshotDirectoryForSession(saveDirectory, sessionName), "disabled");
}

function readLastGlobalSnapshot(saveDirectory: string): { path: string; mtimeMs: number } | null {
  const last = join(saveDirectory, "last");
  if (!existsSync(last)) return null;
  try {
    return { path: realpathSync(last), mtimeMs: statSync(last).mtimeMs };
  } catch {
    return null;
  }
}

function snapshotForSessionInDirectory(saveDirectory: string, sessionName: string): TmuxResurrectSessionSnapshot | null {
  if (existsSync(disabledFileForSession(saveDirectory, sessionName))) return null;
  const snapshotPath = snapshotFileForSession(saveDirectory, sessionName);
  if (!existsSync(snapshotPath)) return null;
  try {
    return { sessionName, savedAt: statSync(snapshotPath).mtime.toISOString() };
  } catch {
    return null;
  }
}

function filterSnapshotForSession(sourcePath: string, sessionName: string): string {
  const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = lines.filter((line) => {
    const [kind, savedSessionName] = line.split("\t", 3);
    return (kind === "pane" || kind === "window") && savedSessionName === sessionName;
  });
  return selected.length > 0 ? `${selected.join("\n")}\n` : "";
}

function writeSessionSnapshot(
  saveDirectory: string, sessionName: string, sourcePath: string, replaceDisabled = false,
): TmuxResurrectSessionSnapshot | null {
  const disabled = disabledFileForSession(saveDirectory, sessionName);
  if (!replaceDisabled && existsSync(disabled)) return null;
  const content = filterSnapshotForSession(sourcePath, sessionName);
  if (!content) return null;
  const directory = snapshotDirectoryForSession(saveDirectory, sessionName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `snapshot.${process.pid}.tmp`);
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, snapshotFileForSession(saveDirectory, sessionName));
  const lastPath = join(directory, "last");
  try { unlinkSync(lastPath); } catch { /* The first snapshot has no link yet. */ }
  symlinkSync("snapshot.txt", lastPath);
  // A deliberate save of a running, newly created same-name Session replaces
  // the termination marker only after its own snapshot is safely in place.
  if (replaceDisabled && existsSync(disabled)) unlinkSync(disabled);
  return snapshotForSessionInDirectory(saveDirectory, sessionName);
}

const RESURRECT_COMMAND_TIMEOUT_MS = 30_000;

async function runProcess(
  command: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = RESURRECT_COMMAND_TIMEOUT_MS,
): Promise<{ output: string; exitCode: number }> {
  const child = getBunRuntime().spawn(command, {
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    child.stdout?.text() ?? Promise.resolve(""),
    child.stderr?.text() ?? Promise.resolve(""),
    child.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      output,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { if (!child.killed) child.kill("SIGKILL"); } catch { /* process may have exited */ }
          reject(new Error(`tmux-resurrect 命令执行超时（${timeoutMs}ms）：${command[0] ?? "command"}`));
        }, timeoutMs);
      }),
    ]);
    const [stdout, stderr, exitCode] = result;
    return { output: `${stdout}\n${stderr}`.trim().slice(-4_000), exitCode };
  } finally {
    clearTimeout(timer);
  }
}

async function runTmux(args: string[], allowFailure = false): Promise<string> {
  const result = await runProcess(["tmux", ...args]);
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(result.output || `tmux ${args[0] ?? "command"} failed with exit code ${result.exitCode}.`);
  }
  return result.output;
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  return (await runProcess(["tmux", "has-session", "-t", `=${sessionName}`])).exitCode === 0;
}

// tmux-resurrect normally uses a global directory, enumerates every Session,
// switches the current client, and may kill Session 0 when restoring. Keep the
// plugin and its process strategies, while scoping those operations to the
// selected Session and a private temporary directory.
const SCOPED_TMUX_WRAPPER = `#!/bin/bash
if [ "$1" = show-option ] && [ "$2" = -gqv ]; then
  case "$3" in
    @resurrect-dir) printf '%s\\n' "$BRIDGE_RESURRECT_DIR"; exit 0 ;;
    @resurrect-never-overwrite) printf '%s\\n' on; exit 0 ;;
  esac
fi
if [ -n "$BRIDGE_SAVE_TARGET" ] && [ "$2" = -a ]; then
  case "$1" in
    list-panes|list-windows) command="$1"; shift 2; exec "$BRIDGE_REAL_TMUX" "$command" -t "$BRIDGE_SAVE_TARGET" "$@" ;;
  esac
fi
if [ "$BRIDGE_RESTORE" = 1 ]; then
  if [ "$1" = switch-client ]; then exit 0; fi
  if [ "$1" = select-pane ] && [ "$2" = -t ]; then
    case "$3" in *[!0-9]*|'') ;; *) exit 0 ;; esac
  fi
fi
if [ "$1" = -S ] && [ -z "$2" ]; then shift 2; fi
exec "$BRIDGE_REAL_TMUX" "$@"
`;

function temporaryDirectory(prefix: string): string {
  // Upstream restore.sh does not quote its snapshot path. Prefer /tmp so an
  // install root or TMPDIR containing spaces cannot break its input handling.
  const base = existsSync("/tmp") ? "/tmp" : tmpdir();
  if (/\s/.test(base)) throw new Error("临时目录路径包含空格，无法安全调用 tmux-resurrect。 ");
  return mkdtempSync(join(base, prefix));
}

async function withScopedTmux<T>(directory: string, target: string, restore: boolean, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const realTmux = findExecutableInPath("tmux", process.env.PATH);
  if (!realTmux) throw new TmuxResurrectUnavailableError();
  const wrapperDirectory = temporaryDirectory("bridge-tmux-wrapper-");
  const wrapper = join(wrapperDirectory, "tmux");
  writeFileSync(wrapper, SCOPED_TMUX_WRAPPER, { encoding: "utf8", mode: 0o700 });
  try {
    return await action({
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      BRIDGE_REAL_TMUX: resolve(realTmux), BRIDGE_RESURRECT_DIR: directory,
      BRIDGE_SAVE_TARGET: target, BRIDGE_RESTORE: restore ? "1" : "0",
    });
  } finally { rmSync(wrapperDirectory, { recursive: true, force: true }); }
}

async function runRestoreScript(pluginDirectory: string, snapshotDirectory: string, sessionName: string): Promise<string> {
  const temp = temporaryDirectory("bridge-tmux-restore-");
  try {
    const source = join(snapshotDirectory, "snapshot.txt");
    const content = filterSnapshotForSession(source, sessionName);
    if (!content || !content.split("\n").some((line) => line.startsWith(`pane\t${sessionName}\t`))) {
      throw new Error(`Session「${sessionName}」的快照无效。`);
    }
    writeFileSync(join(temp, "snapshot.txt"), content, { encoding: "utf8", mode: 0o600 });
    symlinkSync("snapshot.txt", join(temp, "last"));
    const archive = join(snapshotDirectory, "pane_contents.tar.gz");
    if (existsSync(archive)) copyFileSync(archive, join(temp, "pane_contents.tar.gz"));
    const result = await withScopedTmux(temp, "", true, (env) => runProcess(["bash", join(pluginDirectory, "scripts", "restore.sh")], env));
    if (result.exitCode !== 0) throw new Error(result.output || `tmux-resurrect restore failed with exit code ${result.exitCode}.`);
    if (!(await tmuxSessionExists(sessionName))) throw new Error(`快照已执行，但未找到 Session「${sessionName}」。`);
    // Upstream changes the active client to select panes. Apply the saved
    // selections with explicit targets so other attached clients stay put.
    for (const line of content.split("\n")) {
      const fields = line.split("\t");
      if (fields[0] === "pane" && fields.length > 8 && fields[8] === "1") {
        await runTmux(["select-pane", "-t", `${sessionName}:${fields[2]}.${fields[5]}`]);
      } else if (fields[0] === "window" && fields.length > 4 && fields[4] === "1") {
        await runTmux(["select-window", "-t", `${sessionName}:${fields[2]}`]);
      }
    }
    return result.output;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function configuredStatus(): { configPath: string | null; configText: string; saveDirectory: string } {
  const { path: configPath } = readConfigText();
  const configText = readAllConfigText(configPath);
  return { configPath, configText, saveDirectory: readConfiguredSaveDirectory(configText) };
}

export function getTmuxResurrectStatus(): TmuxResurrectStatus {
  const pluginDirectory = tmuxResurrectPluginDirectory();
  const { configPath, configText, saveDirectory } = configuredStatus();
  const lastSnapshot = readLastGlobalSnapshot(saveDirectory);
  return {
    installed: existsSync(join(pluginDirectory, "scripts", "save.sh"))
      && existsSync(join(pluginDirectory, "scripts", "restore.sh")),
    configured: configText.includes(MANAGED_CONFIG_MARKER)
      && configText.includes("tmux-plugins/tmux-continuum")
      && optionIsPositiveInteger(configText, "@continuum-save-interval"),
    automaticSave: optionIsPositiveInteger(configText, "@continuum-save-interval"),
    automaticRestore: optionIsOn(configText, "@continuum-restore"),
    perSessionRestore: configText.includes(MANAGED_CONFIG_MARKER),
    automaticStart: optionIsOn(configText, "@continuum-boot"),
    pluginDirectory,
    saveDirectory,
    sessionSnapshotDirectory: join(saveDirectory, SESSION_SNAPSHOT_DIRECTORY_NAME),
    configPath,
    lastSnapshotAt: lastSnapshot ? new Date(lastSnapshot.mtimeMs).toISOString() : null,
  };
}

function ensureInstalled(status: TmuxResurrectStatus): void {
  if (!status.installed) throw new TmuxResurrectUnavailableError();
}

function ensureSnapshotFromGlobal(status: TmuxResurrectStatus, sessionName: string): TmuxResurrectSessionSnapshot | null {
  const current = snapshotForSessionInDirectory(status.saveDirectory, sessionName);
  const globalSnapshot = readLastGlobalSnapshot(status.saveDirectory);
  if (!globalSnapshot) return current;
  if (current) {
    const currentPath = snapshotFileForSession(status.saveDirectory, sessionName);
    if (statSync(currentPath).mtimeMs >= globalSnapshot.mtimeMs) return current;
  }
  return writeSessionSnapshot(status.saveDirectory, sessionName, globalSnapshot.path);
}

function statusForDirectory(saveDirectory?: string): TmuxResurrectStatus {
  const status = getTmuxResurrectStatus();
  return saveDirectory ? { ...status, saveDirectory, sessionSnapshotDirectory: join(saveDirectory, SESSION_SNAPSHOT_DIRECTORY_NAME) } : status;
}

async function saveSession(sessionName: string, saveDirectory?: string): Promise<TmuxResurrectSessionActionResult> {
  const status = statusForDirectory(saveDirectory);
  ensureInstalled(status);
  const grouped = await runTmux(["display-message", "-p", "-t", `${sessionName}:`, "#{session_grouped}"]);
  if (grouped === "1") throw new Error("暂不支持保存 tmux grouped Session。 ");
  const temp = temporaryDirectory("bridge-tmux-save-");
  try {
    const saveResult = await withScopedTmux(temp, sessionName, false,
      (env) => runProcess(["bash", join(status.pluginDirectory, "scripts", "save.sh"), "quiet"], env));
    if (saveResult.exitCode !== 0) throw new Error(saveResult.output || `tmux-resurrect save failed with exit code ${saveResult.exitCode}.`);
    const source = join(temp, "last");
    if (!existsSync(source)) throw new Error("tmux-resurrect 没有生成快照。 ");
    const filtered = filterSnapshotForSession(source, sessionName);
    if (!filtered.split("\n").some((line) => line.startsWith(`pane\t${sessionName}\t`))) {
      throw new Error(`当前 Session「${sessionName}」没有可保存的 tmux 快照。`);
    }
    const snapshot = writeSessionSnapshot(status.saveDirectory, sessionName, source, true);
    if (!snapshot) throw new Error(`当前 Session「${sessionName}」没有可保存的 tmux 快照。`);
    const directory = snapshotDirectoryForSession(status.saveDirectory, sessionName);
    const archive = join(temp, "pane_contents.tar.gz");
    const storedArchive = join(directory, "pane_contents.tar.gz");
    if (existsSync(archive)) {
      const temporaryArchive = `${storedArchive}.${process.pid}.tmp`;
      copyFileSync(archive, temporaryArchive);
      chmodSync(temporaryArchive, 0o600);
      renameSync(temporaryArchive, storedArchive);
    } else if (existsSync(storedArchive)) unlinkSync(storedArchive);
    return { action: "save", sessionName, snapshot, output: saveResult.output };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function restoreSession(sessionName: string, saveDirectory?: string): Promise<TmuxResurrectSessionActionResult> {
  const status = statusForDirectory(saveDirectory);
  ensureInstalled(status);
  if (await tmuxSessionExists(sessionName)) {
    throw new Error(`Session「${sessionName}」仍在运行，请直接打开它；恢复只针对不存在的 Session。`);
  }
  const snapshot = snapshotForSessionInDirectory(status.saveDirectory, sessionName) ?? ensureSnapshotFromGlobal(status, sessionName);
  if (!snapshot) throw new Error(`没有找到 Session「${sessionName}」的快照。`);
  const output = await runRestoreScript(status.pluginDirectory, snapshotDirectoryForSession(status.saveDirectory, sessionName), sessionName);
  return { action: "restore", sessionName, snapshot, output };
}

async function restorePendingSessions(activeSessionNames: string[], liveSessionNames: string[], saveDirectory?: string): Promise<TmuxResurrectPendingRestoreResult> {
  const status = statusForDirectory(saveDirectory);
  if (!status.installed) return { restored: [], failures: [] };
  const live = new Set(liveSessionNames);
  const restored: string[] = [];
  const failures: Array<{ sessionName: string; error: string }> = [];
  for (const sessionName of [...new Set(activeSessionNames)]) {
    if (live.has(sessionName)) continue;
    const snapshot = ensureSnapshotFromGlobal(status, sessionName);
    if (!snapshot) continue;
    try {
      await restoreSession(sessionName, saveDirectory);
      restored.push(sessionName);
    } catch (error) {
      failures.push({ sessionName, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { restored, failures };
}

function snapshotForSession(sessionName: string, saveDirectory?: string): TmuxResurrectSessionSnapshot | null {
  const status = statusForDirectory(saveDirectory);
  return snapshotForSessionInDirectory(status.saveDirectory, sessionName);
}

function disableSession(sessionName: string, saveDirectory?: string): void {
  const status = statusForDirectory(saveDirectory);
  const directory = snapshotDirectoryForSession(status.saveDirectory, sessionName);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(disabledFileForSession(status.saveDirectory, sessionName), "disabled\n", { encoding: "utf8", mode: 0o600 });
}

/** Use a separate snapshot root for SSH fallback, without changing Web snapshots. */
export function createTmuxResurrectController(saveDirectory?: string): TmuxResurrectController {
  return {
    status: () => statusForDirectory(saveDirectory),
    saveSession: (sessionName) => withSessionActionLock(() => saveSession(sessionName, saveDirectory)),
    restoreSession: (sessionName) => withSessionActionLock(() => restoreSession(sessionName, saveDirectory)),
    restorePendingSessions: (activeSessionNames, liveSessionNames) =>
      withSessionActionLock(() => restorePendingSessions(activeSessionNames, liveSessionNames, saveDirectory)),
    snapshotForSession: (sessionName) => snapshotForSession(sessionName, saveDirectory),
    disableSession: (sessionName) => disableSession(sessionName, saveDirectory),
  };
}

export const tmuxResurrectController: TmuxResurrectController = createTmuxResurrectController();
