/** Browser build replacement: no native imports, configuration, or transport patching. */
export const MOBILE_RESUME_EVENT = "bridge:mobile-resume";
export const MOBILE_CONNECTION_EVENT = "bridge:mobile-connection";
export const MOBILE_SETTINGS_EVENT = "bridge:mobile-settings";
export const MOBILE_SHAKE_EVENT = "bridge:mobile-shake";
export const MOBILE_BACK_EVENT = "bridge:mobile-back";
export function isMobileApp(): boolean { return false; }
export function getBridgeOrigin(): string { return window.location.origin; }
export function bridgeUrl(path: string): string { return path; }
export function getMobileConnection(): null { return null; }
export async function getMobileAppVersion(): Promise<string> { return "浏览器"; }
export async function getMobileAppBuild(): Promise<number> { return 0; }
export function openMobileConnectionSettings(_server?: string): void {}
export async function initializeMobileRuntime(): Promise<void> {}
export async function checkMobileConnection(): Promise<boolean> { return false; }
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
export const openMobileDemo = appOnly;
export const copyMobileText = appOnly;
export const scanMobilePairingQr = appOnly;
export const supportsMobileApkUpdates = async (): Promise<boolean> => false;
export const checkMobileApkUpdate = async (): Promise<never> => appOnly();
export const installMobileApkUpdate = async (): Promise<never> => appOnly();
export const downloadMobileApkUpdate = async (): Promise<never> => appOnly();
