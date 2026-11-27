import { createMobileFetch, isBridgeApiPath, normalizeBridgeServer, normalizeConfiguredBridgeServer, parseMobilePairingInput, type MobileConnection } from "./mobile-connection.js";
import { BRIDGE_NETWORK_SETTINGS_EVENT, readBridgeNetworkSettings } from "./bridge-global-config.js";
import { createMobileVpnSettingsSync } from "./mobile-vpn-settings-sync.js";
import { createMobileConnectionSwitch } from "./mobile-connection-switch.js";
import { readBridgeJson } from "./bridge-json.js";
import { assertBridgeApiSupported, bridgeFeatureUnavailable, parseBridgeCapabilities, setBridgeCapabilities } from "./client-capabilities.js";
import { LOCAL_DRAFT_SCOPE_EVENT, getLocalDraftScope, scopedStorageKey, setLocalDraftScope } from "./local-draft-scope.js";
import { clearMobileDownloadScope, restoreMobileDownloads } from "./mobile-download-manager.js";
import { isAppForeground } from "./foreground-polling.js";
import { clearLocalDraftsAfterDeviceRevocation } from "./local-draft-cleanup.js";
import type { AuthStatus } from "./pairing-diagnostics.js";
import { parseApkUpdate, type MobileApkUpdate, type ApkUpdatePhase } from "./mobile-apk-update.js";
import type { MobileShare } from "./mobile-handoff.js";
import { BridgeResponseError } from "./bridge-json.js";
import { markBridgeRequestFailure, markBridgeRequestStart, markBridgeRequestSuccess, subscribeBridgeApiUnreachable } from "./connection-state.js";
import { classifyMobileVpnPlatform, mobileVpnUnavailableMessage, type MobileVpnCapability } from "./mobile-vpn-contract.js";
import type {
  NearbyConnection, NearbyDiagnostic, NearbyError, NearbyFileOffer, NearbyFileProgress, NearbyFileSelection, NearbyListenerHandle,
  NearbyNetworkInfo, NearbyPeer, NearbyReceivedFile, NearbyServerInfo,
} from "./nearby-transfer-contract.js";
export type { MobileApkUpdate } from "./mobile-apk-update.js";
export type {
  NearbyConnection, NearbyDiagnostic, NearbyError, NearbyFileOffer, NearbyFileProgress, NearbyFileSelection, NearbyListenerHandle,
  NearbyNetworkInfo, NearbyPeer, NearbyReceivedFile, NearbyServerInfo,
} from "./nearby-transfer-contract.js";

export const MOBILE_RESUME_EVENT = "bridge:mobile-resume";
export const MOBILE_CONNECTION_EVENT = "bridge:mobile-connection";
export const MOBILE_SETTINGS_EVENT = "bridge:mobile-settings";
export const MOBILE_SHAKE_EVENT = "bridge:mobile-shake";
export const MOBILE_OPENVPN_CONNECT_EVENT = "bridge:openvpn-connect-opened";
export const MOBILE_BACK_EVENT = "bridge:mobile-back";
const SERVER_KEY = "bridge.mobile.server";
let connection: MobileConnection | null = null;
let originalFetch: typeof fetch | null = null;
let initialization: Promise<void> | null = null;
let downloadTrackingInstalled = false;
let credentialQueue = Promise.resolve();
let removeGlobalVpnRecovery: (() => void) | null = null;
let autoVpnSettingsSyncInstalled = false;
let autoVpnSettingsSync: Promise<boolean> | null = null;
let migratedCredentialServer: string | null = null;
const connectionSwitch = createMobileConnectionSwitch();

