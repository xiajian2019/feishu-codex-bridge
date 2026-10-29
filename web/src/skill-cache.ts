import { getLocalDraftScope, scopedStorageKey } from "./local-draft-scope.js";

export const CODEX_SKILL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

interface SkillCacheEntry<T> {
  savedAt: number;
  value: T;
}
const memoryCache = new Map<string, SkillCacheEntry<unknown>>();

function storageKey(cacheKey: string): string | null {
  return scopedStorageKey("skill-cache", cacheKey);
}

export function clearSkillMemoryCache(): void { memoryCache.clear(); }

export function readCodexSkillCache<T>(
  cacheKey: string,
  isValue: (value: unknown) => value is T,
): T | null {
  const now = Date.now();
  const key = storageKey(cacheKey);
  if (!key) return null;
  const memoryEntry = memoryCache.get(key);
  if (memoryEntry) {
    if (now - memoryEntry.savedAt <= CODEX_SKILL_CACHE_TTL_MS && isValue(memoryEntry.value)) {
      return memoryEntry.value;
    }
    memoryCache.delete(key);
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SkillCacheEntry<unknown>>;
    if (
      typeof parsed.savedAt !== "number"
      || now - parsed.savedAt > CODEX_SKILL_CACHE_TTL_MS
      || !isValue(parsed.value)
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    memoryCache.set(key, { savedAt: parsed.savedAt, value: parsed.value });
    return parsed.value;
  } catch {
    return null;
  }
}

export function writeCodexSkillCache<T>(cacheKey: string, value: T, expectedScope = getLocalDraftScope()): void {
  if (getLocalDraftScope() !== expectedScope) return;
  const key = storageKey(cacheKey);
  if (!key) return;
  const entry: SkillCacheEntry<T> = { savedAt: Date.now(), value };
  memoryCache.set(key, entry);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Keep the in-memory cache when browser storage is unavailable or full.
  }
}

export function clearCodexSkillCache(cacheKey: string): void {
  const key = storageKey(cacheKey);
  if (!key) return;
  memoryCache.delete(key);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Browser storage may be unavailable.
  }
}
