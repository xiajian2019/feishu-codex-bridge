import assert from "node:assert/strict";
import { mock } from "bun:test";

const listeners = new Map<string, (event: any) => void>();
const events = (name: string, value: unknown): void => { listeners.get(name)?.(value); };
const local = "01234567-89ab-4cde-8f01-23456789abcd";
const remote = "11234567-89ab-4cde-8f01-23456789abcd";
let serverAttempts = 0;
let discoveryStarts = 0;
let discoveryStops = 0;
let gateway = "192.168.1.1";
const connectedHosts: string[] = [];
const disconnected: string[] = [];
const ui = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
Object.defineProperty(globalThis, "window", { configurable: true, value: ui });
Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { hidden: false }) });

mock.module("../../web/src/mobile-runtime.js", () => ({
  MOBILE_RESUME_EVENT: "bridge:mobile-resume",
  isMobileApp: () => true,
  nearbyTransferAvailable: async () => true,
  nearbyAddListener: async (name: string, handler: (event: any) => void) => { listeners.set(name, handler); return { remove: async () => {} }; },
  nearbyStartServer: async () => {
    serverAttempts++;
    if (serverAttempts === 1) throw new Error("listener failed");
    return { deviceId: local, displayName: "Local", port: 43891, token: "ab".repeat(16) };
  },
  nearbyGetNetworkInfo: async () => ({ wifi: true, gateway, addresses: ["192.168.1.2"] }),
  nearbyListReceived: async () => [],
  nearbyStartDiscovery: async () => {
    discoveryStarts++;
    events("peerFound", { peer: { id: "service", deviceId: remote, name: "Remote", source: "mdns" } });
  },
  nearbyStopDiscovery: async () => { discoveryStops++; },
  nearbyConnect: async (options: { host: string; deviceId: string; source: string }) => {
    connectedHosts.push(options.host);
    assert.equal(options.deviceId, remote);
    assert.equal(options.source, "qr");
    const id = `connection-${connectedHosts.length}`;
    const peer = { id, name: "Remote", deviceId: remote, source: "qr" };
    if (connectedHosts.length === 1) events("connectionState", { connection: { id, peer, state: "failed", error: "unreachable" } });
    else {
      events("connectionState", { connection: { id, peer, state: "connecting" } });
      events("peerReady", { connectionId: id });
    }
    return { connectionId: id };
  },
  nearbyDisconnect: async (id: string) => { disconnected.push(id); },
}));

const session = await import("../../web/src/nearby-transfer-session.js");
await session.ensureNearbyTransferSession();
assert.equal(session.getNearbyTransferSessionSnapshot().status, "failed");
await session.ensureNearbyTransferSession();
assert.equal(serverAttempts, 2);
assert.equal(session.getNearbyTransferSessionSnapshot().status, "ready");
gateway = "172.20.10.1";
await session.refreshNearbyDiscovery();
assert.equal(discoveryStops, 1);
assert.equal(discoveryStarts, 3);
assert.deepEqual(Object.keys(session.getNearbyTransferSessionSnapshot().peers), ["service"]);
assert.equal(session.getNearbyTransferSessionSnapshot().network?.gateway, gateway);
gateway = "10.4.0.1";
events("networkChanged", {});
await new Promise((resolve) => setTimeout(resolve, 800));
assert.equal(discoveryStops, 2);
assert.equal(session.getNearbyTransferSessionSnapshot().network?.gateway, gateway);
const result = await session.connectNearbyQr({ deviceId: remote, name: "Remote", port: 43891, token: "ab".repeat(16), addresses: ["10.0.0.8", "172.20.10.1"] });
assert.equal(result.connectionId, "connection-2");
assert.deepEqual(connectedHosts, ["10.0.0.8", "172.20.10.1"]);
assert.deepEqual(disconnected, ["connection-1"]);
events("fileCompleted", { connectionId: "connection-2", transferId: "file-1" });
await session.waitForNearbyFileCompleted("connection-2", "file-1");
events("fileOffer", { offer: { connectionId: "connection-2", transferId: "file-2", fileName: "test.txt", size: 1, mimeType: "text/plain" } });
session.markNearbyOfferAccepted("connection-2", "file-2");
assert.equal(session.getNearbyTransferSessionSnapshot().offers["connection-2:file-2"]?.accepted, true);
const pending = session.waitForNearbyFileAccepted("connection-2", "file-3");
events("connectionState", { connection: { id: "connection-2", peer: { id: remote, deviceId: remote, name: "Remote", source: "qr" }, state: "closed", error: "断开测试" } });
await assert.rejects(pending, /断开测试/);
assert.deepEqual(session.getNearbyTransferSessionSnapshot().offers, {});
console.log("nearby session fixture passed");
