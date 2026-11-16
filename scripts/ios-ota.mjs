import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { createSecureContext } from "node:tls";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSignedApp, notifyRenewalIssue, readProfile, renewalDue, renewalPaths, requestRenewedApp } from "./ios-auto-renew.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleId = "dev.feishu.codex.bridge";
const supportedBundleIds = new Set([bundleId]);
const defaultDirectory = join(root, "ios/App/build/ios-ota");
const maxTicketMs = 24 * 60 * 60 * 1000;
const portalSessionMs = 30 * 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const revisionPattern = /^[a-f0-9]{64}$/;

export function parseOtaOptions(args) {
  const result = { mode: "publish", app: null, vpn: false, baseUrl: null, device: null, directory: defaultDirectory,
    port: 18731, httpsPort: 18443, vpnIp: null, tailscale: false, tlsCert: null, tlsKey: null, buildNumber: null,
    noServe: false, allowProvisioningUpdates: true, help: false };
  let modeSet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (["--check", "--start", "--stop", "--link", "--revoke-sessions", "--serve-internal", "--refresh-run"].includes(arg)) {
      if (modeSet) throw new Error("OTA 操作不能同时使用。");
      modeSet = true; result.mode = arg.slice(2);
    } else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--no-serve") result.noServe = true;
    else if (arg === "--vpn") result.vpn = true;
    else if (arg === "--tailscale") result.tailscale = true;
    else if (arg === "--allow-provisioning-updates") result.allowProvisioningUpdates = true;
    else if (arg === "--no-provisioning-updates") result.allowProvisioningUpdates = false;
    else if (["--app", "--base-url", "--device", "--directory", "--build-number", "--port", "--https-port", "--vpn-ip", "--tls-cert", "--tls-key"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要参数。`);
      if (arg === "--app") result.app = resolve(value);
      else if (arg === "--base-url") result.baseUrl = normalizeOtaBaseUrl(value);
      else if (arg === "--device") result.device = value;
      else if (arg === "--directory") result.directory = resolve(value);
      else if (arg === "--build-number") {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error("--build-number 需要正整数。");
        result.buildNumber = Number(value);
      }
      else if (arg === "--vpn-ip") { if (isIP(value) !== 4) throw new Error("--vpn-ip 必须是本机的 IPv4 地址。"); result.vpnIp = value; }
      else if (arg === "--tls-cert") result.tlsCert = resolve(value);
      else if (arg === "--tls-key") result.tlsKey = resolve(value);
      else {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${arg} 端口无效。`);
        if (arg === "--port") result.port = number; else result.httpsPort = number;
      }
    } else throw new Error(`无法识别的参数：${arg}`);
  }
  if (result.noServe && result.mode !== "publish") throw new Error("--no-serve 只能用于生成安装包。");
  if (Number(Boolean(result.tailscale)) + Number(Boolean(result.vpnIp)) + Number(Boolean(result.baseUrl)) > 1) {
    throw new Error("--vpn-ip、--tailscale 和 --base-url 只能选择一种。");
  }
  if (Boolean(result.tlsCert) !== Boolean(result.tlsKey)) throw new Error("--tls-cert 和 --tls-key 必须同时指定。");
  if (result.tailscale && result.tlsCert || result.baseUrl && result.tlsCert) throw new Error("自定义 TLS 证书仅用于 VPN IP 直连。");
  if ((result.app || result.device || result.buildNumber !== null) && result.mode !== "publish") throw new Error("构建选项只能用于生成安装包。");
  if (result.app && result.buildNumber !== null) throw new Error("--app 不能与 --build-number 同时使用。");
  if (result.app && result.vpn) throw new Error("--app 不能与 --vpn 同时使用；已有 App 请直接传入对应产物。");
  return result;
}

export function normalizeOtaBaseUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("OTA 地址必须是有效的 HTTPS URL。"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash ||
      /(?:^|\/)\.\.?($|\/)/.test(url.pathname) || /%2f|%5c/i.test(url.pathname)) {
    throw new Error("OTA 地址必须是没有用户名、参数或片段的 HTTPS URL。");
  }
  return url.href.replace(/\/+$/, "");
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function plist(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}
function stringEntry(key, value) { return `<key>${xml(key)}</key><string>${xml(value)}</string>`; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function stateFile(directory) { return join(directory, "latest.json"); }
function linksDirectory(directory) { return join(directory, "links"); }
function releaseDirectory(directory) { return join(directory, "releases"); }
function atomicJson(path, value) {
  const staged = `${path}.${randomUUID()}.tmp`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(staged, path);
}
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw new Error(`${basename(file)} 失败：${result.error?.message || result.stderr?.trim() || `退出码 ${result.status}`}`);
  return result.stdout ?? "";
}
function readPlist(file, key) { return command("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file]).trim(); }

export function parseOtaBuildNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) {
    throw new Error("iOS OTA 构建号必须是正整数。");
  }
  return Number(text);
}

function publishedBuildNumber(directory) {
  if (!existsSync(stateFile(directory))) return null;
  const build = readLatest(directory).metadata.build;
  return parseOtaBuildNumber(build);
}

function projectBuildNumber(source) {
  const project = join(source, "ios/App/App.xcodeproj/project.pbxproj");
  if (!existsSync(project)) return null;
  const values = [...readFileSync(project, "utf8").matchAll(/CURRENT_PROJECT_VERSION\s*=\s*([0-9]+);/g)]
    .map((match) => parseOtaBuildNumber(match[1]));
  return values.length ? Math.max(...values) : null;
}

export function nextOtaBuildNumber(directory, source = root) {
  const published = publishedBuildNumber(directory) ?? 0;
  const project = projectBuildNumber(source) ?? 1;
  if (published >= Number.MAX_SAFE_INTEGER) throw new Error("iOS OTA 构建号已达到安全上限，请调整版本策略。");
  return Math.max(project, published + 1);
}

export function assertOtaBuildNumberAdvances(directory, current) {
  const build = parseOtaBuildNumber(current);
  const published = publishedBuildNumber(directory);
  if (published !== null && build <= published) {
    throw new Error(`本次 iOS OTA 构建号 ${build} 不高于已发布的 ${published}，无法作为覆盖更新；请重新构建并递增 CFBundleVersion。`);
  }
  return build;
}

export function assertOtaBuildAdvances(directory, app) {
  const current = parseOtaBuildNumber(readPlist(join(app, "Info.plist"), "CFBundleVersion"));
  return assertOtaBuildNumberAdvances(directory, current);
}

