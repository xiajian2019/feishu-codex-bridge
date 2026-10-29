import { createMobileFetch, isBridgeApiPath, normalizeBridgeServer, parseMobilePairingInput, type MobileConnection } from "./mobile-connection.js";
import { createMobileConnectionSwitch } from "./mobile-connection-switch.js";
import { readBridgeJson } from "./bridge-json.js";
import { assertBridgeApiSupported, bridgeFeatureUnavailable, parseBridgeCapabilities, setBridgeCapabilities } from "./client-capabilities.js";
import { LOCAL_DRAFT_SCOPE_EVENT, scopedStorageKey, setLocalDraftScope } from "./local-draft-scope.js";
import { clearMobileDownloadScope, restoreMobileDownloads } from "./mobile-download-manager.js";
import { isAppForeground } from "./foreground-polling.js";
import { clearLocalDraftsAfterDeviceRevocation } from "./local-draft-cleanup.js";
import type { AuthStatus } from "./pairing-diagnostics.js";
import { parseApkUpdate, type MobileApkUpdate, type ApkUpdatePhase } from "./mobile-apk-update.js";
export type { MobileApkUpdate } from "./mobile-apk-update.js";

export const MOBILE_RESUME_EVENT = "bridge:mobile-resume";
export const MOBILE_CONNECTION_EVENT = "bridge:mobile-connection";
export const MOBILE_SETTINGS_EVENT = "bridge:mobile-settings";
export const MOBILE_SHAKE_EVENT = "bridge:mobile-shake";
export const MOBILE_BACK_EVENT = "bridge:mobile-back";
const SERVER_KEY = "bridge.mobile.server";
let connection: MobileConnection | null = null;
let originalFetch: typeof fetch | null = null;
let initialization: Promise<void> | null = null;
let downloadTrackingInstalled = false;
let credentialQueue = Promise.resolve();
const connectionSwitch = createMobileConnectionSwitch();

export function isMobileApp(): boolean { return import.meta.env.VITE_BRIDGE_MOBILE === "true"; }
export function getMobileConnection(): MobileConnection | null { return connection; }
export async function getMobileAppVersion(): Promise<string> { return (await import("./mobile-native.js")).nativeAppVersion(); }
export async function getMobileAppBuild(): Promise<number> { return Number((await (await import("./mobile-native.js")).nativeAppInfo()).build); }
export function getBridgeOrigin(): string { return isMobileApp() && connection ? connection.server : window.location.origin; }

export function bridgeUrl(path: string): string {
  if (!isMobileApp()) return path;
  if (!connection) throw new Error("请先设置 Bridge 连接。");
  const url = new URL(path, window.location.href);
  const current = new URL(window.location.href);
  if (url.origin !== connection.server && (url.protocol !== current.protocol || url.host !== current.host)) {
    throw new Error("该地址不属于当前 Bridge。");
  }
  return new URL(url.pathname + url.search + url.hash, connection.server).toString();
}

export function openMobileConnectionSettings(server?: string): void {
  window.dispatchEvent(new CustomEvent(MOBILE_SETTINGS_EVENT, { detail: server ? { server } : undefined }));
}

function persistCredential(action: () => Promise<void>): Promise<void> {
  const pending = credentialQueue.then(action);
  credentialQueue = pending.catch(() => {});
  return pending;
}

export async function initializeMobileRuntime(): Promise<void> {
  if (!isMobileApp()) return;
  if (initialization) return initialization;
  initialization = initialize();
  try { await initialization; }
  catch (error) { initialization = null; throw error; }
}

async function initialize(): Promise<void> {
  if (!downloadTrackingInstalled) {
    window.addEventListener(LOCAL_DRAFT_SCOPE_EVENT, () => {
      try { restoreMobileDownloads(window.localStorage, scopedStorageKey("mobile-downloads")); }
      catch { restoreMobileDownloads(null, null); }
    });
    downloadTrackingInstalled = true;
  }
  originalFetch ??= window.fetch.bind(window);
  const native = await import("./mobile-native.js");
  let server: string | null = null;
  try {
    const saved = window.localStorage.getItem(SERVER_KEY);
    if (saved) server = normalizeBridgeServer(saved);
  } catch { window.localStorage.removeItem(SERVER_KEY); }
  if (server) {
    try {
      connection = { server, token: await native.getCredential(server) };
    } catch {
      // A missing/locked credential must lead to pairing, never to a browser cookie fallback.
      connection = { server, token: null };
    }
  }
  window.fetch = createMobileFetch({
    pageOrigin: window.location.href,
    connection: () => connection,
    fetch: originalFetch,
    beforeRequest: (method, path) => {
      assertBridgeApiSupported(path);
      if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) && !isAppForeground()) {
        throw new DOMException("App 已进入后台，操作未继续提交；请回前台核对状态后手动重试。", "AbortError");
      }
      return connectionSwitch.beforeRequest(method);
    },
    unauthorized: (failed) => {
      if (connection?.server === failed.server && connection.token === failed.token) void forgetMobileCredential().catch(() => {});
    },
  });
  await native.installNativeLifecycle();
  document.documentElement.classList.add("bridge-mobile-app");
}

