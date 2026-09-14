import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { BridgeConfig } from "./types.js";

export const DEFAULT_LARK_CONFIG_DIR = join(homedir(), ".lark-cli");
export const DEFAULT_AAMP_LARK_CONFIG_DIR = join(
  homedir(),
  ".lark-cli-aamp-one-click-v1",
);

/**
 * Resolve the config store without changing the profile name. AAMP has a
 * documented isolated store; legacy bridge configs continue to use lark-cli's
 * normal store unless they opt into AAMP or specify a directory explicitly.
 */
export function resolveLarkConfigDir(
  config: BridgeConfig,
  inherited: NodeJS.ProcessEnv = process.env,
  forceAamp = false,
): string {
  if (config.lark.configDir) return config.lark.configDir;
  if (forceAamp || config.aamp.enabled) return DEFAULT_AAMP_LARK_CONFIG_DIR;
  return inherited.LARKSUITE_CLI_CONFIG_DIR || DEFAULT_LARK_CONFIG_DIR;
}

export function buildLarkEnvironment(
  config: BridgeConfig,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string") env[key] = value;
  }
  env.LARKSUITE_CLI_CONFIG_DIR = resolveLarkConfigDir(config, inherited);
  if (config.lark.cliPath) {
    env.LARK_CLI_PATH = config.lark.cliPath;
    env.PATH = prependPath(dirname(config.lark.cliPath), env.PATH);
  }
  return env;
}

export function resolveLarkCliPath(
  config: BridgeConfig,
  inherited: NodeJS.ProcessEnv = process.env,
): string {
  return config.lark.cliPath || inherited.LARK_CLI_PATH || "lark-cli";
}

export function prependPath(directory: string, currentPath = process.env.PATH): string {
  const entries = (currentPath || "").split(delimiter).filter(Boolean);
  return [directory, ...entries.filter((entry) => entry !== directory)].join(delimiter);
}

/** Find an executable without invoking a shell or following a PATH shim. */
export function findExecutableInPath(
  name: string,
  currentPath = process.env.PATH,
): string | undefined {
  for (const directory of (currentPath || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // A concurrently removed or inaccessible PATH entry is not a match.
    }
  }
  return undefined;
}
