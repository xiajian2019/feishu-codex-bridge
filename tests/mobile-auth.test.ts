import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";

import { StateDatabase } from "../src/db.js";
import { isNativeAppOrigin, MobileStreamTickets } from "../src/mobile-auth.js";
import { TmuxDashboardApi, type TmuxDashboardApiOptions } from "../src/tmux-dashboard-api.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

const cleanups: Array<() => Promise<void>> = [];
const nativeOrigin = "capacitor://localhost";
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(allowLocalRequests = false) {
  const root = await mkdtemp(join(tmpdir(), "bridge-mobile-auth-"));
  const db = new StateDatabase(join(root, "fixture.db"));
  const auth = new WebPairingAuth({ db, allowLocalRequests });
  const sockets: WebSocket[] = [];
  const terminals: Array<{ closed: boolean; writes: string[] }> = [];
  const session = { id: "$41", name: "fixture", windows: 1, attachedClients: 0, cwd: root, createdAt: 1 };
  let killedSessions = 0;
  const runtime: NonNullable<TmuxDashboardApiOptions["terminalRuntime"]> = {
    spawn() {
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
      const state = { closed: false, writes: [] as string[] };
      terminals.push(state);
      return {
        terminal: { write(data) { state.writes.push(data); }, resize() {}, close() { state.closed = true; } },
        exited, killed: false,
        kill() { this.killed = true; resolveExit(0); },
      };
    },
  };
  const tmux = new TmuxDashboardApi({ db, terminalRuntime: runtime, operations: {
    listSessions: async () => [session], findSession: async () => session,
    createSession: async () => session, killSession: async () => { killedSessions += 1; },
    capturePane: async () => "fixture snapshot",
  } });
  const server = new DashboardServer({ db, auth, tmuxDashboard: tmux, host: "127.0.0.1", port: 0,
    modes: [], cleanupExpiredStagedAttachments: false, taskAttachmentsDirectory: join(root, "attachments") });
  cleanups.push(async () => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, "close"); socket.terminate(); await closed;
      }
    }
    await server.stop(); db.close(); await rm(root, { recursive: true, force: true });
  });
  const url = await server.start();
  async function pair(origin: string | undefined = nativeOrigin) {
    const pairing = auth.startPairing();
    const response = await fetch(url + "/api/auth/mobile/pair", { method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ code: pairing.code }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { token, expiresAt } = await response.json() as { token: string; expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    const bearer = { Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) };
    const sessionResponse = await fetch(url + "/api/session", { headers: bearer });
    expect(sessionResponse.status).toBe(200);
    const { actionToken } = await sessionResponse.json() as { actionToken: string };
    const headers = { ...bearer, "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken };
    const devicesResponse = await fetch(url + "/api/auth/devices", { headers });
    const devices = await devicesResponse.json() as { devices: Array<{ sessionId: string; current: boolean }> };
    const id = devices.devices.find((device) => device.current)!.sessionId;
    return { token, headers, id };
  }
  async function ticket(headers: Record<string, string>, path: string) {
    const response = await fetch(url + "/api/auth/mobile/stream-ticket", {
      method: "POST", headers, body: JSON.stringify({ path }),
    });
    expect(response.status).toBe(200);
    return (await response.json() as { ticket: string }).ticket;
  }
  function websocket(path: string, origin = nativeOrigin, token?: string) {
    const socket = new WebSocket(url.replace("http:", "ws:") + path, {
      headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    sockets.push(socket);
    return socket;
  }
  return { url, auth, db, pair, ticket, websocket, terminals, killedSessions: () => killedSessions };
}

describe("mobile stream tickets", () => {
  it("expires, consumes once, binds query and device, and bounds pending tickets", () => {
    let now = 100;
    let active = true;
    const store = new MobileStreamTickets(() => now, 2);
    const authorization = { deviceId: "fixture", isAuthorized: () => active };
    const issue = (path = "/api/events") => store.issue(path, authorization).ticket;
    const first = issue();
    expect(store.consume(`/api/events?bridgeTicket=${first}`)?.deviceId).toBe("fixture");
    expect(store.consume(`/api/events?bridgeTicket=${first}`)).toBeNull();
    const queryBound = issue("/tmux-dashboard/terminal?session=%2441&cols=80");
    expect(store.consume(`/tmux-dashboard/terminal?session=%2442&cols=80&bridgeTicket=${queryBound}`)).toBeNull();
    expect(store.consume(`/tmux-dashboard/terminal?session=%2441&cols=80&bridgeTicket=${queryBound}`)).toBeNull();
    const expired = issue(); now += 30_000;
    expect(store.consume(`/api/events?bridgeTicket=${expired}`)).toBeNull();
    const revoked = issue(); active = false;
    expect(store.consume(`/api/events?bridgeTicket=${revoked}`)).toBeNull();
    active = true; issue(); issue();
    expect(() => issue()).toThrow("too many pending stream tickets");
    now += 30_000;
    expect(issue()).toBeTruthy();
    for (const path of ["https://evil.invalid/api/events", "//evil.invalid/api/events", "/api/session", "/api/events#fragment", "/api/events?bridgeTicket=existing"]) {
      expect(() => issue(path)).toThrow("invalid stream path");
    }
    expect(isNativeAppOrigin("https://localhost.evil.invalid")).toBe(false);
    expect(isNativeAppOrigin("https://localhost:444")).toBe(false);
  });
});

describe("native mobile authorization", () => {
  it("advertises authenticated client capabilities without granting unavailable services or leaking metadata to unpaired clients", async () => {
    const f = await fixture();
    const anonymous = await (await fetch(f.url + "/api/auth/status", { headers: { Origin: nativeOrigin } })).json() as Record<string, unknown>;
    expect(anonymous.authenticated).toBe(false);
    expect(anonymous.client).toBeUndefined();
    const device = await f.pair();
    const status = await (await fetch(f.url + "/api/auth/status", { headers: device.headers })).json() as {
      authenticated: boolean; client: { schemaVersion: number; protocolVersion: number; minimumClientProtocol: number; version: string; features: string[] };
    };
    expect(status.authenticated).toBe(true);
    expect(status.client).toMatchObject({ schemaVersion: 1, protocolVersion: 1, minimumClientProtocol: 1, version: expect.any(String) });
    expect(status.client.features).toContain("tmux");
    expect(status.client.features).toContain("download-uploads");
    expect(status.client.features).not.toContain("codex-history");
  });

  it("drops malformed unauthenticated upgrade targets without stopping the server", async () => {
    const f = await fixture();
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(f.url).port) });
    let timedOut = false;
    socket.on("error", () => {});
    socket.setTimeout(2_000, () => { timedOut = true; socket.destroy(); });
    await once(socket, "connect");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.resume();
    socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Zml4dHVyZS1tb2JpbGUta2V5\r\n\r\n");
    await closed;
    expect(timedOut).toBe(false);
    const response = await fetch(f.url + "/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("retains localhost browser cookies while refusing cookies from a native cross-origin page", () => {
    const auth = new WebPairingAuth();
    const browser = { headers: { host: "localhost", origin: "http://localhost" }, socket: { remoteAddress: "203.0.113.1" } } as IncomingMessage;
    const token = auth.claimPairing(browser, auth.startPairing().code);
    browser.headers.cookie = `bridge_session=${token}`;
    expect(auth.isAuthorized(browser)).toBe(true);
    expect(auth.connectionAuthorization(browser)()).toBe(true);
    browser.headers.host = "localhost:17310";
    expect(auth.isAuthorized(browser)).toBe(false);
    expect(auth.connectionAuthorization(browser)()).toBe(false);
    browser.headers.authorization = `Bearer ${token}`;
    expect(auth.isAuthorized(browser)).toBe(true);
  });

  it("pairs using a one-time code without cookies and keeps device identity across requests", async () => {
    const f = await fixture();
    for (const origin of [nativeOrigin, "https://localhost", "http://localhost", ""]) {
      const device = await f.pair(origin);
      const response = await fetch(f.url + "/api/auth/status", { headers: device.headers });
      expect(await response.json()).toMatchObject({ authenticated: true, draftScope: expect.any(String) });
      expect(response.headers.get("access-control-allow-origin")).toBe(origin || null);
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const pairing = f.auth.startPairing();
    const claim = () => fetch(f.url + "/api/auth/mobile/pair", { method: "POST",
      headers: { Origin: nativeOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code }) });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(403);
  });

  it("updates the paired App UA on re-entry and serves it to another device's management page", async () => {
    const f = await fixture();
    const phone = await f.pair();
    const admin = await f.pair();
    const before = f.db.listWebAuthSessions().find((device) => device.sessionId === phone.id)!;
    f.db.updateWebAuthSessionDeviceName(phone.id, "日常手机");
    const ua = "Mozilla/5.0 (Linux; Android 14; Phone; wv) Chrome/129.0.0.0 BridgeApp/0.6.0 (Android)";
    const status = await fetch(f.url + "/api/auth/status", {
      headers: { ...phone.headers, "User-Agent": ua },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ authenticated: true });
    const list = await fetch(f.url + "/api/auth/devices", { headers: admin.headers });
    expect(list.status).toBe(200);
    const { devices } = await list.json() as { devices: Array<{ sessionId: string; userAgent: string; deviceName: string }> };
    expect(devices).toHaveLength(2);
    expect(devices.find((device) => device.sessionId === phone.id)).toMatchObject({ userAgent: ua, deviceName: "日常手机" });
    expect(f.db.listWebAuthSessions().find((device) => device.sessionId === phone.id))
      .toMatchObject({ userAgent: ua, tokenHash: before.tokenHash, createdAt: before.createdAt, expiresAt: before.expiresAt });
  });

  it("rejects bad pairing codes and rate-limits guesses", async () => {
    const f = await fixture();
    f.auth.startPairing();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await fetch(f.url + "/api/auth/mobile/pair", { method: "POST",
        headers: { Origin: nativeOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ code: "invalid" }) });
      expect(response.status).toBe(attempt < 8 ? 403 : 429);
      if (attempt === 8) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      await response.text();
    }
  });

  it("restricts CORS and requires Bearer plus Action Token even with valid cookies or trusted loopback", async () => {
    const f = await fixture(true);
    const device = await f.pair();
    const preflight = (origin: string, headers = "authorization, content-type, x-bridge-action-token, x-file-name") => fetch(f.url + "/api/auth/mobile/pair", {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": headers },
    });
    expect((await preflight(nativeOrigin)).status).toBe(204);
    for (const origin of ["https://evil.invalid", "https://localhost:444", "null"]) {
      const response = await preflight(origin);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const paired = await fetch(f.url + "/api/session", { headers: { ...device.headers, Origin: origin } });
      expect(paired.headers.get("access-control-allow-origin")).toBeNull();
      const pairing = await fetch(f.url + "/api/auth/mobile/pair", { method: "POST", headers: { Origin: origin } });
      expect(pairing.status).toBe(403);
    }
    expect((await preflight(nativeOrigin, "x-arbitrary-header")).status).toBe(403);
    const cookie = `bridge_session=${device.token}`;
    for (const headers of [
      { Origin: nativeOrigin, Cookie: cookie },
      { Origin: nativeOrigin, Cookie: cookie, Authorization: "Bearer invalid" },
      { Cookie: cookie, Authorization: "Bearer invalid" },
    ]) {
      expect((await fetch(f.url + "/api/session", { headers })).status).toBe(401);
    }
    const { "X-Bridge-Action-Token": _action, ...withoutAction } = device.headers;
    expect((await fetch(f.url + "/api/auth/logout", { method: "POST", headers: withoutAction })).status).toBe(403);
    expect((await fetch(f.url + "/api/auth/mobile/stream-ticket", { method: "POST",
      headers: { ...device.headers, Authorization: "", Cookie: cookie }, body: JSON.stringify({ path: "/api/events" }) })).status).toBe(401);
    expect((await fetch(f.url + "/api/auth/mobile/stream-ticket", { method: "POST",
      headers: device.headers, body: JSON.stringify({ path: "/api/session" }) })).status).toBe(400);
  });

  it("uses one-time path-bound tickets for SSE and terminal, and revokes both live connections", async () => {
    const f = await fixture();
    const device = await f.pair();
    const streamTicket = await f.ticket(device.headers, "/api/events");
    const streamUrl = f.url + `/api/events?bridgeTicket=${streamTicket}`;
    const stream = await fetch(streamUrl, { headers: { Origin: nativeOrigin } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await fetch(streamUrl, { headers: { Origin: nativeOrigin } })).status).toBe(401);

    const path = "/tmux-dashboard/terminal?session=%2441&cols=80&rows=24";
    const terminalTicket = await f.ticket(device.headers, path);
    const socket = f.websocket(`${path}&bridgeTicket=${terminalTicket}`);
    const frame = once(socket, "message");
    await once(socket, "open"); await frame;
    const rejected = async (path: string, origin = nativeOrigin, token?: string) => {
      const candidate = f.websocket(path, origin, token);
      candidate.on("error", () => {});
      return new Promise<boolean>((resolve) => {
        candidate.once("open", () => { candidate.terminate(); resolve(false); });
        candidate.once("close", () => resolve(true));
      });
    };
    expect(await rejected(`${path}&bridgeTicket=${terminalTicket}`)).toBe(true);
    const mismatch = await f.ticket(device.headers, path);
    expect(await rejected(`${path.replace("cols=80", "cols=81")}&bridgeTicket=${mismatch}`)).toBe(true);
    const badOriginTicket = await f.ticket(device.headers, path);
    expect(await rejected(`${path}&bridgeTicket=${badOriginTicket}`, "https://evil.invalid")).toBe(true);
    // A long-lived token in a WS header cannot authorize the native origin without a ticket.
    expect(await rejected(path, nativeOrigin, device.token)).toBe(true);

    const closed = once(socket, "close");
    const response = await fetch(f.url + `/api/auth/devices/${device.id}/revoke`, { method: "POST", headers: device.headers });
    expect(response.status).toBe(200);
    expect((await closed)[0]).toBe(1008);
    expect((await reader.read()).done).toBe(true); reader.releaseLock();
    expect(f.terminals[0]!.closed).toBe(true);
    expect(f.killedSessions()).toBe(0);
    expect((await fetch(f.url + "/api/session", { headers: device.headers })).status).toBe(401);
  });
});