export function parseRelease(value) {
  if (!value || value.schema !== 1 || !supportedBundleIds.has(value.bundleId) || !revisionPattern.test(value.revision ?? "") ||
      !Number.isSafeInteger(value.size) || value.size <= 0 || typeof value.version !== "string" || !value.version ||
      typeof value.build !== "string" || !value.build || !Number.isFinite(Date.parse(value.expiresAt)) ||
      !Number.isFinite(Date.parse(value.publishedAt))) throw new Error("OTA 安装包元数据无效。");
  return value;
}
const verifiedFiles = new Map();
function verifyReleaseFile(path, revision, expected) {
  const identity = (value) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  const key = identity(expected);
  if (verifiedFiles.get(path) === `${revision}:${key}`) return;
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || identity(before) !== key) throw new Error("OTA 安装包正在变更。");
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const count = readSync(descriptor, buffer, 0, buffer.length, null); if (!count) break; digest.update(buffer.subarray(0, count)); }
    if (identity(fstatSync(descriptor)) !== key || digest.digest("hex") !== revision) throw new Error("OTA 安装包校验失败。");
    verifiedFiles.set(path, `${revision}:${key}`);
    if (verifiedFiles.size > 32) verifiedFiles.delete(verifiedFiles.keys().next().value);
  } finally { closeSync(descriptor); }
}
export function readRelease(directory, revision) {
  if (!revisionPattern.test(revision)) throw new Error("安装包版本无效。");
  const value = parseRelease(JSON.parse(readFileSync(join(releaseDirectory(directory), `${revision}.json`), "utf8")));
  const path = join(releaseDirectory(directory), `${revision}.ipa`);
  const file = lstatSync(path);
  if (value.revision !== revision || !file.isFile() || file.size !== value.size) throw new Error("OTA 安装包已失效。");
  verifyReleaseFile(path, revision, file);
  return { metadata: value, path };
}
export function readLatest(directory) {
  const record = JSON.parse(readFileSync(stateFile(directory), "utf8"));
  return readRelease(directory, record.revision);
}

