/**
 * App-wide Mac target. Environment switching may change the port, but every
 * private Bridge endpoint and the default SSH target use this host.
 *
 * Native Android entry points receive this value from the WebView instead of
 * keeping a second user-specific IP constant.
 */
export const BRIDGE_GLOBAL_MAC_HOST = "10.15.53.70";
export const BRIDGE_NETWORK_SETTINGS_EVENT = "bridge:network-settings-changed";

const BRIDGE_NETWORK_SETTINGS_KEY = "bridge.mobile.network-settings";

export interface BridgeNetworkSettings {
  globalMacHost: string;
  vpnBypassWifiSsids: string[];
}

const DEFAULT_NETWORK_SETTINGS: BridgeNetworkSettings = {
  globalMacHost: BRIDGE_GLOBAL_MAC_HOST,
  vpnBypassWifiSsids: [],
};

function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

/** Validate a host entered for the Mac target without accepting a URL or port. */
export function normalizeGlobalMacHost(value: string): string {
  const host = value.trim().replace(/^\[|\]$/g, "");
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f\/?#@]/.test(host)) {
    throw new Error("全局 IP/主机格式不正确。请输入 IP 地址或主机名。");
  }
  if (host.includes(":")) {
    try {
      const parsed = new URL(`http://[${host}]`);
      if (!parsed.hostname) throw new Error("invalid IPv6 host");
    } catch {
      throw new Error("全局 IP/主机格式不正确。请输入 IP 地址或主机名。");
    }
    return host;
  }
  const ipv4 = host.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d+$/.test(part))) {
    if (ipv4.some((part) => Number(part) < 0 || Number(part) > 255)) {
      throw new Error("全局 IP/主机格式不正确。请输入 IP 地址或主机名。");
    }
    return host;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || host.includes("..")) {
    throw new Error("全局 IP/主机格式不正确。请输入 IP 地址或主机名。");
  }
  return host;
}

function normalizeWifiSsids(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const ssid = value.trim();
    if (!ssid || ssid.length > 128 || /[\u0000-\u001f\u007f]/.test(ssid) || result.includes(ssid)) continue;
    result.push(ssid);
    if (result.length >= 32) break;
  }
  return result;
}

export function readBridgeNetworkSettings(storage: Storage | null = browserStorage()): BridgeNetworkSettings {
  if (!storage) return { ...DEFAULT_NETWORK_SETTINGS, vpnBypassWifiSsids: [] };
  try {
    const raw = storage.getItem(BRIDGE_NETWORK_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_NETWORK_SETTINGS, vpnBypassWifiSsids: [] };
    const parsed = JSON.parse(raw) as { globalMacHost?: unknown; vpnBypassWifiSsids?: unknown };
    const globalMacHost = typeof parsed.globalMacHost === "string"
      ? (() => { try { return normalizeGlobalMacHost(parsed.globalMacHost!); } catch { return DEFAULT_NETWORK_SETTINGS.globalMacHost; } })()
      : DEFAULT_NETWORK_SETTINGS.globalMacHost;
    return { globalMacHost, vpnBypassWifiSsids: normalizeWifiSsids(parsed.vpnBypassWifiSsids) };
  } catch {
    return { ...DEFAULT_NETWORK_SETTINGS, vpnBypassWifiSsids: [] };
  }
}

export function getConfiguredGlobalMacHost(): string {
  return readBridgeNetworkSettings().globalMacHost;
}

export function saveBridgeNetworkSettings(
  input: { globalMacHost: string; vpnBypassWifiSsids: readonly string[] },
  storage: Storage | null = browserStorage(),
): BridgeNetworkSettings {
  const settings: BridgeNetworkSettings = {
    globalMacHost: normalizeGlobalMacHost(input.globalMacHost),
    vpnBypassWifiSsids: normalizeWifiSsids(input.vpnBypassWifiSsids),
  };
  if (!storage) throw new Error("当前环境无法保存网络配置。");
  storage.setItem(BRIDGE_NETWORK_SETTINGS_KEY, JSON.stringify(settings));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BRIDGE_NETWORK_SETTINGS_EVENT));
  return settings;
}

export function bridgeOriginForPort(port: number, protocol = "http:"): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError("Bridge port must be between 1 and 65535.");
  const url = new URL(`${protocol}//${urlHost(getConfiguredGlobalMacHost())}`);
  url.port = String(port);
  return url.origin;
}

/** Replace a private Bridge endpoint's host while retaining its protocol/port. */
export function bridgeOriginWithGlobalMacHost(origin: string, globalMacHost = getConfiguredGlobalMacHost()): string {
  const url = new URL(origin);
  url.hostname = urlHost(normalizeGlobalMacHost(globalMacHost));
  return url.origin;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
