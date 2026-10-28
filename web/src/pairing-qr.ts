import type { Options, QRCode } from "jsqr";
import { loadPairingScanner } from "./pairing-scanner.js";
import { recordPairingScan, type PairingScanObservation } from "./pairing-diagnostics.js";

type QrDecoder = (data: Uint8ClampedArray, width: number, height: number, options?: Options) => QRCode | null;
let decoder: Promise<QrDecoder> | undefined;
function loadDecoder(): Promise<QrDecoder> {
  // jsQR is CommonJS; NodeNext types its dynamic default as a module namespace.
  return decoder ??= import("jsqr").then((module) => module.default as unknown as QrDecoder)
    .catch((error: unknown) => { decoder = undefined; throw error; });
}

/** Accept a code or a Bridge QR link, keeping the claim on this page and host. */
export function parsePairingInput(value: string, origin: string): string {
  const text = value.trim();
  if (!text || text.length > 2048) throw new Error("请扫描 Bridge 配对二维码，或输入配对链接/配对码。");
  let code = text;
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    if (url.username || url.password || url.hostname !== new URL(origin).hostname) {
      throw new Error("二维码地址与当前 Bridge 不一致，请使用当前 Bridge 的配对二维码。");
    }
    // CLI commonly uses 7310 while the same host's development page uses 5173.
    // Claim locally instead of navigating to another browser, port, or page.
    code = new URLSearchParams(url.hash.slice(1)).get("pair") ?? "";
  }
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalized)) {
    throw new Error("未识别到有效的 Bridge 配对码，请使用包含 #pair= 的配对二维码。");
  }
  return normalized.match(/.{4}/g)!.join("-");
}

export async function decodePairingPixels(data: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const read = await loadDecoder();
  return read(data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

export async function decodePairingImage(file: File, onObservation?: (scan: PairingScanObservation) => void): Promise<string> {
  if (file.type && !file.type.startsWith("image/")) throw new Error("请选择二维码图片。");
  const url = URL.createObjectURL(file);
  let width: number | null = null, height: number | null = null, attempts = 0;
  const observe = (outcome: PairingScanObservation["outcome"]): void => {
    const scan: PairingScanObservation = { mode: "image", outcome, width, height, attempts };
    recordPairingScan(scan);
    onObservation?.(scan);
  };
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片无法读取，请选择清晰的二维码图片。"));
      image.src = url;
    });
    width = image.naturalWidth;
    height = image.naturalHeight;
    if (!width || !height) throw new Error("图片分辨率无效，请重新选择图片。");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法读取图片，请输入配对链接或配对码。");
    const maxDimension = Math.max(width, height);
    // Preserve detail first, then try smaller scales to reduce screen moire and
    // thresholding artifacts. A single 2000px downscale can erase a distant QR.
    const sizes = [...new Set([Math.min(maxDimension, 4096), Math.min(maxDimension, 1600), Math.min(maxDimension, 900)])];
    const Scanner = await loadPairingScanner().catch(() => null);
    for (const size of sizes) {
      const scale = size / maxDimension;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (Scanner) {
        attempts++;
        try {
          const result = await Scanner.scanImage(canvas, { returnDetailedScanResult: true });
          observe("decoded");
          return result.data;
        } catch { /* Try an independent local decoder and another scale. */ }
      }
      attempts++;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = await decodePairingPixels(pixels.data, pixels.width, pixels.height);
      if (result) { observe("decoded"); return result; }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    observe("not_detected");
    throw new Error(`未能从 ${width}×${height} 图片中读出二维码（已尝试多尺寸识别）。请让二维码占据画面主要区域，避开反光，或使用原始二维码截图/配对链接。`);
  } catch (error) {
    if (!attempts) observe("image_unreadable");
    throw error;
  } finally { URL.revokeObjectURL(url); }
}
