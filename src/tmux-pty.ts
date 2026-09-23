import { constants as osConstants } from "node:os";

import { isLocalMachine, type TmuxAdapterOptions } from "./tmux-adapter.js";
import type { TmuxTerminalProcess } from "./tmux-verifier.js";
import type { TmuxSessionRecord } from "./tmux-verifier-store.js";

export interface TmuxPtyOptions extends TmuxAdapterOptions {
  cols?: number;
  rows?: number;
}

interface BunTerminal {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunTerminalProcess {
  exited: Promise<number>;
  signalCode?: string | null;
  terminal?: BunTerminal;
  kill(signal?: string): void;
}

interface BunRuntime {
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      terminal: {
        cols: number;
        rows: number;
        name: string;
        data: (_terminal: BunTerminal, data: Uint8Array) => void;
      };
    },
  ): BunTerminalProcess;
}

/**
 * Create one real terminal client attached to an existing tmux session.
 * Killing this PTY detaches the client; it does not kill the tmux session.
 */
export function spawnTmuxAttachPty(
  session: TmuxSessionRecord,
  options: TmuxPtyOptions = {},
): TmuxTerminalProcess {
  const tmuxPath = options.tmuxPath ?? "tmux";
  const sshPath = options.sshPath ?? "ssh";
  const sshOptions = options.sshOptions ?? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  const tmuxArgs = [
    "-L",
    session.tmux_socket,
    "attach-session",
    "-t",
    session.tmux_session,
  ];
  const local = isLocalMachine(session.machine);
  const file = local ? tmuxPath : sshPath;
  const args = local
    ? tmuxArgs
    : [
        ...sshOptions,
        "-tt",
        session.machine,
        [tmuxPath, ...tmuxArgs].map(shellQuote).join(" "),
      ];
  const cwd = local ? session.cwd : process.cwd();
  const env = {
    ...process.env,
    TERM: "xterm-256color",
  };
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!bun) {
    throw new Error("tmux terminal attach requires Bun's POSIX PTY support");
  }

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const decoder = new TextDecoder();
  const subprocess = bun.spawn([file, ...args], {
    terminal: {
      name: "xterm-256color",
      cols: Math.max(2, options.cols ?? 80),
      rows: Math.max(2, options.rows ?? 24),
      data: (_terminal, data) => {
        const text = decoder.decode(data, { stream: true });
        if (text) for (const listener of dataListeners) listener(text);
      },
    },
    cwd,
    env,
  });

  const terminal = subprocess.terminal;
  if (!terminal) throw new Error("Bun did not create a PTY for the tmux client");

  void subprocess.exited.then((exitCode) => {
    const trailingText = decoder.decode();
    if (trailingText) for (const listener of dataListeners) listener(trailingText);
    terminal.close();
    const signalName = subprocess.signalCode;
    const signal = signalName
      ? (osConstants.signals as Record<string, number>)[signalName]
      : undefined;
    for (const listener of exitListeners) listener({ exitCode, signal });
    dataListeners.clear();
    exitListeners.clear();
  });

  return {
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    write(data) {
      terminal.write(data);
    },
    resize(cols, rows) {
      terminal.resize(Math.max(2, cols), Math.max(2, rows));
    },
    kill(signal = "SIGTERM") {
      subprocess.kill(signal);
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
