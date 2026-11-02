import { useSyncExternalStore } from "react";
import { scopedStorageKey } from "./local-draft-scope.js";

export type BridgeApiState = "unknown" | "checking" | "connected" | "unreachable" | "stale";
export type BridgeFailureKind = "browser-offline" | "api-network-unreachable" | "api-auth-failed" | "api-response-error" | "target-unreachable" | null;
export type BridgeTargetState = "unknown" | "reachable" | "unreachable";

export interface BridgeConnectionSnapshot {
  browserOnline: boolean;
  api: BridgeApiState;
  failureKind: BridgeFailureKind;
  target: BridgeTargetState;
  pending: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

const listeners = new Set<() => void>();
const initialOnline = typeof navigator === "undefined" || navigator.onLine !== false;
let snapshot: BridgeConnectionSnapshot = {
  browserOnline: initialOnline,
  api: initialOnline ? "unknown" : "unreachable",
  failureKind: initialOnline ? null : "browser-offline",
  target: "unknown",
  pending: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
};
let installed = false;
const apiUnreachableListeners = new Set<(snapshot: BridgeConnectionSnapshot) => void>();

function publish(next: BridgeConnectionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function installBrowserListeners(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("offline", () => {
    publish({ ...snapshot, browserOnline: false, api: "unreachable", failureKind: "browser-offline", target: "unknown", lastError: "当前设备已离线。页面会保留最近数据。" });
  });
  window.addEventListener("online", () => {
    publish({ ...snapshot, browserOnline: true, api: "checking", failureKind: null, target: "unknown", lastError: null });
  });
  window.addEventListener("bridge:mobile-vpn-target-unreachable", () => {
    if (!snapshot.browserOnline) return;
    publish({ ...snapshot, api: "unreachable", failureKind: "target-unreachable", target: "unreachable", lastError: "目标主机端口不可达，正在尝试 VPN。" });
  });
  window.addEventListener("bridge:mobile-vpn-reachable", () => {
    publish({ ...snapshot, browserOnline: true, api: "checking", failureKind: null, target: "reachable", lastError: null });
  });
}

export function subscribeBridgeConnection(listener: () => void): () => void {
  installBrowserListeners();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBridgeConnectionSnapshot(): BridgeConnectionSnapshot {
  installBrowserListeners();
  return snapshot;
}

/** navigator.onLine is only a browser hint; a successful Bridge request is stronger evidence. */
export function bridgeTransportMayBeReachable(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false || snapshot.api === "connected";
}

/** Global hook used by the mobile runtime; browser builds have no native side effect. */
export function subscribeBridgeApiUnreachable(listener: (snapshot: BridgeConnectionSnapshot) => void): () => void {
  apiUnreachableListeners.add(listener);
  return () => apiUnreachableListeners.delete(listener);
}

export function useBridgeConnection(): BridgeConnectionSnapshot {
  return useSyncExternalStore(subscribeBridgeConnection, getBridgeConnectionSnapshot, getBridgeConnectionSnapshot);
}

export function markBridgeRequestStart(): void {
  publish({
    ...snapshot,
    pending: snapshot.pending + 1,
    api: ["unreachable", "stale"].includes(snapshot.api) ? "checking" : snapshot.api,
    failureKind: snapshot.failureKind === "browser-offline" ? snapshot.failureKind : null,
    target: snapshot.failureKind === "target-unreachable" ? snapshot.target : "unknown",
  });
}

export function markBridgeRequestSuccess(): void {
  publish({
    ...snapshot,
    // The request itself reached Bridge. This corrects stale WebView online hints.
    browserOnline: true,
    api: "connected",
    failureKind: null,
    target: "reachable",
    pending: Math.max(0, snapshot.pending - 1),
    lastSuccessAt: Date.now(),
    lastError: null,
  });
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("bridge:api-reachable"));
  }
}

export function markBridgeRequestFailure(error: unknown, status?: number): void {
  const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  const failureKind: Exclude<BridgeFailureKind, null> = browserOffline
    ? "browser-offline"
    : status === 401 || status === 403
      ? "api-auth-failed"
      : status === undefined
        ? "api-network-unreachable"
        : "api-response-error";
  const networkFailure = status === undefined || status >= 500;
  const next = {
    ...snapshot,
    browserOnline: !browserOffline,
    api: networkFailure ? "unreachable" : snapshot.api,
    failureKind,
    target: "unknown",
    pending: Math.max(0, snapshot.pending - 1),
    lastFailureAt: Date.now(),
    lastError: error instanceof Error ? error.message : String(error),
  } satisfies BridgeConnectionSnapshot;
  const notifyVpn = failureKind === "api-network-unreachable" && snapshot.failureKind !== failureKind;
  publish(next);
  if (notifyVpn) {
    for (const listener of apiUnreachableListeners) listener(next);
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event("bridge:api-network-unreachable"));
    }
  }
}

export function markBridgeRequestSettled(): void {
  publish({ ...snapshot, pending: Math.max(0, snapshot.pending - 1) });
}

export function markBridgeCacheFallback(): void {
  publish({
    ...snapshot,
    api: "stale",
  });
}

export function isTransientBridgeFailure(error: unknown, status?: number): boolean {
  if (status !== undefined) return status >= 500;
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return error instanceof TypeError
    || (error instanceof Error && /(?:failed to fetch|network ?error|连接失败|暂时无法连接|Bridge.*连接)/iu.test(error.message));
}

const CACHE_CATEGORY = "json-cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const CACHE_MAX_BYTES = 750_000;

interface CachedJson {
  savedAt: number;
  value: unknown;
}

function cacheStorage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}

function cacheKey(url: string): string | null {
  return scopedStorageKey(CACHE_CATEGORY, url);
}

export function shouldCacheBridgeGet(url: string): boolean {
  const pathname = (() => {
    try { return new URL(url, typeof window === "undefined" ? "http://bridge.invalid" : window.location.href).pathname; }
    catch { return url; }
  })();
  if (!pathname.startsWith("/api/")) return false;
  return !pathname.includes("/auth/")
    && pathname !== "/api/session"
    && !pathname.endsWith("/events")
    && !pathname.includes("/updates")
    && !pathname.includes("/writer-status")
    && !pathname.includes("/terminal");
}

export function cacheBridgeJson(url: string, value: unknown): void {
  const storage = cacheStorage();
  const key = cacheKey(url);
  if (!storage || !key || !shouldCacheBridgeGet(url)) return;
  try {
    const serialized = JSON.stringify({ savedAt: Date.now(), value } satisfies CachedJson);
    if (serialized.length > CACHE_MAX_BYTES) return;
    storage.setItem(key, serialized);
  } catch {
    // Quota errors and cyclic/unsupported values do not affect the live request.
  }
}

export function readCachedBridgeJson<T>(url: string): T | undefined {
  const storage = cacheStorage();
  const key = cacheKey(url);
  if (!storage || !key || !shouldCacheBridgeGet(url)) return undefined;
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as CachedJson;
    if (!cached || !Number.isFinite(cached.savedAt) || Date.now() < cached.savedAt || Date.now() - cached.savedAt > CACHE_TTL_MS) {
      storage.removeItem(key);
      return undefined;
    }
    return cached.value as T;
  } catch {
    return undefined;
  }
}

export function clearBridgeJsonCache(): void {
  const storage = cacheStorage();
  const prefix = cacheKey("");
  if (!storage || !prefix) return;
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) || key?.startsWith("bridge:web-cache:v1:")) storage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable in privacy modes.
  }
}
