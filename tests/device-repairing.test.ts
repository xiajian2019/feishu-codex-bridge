import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { StateDatabase } from "../src/db.js";
import { WebPairingAuth, type WebAuthSessionRecord } from "../src/web-auth.js";

function request(token?: string, client: "browser" | "app" = "browser"): IncomingMessage {
  return { headers: { host: "bridge.test:7310", "user-agent": client === "app" ? "BridgeApp/1.0 (Android)" : "test browser",
    ...(token ? client === "app" ? { authorization: `Bearer ${token}` } : { cookie: `bridge_session=${token}` } : {}) },
    socket: { remoteAddress: "192.0.2.10" } } as unknown as IncomingMessage;
}

const day = 24 * 60 * 60 * 1_000;

describe("reusing a device authorization", () => {
  for (const storage of ["memory", "sqlite"] as const) {
    for (const client of ["browser", "app"] as const) {
      it(`keeps the same ${storage} device and rotates its credential for ${client}`, () => {
        let now = Date.parse("2026-01-01T00:00:00Z");
        const db = storage === "sqlite" ? new StateDatabase(":memory:") : undefined;
        const auth = new WebPairingAuth({ db, now: () => now });
        try {
          const admin = auth.claimPairing(request(), auth.startPairing().code);
          const old = auth.claimPairing(request(), auth.startPairing().code);
          const adminRequest = request(admin);
          const oldRequest = request(old);
          const before = auth.listDevices(adminRequest)!.find((device) => device.current === false)!;
          expect(auth.renameDevice(adminRequest, before.sessionId, "我的手机")).toBe(true);
          const extended = auth.extendDevice(adminRequest, before.sessionId)!;
          const scope = auth.status(oldRequest).draftScope;
          const connectionAllowed = auth.connectionAuthorization(oldRequest);
          let invalidations = 0;
          const unsubscribe = auth.subscribeToRevocations(() => invalidations++);
          const pairing = auth.startDevicePairing(adminRequest, before.sessionId)!;
          expect(auth.isAuthorized(oldRequest)).toBe(true);
          now += 1_000;
          const replacement = client === "app"
            ? auth.claimMobilePairing(request(undefined, "app"), pairing.code).token
            : auth.claimPairing(request(), pairing.code);
          const replacementRequest = request(replacement, client);
          const devices = auth.listDevices(adminRequest)!;
          expect(devices).toHaveLength(2);
          expect(devices.find((device) => device.sessionId === before.sessionId)).toMatchObject({
            sessionId: before.sessionId, deviceName: "我的手机", createdAt: before.createdAt, expiresAt: extended, clientType: client,
          });
          expect(auth.currentDeviceId(replacementRequest)).toBe(before.sessionId);
          expect(auth.status(replacementRequest).draftScope).toBe(scope);
          expect(auth.isAuthorized(oldRequest)).toBe(false);
          expect(connectionAllowed()).toBe(false);
          expect(invalidations).toBe(1);
          expect(() => auth.claimPairing(request(), pairing.code)).toThrow("pairing code expired or unavailable");
          if (client === "browser") {
            const headers: Record<string, string> = {};
            auth.setSessionCookie(request(), { setHeader: (key: string, value: string) => { headers[key] = value; } } as unknown as ServerResponse, replacement);
            expect(headers["Set-Cookie"]).toContain(`Max-Age=${Math.ceil((Date.parse(extended) - now) / 1000)}`);
          }
          unsubscribe();
        } finally { db?.close(); }
      });
    }
  }

  it("renews an expired but unrevoked record and refuses explicitly revoked records", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db, now: () => now });
    try {
      const admin = auth.claimPairing(request(), auth.startPairing().code);
      const expired = auth.claimPairing(request(), auth.startPairing().code);
      const adminRequest = request(admin);
      const adminId = auth.currentDeviceId(adminRequest)!;
      auth.extendDevice(adminRequest, adminId);
      const expiredId = auth.currentDeviceId(request(expired))!;
      now += 31 * day;
      const pairing = auth.startDevicePairing(adminRequest, expiredId)!;
      const renewed = auth.claimMobilePairing(request(undefined, "app"), pairing.code);
      expect(auth.currentDeviceId(request(renewed.token, "app"))).toBe(expiredId);
      expect(Date.parse(renewed.expiresAt)).toBe(now + 30 * day);
      expect(db.listWebAuthSessions()).toHaveLength(2);
      expect(auth.revokeDevice(adminRequest, expiredId)).toBe(true);
      expect(auth.startDevicePairing(adminRequest, expiredId)).toBeNull();
    } finally { db.close(); }
  });

  it("does not restore a target revoked after its QR was issued", () => {
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db });
    try {
      const admin = auth.claimPairing(request(), auth.startPairing().code);
      const target = auth.claimPairing(request(), auth.startPairing().code);
      const adminRequest = request(admin);
      const targetId = auth.currentDeviceId(request(target))!;
      const pairing = auth.startDevicePairing(adminRequest, targetId)!;
      expect(auth.revokeDevice(adminRequest, targetId)).toBe(true);
      expect(() => auth.claimPairing(request(), pairing.code)).toThrow("device authorization changed or was revoked");
      expect(() => auth.claimPairing(request(), pairing.code)).toThrow("pairing code expired or unavailable");
      expect(db.listWebAuthSessions()).toHaveLength(2);
      expect(auth.isAuthorized(request(target))).toBe(false);
    } finally { db.close(); }
  });

  it("atomically consumes the validated code without deleting a newer QR", () => {
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db });
    try {
      auth.startPairing();
      const oldPairing = db.getWebAuthPairing()!;
      const newer = auth.startPairing();
      const blank: WebAuthSessionRecord = { sessionId: "fixture", tokenHash: "fixture-hash", deviceName: "fixture", userAgent: null,
        remoteAddress: null, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + day).toISOString(), revokedAt: null };
      expect(db.consumeWebAuthPairing(oldPairing, blank)).toBe("pairing_unavailable");
      expect(auth.claimPairing(request(), newer.code)).toBeTruthy();
      expect(db.consumeWebAuthPairing(db.getWebAuthPairing() ?? oldPairing, blank)).toBe("pairing_unavailable");
      expect(db.listWebAuthSessions()).toHaveLength(1);
    } finally { db.close(); }
  });

  it("does not apply a stale target when an older CLI replaces a device QR", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-legacy-pair-writer-"));
    const path = join(root, "fixture.db");
    const db = new StateDatabase(path);
    try {
      const auth = new WebPairingAuth({ db });
      const original = auth.claimPairing(request(), auth.startPairing().code);
      const originalRequest = request(original);
      const originalId = auth.currentDeviceId(originalRequest)!;
      expect(auth.startDevicePairing(originalRequest, originalId)).not.toBeNull();
      const code = "ABCD-EFGH-JKLM";
      const hash = createHash("sha256").update(code.replaceAll("-", "")).digest("hex");
      const legacy = new Database(path);
      try {
        legacy.query(`INSERT INTO web_auth_pairings (id, code_hash, expires_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`)
          .run(hash, new Date(Date.now() + day).toISOString());
      } finally { legacy.close(); }
      const added = auth.claimPairing(request(), code);
      expect(auth.currentDeviceId(request(added))).not.toBe(originalId);
      expect(auth.isAuthorized(originalRequest)).toBe(true);
      expect(db.listWebAuthSessions()).toHaveLength(2);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("migrates a pending legacy code and supports a QR issued by another database instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-device-repair-"));
    const path = join(root, "fixture.db");
    const legacy = new Database(path);
    const code = "ABCD-EFGH-JKLM";
    legacy.exec("CREATE TABLE web_auth_pairings (id INTEGER PRIMARY KEY CHECK (id = 1), code_hash TEXT NOT NULL, expires_at TEXT NOT NULL)");
    legacy.query("INSERT INTO web_auth_pairings VALUES (1, ?, ?)").run(createHash("sha256").update(code.replaceAll("-", "")).digest("hex"), new Date(Date.now() + day).toISOString());
    legacy.close();
    const firstDb = new StateDatabase(path);
    const secondDb = new StateDatabase(path);
    try {
      const first = new WebPairingAuth({ db: firstDb });
      const second = new WebPairingAuth({ db: secondDb });
      const token = first.claimPairing(request(), code);
      const current = request(token);
      const id = first.currentDeviceId(current)!;
      const pair = first.startDevicePairing(current, id)!;
      const newToken = second.claimPairing(request(), pair.code);
      expect(first.currentDeviceId(request(newToken))).toBe(id);
      expect(first.isAuthorized(current)).toBe(false);
      expect(firstDb.listWebAuthSessions()).toHaveLength(1);
    } finally { firstDb.close(); secondDb.close(); await rm(root, { recursive: true, force: true }); }
  });
});
