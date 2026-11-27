import { describe, expect, it } from "bun:test";
import { parseComposerTransferQr, parseComposerTransferQrPayload } from "../web/src/composer-transfer-link.js";
import { createComposerPeerTransferQr } from "../web/src/composer-peer-transfer.js";

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

  it("accepts a same-host PeerJS direct-transfer link", () => {
    expect(parseComposerTransferQrPayload(
      "https://10.0.0.42:5173/composer-transfer?mode=peerjs&peer=bridge-peer_123&token=abcdefghijklmnopqrstuvwxyz",
      "http://10.0.0.42:17310",
    )).toEqual({ mode: "peerjs", peerId: "bridge-peer_123", token: "abcdefghijklmnopqrstuvwxyz" });
    expect(() => parseComposerTransferQr(
      "https://10.0.0.42:5173/composer-transfer?mode=peerjs&peer=bridge-peer_123&token=abcdefghijklmnopqrstuvwxyz",
      "http://10.0.0.42:17310",
    )).toThrow();
  });

  it("rejects malformed PeerJS capabilities and unknown QR parameters", () => {
    expect(() => parseComposerTransferQrPayload(
      "https://bridge.example/composer-transfer?mode=peerjs&peer=bad%20peer&token=short",
      "https://bridge.example",
    )).toThrow();
    expect(() => parseComposerTransferQrPayload(
      "https://bridge.example/composer-transfer?mode=peerjs&peer=peer-1&token=abcdefghijklmnopqrstuvwxyz&extra=1",
      "https://bridge.example",
    )).toThrow();
  });

  it("does not accept a WQDrop Composer envelope from another Bridge host", () => {
    const qr = createComposerPeerTransferQr("https://evil.example", "peer-1", "abcdefghijklmnopqrstuvwxyz");
    expect(() => parseComposerTransferQrPayload(qr, "https://bridge.example")).toThrow();
  });
});