async function fileSha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function createOtaRelease(app, directory, requestedDevice = null, now = Date.now()) {
  if (!existsSync(join(app, "Info.plist"))) throw new Error("找不到已签名的 iOS App。");
  mkdirSync(releaseDirectory(directory), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(directory, ".ota-stage-"));
  try {
    const payload = join(staging, "Payload");
    const snapshot = join(payload, "App.app");
    mkdirSync(payload, { recursive: true, mode: 0o700 });
    command("/usr/bin/ditto", [app, snapshot]);
    const appBundleId = readPlist(join(snapshot, "Info.plist"), "CFBundleIdentifier");
    if (!supportedBundleIds.has(appBundleId)) throw new Error("App 的 Bundle ID 与 Bridge 不一致。");
    const profile = readProfile(join(snapshot, "embedded.mobileprovision"));
    if (!profile.devices.length) throw new Error("描述文件没有可安装设备。");
    if (requestedDevice && !profile.devices.includes(requestedDevice)) throw new Error("主 App 描述文件不包含指定设备。");
    const candidates = requestedDevice ? [requestedDevice] : profile.devices;
    let valid = [];
    let signing;
    for (const udid of candidates) {
      try { const found = inspectSignedApp(snapshot, udid); signing ??= found; valid.push(udid); }
      catch (error) { if (requestedDevice) throw error; }
    }
    if (!signing || !valid.length) throw new Error("主 App 和扩展没有共同的已授权设备。");
    if (renewalDue(signing, now)) {
      const originalCount = valid.length;
      console.log("签名将在 24 小时内到期，正在为 OTA 快照申请新描述文件。");
      const archive = `snapshot-${randomUUID()}.xcarchive`;
      const archivedApp = join(staging, archive, "Products/Applications/App.app");
      mkdirSync(dirname(archivedApp), { recursive: true, mode: 0o700 });
      command("/usr/bin/ditto", [snapshot, archivedApp]);
      const renewalDir = join(staging, "renewal");
      mkdirSync(renewalDir, { recursive: true, mode: 0o700 });
      const renewed = requestRenewedApp(staging, { archive, udid: valid[0], signing }, renewalDir, now);
      rmSync(snapshot, { recursive: true, force: true });
      command("/usr/bin/ditto", [renewed.app, snapshot]);
      signing = inspectSignedApp(snapshot, valid[0]);
      valid = valid.filter((udid) => { try { inspectSignedApp(snapshot, udid); return true; } catch { return false; } });
      if (valid.length !== originalCount || requestedDevice && !valid.includes(requestedDevice)) throw new Error("新描述文件不包含所有原授权设备，未发布 OTA 安装包。");
    }
    if (Date.parse(signing.effectiveExpiry) <= now) throw new Error("App 的签名或描述文件已过期，请先重新签名。");
    const version = readPlist(join(snapshot, "Info.plist"), "CFBundleShortVersionString");
    const build = readPlist(join(snapshot, "Info.plist"), "CFBundleVersion");
    const tempIpa = join(staging, "Bridge.ipa");
    command("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payload, tempIpa]);
    const revision = await fileSha256(tempIpa);
    const size = statSync(tempIpa).size;
    const metadata = parseRelease({ schema: 1, bundleId: appBundleId, revision, size, version, build,
      expiresAt: signing.effectiveExpiry, publishedAt: new Date(now).toISOString(), deviceCount: valid.length });
    const destination = join(releaseDirectory(directory), `${revision}.ipa`);
    if (existsSync(destination)) {
      if (!lstatSync(destination).isFile() || statSync(destination).size !== size || await fileSha256(destination) !== revision) {
        throw new Error("已有同名 OTA 安装包损坏，请检查安装包目录。");
      }
    } else renameSync(tempIpa, destination);
    atomicJson(join(releaseDirectory(directory), `${revision}.json`), metadata);
    atomicJson(stateFile(directory), { schema: 1, revision });
    return metadata;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function createInstallLink(directory, baseUrl, now = Date.now()) {
  const base = normalizeOtaBaseUrl(baseUrl);
  const { metadata } = readLatest(directory);
  const expires = Math.min(now + maxTicketMs, Date.parse(metadata.expiresAt));
  if (expires <= now) throw new Error("安装包的签名已过期，请重新构建或签名。");
  mkdirSync(linksDirectory(directory), { recursive: true, mode: 0o700 });
  let active = 0;
  for (const name of readdirSync(linksDirectory(directory))) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(linksDirectory(directory), name);
    try { if (JSON.parse(readFileSync(path, "utf8")).expires <= now) unlinkSync(path); else active++; } catch { active++; }
  }
  if (active >= 200) throw new Error("OTA 安装链接过多，请稍后重试或撤销旧链接。");
  const token = randomBytes(32).toString("base64url");
  atomicJson(join(linksDirectory(directory), `${hash(token)}.json`), { schema: 1, revision: metadata.revision, base, expires });
  return { url: `${base}/${token}/`, expiresAt: new Date(expires).toISOString(), metadata };
}

export function resolveInstallTicket(directory, token, now = Date.now()) {
  if (!tokenPattern.test(token)) return null;
  try {
    const ticket = JSON.parse(readFileSync(join(linksDirectory(directory), `${hash(token)}.json`), "utf8"));
    if (ticket.schema !== 1 || !revisionPattern.test(ticket.revision) || !Number.isFinite(ticket.expires) || ticket.expires <= now) return null;
    const base = normalizeOtaBaseUrl(ticket.base);
    const release = readRelease(directory, ticket.revision);
    if (Date.parse(release.metadata.expiresAt) <= now) return null;
    return { ...release, base, token, expires: ticket.expires };
  } catch { return null; }
}

function sessionsDirectory(directory) { return join(directory, "sessions"); }
function portalCookieName(serviceId) { return `bridge_ios_ota_${hash(serviceId).slice(0, 12)}`; }
function portalSession(directory, token, now) {
  if (!tokenPattern.test(token ?? "")) return null;
  try {
    const session = JSON.parse(readFileSync(join(sessionsDirectory(directory), `${hash(token)}.json`), "utf8"));
    return session.schema === 1 && Number.isFinite(session.expires) && session.expires > now ? session : null;
  } catch { return null; }
}
function requestPortalSession(request, directory, serviceId, now) {
  const name = portalCookieName(serviceId);
  const token = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
  return portalSession(directory, token, now);
}
function issuePortalSession(directory, serviceId, base, now) {
  mkdirSync(sessionsDirectory(directory), { recursive: true, mode: 0o700 });
  const files = readdirSync(sessionsDirectory(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  let active = 0;
  for (const file of files) {
    const path = join(sessionsDirectory(directory), file);
    try { if (JSON.parse(readFileSync(path, "utf8")).expires <= now) unlinkSync(path); else active++; } catch { active++; }
  }
  if (active >= 100) throw new Error("OTA 已授权设备过多，请先撤销不再使用的授权。");
  const token = randomBytes(32).toString("base64url");
  atomicJson(join(sessionsDirectory(directory), `${hash(token)}.json`), { schema: 1, base, expires: now + portalSessionMs });
  const path = new URL(base).pathname.replace(/\/+$/, "") || "/";
  return `${portalCookieName(serviceId)}=${token}; Path=${path === "/" ? "/" : path + "/"}; Max-Age=${portalSessionMs / 1000}; Secure; HttpOnly; SameSite=Strict`;
}
export function revokePortalSessions(directory) {
  let removed = 0;
  for (const dir of [sessionsDirectory(directory), linksDirectory(directory)]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const path = join(dir, file);
      if (!lstatSync(path).isFile()) continue;
      unlinkSync(path); removed++;
    }
  }
  return removed;
}

export function otaManifest(base, token, metadata) {
  const packageUrl = `${normalizeOtaBaseUrl(base)}/${token}/${metadata.revision}.ipa`;
  const assets = `<key>assets</key><array><dict>${stringEntry("kind", "software-package")}${stringEntry("url", packageUrl)}</dict></array>`;
  const info = stringEntry("bundle-identifier", metadata.bundleId) + stringEntry("bundle-version", metadata.build) +
    stringEntry("kind", "software") + stringEntry("title", "Bridge");
  return plist(`<key>items</key><array><dict>${assets}<key>metadata</key><dict>${info}</dict></dict></array>`);
}

function otaPageContentSecurityPolicy(nonce) {
  return `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
}

function mergeByteRange(ranges, start, end) {
  if (end < start) return ranges;
  const sorted = [...ranges, [start, end]].sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range[0] > previous[1] + 1) merged.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}

function byteRangeCoverage(ranges) {
  return ranges.reduce((total, [start, end]) => total + end - start + 1, 0);
}

export function otaPage(base, token, metadata, nonce = randomBytes(18).toString("base64")) {
  const manifestUrl = `${normalizeOtaBaseUrl(base)}/${token}/manifest.plist`;
  const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
  const basePath = new URL(normalizeOtaBaseUrl(base)).pathname.replace(/\/+$/, "");
  const statusUrlLiteral = JSON.stringify(`${basePath}/${token}/download-status.json`).replaceAll("<", "\\u003c");
  const publishedAt = new Date(metadata.publishedAt).toLocaleString("zh-CN", { hour12: false });
  const date = new Date(metadata.expiresAt).toLocaleString("zh-CN", { hour12: false });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><link rel="icon" href="data:,"><title>安装 Bridge</title>
<style>:root{color-scheme:light dark;font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#f2f3f7;color:#182230}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:min(100%,440px)}.brand{display:flex;align-items:center;gap:14px;margin-bottom:24px}.icon{width:58px;height:58px;border-radius:17px;display:grid;place-items:center;background:#2563eb;color:#fff;font-size:27px;font-weight:700}h1{font-size:24px;margin:0}p{margin:4px 0;color:#586678}.button{display:block;border-radius:14px;background:#2563eb;color:white;padding:15px;text-align:center;text-decoration:none;font-weight:650}.card{margin-top:18px;padding:4px 16px;border-radius:14px;background:#fff}.row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #e6eaf0}.row:last-child{border:0}.row span{color:#586678}.row b{text-align:right;overflow-wrap:anywhere}#status{margin-top:16px;padding:12px;border-radius:10px;background:#e7efff;color:#1c4189}#transfer-progress{display:block;width:100%;height:8px;margin-top:8px}#transfer-progress[hidden]{display:none}#status[hidden]{display:none}.hint{margin-top:18px;font-size:14px}@media(prefers-color-scheme:dark){:root{background:#10151e;color:#e9edf5}p,.row span{color:#a7b3c4}.card{background:#1b2330}.row{border-color:#303b4a}#status{background:#1d3557;color:#d1e3ff}}</style></head>
<body><main><div class="brand"><div class="icon" aria-hidden="true">B</div><div><h1>安装 Bridge</h1><p>版本 ${xml(metadata.version)} · 构建 ${xml(metadata.build)}</p></div></div>
<a class="button" id="install" href="${xml(installUrl)}">安装 Bridge</a><div id="status" role="status" aria-live="polite">点按后请在 iPhone 上确认系统提示。IPA 下载由 iOS 安装器处理；Safari 不显示普通下载进度。</div><p id="transfer-label" hidden></p><progress id="transfer-progress" max="${metadata.size}" value="0" hidden aria-label="此安装链接累计的服务端输出"></progress>
<div class="card"><div class="row"><span>OTA 包生成时间</span><b>${xml(publishedAt)}</b></div><div class="row"><span>签名有效至</span><b>${xml(date)}</b></div><div class="row"><span>安装包</span><b>${xml((metadata.size / 1024 / 1024).toFixed(1))} MB</b></div></div>
<p class="hint">请在 iPhone 的 Safari 中打开本页。安装时保留原 App，以便系统覆盖更新。</p></main>
<script nonce="${xml(nonce)}">(() => {
  const statusUrl = ${statusUrlLiteral};
  const totalBytes = ${metadata.size};
  const install = document.getElementById("install");
  const status = document.getElementById("status");
  const progress = document.getElementById("transfer-progress");
  const progressLabel = document.getElementById("transfer-label");
  let installRequested = false;
  let requestObserved = false;
  let polling = false;
  let deadline = 0;
  let timer = 0;
  const formatBytes = (value) => value < 1048576 ? Math.round(value / 1024) + " KB" : (value / 1048576).toFixed(1) + " MB";
  const render = (snapshot) => {
    if (snapshot.requestCount > 0) {
      requestObserved = true;
      installRequested = true;
      if (snapshot.state !== "sent" && !polling) { polling = true; deadline = Date.now() + 300000; }
      if (snapshot.state === "downloading") deadline = Date.now() + 300000;
    }
    if (!snapshot.requestCount) {
      progress.hidden = true;
      progressLabel.hidden = true;
      status.textContent = installRequested
        ? "尚未收到 IPA 请求。请在 iOS 系统提示中点“安装”；此页面不会代替系统确认。"
        : "点按后请在 iPhone 上确认系统提示。IPA 下载由 iOS 安装器处理；Safari 不显示普通下载进度。";
      return;
    }
    progress.hidden = false;
    progressLabel.hidden = false;
    const lastRequest = snapshot.lastRequestAt ? new Date(snapshot.lastRequestAt).toLocaleString() : "未知";
    progressLabel.textContent = "此链接累计的服务端输出 · 最近请求 " + lastRequest;
    progress.max = snapshot.totalBytes;
    progress.value = Math.min(snapshot.bytesSent, snapshot.totalBytes);
    progress.setAttribute("aria-valuetext", formatBytes(snapshot.bytesSent) + " / " + formatBytes(snapshot.totalBytes));
    if (snapshot.state === "sent") {
      status.textContent = "此链接的包请求累计已覆盖完整 IPA（" + formatBytes(snapshot.totalBytes) + "），服务端响应已写完。iPhone 是否收到及安装仍需确认；同一链接的历史请求会合并。";
    } else if (snapshot.activeRequests > 0) {
      status.textContent = "此链接有 IPA 请求：服务端累计输出 " + formatBytes(snapshot.bytesSent) + " / " + formatBytes(snapshot.totalBytes) + "。这不是 iPhone 安装进度；同一链接的请求会合并。";
    } else {
      status.textContent = "当前没有活跃 IPA 请求；此链接累计输出 " + formatBytes(snapshot.bytesSent) + " / " + formatBytes(snapshot.totalBytes) + "。要单独追踪一次安装，请从 App 重新打开安装页。";
    }
  };
  const refresh = async () => {
    if (timer) { window.clearTimeout(timer); timer = 0; }
    try {
      const response = await fetch(statusUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("状态暂不可读");
      render(await response.json());
    } catch {
      status.textContent = "暂时无法读取服务端传输状态；请以 iOS 系统安装提示为准。";
    }
    if (polling && Date.now() < deadline) timer = window.setTimeout(refresh, 1000);
    else if (polling) {
      polling = false;
      status.textContent = requestObserved
        ? status.textContent + " 自动刷新已暂停；返回本页可重新查询。"
        : "仍未观察到 IPA 请求。请确认已在 iOS 系统提示中点“安装”。";
    }
  };
  const resumePolling = () => {
    if (installRequested && !polling) { polling = true; deadline = Date.now() + 300000; }
    void refresh();
  };
  install.addEventListener("click", () => {
    installRequested = true;
    polling = true;
    deadline = Date.now() + 300000;
    status.textContent = "已打开 iOS 安装器，等待系统请求 " + formatBytes(totalBytes) + " IPA…";
    void refresh();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resumePolling(); });
  window.addEventListener("pageshow", resumePolling);
  void refresh();
})();</script></body></html>`;
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size || (!match[1] && Number(match[2]) === 0)) return false;
  end = Math.min(end, size - 1);
  return { start, end };
}

export function createOtaHandler(directory, serviceId, now = Date.now) {
  const transfers = new Map();
  return (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
    const requestTime = now();
    for (const [token, transfer] of transfers) if (transfer.expires <= requestTime) transfers.delete(token);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/health") {
      const body = JSON.stringify({ service: serviceId });
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body); return;
    }
    let settings = null;
    try { settings = JSON.parse(readFileSync(servicePaths(directory).settings, "utf8")); } catch {}
    const basePath = settings?.base ? new URL(normalizeOtaBaseUrl(settings.base)).pathname.replace(/\/+$/, "") : "";
    if (pathname === "/" || basePath && (pathname === basePath || pathname === basePath + "/")) {
      const session = requestPortalSession(request, directory, serviceId, now());
      if (!session || !settings?.base || session.base !== normalizeOtaBaseUrl(settings.base)) {
        response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : "请先在 Mac 上运行 OTA 命令，使用生成的安装链接授权此浏览器。"); return;
      }
      try {
        const next = createInstallLink(directory, settings.base, now());
        const token = new URL(next.url).pathname.split("/").filter(Boolean).at(-1);
        const nonce = randomBytes(18).toString("base64");
        const body = otaPage(settings.base, token, next.metadata, nonce);
        response.setHeader("Content-Security-Policy", otaPageContentSecurityPolicy(nonce));
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
        response.end(request.method === "HEAD" ? undefined : body);
      } catch {
        response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : "暂无有效的安装包，请在 Mac 上重新生成签名包。");
      }
      return;
    }
    const match = /^\/(?:.*\/)?([A-Za-z0-9_-]{43})\/(|manifest\.plist|download-status\.json|[a-f0-9]{64}\.ipa)$/.exec(pathname);
    const ticket = match ? resolveInstallTicket(directory, match[1], requestTime) : null;
    if (!ticket) { response.writeHead(404); response.end(); return; }
    const part = match[2];
    if (!part || part === "manifest.plist") {
      const nonce = !part ? randomBytes(18).toString("base64") : null;
      const body = part ? otaManifest(ticket.base, ticket.token, ticket.metadata) : otaPage(ticket.base, ticket.token, ticket.metadata, nonce);
      if (nonce) response.setHeader("Content-Security-Policy", otaPageContentSecurityPolicy(nonce));
      const headers = { "Content-Type": part ? "text/xml; charset=utf-8" : "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) };
      if (!part && request.method === "GET" && !requestPortalSession(request, directory, serviceId, now())) {
        try { headers["Set-Cookie"] = issuePortalSession(directory, serviceId, ticket.base, now()); }
        catch { response.writeHead(503); response.end(); return; }
      }
      response.writeHead(200, headers);
      response.end(request.method === "HEAD" ? undefined : body); return;
    }
    if (part === "download-status.json") {
      const transfer = transfers.get(ticket.token);
      const bytesSent = byteRangeCoverage(transfer?.sentRanges ?? []);
      const completedBytes = byteRangeCoverage(transfer?.completedRanges ?? []);
      const snapshot = {
        state: !transfer ? "waiting" : transfer.activeRequests > 0 ? "downloading" : completedBytes >= ticket.metadata.size ? "sent" : "interrupted",
        requestCount: transfer?.requestCount ?? 0,
        activeRequests: transfer?.activeRequests ?? 0,
        bytesSent,
        completedBytes,
        totalBytes: ticket.metadata.size,
        lastRequestAt: transfer?.lastRequestAt ?? null,
      };
      const body = JSON.stringify(snapshot);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body); return;
    }
    if (part !== `${ticket.metadata.revision}.ipa`) { response.writeHead(404); response.end(); return; }
    const range = parseRange(request.headers.range, ticket.metadata.size);
    if (range === false) { response.writeHead(416, { "Content-Range": `bytes */${ticket.metadata.size}` }); response.end(); return; }
    const headers = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Content-Length": range ? range.end - range.start + 1 : ticket.metadata.size };
    if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${ticket.metadata.size}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD") { response.end(); return; }
    let transfer = transfers.get(ticket.token);
    if (!transfer || transfer.expires <= now()) {
      while (transfers.size >= 200) transfers.delete(transfers.keys().next().value);
      transfer = { expires: ticket.expires, requestCount: 0, activeRequests: 0, lastRequestAt: null, sentRanges: [], completedRanges: [] };
      transfers.set(ticket.token, transfer);
    }
    transfer.requestCount++;
    transfer.activeRequests++;
    transfer.lastRequestAt = requestTime;
    const requestStart = range?.start ?? 0;
    const requestEnd = range?.end ?? ticket.metadata.size - 1;
    let nextOffset = requestStart;
    let responseFinished = false;
    const stream = createReadStream(ticket.path, range || undefined);
    const authorizationCheck = setInterval(() => {
      if (!resolveInstallTicket(directory, ticket.token, now())) response.destroy();
    }, 1_000);
    authorizationCheck.unref?.();
    stream.once("error", (error) => response.destroy(error));
    stream.once("end", () => clearInterval(authorizationCheck));
    stream.on("data", (chunk) => {
      const end = Math.min(requestEnd, nextOffset + chunk.length - 1);
      if (end >= nextOffset) transfer.sentRanges = mergeByteRange(transfer.sentRanges, nextOffset, end);
      nextOffset = end + 1;
    });
    response.once("finish", () => {
      responseFinished = true;
      transfer.activeRequests = Math.max(0, transfer.activeRequests - 1);
      if (nextOffset > requestStart) transfer.completedRanges = mergeByteRange(transfer.completedRanges, requestStart, Math.min(requestEnd, nextOffset - 1));
    });
    response.once("close", () => {
      clearInterval(authorizationCheck);
      stream.destroy();
      if (!responseFinished) transfer.activeRequests = Math.max(0, transfer.activeRequests - 1);
    });
    stream.pipe(response);
  };
}

