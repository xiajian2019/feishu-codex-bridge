import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as QRCode from "qrcode";
import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { diagnosePairing, readAuthEvidence, recordAuthStatus, readPairingScan, recordPairingScan, type AuthStatus } from "../web/src/pairing-diagnostics.js";
import { decodePairingPixels, parsePairingInput } from "../web/src/pairing-qr.js";
import { pairingScanMode } from "../web/src/pairing-scanner.js";

const DAY = 24 * 60 * 60 * 1000;
function request(cookie?: string): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie }, socket: { remoteAddress: "203.0.113.20" } } as IncomingMessage;
}
function pair(auth: WebPairingAuth): string {
  return auth.claimPairing(request(), auth.startPairing().code);
}
function response(): { headers: Record<string, string>; value: ServerResponse } {
  const headers: Record<string, string> = {};
  return { headers, value: { setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; } } as ServerResponse };
}

describe("pairing failure diagnostics", () => {
  it("distinguishes absent, unknown, invalid, revoked, and expired credentials without leaking secrets", () => {
    const db = new StateDatabase(":memory:");
    let now = Date.parse("2026-10-27T08:00:00Z");
    const auth = new WebPairingAuth({ db, now: () => now });
    try {
      expect(auth.status(request())).toMatchObject({ authenticated: false, activeSessionCount: null, draftScope: null,
        diagnostics: { reason: "credential_missing", credential: "none", cookiePresent: false, sessionExpiresAt: null } });
      expect(auth.status(request("bridge_session=unrecognized"))).toMatchObject({
        diagnostics: { reason: "session_unknown", cookiePresent: true, sessionExpiresAt: null } });
      expect(auth.status(request("bridge_session="))).toMatchObject({ diagnostics: { reason: "credential_invalid" } });
      const token = pair(auth);
      const authenticated = request(`bridge_session=${token}`);
      const valid = auth.status(authenticated);
      expect(valid).toMatchObject({ authenticated: true, diagnostics: { reason: "authenticated", credential: "cookie", cookieCount: 1 } });
      expect(JSON.stringify(valid.diagnostics)).not.toContain(token);
      expect(JSON.stringify(valid.diagnostics)).not.toContain(db.listWebAuthSessions()[0]!.tokenHash);
      const duplicate = request(`bridge_session=${token}; bridge_session=other`);
      expect(auth.status(duplicate).diagnostics.cookieCount).toBe(2);
      const malformedBearer = request(`bridge_session=${token}`);
      malformedBearer.headers.authorization = "Bearer bad";
      expect(auth.status(malformedBearer).diagnostics).toMatchObject({ reason: "credential_invalid", credential: "bearer" });
      db.revokeWebAuthSession(auth.currentDeviceId(authenticated)!, new Date(now).toISOString());
      expect(auth.status(authenticated)).toMatchObject({ authenticated: false, diagnostics: { reason: "session_revoked" } });
      const expiring = pair(auth);
      now += 31 * DAY;
      // Expiry may also revoke the row internally; the user still needs the expiry reason.
      expect(auth.status(request(`bridge_session=${expiring}`))).toMatchObject({ authenticated: false,
        diagnostics: { reason: "session_expired", sessionExpiresAt: "2026-11-26T08:00:00.000Z" } });
      const failed = response();
      auth.refreshSessionCookie(authenticated, failed.value);
      auth.refreshSessionCookie(request(`bridge_session=${expiring}`), failed.value);
      auth.refreshSessionCookie(request(), failed.value);
      expect(failed.headers["set-cookie"]).toBeUndefined();
    } finally { db.close(); }
  });

  it("keeps the diagnostic installation identity across auth restarts and separates databases", () => {
    const db = new StateDatabase(":memory:");
    const other = new StateDatabase(":memory:");
    try {
      const first = new WebPairingAuth({ db }).status(request()).diagnostics.installationId;
      expect(first).toMatch(/^[a-f0-9]{16}$/);
      expect(new WebPairingAuth({ db }).status(request()).diagnostics.installationId).toBe(first);
      expect(new WebPairingAuth({ db: other }).status(request()).diagnostics.installationId).not.toBe(first);
    } finally { db.close(); other.close(); }
  });

  it("synchronizes the phone Cookie after an admin extends that phone, without extending authorization on access", async () => {
    const db = new StateDatabase(":memory:");
    let now = Date.parse("2026-10-27T08:00:00Z");
    const auth = new WebPairingAuth({ db, now: () => now });
    const phone = pair(auth);
    const phoneId = auth.currentDeviceId(request(`bridge_session=${phone}`))!;
    const admin = pair(auth);
    const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [] });
    try {
      const url = await server.start();
      const anonymous = await fetch(url + "/api/auth/status");
      expect(anonymous.headers.get("cache-control")).toBe("no-store");
      expect(anonymous.headers.get("set-cookie")).toBeNull();
      expect(await anonymous.json()).toMatchObject({ authenticated: false, diagnostics: { reason: "credential_missing" } });
      const adminHeaders = { Cookie: `bridge_session=${admin}` };
      const session = await (await fetch(url + "/api/session", { headers: adminHeaders })).json() as { actionToken: string };
      const extended = await fetch(url + `/api/auth/devices/${phoneId}/extend`, {
        method: "POST", headers: { ...adminHeaders, Origin: url, "X-Bridge-Action-Token": session.actionToken },
      });
      expect(extended.status).toBe(200);
      const expiry = (await extended.json() as { expiresAt: string }).expiresAt;
      expect(expiry).toBe("2027-11-26T08:00:00.000Z");
      const phoneHeaders = { Cookie: `bridge_session=${phone}` };
      const checked = await fetch(url + "/api/auth/status", { headers: phoneHeaders });
      expect(await checked.json()).toMatchObject({ authenticated: true, diagnostics: { sessionExpiresAt: expiry } });
      expect(checked.headers.get("set-cookie")).toContain("Max-Age=" + (Date.parse(expiry) - now) / 1000);
      expect(checked.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
      const ordinary = await fetch(url + "/api/session", { headers: phoneHeaders });
      expect(ordinary.headers.get("set-cookie")).toContain("Max-Age=" + (Date.parse(expiry) - now) / 1000);
      // A native bearer credential must never be turned into a browser Cookie.
      const bearer = await fetch(url + "/api/auth/status", { headers: { Authorization: `Bearer ${phone}` } });
      expect(bearer.headers.get("set-cookie")).toBeNull();
      now += 31 * DAY;
      expect(auth.status(request(`bridge_session=${phone}`)).authenticated).toBe(true);
      expect(db.listWebAuthSessions().find((item) => item.sessionId === phoneId)!.expiresAt).toBe(expiry);
      db.revokeWebAuthSession(phoneId, new Date(now).toISOString());
      const revoked = await fetch(url + "/api/auth/status", { headers: phoneHeaders });
      expect(revoked.headers.get("set-cookie")).toBeNull();
      expect(await revoked.json()).toMatchObject({ authenticated: false, diagnostics: { reason: "session_revoked" } });
    } finally { await server.stop(); db.close(); }
  });
});

