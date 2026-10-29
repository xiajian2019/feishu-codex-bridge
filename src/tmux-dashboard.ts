import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { getBunRuntime } from "./bun-runtime.js";
import type { ForegroundCodexIdentity } from "./tmux-review.js";

const SESSION_FORMAT = "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_path}\t#{session_created}";

export interface TmuxSession {
  id: string;
  name: string;
  windows: number;
  attachedClients: number;
  cwd: string;
  createdAt: number;
}

export interface TmuxReviewPaneSnapshot {
  paneId: string;
  panePid: number;
  paneTty: string;
  currentCommand: string;
  cwd: string;
  foregroundCodex: ForegroundCodexIdentity | null;
}

export class SessionNotFoundError extends Error {}

export class TmuxQueryTimeoutError extends Error {
  constructor() { super("tmux Session 列表查询超时，请重试。"); }
}

export class ValidationError extends Error {}

export function isSessionId(value: string): boolean {
  return /^\$\d+$/.test(value);
}

export function isValidSessionName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
}

export function parseSessions(output: string): TmuxSession[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split("\t");
    const legacyComposite = /^(\$\d+)[_\t](.+?)[_\t](\d+)[_\t](\d+)[_\t](.+)[_\t](\d+)$/.exec(line);
    const [id, name, windows, attachedClients, cwd, createdAt] = fields.length === 6
      ? fields
      : legacyComposite?.slice(1) ?? fields;
    return {
      id,
      name,
      windows: Number(windows) || 0,
      attachedClients: Number(attachedClients) || 0,
      cwd,
      createdAt: Number(createdAt) || 0,
    };
  });
}

