import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import * as qrcodeTerminal from "qrcode-terminal";

import { loadConfig } from "./config.js";
import { StateDatabase } from "./db.js";
import { WebPairingAuth } from "./web-auth.js";

const DEFAULT_WEB_PORT = 7310;

interface PairCliArguments {
  dbPath: string;
  configPath: string;
  url: string;
  port?: number;
  help: boolean;
}

export function parseWebPairArguments(argv: string[], cwd = process.cwd()): PairCliArguments {
  const dataRoot = resolvePairingDataRoot(cwd);
  let dbPath = join(dataRoot, "runtime", "bridge.db");
  let configPath = join(dataRoot, "config.json");
  let url = "";
  let port: number | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" || arg === "") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--db" || arg.startsWith("--db=")) {
      const inline = arg.startsWith("--db=") ? arg.slice("--db=".length) : undefined;
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--db requires a path");
      dbPath = resolve(cwd, value);
      continue;
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      const inline = arg.startsWith("--config=") ? arg.slice("--config=".length) : undefined;
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--config requires a path");
      configPath = resolve(cwd, value);
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const inline = arg.startsWith("--port=") ? arg.slice("--port=".length) : undefined;
      const value = inline ?? argv[++index];
      const parsedPort = Number(value);
      if (!value || value.startsWith("--") || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("--port requires a port from 1 to 65535");
      }
      port = parsedPort;
      continue;
    }
    if (arg === "--url" || arg.startsWith("--url=")) {
      const inline = arg.startsWith("--url=") ? arg.slice("--url=".length) : undefined;
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--url requires an HTTP(S) URL");
      url = value;
      continue;
    }
    throw new Error("unknown argument: " + arg);
  }
  return { dbPath, configPath, url, port, help };
}

export async function runWebPair(argv = process.argv.slice(2)): Promise<void> {
  const args = parseWebPairArguments(argv);
  if (args.help) {
    printUsage();
    return;
  }
  const baseUrl = args.url || buildAutomaticPairingUrl(args.configPath, args.port);
  const db = new StateDatabase(args.dbPath);
  try {
    const pairing = new WebPairingAuth({ db }).startPairing();
    const pairingUrl = buildPairingUrl(baseUrl, pairing.code);
    console.log("配对地址：" + baseUrl);
    console.log("数据库：" + args.dbPath);
    console.log("请用手机扫描下面的二维码完成配对：");
    console.log("5 分钟内有效，二维码只能使用一次。");
    await renderQr(pairingUrl);
    console.log("备用链接：" + pairingUrl);
  } finally {
    db.close();
  }
}

function resolvePairingDataRoot(cwd: string): string {
  const installRoot = process.env.FEISHU_CODEX_BRIDGE_INSTALL_ROOT;
  if (installRoot) return resolve(installRoot);
  const portableRoot = process.env.FEISHU_CODEX_BRIDGE_PORTABLE_ROOT;
  if (portableRoot) return resolve(portableRoot);
  return resolve(cwd);
}

function buildAutomaticPairingUrl(configPath: string, portOverride?: number): string {
  const ipv4 = getPreferredIpv4Address();
  if (!ipv4) {
    throw new Error("没有找到可用的局域网 IPv4 地址；请连接 Wi-Fi 或以 --url 指定可访问地址。");
  }
  const port = portOverride ?? readConfiguredWebPort(configPath);
  return "http://" + ipv4 + ":" + port + "/";
}

function readConfiguredWebPort(configPath: string): number {
  if (!existsSync(configPath)) return DEFAULT_WEB_PORT;
  const config = loadConfig(configPath);
  return config.web.port;
}

function getPreferredIpv4Address(): string | null {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => {
        const family = String(entry.family);
        return (family === "IPv4" || family === "4")
          && !entry.internal
          && !entry.address.startsWith("127.")
          && !entry.address.startsWith("169.254.");
      })
      .map((entry) => ({ name, address: entry.address, private: isPrivateIpv4(entry.address) })),
  );
  const interfacePriority = (name: string): number => {
    if (name === "en0") return 0;
    if (/^en\d+$/.test(name)) return 1;
    if (/^(eth|wlan)\d+$/.test(name)) return 2;
    return 3;
  };
  candidates.sort((left, right) => Number(right.private) - Number(left.private)
    || interfacePriority(left.name) - interfacePriority(right.name));
  return candidates[0]?.address ?? null;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second! >= 64 && second! <= 127);
}

function buildPairingUrl(rawUrl: string, code: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("--url must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--url must be an absolute HTTP(S) URL");
  }
  url.hash = "pair=" + encodeURIComponent(code);
  return url.toString();
}

function renderQr(value: string): Promise<void> {
  return new Promise((resolvePromise) => {
    qrcodeTerminal.generate(value, { small: true }, (output) => {
      process.stdout.write(output + "\n");
      resolvePromise();
    });
  });
}

function printUsage(): void {
  console.log([
    "Usage: bun run web:pair [--url <url>] [--port <port>] [--db <path>] [--config <path>]",
    "  Without --url, use the current LAN IPv4 address and web.port from config.json (default: 7310).",
    "  The database defaults to runtime/bridge.db regardless of URL or port.",
    "  --url <url>       Override the generated phone-reachable HTTP(S) URL",
    "  --port <port>     Override the web.port read from config.json",
    "  --db <path>       Override the production SQLite database path",
    "  --config <path>   Override config.json used to read web.port",
  ].join("\n"));
}

if (import.meta.main) {
  runWebPair().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
