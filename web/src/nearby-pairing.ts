import type { NearbyNetworkInfo, NearbyServerInfo } from "./nearby-transfer-contract.js";

export interface NearbyPairingInfo {
  deviceId: string;
  name: string;
  port: number;
  token: string;
  addresses: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{32}$/i;

function localAddress(address: string): boolean {
  const octets = address.split(".");
  if (octets.length === 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
    const [a, b] = octets.map(Number);
    return a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
  }
  // Scoped link-local IPv6 addresses name the sender's interface and cannot be
  // reused as the receiver's interface; use IPv4 or a routable IPv6 address.
  if (!address.includes(":") || address.includes("%") || !/^[0-9a-f:.]+$/i.test(address)) return false;
  try {
    const host = new URL(`http://[${address}]/`).hostname.toLowerCase();
    return /^\[(?:2|3|fc|fd)/.test(host);
  } catch { return false; }
}

export function createNearbyPairingUrl(server: NearbyServerInfo, network: NearbyNetworkInfo): string {
  const addresses = [...new Set(network.addresses.filter(localAddress))].slice(0, 8);
  if (!addresses.length) throw new Error("未找到可用于扫码连接的局域网地址，请检查 Wi‑Fi 或热点后刷新。");
  if (!UUID.test(server.deviceId) || !TOKEN.test(server.token) || !Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) {
    throw new Error("本机附近传文件服务信息无效，请重试。");
  }
  const url = new URL("bridge-nearby://pair");
  url.searchParams.set("v", "1");
  url.searchParams.set("id", server.deviceId);
  url.searchParams.set("name", server.displayName.slice(0, 80));
  url.searchParams.set("port", String(server.port));
  url.searchParams.set("token", server.token);
  for (const address of addresses) url.searchParams.append("address", address);
  return url.toString();
}

export function parseNearbyPairingUrl(value: string): NearbyPairingInfo {
  if (value.length > 2048) throw new Error("附近设备二维码内容过长。");
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("请扫描附近传文件页面上的二维码。"); }
  const deviceId = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const name = url.searchParams.get("name") ?? "附近设备";
  const port = Number(url.searchParams.get("port"));
  const addresses = [...new Set(url.searchParams.getAll("address"))];
  if (url.protocol !== "bridge-nearby:" || url.hostname !== "pair" || url.pathname !== "" || url.username || url.password || url.hash ||
      url.searchParams.get("v") !== "1" || !UUID.test(deviceId) || !TOKEN.test(token) || name.length > 80 ||
      !Number.isInteger(port) || port < 1 || port > 65_535 || !addresses.length || addresses.length > 8 || !addresses.every(localAddress)) {
    throw new Error("附近设备二维码无效，请让对方刷新后重新生成。");
  }
  return { deviceId: deviceId.toLowerCase(), name: name || "附近设备", port, token, addresses };
}
