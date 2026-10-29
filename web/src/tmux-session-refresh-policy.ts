export const SESSION_LIST_LIFECYCLE_REFRESH_MAX_AGE_MS = 60_000;

export function isSessionListRefreshStale(
  lastLoadedAt: number,
  now = Date.now(),
  maxAgeMs = SESSION_LIST_LIFECYCLE_REFRESH_MAX_AGE_MS,
): boolean {
  return lastLoadedAt <= 0 || now - lastLoadedAt >= maxAgeMs;
}

export function shouldRefreshSessionListOnVisibilityChange(
  previous: DocumentVisibilityState,
  current: DocumentVisibilityState,
  lastLoadedAt: number,
  now = Date.now(),
): boolean {
  return previous === "hidden"
    && current === "visible"
    && isSessionListRefreshStale(lastLoadedAt, now);
}

export function shouldRefreshSessionListOnPageShow(
  persisted: boolean,
  visibility: DocumentVisibilityState,
  lastLoadedAt: number,
  now = Date.now(),
): boolean {
  return persisted
    && visibility === "visible"
    && isSessionListRefreshStale(lastLoadedAt, now);
}
