import type { ShortcutStore } from "./tmux-shortcuts.js";
import { getBridgeOrigin } from "./mobile-runtime.js";

const CACHE_KEY = "feishu-codex-bridge.shortcut-config.v1";
const REVISION_KEY = "feishu-codex-bridge.shortcut-config.revision";
const CHANGE_EVENT = "feishu-codex-bridge:shortcut-config-invalidated";
let inMemoryRevision = 0;
let memory: { revision: string; store: ShortcutStore } | null = null;
let pending: { revision: string; promise: Promise<ShortcutStore> } | null = null;

type CacheEntry = { version: 1; cachedAt: number; store: ShortcutStore };

function scope(): string {
  return typeof window === "undefined" ? "" : getBridgeOrigin();
}

function storageKey(key: string): string {
  return `${key}:${encodeURIComponent(scope())}`;
}

function isShortcutStore(value: unknown): value is ShortcutStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ShortcutStore>;
  return Array.isArray(candidate.groups)
    && candidate.groups.every((group) => (
      typeof group === "object" && group !== null
      && typeof group.id === "string"
      && typeof group.enabled === "boolean"
      && (group.surface === "composer" || group.surface === "palette")
    ))
    && Array.isArray(candidate.shortcuts)
    && candidate.shortcuts.every((shortcut) => (
      typeof shortcut === "object" && shortcut !== null
      && typeof shortcut.id === "string"
      && typeof shortcut.groupId === "string"
      && typeof shortcut.enabled === "boolean"
      && typeof shortcut.sortOrder === "number"
    ));
}

export function readShortcutConfigRevision(): string {
  let storedRevision = "";
  try { storedRevision = window.localStorage.getItem(storageKey(REVISION_KEY)) ?? ""; } catch { /* Use the in-memory revision. */ }
  return `${scope()}:${inMemoryRevision}:${storedRevision}`;
}

/** Shared by every Session; retained until a local edit or an explicit management refresh. */
export function readShortcutConfigCache(): ShortcutStore | null {
  const revision = readShortcutConfigRevision();
  if (memory?.revision === revision) return memory.store;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(CACHE_KEY));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    if (entry.version !== 1 || !isShortcutStore(entry.store)) {
      window.localStorage.removeItem(storageKey(CACHE_KEY));
      return null;
    }
    memory = { revision, store: entry.store };
    return entry.store;
  } catch {
    return null;
  }
}

export function writeShortcutConfigCache(store: ShortcutStore): void {
  memory = { revision: readShortcutConfigRevision(), store };
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(CACHE_KEY), JSON.stringify({ version: 1, cachedAt: Date.now(), store } satisfies CacheEntry));
  } catch {
    // Keep the shared memory cache when storage is unavailable or full.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function loadShortcutConfig(load: () => Promise<ShortcutStore>, force = false): Promise<ShortcutStore> {
  const cached = force ? null : readShortcutConfigCache();
  if (cached) return Promise.resolve(cached);
  const revision = readShortcutConfigRevision();
  if (pending?.revision === revision) return pending.promise;
  const originalScope = scope();
  const promise = load().then((store) => {
    if (originalScope !== scope()) throw new DOMException("Bridge connection changed", "AbortError");
    // A response started before an edit must never replace the newer configuration.
    if (revision !== readShortcutConfigRevision()) return loadShortcutConfig(load);
    writeShortcutConfigCache(store);
    return store;
  }).finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  pending = { revision, promise };
  return promise;
}

export function invalidateShortcutConfigCache(): void {
  inMemoryRevision += 1;
  memory = null;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(CACHE_KEY));
    window.localStorage.setItem(storageKey(REVISION_KEY), `${Date.now()}:${Math.random().toString(36).slice(2)}`);
  } catch {
    // The in-tab notification still refreshes consumers when storage is blocked.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeShortcutConfigInvalidation(onInvalidated: () => void, includeSameTab = true): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent): void => {
    if (event.key === storageKey(REVISION_KEY) || event.key === storageKey(CACHE_KEY) || event.key === null) {
      memory = null;
      onInvalidated();
    }
  };
  const onChange = (): void => onInvalidated();
  window.addEventListener("storage", onStorage);
  if (includeSameTab) window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    if (includeSameTab) window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
