import { scopedStorageKey } from "./local-draft-scope.js";

export type TmuxWebShellState = {
  visible: boolean;
};

type StoredTmuxWebShellState = TmuxWebShellState & {
  version: 1;
};

function storageKey(sessionId: string, sessionCreatedAt: number): string | null {
  if (!sessionId || !Number.isFinite(sessionCreatedAt)) return null;
  return scopedStorageKey("tmux-web-shell", JSON.stringify([sessionId, sessionCreatedAt]));
}

export function loadTmuxWebShellState(sessionId: string, sessionCreatedAt: number): TmuxWebShellState | null {
  const key = storageKey(sessionId, sessionCreatedAt);
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTmuxWebShellState>;
    if (parsed.version !== 1 || typeof parsed.visible !== "boolean") {
      window.localStorage.removeItem(key);
      return null;
    }
    return { visible: parsed.visible };
  } catch {
    return null;
  }
}

export function saveTmuxWebShellState(sessionId: string, sessionCreatedAt: number, state: TmuxWebShellState): void {
  const key = storageKey(sessionId, sessionCreatedAt);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, visible: state.visible } satisfies StoredTmuxWebShellState));
  } catch {
    // Private browsing or a full storage quota must not block the terminal.
  }
}

export function clearTmuxWebShellState(sessionId: string, sessionCreatedAt: number): void {
  const key = storageKey(sessionId, sessionCreatedAt);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore unavailable local storage.
  }
}
