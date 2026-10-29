import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchShortcutConfig, recordShortcutUse } from "../web/src/api.js";
import {
  invalidateShortcutConfigCache, loadShortcutConfig, readShortcutConfigCache,
  subscribeShortcutConfigInvalidation, writeShortcutConfigCache,
} from "../web/src/shortcut-config-cache.js";
import type { ShortcutStore } from "../web/src/tmux-shortcuts.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let origin = "http://bridge.test";
let values: Map<string, string>;
let target: EventTarget;
const store = (title: string): ShortcutStore => ({ groups: [{ id: "composer", title, icon: "K", description: "",
  surface: "composer", layout: "grid", enabled: true, sortOrder: 0 }], shortcuts: [] });

beforeEach(() => {
  origin = "http://bridge.test";
  values = new Map();
  target = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { get origin() { return origin; } },
    localStorage: { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
    dispatchEvent: target.dispatchEvent.bind(target), addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } });
  invalidateShortcutConfigCache();
});
afterEach(() => {
  invalidateShortcutConfigCache();
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("shared shortcut configuration", () => {
  it("coalesces initial consumers and reuses persistent configuration across Sessions until manual refresh", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json(store(requests === 1 ? "initial" : "refreshed"));
    }) as typeof fetch;
    const first = await Promise.all([fetchShortcutConfig(), fetchShortcutConfig(), fetchShortcutConfig()]);
    expect(requests).toBe(1);
    expect(first).toEqual([store("initial"), store("initial"), store("initial")]);
    await fetchShortcutConfig();
    expect(requests).toBe(1);
    // Simulate reopening a persistent cache long after the former seven-day expiry.
    const key = [...values.keys()].find((value) => value.includes("shortcut-config.v1"))!;
    const entry = JSON.parse(values.get(key)!);
    values.set(key, JSON.stringify({ ...entry, cachedAt: 0 }));
    origin = "http://other-bridge.test";
    invalidateShortcutConfigCache();
    origin = "http://bridge.test";
    await expect(fetchShortcutConfig()).resolves.toEqual(store("initial"));
    expect(requests).toBe(1);
    await expect(fetchShortcutConfig({ force: true })).resolves.toEqual(store("refreshed"));
    await expect(fetchShortcutConfig()).resolves.toEqual(store("refreshed"));
    expect(requests).toBe(2);
  });

  it("keeps usage counts in the shared cache without reloading configuration", async () => {
    const shortcut = { id: "test", groupId: "favorites", title: "test", detail: "", kind: "insert" as const,
      value: "test", enabled: true, dangerous: false, sortOrder: 0, operationCount: 0, displayMode: "closed" as const };
    writeShortcutConfigCache({ ...store("cached"), shortcuts: [shortcut] });
    const requests: string[] = [];
    globalThis.fetch = (async (url) => {
      requests.push(String(url));
      return Response.json(String(url).endsWith("/use") ? { shortcut: { ...shortcut, operationCount: 1 } } : { actionToken: "fixture" });
    }) as typeof fetch;
    await recordShortcutUse(shortcut.id);
    expect((await fetchShortcutConfig()).shortcuts[0]!.operationCount).toBe(1);
    expect(requests.some((url) => url.includes("shortcut-config"))).toBe(false);
  });

  it("updates mounted consumers after a manual refresh without another request", async () => {
    writeShortcutConfigCache(store("old"));
    const observed: ShortcutStore[] = [];
    const unsubscribe = subscribeShortcutConfigInvalidation(() => { observed.push(readShortcutConfigCache()!); });
    try {
      await loadShortcutConfig(async () => store("new"), true);
      expect(observed).toEqual([store("new")]);
    } finally { unsubscribe(); }
  });

  it("discards a response started before a local edit", async () => {
    let finishOld!: (value: ShortcutStore) => void;
    const first = loadShortcutConfig(() => new Promise((resolve) => { finishOld = resolve; }));
    invalidateShortcutConfigCache();
    await loadShortcutConfig(async () => store("edited"));
    finishOld(store("outdated"));
    await expect(first).resolves.toEqual(store("edited"));
    expect(readShortcutConfigCache()).toEqual(store("edited"));
  });

  it("keeps a shared memory cache when localStorage is unavailable and preserves it after refresh failure", async () => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("storage unavailable"); } });
    await loadShortcutConfig(async () => store("offline copy"));
    await expect(loadShortcutConfig(async () => { throw new Error("must use cache"); })).resolves.toEqual(store("offline copy"));
    await expect(loadShortcutConfig(async () => { throw new Error("offline"); }, true)).rejects.toThrow("offline");
    expect(readShortcutConfigCache()).toEqual(store("offline copy"));
  });

  it("isolates Bridge servers and rejects a response from a previous connection", async () => {
    let finish!: (value: ShortcutStore) => void;
    const old = loadShortcutConfig(() => new Promise((resolve) => { finish = resolve; }));
    origin = "http://other-bridge.test";
    expect(readShortcutConfigCache()).toBeNull();
    finish(store("wrong server"));
    await expect(old).rejects.toThrow("Bridge connection changed");
    expect(readShortcutConfigCache()).toBeNull();
  });
});
