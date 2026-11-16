import { describe, expect, it } from "bun:test";
import { TmuxTerminalReplayGuard } from "../web/src/tmux-terminal-replay.js";

// The browser build of xterm expects self even when its parser is used headlessly.
(globalThis as unknown as { self: typeof globalThis }).self = globalThis;
const { Terminal } = await import("@xterm/xterm");

describe("tmux cached output replay", () => {
  it("suppresses replies from replay, then forwards live replies and input", async () => {
    const terminal = new Terminal();
    const states: boolean[] = [];
    const forwarded: string[] = [];
    const guard = new TmuxTerminalReplayGuard(terminal, (replaying) => states.push(replaying));
    terminal.onData((data) => { if (!guard.active) forwarded.push(data); });
    try {
      guard.start();
      terminal.write("\u001b[");
      terminal.write("c\u001b[>c\u001b[6n\u001bP$qm\u001b\\");
      guard.finish();
      // A live query can arrive before xterm finishes parsing the replay.
      await new Promise<void>((resolve) => terminal.write("\u001b[c\u001b[>c", resolve));
      expect(states).toEqual([true, false]);
      expect(forwarded).toEqual(["\u001b[?1;2c", "\u001b[>0;276;0c"]);
      // Identical bytes entered by the user must not be filtered by content.
      terminal.input("\u001b[?1;2c");
      terminal.input("hello");
      expect(forwarded.slice(2)).toEqual(["\u001b[?1;2c", "hello"]);
    } finally {
      terminal.dispose();
    }
  });

  it("allows a query completed by live output to receive a response", async () => {
    const terminal = new Terminal();
    const forwarded: string[] = [];
    const guard = new TmuxTerminalReplayGuard(terminal, () => {});
    terminal.onData((data) => { if (!guard.active) forwarded.push(data); });
    try {
      guard.start();
      terminal.write("\u001b[");
      guard.finish();
      await new Promise<void>((resolve) => terminal.write("c", resolve));
      expect(forwarded).toEqual(["\u001b[?1;2c"]);
    } finally {
      terminal.dispose();
    }
  });

  it("keeps a newer replay guarded until its own queued boundary", async () => {
    const terminal = new Terminal();
    const states: boolean[] = [];
    const forwarded: string[] = [];
    const guard = new TmuxTerminalReplayGuard(terminal, (replaying) => states.push(replaying));
    terminal.onData((data) => { if (!guard.active) forwarded.push(data); });
    try {
      guard.start();
      terminal.write("\u001b[c");
      guard.finish();
      guard.start();
      terminal.write("\u001b[>c");
      guard.finish();
      await new Promise<void>((resolve) => terminal.write("\u001b[c", resolve));
      expect(states).toEqual([true, true, false]);
      expect(forwarded).toEqual(["\u001b[?1;2c"]);
    } finally {
      terminal.dispose();
    }
  });
});