async function runTmux(args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  if (options.signal?.aborted) throw options.signal.reason;
  const child = getBunRuntime().spawn(["tmux", ...args], {
    env: {
      ...process.env,
      TMUX: undefined,
      TMUX_PANE: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    const cancel = (error: unknown): void => {
      reject(error);
      // This is the short-lived query client, never the tmux server or a Session.
      try { child.kill("SIGKILL"); } catch { /* The client may already have exited. */ }
    };
    if (options.timeoutMs !== undefined) timer = setTimeout(() => cancel(new TmuxQueryTimeoutError()), options.timeoutMs);
    onAbort = () => cancel(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([child.stdout!.text(), child.stderr!.text(), child.exited]), cancellation,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `tmux ${args[0]} exited with code ${exitCode}`);
    return stdout.trimEnd();
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}

async function runTmuxWithStdin(args: string[], input: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const child = spawn("tmux", args, {
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `tmux ${args[0]} exited with ${code ?? signal ?? "unknown status"}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function validatePaneId(paneId: string): void {
  if (!/^%\d+$/.test(paneId)) throw new ValidationError("Invalid tmux pane id.");
}

/** Paste multiline text through a unique tmux buffer into one explicit pane. */
export async function pasteTextToPane(
  paneId: string,
  text: string,
  beforePaste?: () => Promise<void>,
): Promise<void> {
  validatePaneId(paneId);
  if (Buffer.byteLength(text, "utf8") > 32 * 1024) throw new ValidationError("The message is too long.");
  const bufferName = `bridge-review-${randomUUID()}`;
  try {
    await runTmuxWithStdin(["load-buffer", "-b", bufferName, "-"], text);
    await beforePaste?.();
    await runTmux(["paste-buffer", "-d", "-p", "-r", "-b", bufferName, "-t", paneId]);
  } finally {
    await runTmux(["delete-buffer", "-b", bufferName]).catch(() => undefined);
  }
}

export async function sendEnterToPane(paneId: string, beforeEnter?: () => Promise<void>): Promise<void> {
  validatePaneId(paneId);
  await beforeEnter?.();
  await runTmux(["send-keys", "-t", paneId, "Enter"]);
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const child = getBunRuntime().spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout!.text(),
    child.stderr!.text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command} exited with code ${exitCode}`);
  return stdout.trimEnd();
}

interface ProcessSnapshot {
  pid: number;
  ppid: number;
  processGroup: number;
  foregroundGroup: number;
  tty: string;
  startedAt: string;
  command: string;
}

async function findForegroundCodexProcess(panePid: number, paneTty: string, currentCommand: string): Promise<ForegroundCodexIdentity | null> {
  const processRows = await runCommand("ps", ["-ww", "-axo", "pid=,ppid=,pgid=,tpgid=,tty=,lstart=,command="]);
  return selectForegroundCodexProcess(processRows, panePid, paneTty, currentCommand);
}

export function selectForegroundCodexProcess(
  processRows: string,
  panePid: number,
  paneTty: string,
  currentCommand: string,
): ForegroundCodexIdentity | null {
  if (!isCodexProcessName(currentCommand)) return null;
  const processes = processRows.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.{24})\s+(.+)$/.exec(line);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      processGroup: Number(match[3]),
      foregroundGroup: Number(match[4]),
      tty: match[5]!,
      startedAt: match[6]!.trim(),
      command: match[7]!,
    } satisfies ProcessSnapshot];
  });
  const descendants = new Set<number>([panePid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  const expectedTty = paneTty.replace(/^\/dev\//, "");
  const foreground = processes
    .filter((process) => descendants.has(process.pid)
      && process.tty === expectedTty
      && process.processGroup > 0
      && process.processGroup === process.foregroundGroup
      && isCodexProcessName(process.command))
    .sort((left, right) => left.pid - right.pid)[0];
  return foreground
    ? { pid: foreground.pid, startedAt: foreground.startedAt, command: "codex" }
    : null;
}

function isCodexProcessName(value: string): boolean {
  const firstWord = value.trim().split(/\s+/, 1)[0] ?? "";
  const name = firstWord.split(/[\\/]/).pop() ?? firstWord;
  return /^codex(?:\.js)?$/i.test(name);
}

export async function listSessions(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TmuxSession[]> {
  try {
    return parseSessions(await runTmux(["list-sessions", "-F", SESSION_FORMAT], { timeoutMs: 4_000, ...options }));
  } catch (error) {
    if (/no server running|no sessions|failed to connect to server/i.test(String(error))) return [];
    throw error;
  }
}

export async function createSession(name: string, requestedCwd?: string): Promise<TmuxSession> {
  if (!isValidSessionName(name)) {
    throw new ValidationError("Session names must start with a letter or number and use only letters, numbers, dot, dash, or underscore.");
  }

  const expandedCwd = requestedCwd?.trim().replace(/^~(?=\/|$)/, homedir());
  const cwd = resolve(expandedCwd || homedir());
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    throw new ValidationError("The working directory does not exist or is not a directory.");
  }

  await runTmux(["new-session", "-d", "-s", name, "-c", cwd]);
  const createdSession = (await listSessions()).find((session) => session.name === name);
  if (!createdSession) throw new Error("tmux created the session, but it was not returned by list-sessions.");
  return createdSession;
}

export async function killSession(id: string): Promise<void> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  if (!(await listSessions()).some((session) => session.id === id)) {
    throw new SessionNotFoundError("Session no longer exists.");
  }
  await runTmux(["kill-session", "-t", id]);
}

export async function findSession(id: string): Promise<TmuxSession | undefined> {
  if (!isSessionId(id)) return undefined;
  return (await listSessions()).find((session) => session.id === id);
}

export async function getCurrentPanePath(id: string, knownSession?: TmuxSession): Promise<string> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  if (!knownSession && !(await findSession(id))) throw new SessionNotFoundError("Session no longer exists.");
  const cwd = resolve(await runTmux(["display-message", "-p", "-t", id, "#{pane_current_path}"]));
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) throw new ValidationError("The tmux pane working directory is unavailable.");
  return cwd;
}

