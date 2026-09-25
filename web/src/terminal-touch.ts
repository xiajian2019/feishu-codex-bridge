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
  sendViewScroll: (data: string) => boolean,
  direction: -1 | 1,
  clientX: number,
  clientY: number,
): boolean {
  const { col, row } = cellPosition(terminal, element, clientX, clientY);
  const button = direction < 0 ? 64 : 65;
  return sendViewScroll(`\u001b[<${button};${col};${row}M`);
}

export function bindMobileTerminalTouch(
  host: HTMLElement,
  terminal: Terminal,
  sendViewScroll: (data: string) => boolean,
): () => void {
  terminal.attachCustomWheelEventHandler((event) => {
    if (terminal.buffer.active.type === "normal") return true;
    if (terminal.modes.mouseTrackingMode === "none") {
      terminal.scrollLines(Math.round(event.deltaY / 18));
      event.preventDefault();
      return false;
    }
    const lines = Math.min(12, Math.max(1, Math.round(Math.abs(event.deltaY) / 18)));
    const direction = event.deltaY < 0 ? -1 : 1;
    let delivered = true;
    for (let index = 0; index < lines; index += 1) {
      delivered = sendMouseWheel(terminal, host, sendViewScroll, direction, event.clientX, event.clientY) && delivered;
    }
    if (!delivered) terminal.scrollLines(direction * lines);
    event.preventDefault();
    return false;
  });
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
    } else if (terminal.modes.mouseTrackingMode !== "none") {
      let delivered = true;
      for (let index = 0; index < lines; index += 1) {
        delivered = sendMouseWheel(terminal, host, sendViewScroll, direction, touch.clientX, touch.clientY) && delivered;
      }
      if (!delivered) terminal.scrollLines(direction * lines);
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
