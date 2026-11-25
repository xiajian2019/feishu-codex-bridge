/** Browser build replacement: no native imports, configuration, or transport patching. */
import { classifyMobileVpnPlatform, type MobileVpnCapability } from "./mobile-vpn-contract.js";
import type {
  NearbyConnection, NearbyDiagnostic, NearbyError, NearbyFileOffer, NearbyFileProgress, NearbyFileSelection, NearbyListenerHandle,
  NearbyNetworkInfo, NearbyPeer, NearbyReceivedFile, NearbyServerInfo,
} from "./nearby-transfer-contract.js";

export const MOBILE_RESUME_EVENT = "bridge:mobile-resume";
export const MOBILE_CONNECTION_EVENT = "bridge:mobile-connection";
export const MOBILE_SETTINGS_EVENT = "bridge:mobile-settings";
export const MOBILE_SHAKE_EVENT = "bridge:mobile-shake";
export const MOBILE_OPENVPN_CONNECT_EVENT = "bridge:openvpn-connect-opened";
export const MOBILE_BACK_EVENT = "bridge:mobile-back";
export function isMobileApp(): boolean { return false; }
export async function isNativeRemoteDesktopAvailable(): Promise<boolean> { return false; }
export async function getNativeRemoteDesktopPlatform(): Promise<"ios" | "android" | null> { return null; }
export async function openNativeRemoteDesktop(_url: string, _title = "远程桌面"): Promise<void> { throw new Error("原生远程桌面仅支持手机 App。"); }
export async function closeNativeRemoteDesktop(): Promise<void> {}
export async function onNativeRemoteDesktopClosed(_listener: () => void): Promise<{ remove(): Promise<void> }> {
  return { remove: async () => {} };
}
export async function onNativeRemoteDesktopReconnect(_listener: (event: { reason?: string }) => void): Promise<{ remove(): Promise<void> }> {
  return { remove: async () => {} };
}
export function getBridgeOrigin(): string { return window.location.origin; }
export function bridgeUrl(path: string): string { return path; }
export function getMobileConnection(): null { return null; }
export async function nearbyTransferAvailable(): Promise<boolean> { return false; }
export async function nearbyStartServer(_displayName: string, _port?: number): Promise<NearbyServerInfo> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyStopServer(): Promise<void> {}
export async function nearbyStartDiscovery(): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyStopDiscovery(): Promise<void> {}
export async function nearbyGetNetworkInfo(): Promise<NearbyNetworkInfo> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyConnect(_options: { peerId?: string; host?: string; port?: number; token?: string; deviceId?: string; name?: string; source?: "mdns" | "hotspot" | "qr" }): Promise<{ connectionId: string }> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyDisconnect(_connectionId: string): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyPickFile(): Promise<NearbyFileSelection> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyAcceptConnection(_connectionId: string): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyRejectConnection(_connectionId: string): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyBeginFile(_options: { connectionId: string; transferId: string; selectionId: string }): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbySendFile(_options: { connectionId: string; transferId: string; selectionId: string }): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbySendChunk(_options: { connectionId: string; transferId: string; dataBase64: string; final: boolean }): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyAcceptFile(_connectionId: string, _transferId: string): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyRejectFile(_connectionId: string, _transferId: string): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyListReceived(): Promise<NearbyReceivedFile[]> { throw new Error("附近传文件仅支持手机 App。"); }
export async function openNearbyReceived(_file: NearbyReceivedFile): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function nearbyDeleteReceived(_id: string): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
export async function shareNearbyReceived(_file: NearbyReceivedFile): Promise<void> { throw new Error("附近传文件仅支持手机 App。"); }
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
export async function nearbyAddListener(_event: string, _handler: (event: never) => void): Promise<NearbyListenerHandle> { return { remove: async () => {} }; }
export async function getMobileAppVersion(): Promise<string> { return "浏览器"; }
export async function getMobileAppBuild(): Promise<number> { return 0; }
export async function isMobileCrashDiagnosticsAvailable(): Promise<boolean> { return false; }
export async function getMobileCrashReportStatus(): Promise<import("./mobile-crash-diagnostics.js").MobileCrashReportStatus> { throw new Error("本机崩溃诊断仅支持 iOS App。"); }
export async function readMobileCrashReport(_id: string): Promise<string> { throw new Error("本机崩溃诊断仅支持 iOS App。"); }
export async function captureMobileThreadSnapshot(): Promise<string> { throw new Error("本机崩溃诊断仅支持 iOS App。"); }
export async function shareMobileCrashReport(_id: string): Promise<void> { throw new Error("本机崩溃诊断仅支持 iOS App。"); }
export async function getMobileVpnCapability(): Promise<MobileVpnCapability> { return classifyMobileVpnPlatform("web", false); }
export async function appOnlyVpnPocAvailable(): Promise<boolean> { return false; }
export async function getAppOnlyVpnPocStatus(): Promise<Record<string, unknown>> { throw new Error("此功能仅在手机 App 中可用。"); }
export async function pickAppOnlyVpnProfile(): Promise<{ selectionId: string; fileName?: string }> { throw new Error("此功能仅在手机 App 中可用。"); }
export async function importAppOnlyVpnProfile(_selectionId: string): Promise<Record<string, unknown>> { throw new Error("此功能仅在手机 App 中可用。"); }
export async function connectAppOnlyVpn(): Promise<Record<string, unknown>> { throw new Error("此功能仅在手机 App 中可用。"); }
export async function disconnectAppOnlyVpn(): Promise<Record<string, unknown>> { throw new Error("此功能仅在手机 App 中可用。"); }
export async function probeAppOnlyVpnHttp(_options: { address: string; port: number; path: string }): Promise<{ ok: boolean; bytes?: number; bodyUtf8?: string }> { throw new Error("此功能仅在手机 App 中可用。"); }
export async function openAppOnlyTmuxWebView(_options: { address: string; port: number; path: string; credentialServer: string }): Promise<{ opened: boolean; target?: string }> { throw new Error("此功能仅在手机 App 中可用。"); }
export async function clearAppOnlyVpnProfile(): Promise<void> { throw new Error("此功能仅在手机 App 中可用。"); }
export function openMobileConnectionSettings(_server?: string, _error?: string): void {}
export async function initializeMobileRuntime(): Promise<void> {}
export async function checkMobileConnection(): Promise<boolean> { return false; }
export async function requestMobileVpnRecovery(): Promise<boolean> { return false; }
export async function openExternalOpenVPNConnect(): Promise<boolean> { return false; }
export async function startMobileVpnRecoveryMonitor(): Promise<boolean> { return false; }
export async function stopMobileVpnRecoveryMonitor(): Promise<boolean> { return false; }
export async function readCurrentWifiSsid(): Promise<string | null> { return null; }
export async function checkAndConnectMobileVpn(): Promise<string> { throw new Error("手动连接 VPN 仅支持已集成 BridgeAutoVpn 的原生 App。"); }
export async function importMobileVpnProfile(): Promise<string> { throw new Error("OpenVPN 配置导入仅支持已集成 BridgeAutoVpn 的 iOS App。"); }
export async function applyConfiguredBridgeNetworkSettings(): Promise<void> {}
export async function applyConfiguredBridgeOrigin(): Promise<void> {}
export async function mobileStreamUrl(path: string): Promise<string> { return new URL(path, window.location.origin).toString(); }
async function appOnly(): Promise<never> { throw new Error("此功能仅在手机 App 中可用。"); }
export const pairMobileConnection = appOnly;
export const forgetMobileCredential = appOnly;
export const disconnectMobileConnection = appOnly;
export const switchMobileConnection = async (): Promise<boolean> => false;
export const downloadBridgeFile = appOnly;
export const shareBridgeFile = appOnly;
export const shareMobileBlob = appOnly;
export const openBridgeExternal = appOnly;
export const openIosOtaPage = appOnly;
export const openMobileDemo = appOnly;
export const copyMobileText = appOnly;
export const copyMobileImage = appOnly;
export const listMobileShares = appOnly;
export const readMobileShareFiles = appOnly;
export const getMobileNotificationPermission = appOnly;
export const sendMobileNotification = appOnly;
export async function scanMobilePairingQr(_instructions?: string): Promise<never> { return appOnly(); }
export const setMobileShakeEnabled = appOnly;
export const supportsMobileApkUpdates = async (): Promise<boolean> => false;
export const checkMobileApkUpdate = async (): Promise<never> => appOnly();
export const installMobileApkUpdate = async (): Promise<never> => appOnly();
export const downloadMobileApkUpdate = async (): Promise<never> => appOnly();
