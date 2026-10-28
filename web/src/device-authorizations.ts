export type DeviceAuthorizationState = "active" | "expired" | "revoked";
export interface DeviceAuthorization {
  sessionId: string;
  current: boolean;
  deviceName: string;
  userAgent: string | null;
  remoteAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  status?: DeviceAuthorizationState;
  revokedAt?: string | null;
  clientType?: "browser" | "app" | "unknown";
  lastAccessOrigin?: string | null;
  lastAccessOriginAt?: string | null;
}
export interface DevicePresentation {
  name: string;
  browser: string;
  system: string;
  app: boolean;
  model: string | null;
  modelKey: string | null;
  shortId: string;
  customName: boolean;
}
const DEFAULT_NAMES = new Set(["Android", "华为手机", "iPhone / iPad", "iPhone", "iPad", "Mac", "Windows", "Linux", "Browser device", "浏览器设备"]);
const DAY = 86_400_000;

export function deviceAuthorizationState(device: DeviceAuthorization, now = Date.now()): DeviceAuthorizationState {
  if (device.status) return device.status;
  const expiry = Date.parse(device.expiresAt);
  if (device.revokedAt && Date.parse(device.revokedAt) < expiry) return "revoked";
  return Number.isFinite(expiry) && expiry > now ? "active" : "expired";
}

