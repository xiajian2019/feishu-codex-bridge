import { afterEach, beforeEach, expect, it } from "bun:test";
import { getLocalDraftScope, scopedStorageKey, setLocalDraftScope } from "../web/src/local-draft-scope.js";
import { clearLocalDraftsAfterDeviceRevocation } from "../web/src/local-draft-cleanup.js";
import { loadDraftAttachment, loadDraftMetadata, saveDraftAttachment, saveDraftMetadata, clearDraftAttachments } from "../web/src/tmux-draft-store.js";
import { cacheBridgeJson, readCachedBridgeJson } from "../web/src/connection-state.js";
import { getJson } from "../web/src/api.js";
import { readCodexSkillCache, writeCodexSkillCache } from "../web/src/skill-cache.js";

const original = new Map(["window", "sessionStorage", "indexedDB"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const originalFetch = globalThis.fetch;
const serverA = "https://mac.fixture:5173";
const serverB = "https://mac.fixture:7310";
const device = "a".repeat(43);
let local: Storage;
let session: Storage;
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, clear: () => values.clear() };
}

// Small asynchronous IndexedDB substitute. Production key construction, cursor
// deletion and scope checks run unchanged; this is not a browser persistence test.
function memoryIndexedDb(): IDBFactory {
  const databases = new Map<string, Map<string, any>>();
  return { open(name: string) {
    const request: any = {};
    const records = databases.get(name) ?? new Map();
    databases.set(name, records);
    request.result = { close() {}, transaction() {
      const tx: any = {};
      tx.objectStore = () => ({
        put(value: any) { queueMicrotask(() => { records.set(value.key, value); tx.oncomplete?.(); }); },
        get(key: string) {
          const read: any = {};
          queueMicrotask(() => { read.result = records.get(key); read.onsuccess?.(); });
          return read;
        },
        openCursor() {
          const read: any = {};
          const entries = [...records.entries()];
          let index = 0;
          const next = () => queueMicrotask(() => {
            const entry = entries[index++];
            read.result = entry ? { value: entry[1], delete: () => records.delete(entry[0]), continue: next } : null;
            read.onsuccess?.();
            if (!entry) tx.oncomplete?.();
          });
          next();
          return read;
        },
      });
      return tx;
    } };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } as unknown as IDBFactory;
}

beforeEach(() => {
  local = memoryStorage(); session = memoryStorage();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: local, sessionStorage: session, location: { origin: "http://localhost" } } });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: memoryIndexedDb() });
  setLocalDraftScope(device, serverA);
});
afterEach(() => {
  setLocalDraftScope(null); globalThis.fetch = originalFetch;
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("isolates the same resource IDs across ports, instances and devices without storing credentials", () => {
  const keyA = scopedStorageKey("history-detail", JSON.stringify(["home", "thread"]));
  setLocalDraftScope(device, serverB);
  expect(scopedStorageKey("history-detail", JSON.stringify(["home", "thread"]))).not.toBe(keyA);
  setLocalDraftScope("b".repeat(43), serverA);
  expect(scopedStorageKey("history-detail", JSON.stringify(["home", "thread"]))).not.toBe(keyA);
  setLocalDraftScope(null);
  expect(scopedStorageKey("task-followup", "same-id")).toBeNull();
});

it("keeps tmux text and attachment bytes isolated, including clear-by-session", async () => {
  saveDraftMetadata("$1", { text: "A", attachments: [] });
  await saveDraftAttachment("$1", "same-id", new File(["bytes A"], "same.txt"));
  setLocalDraftScope(device, serverB);
  expect(loadDraftMetadata("$1")).toBeNull();
  expect(await loadDraftAttachment("$1", "same-id")).toBeNull();
  saveDraftMetadata("$1", { text: "B", attachments: [] });
  await saveDraftAttachment("$1", "same-id", new File(["bytes B"], "same.txt"));
  await clearDraftAttachments("$1");
  expect(await loadDraftAttachment("$1", "same-id")).toBeNull();
  setLocalDraftScope(device, serverA);
  expect(loadDraftMetadata("$1")?.text).toBe("A");
  expect(await (await loadDraftAttachment("$1", "same-id"))?.text()).toBe("bytes A");
});

it("does not adopt unscoped legacy drafts or save an attachment into a scope selected during IndexedDB open", async () => {
  local.setItem("feishu-codex-bridge:tmux-draft:%241", JSON.stringify({ version: 1, text: "legacy", attachments: [], updatedAt: Date.now() }));
  expect(loadDraftMetadata("$1")).toBeNull();
  const pending = saveDraftAttachment("$1", "same-id", new File(["old bytes"], "old.txt"));
  setLocalDraftScope(device, serverB);
  await pending;
  expect(await loadDraftAttachment("$1", "same-id")).toBeNull();
  setLocalDraftScope(device, serverA);
  expect(await loadDraftAttachment("$1", "same-id")).toBeNull();
});

it("does not persist a pagehide draft from an old composer into the next device's scope", () => {
  const originalScope = getLocalDraftScope();
  setLocalDraftScope("b".repeat(43), serverA);
  saveDraftMetadata("$1", { text: "new device", attachments: [] });
  saveDraftMetadata("$1", { text: "old pagehide text", attachments: [] }, originalScope);
  expect(loadDraftMetadata("$1")?.text).toBe("new device");
});

it("does not return a previous environment's JSON fallback or skill cache", async () => {
  cacheBridgeJson("/api/projects", { projects: ["A"] });
  writeCodexSkillCache("global", ["A"]);
  setLocalDraftScope(device, serverB);
  expect(readCachedBridgeJson("/api/projects")).toBeUndefined();
  expect(readCodexSkillCache("global", Array.isArray)).toBeNull();
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  await expect(getJson("/api/projects")).rejects.toThrow("Failed to fetch");
  setLocalDraftScope(device, serverA);
  await expect(getJson("/api/projects")).resolves.toEqual({ projects: ["A"] });
});

it("rejects an in-flight JSON result after device identity changes instead of caching it for the new device", async () => {
  let complete!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { complete = resolve; })) as typeof fetch;
  const pending = getJson("/api/projects");
  setLocalDraftScope("b".repeat(43), serverA);
  complete(Response.json({ projects: ["private A"] }));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(readCachedBridgeJson("/api/projects")).toBeUndefined();
});

