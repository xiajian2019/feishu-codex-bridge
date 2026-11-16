import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOtaBuildNumberAdvances, assertTailscalePortAvailable, createInstallLink, createOtaHandler, discoverVpnAddresses, ensureVpnCertificate,
  nextOtaBuildNumber, normalizeOtaBaseUrl, otaManifest, otaPage, parseOtaBuildNumber, parseOtaOptions, parseRange, refreshAgentPlist, refreshOtaRelease,
  resolveInstallTicket, revokePortalSessions, servicePaths,
} from "../scripts/ios-ota.mjs";

const now = Date.parse("2026-11-09T12:00:00Z");
const dirs: string[] = [];
function fixture(content = "signed IPA fixture") {
  const dir = mkdtempSync(join(tmpdir(), "bridge-ios-ota-test-")); dirs.push(dir);
  mkdirSync(join(dir, "releases"));
  const revision = createHash("sha256").update(content).digest("hex");
  const metadata = { schema: 1, bundleId: "dev.feishu.codex.bridge", revision, size: Buffer.byteLength(content),
    version: "1.0", build: "1", expiresAt: new Date(now + 7 * 86400_000).toISOString(), publishedAt: new Date(now).toISOString() };
  writeFileSync(join(dir, "releases", revision + ".ipa"), content);
  writeFileSync(join(dir, "releases", revision + ".json"), JSON.stringify(metadata));
  writeFileSync(join(dir, "latest.json"), JSON.stringify({ schema: 1, revision }));
  return { dir, revision, metadata, content };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("iOS OTA installation", () => {
  test("accepts VPN IP and a trusted HTTPS proxy while rejecting unsafe combinations", () => {
    expect(parseOtaOptions(["--vpn-ip", "10.0.0.94"]).vpnIp).toBe("10.0.0.94");
    expect(parseOtaOptions(["--tailscale"]).tailscale).toBe(true);
    expect(normalizeOtaBaseUrl("https://10.0.0.94:18731/")).toBe("https://10.0.0.94:18731");
    for (const value of ["http://10.0.0.94", "https://user:pw@host", "https://host/?ticket=a", "https://host/#frag", "https://host/a%2fb"]) {
      expect(() => normalizeOtaBaseUrl(value)).toThrow();
    }
    expect(() => parseOtaOptions(["--vpn-ip", "not-an-ip"])).toThrow();
    expect(() => parseOtaOptions(["--vpn-ip", "10.0.0.1", "--tailscale"])).toThrow();
    expect(() => parseOtaOptions(["--tls-cert", "/tmp/cert"])).toThrow();
    expect(parseOtaOptions(["--build-number", "42"]).buildNumber).toBe(42);
    expect(parseOtaOptions(["--vpn"]).vpn).toBe(true);
    expect(() => parseOtaOptions(["--build-number", "0"])).toThrow("正整数");
    expect(() => parseOtaOptions(["--app", "/tmp/App.app", "--build-number", "42"])).toThrow("不能与");
  });

  test("allocates a build number newer than both the project and the published OTA package", () => {
    const { dir } = fixture();
    const source = mkdtempSync(join(tmpdir(), "bridge-ios-ota-source-")); dirs.push(source);
    mkdirSync(join(source, "ios/App/App.xcodeproj"), { recursive: true });
    writeFileSync(join(source, "ios/App/App.xcodeproj/project.pbxproj"), "CURRENT_PROJECT_VERSION = 1;\nCURRENT_PROJECT_VERSION = 1;");
    expect(parseOtaBuildNumber("42")).toBe(42);
    expect(nextOtaBuildNumber(dir, source)).toBe(2);
    expect(assertOtaBuildNumberAdvances(dir, 2)).toBe(2);
    expect(() => assertOtaBuildNumberAdvances(dir, 1)).toThrow("不高于已发布");
    expect(() => parseOtaBuildNumber("1.0")).toThrow("正整数");
  });

  test("discovers only IPv4 VPN interfaces", () => {
    expect(discoverVpnAddresses({ utun0: [{ family: "IPv4", internal: false, address: "10.0.0.94" }],
      en0: [{ family: "IPv4", internal: false, address: "192.168.1.2" }], utun1: [{ family: "IPv6", internal: false, address: "::1" }] })).toEqual(["10.0.0.94"]);
  });

  test("generates an IP-specific TLS leaf, keeps the root stable and protects the private key", () => {
    const { dir } = fixture();
    const first = ensureVpnCertificate(dir, "10.0.0.94");
    const repeat = ensureVpnCertificate(dir, "10.0.0.94");
    expect(repeat.fingerprint).toBe(first.fingerprint);
    expect(statSync(first.key).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "tls/root-ca.key")).mode & 0o777).toBe(0o600);
    const changed = ensureVpnCertificate(dir, "10.0.0.95");
    expect(changed.fingerprint).toBe(first.fingerprint);
    expect(readFileSync(changed.certificateForPhone).equals(readFileSync(first.certificateForPhone))).toBe(true);
  });

  test("issues scoped expiring links and creates a manifest pointing at the immutable package", () => {
    const { dir, revision, metadata } = fixture();
    const link = createInstallLink(dir, "https://10.0.0.94:18731", now);
    const token = new URL(link.url).pathname.split("/")[1];
    const ticket = resolveInstallTicket(dir, token, now);
    expect(ticket?.metadata.revision).toBe(revision);
    expect(resolveInstallTicket(dir, token, Date.parse(link.expiresAt))).toBeNull();
    expect(resolveInstallTicket(dir, "../other", now)).toBeNull();
    const manifest = otaManifest(ticket!.base, token, metadata);
    expect(manifest).toContain(`${revision}.ipa`);
    expect(manifest).toContain("dev.feishu.codex.bridge");
    const page = otaPage(ticket!.base, token, metadata);
    expect(page).toContain("itms-services://?action=download-manifest&amp;url=");
    expect(page).toContain("点按后请在 iPhone 上确认");
    expect(page).toContain("OTA 包生成时间");
    expect(page).toContain("2026/11/9 12:00:00");
    expect(page).not.toContain("安装成功");
  });

  test("refuses a changed package even when its length is unchanged", () => {
    const { dir, revision, content } = fixture();
    const link = createInstallLink(dir, "https://10.0.0.94:18731", now);
    const token = new URL(link.url).pathname.split("/")[1];
    expect(resolveInstallTicket(dir, token, now)).not.toBeNull();
    writeFileSync(join(dir, "releases", revision + ".ipa"), "x".repeat(content.length));
    expect(resolveInstallTicket(dir, token, now)).toBeNull();
  });

  test("can generate a fresh Safari URL and terminal QR for an existing release", () => {
    const { dir } = fixture();
    const result = spawnSync(process.execPath, [new URL("../scripts/ios-ota.mjs", import.meta.url).pathname,
      "--link", "--directory", dir, "--base-url", "https://10.0.0.94:18731"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("在 iPhone 的 Safari 打开");
    expect(result.stdout).toContain("https://10.0.0.94:18731/");
    expect(result.stdout).toContain("▄▄");
  });

  test("refreshes the published signed snapshot only when it enters the 24-hour window", async () => {
    const { dir, revision, metadata } = fixture();
    let unpacked = 0, published = 0;
    const options = { now, unpack: async (_source: string, _destination: string) => { unpacked++; },
      publish: async (app: string) => { published++; expect(app).toEndWith("Payload/App.app"); return { expiresAt: "2026-11-20T00:00:00Z" }; } };
    expect(await refreshOtaRelease(dir, options)).toBeNull();
    expect([unpacked, published]).toEqual([0, 0]);
    writeFileSync(join(dir, "releases", revision + ".json"), JSON.stringify({ ...metadata, expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString() }));
    expect(await refreshOtaRelease(dir, options)).toEqual({ expiresAt: "2026-11-20T00:00:00Z" });
    expect([unpacked, published]).toEqual([1, 1]);
  });

  test("schedules hourly refresh of the published package", () => {
    const { dir } = fixture();
    const paths = servicePaths(dir, dir);
    const file = join(dir, "refresh.plist");
    writeFileSync(file, refreshAgentPlist(paths, dir, "/path to/bun"));
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.ProgramArguments).toContain("--refresh-run");
    expect(value.ProgramArguments).toContain(dir);
    expect(value.StartCalendarInterval).toEqual({ Minute: 0 });
  });

  test("does not replace an existing Tailscale service", () => {
    expect(() => assertTailscalePortAvailable({}, 18443, 18731)).not.toThrow();
    const mine = { TCP: { "18443": { HTTPS: true } }, Web: { "host.ts.net:18443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18731" } } } } };
    expect(() => assertTailscalePortAvailable(mine, 18443, 18731)).not.toThrow();
    expect(() => assertTailscalePortAvailable(mine, 18443, 18732)).toThrow("其他服务");
    expect(() => assertTailscalePortAvailable({ TCP: { "18443": { HTTPS: true, Funnel: true } } }, 18443, 18731)).toThrow();
  });

  test("validates byte ranges, including suffix ranges", () => {
    expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe(false);
    expect(parseRange("bytes=0-1,3-4", 10)).toBe(false);
  });

  test("serves the scoped page, manifest, immutable IPA and ranges; rejects missing or expired tickets", async () => {
    const { dir, content, revision } = fixture();
    const link = createInstallLink(dir, "https://10.0.0.94:18731", now);
    const token = new URL(link.url).pathname.split("/")[1];
    writeFileSync(join(dir, "service.json"), JSON.stringify({ schema: 1, base: "https://10.0.0.94:18731" }));
    let clock = now;
    const server = createServer(createOtaHandler(dir, "fixture", () => clock));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/`)).status).toBe(401);
      const page = await fetch(`${base}/${token}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const cookie = page.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict");
      expect(await page.text()).toContain("安装 Bridge");
      expect((await fetch(`${base}/`, { headers: { Cookie: cookie.split(";")[0] } })).status).toBe(200);
      const manifest = await fetch(`${base}/${token}/manifest.plist`);
      expect(manifest.headers.get("content-type")).toContain("text/xml");
      expect(await manifest.text()).toContain(`${revision}.ipa`);
      const range = await fetch(`${base}/${token}/${revision}.ipa`, { headers: { Range: "bytes=0-5" } });
      expect(range.status).toBe(206);
      expect(await range.text()).toBe(content.slice(0, 6));
      expect((await fetch(`${base}/${token}/${revision}.ipa`, { method: "HEAD" })).headers.get("content-length")).toBe(String(content.length));
      expect((await fetch(`${base}/${token}/${revision}.ipa`, { headers: { Range: "bytes=999-" } })).status).toBe(416);
      expect((await fetch(`${base}/${token}/latest.json`)).status).toBe(404);
      expect((await fetch(`${base}/${token}/`, { method: "POST" })).status).toBe(405);
      clock = Date.parse(link.expiresAt);
      expect((await fetch(`${base}/${token}/manifest.plist`)).status).toBe(404);
      expect((await fetch(`${base}/`, { headers: { Cookie: cookie.split(";")[0] } })).status).toBe(200);
      expect(revokePortalSessions(dir)).toBeGreaterThan(0);
      expect((await fetch(`${base}/`, { headers: { Cookie: cookie.split(";")[0] } })).status).toBe(401);
      expect((await fetch(`${base}/${token}/`)).status).toBe(404);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  test("serves VPN HTTPS with a trusted root and rejects an untrusted client", async () => {
    const { dir } = fixture();
    const tls = ensureVpnCertificate(dir, "127.0.0.1");
    const server = createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key), minVersion: "TLSv1.2" }, createOtaHandler(dir, "fixture"));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
    const get = (ca?: Buffer) => new Promise<number>((resolve, reject) => {
      const req = httpsRequest({ host: "127.0.0.1", port: address.port, path: "/health", ca }, (response) => { response.resume(); resolve(response.statusCode!); });
      req.once("error", reject); req.end();
    });
    try {
      await expect(get()).rejects.toThrow();
      expect(await get(readFileSync(tls.ca))).toBe(200);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
