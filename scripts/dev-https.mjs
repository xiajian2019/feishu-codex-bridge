import { spawnSync } from "node:child_process";
import { createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { servicePaths } from "./ios-ota.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const otaDirectory = join(root, "ios/App/build/ios-ota");
const destination = join(root, "ios/App/build/dev-https");
function command(args) {
  const result = spawnSync("/usr/bin/openssl", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`openssl 失败：${result.error?.message || result.stderr?.trim()}`);
}
export function configureDevHttps(ip, options = {}) {
  const addresses = Object.values(options.interfaces ?? networkInterfaces()).flatMap((rows) => rows ?? []);
  if (isIP(ip) !== 4 || !addresses.some((row) => row.family === "IPv4" && row.address === ip)) throw new Error("--ip 必须是 Mac 当前网卡上的 IPv4 地址。");
  const caRoot = options.caRoot ?? join(servicePaths(otaDirectory).tlsRoot, "tls");
  const directory = options.directory ?? destination;
  const ca = join(caRoot, "root-ca.pem"), caKey = join(caRoot, "root-ca.key");
  if (!existsSync(ca) || !existsSync(caKey)) throw new Error("找不到已生成的 OTA 根证书，请先启动 VPN IP 直连 OTA 服务。");
  const rootCert = new X509Certificate(readFileSync(ca));
  const rootKey = createPublicKey(readFileSync(caKey)).export({ type: "spki", format: "der" });
  if (!rootCert.ca || !rootCert.verify(rootCert.publicKey) || !rootKey.equals(rootCert.publicKey.export({ type: "spki", format: "der" }))
      || Date.parse(rootCert.validTo) <= Date.now() || (statSync(caKey).mode & 0o077) !== 0) throw new Error("OTA 根证书无效、过期或私钥权限过宽。");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(directory, ".certificate-"));
  const oldUmask = process.umask(0o077);
  try {
    const key = join(staging, "server.key"), csr = join(staging, "server.csr"), cert = join(staging, "server.pem"), config = join(staging, "extensions.cnf");
    const names = [...new Set([`IP:${ip}`, "IP:127.0.0.1", "DNS:localhost"])].join(",");
    writeFileSync(config, `[server]\nsubjectAltName=${names}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    command(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=Bridge Development HTTPS", "-keyout", key, "-out", csr]);
    command(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-set_serial", `0x${randomUUID().replaceAll("-", "")}`,
      "-days", "365", "-sha256", "-extfile", config, "-extensions", "server", "-out", cert]);
    const leaf = new X509Certificate(readFileSync(cert));
    if (!leaf.checkIP(ip) || !leaf.checkIP("127.0.0.1") || !leaf.verify(rootCert.publicKey)
      || !createPublicKey(readFileSync(key)).export({ type: "spki", format: "der" }).equals(leaf.publicKey.export({ type: "spki", format: "der" }))) throw new Error("开发服务证书校验失败。");
    const finalKey = join(directory, "server.key"), finalCert = join(directory, "server.pem");
    renameSync(key, finalKey); renameSync(cert, finalCert);
    const settings = { schema: 1, ip, cert: finalCert, key: finalKey, ca };
    const temp = join(staging, "settings.json"); writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    renameSync(temp, join(directory, "settings.json"));
    return settings;
  } finally { process.umask(oldUmask); rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== "--");
    if (args.length !== 2 || args[0] !== "--ip") throw new Error("用法：bun run dev:https:configure -- --ip <Mac 的 IPv4>");
    const settings = configureDevHttps(args[1]);
    console.log(`开发 HTTPS 证书已生成：${settings.ip}。重启当前 checkout 的 Vite 后生效。`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
