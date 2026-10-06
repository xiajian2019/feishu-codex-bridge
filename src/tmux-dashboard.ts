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

export async function setCodexHomeForSession(id: string, codexHomePath: string | null): Promise<void> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  if (!(await findSession(id))) throw new SessionNotFoundError("Session no longer exists.");
  if (codexHomePath) {
    await runTmux(["set-environment", "-t", id, "CODEX_HOME", resolve(codexHomePath)]);
  } else {
    await runTmux(["set-environment", "-u", "-t", id, "CODEX_HOME"]);
  }
}

export async function inspectCodexHome(id: string): Promise<{ status: "running" | "not-running" | "unavailable"; path?: string }> {
  if (!isSessionId(id)) throw new ValidationError("Invalid tmux session id.");
  if (!(await findSession(id))) throw new SessionNotFoundError("Session no longer exists.");

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
