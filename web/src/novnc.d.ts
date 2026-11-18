declare module "@novnc/novnc" {
  export const bridgeNoVNCCodecReady: Promise<void>;
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: { username?: string; password?: string } });
    viewOnly: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    dragViewport: boolean;
    focusOnClick: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string }): void;
    sendKey(keysym: number, code?: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}
