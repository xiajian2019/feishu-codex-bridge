import { join, resolve } from "node:path";
import * as qrcodeTerminal from "qrcode-terminal";

import { StateDatabase } from "./db.js";
import { WebPairingAuth } from "./web-auth.js";

interface PairCliArguments {
  dbPath: string;
  url: string;
  help: boolean;
}

export function parseWebPairArguments(argv: string[], cwd = process.cwd()): PairCliArguments {
  let dbPath = join(resolve(cwd), "runtime", "bridge.db");
  let explicitDbPath = false;
  let url = "";
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
      explicitDbPath = true;
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
  if (!explicitDbPath) dbPath = inferDbPathForUrl(url, cwd);
  return { dbPath, url, help };
}

export async function runWebPair(argv = process.argv.slice(2)): Promise<void> {
  const args = parseWebPairArguments(argv);
  if (args.help) {
    printUsage();
    return;
  }
  const db = new StateDatabase(args.dbPath);
  const pairing = new WebPairingAuth({ db }).startPairing();
  const pairingUrl = buildPairingUrl(args.url, pairing.code);
  console.log("请用手机扫描下面的二维码完成配对：");
  console.log("数据库：" + args.dbPath);
  console.log("5 分钟内有效，二维码只能使用一次。");
  await renderQr(pairingUrl);
  console.log("备用链接：" + pairingUrl);
  db.close();
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

function inferDbPathForUrl(rawUrl: string, cwd: string): string {
  try {
    const port = new URL(rawUrl).port;
    if (port === "5173" || port === "17310") {
      return resolve(cwd, "runtime", "dev", "bridge.db");
    }
    if (port === "7320") {
      return resolve(cwd, "runtime", "tmux-verifier.db");
    }
  } catch {
    // buildPairingUrl() reports the useful URL validation error later.
  }
  return resolve(cwd, "runtime", "bridge.db");
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
    "Usage: bun run web:pair -- --url http://192.168.1.10:7320/",
    "  --url <url>                 phone-reachable HTTP(S) page URL",
    "  --db <path>                 SQLite database used by the running service",
    "                              inferred from URL: 5173/17310=runtime/dev, 7320=runtime/tmux-verifier",
    "",
    "Standalone tmux verifier example:",
    "  bun run web:pair -- --db ./runtime/tmux-verifier.db --url http://192.168.1.10:7320/",
  ].join("\n"));
}

if (import.meta.main) {
  runWebPair().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