export async function checkMobileConnection(): Promise<boolean> {
  if (!connection?.token) return false;
  const selected = connection;
  const response = await fetch("/api/auth/status", { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!response.ok) throw new Error("Bridge 暂时无法连接（" + response.status + "）。");
  const status = await readBridgeJson<AuthStatus>(response);
  if (selected !== connection) throw new DOMException("Bridge connection changed", "AbortError");
  if (typeof status.authenticated !== "boolean") throw new Error("当前后端的鉴权响应不兼容，请检查服务版本。");
  if (status.authenticated) {
    setBridgeCapabilities(parseBridgeCapabilities(status.client));
    setLocalDraftScope(status.draftScope, selected.server);
    try { restoreMobileDownloads(window.localStorage, scopedStorageKey("mobile-downloads")); }
    catch { restoreMobileDownloads(null, null); }
  }
  if (!status.authenticated) await forgetMobileCredential();
  return status.authenticated;
}

export async function pairMobileConnection(address: string, code: string): Promise<void> {
  if (!originalFetch) throw new Error("App 尚未初始化，请重新打开。");
  const parsed = parseMobilePairingInput(address, code);
  await connectionSwitch.run(async () => {
    const response = await originalFetch!(new URL("/api/auth/mobile/pair", parsed.server), {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code: parsed.code }), signal: AbortSignal.timeout(15_000),
    });
    const result = await readBridgeJson<{ token?: string; error?: string }>(response);
    if (!response.ok) throw new Error(result.error || "配对失败（" + response.status + "）。");
    if (!result.token || !/^[A-Za-z0-9_-]{40,128}$/.test(result.token)) throw new Error("Bridge 返回了无效的配对结果。");
    const native = await import("./mobile-native.js");
    const token = result.token;
    await persistCredential(() => native.setCredential(parsed.server, token));
    return { server: parsed.server, token };
  }, (next) => { commitMobileConnection(next); return true; });
}

export async function switchMobileConnection(address: string): Promise<boolean> {
  if (!isMobileApp()) return false;
  const server = normalizeBridgeServer(address);
  const previous = connection;
  const next = await connectionSwitch.run(async () => {
    if (!originalFetch) throw new Error("App 尚未初始化，请重新打开。");
    const native = await import("./mobile-native.js");
    const token = await native.getCredential(server);
    if (!token) return null;
    // Never update the transport's live connection merely to test another server.
    const response = await originalFetch(new URL("/api/auth/status", server), {
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      credentials: "omit", mode: "cors", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`目标环境暂时不可用（${response.status}），当前环境未改变。`);
    const status = await readBridgeJson<AuthStatus>(response);
    if (status.authenticated === false) return null;
    if (status.authenticated !== true) throw new Error("目标环境的鉴权接口不兼容，当前环境未改变。");
    parseBridgeCapabilities(status.client);
    return { server, token };
  }, (candidate) => {
    if (!candidate) return false;
    if (connection !== previous) throw new Error("当前登录状态已变化，请重新确认后再切换。");
    commitMobileConnection(candidate);
    return true;
  });
  return next !== null;
}

function commitMobileConnection(next: MobileConnection): void {
  window.localStorage.setItem(SERVER_KEY, next.server);
  connection = next;
  // Keep the old draft scope until reload: pagehide must flush old drafts to the
  // old namespace, never into the newly selected server's namespace.
  window.dispatchEvent(new Event(MOBILE_CONNECTION_EVENT));
}

export async function forgetMobileCredential(): Promise<void> {
  const server = connection?.server;
  if (!server) return;
  clearMobileDownloadScope();
  const cleanup = clearLocalDraftsAfterDeviceRevocation();
  setLocalDraftScope(null);
  setBridgeCapabilities(null);
  connection = { server, token: null };
  window.dispatchEvent(new Event(MOBILE_CONNECTION_EVENT));
  const native = await import("./mobile-native.js");
  await Promise.all([cleanup, persistCredential(() => native.removeCredential(server))]);
}

export async function disconnectMobileConnection(): Promise<void> {
  // Best effort remote revocation; local credentials are always removed, even offline.
  try {
    const session = await fetch("/api/session", { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (session.ok) {
      const { actionToken } = await readBridgeJson<{ actionToken: string }>(session);
      await fetch("/api/auth/logout", { method: "POST", headers: { "X-Bridge-Action-Token": actionToken }, signal: AbortSignal.timeout(5_000) });
    }
  } finally { await forgetMobileCredential(); }
}

export async function mobileStreamUrl(path: string): Promise<string> {
  if (!isMobileApp()) return new URL(path, window.location.origin).toString();
  const target = new URL(bridgeUrl(path));
  if (target.pathname !== "/api/events" && target.pathname !== "/tmux-dashboard/terminal") throw new Error("不支持该实时连接。");
  const session = await fetch("/api/session", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!session.ok) throw new Error("请重新配对 Bridge。");
  const { actionToken } = await readBridgeJson<{ actionToken: string }>(session);
  const response = await fetch("/api/auth/mobile/stream-ticket", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken },
    body: JSON.stringify({ path: target.pathname + target.search }), signal: AbortSignal.timeout(10_000),
  });
  const result = await readBridgeJson<{ ticket?: string; error?: string }>(response);
  if (!response.ok || !result.ticket) throw new Error(result.error || "实时连接授权失败。");
  target.searchParams.set("bridgeTicket", result.ticket);
  return target.toString();
}

export async function downloadBridgeFile(path: string, fileName = "bridge-file"): Promise<void> {
  const selected = connection;
  const url = new URL(bridgeUrl(path));
  if (url.origin !== getBridgeOrigin() || !isBridgeApiPath(url.pathname)) throw new Error("该文件不属于当前 Bridge。");
  const native = await import("./mobile-native.js");
  if (connection !== selected) throw new DOMException("Bridge connection changed", "AbortError");
  await native.downloadBridgeFile(url.toString(), fileName, selected?.token ?? null);
}

/** @deprecated Use downloadBridgeFile for authenticated Bridge files. */
export async function shareBridgeFile(path: string, fileName = "bridge-file"): Promise<void> {
  await downloadBridgeFile(path, fileName);
}

export async function openBridgeExternal(value: string): Promise<void> {
  const url = new URL(value, getBridgeOrigin());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只支持 HTTP 或 HTTPS 链接。");
  const native = await import("./mobile-native.js");
  await native.openExternal(url.toString());
}

export async function openMobileDemo(id: string, path: string): Promise<void> {
  const selected = connection;
  if (!selected?.token) throw new Error("请先配对 Bridge。");
  const session = await fetch("/api/session", { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  const { actionToken } = await readBridgeJson<{ actionToken: string }>(session);
  const response = await fetch(`/api/local-demos/${encodeURIComponent(id)}/browser-ticket`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken },
    body: JSON.stringify({ path }), signal: AbortSignal.timeout(10_000),
  });
  const result = await readBridgeJson<{ url?: string; error?: string }>(response);
  if (!response.ok || !result.url) throw new Error(result.error || "Demo 浏览器授权失败，请升级后端后重试。");
  const url = new URL(result.url, selected.server);
  if (url.origin !== selected.server || url.pathname !== `/api/local-demos/${id}/browser-open` || url.username || url.password || url.hash
    || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("ticket") ?? "")) throw new Error("Demo 打开地址无效。");
  if (selected !== connection) throw new Error("当前环境已变化，请重新打开 Demo。");
  await openBridgeExternal(url.href);
}