export function servicePaths(directory, home = homedir()) {
  const id = hash(resolve(directory)).slice(0, 16);
  const label = `com.local.feishu-codex-bridge.ios-ota.${id}`;
  return { label, plist: join(home, "Library/LaunchAgents", `${label}.plist`),
    refreshLabel: `${label}.refresh`, refreshPlist: join(home, "Library/LaunchAgents", `${label}.refresh.plist`),
    tlsRoot: join(home, "Library/Application Support/Feishu Codex Bridge/ios-ota-tls", id),
    stdout: join(directory, "server.log"), stderr: join(directory, "server-error.log"),
    refreshLog: join(directory, "refresh.log"), refreshError: join(directory, "refresh-error.log"), settings: join(directory, "service.json") };
}
export function serverAgentPlist(paths, directory, port, executable = process.execPath, direct = null) {
  const args = [executable, fileURLToPath(import.meta.url), "--serve-internal", "--directory", directory, "--port", String(port)];
  if (direct) args.push("--vpn-ip", direct.ip, "--tls-cert", direct.cert, "--tls-key", direct.key);
  return plist(`${stringEntry("Label", paths.label)}<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>` +
    `${stringEntry("WorkingDirectory", root)}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>` +
    `${stringEntry("StandardOutPath", paths.stdout)}${stringEntry("StandardErrorPath", paths.stderr)}`);
}

