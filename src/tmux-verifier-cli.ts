import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TmuxVerifier } from "./tmux-verifier.js";
import { TmuxVerifierStore } from "./tmux-verifier-store.js";
import { TmuxVerifierWebServer } from "./tmux-verifier-web.js";

export interface TmuxVerifierCliArguments {
  host: string;
  port: number;
  databasePath: string;
  codexPath: string;
  tmuxPath: string;
  socket: string;
  bridgeDashboardUrl: string;
  pollIntervalMs: number;
  help: boolean;
}

export function parseTmuxVerifierArguments(
  argv: string[],
  cwd = process.cwd(),
): TmuxVerifierCliArguments {
  const defaults: TmuxVerifierCliArguments = {
    host: "127.0.0.1",
    port: 7320,
    databasePath: resolve(cwd, "runtime", "tmux-verifier.db"),
    codexPath: defaultCodexPath(),
    tmuxPath: process.env.TMUX_VERIFY_TMUX_PATH ?? defaultTmuxPath(),
    socket: process.env.TMUX_VERIFY_SOCKET ?? "",
    bridgeDashboardUrl: normalizeBridgeDashboardUrl(
      process.env.TMUX_VERIFY_BRIDGE_DASHBOARD_URL ?? "http://127.0.0.1:7310",
    ),
    pollIntervalMs: 500,
    help: false,
  } satisfies TmuxVerifierCliArguments;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      defaults.help = true;
      continue;
    }
    const [name, inlineValue] = splitOption(arg);
    if (name === "--host") {
      defaults.host = requireValue(name, inlineValue ?? argv[++index]);
    } else if (name === "--port") {
      defaults.port = parseNumber(name, inlineValue ?? argv[++index], 1, 65_535);
    } else if (name === "--db") {
      defaults.databasePath = resolve(cwd, requireValue(name, inlineValue ?? argv[++index]));
    } else if (name === "--codex") {
      defaults.codexPath = requireValue(name, inlineValue ?? argv[++index]);
    } else if (name === "--tmux") {
      defaults.tmuxPath = requireValue(name, inlineValue ?? argv[++index]);
    } else if (name === "--socket") {
      defaults.socket = requireValue(name, inlineValue ?? argv[++index]);
    } else if (name === "--bridge-url") {
      defaults.bridgeDashboardUrl = normalizeBridgeDashboardUrl(
        requireValue(name, inlineValue ?? argv[++index]),
      );
    } else if (name === "--poll-ms") {
      defaults.pollIntervalMs = parseNumber(name, inlineValue ?? argv[++index], 100, 60_000);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return defaults;
}

export async function runTmuxVerifier(argv = process.argv.slice(2)): Promise<void> {
  const args = parseTmuxVerifierArguments(argv);
  if (args.help) {
    printUsage();
    return;
  }
  mkdirSync(resolve(args.databasePath, ".."), { recursive: true });
  const store = new TmuxVerifierStore(args.databasePath);
  const verifier = new TmuxVerifier({
    store,
    defaultCodexPath: args.codexPath,
    tmuxSocket: args.socket,
    pollIntervalMs: args.pollIntervalMs,
    adapterOptions: { tmuxPath: args.tmuxPath },
  });
  const server = new TmuxVerifierWebServer({
    verifier,
    host: args.host,
    port: args.port,
    projectMapPath: process.env.TMUX_VERIFY_PROJECT_MAP
      ?? resolve(homedir(), ".codex", "project-map.yaml"),
    bridgeDashboardUrl: args.bridgeDashboardUrl,
    logger: createLogger(),
  });
  verifier.start();
  const url = await server.start();
  console.log(JSON.stringify({ service: "tmux-verifier", url, database: args.databasePath }));

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    verifier.stop();
    store.close();
  };
  const onSignal = (): void => {
    void stop().then(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await new Promise<void>(() => undefined);
}

function defaultCodexPath(): string {
  const candidates = [
    process.env.CODEX_PATH,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "codex",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => !candidate.startsWith("/") || existsSync(candidate)) ?? "codex";
}

function defaultTmuxPath(): string {
  const candidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "tmux"];
  return candidates.find((candidate) => !candidate.startsWith("/") || existsSync(candidate)) ?? "tmux";
}

function splitOption(arg: string): [string, string | undefined] {
  const equal = arg.indexOf("=");
  return equal === -1 ? [arg, undefined] : [arg.slice(0, equal), arg.slice(equal + 1)];
}

function requireValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseNumber(name: string, value: string | undefined, min: number, max: number): number {
  const normalized = requireValue(name, value);
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must be an integer`);
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

function createLogger() {
  const write = (level: string, message: string, details?: Record<string, unknown>): void => {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...(details ? { details } : {}),
    }));
  };
  return {
    info: (message: string, details?: Record<string, unknown>) => write("info", message, details),
    warn: (message: string, details?: Record<string, unknown>) => write("warn", message, details),
    error: (message: string, details?: Record<string, unknown>) => write("error", message, details),
  };
}

function printUsage(): void {
  console.log([
    "Usage: pnpm run tmux:verify -- [options]",
    "  --host <host>       loopback host (default: 127.0.0.1)",
    "  --port <port>       HTTP port (default: 7320)",
    "  --db <path>         verifier SQLite path (default: runtime/tmux-verifier.db)",
    "  --codex <path>      Codex executable path (default: auto-discovered)",
    "  --tmux <path>       tmux executable path (default: tmux)",
    "  --socket <name>     use a named tmux socket (default: existing tmux server)",
    "  --bridge-url <url>  Bridge dashboard URL (default: http://127.0.0.1:7310)",
    "  --poll-ms <ms>      pane polling interval (default: 500)",
  ].join("\n"));
}

function normalizeBridgeDashboardUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--bridge-url must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--bridge-url must be an absolute HTTP(S) URL");
  }
  return url.toString();
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  runTmuxVerifier().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
