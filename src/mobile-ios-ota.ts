import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

interface Release { revision: string; version: string; build: string; size: number; expiresAt: string; publishedAt: string }
interface Settings { base: string; port: number; direct?: { ip: string; cert: string } | null }
type PublishState = { state: "idle" | "running" | "succeeded" | "failed"; message?: string };

// The installed single-binary Bridge may run outside the checkout. Reuse an
// unambiguous user-owned OTA LaunchAgent instead of assuming its cwd is source.
function discoverOtaAgent(): { directory: string; source: string; bun: string } | null {
  if (process.platform !== "darwin") return null;
  try {
    const folder = join(homedir(), "Library/LaunchAgents");
    const entries = readdirSync(folder).filter((name) => /^com\.local\.feishu-codex-bridge\.ios-ota\.[a-f0-9]{16}\.plist$/.test(name));
    const matches: Array<{ directory: string; source: string; bun: string }> = [];
    for (const entry of entries) {
      const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(folder, entry)], { encoding: "utf8" });
      if (result.status !== 0) continue;
      const value = JSON.parse(result.stdout) as { Label?: string; ProgramArguments?: string[] };
      const args = value.ProgramArguments ?? [], index = args.indexOf("--directory"), script = args[1];
      if (!args.includes("--serve-internal") || index < 0 || !args[index + 1] || !script || basename(script) !== "ios-ota.mjs") continue;
      const directory = resolve(args[index + 1]);
      const label = "com.local.feishu-codex-bridge.ios-ota." + createHash("sha256").update(directory).digest("hex").slice(0, 16);
      if (value.Label !== label || entry !== `${label}.plist` || !existsSync(join(directory, "service.json"))) continue;
      matches.push({ directory, source: dirname(dirname(script)), bun: args[0] ?? "" });
    }
    return matches.length === 1 ? matches[0]! : null;
  } catch { return null; }
}

/** Bridges authenticated clients to the existing, separately running OTA service. */
export class MobileIosOta {
  private readonly directory: string;
  private readonly source: string;
  private readonly agentBun: string;
  private publishState: PublishState = { state: "idle" };
  private child: ChildProcess | null = null;

  constructor(options: { directory?: string; source?: string } = {}) {
    const explicit = options.directory ?? process.env.FEISHU_CODEX_BRIDGE_IOS_OTA_DIR?.trim();
    const local = join(process.cwd(), "ios/App/build/ios-ota");
    const discovered = !explicit && !existsSync(join(local, "service.json")) ? discoverOtaAgent() : null;
    this.directory = resolve(explicit || discovered?.directory || local);
    this.source = resolve(options.source ?? process.env.FEISHU_CODEX_BRIDGE_IOS_OTA_SOURCE?.trim() ?? discovered?.source ?? process.cwd());
    this.agentBun = discovered?.bun ?? "";
  }

