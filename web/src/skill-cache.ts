export const CODEX_SKILL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

interface SkillCacheEntry<T> {
  savedAt: number;
  value: T;
}
const memoryCache = new Map<string, SkillCacheEntry<unknown>>();

function storageKey(cacheKey: string): string {
  return `bridge.codex-skill-cache.v1:${encodeURIComponent(cacheKey)}`;
}

export function readCodexSkillCache<T>(
  cacheKey: string,
  isValue: (value: unknown) => value is T,
): T | null {
  const now = Date.now();
  const memoryEntry = memoryCache.get(cacheKey);
  if (memoryEntry) {
    if (now - memoryEntry.savedAt <= CODEX_SKILL_CACHE_TTL_MS && isValue(memoryEntry.value)) {
      return memoryEntry.value;
    }
    memoryCache.delete(cacheKey);
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SkillCacheEntry<unknown>>;
    if (
      typeof parsed.savedAt !== "number"
      || now - parsed.savedAt > CODEX_SKILL_CACHE_TTL_MS
      || !isValue(parsed.value)
    ) {
      window.localStorage.removeItem(storageKey(cacheKey));
      return null;
    }
    memoryCache.set(cacheKey, { savedAt: parsed.savedAt, value: parsed.value });
    return parsed.value;
  } catch {
    return null;
  }
}

export function writeCodexSkillCache<T>(cacheKey: string, value: T): void {
  const entry: SkillCacheEntry<T> = { savedAt: Date.now(), value };
  memoryCache.set(cacheKey, entry);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(cacheKey), JSON.stringify(entry));
  } catch {
    // Keep the in-memory cache when browser storage is unavailable or full.
  }
}

export function clearCodexSkillCache(cacheKey: string): void {
  memoryCache.delete(cacheKey);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(cacheKey));
  } catch {
    // Browser storage may be unavailable.
  }
}
