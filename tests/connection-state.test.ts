import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocalDraftScope } from "../web/src/local-draft-scope.js";

import {
  cacheBridgeJson,
  isTransientBridgeFailure,
  markBridgeCacheFallback,
  readCachedBridgeJson,
  shouldCacheBridgeGet,
} from "../web/src/connection-state.js";
import { getJson } from "../web/src/api.js";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
beforeEach(() => setLocalDraftScope("a".repeat(43), "https://one.fixture"));

afterEach(() => {
  setLocalDraftScope(null);
  if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
  if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
  else Reflect.deleteProperty(globalThis, "fetch");
});

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  return values;
}

describe("Bridge connection state cache", () => {
  it("caches JSON reads but excludes auth, streams, and terminal endpoints", () => {
    expect(shouldCacheBridgeGet("/api/task-panel?limit=50")).toBe(true);
    expect(shouldCacheBridgeGet("/api/auth/status")).toBe(false);
    expect(shouldCacheBridgeGet("/api/events")).toBe(false);
    expect(shouldCacheBridgeGet("/tmux-dashboard/terminal")).toBe(false);
  });

  it("keeps a bounded session snapshot available during a temporary API outage", () => {
    const values = installStorage();
    const url = "/api/task-panel?limit=50&offset=0";
    const payload = { items: [{ task_guid: "cached-task" }], total: 1 };
    cacheBridgeJson(url, payload);
    expect(readCachedBridgeJson<typeof payload>(url)).toEqual(payload);
    expect(values.size).toBe(1);
    markBridgeCacheFallback();
  });

  it("returns a cached GET response when the API cannot be reached", async () => {
    installStorage();
    const url = "/api/projects";
    const payload = { projects: [{ name: "cached" }] };
    cacheBridgeJson(url, payload);
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch,
    });
    await expect(getJson<typeof payload>(url)).resolves.toEqual(payload);
  });

  it("does not classify aborts or client validation errors as network loss", () => {
    expect(isTransientBridgeFailure(new DOMException("cancelled", "AbortError"))).toBe(false);
    expect(isTransientBridgeFailure(new DOMException("timed out", "TimeoutError"))).toBe(false);
    expect(isTransientBridgeFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientBridgeFailure(new Error("bad request"), 422)).toBe(false);
    expect(isTransientBridgeFailure(new Error("gateway down"), 503)).toBe(true);
  });

  it("falls back for an HTML gateway error but rejects a successful empty response", async () => {
    installStorage();
    cacheBridgeJson("/api/projects", { projects: ["cached"] });
    globalThis.fetch = (async () => new Response("<html>gateway unavailable</html>", { status: 502 })) as typeof fetch;
    await expect(getJson("/api/projects")).resolves.toEqual({ projects: ["cached"] });
    globalThis.fetch = (async () => new Response("")) as typeof fetch;
    await expect(getJson("/api/projects")).rejects.toThrow("空响应");
  });
});
