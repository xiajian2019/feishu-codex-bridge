// Real runtime in an isolated process: native credential storage is the only substitute.
import assert from "node:assert/strict";
import { mock } from "bun:test";

process.env.VITE_BRIDGE_MOBILE = "true";
const scenario = process.argv[2];
const oldServer = "https://mac.fixture:5173";
const targetServer = "https://mac.fixture:7310";
const scope = "s".repeat(43);
const token = "a".repeat(43);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const probe = deferred<Response>();
const write = deferred<Response>();
const rows = new Map<string, string>([["bridge.mobile.server", oldServer]]);
const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) };
const calls: Request[] = [];
const status = (minimumClientProtocol = 1) => Response.json({ authenticated: true, draftScope: scope,
  client: { schemaVersion: 1, protocolVersion: 1, minimumClientProtocol, version: "fixture", features: ["tmux"] } });
const ui = Object.assign(new EventTarget(), {
  localStorage: storage, location: { href: "capacitor://localhost/", origin: "null" },
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.url.startsWith(targetServer)) return probe.promise;
    if (request.method === "POST" && scenario === "write-active") return write.promise;
    return request.url.endsWith("/api/auth/status") ? status() : Response.json({ server: oldServer });
  }) as typeof fetch,
});
Object.defineProperty(globalThis, "window", { configurable: true, value: ui });
Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => ui.fetch, set: (value) => { ui.fetch = value; } });
Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { classList: { add() {} } } } });
mock.module("../../web/src/mobile-native.js", () => ({
  getCredential: async () => token, setCredential: async () => {}, removeCredential: async () => {}, installNativeLifecycle: async () => {},
}));
const runtime = await import("../../web/src/mobile-runtime.js");
const { getLocalDraftScope } = await import("../../web/src/local-draft-scope.js");
await runtime.initializeMobileRuntime();
assert.equal(runtime.isMobileApp(), true);
assert.equal(await runtime.checkMobileConnection(), true);
const oldScope = getLocalDraftScope();
assert.ok(oldScope?.includes(scope));

if (scenario === "background") {
  const { setAppForeground } = await import("../../web/src/foreground-polling.js");
  setAppForeground(false);
  const before = calls.length;
  await assert.rejects(fetch("/api/messages", { method: "POST", body: "must wait" }), { name: "AbortError" });
  assert.equal(calls.length, before);
  setAppForeground(true);
  assert.equal((await fetch("/api/messages", { method: "POST", body: "user retries" })).status, 200);
  process.exit(0);
}

if (scenario === "write-active") {
  const sending = fetch("/api/messages", { method: "POST", body: "old environment message" });
  await assert.rejects(runtime.switchMobileConnection(targetServer), /请求正在提交/);
  assert.equal(calls.filter((call) => call.url.startsWith(targetServer)).length, 0);
  write.resolve(Response.json({ ok: true }));
  await sending;
}
const switching = runtime.switchMobileConnection(targetServer);
for (let i = 0; i < 100 && !calls.some((call) => call.url.startsWith(targetServer)); i += 1) await Promise.resolve();
assert.ok(calls.some((call) => call.url.startsWith(targetServer)), "target probe not started");
assert.equal(runtime.getMobileConnection()?.server, oldServer);
assert.equal(rows.get("bridge.mobile.server"), oldServer);
assert.deepEqual(await (await fetch("/api/projects")).json(), { server: oldServer });
await assert.rejects(fetch("/api/messages", { method: "POST", body: "must not cross environments" }), { name: "AbortError" });
await assert.rejects(runtime.switchMobileConnection("https://other.fixture"), /正在切换/);
assert.equal(calls.filter((call) => call.url.startsWith(targetServer) && call.method !== "GET").length, 0);

if (scenario === "offline") {
  probe.reject(new TypeError("Failed to fetch"));
  await assert.rejects(switching, /Failed to fetch/);
} else if (scenario === "unauthorized") {
  probe.resolve(Response.json({ error: "pairing required" }, { status: 401 }));
  assert.equal(await switching, false);
} else if (scenario === "incompatible") {
  probe.resolve(status(2));
  await assert.rejects(switching, /更新版本的 App/);
} else {
  probe.resolve(status());
  assert.equal(await switching, true);
  assert.equal(runtime.getMobileConnection()?.server, targetServer);
  assert.equal(rows.get("bridge.mobile.server"), targetServer);
  // pagehide must keep flushing the previous environment's draft namespace.
  assert.equal(getLocalDraftScope(), oldScope);
  await assert.rejects(fetch("/api/chunks/2", { method: "PUT", body: "late chunk" }), { name: "AbortError" });
  await assert.rejects(fetch("/api/projects"), { name: "AbortError" });
}
if (["offline", "unauthorized", "incompatible"].includes(scenario!)) {
  assert.equal(runtime.getMobileConnection()?.server, oldServer);
  assert.equal(rows.get("bridge.mobile.server"), oldServer);
  assert.equal(getLocalDraftScope(), oldScope);
  // Failed probes restore availability, not just a visually selected environment.
  assert.equal((await fetch("/api/messages", { method: "POST" })).status, 200);
}
assert.equal(calls.filter((call) => call.url.startsWith(targetServer) && call.method !== "GET").length, 0);
assert.equal(calls.find((call) => call.url.startsWith(targetServer))?.headers.get("Authorization"), "Bearer " + token);