export async function copyMobileText(value: string): Promise<void> {
  const native = await import("./mobile-native.js");
  await native.copyText(value);
}

export async function setMobileShakeEnabled(enabled: boolean): Promise<void> {
  await (await import("./mobile-native.js")).setShakeEnabled(enabled);
}

export async function supportsMobileApkUpdates(): Promise<boolean> {
  if (!isMobileApp()) return false;
  const native = await import("./mobile-native.js");
  return native.isAndroidPlatform();
}

export async function checkMobileApkUpdate(): Promise<MobileApkUpdate | null> {
  if (!(await supportsMobileApkUpdates())) return null;
  if (bridgeFeatureUnavailable("mobile-apk-update")) return null;
  const selected = connection;
  const response = await fetch("/api/mobile/update", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 || response.status === 501) return null;
  const result = await readBridgeJson<{ available?: boolean; error?: string }>(response);
  if (!response.ok) throw new Error(result.error || `更新检查失败（${response.status}）。`);
  if (result.available !== true) return null;
  if (selected !== connection || !selected) throw new Error("环境已变化，请重新检查更新。");
  return parseApkUpdate(result, selected.server);
}

async function transferMobileApk(update: MobileApkUpdate, install: boolean, uri?: string, onPhase?: (phase: ApkUpdatePhase, uri?: string) => void): Promise<string> {
  const current = getMobileConnection();
  if (!current?.token) throw new Error("请先配对 Bridge。");
  if (update.server !== current.server) throw new Error("更新包属于其他环境，请重新检查更新。");
  const validated = parseApkUpdate(update, current.server);
  const native = await import("./mobile-native.js");
  if (current !== connection) throw new Error("环境已变化，请重新检查更新。");
  const release = connectionSwitch.beforeRequest("POST");
  try { return await native.prepareApkUpdate(validated, current.token, install, uri, onPhase); }
  finally { release(); }
}
export function installMobileApkUpdate(update: MobileApkUpdate, uri?: string, onPhase?: (phase: ApkUpdatePhase, uri?: string) => void): Promise<string> {
  return transferMobileApk(update, true, uri, onPhase);
}
export function downloadMobileApkUpdate(update: MobileApkUpdate, uri?: string, onPhase?: (phase: ApkUpdatePhase, uri?: string) => void): Promise<string> {
  return transferMobileApk(update, false, uri, onPhase);
}

export async function shareMobileBlob(blob: Blob, fileName: string): Promise<void> {
  const native = await import("./mobile-native.js");
  await native.shareBlob(blob, fileName);
}
