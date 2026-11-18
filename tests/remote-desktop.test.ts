import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { WebSocket } from "ws";
import { StateDatabase } from "../src/db.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { DashboardServer } from "../src/web.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(displays: import("../src/remote-desktop-displays.js").RemoteDesktopDisplay[] = []) {
  const peers: Socket[] = [];
  const upstream = createServer((peer) => { peers.push(peer); peer.write(Buffer.from("RFB 003.008\n")); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  const root = await mkdtemp(join(tmpdir(), "bridge-vnc-web-"));
  await writeFile(join(root, "index.html"), "<html><body>fixture app</body></html>");
  const db = new StateDatabase(join(root, "fixture.db"));
  const auth = new WebPairingAuth({ db, allowLocalRequests: false });
  const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [],
    webRoot: root, cleanupExpiredStagedAttachments: false, remoteDesktopConnector: () => connect({ host: "127.0.0.1", port }),
    remoteDesktopDisplays: async () => displays });
  const url = await server.start();
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    for (const peer of peers) peer.destroy();
    await server.stop(); db.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  async function pair(mobile = false) {
    const origin = mobile ? "capacitor://localhost" : url;
    const response = await fetch(url + (mobile ? "/api/auth/mobile/pair" : "/api/auth/pairing/claim"), {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: auth.startPairing().code }),
    });
    expect(response.status).toBe(200);
    const token = mobile ? (await response.json() as { token: string }).token : "";
    const cookie = mobile ? "" : response.headers.get("set-cookie")!.split(";")[0]!;
    const identity = mobile ? { Authorization: `Bearer ${token}` } : { Cookie: cookie };
    const session = await fetch(url + "/api/session", { headers: { ...identity, Origin: origin } });
    const { actionToken } = await session.json() as { actionToken: string };
    const request = { headers: mobile ? { authorization: `Bearer ${token}` } : { cookie }, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;
    const id = auth.currentDeviceId(request)!;
    return { origin, identity, actionToken, request, id };
  }
  async function ticket(device: Awaited<ReturnType<typeof pair>>) {
    const response = await fetch(url + "/api/remote-desktop/ticket", {
      method: "POST", headers: { ...device.identity, Origin: device.origin, "X-Bridge-Action-Token": device.actionToken },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json() as { ticket: string }).ticket;
  }
  function websocket(path: string, origin?: string) {
    const ws = new WebSocket(url.replace("http:", "ws:") + path, { headers: origin ? { Origin: origin } : {} });
    ws.on("error", () => {});
    sockets.push(ws); return ws;
  }
  return { url, root, auth, peers, pair, ticket, websocket };
}

async function rejected(ws: WebSocket): Promise<void> {
  const result = await Promise.race([
    once(ws, "open").then(() => "open").catch(() => "error"),
    once(ws, "error").then(() => "error"),
  ]);
  expect(result).toBe("error");
}

describe("remote desktop stream", () => {
  it("limits display metadata to authorized devices and prevents stale layout caching", async () => {
    const display = { id: 7, name: "内建屏", builtIn: true, main: false, x: 1152, y: 836,
      width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234 };
    const f = await fixture([display]);
    expect((await fetch(f.url + "/api/remote-desktop/displays")).status).toBe(401);
    const device = await f.pair();
    const response = await fetch(f.url + "/api/remote-desktop/displays", { headers: device.identity });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ displays: [display] });
  });

  it("requires device authorization, action token, a single-use ticket and an allowed origin", async () => {
    const f = await fixture();
    const device = await f.pair();
    expect((await fetch(f.url + "/remote-desktop")).status).toBe(401);
    const page = await fetch(f.url + "/remote-desktop", { headers: device.identity });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("fixture app");
    expect((await fetch(f.url + "/api/remote-desktop/ticket", { method: "POST" })).status).toBe(401);
    expect((await fetch(f.url + "/api/remote-desktop/ticket", { method: "POST", headers: { ...device.identity, Origin: device.origin } })).status).toBe(403);
    expect((await fetch(f.url + "/api/remote-desktop/ticket", { method: "POST", headers: { ...device.identity, Origin: "https://evil.invalid", "X-Bridge-Action-Token": device.actionToken } })).status).toBe(403);
    await rejected(f.websocket("/remote-desktop/stream", device.origin));
    const badOriginTicket = await f.ticket(device);
    await rejected(f.websocket(`/remote-desktop/stream?bridgeTicket=${badOriginTicket}`, "https://evil.invalid"));
    const wrongPathTicket = await f.ticket(device);
    await rejected(f.websocket(`/remote-desktop/stream?target=other&bridgeTicket=${wrongPathTicket}`, device.origin));
    expect(f.peers).toHaveLength(0);
    const singleUse = await f.ticket(device);
    const ws = f.websocket(`/remote-desktop/stream?bridgeTicket=${singleUse}`, device.origin);
    const banner = once(ws, "message");
    await once(ws, "open");
    const [data] = await banner;
    expect(data.toString()).toBe("RFB 003.008\n");
    await rejected(f.websocket(`/remote-desktop/stream?bridgeTicket=${singleUse}`, device.origin));
    expect(f.peers).toHaveLength(1);
    const received = once(f.peers[0]!, "data");
    ws.send(Buffer.from([0, 1, 2, 255]));
    const [bytes] = await received;
    expect([...bytes]).toEqual([0, 1, 2, 255]);
    const closed = once(ws, "close");
    expect(f.auth.revokeDevice(device.request, device.id)).toBe(true);
    const [code] = await closed;
    expect(code).toBe(1008);
  });

  it("closes an idle stream when another database connection revokes the device", async () => {
    const f = await fixture();
    const device = await f.pair();
    const value = await f.ticket(device);
    const ws = f.websocket(`/remote-desktop/stream?bridgeTicket=${value}`, device.origin);
    const banner = once(ws, "message");
    await once(ws, "open"); await banner;
    const closed = once(ws, "close");
    const other = new StateDatabase(join(f.root, "fixture.db"));
    try { other.revokeWebAuthSession(device.id, new Date().toISOString()); } finally { other.close(); }
    expect((await closed)[0]).toBe(1008);
  });

  it("rejects non-binary client frames", async () => {
    const f = await fixture();
    const device = await f.pair();
    const value = await f.ticket(device);
    const ws = f.websocket(`/remote-desktop/stream?bridgeTicket=${value}`, device.origin);
    const banner = once(ws, "message");
    await once(ws, "open"); await banner;
    const closed = once(ws, "close");
    ws.send("text is not an RFB frame");
    expect((await closed)[0]).toBe(1003);
  });

  it("supports the same ticketed stream for a paired native WebView", async () => {
    const f = await fixture();
    const device = await f.pair(true);
    const value = await f.ticket(device);
    const ws = f.websocket(`/remote-desktop/stream?bridgeTicket=${value}`, device.origin);
    const banner = once(ws, "message");
    await once(ws, "open");
    expect((await banner)[0].toString()).toBe("RFB 003.008\n");
    const withoutOriginTicket = await f.ticket(device);
    const withoutOrigin = f.websocket(`/remote-desktop/stream?bridgeTicket=${withoutOriginTicket}`);
    const secondBanner = once(withoutOrigin, "message");
    await once(withoutOrigin, "open");
    expect((await secondBanner)[0].toString()).toBe("RFB 003.008\n");
    const closed = once(ws, "close");
    const secondClosed = once(withoutOrigin, "close");
    expect(f.auth.revokeDevice(device.request, device.id)).toBe(true);
    expect((await closed)[0]).toBe(1008);
    expect((await secondClosed)[0]).toBe(1008);
  });
});
