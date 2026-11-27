import { parseComposerPeerTransferQr } from "./composer-peer-transfer.js";

const TRANSFER_CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const PEER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PEER_TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

export type ComposerTransferQrPayload =
  | { mode: "server"; code: string }
  | { mode: "peerjs"; peerId: string; token: string };

/** Parse either the existing Bridge relay QR or a PeerJS direct-transfer QR. */
export function parseComposerTransferQrPayload(value: string, currentBridgeOrigin: string): ComposerTransferQrPayload {
  const raw = value.trim();
  const direct = raw.replace(/[\s-]/g, "").toUpperCase();
  if (TRANSFER_CODE.test(direct)) return { mode: "server", code: direct };
  if (raw.length > 4096) throw new Error("二维码内容过长，请扫描 Composer 的同步二维码。");
  const current = new URL(currentBridgeOrigin);
  const composerPeer = parseComposerPeerTransferQr(raw);
  if (composerPeer) {
    if (new URL(composerPeer.origin).hostname !== current.hostname) throw new Error("二维码属于另一台 Bridge，请在当前 Bridge 生成同步二维码。");
    return { mode: "peerjs", peerId: composerPeer.peerId, token: composerPeer.token };
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("未识别到 Composer 同步二维码。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("二维码不是 Composer 同步链接。");
  if (url.hostname !== current.hostname) throw new Error("二维码属于另一台 Bridge，请在当前 Bridge 生成同步二维码。");
  if (url.pathname !== "/composer-transfer") throw new Error("二维码不是 Composer 同步链接。");
  const mode = url.searchParams.get("mode") ?? "server";
  if (mode === "peerjs") {
    for (const key of url.searchParams.keys()) if (!["mode", "peer", "token"].includes(key)) throw new Error("WebRTC 同步二维码参数无效。");
    const peerId = url.searchParams.get("peer") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (!PEER_ID.test(peerId) || !PEER_TOKEN.test(token)) throw new Error("WebRTC 同步二维码已损坏或已失效。");
    return { mode: "peerjs", peerId, token };
  }
  if (mode !== "server") throw new Error("同步二维码方式无效。");
  for (const key of url.searchParams.keys()) if (key !== "code" && key !== "mode") throw new Error("同步二维码参数无效。");
  const code = url.searchParams.get("code")?.replace(/[\s-]/g, "").toUpperCase() ?? "";
  if (!TRANSFER_CODE.test(code)) throw new Error("同步二维码已损坏或已过期。");
  return { mode: "server", code };
}

/** Extract a short-lived Composer transfer code without navigating to an untrusted host. */
export function parseComposerTransferQr(value: string, currentBridgeOrigin: string): string {
  const payload = parseComposerTransferQrPayload(value, currentBridgeOrigin);
  if (payload.mode !== "server") throw new Error("这是 WebRTC 直传二维码，请在直传页面继续。");
  return payload.code;
}