describe("browser pairing evidence", () => {
  function storage() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }
  function status(authenticated: boolean): AuthStatus {
    return { authenticated, local: false, activeSessionCount: null, pairingAvailable: false, pairingExpiresAt: null,
      diagnostics: { reason: authenticated ? "authenticated" : "credential_missing", credential: authenticated ? "cookie" : "none",
        cookiePresent: authenticated, cookieCount: authenticated ? 1 : 0, serverTime: "2026-10-27T08:00:00.000Z",
        installationId: "0123456789abcdef", sessionExpiresAt: authenticated ? "2027-10-27T08:00:00.000Z" : null, sessionRevokedAt: null } };
  }

  it("preserves the last successful expiry and transitions when Cookie disappears, with bounded redacted history", () => {
    const store = storage();
    const valid = { ...status(true), token: "never-store-me", draftScope: "never-store-scope" };
    recordAuthStatus(valid, store, "http://bridge.test:5173/#pair=never-store-code", "2026-10-27T07:50:00Z");
    recordAuthStatus(status(true), store, "http://bridge.test:5173", "2026-10-27T07:51:00Z");
    expect(readAuthEvidence(store).events).toHaveLength(1);
    recordAuthStatus(status(false), store, "http://bridge.test:5173", "2026-10-27T08:00:00Z");
    const evidence = readAuthEvidence(store);
    expect(evidence.lastSuccess?.at).toBe("2026-10-27T07:51:00Z");
    expect(evidence.events).toHaveLength(2);
    expect(diagnosePairing(status(false), evidence).detail).toContain("上次服务器授权仍未到期");
    const saved = [...store.values.values()].join("");
    expect(saved).not.toContain("never-store");
    expect(saved).not.toContain("#pair");
    const otherServer = status(false);
    otherServer.diagnostics!.installationId = "abcdef0123456789";
    expect(diagnosePairing(otherServer, evidence).title).toContain("服务标识已变化");
    for (let index = 0; index < 30; index++) recordAuthStatus(status(index % 2 === 0), store, "http://bridge.test:5173");
    expect(readAuthEvidence(store).events).toHaveLength(20);
  });

  it("tolerates unavailable, corrupt, or legacy browser storage and server diagnostics", () => {
    const store = { getItem: () => "invalid json", setItem: () => { throw new Error("storage disabled"); } };
    expect(readAuthEvidence(store).events).toEqual([]);
    expect(() => recordAuthStatus(status(false), store, "http://bridge.test")).not.toThrow();
    const legacy = status(false);
    delete legacy.diagnostics;
    expect(diagnosePairing(legacy, readAuthEvidence(null)).title).toBe("等待诊断结果");
  });
});

