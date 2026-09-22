import * as pty from "node-pty";

import { isLocalMachine, type TmuxAdapterOptions } from "./tmux-adapter.js";
import type { TmuxSessionRecord } from "./tmux-verifier-store.js";

export interface TmuxPtyOptions extends TmuxAdapterOptions {
  cols?: number;
  rows?: number;
}

/**
 * Create one real terminal client attached to an existing tmux session.
 * Killing this PTY detaches the client; it does not kill the tmux session.
 */
export function spawnTmuxAttachPty(
  session: TmuxSessionRecord,
  options: TmuxPtyOptions = {},
): pty.IPty {
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
  return pty.spawn(file, args, {
    name: "xterm-256color",
    cols: Math.max(2, options.cols ?? 80),
    rows: Math.max(2, options.rows ?? 24),
    cwd,
    env,
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
