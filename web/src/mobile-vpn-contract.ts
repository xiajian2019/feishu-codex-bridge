export type MobileVpnPlatform = "android" | "ios" | "browser" | "unsupported";

export interface MobileVpnCapability {
  platform: MobileVpnPlatform;
  pluginAvailable: boolean;
  enabled: boolean;
  profileImport: boolean;
  externalOpenVPNConnect: boolean;
}

/**
 * The native picker keeps the selected URL and profile contents on the native
 * side. WebView receives only an opaque handle that is immediately returned to
 * the plugin's import method.
 */
export interface MobileVpnProfileSelection {
  selectionId: string;
  fileName?: string;
}

export function classifyMobileVpnPlatform(
  platform: string,
  pluginAvailable: boolean,
  externalOpenVPNConnect = false,
): MobileVpnCapability {
  const normalized: MobileVpnPlatform = platform === "android" ? "android"
    : platform === "ios" ? "ios"
      : platform === "web" ? "browser" : "unsupported";
  const native = normalized === "android" || normalized === "ios";
  const available = native && pluginAvailable;
  return {
    platform: normalized,
    pluginAvailable: available,
    enabled: available,
    profileImport: normalized === "ios" && available,
    externalOpenVPNConnect: normalized === "ios" && externalOpenVPNConnect,
  };
}

export function normalizeMobileVpnProfileSelection(value: unknown): MobileVpnProfileSelection {
  if (!value || typeof value !== "object") throw new Error("未选择有效的 .ovpn 配置。");
  const candidate = value as Record<string, unknown>;
  const selectionId = typeof candidate.selectionId === "string" ? candidate.selectionId.trim() : "";
  if (!selectionId || selectionId.length > 512 || /[\u0000-\u001f\u007f]/.test(selectionId)) {
    throw new Error("原生 VPN 返回了无效的配置选择。");
  }
  const fileName = typeof candidate.fileName === "string" ? candidate.fileName.trim() : "";
  if (fileName && (!/^[^/\\\u0000-\u001f\u007f]{1,160}\.ovpn$/i.test(fileName))) {
    throw new Error("请选择 .ovpn 配置文件。");
  }
  return { selectionId, ...(fileName ? { fileName } : {}) };
}

export function mobileVpnUnavailableMessage(
  platform: MobileVpnPlatform,
  action: "connect" | "wifi" | "import" | "sync",
): string {
  if (action === "connect") {
    if (platform === "ios") return "手动连接 VPN 需要当前 iOS App 集成 BridgeAutoVpn；请先导入 .ovpn 配置或更新 App。";
    if (platform === "android") return "手动连接 VPN 需要当前 Android App 提供自动 VPN 功能，请更新 App 后重试。";
    return "手动连接 VPN 仅支持已集成 BridgeAutoVpn 的原生 App。";
  }
  if (action === "wifi") {
    if (platform === "ios") return "无法读取当前 Wi‑Fi 名称，可能未授予 iOS 所需的 Wi‑Fi 信息权限；请手动输入 SSID。";
    if (platform === "android") return "读取当前 Wi‑Fi 需要当前 Android App 提供自动 VPN 功能，请手动输入 SSID 或更新 App。";
    return "当前平台无法读取 Wi‑Fi 名称，请手动输入 SSID。";
  }
  if (action === "import") return "当前 iOS App 尚未集成 BridgeAutoVpn，无法导入 .ovpn 配置；请更新 App 或手动配置 VPN。";
  if (platform === "ios") return "自动 VPN 网络设置尚未同步到 iOS App，请重新打开 App 后重试。";
  if (platform === "android") return "自动 VPN 网络设置尚未同步到 Android App，请重新打开 App 后重试。";
  return "自动 VPN 网络设置尚未同步到当前原生 App，请重新打开 App 后重试。";
}