export function refreshAgentPlist(paths, directory, executable = process.execPath) {
  const args = [executable, fileURLToPath(import.meta.url), "--refresh-run", "--directory", directory];
  const path = [dirname(executable), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"].join(":");
  const environment = stringEntry("PATH", path) + (process.env.DEVELOPER_DIR ? stringEntry("DEVELOPER_DIR", process.env.DEVELOPER_DIR) : "");
  return plist(`${stringEntry("Label", paths.refreshLabel)}<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>` +
    `${stringEntry("WorkingDirectory", root)}<key>EnvironmentVariables</key><dict>${environment}</dict>` +
    `<key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>` +
    `${stringEntry("StandardOutPath", paths.refreshLog)}${stringEntry("StandardErrorPath", paths.refreshError)}`);
}

export async function refreshOtaRelease(directory, options = {}) {
  const now = options.now ?? Date.now();
  const { metadata, path } = readLatest(directory);
  if (!renewalDue({ effectiveExpiry: metadata.expiresAt }, now)) return null;
  const staging = mkdtempSync(join(directory, ".ota-refresh-"));
  try {
    const unpack = options.unpack ?? ((source, destination) => command("/usr/bin/ditto", ["-x", "-k", source, destination]));
    const publish = options.publish ?? createOtaRelease;
    await unpack(path, staging);
    return await publish(join(staging, "Payload/App.app"), directory, null, now);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function discoverVpnAddresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.entries(interfaces).flatMap(([name, entries]) => /^(utun|tun|ppp|ipsec)/i.test(name)
    ? (entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address) : []))];
}

function assignedIPv4(ip) {
  return Object.values(networkInterfaces()).some((entries) => (entries ?? []).some((entry) => entry.family === "IPv4" && entry.address === ip));
}

function verifyCertificate(certPath, keyPath, ip, caPath = null) {
  const certificate = new X509Certificate(readFileSync(certPath));
  const publicKey = createPublicKey(readFileSync(keyPath)).export({ type: "spki", format: "der" });
  const actualKey = certificate.publicKey.export({ type: "spki", format: "der" });
  if (!publicKey.equals(actualKey) || !certificate.checkIP(ip) || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error(`TLS 证书与私钥、VPN IP ${ip} 或有效期不匹配。`);
  }
  if (caPath && !certificate.verify(new X509Certificate(readFileSync(caPath)).publicKey)) throw new Error("TLS 证书不是由本地 OTA 根证书签发的。");
  createSecureContext({ key: readFileSync(keyPath), cert: readFileSync(certPath), minVersion: "TLSv1.2" });
  return certificate;
}

