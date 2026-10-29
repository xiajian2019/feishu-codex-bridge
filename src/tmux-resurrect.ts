import {
  existsSync,
  mkdirSync,
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
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getBunRuntime } from "./bun-runtime.js";

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

function writeSessionSnapshot(saveDirectory: string, sessionName: string, sourcePath: string): TmuxResurrectSessionSnapshot | null {
  if (existsSync(disabledFileForSession(saveDirectory, sessionName))) return null;
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
  return snapshotForSessionInDirectory(saveDirectory, sessionName);
}

async function runProcess(command: string[], env?: NodeJS.ProcessEnv): Promise<{ output: string; exitCode: number }> {
  const child = getBunRuntime().spawn(command, {
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout?.text() ?? Promise.resolve(""),
    child.stderr?.text() ?? Promise.resolve(""),
    child.exited,
  ]);
  return { output: `${stdout}\n${stderr}`.trim().slice(-4_000), exitCode };
}

async function runTmux(args: string[], allowFailure = false): Promise<string> {
  const result = await runProcess(["tmux", ...args]);
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(result.output || `tmux ${args[0] ?? "command"} failed with exit code ${result.exitCode}.`);
  }
  return result.output;
}

async function tmuxOption(name: string): Promise<string> {
  return runTmux(["show-option", "-gqv", name]);
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  return (await runProcess(["tmux", "has-session", "-t", sessionName])).exitCode === 0;
}

async function runRestoreScript(pluginDirectory: string, saveDirectory: string): Promise<string> {
  const previousDirectory = await tmuxOption("@resurrect-dir");
  await runTmux(["set-option", "-g", "@resurrect-dir", saveDirectory]);
  try {
    const result = await runProcess(["bash", join(pluginDirectory, "scripts", "restore.sh")]);
    if (result.exitCode !== 0) throw new Error(result.output || `tmux-resurrect restore failed with exit code ${result.exitCode}.`);
    return result.output;
  } finally {
    if (previousDirectory) await runTmux(["set-option", "-g", "@resurrect-dir", previousDirectory], true);
    else await runTmux(["set-option", "-gu", "@resurrect-dir"], true);
  }
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

async function saveSession(sessionName: string): Promise<TmuxResurrectSessionActionResult> {
  const status = getTmuxResurrectStatus();
  ensureInstalled(status);
  const saveResult = await runProcess(["bash", join(status.pluginDirectory, "scripts", "save.sh")]);
  if (saveResult.exitCode !== 0) throw new Error(saveResult.output || `tmux-resurrect save failed with exit code ${saveResult.exitCode}.`);
  const snapshot = ensureSnapshotFromGlobal(status, sessionName);
  if (!snapshot) throw new Error(`当前 Session「${sessionName}」没有可保存的 tmux 快照。`);
  return { action: "save", sessionName, snapshot, output: saveResult.output };
}

async function restoreSession(sessionName: string): Promise<TmuxResurrectSessionActionResult> {
  const status = getTmuxResurrectStatus();
  ensureInstalled(status);
  if (await tmuxSessionExists(sessionName)) {
    throw new Error(`Session「${sessionName}」仍在运行，请直接打开它；恢复只针对不存在的 Session。`);
  }
  const snapshot = snapshotForSessionInDirectory(status.saveDirectory, sessionName) ?? ensureSnapshotFromGlobal(status, sessionName);
  if (!snapshot) throw new Error(`没有找到 Session「${sessionName}」的快照。`);
  const output = await runRestoreScript(status.pluginDirectory, snapshotDirectoryForSession(status.saveDirectory, sessionName));
  return { action: "restore", sessionName, snapshot, output };
}

async function restorePendingSessions(activeSessionNames: string[], liveSessionNames: string[]): Promise<TmuxResurrectPendingRestoreResult> {
  const status = getTmuxResurrectStatus();
  if (!status.installed) return { restored: [], failures: [] };
  const live = new Set(liveSessionNames);
  const restored: string[] = [];
  const failures: Array<{ sessionName: string; error: string }> = [];
  for (const sessionName of [...new Set(activeSessionNames)]) {
    if (live.has(sessionName)) continue;
    const snapshot = ensureSnapshotFromGlobal(status, sessionName);
    if (!snapshot) continue;
    try {
      await restoreSession(sessionName);
      restored.push(sessionName);
    } catch (error) {
      failures.push({ sessionName, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { restored, failures };
}

function snapshotForSession(sessionName: string): TmuxResurrectSessionSnapshot | null {
  const status = getTmuxResurrectStatus();
  return snapshotForSessionInDirectory(status.saveDirectory, sessionName);
}

function disableSession(sessionName: string): void {
  const status = getTmuxResurrectStatus();
  const directory = snapshotDirectoryForSession(status.saveDirectory, sessionName);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(disabledFileForSession(status.saveDirectory, sessionName), "disabled\n", { encoding: "utf8", mode: 0o600 });
}

export const tmuxResurrectController: TmuxResurrectController = {
  status: getTmuxResurrectStatus,
  saveSession: (sessionName) => withSessionActionLock(() => saveSession(sessionName)),
  restoreSession: (sessionName) => withSessionActionLock(() => restoreSession(sessionName)),
  restorePendingSessions: (activeSessionNames, liveSessionNames) => withSessionActionLock(() => restorePendingSessions(activeSessionNames, liveSessionNames)),
  snapshotForSession,
  disableSession,
};
