// qr-scanner's UMD entry and NodeNext declaration interop differ. Keep the
// browser adapter explicit; both the library and worker are bundled locally.
export interface PairingScannerInstance {
  start(): Promise<void>;
  stop(): void;
  destroy(): void;
  setInversionMode(mode: "both"): void;
}
interface PairingScannerLibrary {
  new(video: HTMLVideoElement, onDecode: (result: { data: string }) => void, options: {
    preferredCamera: "environment";
    maxScansPerSecond: number;
    highlightScanRegion: boolean;
    highlightCodeOutline: boolean;
    returnDetailedScanResult: true;
    onDecodeError: () => void;
  }): PairingScannerInstance;
  scanImage(image: HTMLCanvasElement, options: { returnDetailedScanResult: true }): Promise<{ data: string }>;
}
let library: Promise<PairingScannerLibrary> | undefined;
export function loadPairingScanner(): Promise<PairingScannerLibrary> {
  return library ??= import("qr-scanner").then((module) => module.default as unknown as PairingScannerLibrary)
    .catch((error: unknown) => { library = undefined; throw error; });
}

export function pairingScanMode(protocol: string, secureContext: boolean, hasMediaDevices: boolean): "live" | "photo" {
  return protocol === "https:" && secureContext && hasMediaDevices ? "live" : "photo";
}

export function pairingCameraFailure(error: unknown, app: boolean): string {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/NotAllowed|Permission|permission|denied/.test(detail)) return app
    ? "相机权限被拒绝，请在系统设置中允许 Bridge 使用相机；也可以选择本地二维码图片。"
    : "摄像头权限被拒绝，请在浏览器的站点权限中允许相机，或选择二维码图片。";
  if (/NotReadable|TrackStart|in use|busy|占用/i.test(detail)) return "相机被占用或暂时不可用，请关闭其他相机应用后重新扫码；也可选择本地图片。";
  if (/NotFound|not found|No camera/i.test(detail)) return "没有找到可用摄像头，可选择本地二维码图片。";
  return "暂时无法打开相机，请重新扫码，或使用本地二维码图片。";
}