export function ensureVpnCertificate(directory, ip) {
  if (isIP(ip) !== 4) throw new Error("VPN IP 必须是 IPv4 地址。");
  const tls = join(directory, "tls");
  mkdirSync(tls, { recursive: true, mode: 0o700 });
  const caKey = join(tls, "root-ca.key"), caPem = join(tls, "root-ca.pem"), caCer = join(tls, "root-ca.cer");
  const cert = join(tls, "server.pem"), key = join(tls, "server.key");
  const hasKey = existsSync(caKey), hasCa = existsSync(caPem);
  if (hasKey !== hasCa) throw new Error("本地 OTA 根证书不完整；为避免更换已信任的根证书，请先检查 tls 目录。");
  const previousUmask = process.umask(0o077);
  const staged = mkdtempSync(join(tls, ".generate-"));
  try {
    if (!hasKey) {
      const stagedKey = join(staged, "root.key"), stagedCa = join(staged, "root.pem");
      command("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650",
        "-subj", "/CN=Bridge iOS OTA Local CA", "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", stagedKey, "-out", stagedCa]);
      const ca = new X509Certificate(readFileSync(stagedCa));
      if (!ca.ca || !ca.verify(ca.publicKey)) throw new Error("无法验证生成的 OTA 根证书。");
      renameSync(stagedKey, caKey); renameSync(stagedCa, caPem);
    }
    const ca = new X509Certificate(readFileSync(caPem));
    const caPub = ca.publicKey.export({ type: "spki", format: "der" });
    if (!ca.ca || !ca.verify(ca.publicKey) || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now() ||
        !caPub.equals(createPublicKey(readFileSync(caKey)).export({ type: "spki", format: "der" }))) {
      throw new Error("本地 OTA 根证书已过期或与私钥不匹配。");
    }
    if ((statSync(caKey).mode & 0o077) !== 0) throw new Error("OTA 根证书私钥权限过宽，请将其设为仅当前用户可读写。");
    if (!existsSync(caCer)) command("/usr/bin/openssl", ["x509", "-in", caPem, "-outform", "DER", "-out", caCer]);
    const cer = new X509Certificate(readFileSync(caCer));
    if (cer.fingerprint256 !== ca.fingerprint256) throw new Error("导出的根证书与本地根证书不一致。");
    let valid = false;
    try { valid = Date.parse(verifyCertificate(cert, key, ip, caPem).validTo) > Date.now() + 24 * 60 * 60 * 1000; } catch {}
    if (!valid) {
      const stagedKey = join(staged, "server.key"), csr = join(staged, "server.csr"), stagedCert = join(staged, "server.pem"), config = join(staged, "extensions.cnf");
      writeFileSync(config, `[server]\nsubjectAltName=IP:${ip}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
      command("/usr/bin/openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=Bridge iOS OTA", "-keyout", stagedKey, "-out", csr]);
      command("/usr/bin/openssl", ["x509", "-req", "-in", csr, "-CA", caPem, "-CAkey", caKey, "-set_serial", `0x${randomBytes(16).toString("hex")}`,
        "-days", "365", "-sha256", "-extfile", config, "-extensions", "server", "-out", stagedCert]);
      verifyCertificate(stagedCert, stagedKey, ip, caPem);
      renameSync(stagedKey, key); renameSync(stagedCert, cert);
    }
    return { ip, cert, key, ca: caPem, certificateForPhone: caCer, fingerprint: ca.fingerprint256 };
  } finally {
    process.umask(previousUmask);
    rmSync(staged, { recursive: true, force: true });
  }
}

function launchctl(args) { return spawnSync("/bin/launchctl", args, { encoding: "utf8" }); }
function readTailscale() {
  let output;
  try { output = command("tailscale", ["status", "--json"]); }
  catch (error) { throw new Error(`Tailscale 状态不可用：${error instanceof Error ? error.message : String(error)}`); }
  const status = JSON.parse(output);
  if (status.BackendState !== "Running" || !status.Self?.Online) throw new Error("Tailscale 当前未连接；请先在 Mac 和 iPhone 上连接同一私有网络。");
  const domain = String(status.Self.DNSName ?? "").replace(/\.$/, "");
  if (!domain || !(status.CertDomains ?? []).includes(domain)) throw new Error("Tailscale 尚未为本机启用 HTTPS 证书；请检查 Tailnet 的 HTTPS 设置。");
  return domain;
}
export function assertTailscalePortAvailable(status, httpsPort, localPort) {
  const tcp = status?.TCP?.[String(httpsPort)];
  const entries = Object.entries(status?.Web ?? {}).filter(([key]) => key.endsWith(`:${httpsPort}`));
  const publicFunnel = Object.entries(status?.AllowFunnel ?? {}).some(([key, enabled]) => key.endsWith(`:${httpsPort}`) && enabled === true);
  if (!tcp && entries.length === 0 && !publicFunnel) return;
  if (entries.length !== 1) throw new Error(`Tailscale 的 ${httpsPort} 端口已有配置，未覆盖。`);
  const handlers = Object.entries(entries[0][1]?.Handlers ?? {});
  if (handlers.length !== 1 || handlers[0][0] !== "/" || handlers[0][1]?.Proxy !== `http://127.0.0.1:${localPort}` || tcp?.HTTPS !== true || tcp?.Funnel || publicFunnel) {
    throw new Error(`Tailscale 的 ${httpsPort} 端口已被其他服务使用，未覆盖。`);
  }
}
async function serviceHealth(port, label, direct = null) {
  if (!direct) {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) });
    return response.ok && (await response.json()).service === label;
  }
  const expected = new X509Certificate(readFileSync(direct.cert)).fingerprint256;
  return await new Promise((resolve, reject) => {
    // This local probe pins the configured leaf certificate. The iPhone must
    // independently trust its CA; a successful probe does not establish that.
    const req = httpsRequest({ host: direct.ip, port, path: "/health", method: "GET", rejectUnauthorized: false, timeout: 600 }, (response) => {
      const peer = response.socket.getPeerCertificate();
      if (!peer.raw || new X509Certificate(peer.raw).fingerprint256 !== expected) { response.resume(); reject(new Error("OTA 端口的 TLS 证书与预期不一致。")); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { try { resolve(response.statusCode === 200 && JSON.parse(body).service === label); } catch { resolve(false); } });
    });
    req.on("timeout", () => req.destroy(new Error("OTA 服务连接超时。")));
    req.on("error", reject); req.end();
  });
}
async function waitForService(port, label, direct = null) {
  for (let i = 0; i < 30; i++) {
    try {
      if (await serviceHealth(port, label, direct)) return true;
      throw new Error(`本机 ${port} 端口属于其他服务。`);
    } catch (error) {
      if (error instanceof Error && (error.message.includes("属于其他服务") || error.message.includes("证书与预期不一致"))) throw error;
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  return false;
}

function enableRefreshAgent(paths, directory) {
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${paths.refreshLabel}`;
  const content = refreshAgentPlist(paths, directory);
  if (launchctl(["print", service]).status === 0) {
    if (!existsSync(paths.refreshPlist) || readFileSync(paths.refreshPlist, "utf8") !== content) {
      throw new Error("OTA 续签任务配置已变化，请先停止 OTA 服务再重新启动。");
    }
    return;
  }
  const staged = `${paths.refreshPlist}.${randomUUID()}.tmp`;
  writeFileSync(staged, content, { mode: 0o600 });
  renameSync(staged, paths.refreshPlist);
  const started = launchctl(["bootstrap", domain, paths.refreshPlist]);
  if (started.status !== 0) throw new Error(`无法启用 OTA 包自动续签：${started.stderr?.trim()}`);
}

async function startService(options) {
  if (process.platform !== "darwin") throw new Error("OTA 后台服务需要 macOS。");
  const paths = servicePaths(options.directory);
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${paths.label}`;
  let base = options.baseUrl;
  let configureTailscale = false;
  let direct = null;
  if (options.tailscale) {
    const host = readTailscale();
    base = `https://${host}:${options.httpsPort}`;
    const status = JSON.parse(command("tailscale", ["serve", "status", "--json"]) || "{}");
    assertTailscalePortAvailable(status, options.httpsPort, options.port);
    configureTailscale = true;
  } else if (!base) {
    const ips = discoverVpnAddresses();
    const ip = options.vpnIp || (ips.length === 1 ? ips[0] : null);
    if (!ip) throw new Error(ips.length ? "发现多个 VPN IPv4，请用 --vpn-ip 指定 Mac 的地址。" : "没有发现 VPN IPv4，请连接 VPN 后运行，或使用 --vpn-ip 指定本机地址。");
    if (!assignedIPv4(ip)) throw new Error(`VPN IP ${ip} 不属于本机活动网卡；未启动服务。`);
    if (options.tlsCert) {
      verifyCertificate(options.tlsCert, options.tlsKey, ip);
      direct = { ip, cert: options.tlsCert, key: options.tlsKey };
    } else direct = ensureVpnCertificate(paths.tlsRoot, ip);
    base = `https://${ip}:${options.port}`;
  }
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.plist), { recursive: true, mode: 0o700 });
  const sourceRevision = hash(Buffer.concat([readFileSync(fileURLToPath(import.meta.url)), readFileSync(join(root, "scripts/ios-auto-renew.mjs"))]));
  const certFingerprint = direct ? new X509Certificate(readFileSync(direct.cert)).fingerprint256 : null;
  let existing = null;
  try { existing = JSON.parse(readFileSync(paths.settings, "utf8")); } catch {}
  let running = launchctl(["print", service]).status === 0;
  if (running) {
    if (!existing || existing.port !== options.port || existing.base !== base ||
        Boolean(existing.direct) !== Boolean(direct) || existing.direct?.cert !== direct?.cert || existing.direct?.key !== direct?.key) {
      throw new Error("OTA 服务已使用其他地址或证书运行；请先停止该服务，再重新启动。");
    }
    if (direct && existing.certFingerprint && existing.certFingerprint !== certFingerprint) {
      throw new Error("OTA TLS 证书已更新，请先停止服务，再重新启动以加载新证书。");
    }
    if (!await waitForService(options.port, paths.label, direct)) throw new Error("已登记的 OTA 服务没有响应，请检查其状态，不会接管端口。");
    if (existing.sourceRevision !== sourceRevision) {
      const stopped = launchctl(["bootout", service]);
      if (stopped.status !== 0) throw new Error(`无法重启 OTA 服务：${stopped.stderr?.trim()}`);
      running = false;
      for (let i = 0; i < 30; i++) {
        if (spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${options.port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).status !== 0) break;
        await new Promise((done) => setTimeout(done, 200));
      }
    }
  }
  if (!running) {
    const occupied = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${options.port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (occupied.status === 0) throw new Error(`本机 ${options.port} 端口已有服务，未覆盖。`);
    const staged = `${paths.plist}.${randomUUID()}.tmp`;
    writeFileSync(staged, serverAgentPlist(paths, options.directory, options.port, process.execPath, direct), { mode: 0o600 });
    renameSync(staged, paths.plist);
    const launched = launchctl(["bootstrap", domain, paths.plist]);
    if (launched.status !== 0) throw new Error(`无法启动 OTA 服务：${launched.stderr?.trim()}`);
    if (!await waitForService(options.port, paths.label, direct)) throw new Error(`OTA 服务没有启动，请查看 ${paths.stderr}`);
  }
  if (configureTailscale) command("tailscale", ["serve", "--bg", `--https=${options.httpsPort}`, `http://127.0.0.1:${options.port}`]);
  atomicJson(paths.settings, { schema: 1, base, port: options.port, httpsPort: options.httpsPort, tailscale: configureTailscale,
    sourceRevision, certFingerprint, direct: direct ? { ip: direct.ip, cert: direct.cert, key: direct.key } : null });
  enableRefreshAgent(paths, options.directory);
  if (direct?.certificateForPhone) {
    console.log(`首次使用请通过 AirDrop 等可信方式将根证书发送到 iPhone：${direct.certificateForPhone}`);
    console.log(`根证书 SHA-256：${direct.fingerprint}`);
    console.log("先在 iPhone 的 设置 → 通用 → VPN 与设备管理 中安装描述文件，再到 设置 → 通用 → 关于本机 → 证书信任设置 启用完全信任。");
    console.log("启用后此根证书受到 iPhone 全局信任，请勿分享 Mac 上的根证书私钥；也可改用已有可信 TLS 证书。");
  }
  return base;
}

function stopService(options) {
  const paths = servicePaths(options.directory);
  let settings = null, tailscaleError = null;
  try { settings = JSON.parse(readFileSync(paths.settings, "utf8")); } catch {}
  if (settings?.tailscale) {
    try {
      const status = JSON.parse(command("tailscale", ["serve", "status", "--json"]) || "{}");
      assertTailscalePortAvailable(status, settings.httpsPort, settings.port);
      if (status?.TCP?.[String(settings.httpsPort)] || Object.keys(status?.Web ?? {}).some((key) => key.endsWith(`:${settings.httpsPort}`))) {
        command("tailscale", ["serve", `--https=${settings.httpsPort}`, "off"]);
      }
    } catch (error) { tailscaleError = error; }
  }
  for (const label of [paths.refreshLabel, paths.label]) {
    const service = `gui/${process.getuid()}/${label}`;
    if (launchctl(["print", service]).status === 0) {
      const stopped = launchctl(["bootout", service]);
      if (stopped.status !== 0) throw new Error(`无法停止 OTA 服务：${stopped.stderr?.trim()}`);
    }
  }
  if (existsSync(paths.refreshPlist)) unlinkSync(paths.refreshPlist);
  if (existsSync(paths.plist)) unlinkSync(paths.plist);
  if (tailscaleError) throw new Error(`本机 OTA 服务已停止，但无法确认 Tailscale 路由已移除：${tailscaleError instanceof Error ? tailscaleError.message : String(tailscaleError)}；配置保留以便重试。`);
  if (existsSync(paths.settings)) unlinkSync(paths.settings);
}
async function printInstallLink(link) {
  console.log(`在 iPhone 的 Safari 打开：\n${link.url}\n链接有效至：${new Date(link.expiresAt).toLocaleString()}`);
  try {
    const qr = await import("qrcode-terminal");
    (qr.default ?? qr).generate(link.url, { small: true }, (output) => console.log(output));
  } catch { /* The URL remains usable without terminal QR support. */ }
}
function showHelp() {
  console.log(`用法：bun run mobile:ios:ota -- [选项]
  默认构建签名 App、生成 OTA 包并启动私有 HTTPS 安装服务。
  --app <App.app>                使用已有签名 App，跳过构建
  --vpn                          默认构建改为 AppVpn（需要 Network Extension 权限的付费团队）
  --device <UDID>                检查描述文件包含该 iPhone/iPad
  --build-number <正整数>        覆盖本次 OTA 构建号；默认自动递增
  --allow-provisioning-updates   允许 Xcode 更新签名配置（默认）
  --no-provisioning-updates      构建时只使用现有签名配置
  --no-serve                     只生成安装包，不启动服务或修改 Tailscale
  --vpn-ip <IPv4>                使用 Mac 的 VPN 地址直连；默认自动发现唯一 VPN 地址
  --tls-cert <文件>              VPN IP 的 HTTPS 证书；与 --tls-key 同时指定
  --tls-key <文件>               VPN IP 的 HTTPS 私钥；省略时生成本地根证书
  --tailscale                    使用 Tailscale 私有 HTTPS
  --base-url <https://...>       使用已有可信 HTTPS 反向代理
  --port <端口>                  本机 OTA 服务端口（默认 18731）
  --https-port <端口>            Tailscale HTTPS 端口（默认 18443）
  --check                        只检查安装包和网络状态
  --start                        启动 OTA 服务并输出安装链接
  --link                         为已发布版本生成新的短时安装链接
  --revoke-sessions              撤销所有 OTA 浏览器授权及未过期链接
  --stop                         停止本 OTA 服务及其 Tailscale 端口
  --help                         显示帮助`);
}

async function main() {
  const options = parseOtaOptions(process.argv.slice(2));
  if (options.help) { showHelp(); return; }
  const paths = servicePaths(options.directory);
  if (["publish", "refresh-run", "start", "stop"].includes(options.mode) && !process.env.BRIDGE_IOS_SIGNING_LOCK_HELD) {
    const shared = dirname(renewalPaths(root).state);
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    // The existing device renewal can spend time discovering an offline phone.
    // Give the hourly OTA refresh time to follow it instead of losing every run.
    const lockWait = options.mode === "refresh-run" ? "300" : "5";
    const result = spawnSync("/usr/bin/lockf", ["-k", "-t", lockWait, join(shared, "signing.lock"), process.execPath,
      fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: root, stdio: "inherit", env: { ...process.env, BRIDGE_IOS_SIGNING_LOCK_HELD: "1" },
    });
    if (result.error || result.status !== 0) {
      if (result.status === 75) {
        console.error("另一个 Bridge iOS 构建或续签正在使用签名配置，请稍后重试。");
        if (options.mode === "refresh-run") notifyRenewalIssue("OTA 签名刷新等待其他 iOS 构建，请查看 OTA 日志。");
      }
      if (result.error) throw new Error(`无法启动 iOS 签名锁：${result.error.message}`);
      process.exitCode = result.status ?? 1;
    }
    return;
  }
  if (options.mode === "serve-internal") {
    if (options.vpnIp && !options.tlsCert) throw new Error("VPN 直连服务缺少 TLS 证书或私钥。");
    const handler = createOtaHandler(options.directory, paths.label);
    const direct = options.vpnIp && options.tlsCert ? { ip: options.vpnIp, cert: options.tlsCert, key: options.tlsKey } : null;
    if (direct) verifyCertificate(direct.cert, direct.key, direct.ip);
    const server = direct ? createHttpsServer({ key: readFileSync(direct.key), cert: readFileSync(direct.cert), minVersion: "TLSv1.2" }, handler)
      : createServer(handler);
    server.on("error", (error) => { console.error(`OTA 服务启动失败：${error.message}`); process.exitCode = 1; });
    server.listen(options.port, direct ? direct.ip : "127.0.0.1");
    return;
  }
  if (options.mode === "refresh-run") {
    try {
      const refreshed = await refreshOtaRelease(options.directory);
      if (refreshed) {
        console.log(`OTA 安装包签名已刷新，有效至 ${new Date(refreshed.expiresAt).toLocaleString()}；需要在 iPhone 安装后才会生效。`);
        notifyRenewalIssue("OTA 安装包已重新签名，请在 iPhone 打开安装页并确认安装。");
      } else console.log("OTA 安装包尚未进入续签窗口。");
    } catch (error) {
      notifyRenewalIssue("OTA 签名刷新失败，请查看 Mac 上的 OTA 续签日志。");
      throw error;
    }
    return;
  }
  if (options.mode === "check") {
    try { const { metadata } = readLatest(options.directory); console.log(`安装包：${metadata.version} (${metadata.build})；签名到期 ${new Date(metadata.expiresAt).toLocaleString()}。`); }
    catch { console.log("尚未生成 OTA 安装包。"); }
    const ips = discoverVpnAddresses();
    console.log(ips.length ? `本机 VPN IPv4：${ips.join("、")}` : "未发现 VPN IPv4。");
    if (options.tailscale) {
      try { console.log(`Tailscale：已连接，HTTPS 主机 ${readTailscale()}。`); }
      catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
    }
    return;
  }
  if (options.mode === "stop") { stopService(options); console.log("OTA 服务已停止，安装包保留。"); return; }
  if (options.mode === "revoke-sessions") { console.log(`已撤销 ${revokePortalSessions(options.directory)} 个 OTA 浏览器授权和安装链接。`); return; }
  if (options.mode === "link") {
    let settings = null;
    try { settings = JSON.parse(readFileSync(paths.settings, "utf8")); } catch {}
    const base = options.baseUrl || settings?.base;
    if (!base) throw new Error("尚未配置 OTA HTTPS 地址，请先启动服务或指定 --base-url。");
    const link = createInstallLink(options.directory, base);
    await printInstallLink(link); return;
  }
  if (options.mode === "publish") {
    let app = options.app;
    if (!app) {
      const buildNumber = options.buildNumber ?? nextOtaBuildNumber(options.directory, root);
      if (options.buildNumber !== null) assertOtaBuildNumberAdvances(options.directory, buildNumber);
      const args = [join(root, "scripts/ios-device.mjs"), "--build-only", "--build-number", String(buildNumber)];
      if (options.vpn) args.push("--vpn");
      if (options.device) args.push("--device", options.device);
      if (options.allowProvisioningUpdates) args.push("--allow-provisioning-updates");
      command(process.execPath, args, { cwd: root, stdio: "inherit" });
      const buildDir = resolve(process.env.BRIDGE_IOS_DERIVED_DATA || join(root, "ios/App/build/DeviceDerivedData"));
      const configuration = options.vpn ? "Debug" : "PersonalDebug";
      const product = options.vpn ? "AppVpn.app" : "App.app";
      app = join(buildDir, `Build/Products/${configuration}-iphoneos`, product);
    }
    assertOtaBuildAdvances(options.directory, app);
    const release = await createOtaRelease(app, options.directory, options.device);
    console.log(`已生成 Bridge ${release.version} (${release.build}) OTA 安装包，签名到期 ${new Date(release.expiresAt).toLocaleString()}。`);
    if (options.noServe) { console.log(`安装包目录：${options.directory}；未启动服务。`); return; }
  }
  readLatest(options.directory);
  const base = await startService(options);
  const link = createInstallLink(options.directory, base);
  await printInstallLink(link);
  console.log(`首次打开安装链接后，可将 ${base}/ 添加到 iPhone 主屏幕，30 天内直接打开最新安装包。`);
  console.log("链接仅证明可请求安装；请在 iPhone 上确认并核对安装结果。");
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(`iOS OTA 未完成：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