/** UA is a display hint only. Never use it or IP to merge or authorize devices. */
export function describeDevice(device: DeviceAuthorization): DevicePresentation {
  const ua = device.userAgent ?? "";
  const bridgeApp = ua.match(/(?:^|\s)BridgeApp\/([A-Za-z0-9][A-Za-z0-9._+-]{0,63})(?=\s|$)/i);
  const app = bridgeApp !== null || device.clientType === "app";
  const huawei = /huawei|harmonyos/i.test(ua);
  const ipad = /ipad/i.test(ua);
  const iphone = /iphone/i.test(ua) || (app && /\(iOS\)/i.test(ua) && !ipad);
  const android = /android/i.test(ua);
  const mac = /macintosh|mac os x/i.test(ua) && !ipad && !iphone;
  const windows = /windows/i.test(ua);
  const kind = huawei ? "华为手机" : ipad ? "iPad" : iphone ? "iPhone" : android ? "Android 手机" : mac ? "Mac" : windows ? "Windows 电脑" : /linux/i.test(ua) ? "Linux 电脑" : "未知设备";
  const version = (pattern: RegExp): string => ua.match(pattern)?.[1]?.replaceAll("_", ".") ?? "";
  const labelled = (name: string, value: string): string => value ? `${name} ${value}` : name;
  const major = (pattern: RegExp): string => version(pattern).split(".").slice(0, 2).join(".");
  let browser: string;
  if (bridgeApp) browser = `Bridge App ${bridgeApp[1]}`;
  else if (/lark\/|feishu\//i.test(ua)) browser = labelled("飞书内嵌", major(/(?:Lark|Feishu)\/([\d.]+)/i));
  else if (/;\s*wv(?:[;)\s]|$)/i.test(ua)) browser = labelled("内嵌浏览器 WebView", major(/Chrome\/([\d.]+)/i));
  else if (/HuaweiBrowser\//i.test(ua)) browser = labelled("华为浏览器", major(/HuaweiBrowser\/([\d.]+)/i));
  else if (/Edg(?:A|iOS)?\//i.test(ua)) browser = labelled("Edge", major(/Edg(?:A|iOS)?\/([\d.]+)/i));
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = labelled("Firefox", major(/(?:Firefox|FxiOS)\/([\d.]+)/i));
  else if (/SamsungBrowser\//i.test(ua)) browser = labelled("三星浏览器", major(/SamsungBrowser\/([\d.]+)/i));
  else if (/OPR\//i.test(ua)) browser = labelled("Opera", major(/OPR\/([\d.]+)/i));
  else if (/Chrome\/|CriOS\//i.test(ua)) browser = labelled("Chrome", major(/(?:Chrome|CriOS)\/([\d.]+)/i));
  else if (/Safari\//i.test(ua)) browser = labelled("Safari", major(/Version\/([\d.]+)/i));
  else browser = "未知浏览器";
  const iosVersion = version(/(?:CPU(?: iPhone)? OS|iPhone OS) ([\d_]+)/i);
  const system = /HarmonyOS/i.test(ua) ? labelled("HarmonyOS", version(/HarmonyOS[ /]([\d.]+)/i))
    : ipad || iphone ? labelled(ipad ? "iPadOS" : "iOS", iosVersion)
    : android ? labelled("Android", version(/Android ([\d.]+)/i))
    : mac ? labelled("macOS", version(/Mac OS X ([\d_]+)/i)) : windows ? "Windows" : /Linux/i.test(ua) ? "Linux" : "未知系统";
  let model: string | null = null;
  if (android) {
    const tail = ua.match(/Android [^;)]*;([^)]*)/i)?.[1] ?? "";
    const candidates = tail.split(";").map((part) => part.replace(/Build\/.*$/i, "").trim())
      .filter((part) => part.length > 1 && !/^(?:wv|U|HarmonyOS(?:[ /].*)?|HMSCore.*|[a-z]{2}[-_][a-z]{2})$/i.test(part));
    model = candidates.at(-1)?.slice(0, 80) ?? null;
  }
  if (device.clientType === "app" && !bridgeApp) browser = "Bridge App";
  const customName = !DEFAULT_NAMES.has(device.deviceName);
  return { name: customName ? device.deviceName : kind, browser, system, app, model,
    // Same model is a review aid, not proof of a shared physical device.
    modelKey: model ? `${huawei ? "huawei" : "android"}:${model.toLowerCase()}` : null,
    shortId: device.sessionId.replaceAll("-", "").slice(0, 8).toUpperCase(), customName };
}

export function deviceAccessEnvironment(device: DeviceAuthorization): { origin: string; port: string } | null {
  if (!device.lastAccessOrigin || !device.lastAccessOriginAt) return null;
  const observed = Date.parse(device.lastAccessOriginAt), lastSeen = Date.parse(device.lastSeenAt);
  // An older shared-DB writer may advance last_seen_at without knowing this field.
  if (!Number.isFinite(observed) || !Number.isFinite(lastSeen) || observed < lastSeen) return null;
  try {
    const url = new URL(device.lastAccessOrigin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, port: url.port || (url.protocol === "https:" ? "443" : "80") };
  } catch { return null; }
}

export function sameModelCounts(devices: DeviceAuthorization[], now = Date.now()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const device of devices) {
    if (deviceAuthorizationState(device, now) !== "active") continue;
    const key = describeDevice(device).modelKey;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function sortDeviceAuthorizations(devices: DeviceAuthorization[]): DeviceAuthorization[] {
  return [...devices].sort((left, right) => Number(right.current) - Number(left.current)
    || (Date.parse(right.lastSeenAt) || 0) - (Date.parse(left.lastSeenAt) || 0)
    || right.createdAt.localeCompare(left.createdAt) || left.sessionId.localeCompare(right.sessionId));
}

export function matchesDeviceSearch(device: DeviceAuthorization, query: string): boolean {
  const profile = describeDevice(device);
  const text = [device.deviceName, device.remoteAddress, device.sessionId, profile.name, profile.browser, profile.model, profile.system, deviceAccessEnvironment(device)?.origin].join(" ").toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every((term) => text.includes(term));
}

export function deviceLastUsed(value: string, now = Date.now()): string {
  const duration = now - Date.parse(value);
  if (!Number.isFinite(duration)) return "最近使用时间未知";
  if (duration < 60_000) return "刚刚使用";
  if (duration < 3_600_000) return `${Math.floor(duration / 60_000)} 分钟前使用`;
  if (duration < DAY) return `${Math.floor(duration / 3_600_000)} 小时前使用`;
  return `${Math.floor(duration / DAY)} 天前使用`;
}

export function deviceExpiry(value: string, now = Date.now()): string {
  const remaining = Date.parse(value) - now;
  if (!Number.isFinite(remaining)) return "到期时间未知";
  if (remaining <= 0) return "已到期";
  if (remaining < DAY) return "不足 1 天到期";
  return `剩余 ${Math.ceil(remaining / DAY)} 天`;
}

export function selectableDeviceIds(devices: DeviceAuthorization[], now = Date.now()): string[] {
  return devices.filter((device) => !device.current && deviceAuthorizationState(device, now) === "active").map((device) => device.sessionId);
}
