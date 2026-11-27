import type { Terminal } from "@xterm/xterm";

/** Check only the current viewport; old scrollback does not make a blank screen visible. */
export function hasVisibleTerminalContent(terminal: Pick<Terminal, "buffer" | "rows">): boolean {
  const buffer = terminal.buffer.active;
  for (let row = 0; row < terminal.rows; row += 1) {
    if (buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim()) return true;
  }
  return false;
}
