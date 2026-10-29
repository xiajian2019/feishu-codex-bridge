import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StateDatabase } from "../src/db.js";
import { PairingRateLimitError, WebPairingAuth } from "../src/web-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WebPairingAuth", () => {
  for (const transport of ["cookie", "bearer", "loopback-cookie"] as const) {
    it(`refreshes an existing ${transport} device UA on its next login without changing its identity`, () => {
      const db = new StateDatabase(":memory:");
      const auth = new WebPairingAuth({ db, allowLocalRequests: transport === "loopback-cookie" });
      const original = fakeRequest("203.0.113.20");
      original.headers["user-agent"] = "Mozilla/5.0 (Linux; Android 14; Phone) Chrome/129.0.0.0";
      const token = auth.claimPairing(original, auth.startPairing().code);
      const before = db.listWebAuthSessions()[0]!;
      const renamed = "我的工作手机";
      db.updateWebAuthSessionDeviceName(before.sessionId, renamed);
      const returning = fakeRequest(transport === "loopback-cookie" ? "127.0.0.1" : "203.0.113.20");
      returning.headers[transport === "bearer" ? "authorization" : "cookie"] = transport === "bearer"
        ? `Bearer ${token}` : `bridge_session=${token}`;
      const upgradedUA = original.headers["user-agent"] + " BridgeApp/0.6.0 (Android)";
      returning.headers["user-agent"] = upgradedUA;
      try {
        expect(auth.status(returning).authenticated).toBe(true);
        const admin = fakeRequest("203.0.113.20", `bridge_session=${token}`);
        // Missing UA headers on a subsequent request must not erase metadata.
        const devices = new WebPairingAuth({ db }).listDevices(admin)!;
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({
          sessionId: before.sessionId, current: true, deviceName: renamed,
          userAgent: upgradedUA, createdAt: before.createdAt, expiresAt: before.expiresAt,
        });
        expect(db.listWebAuthSessions()[0]?.userAgent).toBe(upgradedUA);
        db.revokeWebAuthSession(before.sessionId, new Date().toISOString());
        const rejected = fakeRequest("203.0.113.20", `bridge_session=${token}`);
        rejected.headers["user-agent"] = "untrusted replacement";
        expect(auth.isAuthorized(rejected)).toBe(false);
        expect(db.listWebAuthSessions()[0]?.userAgent).toBe(upgradedUA);
      } finally { db.close(); }
    });
  }

  it("retains an appended Bridge marker on a long system user agent", () => {
    const auth = new WebPairingAuth();
    const request = fakeRequest("203.0.113.21");
    const token = auth.claimPairing(request, auth.startPairing().code);
    request.headers.cookie = `bridge_session=${token}`;
    const ua = "Mozilla/5.0 (Linux; Android 14) " + "system-detail ".repeat(50) + "BridgeApp/0.6.0 (Android)";
    request.headers["user-agent"] = ua;
    expect(auth.listDevices(request)?.[0]?.userAgent).toBe(ua);
  });

  it("throttles last-seen writes while checking metadata changes and revocation on every request", () => {
    const db = new StateDatabase(":memory:");
    let now = Date.now();
    const auth = new WebPairingAuth({ db, now: () => now });
    const remote = fakeRequest("203.0.113.20");
    const token = auth.claimPairing(remote, auth.startPairing().code);
    const request = fakeRequest("203.0.113.20", `bridge_session=${token}`);
    const touch = spyOn(db, "touchWebAuthSession");
    try {
      now += 1_000;
      expect(auth.isAuthorized(request)).toBe(true);
      expect(auth.isAuthorized(request)).toBe(true);
      expect(touch).toHaveBeenCalledTimes(0);
      now += 60_000;
      expect(auth.isAuthorized(request)).toBe(true);
      expect(auth.isAuthorized(request)).toBe(true);
      expect(touch).toHaveBeenCalledTimes(1);
      request.headers["user-agent"] = "upgraded browser";
      expect(auth.isAuthorized(request)).toBe(true);
      expect(touch).toHaveBeenCalledTimes(2);
      db.revokeWebAuthSession(db.listWebAuthSessions()[0]!.sessionId, new Date(now).toISOString());
      expect(auth.isAuthorized(request)).toBe(false);
      expect(touch).toHaveBeenCalledTimes(2);
    } finally { touch.mockRestore(); db.close(); }
  });

  it("pairs a non-local device and restores its session after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-web-auth-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "bridge.db");
    const firstDb = new StateDatabase(statePath);
    const first = new WebPairingAuth({ db: firstDb });
    const remote = fakeRequest("203.0.113.20");
    const pairing = first.startPairing();
    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(first.status(remote)).toMatchObject({
      authenticated: false,
      local: false,
      pairingAvailable: true,
      draftScope: null,
    });

    const secondDb = new StateDatabase(statePath);
    const second = new WebPairingAuth({ db: secondDb });
    const response = fakeResponse();
    const token = second.claimPairing(remote, pairing.code.toLowerCase().replaceAll("-", " "));
    first.setSessionCookie(remote, response as unknown as ServerResponse, token);
    const cookie = response.headers["set-cookie"];
    expect(cookie).toContain("bridge_session=");

    const authenticatedRequest = fakeRequest("203.0.113.20", cookie);
    expect(first.isAuthorized(authenticatedRequest)).toBe(true);

    expect(second.isAuthorized(authenticatedRequest)).toBe(true);
    expect(second.listDevices(authenticatedRequest)).toHaveLength(1);
    const draftScope = first.status(authenticatedRequest).draftScope;
    expect(draftScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.status(authenticatedRequest).draftScope).toBe(draftScope);
    const deviceId = second.listDevices(authenticatedRequest)![0]!.sessionId;
    expect(second.revokeDevice(authenticatedRequest, deviceId)).toBe(true);
    expect(second.status(authenticatedRequest).draftScope).toBeNull();
    firstDb.close();
    secondDb.close();
  });

  it("consumes a pairing code once and rate-limits bad guesses", () => {
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db });
    const remote = fakeRequest("203.0.113.21");
    const pairing = auth.startPairing();
    expect(() => auth.claimPairing(remote, "AAAA-AAAA-AAAA")).toThrow("invalid pairing code");
    for (let index = 0; index < 7; index += 1) {
      expect(() => auth.claimPairing(remote, "BBBB-BBBB-BBBB")).toThrow("invalid pairing code");
    }
    expect(() => auth.claimPairing(remote, "CCCC-CCCC-CCCC")).toThrow(PairingRateLimitError);
    const validRemote = fakeRequest("203.0.113.22");
    const token = auth.claimPairing(validRemote, pairing.code);
    expect(token).toBeTruthy();
    expect(() => auth.claimPairing(validRemote, pairing.code)).toThrow("pairing code expired or unavailable");
    db.close();
  });

  it("allows an authenticated admin to rename a device", () => {
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db });
    const remote = fakeRequest("203.0.113.23");
    const pairing = auth.startPairing();
    const response = fakeResponse();
    const token = auth.claimPairing(remote, pairing.code);
    auth.setSessionCookie(remote, response as unknown as ServerResponse, token);

    const authenticatedRequest = fakeRequest("203.0.113.23", response.headers["set-cookie"]);
    const device = auth.listDevices(authenticatedRequest)?.[0];
    expect(device?.deviceName).toBe("Browser device");
    expect(auth.renameDevice(authenticatedRequest, device!.sessionId, "办公室 iPhone")).toBe(true);
    expect(auth.listDevices(authenticatedRequest)?.[0]?.deviceName).toBe("办公室 iPhone");
    expect(auth.renameDevice(authenticatedRequest, device!.sessionId, "")).toBe(false);
    db.close();
  });

  it("allows an authenticated admin to extend a device by one calendar year", () => {
    const start = Date.parse("2026-10-24T12:34:56.000Z");
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db, now: () => start });
    const remote = fakeRequest("203.0.113.24");
    const pairing = auth.startPairing();
    const response = fakeResponse();
    const token = auth.claimPairing(remote, pairing.code);
    auth.setSessionCookie(remote, response as unknown as ServerResponse, token);

    const authenticatedRequest = fakeRequest("203.0.113.24", response.headers["set-cookie"]);
    const before = auth.listDevices(authenticatedRequest)?.[0];
    expect(before?.expiresAt).toBe("2026-11-23T12:34:56.000Z");
    expect(auth.extendDevice(authenticatedRequest, before!.sessionId)).toBe("2027-11-23T12:34:56.000Z");
    expect(auth.listDevices(authenticatedRequest)?.[0]?.expiresAt).toBe("2027-11-23T12:34:56.000Z");

    const stored = db.listWebAuthSessions()[0];
    expect(stored?.expiresAt).toBe("2027-11-23T12:34:56.000Z");
    db.close();
  });
});

function fakeRequest(address: string, cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: address },
  } as unknown as IncomingMessage;
}

function fakeResponse(): { headers: Record<string, string> } & Pick<ServerResponse, "setHeader"> {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: number | string | readonly string[]): ServerResponse {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join("; ") : String(value);
      return undefined as never;
    },
  };
}
