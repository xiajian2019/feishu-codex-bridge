import type { Terminal } from "@xterm/xterm";

function cellPosition(terminal: Terminal, element: HTMLElement, clientX: number, clientY: number): { col: number; row: number } {
  const screen = element.querySelector<HTMLElement>(".xterm-screen");
  const rect = (screen ?? element).getBoundingClientRect();
  return {
    col: Math.max(1, Math.min(terminal.cols, Math.floor(((clientX - rect.left) / Math.max(rect.width, 1)) * terminal.cols) + 1)),
    row: Math.max(1, Math.min(terminal.rows, Math.floor(((clientY - rect.top) / Math.max(rect.height, 1)) * terminal.rows) + 1)),
  };
}

type BufferCell = { column: number; row: number };
type BufferRange = { start: number; end: number };
export type TerminalSelectionDisplay = { text: string; left: number; top: number };
const LONG_PRESS_DELAY_MS = 3_000;
const TOUCH_SCROLL_PIXELS_PER_LINE = 10;
const TOUCH_INERTIA_FRICTION_MS = 280;
const TOUCH_INERTIA_MIN_VELOCITY = 0.12;
const TOUCH_INERTIA_MAX_DURATION_MS = 1_000;
const TOUCH_INERTIA_MAX_ROWS = 24;
const TOUCH_VELOCITY_MAX_PX_PER_MS = 2;
const TOUCH_END_MAX_SCROLL_LINES = 48;
const CONSOLE_RENDER_LOG_INTERVAL_MS = 120;
type ScrollTrace = {
  startedAt: number;
  startX: number;
  startY: number;
  startCell: { col: number; row: number };
  startViewportY: number;
  startBaseY: number;
  startPageScrollY: number;
  startBuffer: string;
  target: string;
  lastSampleAt: number;
  lastMoveAt: number;
  moves: number;
  requestedLines: number;
  actualRows: number;
  maxHandlerMs: number;
};
type PendingScrollRender = {
  requestedAt: number;
  input: "touch" | "inertia" | "wheel";
  col: number;
  row: number;
  deltaY: number;
  requestedLines: number;
  target: string;
  buffer: string;
};
type ScrollDiagnosticEntry = {
  timestamp: string;
  event: string;
  details: Record<string, unknown>;
};

