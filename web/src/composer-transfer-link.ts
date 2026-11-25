const TRANSFER_CODE = /^[A-HJ-NP-Z2-9]{10}$/;

/** Extract a short-lived Composer transfer code without navigating to an untrusted host. */
export function parseComposerTransferQr(value: string, currentBridgeOrigin: string): string {
  const raw = value.trim();
  const direct = raw.replace(/[\s-]/g, "").toUpperCase();
  if (TRANSFER_CODE.test(direct)) return direct;
  if (raw.length > 4096) throw new Error("二维码内容过长，请扫描 Composer 的同步二维码。");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("未识别到 Composer 同步二维码。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("二维码不是 Composer 同步链接。");
  const current = new URL(currentBridgeOrigin);
  if (url.hostname !== current.hostname) throw new Error("二维码属于另一台 Bridge，请在当前 Bridge 生成同步二维码。");
  if (url.pathname !== "/composer-transfer") throw new Error("二维码不是 Composer 同步链接。");
  for (const key of url.searchParams.keys()) if (key !== "code") throw new Error("同步二维码参数无效。");
  const code = url.searchParams.get("code")?.replace(/[\s-]/g, "").toUpperCase() ?? "";
  if (!TRANSFER_CODE.test(code)) throw new Error("同步二维码已损坏或已过期。");
  return code;
}