it("captures revocation cleanup before scope reset and preserves other environments plus UI theme", async () => {
  saveDraftMetadata("$1", { text: "A", attachments: [] });
  await saveDraftAttachment("$1", "same-id", new File(["A"], "same.txt"));
  cacheBridgeJson("/api/projects", { projects: ["A"] });
  local.setItem("theme", "dark");
  setLocalDraftScope(device, serverB);
  saveDraftMetadata("$1", { text: "B", attachments: [] });
  await saveDraftAttachment("$1", "same-id", new File(["B"], "same.txt"));
  const keyB = scopedStorageKey("history-detail", "same-thread")!;
  local.setItem(keyB, "B history");
  setLocalDraftScope(device, serverA);
  const cleanup = clearLocalDraftsAfterDeviceRevocation();
  setLocalDraftScope(null);
  await cleanup;
  setLocalDraftScope(device, serverA);
  expect(loadDraftMetadata("$1")).toBeNull();
  expect(await loadDraftAttachment("$1", "same-id")).toBeNull();
  expect(readCachedBridgeJson("/api/projects")).toBeUndefined();
  setLocalDraftScope(device, serverB);
  expect(loadDraftMetadata("$1")?.text).toBe("B");
  expect(await (await loadDraftAttachment("$1", "same-id"))?.text()).toBe("B");
  expect(local.getItem(keyB)).toBe("B history");
  expect(local.getItem("theme")).toBe("dark");
  expect(getLocalDraftScope()).not.toContain("Bearer");
});
