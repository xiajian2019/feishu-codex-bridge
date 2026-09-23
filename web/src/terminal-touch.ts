import type { Terminal } from "@xterm/xterm";

function cellPosition(terminal: Terminal, element: HTMLElement, clientX: number, clientY: number): { col: number; row: number } {
  const rect = element.getBoundingClientRect();
  return {
    col: Math.max(1, Math.min(terminal.cols, Math.floor(((clientX - rect.left) / Math.max(rect.width, 1)) * terminal.cols) + 1)),
    row: Math.max(1, Math.min(terminal.rows, Math.floor(((clientY - rect.top) / Math.max(rect.height, 1)) * terminal.rows) + 1)),
  };
}

function sendMouseWheel(
  terminal: Terminal,
  element: HTMLElement,
  sendInput: (data: string) => void,
  direction: -1 | 1,
  clientX: number,
  clientY: number,
): void {
  const { col, row } = cellPosition(terminal, element, clientX, clientY);
  const button = direction < 0 ? 64 : 65;
  sendInput(`\u001b[<${button};${col};${row}M`);
}

export function bindMobileTerminalTouch(
  host: HTMLElement,
  terminal: Terminal,
  sendInput: (data: string) => void,
): () => void {
  let previousY: number | null = null;
  const onTouchStart = (event: TouchEvent): void => {
    previousY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch || previousY === null) return;
    const delta = previousY - touch.clientY;
    if (Math.abs(delta) < 8) return;
    const lines = Math.max(1, Math.round(Math.abs(delta) / 18));
    const direction = delta > 0 ? 1 : -1;
    if (terminal.buffer.active.type === "normal") {
      terminal.scrollLines(direction * lines);
    } else {
      for (let index = 0; index < lines; index += 1) {
        sendMouseWheel(terminal, host, sendInput, direction, touch.clientX, touch.clientY);
      }
    }
    previousY = touch.clientY;
    event.preventDefault();
  };
  const onTouchEnd = (): void => { previousY = null; };
  host.addEventListener("touchstart", onTouchStart, { passive: false });
  host.addEventListener("touchmove", onTouchMove, { passive: false });
  host.addEventListener("touchend", onTouchEnd);
  host.addEventListener("touchcancel", onTouchEnd);
  return () => {
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("touchend", onTouchEnd);
    host.removeEventListener("touchcancel", onTouchEnd);
  };
}
