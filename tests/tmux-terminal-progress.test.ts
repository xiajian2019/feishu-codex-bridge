import { expect, it } from "bun:test";
import { hasVisibleTerminalContent } from "../web/src/tmux-terminal-progress.js";

(globalThis as unknown as { self: typeof globalThis }).self = globalThis;
const { Terminal } = await import("@xterm/xterm");

it("detects visible terminal content after control-only output and ignores cleared scrollback", async () => {
  const terminal = new Terminal({ cols: 20, rows: 5, scrollback: 20 });
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  try {
    await write("\u001b[2J\u001b[H   ");
    expect(hasVisibleTerminalContent(terminal)).toBe(false);
    await write("Codex 画面");
    expect(hasVisibleTerminalContent(terminal)).toBe(true);
    await write("\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\u001b[2J\u001b[H");
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
    expect(hasVisibleTerminalContent(terminal)).toBe(false);
    await write("新内容");
    expect(hasVisibleTerminalContent(terminal)).toBe(true);
  } finally {
    terminal.dispose();
  }
});
