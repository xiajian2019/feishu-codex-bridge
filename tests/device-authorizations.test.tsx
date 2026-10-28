import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { StateDatabase } from "../src/db.js";
import { WebPairingAuth, webAuthRequestOrigin } from "../src/web-auth.js";
import { DashboardServer } from "../src/web.js";
import { DeviceAuthorizations } from "../web/src/DeviceAuthorizations.js";
import { describeDevice, deviceAccessEnvironment, deviceAuthorizationState, matchesDeviceSearch, sameModelCounts, selectableDeviceIds, sortDeviceAuthorizations, type DeviceAuthorization } from "../web/src/device-authorizations.js";

const WEBVIEW = "Mozilla/5.0 (Linux; Android 12; ADA-AL00U Build/HUAWEIADA-AL00U; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const HUAWEI = "Mozilla/5.0 (Linux; Android 12; HarmonyOS; ADA-AL00U; HMSCore 6.16.4.362) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.79 HuaweiBrowser/17.9.2.300 Mobile Safari/537.36";
const NOW = Date.parse("2026-10-27T13:00:00.000Z");
function device(overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
  return { sessionId: "abcdef12-3456-7890-abcd-ef1234567890", current: false, deviceName: "华为手机", userAgent: HUAWEI,
    remoteAddress: "192.168.1.40", createdAt: "2026-09-27T13:00:00.000Z", lastSeenAt: "2026-10-27T13:00:00.000Z", expiresAt: "2027-10-27T13:00:00.000Z", ...overrides };
}
function request(headers: Record<string, string> = {}, remoteAddress = "192.0.2.4"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe("device authorization presentation", () => {
  it("distinguishes the screenshot's browser environments, keeps aliases, and only flags same models for review", () => {
    const browser = device();
    const app = device({ sessionId: "app-token", userAgent: WEBVIEW, clientType: "app", deviceName: "主力华为" });
    expect(describeDevice(browser)).toMatchObject({ browser: "华为浏览器 17.9", system: "HarmonyOS", model: "ADA-AL00U", customName: false });
    expect(describeDevice(device({ userAgent: WEBVIEW }))).toMatchObject({ browser: "内嵌浏览器 WebView 114.0", system: "Android 12", app: false, model: "ADA-AL00U" });
    expect(describeDevice(app)).toMatchObject({ name: "主力华为", browser: "Bridge App", app: true, customName: true });
    const unknownModels = [device({ userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/132.0", sessionId: "other" })];
    const count = sameModelCounts([browser, app, ...unknownModels], NOW);
    expect(count.get(describeDevice(browser).modelKey!)).toBe(2);
    expect(count.has("")).toBe(false);
    expect(browser.sessionId).not.toBe(app.sessionId);
    expect(selectableDeviceIds([device({ current: true }), app, device({ status: "expired", sessionId: "expired" })], NOW)).toEqual(["app-token"]);
  });

  it("pins current authorization, searches readable metadata and ports, and rejects stale shared-DB origins", () => {
    const current = device({ current: true, sessionId: "current", lastSeenAt: "2026-10-26T00:00:00.000Z" });
    const browser = device({ lastAccessOrigin: "http://bridge.test:5173", lastAccessOriginAt: "2026-10-27T13:00:00.000Z" });
    expect(sortDeviceAuthorizations([browser, current])[0]).toBe(current);
    expect(matchesDeviceSearch(browser, "华为 5173")).toBe(true);
    expect(matchesDeviceSearch(browser, "192.168.1.40 ADA-AL00U")).toBe(true);
    expect(deviceAccessEnvironment(browser)).toEqual({ origin: "http://bridge.test:5173", port: "5173" });
    expect(deviceAccessEnvironment(device({ ...browser, lastSeenAt: "2026-10-27T13:00:01.000Z" }))).toBeNull();
    expect(deviceAccessEnvironment(device({ ...browser, lastAccessOrigin: "https://bridge.test" }))).toEqual({ origin: "https://bridge.test", port: "443" });
    expect(deviceAccessEnvironment(device({ ...browser, lastAccessOrigin: "http://user:secret@bridge.test:7130" }))).toBeNull();
    expect(deviceAuthorizationState(device({ revokedAt: "2026-10-26T00:00:00Z" }), NOW)).toBe("revoked");
  });

  it("renders compact identity and port summaries while keeping the raw UA in closed details", () => {
    const row = device({ current: true, clientType: "app", userAgent: WEBVIEW, lastAccessOrigin: "http://bridge.test:7130", lastAccessOriginAt: "2026-10-27T13:00:00.000Z" });
    const html = renderToStaticMarkup(<DeviceAuthorizations devices={[row]} loading={false} busy={false} onRefresh={async () => {}} onRename={() => {}} onExtend={async () => {}} onRevoke={async () => {}} />);
    expect(html).toContain("Bridge App");
    expect(html).toContain("最近访问 :7130");
    expect(html).toContain("当前授权");
    expect(html.indexOf(WEBVIEW)).toBeGreaterThan(html.indexOf('<details class="device-auth-details">'));
    expect(html).not.toContain('<details class="device-auth-details" open');
    expect(html).not.toContain("role=\"dialog\"");
    expect(html).toContain("授权记录范围");
  });
});

describe("public environment tracking", () => {
  it("records browser-facing ports from the trusted local proxy and ignores remote forwarding claims", () => {
    expect(webAuthRequestOrigin(request({ host: "bridge.test:7130" }))).toBe("http://bridge.test:7130");
    expect(webAuthRequestOrigin(request({ host: "127.0.0.1:17310", "x-bridge-public-origin": "https://bridge.test:5173" }, "127.0.0.1"))).toBe("https://bridge.test:5173");
    expect(webAuthRequestOrigin(request({ host: "bridge.test:7130", "x-bridge-public-origin": "http://forged.test:5173" }))).toBe("http://bridge.test:7130");
    expect(webAuthRequestOrigin(request({ host: "[::1]:7130" }, "::1"))).toBe("http://[::1]:7130");
    expect(webAuthRequestOrigin(request({ host: "127.0.0.1:17310", "x-bridge-public-origin": "http://bridge.test:5173/#pair=secret" }, "127.0.0.1"))).toBe("http://127.0.0.1:17310");
  });

  it("updates port changes immediately and detects an older writer that does not record origin", () => {
    const db = new StateDatabase(":memory:");
    let now = NOW;
    const auth = new WebPairingAuth({ db, now: () => now });
    const token = auth.claimPairing(request({ host: "bridge.test:7130", "user-agent": HUAWEI }), auth.startPairing().code);
    const direct = request({ host: "bridge.test:7130", cookie: `bridge_session=${token}`, "user-agent": HUAWEI });
    try {
      expect(auth.listDevices(direct)![0]).toMatchObject({ lastAccessOrigin: "http://bridge.test:7130", clientType: "browser" });
      now += 1000;
      const proxy = request({ host: "127.0.0.1:17310", cookie: `bridge_session=${token}`, "x-bridge-public-origin": "http://bridge.test:5173", "x-forwarded-for": "192.0.2.4", "user-agent": HUAWEI }, "127.0.0.1");
      expect(auth.listDevices(proxy)![0]).toMatchObject({ lastAccessOrigin: "http://bridge.test:5173", lastAccessOriginAt: new Date(now).toISOString() });
      const saved = db.listWebAuthSessions()[0]!;
      now += 1000;
      db.touchWebAuthSession(saved.sessionId, new Date(now).toISOString(), HUAWEI, "192.0.2.4");
      expect(deviceAccessEnvironment(db.listWebAuthSessions()[0]! as unknown as DeviceAuthorization)).toBeNull();
      now += 1000;
      // A fresh same-origin request restores a trustworthy last origin even within the touch throttle window.
      const refreshed = auth.listDevices(proxy)![0]!;
      expect(deviceAccessEnvironment(refreshed)).toEqual({ origin: "http://bridge.test:5173", port: "5173" });
      expect(refreshed.lastAccessOriginAt).toBe(new Date(now).toISOString());
    } finally { db.close(); }
  });

  it("migrates legacy sessions without losing credentials or inventing an access port", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-device-migration-"));
    const path = join(root, "fixture.db");
    const token = "legacy-fixture-token";
    const hash = createHash("sha256").update(token).digest("hex");
    const old = new Database(path);
    old.exec(`CREATE TABLE web_auth_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL, user_agent TEXT, remote_address TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)`);
    old.query("INSERT INTO web_auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("legacy", hash, "主力手机", WEBVIEW, "192.0.2.4", new Date(NOW).toISOString(), new Date(NOW).toISOString(), "2030-01-01T00:00:00Z");
    old.close();
    const db = new StateDatabase(path);
    try {
      const row = db.listWebAuthSessions()[0]!;
      expect(row).toMatchObject({ sessionId: "legacy", deviceName: "主力手机", tokenHash: hash, clientType: "unknown", lastAccessOrigin: null, lastAccessOriginAt: null });
      const auth = new WebPairingAuth({ db, now: () => NOW });
      expect(auth.isAuthorized(request({ cookie: `bridge_session=${token}`, host: "bridge.test:7130" }))).toBe(true);
      expect(db.listWebAuthSessions()[0]!.lastAccessOrigin).toBe("http://bridge.test:7130");
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("makes the Vite API proxy overwrite client-supplied display metadata without changing action origin routing", async () => {
    const config = (await import("../web/vite.config.ts")).default;
    const api = config.server!.proxy!["/api"] as { configure: (proxy: unknown) => void };
    let handler!: (outgoing: unknown, incoming: IncomingMessage) => void;
    api.configure({ on: (_event: string, callback: typeof handler) => { handler = callback; } });
    const headers = new Map<string, string>([["x-bridge-public-origin", "http://forged.test:7130"]]);
    handler({ setHeader: (key: string, value: string) => headers.set(key.toLowerCase(), value), removeHeader: (key: string) => headers.delete(key.toLowerCase()) }, request({ host: "bridge.test:5173", "x-bridge-public-origin": "http://forged.test:7130" }));
    expect(headers.get("x-bridge-public-origin")).toBe("http://bridge.test:5173");
    expect(headers.get("origin")).toBe("http://127.0.0.1:17310");
  });

  it("serves authorized history, separates App/browser identities, and exposes no credentials", async () => {
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db, now: () => NOW });
    const admin = auth.claimPairing(request({ host: "bridge.test:5173" }), auth.startPairing().code);
    const mobile = auth.claimMobilePairing(request({ host: "bridge.test:7130", "user-agent": WEBVIEW }), auth.startPairing().code);
    const revoked = auth.claimPairing(request({ host: "bridge.test:7130" }), auth.startPairing().code);
    const expired = auth.claimPairing(request({ host: "bridge.test:7130" }), auth.startPairing().code);
    const revokedId = auth.currentDeviceId(request({ cookie: `bridge_session=${revoked}` }))!;
    const expiredId = auth.currentDeviceId(request({ cookie: `bridge_session=${expired}` }))!;
    db.revokeWebAuthSession(revokedId, new Date(NOW).toISOString());
    db.updateWebAuthSessionExpiry(expiredId, new Date(NOW - 1).toISOString());
    const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [] });
    try {
      const url = await server.start();
      expect((await fetch(url + "/api/auth/devices?includeInactive=1")).status).toBe(401);
      const headers = { Cookie: `bridge_session=${admin}`, "X-Bridge-Public-Origin": "http://bridge.test:5173" };
      const active = await (await fetch(url + "/api/auth/devices", { headers })).json() as { devices: DeviceAuthorization[] };
      expect(active.devices).toHaveLength(2);
      const history = await (await fetch(url + "/api/auth/devices?includeInactive=1", { headers })).json() as { devices: DeviceAuthorization[] };
      expect(history.devices).toHaveLength(4);
      expect(history.devices.find((item) => item.current)).toMatchObject({ lastAccessOrigin: "http://bridge.test:5173", status: "active" });
      expect(history.devices.find((item) => item.clientType === "app")).toMatchObject({ userAgent: WEBVIEW, lastAccessOrigin: "http://bridge.test:7130" });
      expect(history.devices.find((item) => item.sessionId === revokedId)?.status).toBe("revoked");
      expect(history.devices.find((item) => item.sessionId === expiredId)?.status).toBe("expired");
      const serialized = JSON.stringify(history);
      for (const secret of [admin, mobile.token, revoked, expired]) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("tokenHash");
    } finally { await server.stop(); db.close(); }
  });
});
