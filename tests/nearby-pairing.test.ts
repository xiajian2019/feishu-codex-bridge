import { expect, test } from "bun:test";
import { createNearbyPairingUrl, parseNearbyPairingUrl } from "../web/src/nearby-pairing.js";

const server = { deviceId: "01234567-89ab-4cde-8f01-23456789abcd", displayName: "测试手机", port: 43891, token: "ab".repeat(16) };

test("nearby QR contains usable addresses and round trips device identity", () => {
  const url = createNearbyPairingUrl(server, { wifi: true, addresses: ["127.0.0.1", "192.168.1.4", "192.168.1.4", "fe80::1%en0", "fd12::2"] });
  expect(parseNearbyPairingUrl(url)).toEqual({
    deviceId: server.deviceId, name: server.displayName, port: server.port, token: server.token, addresses: ["192.168.1.4", "fd12::2"],
  });
});

test("nearby QR rejects malformed identities, destinations and ports", () => {
  const original = createNearbyPairingUrl(server, { wifi: true, addresses: ["172.20.10.1"] });
  for (const [key, value] of [["address", "127.0.0.1"], ["address", "example.com"], ["id", "other"], ["token", ""], ["port", "65536"]]) {
    const url = new URL(original);
    url.searchParams.set(key!, value!);
    expect(() => parseNearbyPairingUrl(url.toString())).toThrow();
  }
  expect(() => parseNearbyPairingUrl("https://example.com/")).toThrow();
  expect(() => createNearbyPairingUrl(server, { wifi: false, addresses: ["127.0.0.1"] })).toThrow("未找到");
});