describe("browser pairing QR", () => {
  it("uses photo capture on HTTP and live scanning only on capable HTTPS pages, retaining redacted image diagnostics", () => {
    expect(pairingScanMode("http:", false, false)).toBe("photo");
    expect(pairingScanMode("http:", true, true)).toBe("photo");
    expect(pairingScanMode("https:", true, false)).toBe("photo");
    expect(pairingScanMode("https:", false, true)).toBe("photo");
    expect(pairingScanMode("https:", true, true)).toBe("live");
    const values = new Map<string, string>();
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    recordPairingScan({ mode: "image", outcome: "not_detected", width: 4032, height: 3024, attempts: 6,
      token: "never-store-token", decodedText: "never-store-code" } as never, store);
    expect(readPairingScan(store)).toMatchObject({ mode: "image", outcome: "not_detected", width: 4032, height: 3024, attempts: 6 });
    expect([...values.values()].join("")).not.toContain("never-store");
  });
  it("accepts CLI links from another port on the same host while rejecting unrelated or unsafe QR payloads", () => {
    expect(parsePairingInput("http://bridge.test:7310/#pair=ABCD-EFGH-JKLM", "http://bridge.test:5173")).toBe("ABCD-EFGH-JKLM");
    expect(parsePairingInput("abcd efgh jklm", "http://bridge.test")).toBe("ABCD-EFGH-JKLM");
    for (const invalid of ["javascript:alert(1)", "https://other.test/#pair=ABCD-EFGH-JKLM", "http://user:secret@bridge.test/#pair=ABCD-EFGH-JKLM", "http://bridge.test/?pair=ABCD-EFGH-JKLM", "not a code", "ABCD-EFGH-1234"]) {
      expect(() => parsePairingInput(invalid, "http://bridge.test")).toThrow();
    }
  });

  it("decodes a real generated QR with the browser's fallback decoder, including inverted terminal colors", async () => {
    const payload = "http://bridge.test:7310/#pair=ABCD-EFGH-JKLM";
    const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const scale = 5, margin = 4;
    const width = (qr.modules.size + margin * 2) * scale;
    const pixels = new Uint8ClampedArray(width * width * 4);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const row = Math.floor(y / scale) - margin, column = Math.floor(x / scale) - margin;
      const dark = row >= 0 && column >= 0 && row < qr.modules.size && column < qr.modules.size && qr.modules.get(row, column);
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = dark ? 0 : 255;
      pixels[offset + 3] = 255;
    }
    expect(await decodePairingPixels(pixels, width, width)).toBe(payload);
    for (let index = 0; index < pixels.length; index++) if (index % 4 !== 3) pixels[index] = 255 - pixels[index]!;
    expect(await decodePairingPixels(pixels, width, width)).toBe(payload);
  });
});