export function isMobileApp(): boolean { return import.meta.env.VITE_BRIDGE_MOBILE === "true"; }
export function getMobileConnection(): MobileConnection | null { return connection; }
export async function nearbyTransferAvailable(): Promise<boolean> {
  return isMobileApp() && (await import("./mobile-native.js")).nearbyTransferAvailable();
}
export async function nearbyStartServer(displayName: string, port?: number): Promise<NearbyServerInfo> {
  return (await import("./mobile-native.js")).nearbyStartServer(displayName, port);
}
export async function nearbyStopServer(): Promise<void> { await (await import("./mobile-native.js")).nearbyStopServer(); }
export async function nearbyStartDiscovery(): Promise<void> { await (await import("./mobile-native.js")).nearbyStartDiscovery(); }
export async function nearbyStopDiscovery(): Promise<void> { await (await import("./mobile-native.js")).nearbyStopDiscovery(); }
export async function nearbyGetNetworkInfo(): Promise<NearbyNetworkInfo> { return (await import("./mobile-native.js")).nearbyGetNetworkInfo(); }
export async function nearbyConnect(options: { peerId?: string; host?: string; port?: number; token?: string; deviceId?: string; name?: string; source?: "mdns" | "hotspot" | "qr" }): Promise<{ connectionId: string }> {
  return (await import("./mobile-native.js")).nearbyConnect(options);
}
export async function nearbyDisconnect(connectionId: string): Promise<void> { await (await import("./mobile-native.js")).nearbyDisconnect(connectionId); }
export async function nearbyPickFile(): Promise<NearbyFileSelection> { return (await import("./mobile-native.js")).nearbyPickFile(); }
export async function nearbyAcceptConnection(connectionId: string): Promise<void> { await (await import("./mobile-native.js")).nearbyAcceptConnection(connectionId); }
export async function nearbyRejectConnection(connectionId: string): Promise<void> { await (await import("./mobile-native.js")).nearbyRejectConnection(connectionId); }
export async function nearbyBeginFile(options: { connectionId: string; transferId: string; selectionId: string }): Promise<void> { await (await import("./mobile-native.js")).nearbyBeginFile(options); }
export async function nearbySendFile(options: { connectionId: string; transferId: string; selectionId: string }): Promise<void> { await (await import("./mobile-native.js")).nearbySendFile(options); }
export async function nearbySendChunk(options: { connectionId: string; transferId: string; dataBase64: string; final: boolean }): Promise<void> { await (await import("./mobile-native.js")).nearbySendChunk(options); }
export async function nearbyAcceptFile(connectionId: string, transferId: string): Promise<void> { await (await import("./mobile-native.js")).nearbyAcceptFile(connectionId, transferId); }
export async function nearbyRejectFile(connectionId: string, transferId: string): Promise<void> { await (await import("./mobile-native.js")).nearbyRejectFile(connectionId, transferId); }
export async function nearbyListReceived(): Promise<NearbyReceivedFile[]> { return (await import("./mobile-native.js")).nearbyListReceived(); }
export async function openNearbyReceived(file: NearbyReceivedFile): Promise<void> { await (await import("./mobile-native.js")).openNearbyReceived(file); }
export async function nearbyDeleteReceived(id: string): Promise<void> { await (await import("./mobile-native.js")).nearbyDeleteReceived(id); }
export async function shareNearbyReceived(file: NearbyReceivedFile): Promise<void> { await (await import("./mobile-native.js")).shareNearbyReceived(file); }
export function nearbyAddListener(event: "peerFound", handler: (event: { peer: NearbyPeer }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "peerLost", handler: (event: { peer: NearbyPeer }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "connectionState", handler: (event: { connection: NearbyConnection }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "peerReady", handler: (event: { connectionId: string }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "networkChanged", handler: () => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "fileOffer", handler: (event: { offer: NearbyFileOffer }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "fileAccepted", handler: (event: { connectionId: string; transferId: string }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "fileCompleted", handler: (event: { connectionId: string; transferId: string }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "fileProgress", handler: (event: { progress: NearbyFileProgress }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "fileReceived", handler: (event: { file: NearbyReceivedFile; connectionId: string; transferId: string }) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "diagnostic", handler: (event: NearbyDiagnostic) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: "error", handler: (event: NearbyError) => void): Promise<NearbyListenerHandle>;
export function nearbyAddListener(event: string, handler: (event: never) => void): Promise<NearbyListenerHandle> {
  return import("./mobile-native.js").then((native) => native.nearbyAddListener(event as never, handler as never));
}
export async function getMobileAppVersion(): Promise<string> { return (await import("./mobile-native.js")).nativeAppVersion(); }
export async function getMobileAppBuild(): Promise<number> { return Number((await (await import("./mobile-native.js")).nativeAppInfo()).build); }
export async function isNativeRemoteDesktopAvailable(): Promise<boolean> {
  return isMobileApp() && (await import("./mobile-native.js")).nativeRemoteDesktopAvailable();
}
export async function getNativeRemoteDesktopPlatform(): Promise<"ios" | "android" | null> {
  if (!isMobileApp()) return null;
  return (await import("./mobile-native.js")).nativeRemoteDesktopPlatform();
}
export async function openNativeRemoteDesktop(url: string, title = "远程桌面"): Promise<void> {
  if (!isMobileApp()) throw new Error("原生远程桌面仅支持手机 App。");
  const native = await import("./mobile-native.js");
  const platform = native.nativeRemoteDesktopPlatform();
  let target = url;
  if (platform === "android" && !target) {
    const bridge = new URL(getBridgeOrigin());
    const host = bridge.hostname.replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
      throw new Error("Android 原生 VNC 不能连接 Bridge 的回环地址，请使用 Mac 的局域网或 VPN 地址。");
    }
    target = `vnc://${host.includes(":") ? `[${host}]` : host}:5900`;
  }
  await native.openNativeRemoteDesktop(target, title);
}
export async function closeNativeRemoteDesktop(): Promise<void> {
  if (isMobileApp()) await (await import("./mobile-native.js")).closeNativeRemoteDesktop();
}
export async function onNativeRemoteDesktopClosed(listener: () => void): Promise<{ remove(): Promise<void> }> {
  return (await import("./mobile-native.js")).onNativeRemoteDesktopClosed(listener);
}
export async function onNativeRemoteDesktopReconnect(listener: (event: { reason?: string }) => void): Promise<{ remove(): Promise<void> }> {
  return (await import("./mobile-native.js")).onNativeRemoteDesktopReconnect(listener);
}
export async function isMobileCrashDiagnosticsAvailable(): Promise<boolean> {
  return isMobileApp() && (await import("./mobile-native.js")).isMobileCrashDiagnosticsAvailable();
}
export async function getMobileCrashReportStatus(): Promise<import("./mobile-crash-diagnostics.js").MobileCrashReportStatus> {
  return (await import("./mobile-native.js")).getMobileCrashReportStatus();
}
export async function readMobileCrashReport(id: string): Promise<string> { return (await import("./mobile-native.js")).readMobileCrashReport(id); }
export async function captureMobileThreadSnapshot(): Promise<string> { return (await import("./mobile-native.js")).captureMobileThreadSnapshot(); }
export async function shareMobileCrashReport(id: string): Promise<void> { return (await import("./mobile-native.js")).shareMobileCrashReport(id); }
export async function getMobileVpnCapability(): Promise<MobileVpnCapability> {
  if (!isMobileApp()) return classifyMobileVpnPlatform("web", false);
  return (await import("./mobile-native.js")).getMobileVpnCapability();
}
export async function appOnlyVpnPocAvailable(): Promise<boolean> {
  if (!isMobileApp()) return false;
  return (await import("./mobile-native.js")).appOnlyVpnPocAvailable();
}
export async function getAppOnlyVpnPocStatus(): Promise<Record<string, unknown>> {
  return (await import("./mobile-native.js")).getAppOnlyVpnPocStatus();
}
export async function pickAppOnlyVpnProfile(): Promise<{ selectionId: string; fileName?: string }> {
  return (await import("./mobile-native.js")).pickAppOnlyVpnProfile();
}
export async function importAppOnlyVpnProfile(selectionId: string): Promise<Record<string, unknown>> {
  return (await import("./mobile-native.js")).importAppOnlyVpnProfile(selectionId);
}
export async function connectAppOnlyVpn(): Promise<Record<string, unknown>> {
  return (await import("./mobile-native.js")).connectAppOnlyVpn();
}
export async function disconnectAppOnlyVpn(): Promise<Record<string, unknown>> {
  return (await import("./mobile-native.js")).disconnectAppOnlyVpn();
}
export async function probeAppOnlyVpnHttp(options: { address: string; port: number; path: string }): Promise<{
  ok: boolean;
  bytes?: number;
  bodyUtf8?: string;
}> {
  return (await import("./mobile-native.js")).probeAppOnlyVpnHttp(options);
}
export async function openAppOnlyTmuxWebView(options: { address: string; port: number; path: string; credentialServer: string }): Promise<{
  opened: boolean;
  target?: string;
}> {
  return (await import("./mobile-native.js")).openAppOnlyTmuxWebView(options);
}
export async function clearAppOnlyVpnProfile(): Promise<void> {
  return (await import("./mobile-native.js")).clearAppOnlyVpnProfile();
}
/** Arm the native reachability monitor while the Bridge page is open. */
export async function startMobileVpnRecoveryMonitor(): Promise<boolean> {
  const selected = connection;
  if (!selected?.token) return false;
  const native = await import("./mobile-native.js");
  if (selected !== connection) return false;
  if (!native.getMobileVpnCapability().externalOpenVPNConnect ||
      (readBridgeNetworkSettings().iosVpnProvider ?? "external") !== "external") return false;
  return native.startOpenVPNConnectRecoveryMonitor(selected.server, readBridgeNetworkSettings().vpnBypassWifiSsids);
}

/** Stop the native reachability monitor when leaving the Bridge page. */
export async function stopMobileVpnRecoveryMonitor(): Promise<boolean> {
  if (!isMobileApp()) return false;
  return (await import("./mobile-native.js")).stopOpenVPNConnectRecoveryMonitor();
}
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

export function openMobileConnectionSettings(server?: string, error?: string): void {
  window.dispatchEvent(new CustomEvent(MOBILE_SETTINGS_EVENT, { detail: { ...(server ? { server } : {}), ...(error ? { error } : {}) } }));
}

function persistCredential(action: () => Promise<void>): Promise<void> {
  const pending = credentialQueue.then(action);
  credentialQueue = pending.catch(() => {});
  return pending;
}

const syncAutoVpnSettings = createMobileVpnSettingsSync(
  () => readBridgeNetworkSettings().vpnBypassWifiSsids,
  async (bypassWifiSsids, provider) => (await import("./mobile-native.js")).configureMobileAutoVpn(bypassWifiSsids, provider),
  () => readBridgeNetworkSettings().iosVpnProvider ?? "external",
);

function queueAutoVpnSettingsSync(): Promise<boolean> {
  autoVpnSettingsSync = syncAutoVpnSettings();
  return autoVpnSettingsSync;
}

async function awaitLatestVpnSettings(): Promise<boolean> {
  for (;;) {
    const pending = autoVpnSettingsSync ?? queueAutoVpnSettingsSync();
    const applied = await pending;
    if (pending === autoVpnSettingsSync) return applied;
  }
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
  if (!autoVpnSettingsSyncInstalled) {
    window.addEventListener(BRIDGE_NETWORK_SETTINGS_EVENT, () => { void queueAutoVpnSettingsSync(); });
    autoVpnSettingsSyncInstalled = true;
  }
  // Native checks are independent of pairing and SSH/Bridge target reachability.
  await queueAutoVpnSettingsSync();
  let savedServer: string | null = null;
  try {
    const saved = window.localStorage.getItem(SERVER_KEY);
    if (saved) savedServer = normalizeBridgeServer(saved);
  } catch { window.localStorage.removeItem(SERVER_KEY); }
  const server = savedServer ? normalizeConfiguredBridgeServer(savedServer) : null;
  if (server) {
    try {
      let token = await native.getCredential(server);
      if (!token && savedServer !== server && savedServer) {
        // Migrate the old exact-origin credential inside native storage. The
        // token never enters localStorage or a URL.
        token = await native.getCredential(savedServer);
        if (token) {
          await persistCredential(() => native.setCredential(server, token!));
          migratedCredentialServer = savedServer;
        }
      }
      connection = { server, token };
      window.localStorage.setItem(SERVER_KEY, server);
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
  removeGlobalVpnRecovery ??= subscribeBridgeApiUnreachable(() => {
    void requestMobileVpnRecovery().catch(() => {});
  });
  await native.installNativeLifecycle();
  document.documentElement.classList.add("bridge-mobile-app");
}

export async function checkMobileConnection(): Promise<boolean> {
  if (!connection?.token) return false;
  const selected = connection;
  markBridgeRequestStart();
  let requestEnded = false;
  try {
    const response = await fetch("/api/auth/status", { signal: AbortSignal.timeout(12_000), cache: "no-store" });
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403
        ? "Bridge 配对已失效，请重新配对。" : "Bridge 暂时无法连接（" + response.status + "）。");
      markBridgeRequestFailure(error, response.status);
      requestEnded = true;
      if (response.status === 401 || response.status === 403) await forgetMobileCredential();
      throw error;
    }
    const status = await readBridgeJson<AuthStatus>(response);
    if (selected !== connection) throw new DOMException("Bridge connection changed", "AbortError");
    if (typeof status.authenticated !== "boolean") throw new Error("当前后端的鉴权响应不兼容，请检查服务版本。");
    markBridgeRequestSuccess();
    requestEnded = true;
    if (status.authenticated) {
      setBridgeCapabilities(parseBridgeCapabilities(status.client));
      setLocalDraftScope(status.draftScope, selected.server);
      try { restoreMobileDownloads(window.localStorage, scopedStorageKey("mobile-downloads")); }
      catch { restoreMobileDownloads(null, null); }
      // Sync is independent of login and never blocks an offline-capable SSH page.
      void import("./composer-native-data.js").then((module) => module.syncNativeComposerData()).catch(() => {});
      if (migratedCredentialServer) {
        const native = await import("./mobile-native.js");
        const oldServer = migratedCredentialServer;
        migratedCredentialServer = null;
        void persistCredential(() => native.removeCredential(oldServer)).catch(() => {});
      }
    }
    if (!status.authenticated) await forgetMobileCredential();
    return status.authenticated;
  } catch (error) {
    if (!requestEnded) {
      const connectionChanged = error instanceof DOMException && error.name === "AbortError" && selected !== connection;
      // A foreground auth probe that aborts is still evidence that the
      // private API path failed. Background cancellation and an environment
      // switch remain silent and must not wake native VPN recovery.
      markBridgeRequestFailure(error, error instanceof BridgeResponseError ? error.status : undefined, {
        notifyNetworkRecovery: !connectionChanged && isAppForeground(),
      });
    }
    throw error;
  }
}

/** Probe the Bridge API origin to retry after the network becomes reachable. */
export async function requestMobileVpnRecovery(): Promise<boolean> {
  const selected = connection;
  if (!selected?.token) return false;
  let url: URL;
  try { url = new URL(normalizeConfiguredBridgeServer(selected.server)); }
  catch { return false; }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : Number.NaN;
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const native = await import("./mobile-native.js");
  if (!await awaitLatestVpnSettings() || selected !== connection || !isAppForeground()) return false;
  const capability = native.getMobileVpnCapability();
  const settings = readBridgeNetworkSettings();
  if (capability.platform === "ios" && (settings.iosVpnProvider ?? "external") === "external") {
    // Only the dedicated foreground Bridge probe arms the external client's
    // native monitor; ordinary WebView failures must not open another app.
    if (!capability.externalOpenVPNConnect || !isAppForeground()) return false;
    return native.startOpenVPNConnectRecoveryMonitor(selected.server, settings.vpnBypassWifiSsids);
  }
  return native.requestMobileVpnRecovery({
    host: url.hostname,
    port,
    bypassWifiSsids: settings.vpnBypassWifiSsids,
  });
}

export async function openExternalOpenVPNConnect(): Promise<boolean> {
  const native = await import("./mobile-native.js");
  if (!native.getMobileVpnCapability().externalOpenVPNConnect || !isAppForeground()) return false;
  const launched = await native.openExternalOpenVPNConnect();
  if (launched) window.dispatchEvent(new Event(MOBILE_OPENVPN_CONNECT_EVENT));
  return launched;
}

/** Explicitly check and start the selected native VPN without leaving Bridge. */
export async function checkAndConnectMobileVpn(): Promise<string> {
  const applied = await awaitLatestVpnSettings();
  const native = await import("./mobile-native.js");
  if (!applied) throw new Error(mobileVpnUnavailableMessage(native.getMobileVpnCapability().platform, "sync"));
  const settings = readBridgeNetworkSettings();
  return native.checkAndConnectMobileVpn(settings.vpnBypassWifiSsids, settings.iosVpnProvider ?? "external");
}

export async function readCurrentWifiSsid(): Promise<string | null> {
  return (await import("./mobile-native.js")).readCurrentWifiSsid();
}

export async function importMobileVpnProfile(): Promise<string> {
  if (!isMobileApp()) throw new Error(mobileVpnUnavailableMessage("browser", "import"));
  return (await import("./mobile-native.js")).importMobileVpnProfile();
}

/** Apply a changed global private-host setting to the live App connection. */
async function applyConfiguredBridgeOriginInternal(): Promise<void> {
  if (!isMobileApp()) return;
  const native = await import("./mobile-native.js");
  if (!connection) return;
  const selected = connection;
  const server = normalizeConfiguredBridgeServer(selected.server);
  if (server === selected.server) return;
  const token = selected.token ?? await native.getCredential(selected.server);
  if (connection !== selected) throw new DOMException("Bridge connection changed", "AbortError");
  if (token) await persistCredential(() => native.setCredential(server, token));
  if (connection !== selected) throw new DOMException("Bridge connection changed", "AbortError");
  commitMobileConnection({ server, token });
  if (token) void persistCredential(() => native.removeCredential(selected.server)).catch(() => {});
}

/** Apply only the Bridge origin, independent of optional VPN integration. */
export async function applyConfiguredBridgeOrigin(): Promise<void> {
  await applyConfiguredBridgeOriginInternal();
}

/** Apply the global host and VPN settings to the live App connection. */
export async function applyConfiguredBridgeNetworkSettings(): Promise<void> {
  if (!isMobileApp()) return;
  const native = await import("./mobile-native.js");
  const vpnApplied = await (autoVpnSettingsSync ?? queueAutoVpnSettingsSync());
  await applyConfiguredBridgeOriginInternal();
  if (!vpnApplied) throw new Error(
    mobileVpnUnavailableMessage(native.getMobileVpnCapability().platform, "sync"),
  );
}

export async function pairMobileConnection(address: string, code: string): Promise<void> {
  if (!originalFetch) throw new Error("App 尚未初始化，请重新打开。");
  const parsed = parseMobilePairingInput(address, code);
  const server = normalizeConfiguredBridgeServer(parsed.server);
  await connectionSwitch.run(async () => {
    const response = await originalFetch!(new URL("/api/auth/mobile/pair", server), {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code: parsed.code }), signal: AbortSignal.timeout(15_000),
    });
    const result = await readBridgeJson<{ token?: string; error?: string }>(response);
    if (!response.ok) throw new Error(result.error === "device authorization changed or was revoked"
      ? "设备授权已变化或撤销，请在设备管理中重新生成二维码。"
      : result.error || "配对失败（" + response.status + "）。");
    if (!result.token || !/^[A-Za-z0-9_-]{40,128}$/.test(result.token)) throw new Error("Bridge 返回了无效的配对结果。");
    const native = await import("./mobile-native.js");
    const token = result.token;
    await persistCredential(() => native.setCredential(server, token));
    return { server, token };
  }, (next) => { commitMobileConnection(next); return true; });
}

export async function switchMobileConnection(address: string): Promise<boolean> {
  if (!isMobileApp()) return false;
  const server = normalizeConfiguredBridgeServer(address);
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
  const previous = connection;
  const previousScope = getLocalDraftScope();
  window.localStorage.setItem(SERVER_KEY, next.server);
  connection = next;
  if (!previous || previous.server !== next.server || previous.token !== next.token) {
    void import("./composer-native-data.js")
      .then((module) => module.deactivateNativeComposerScope(previousScope, next.server)).catch(() => {});
  }
  // Keep the old draft scope until reload: pagehide must flush old drafts to the
  // old namespace, never into the newly selected server's namespace.
  window.dispatchEvent(new Event(MOBILE_CONNECTION_EVENT));
}

export async function forgetMobileCredential(): Promise<void> {
  const server = connection?.server;
  if (!server) return;
  migratedCredentialServer = null;
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
  await native.downloadBridgeFile(url.toString(), fileName, selected?.token ?? null, selected?.server);
}

/** @deprecated Use downloadBridgeFile for authenticated Bridge files. */
export async function shareBridgeFile(path: string, fileName = "bridge-file"): Promise<void> {
  await downloadBridgeFile(path, fileName);
}

export async function openIosOtaPage(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/\/[A-Za-z0-9_-]{43}\/$/.test(url.pathname)) throw new Error("iOS 安装地址无效。");
  await (await import("./mobile-native.js")).openIosOtaPage(url.href);
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

export async function copyMobileImage(blob: Blob): Promise<void> {
  await (await import("./mobile-native.js")).copyImage(blob);
}

export async function listMobileShares(): Promise<MobileShare[]> { return (await import("./mobile-native.js")).listIncomingShares(); }
export async function readMobileShareFiles(share: MobileShare): Promise<File[]> { return (await import("./mobile-native.js")).incomingShareFiles(share); }
export async function getMobileNotificationPermission(request = false): Promise<string> { return (await import("./mobile-native.js")).nativeNotificationPermission(request); }
export async function sendMobileNotification(options: { id: number; title: string; category: string; server: string; scope: string; route: string }): Promise<boolean> {
  return (await import("./mobile-native.js")).showNativeNotification(options);
}

export async function scanMobilePairingQr(instructions?: string): Promise<string | null> {
  return (await import("./mobile-native.js")).scanPairingQr(instructions);
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
