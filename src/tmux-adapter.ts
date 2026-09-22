import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TmuxSessionRecord } from "./tmux-verifier-store.js";

const execFileAsync = promisify(execFile);

export interface TmuxAdapterOptions {
  tmuxPath?: string;
  sshPath?: string;
  sshOptions?: string[];
  commandTimeoutMs?: number;
}

export interface TmuxAdapter {
  startSession(session: TmuxSessionRecord): Promise<void>;
  hasSession(session: TmuxSessionRecord): Promise<boolean>;
  capturePane(session: TmuxSessionRecord): Promise<string>;
  sendText(session: TmuxSessionRecord, text: string): Promise<void>;
  sendTerminalData(session: TmuxSessionRecord, data: string): Promise<void>;
  killSession(session: TmuxSessionRecord): Promise<void>;
  attachCommand(session: TmuxSessionRecord): string;
}

export function createTmuxAdapter(
  session: TmuxSessionRecord,
  options: TmuxAdapterOptions = {},
): TmuxAdapter {
  return new SshTmuxAdapter(session, options);
}

export function isLocalMachine(machine: string): boolean {
  return machine === "" || machine === "local" || machine === "localhost";
}

class SshTmuxAdapter implements TmuxAdapter {
  private readonly tmuxPath: string;
  private readonly sshPath: string;
  private readonly sshOptions: string[];
  private readonly timeoutMs: number;

  constructor(
    private readonly session: TmuxSessionRecord,
    options: TmuxAdapterOptions,
  ) {
    this.tmuxPath = options.tmuxPath ?? "tmux";
    this.sshPath = options.sshPath ?? "ssh";
    this.sshOptions = options.sshOptions ?? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
    this.timeoutMs = options.commandTimeoutMs ?? 20_000;
  }

  public async startSession(session: TmuxSessionRecord): Promise<void> {
    await this.runTmux([
      "new-session",
      "-d",
      "-s",
      session.tmux_session,
      "-c",
      session.cwd,
      session.codex_path,
      "--no-alt-screen",
      "--cd",
      session.cwd,
    ]);
  }

  public async hasSession(session: TmuxSessionRecord): Promise<boolean> {
    try {
      await this.runTmux(["has-session", "-t", session.tmux_session]);
      return true;
    } catch (error) {
      if (isMissingTmuxSession(error)) return false;
      throw error;
    }
  }

  public async capturePane(session: TmuxSessionRecord): Promise<string> {
    const result = await this.runTmux([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-t",
      session.tmux_session,
    ]);
    return result.stdout;
  }

  public async sendText(session: TmuxSessionRecord, text: string): Promise<void> {
    if (!text) return;
    await this.runTmux([
      "send-keys",
      "-t",
      session.tmux_session,
      "-l",
      "--",
      text,
    ]);
    await this.runTmux(["send-keys", "-t", session.tmux_session, "Enter"]);
  }

  public async sendTerminalData(session: TmuxSessionRecord, data: string): Promise<void> {
    const tokens = terminalDataToTmuxKeys(data);
    for (const token of tokens) {
      if (token.kind === "literal") {
        await this.runTmux([
          "send-keys",
          "-t",
          session.tmux_session,
          "-l",
          "--",
          token.value,
        ]);
      } else {
        await this.runTmux(["send-keys", "-t", session.tmux_session, token.value]);
      }
    }
  }

  public async killSession(session: TmuxSessionRecord): Promise<void> {
    try {
      await this.runTmux(["kill-session", "-t", session.tmux_session]);
    } catch (error) {
      if (!isMissingTmuxSession(error)) throw error;
    }
  }

  public attachCommand(session: TmuxSessionRecord): string {
    const tmuxCommand = [
      this.tmuxPath,
      ...tmuxSocketArguments(session.tmux_socket),
      "attach-session",
      "-t",
      session.tmux_session,
    ].map(shellQuote).join(" ");
    if (isLocalMachine(session.machine)) return tmuxCommand;
    const sshPrefix = [this.sshPath, ...this.sshOptions, session.machine]
      .map(shellQuote)
      .join(" ");
    return `${sshPrefix} ${shellQuote(tmuxCommand)}`;
  }

  private async runTmux(args: string[]): Promise<ExecResult> {
    const tmuxArgs = [...tmuxSocketArguments(this.session.tmux_socket), ...args];
    if (isLocalMachine(this.session.machine)) {
      const environment = { ...process.env };
      delete environment.TMUX;
      return execute(this.tmuxPath, tmuxArgs, this.timeoutMs, environment);
    }
    const remoteCommand = [this.tmuxPath, ...tmuxArgs].map(shellQuote).join(" ");
    return execute(
      this.sshPath,
      [...this.sshOptions, this.session.machine, remoteCommand],
      this.timeoutMs,
    );
  }
}

function tmuxSocketArguments(socket: string): string[] {
  return socket ? ["-L", socket] : [];
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  code?: string | number;
  stderr?: string;
  stdout?: string;
}

async function execute(
  file: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  try {
    const result = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env,
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    const failure = error as ExecFailure;
    const details = [
      failure.message,
      failure.stderr,
      failure.stdout,
    ].filter(Boolean).join(" ");
    const wrapped = new Error(details || "command failed") as ExecFailure;
    wrapped.cause = error;
    wrapped.code = failure.code;
    wrapped.stderr = failure.stderr;
    wrapped.stdout = failure.stdout;
    throw wrapped;
  }
}

function isMissingTmuxSession(error: unknown): boolean {
  const failure = error as ExecFailure;
  const text = [failure.message, failure.stderr].filter(Boolean).join(" ").toLowerCase();
  return Boolean(
    text.includes("can't find session")
      || text.includes("no server running")
      || text.includes("session not found")
      || text.includes("no sessions")
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type TerminalKey = { kind: "literal" | "key"; value: string };

export function terminalDataToTmuxKeys(data: string): TerminalKey[] {
  const tokens: TerminalKey[] = [];
  let literal = "";
  const flush = (): void => {
    if (!literal) return;
    tokens.push({ kind: "literal", value: literal });
    literal = "";
  };

  for (let index = 0; index < data.length;) {
    const remaining = data.slice(index);
    const escape = /^(\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001bO[A-Z])/.exec(remaining)?.[0];
    if (escape) {
      flush();
      tokens.push({ kind: "key", value: mapEscapeSequence(escape) });
      index += escape.length;
      continue;
    }
    const char = data[index];
    if (char === "\r" || char === "\n") {
      flush();
      tokens.push({ kind: "key", value: "Enter" });
    } else if (char === "\u0003") {
      flush();
      tokens.push({ kind: "key", value: "C-c" });
    } else if (char === "\u007f" || char === "\b") {
      flush();
      tokens.push({ kind: "key", value: "BSpace" });
    } else if (char === "\u001b") {
      flush();
      tokens.push({ kind: "key", value: "Escape" });
    } else if (char < " ") {
      flush();
      tokens.push({ kind: "key", value: `C-${String.fromCharCode(char.charCodeAt(0) + 96)}` });
    } else {
      literal += char;
    }
    index += 1;
  }
  flush();
  return tokens;
}

function mapEscapeSequence(value: string): string {
  switch (value) {
    case "\u001b[A":
    case "\u001bOA":
      return "Up";
    case "\u001b[B":
    case "\u001bOB":
      return "Down";
    case "\u001b[C":
    case "\u001bOC":
      return "Right";
    case "\u001b[D":
    case "\u001bOD":
      return "Left";
    case "\u001b[H":
      return "Home";
    case "\u001b[F":
      return "End";
    case "\u001b[3~":
      return "DC";
    default:
      return "Escape";
  }
}
