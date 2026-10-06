import type { ShortcutStore } from "./tmux-shortcuts.js";

const CACHE_KEY = "feishu-codex-bridge.shortcut-config.v1";
const REVISION_KEY = "feishu-codex-bridge.shortcut-config.revision";
const CHANGE_EVENT = "feishu-codex-bridge:shortcut-config-invalidated";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
let inMemoryRevision = 0;
let lastServerRevision: string | null = null;

type CacheEntry = {
  version: 1;
  cachedAt: number;
  store: ShortcutStore;
};

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

export function readShortcutConfigCache(): ShortcutStore | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    const age = Date.now() - Number(entry.cachedAt);
    if (entry.version !== 1 || !Number.isFinite(entry.cachedAt) || age < 0 || age > CACHE_TTL_MS || !isShortcutStore(entry.store)) {
      window.localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return entry.store;
  } catch {
    try { window.localStorage.removeItem(CACHE_KEY); } catch { /* Browser storage may be unavailable. */ }
    return null;
  }
}

export function writeShortcutConfigCache(store: ShortcutStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, cachedAt: Date.now(), store } satisfies CacheEntry));
  } catch {
    // Cached configuration is an optimization; API reads remain authoritative.
  }
}

export function readShortcutConfigRevision(): string {
  let storedRevision = "";
  try { storedRevision = window.localStorage.getItem(REVISION_KEY) ?? ""; } catch { /* Use the in-memory revision. */ }
  return `${inMemoryRevision}:${storedRevision}`;
}

export function recordShortcutConfigServerRevision(revision: string): void {
  if (/^[0-9a-f]{64}$/i.test(revision)) lastServerRevision = revision;
}

export function observeShortcutConfigServerRevision(revision: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(revision)) return false;
  if (lastServerRevision === null) {
    lastServerRevision = revision;
    return false;
  }
  if (lastServerRevision === revision) return false;
  lastServerRevision = revision;
  invalidateShortcutConfigCache();
  return true;
}

export function invalidateShortcutConfigCache(): void {
  if (typeof window === "undefined") return;
  inMemoryRevision += 1;
  try {
    window.localStorage.removeItem(CACHE_KEY);
    window.localStorage.setItem(REVISION_KEY, `${Date.now()}:${Math.random().toString(36).slice(2)}`);
  } catch {
    // The in-tab notification still refreshes consumers when storage is blocked.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeShortcutConfigInvalidation(onInvalidated: () => void, includeSameTab = true): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent): void => {
    if (event.key === REVISION_KEY) onInvalidated();
  };
  const onChange = (): void => onInvalidated();
  window.addEventListener("storage", onStorage);
  if (includeSameTab) window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    if (includeSameTab) window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
