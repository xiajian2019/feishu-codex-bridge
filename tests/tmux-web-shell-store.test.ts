import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearTmuxWebShellState, loadTmuxWebShellState, saveTmuxWebShellState } from "../web/src/tmux-web-shell-store.js";
import { scopedStorageKey, setLocalDraftScope } from "../web/src/local-draft-scope.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let localStorage: Storage;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  };
}

beforeEach(() => {
  localStorage = memoryStorage();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  setLocalDraftScope("a".repeat(43), "https://bridge.fixture");
});

afterEach(() => {
  setLocalDraftScope(null);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("tmux web shell state", () => {
  it("persists visibility per Session incarnation", () => {
    saveTmuxWebShellState("$1", 10, { visible: true });
    saveTmuxWebShellState("$2", 20, { visible: false });

    expect(loadTmuxWebShellState("$1", 10)).toEqual({ visible: true });
    expect(loadTmuxWebShellState("$2", 20)).toEqual({ visible: false });
    expect(loadTmuxWebShellState("$1", 11)).toBeNull();

    clearTmuxWebShellState("$1", 10);
    expect(loadTmuxWebShellState("$1", 10)).toBeNull();
    expect(loadTmuxWebShellState("$2", 20)).toEqual({ visible: false });
  });

  it("isolates state by authenticated Bridge scope and rejects malformed records", () => {
    saveTmuxWebShellState("$1", 10, { visible: true });
    const key = scopedStorageKey("tmux-web-shell", JSON.stringify(["$2", 20]));
    expect(key).not.toBeNull();
    localStorage.setItem(key!, JSON.stringify({ version: 99, visible: true }));
    expect(loadTmuxWebShellState("$2", 20)).toBeNull();
    expect(localStorage.getItem(key!)).toBeNull();

    setLocalDraftScope("b".repeat(43), "https://other.fixture");
    expect(loadTmuxWebShellState("$1", 10)).toBeNull();
    saveTmuxWebShellState("$1", 10, { visible: false });

    setLocalDraftScope("a".repeat(43), "https://bridge.fixture");
    expect(loadTmuxWebShellState("$1", 10)).toEqual({ visible: true });
  });

  it("does not write without an authenticated scope", () => {
    setLocalDraftScope(null);
    saveTmuxWebShellState("$1", 10, { visible: true });
    expect(localStorage.length).toBe(0);
    expect(loadTmuxWebShellState("$1", 10)).toBeNull();
  });
});
