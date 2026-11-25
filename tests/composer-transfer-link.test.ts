import { describe, expect, it } from "bun:test";
import { parseComposerTransferQr } from "../web/src/composer-transfer-link.js";

describe("Composer transfer QR links", () => {
  it("accepts a short code and a same-host dev link", () => {
    expect(parseComposerTransferQr("77JPC3SXGH", "http://10.0.0.42:17310")).toBe("77JPC3SXGH");
    expect(parseComposerTransferQr("http://10.0.0.42:5173/composer-transfer?code=77JPC3SXGH", "http://10.0.0.42:17310")).toBe("77JPC3SXGH");
  });

  it("rejects external hosts and non-transfer routes", () => {
    expect(() => parseComposerTransferQr("https://evil.example/composer-transfer?code=77JPC3SXGH", "https://bridge.example")).toThrow();
    expect(() => parseComposerTransferQr("https://bridge.example/tmux-dashboard?session=x", "https://bridge.example")).toThrow();
    expect(() => parseComposerTransferQr("https://bridge.example/composer-transfer?code=BAD", "https://bridge.example")).toThrow();
  });
});
