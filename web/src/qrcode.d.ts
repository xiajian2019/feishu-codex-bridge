declare module "qrcode" {
  interface QRCodeColorOptions {
    dark?: string;
    light?: string;
  }

  interface QRCodeDataUrlOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    width?: number;
    color?: QRCodeColorOptions;
  }

  export function toDataURL(text: string, options?: QRCodeDataUrlOptions): Promise<string>;
}
