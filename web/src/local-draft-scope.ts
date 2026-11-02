// Keep the authenticated namespace while Vite replaces this module. Composer
// effects can restart before auth revalidation runs again.
const draftScopeState: { value: string | null } = import.meta.hot?.data.draftScopeState ?? { value: null };
if (import.meta.hot) import.meta.hot.data.draftScopeState = draftScopeState;
export const LOCAL_DRAFT_SCOPE_EVENT = "bridge:draft-scope-change";
function changeScope(next: string | null): void {
  if (next === draftScopeState.value) return;
  draftScopeState.value = next;
  if (typeof window !== "undefined") window.dispatchEvent?.(new Event(LOCAL_DRAFT_SCOPE_EVENT));
}

/** The server derives this opaque value from the installation and current device session. */
export function setLocalDraftScope(value: string | null | undefined, server?: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    changeScope(null);
    return;
  }
  // Callers handling App auth must supply the API origin, not the WebView origin.
  // No credential is included. The opaque server value already binds instance + device.
  // Browser storage is already origin-isolated; keep its existing opaque scope
  // so upgrading the browser frontend does not orphan previously scoped drafts.
  const origin = server ?? "";
  changeScope(origin ? `${encodeURIComponent(new URL(origin).origin)}:${value}` : value);
}

const STORAGE_PREFIX = "bridge:scoped:v1:";
export function scopedStorageKey(category: string, id = "", scope = draftScopeState.value): string | null {
  return scope ? `${STORAGE_PREFIX}${encodeURIComponent(scope)}:${category}:${encodeURIComponent(id)}` : null;
}

/** Only the current device/environment is cleared; theme and other environments survive. */
export function clearScopedClientStorage(): void {
  const prefix = draftScopeState.value ? `${STORAGE_PREFIX}${encodeURIComponent(draftScopeState.value)}:` : null;
  if (typeof window === "undefined") return;
  // Legacy data cannot be attributed safely. Never auto-import it; remove it on
  // explicit logout/revocation together with the current sensitive namespace.
  const legacyPrefixes = ["bridge:web-cache:v1:", "bridge-task-draft:", "feishu-codex-bridge:tmux-draft:",
    "feishu-codex-bridge.codex-history-detail.v1:", "bridge.codex-skill-cache.v1:"];
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[name];
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (key && ((prefix && key.startsWith(prefix)) || legacyPrefixes.some((item) => key.startsWith(item))
          || key === "bridge:last-known-authenticated")) storage.removeItem(key);
      }
    } catch { /* Storage cleanup must not prevent local credential removal. */ }
  }
}

export function getLocalDraftScope(): string | null {
  return draftScopeState.value;
}
