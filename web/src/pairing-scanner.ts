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