  private settings(): Settings {
    const data = JSON.parse(readFileSync(join(this.directory, "service.json"), "utf8")) as Settings;
    const url = new URL(data.base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw new Error("OTA 服务配置无效。");
    return { ...data, base: url.href.replace(/\/+$/, "") };
  }

  private release(): Release {
    const latest = JSON.parse(readFileSync(join(this.directory, "latest.json"), "utf8")) as { revision?: string };
    const revision = latest.revision ?? "";
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("OTA 安装包元数据无效。");
    const data = JSON.parse(readFileSync(join(this.directory, "releases", `${revision}.json`), "utf8")) as Release & { bundleId?: string; schema?: number };
    const file = lstatSync(join(this.directory, "releases", `${revision}.ipa`));
    if (data.schema !== 1 || data.bundleId !== "dev.feishu.codex.bridge" || data.revision !== revision || !file.isFile()
      || !Number.isSafeInteger(data.size) || data.size !== file.size || !data.version || !data.build
      || !Number.isFinite(Date.parse(data.expiresAt)) || !Number.isFinite(Date.parse(data.publishedAt))) throw new Error("OTA 安装包元数据无效。");
    return { revision, version: data.version, build: data.build, size: data.size, expiresAt: data.expiresAt, publishedAt: data.publishedAt };
  }

  private async healthy(settings: Settings): Promise<boolean> {
    const label = "com.local.feishu-codex-bridge.ios-ota." + createHash("sha256").update(this.directory).digest("hex").slice(0, 16);
    try {
      const direct = settings.direct;
      const expected = direct ? new X509Certificate(readFileSync(direct.cert)).fingerprint256 : null;
      return await new Promise<boolean>((done) => {
        const options = { hostname: direct?.ip ?? "127.0.0.1", port: settings.port, path: "/health", method: "GET", timeout: 1200,
          ...(direct ? { rejectUnauthorized: false } : {}) };
        const req = (direct ? httpsRequest : httpRequest)(options, (res) => {
          if (direct) {
            const socket = res.socket as import("node:tls").TLSSocket;
            const peer = socket.getPeerCertificate();
            if (!peer.raw || new X509Certificate(peer.raw).fingerprint256 !== expected) { res.resume(); done(false); return; }
          }
          let body = ""; res.setEncoding("utf8"); res.on("data", (chunk: string) => { body += chunk; });
          res.on("end", () => { try { done(res.statusCode === 200 && JSON.parse(body).service === label); } catch { done(false); } });
        });
        req.on("timeout", () => req.destroy()); req.on("error", () => done(false)); req.end();
      });
    } catch { return false; }
  }

  async status(): Promise<{ available: boolean; serviceRunning: boolean; release: Release | null; publish: PublishState }> {
    let release: Release | null = null, serviceRunning = false;
    try { release = this.release(); } catch { /* No package has been published yet. */ }
    try { serviceRunning = await this.healthy(this.settings()); } catch { /* Not configured. */ }
    return { available: Boolean(release && Date.parse(release.expiresAt) > Date.now()), serviceRunning, release, publish: this.publishState };
  }

  async createLink(): Promise<{ url: string; expiresAt: string }> {
    const settings = this.settings(), release = this.release(), now = Date.now();
    if (!await this.healthy(settings)) throw new Error("OTA 服务未运行，请先在 Mac 启动 OTA 服务。");
    const expires = Math.min(now + 30 * 60_000, Date.parse(release.expiresAt));
    if (expires <= now) throw new Error("安装包签名已过期，请重新构建或续签。");
    const directory = join(this.directory, "links");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let active = 0;
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      try { if (JSON.parse(readFileSync(path, "utf8")).expires <= now) unlinkSync(path); else active++; } catch { active++; }
    }
    if (active >= 200) throw new Error("安装链接过多，请稍后重试。");
    const token = randomBytes(32).toString("base64url");
    const path = join(directory, createHash("sha256").update(token).digest("hex") + ".json");
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify({ schema: 1, revision: release.revision, base: settings.base, expires }), { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
    finally { try { unlinkSync(temp); } catch { /* renamed */ } }
    return { url: `${settings.base}/${token}/`, expiresAt: new Date(expires).toISOString() };
  }

  startPublish(): PublishState {
    if (this.child) throw new Error("iOS 安装包正在构建，请稍后再试。");
    const script = join(this.source, "scripts", "ios-ota.mjs");
    if (!existsSync(script)) throw new Error("找不到 iOS OTA 源码，请在 Mac 上配置源码目录。");
    const fromPath = (process.env.PATH ?? "").split(delimiter).map((part) => join(part, "bun")).find((path) => existsSync(path));
    const bun = process.env.FEISHU_CODEX_BRIDGE_IOS_OTA_BUN?.trim() || this.agentBun || (/^bun(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "") || fromPath;
    if (!bun) throw new Error("找不到 Bun，无法构建 iOS 安装包。");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const fd = openSync(join(this.directory, "bridge-publish.log"), "a", 0o600);
    try { this.child = spawn(bun, [script, "--no-serve", "--directory", this.directory], { cwd: this.source, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    const child = this.child;
    this.publishState = { state: "running" };
    child.once("error", () => { if (this.child === child) { this.child = null; this.publishState = { state: "failed", message: "构建未能启动，请查看 Mac 上的 OTA 构建日志。" }; } });
    child.once("exit", (code) => { if (this.child === child) { this.child = null; this.publishState = code === 0 ? { state: "succeeded", message: "新安装包已发布。" } : { state: "failed", message: "构建或签名失败，请查看 Mac 上的 OTA 构建日志。" }; } });
    return this.publishState;
  }
}
