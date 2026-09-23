import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { getBunRuntime } from "./bun-runtime.js";

const SESSION_FORMAT = "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_path}\t#{session_created}";

export interface TmuxSession {
  id: string;
  name: string;
  windows: number;
  attachedClients: number;
  cwd: string;
  createdAt: number;
}

export class SessionNotFoundError extends Error {}

export class ValidationError extends Error {}

export function isSessionId(value: string): boolean {
  return /^\$\d+$/.test(value);
}

export function isValidSessionName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
}

export function parseSessions(output: string): TmuxSession[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, name, windows, attachedClients, cwd, createdAt] = line.split("\t");
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

async function runTmux(args: string[]): Promise<string> {
  const child = getBunRuntime().spawn(["tmux", ...args], {
    env: {
      ...process.env,
      TMUX: undefined,
      TMUX_PANE: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout!.text(),
    child.stderr!.text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `tmux ${args[0]} exited with code ${exitCode}`);
  }
  return stdout.trimEnd();
}

export async function listSessions(): Promise<TmuxSession[]> {
  try {
    return parseSessions(await runTmux(["list-sessions", "-F", SESSION_FORMAT]));
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