export async function inspectReviewPane(id: string, knownSession?: TmuxSession): Promise<TmuxReviewPaneSnapshot> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  if (!knownSession && !(await findSession(id))) throw new SessionNotFoundError("Session no longer exists.");

  const details = await runTmux([
    "display-message",
    "-p",
    "-t",
    id,
    "#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_command}\t#{pane_current_path}",
  ]);
  const [paneId, panePidValue, paneTty, currentCommand, ...cwdParts] = details.split("\t");
  const panePid = Number(panePidValue);
  const cwd = resolve(cwdParts.join("\t"));
  if (!paneId || !/^%\d+$/.test(paneId) || !Number.isSafeInteger(panePid) || panePid < 1 || !paneTty || !cwdParts.length) {
    throw new ValidationError("The active tmux pane is unavailable.");
  }
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) throw new ValidationError("The tmux pane working directory is unavailable.");

  const foregroundCodex = isCodexProcessName(currentCommand)
    ? await findForegroundCodexProcess(panePid, paneTty, currentCommand)
    : null;
  return { paneId, panePid, paneTty, currentCommand, cwd, foregroundCodex };
}

export async function setCodexHomeForSession(id: string, codexHomePath: string | null): Promise<void> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  if (!(await findSession(id))) throw new SessionNotFoundError("Session no longer exists.");
  if (codexHomePath) {
    await runTmux(["set-environment", "-t", id, "CODEX_HOME", resolve(codexHomePath)]);
  } else {
    await runTmux(["set-environment", "-u", "-t", id, "CODEX_HOME"]);
  }
}

export async function inspectCodexHome(
  id: string,
  knownSession?: TmuxSession,
): Promise<{ status: "running" | "not-running" | "unavailable"; path?: string }> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  if (!knownSession && !(await findSession(id))) throw new SessionNotFoundError("Session no longer exists.");

  try {
    const panePid = Number(await runTmux(["display-message", "-p", "-t", id, "#{pane_pid}"]));
    if (!Number.isSafeInteger(panePid) || panePid < 1) return { status: "unavailable" };
    const processRows = await runCommand("ps", ["-ww", "-axo", "pid=,ppid=,command="]);
    const processInfo = processRows.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
    });
    const depths = new Map<number, number>([[panePid, 0]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const process of processInfo) {
        const parentDepth = depths.get(process.ppid);
        if (parentDepth !== undefined && !depths.has(process.pid)) {
          depths.set(process.pid, parentDepth + 1);
          changed = true;
        }
      }
    }
    const codexProcesses = processInfo
      .filter((process) => depths.has(process.pid) && /(?:^|[\\/\s])codex(?:\.js)?(?:$|[\s/])/i.test(process.command))
      .sort((left, right) => (depths.get(right.pid) ?? 0) - (depths.get(left.pid) ?? 0));
    if (codexProcesses.length === 0) return { status: "not-running" };

    for (const process of codexProcesses.slice(0, 24)) {
      try {
        const commandWithEnvironment = await runCommand("ps", ["eww", "-p", String(process.pid), "-o", "command="]);
        const match = /(?:^|\s)CODEX_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z\d_]*=|$)/.exec(commandWithEnvironment);
        if (match) {
          const value = match[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
          if (value) return { status: "running", path: resolve(value.replace(/^~(?=\/|$)/, homedir())) };
        }
        return { status: "running", path: resolve(homedir(), ".codex") };
      } catch {
        // Try the next Codex process if the operating system denies this process listing.
      }
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function capturePane(
  id: string,
  rows = 24,
  options: { alternateScreen?: boolean; includeEscapeSequences?: boolean } = {},
): Promise<string> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  const safeRows = Number.isSafeInteger(rows) ? Math.max(1, Math.min(2_000, rows)) : 24;
  const args = ["capture-pane", "-p"];
  if (options.alternateScreen) args.push("-a");
  if (options.includeEscapeSequences) args.push("-e");
  args.push("-t", id, "-S", "-" + safeRows);
  return runTmux(args);
}
