/** Prepare capture-pane output for a separate, read-only xterm history buffer. */
export function terminalHistorySnapshot(content: string): string {
  // capture-pane terminates its final row with LF. Keeping that delimiter would
  // scroll a full-height snapshot by one row; the other trailing blank rows
  // are meaningful and must remain in the snapshot.
  const lines = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return "\u001b[0m\u001b[3J\u001b[2J\u001b[H\u001b[?25l" + lines.replace(/\n/g, "\r\n");
}