const MAX_SCROLL_DIAGNOSTIC_ENTRIES = 2_000;
const scrollDiagnosticEntries: ScrollDiagnosticEntry[] = [];
const lastConsoleRenderLogAt = new Map<string, number>();
function touchTargetName(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "unknown";
  const classes = [...target.classList].slice(0, 3).join(".");
  return `${target.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
}

function logScrollDiagnostic(event: string, details: Record<string, unknown>): void {
  const entry = { timestamp: new Date().toISOString(), event, details };
  scrollDiagnosticEntries.push(entry);
  if (scrollDiagnosticEntries.length > MAX_SCROLL_DIAGNOSTIC_ENTRIES) scrollDiagnosticEntries.shift();
  if (event === "render") {
    const now = performance.now();
    const lastLoggedAt = lastConsoleRenderLogAt.get(event) ?? Number.NEGATIVE_INFINITY;
    if (now - lastLoggedAt < CONSOLE_RENDER_LOG_INTERVAL_MS) return;
    lastConsoleRenderLogAt.set(event, now);
  }
  console.log(`[tmux-scroll:${event}] ${JSON.stringify(entry)}`);
}

export function downloadTerminalScrollDiagnostics(): number {
  const entries = [...scrollDiagnosticEntries];
  if (entries.length === 0) return 0;
  const payload = {
    format: "tmux-scroll-diagnostics",
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries,
  };
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/tmux-dashboard/api/scroll-diagnostics/export";
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "payload";
  input.value = JSON.stringify(payload);
  form.append(input);
  document.body.append(form);
  form.submit();
  window.setTimeout(() => form.remove(), 1_000);
  return entries.length;
}

function bufferCellPosition(terminal: Terminal, host: HTMLElement, clientX: number, clientY: number): BufferCell {
  const position = cellPosition(terminal, host, clientX, clientY);
  return {
    column: position.col - 1,
    row: terminal.buffer.active.viewportY + position.row - 1,
  };
}

function wordCategory(value: string): "word" | "symbol" | "space" {
  if (!value.trim()) return "space";
  return /[\p{L}\p{N}_]/u.test(value) ? "word" : "symbol";
}

function longPressRange(terminal: Terminal, host: HTMLElement, clientX: number, clientY: number): BufferRange | null {
  const position = bufferCellPosition(terminal, host, clientX, clientY);
  const line = terminal.buffer.active.getLine(position.row);
  if (!line) return null;

  let column = position.column;
  let cell = line.getCell(column);
  if (cell?.getWidth() === 0 && column > 0) {
    column -= 1;
    cell = line.getCell(column);
  }
  if (!cell) return null;

  const value = cell.getChars();
  if (!value.trim()) {
    if (!line.translateToString(true).trim()) return null;
    let endColumn = terminal.cols;
    while (endColumn > 0) {
      const endCell = line.getCell(endColumn - 1);
      if (!endCell) {
        endColumn -= 1;
      } else if (endCell.getWidth() === 0 || endCell.getChars().trim()) {
        break;
      } else {
        endColumn -= 1;
      }
    }
    return { start: position.row * terminal.cols, end: position.row * terminal.cols + Math.max(1, endColumn) };
  }

  const category = wordCategory(value);
  let startColumn = column;
  while (startColumn > 0) {
    const previous = line.getCell(startColumn - 1);
    if (!previous) break;
    if (previous.getWidth() === 0) {
      startColumn -= 1;
      continue;
    }
    if (wordCategory(previous.getChars()) !== category) break;
    startColumn -= 1;
  }

  let endColumn = column + Math.max(1, cell.getWidth());
  while (endColumn < terminal.cols) {
    const next = line.getCell(endColumn);
    if (!next) break;
    if (next.getWidth() === 0) {
      endColumn += 1;
      continue;
    }
    if (wordCategory(next.getChars()) !== category) break;
    endColumn += Math.max(1, next.getWidth());
  }

  const lineOffset = position.row * terminal.cols;
  return { start: lineOffset + startColumn, end: lineOffset + endColumn };
}

function selectBufferRange(terminal: Terminal, range: BufferRange): void {
  const columns = terminal.cols;
  const start = Math.max(0, range.start);
  const end = Math.max(start + 1, range.end);
  terminal.select(start % columns, Math.floor(start / columns), end - start);
}

function setHandlePosition(
  terminal: Terminal,
  host: HTMLElement,
  handle: HTMLButtonElement,
  offset: number,
  isEnd = false,
): void {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) {
    handle.hidden = true;
    return;
  }
  const screenRect = screen.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const cellWidth = screenRect.width / terminal.cols;
  const cellHeight = screenRect.height / terminal.rows;
  const boundaryOffset = isEnd ? Math.max(0, offset - 1) : offset;
  const row = Math.floor(boundaryOffset / terminal.cols) - terminal.buffer.active.viewportY;
  if (row < 0 || row >= terminal.rows || cellWidth <= 0 || cellHeight <= 0) {
    handle.hidden = true;
    return;
  }
  const column = isEnd ? boundaryOffset % terminal.cols + 1 : boundaryOffset % terminal.cols;
  handle.style.left = `${screenRect.left - hostRect.left + column * cellWidth}px`;
  handle.style.top = `${screenRect.top - hostRect.top + (row + 1) * cellHeight}px`;
  handle.hidden = false;
}

function selectionDisplayPosition(terminal: Terminal, host: HTMLElement, range: BufferRange): { left: number; top: number } {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  const frame = host.parentElement;
  if (!screen || !frame) return { left: 8, top: 8 };
  const screenRect = screen.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const cellWidth = screenRect.width / terminal.cols;
  const cellHeight = screenRect.height / terminal.rows;
  const endOffset = Math.max(range.start, range.end - 1);
  const row = Math.max(0, Math.min(
    terminal.rows - 1,
    Math.floor(endOffset / terminal.cols) - terminal.buffer.active.viewportY,
  ));
  const column = endOffset % terminal.cols + 1;
  const buttonWidth = 116;
  const buttonHeight = 40;
  const endX = screenRect.left - frameRect.left + column * cellWidth;
  const below = screenRect.top - frameRect.top + (row + 1) * cellHeight + 5;
  return {
    left: Math.max(6, Math.min(frameRect.width - buttonWidth - 6, endX - buttonWidth / 2)),
    top: below + buttonHeight <= frameRect.height - 4 ? below : Math.max(4, below - buttonHeight - 10),
  };
}

export function bindMobileTerminalTouch(
  host: HTMLElement,
  terminal: Terminal,
  onSelectionChange: (selection: TerminalSelectionDisplay | null) => void,
): () => void {
  let lastWheelSampleAt = 0;
  let lastViewportSampleAt = 0;
  let lastObservedViewportY = terminal.buffer.active.viewportY;
  let pendingScrollRender: PendingScrollRender | null = null;
  const renderListener = terminal.onRender(({ start, end }) => {
    const pending = pendingScrollRender;
    if (!pending) return;
    pendingScrollRender = null;
    logScrollDiagnostic("render", {
      ...pending,
      renderDelayMs: Number((performance.now() - pending.requestedAt).toFixed(2)),
      renderedStartRow: start + 1,
      renderedEndRow: end + 1,
    });
  });
  const watchScrollRender = (input: "touch" | "inertia" | "wheel", cell: { col: number; row: number }, deltaY: number, requestedLines: number, target: EventTarget | null): void => {
    pendingScrollRender = {
      requestedAt: performance.now(),
      input,
      col: cell.col,
      row: cell.row,
      deltaY,
      requestedLines,
      target: touchTargetName(target),
      buffer: terminal.buffer.active.type,
    };
  };
  terminal.attachCustomWheelEventHandler((event) => {
    const now = performance.now();
    const position = cellPosition(terminal, host, event.clientX, event.clientY);
    const buffer = terminal.buffer.active;
    if (buffer.type === "normal") {
      watchScrollRender("wheel", position, event.deltaY, 0, event.target);
      if (now - lastWheelSampleAt >= 120) {
        lastWheelSampleAt = now;
        logScrollDiagnostic("wheel", {
          route: "xterm-default-local",
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          col: position.col,
          row: position.row,
          buffer: buffer.type,
          viewportY: buffer.viewportY,
          baseY: buffer.baseY,
          target: touchTargetName(event.target),
        });
      }
      return true;
    }
    const lines = Math.round(event.deltaY / 18);
    const beforeViewportY = buffer.viewportY;
    const startedAt = performance.now();
    watchScrollRender("wheel", position, event.deltaY, lines, event.target);
    terminal.scrollLines(lines);
    const handlerMs = performance.now() - startedAt;
    const afterViewportY = terminal.buffer.active.viewportY;
    if (now - lastWheelSampleAt >= 120 || beforeViewportY === afterViewportY || handlerMs >= 16) {
      lastWheelSampleAt = now;
      logScrollDiagnostic("wheel", {
        route: "xterm-local-scrollLines",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        col: position.col,
        row: position.row,
        requestedLines: lines,
        movedRows: afterViewportY - beforeViewportY,
        handlerMs: Number(handlerMs.toFixed(2)),
        buffer: terminal.buffer.active.type,
        viewportY: afterViewportY,
        baseY: terminal.buffer.active.baseY,
        target: touchTargetName(event.target),
      });
    }
    event.preventDefault();
    return false;
  });
  let previousY: number | null = null;
  let touchStartX: number | null = null;
  let touchStartY: number | null = null;
  let activeTouchIdentifier: number | null = null;
  let lastTouchMoveY: number | null = null;
  let lastTouchMoveAt = 0;
  let touchVelocityPxPerMs = 0;
  let inertiaFrame = 0;
  let longPressTimer = 0;
  let longPressTriggered = false;
  let scrollTrace: ScrollTrace | null = null;
  let selectedRange: BufferRange | null = null;
  let dragHandle: "start" | "end" | null = null;
  const cancelTouchInertia = (): void => {
    if (inertiaFrame) window.cancelAnimationFrame(inertiaFrame);
    inertiaFrame = 0;
  };
  const startTouchInertia = (
    velocity: number,
    target: EventTarget | null,
    position: { col: number; row: number },
    initialScrollPixels = 0,
  ): void => {
    cancelTouchInertia();
    if (
      Math.abs(velocity) < TOUCH_INERTIA_MIN_VELOCITY
      && Math.abs(initialScrollPixels) < TOUCH_SCROLL_PIXELS_PER_LINE
    ) return;

    const startedAt = performance.now();
    let lastFrameAt = startedAt;
    let pixelRemainder = initialScrollPixels;
    let movedRows = 0;
    let maxFrameGapMs = 0;
    const maxRows = TOUCH_INERTIA_MAX_ROWS + Math.ceil(Math.abs(initialScrollPixels) / TOUCH_SCROLL_PIXELS_PER_LINE);
    logScrollDiagnostic("touch-inertia-start", {
      velocityPxPerMs: Number(velocity.toFixed(3)),
      initialScrollPixels: Number(initialScrollPixels.toFixed(1)),
      target: touchTargetName(target),
      viewportY: terminal.buffer.active.viewportY,
      baseY: terminal.buffer.active.baseY,
    });

    const finish = (reason: string, now: number): void => {
      cancelTouchInertia();
      logScrollDiagnostic("touch-inertia-end", {
        reason,
        durationMs: Number((now - startedAt).toFixed(1)),
        movedRows,
        maxFrameGapMs: Number(maxFrameGapMs.toFixed(1)),
        viewportY: terminal.buffer.active.viewportY,
        baseY: terminal.buffer.active.baseY,
      });
    };

    const step = (now: number): void => {
      const elapsed = Math.max(0, Math.min(32, now - lastFrameAt));
      maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrameAt);
      lastFrameAt = now;
      const decayedVelocity = velocity * Math.exp(-elapsed / TOUCH_INERTIA_FRICTION_MS);
      const scrollPixels = (velocity + decayedVelocity) * 0.5 * elapsed;
      velocity = decayedVelocity;
      pixelRemainder += scrollPixels;

      const requestedLines = Math.trunc(pixelRemainder / TOUCH_SCROLL_PIXELS_PER_LINE);
      if (requestedLines !== 0) {
        const lines = Math.max(-12, Math.min(12, requestedLines));
        const beforeViewportY = terminal.buffer.active.viewportY;
        watchScrollRender("inertia", position, scrollPixels, lines, target);
        terminal.scrollLines(lines);
        const actualLines = terminal.buffer.active.viewportY - beforeViewportY;
        pixelRemainder -= actualLines * TOUCH_SCROLL_PIXELS_PER_LINE;
        movedRows += Math.abs(actualLines);
        if (actualLines === 0) {
          finish("buffer-boundary", now);
          return;
        }
      }

      const durationMs = now - startedAt;
      if (durationMs >= TOUCH_INERTIA_MAX_DURATION_MS) {
        finish("duration-limit", now);
        return;
      }
      if (movedRows >= maxRows) {
        finish("row-limit", now);
        return;
      }
      if (Math.abs(velocity) < TOUCH_INERTIA_MIN_VELOCITY && Math.abs(pixelRemainder) < TOUCH_SCROLL_PIXELS_PER_LINE) {
        finish("friction", now);
        return;
      }
      inertiaFrame = window.requestAnimationFrame(step);
    };

    inertiaFrame = window.requestAnimationFrame(step);
  };
  const startHandle = host.ownerDocument.createElement("button");
  const endHandle = host.ownerDocument.createElement("button");
  for (const [handle, side] of [[startHandle, "start"], [endHandle, "end"]] as const) {
    handle.type = "button";
    handle.className = `dashboard-terminal-selection-handle is-${side}`;
    handle.dataset.terminalSelectionHandle = side;
    handle.setAttribute("aria-label", `Adjust selection ${side}`);
    handle.hidden = true;
    host.append(handle);
  }
  const clearLongPressTimer = (): void => {
    window.clearTimeout(longPressTimer);
    longPressTimer = 0;
  };
  const updateSelectionControls = (range: BufferRange | null): void => {
    selectedRange = range;
    if (!range) {
      startHandle.hidden = true;
      endHandle.hidden = true;
      onSelectionChange(null);
      return;
    }
    const text = terminal.getSelection();
    if (!text) {
      startHandle.hidden = true;
      endHandle.hidden = true;
      onSelectionChange(null);
      return;
    }
    setHandlePosition(terminal, host, startHandle, range.start);
    setHandlePosition(terminal, host, endHandle, range.end, true);
    const position = selectionDisplayPosition(terminal, host, range);
    onSelectionChange({ text, ...position });
  };
  const selectionChange = terminal.onSelectionChange(() => {
    if (!terminal.hasSelection()) updateSelectionControls(null);
  });
  const selectionScroll = terminal.onScroll((viewportY) => {
    if (selectedRange) updateSelectionControls(selectedRange);
    const now = performance.now();
    const movedRows = viewportY - lastObservedViewportY;
    lastObservedViewportY = viewportY;
    if (now - lastViewportSampleAt < 120) return;
    lastViewportSampleAt = now;
    logScrollDiagnostic("viewport", {
      movedRows,
      viewportY,
      baseY: terminal.buffer.active.baseY,
      buffer: terminal.buffer.active.type,
    });
  });
  const selectionResize = terminal.onResize(() => {
    if (selectedRange) updateSelectionControls(selectedRange);
  });
  const onTouchStart = (event: TouchEvent): void => {
    if (event.cancelable) event.preventDefault();
    if (activeTouchIdentifier !== null) return;
    clearLongPressTimer();
    const touch = event.changedTouches[0] ?? event.touches[0];
    if (!touch) {
      scrollTrace = null;
      return;
    }
    cancelTouchInertia();
    activeTouchIdentifier = touch.identifier;
    previousY = touch?.clientY ?? null;
    touchStartX = touch?.clientX ?? null;
    touchStartY = previousY;
    lastTouchMoveY = touch.clientY;
    lastTouchMoveAt = performance.now();
    touchVelocityPxPerMs = 0;
    longPressTriggered = false;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-selection-handle]")
      : null;
    const handleSide = target?.dataset.terminalSelectionHandle;
    if (selectedRange && (handleSide === "start" || handleSide === "end")) {
      scrollTrace = null;
      dragHandle = handleSide;
      event.preventDefault();
      return;
    }
    dragHandle = null;
    if (selectedRange) {
      updateSelectionControls(null);
      terminal.clearSelection();
    }
    if (!touch) {
      scrollTrace = null;
      return;
    }
    const startX = touch.clientX;
    const startY = touch.clientY;
    const startCell = cellPosition(terminal, host, startX, startY);
    const buffer = terminal.buffer.active;
    const startedAt = performance.now();
    scrollTrace = {
      startedAt,
      startX,
      startY,
      startCell,
      startViewportY: buffer.viewportY,
      startBaseY: buffer.baseY,
      startPageScrollY: window.scrollY,
      startBuffer: buffer.type,
      target: touchTargetName(event.target),
      lastSampleAt: 0,
      lastMoveAt: startedAt,
      moves: 0,
      requestedLines: 0,
      actualRows: 0,
      maxHandlerMs: 0,
    };
    longPressTimer = window.setTimeout(() => {
      longPressTimer = 0;
      const range = longPressRange(terminal, host, startX, startY);
      if (!range) return;
      longPressTriggered = true;
      selectBufferRange(terminal, range);
      updateSelectionControls(range);
    }, LONG_PRESS_DELAY_MS);
  };
  const onTouchMove = (event: TouchEvent): void => {
    const touch = Array.from(event.touches).find((candidate) => candidate.identifier === activeTouchIdentifier);
    if (!touch || previousY === null) return;
    if (event.cancelable) event.preventDefault();
    if (
      !longPressTriggered
      && touchStartX !== null
      && touchStartY !== null
      && Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY) >= 10
    ) clearLongPressTimer();

    if (dragHandle && selectedRange) {
      const position = bufferCellPosition(terminal, host, touch.clientX, touch.clientY);
      const maxOffset = Math.max(0, terminal.buffer.active.length * terminal.cols - 1);
      const offset = Math.max(0, Math.min(maxOffset, position.row * terminal.cols + position.column));
      const range = dragHandle === "start"
        ? { start: Math.min(offset, selectedRange.end - 1), end: selectedRange.end }
        : { start: selectedRange.start, end: Math.max(selectedRange.start + 1, offset + 1) };
      selectBufferRange(terminal, range);
      updateSelectionControls(range);
      previousY = touch.clientY;
      event.preventDefault();
      return;
    }

    if (longPressTriggered && selectedRange) {
      const position = bufferCellPosition(terminal, host, touch.clientX, touch.clientY);
      const offset = position.row * terminal.cols + position.column;
      const range = {
        start: Math.min(selectedRange.start, offset),
        end: Math.max(selectedRange.end, offset + 1),
      };
      selectBufferRange(terminal, range);
      updateSelectionControls(range);
      previousY = touch.clientY;
      event.preventDefault();
      return;
    }

    const now = performance.now();
    const velocityDelta = lastTouchMoveY === null ? 0 : lastTouchMoveY - touch.clientY;
    const velocityInterval = now - lastTouchMoveAt;
    if (velocityInterval > 0 && velocityInterval <= 100) {
      const sampleVelocity = Math.max(
        -TOUCH_VELOCITY_MAX_PX_PER_MS,
        Math.min(TOUCH_VELOCITY_MAX_PX_PER_MS, velocityDelta / velocityInterval),
      );
      touchVelocityPxPerMs = touchVelocityPxPerMs * 0.35 + sampleVelocity * 0.65;
    } else {
      touchVelocityPxPerMs = 0;
    }
    lastTouchMoveY = touch.clientY;
    lastTouchMoveAt = now;

    const delta = previousY - touch.clientY;
    if (Math.abs(delta) < 8) return;
    const lines = Math.min(12, Math.max(1, Math.round(Math.abs(delta) / TOUCH_SCROLL_PIXELS_PER_LINE)));
    const direction = delta > 0 ? 1 : -1;
    const beforeViewportY = terminal.buffer.active.viewportY;
    const cell = cellPosition(terminal, host, touch.clientX, touch.clientY);
    const handlerStartedAt = performance.now();
    watchScrollRender("touch", cell, delta, lines, event.target);
    terminal.scrollLines(direction * lines);
    const handlerMs = performance.now() - handlerStartedAt;
    const afterViewportY = terminal.buffer.active.viewportY;
    if (scrollTrace) {
      if (scrollTrace.moves === 0) {
        logScrollDiagnostic("touch-start", {
          x: scrollTrace.startX,
          y: scrollTrace.startY,
          col: scrollTrace.startCell.col,
          row: scrollTrace.startCell.row,
          target: scrollTrace.target,
          buffer: scrollTrace.startBuffer,
          viewportY: scrollTrace.startViewportY,
          baseY: scrollTrace.startBaseY,
          pageScrollY: scrollTrace.startPageScrollY,
          mouseTrackingMode: terminal.modes.mouseTrackingMode,
        });
      }
      const eventGapMs = now - scrollTrace.lastMoveAt;
      scrollTrace.moves += 1;
      scrollTrace.requestedLines += lines;
      scrollTrace.actualRows += afterViewportY - beforeViewportY;
      scrollTrace.maxHandlerMs = Math.max(scrollTrace.maxHandlerMs, handlerMs);
      if (now - scrollTrace.lastSampleAt >= 120 || handlerMs >= 16) {
        scrollTrace.lastSampleAt = now;
        logScrollDiagnostic("touch-move", {
          elapsedMs: Number((now - scrollTrace.startedAt).toFixed(1)),
          eventGapMs: Number(eventGapMs.toFixed(1)),
          x: touch.clientX,
          y: touch.clientY,
          col: cell.col,
          row: cell.row,
          deltaYpx: Number(delta.toFixed(1)),
          direction: direction > 0 ? "up" : "down",
          requestedLines: lines,
          movedRows: afterViewportY - beforeViewportY,
          handlerMs: Number(handlerMs.toFixed(2)),
          buffer: terminal.buffer.active.type,
          viewportY: afterViewportY,
          baseY: terminal.buffer.active.baseY,
          pageScrollY: window.scrollY,
          documentScrollTop: host.ownerDocument.documentElement.scrollTop,
          defaultPrevented: event.defaultPrevented,
          target: scrollTrace.target,
        });
      }
      scrollTrace.lastMoveAt = now;
    }
    previousY = touch.clientY;
    event.preventDefault();
  };
  const onTouchEnd = (event: TouchEvent): void => {
    const endedTouch = Array.from(event.changedTouches).find((touch) => touch.identifier === activeTouchIdentifier);
    if (!endedTouch) return;
    clearLongPressTimer();
    const now = performance.now();
    const canFinishScroll = event.type === "touchend" && !longPressTriggered && !dragHandle && previousY !== null;
    const finalDelta = previousY === null ? 0 : previousY - endedTouch.clientY;
    let finalRequestedLines = 0;
    let finalScrollPixels = 0;
    if (canFinishScroll && scrollTrace && Math.abs(finalDelta) >= 8) {
      const maxFinalLines = Math.max(TOUCH_END_MAX_SCROLL_LINES, terminal.rows);
      finalRequestedLines = Math.min(
        maxFinalLines,
        Math.max(1, Math.round(Math.abs(finalDelta) / TOUCH_SCROLL_PIXELS_PER_LINE)),
      );
      finalScrollPixels = Math.sign(finalDelta) * finalRequestedLines * TOUCH_SCROLL_PIXELS_PER_LINE;
      logScrollDiagnostic("touch-final-delta", {
        deltaYpx: Number(finalDelta.toFixed(1)),
        requestedLines: finalRequestedLines,
        queuedScrollPixels: finalScrollPixels,
        queuedForInertia: true,
        viewportY: terminal.buffer.active.viewportY,
        target: touchTargetName(event.target),
      });
    }

    const finalVelocityDelta = (lastTouchMoveY ?? endedTouch.clientY) - endedTouch.clientY;
    const finalVelocityInterval = now - lastTouchMoveAt;
    const hasRecentEndVelocity = finalVelocityInterval > 0
      && finalVelocityInterval <= 1_500
      && Math.abs(finalVelocityDelta) >= 8;
    const releaseVelocity = hasRecentEndVelocity
      ? Math.max(
        -TOUCH_VELOCITY_MAX_PX_PER_MS,
        Math.min(TOUCH_VELOCITY_MAX_PX_PER_MS, finalVelocityDelta / finalVelocityInterval),
      )
      : touchVelocityPxPerMs * Math.exp(-Math.max(0, finalVelocityInterval) / TOUCH_INERTIA_FRICTION_MS);
    const hasScrollMovement = Boolean(scrollTrace && (scrollTrace.moves > 0 || finalRequestedLines > 0));
    const shouldStartInertia = event.type === "touchend"
      && event.touches.length === 0
      && !longPressTriggered
      && !dragHandle
      && hasScrollMovement
      && (finalRequestedLines > 0 || Math.abs(releaseVelocity) >= TOUCH_INERTIA_MIN_VELOCITY);
    const inertiaPosition = cellPosition(terminal, host, endedTouch.clientX, endedTouch.clientY);
    if (scrollTrace && hasScrollMovement) {
      const endCell = cellPosition(terminal, host, endedTouch.clientX, endedTouch.clientY);
      logScrollDiagnostic("touch-end", {
        durationMs: Number((now - scrollTrace.startedAt).toFixed(1)),
        start: { x: scrollTrace.startX, y: scrollTrace.startY, ...scrollTrace.startCell },
        end: { x: endedTouch.clientX, y: endedTouch.clientY, ...endCell },
        target: scrollTrace.target,
        endType: event.type,
        moves: scrollTrace.moves,
        requestedLines: scrollTrace.requestedLines,
        actualRows: scrollTrace.actualRows,
        netViewportRows: terminal.buffer.active.viewportY - scrollTrace.startViewportY,
        finalDeltaYpx: Number(finalDelta.toFixed(1)),
        finalRequestedLines,
        finalScrollQueued: finalRequestedLines > 0,
        startBaseY: scrollTrace.startBaseY,
        endBaseY: terminal.buffer.active.baseY,
        startPageScrollY: scrollTrace.startPageScrollY,
        endPageScrollY: window.scrollY,
        documentScrollTop: host.ownerDocument.documentElement.scrollTop,
        maxHandlerMs: Number(scrollTrace.maxHandlerMs.toFixed(2)),
        buffer: terminal.buffer.active.type,
        mouseTrackingMode: terminal.modes.mouseTrackingMode,
        inertiaVelocityPxPerMs: Number(releaseVelocity.toFixed(3)),
        inertiaVelocitySource: hasRecentEndVelocity ? "touchend-final-segment" : "decayed-touchmove",
        willStartInertia: shouldStartInertia,
      });
    }
    const inertiaTarget = event.target instanceof Element ? event.target : host;
    scrollTrace = null;
    previousY = null;
    touchStartX = null;
    touchStartY = null;
    activeTouchIdentifier = null;
    lastTouchMoveY = null;
    lastTouchMoveAt = 0;
    touchVelocityPxPerMs = 0;
    longPressTriggered = false;
    dragHandle = null;
    if (shouldStartInertia) {
      startTouchInertia(releaseVelocity, inertiaTarget, inertiaPosition, finalScrollPixels);
    }
    else cancelTouchInertia();
  };
  host.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
  host.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  host.ownerDocument.addEventListener("touchend", onTouchEnd, true);
  host.ownerDocument.addEventListener("touchcancel", onTouchEnd, true);
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  const screenRect = screen?.getBoundingClientRect();
  logScrollDiagnostic("attached", {
    cols: terminal.cols,
    rows: terminal.rows,
    buffer: terminal.buffer.active.type,
    viewportY: terminal.buffer.active.viewportY,
    baseY: terminal.buffer.active.baseY,
    mouseTrackingMode: terminal.modes.mouseTrackingMode,
    screenWidth: screenRect?.width ?? 0,
    screenHeight: screenRect?.height ?? 0,
  });
  return () => {
    clearLongPressTimer();
    cancelTouchInertia();
    selectionChange.dispose();
    selectionScroll.dispose();
    selectionResize.dispose();
    renderListener.dispose();
    pendingScrollRender = null;
    startHandle.remove();
    endHandle.remove();
    onSelectionChange(null);
    host.removeEventListener("touchstart", onTouchStart, true);
    host.removeEventListener("touchmove", onTouchMove, true);
    host.ownerDocument.removeEventListener("touchend", onTouchEnd, true);
    host.ownerDocument.removeEventListener("touchcancel", onTouchEnd, true);
  };
}
