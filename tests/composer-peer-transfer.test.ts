import { expect, test } from "bun:test";
import {
  COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES,
  COMPOSER_PEER_TRANSFER_MAX_FILES,
  COMPOSER_PEER_TRANSFER_MAX_TOTAL_BYTES,
  createComposerPeerTransferQr,
  createComposerPeerTransferUrl,
  formatComposerPeerBytes,
  peerMessageBytes,
  validateComposerPeerOffer,
} from "../web/src/composer-peer-transfer.js";
import { parseComposerTransferQrPayload } from "../web/src/composer-transfer-link.js";

test("PeerJS Composer QR keeps the Bridge origin and direct-transfer capability", () => {
  const url = createComposerPeerTransferUrl("https://bridge.example:5173", "bridge-peer_123", "abcdefghijklmnopqrstuvwxyz");
  expect(new URL(url).origin).toBe("https://bridge.example:5173");
  expect(new URL(url).searchParams.get("mode")).toBe("peerjs");
  expect(new URL(url).searchParams.get("peer")).toBe("bridge-peer_123");
  expect(new URL(url).searchParams.get("token")).toBe("abcdefghijklmnopqrstuvwxyz");
});

test("PeerJS Composer QR uses the WQDrop pair envelope", () => {
  const qr = createComposerPeerTransferQr("https://bridge.example:5173", "bridge-peer_123", "abcdefghijklmnopqrstuvwxyz", "Session A");
  expect(new URL(qr).protocol).toBe("wqdrop:");
  expect(parseComposerTransferQrPayload(qr, "https://bridge.example:17310")).toEqual({
    mode: "peerjs", peerId: "bridge-peer_123", token: "abcdefghijklmnopqrstuvwxyz",
  });
});

test("PeerJS Composer offer validation bounds text and image batches", () => {
  expect(validateComposerPeerOffer("文字", [])).toBeNull();
  expect(validateComposerPeerOffer("", [{ id: "one", name: "a.png", contentType: "image/png", sizeBytes: 10 }])).toBeNull();
  expect(validateComposerPeerOffer("", [])).toBe("请输入文字或选择图片。");
  expect(validateComposerPeerOffer("x", Array.from({ length: COMPOSER_PEER_TRANSFER_MAX_FILES + 1 }, (_, index) => ({ id: String(index), name: `${index}.png`, contentType: "image/png", sizeBytes: 1 })))).toContain("最多传输");
  expect(validateComposerPeerOffer("x", [{ id: "large", name: "large.png", contentType: "image/png", sizeBytes: COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES + 1 }])).toContain("单张图片");
  expect(validateComposerPeerOffer("x", [
    { id: "a", name: "a.png", contentType: "image/png", sizeBytes: 22 * 1024 * 1024 },
    { id: "b", name: "b.png", contentType: "image/png", sizeBytes: 22 * 1024 * 1024 },
    { id: "c", name: "c.png", contentType: "image/png", sizeBytes: 22 * 1024 * 1024 },
  ])).toContain("总大小");
  expect(formatComposerPeerBytes(1024)).toBe("1.0 KiB");
});

test("PeerJS binary message data is normalized without exposing the backing range", () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const view = peerMessageBytes(source.subarray(1, 3));
  expect(view && [...view]).toEqual([2, 3]);
});
