import { getActionToken, getJson } from "./api.js";
import { bridgeUrl, getBridgeOrigin } from "./mobile-runtime.js";
import type { DesktopDisplay } from "./remote-desktop-viewport.js";

/** The credential is a one-use, path-bound ticket, not a device token. */
export async function createRemoteDesktopStreamUrl(): Promise<string> {
  const origin = getBridgeOrigin();
  const actionToken = await getActionToken();
  if (origin !== getBridgeOrigin()) throw new DOMException("Bridge connection changed", "AbortError");
  const { ticket } = await getJson<{ ticket: string }>("/api/remote-desktop/ticket", {
    method: "POST", headers: { "X-Bridge-Action-Token": actionToken },
  });
  if (origin !== getBridgeOrigin()) throw new DOMException("Bridge connection changed", "AbortError");
  if (!ticket) throw new Error("远程桌面授权失败，请重新连接。");
  const target = new URL(bridgeUrl("/remote-desktop/stream"), window.location.href);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.searchParams.set("bridgeTicket", ticket);
  return target.toString();
}

/** Optional on older servers; never reuse a cached layout after displays change. */
export async function readRemoteDesktopDisplays(): Promise<DesktopDisplay[]> {
  const origin = getBridgeOrigin();
  const response = await fetch("/api/remote-desktop/displays", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (origin !== getBridgeOrigin()) throw new DOMException("Bridge connection changed", "AbortError");
  if (!response.ok) return [];
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("displays" in value) || !Array.isArray(value.displays)) return [];
  return value.displays.filter((item: unknown): item is DesktopDisplay => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return Number.isSafeInteger(record.id) && typeof record.name === "string"
      && typeof record.builtIn === "boolean" && typeof record.main === "boolean"
      && ["x", "y", "width", "height", "pixelWidth", "pixelHeight"].every((key) =>
        typeof record[key] === "number" && Number.isFinite(record[key]))
      && (record.width as number) > 0 && (record.height as number) > 0;
  }).slice(0, 16);
}
