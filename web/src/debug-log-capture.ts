type ConsoleLevel = "debug" | "info" | "log" | "warn" | "error";

type DebugWindow = Window & {
  __tmuxDebugLog?: string[];
  /** Kept as a compatibility alias for the vConsole panel from older builds. */
  __tmuxKeyboardLog?: string[];
  __tmuxDebugLogPaused?: boolean;
  __tmuxKeyboardPaused?: boolean;
};

type ConsoleFunction = (...args: unknown[]) => void;
type CaptureListener = (active: boolean) => void;

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["debug", "info", "log", "warn", "error"];
const MAX_LOG_ENTRIES = 3_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let active = false;
let entries: string[] = [];
let entryBytes = 0;
let originalConsole: Partial<Record<ConsoleLevel, ConsoleFunction>> | null = null;
const listeners = new Set<CaptureListener>();

function debugWindow(): DebugWindow | null {
  return typeof window === "undefined" ? null : window as DebugWindow;
}

function isPaused(): boolean {
  const currentWindow = debugWindow();
  return Boolean(currentWindow?.__tmuxDebugLogPaused ?? currentWindow?.__tmuxKeyboardPaused);
}

function notify(activeState: boolean): void {
  for (const listener of listeners) listener(activeState);
}

function safeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (depth >= 4) return "[MaxDepth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeValue(item, seen, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = safeValue(item, seen, depth + 1);
  }
  return result;
}

function formatConsoleEntry(level: ConsoleLevel, args: unknown[]): string {
  let serialized: string;
  try {
    serialized = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      args: args.map((value) => safeValue(value, new WeakSet<object>(), 0)),
    });
  } catch (error) {
    serialized = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      args: [`[Unserializable: ${error instanceof Error ? error.message : "unknown error"}]`],
    });
  }
  return serialized.length > 64 * 1024 ? serialized.slice(0, 64 * 1024) + "...[truncated]" : serialized;
}

function appendEntry(entry: string): void {
  if (!active || isPaused()) return;
  entries.push(entry);
  entryBytes += entry.length + 1;
  while (entries.length > MAX_LOG_ENTRIES || entryBytes > MAX_LOG_BYTES) {
    const removed = entries.shift();
    if (removed === undefined) break;
    entryBytes -= removed.length + 1;
  }
  const currentWindow = debugWindow();
  if (currentWindow) {
    currentWindow.__tmuxDebugLog = entries;
    currentWindow.__tmuxKeyboardLog = entries;
  }
}

function installConsoleCapture(): void {
  if (originalConsole) return;
  const currentConsole = console as unknown as Record<ConsoleLevel, ConsoleFunction>;
  originalConsole = {};
  for (const level of CONSOLE_LEVELS) {
    const original = currentConsole[level];
    originalConsole[level] = original;
    currentConsole[level] = ((...args: unknown[]) => {
      appendEntry(formatConsoleEntry(level, args));
      original.apply(console, args);
    }) as ConsoleFunction;
  }
}

function restoreConsole(): void {
  if (!originalConsole) return;
  const currentConsole = console as unknown as Record<ConsoleLevel, ConsoleFunction>;
  for (const level of CONSOLE_LEVELS) {
    const original = originalConsole[level];
    if (original) currentConsole[level] = original;
  }
  originalConsole = null;
}

export function isDebugLogCaptureActive(): boolean {
  return active;
}

export function isDebugLogCapturePaused(): boolean {
  return isPaused();
}

export function logDebugDiagnostic(scope: string, event: string, details: Record<string, unknown> = {}): void {
  if (!active || isPaused()) return;
  console.info(`[${scope}] ` + JSON.stringify({ event, ...details }));
}

export function subscribeDebugLogCapture(listener: CaptureListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginDebugLogCapture(): boolean {
  if (active) return false;
  entries = [];
  entryBytes = 0;
  active = true;
  const currentWindow = debugWindow();
  if (currentWindow) {
    currentWindow.__tmuxDebugLog = entries;
    currentWindow.__tmuxKeyboardLog = entries;
    currentWindow.__tmuxDebugLogPaused = false;
    currentWindow.__tmuxKeyboardPaused = false;
  }
  installConsoleCapture();
  console.log("[tmux-debug] capture-start");
  notify(true);
  return true;
}

export function finishDebugLogCapture(): File | null {
  if (!active) return null;
  console.log("[tmux-debug] capture-finish");
  const logText = entries.join("\n") + (entries.length > 0 ? "\n" : "");
  active = false;
  restoreConsole();
  const currentWindow = debugWindow();
  if (currentWindow) {
    currentWindow.__tmuxDebugLogPaused = true;
    currentWindow.__tmuxKeyboardPaused = true;
  }
  notify(false);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([logText], `tmux-debug-${stamp}.log`, { type: "text/plain;charset=utf-8" });
}

export function cancelDebugLogCapture(): void {
  if (!active) return;
  active = false;
  restoreConsole();
  const currentWindow = debugWindow();
  if (currentWindow) {
    currentWindow.__tmuxDebugLogPaused = true;
    currentWindow.__tmuxKeyboardPaused = true;
  }
  notify(false);
}
