/** Browser build replacement: no native imports, configuration, or transport patching. */
import { classifyMobileVpnPlatform, type MobileVpnCapability } from "./mobile-vpn-contract.js";

export const MOBILE_RESUME_EVENT = "bridge:mobile-resume";
export const MOBILE_CONNECTION_EVENT = "bridge:mobile-connection";
export const MOBILE_SETTINGS_EVENT = "bridge:mobile-settings";
export const MOBILE_SHAKE_EVENT = "bridge:mobile-shake";
export const MOBILE_OPENVPN_CONNECT_EVENT = "bridge:openvpn-connect-opened";
export const MOBILE_BACK_EVENT = "bridge:mobile-back";
export function isMobileApp(): boolean { return false; }
export function getBridgeOrigin(): string { return window.location.origin; }
export function bridgeUrl(path: string): string { return path; }
export function getMobileConnection(): null { return null; }
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
export const scanMobilePairingQr = appOnly;
export const setMobileShakeEnabled = appOnly;
export const supportsMobileApkUpdates = async (): Promise<boolean> => false;
export const checkMobileApkUpdate = async (): Promise<never> => appOnly();
export const installMobileApkUpdate = async (): Promise<never> => appOnly();
export const downloadMobileApkUpdate = async (): Promise<never> => appOnly();
