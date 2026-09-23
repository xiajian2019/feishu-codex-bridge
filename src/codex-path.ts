import { execFileSync } from "node:child_process";
import { constants as fsConstants, accessSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { findExecutableInPath } from "./runtime-env.js";

export type CodexPathSource =
  | "environment"
  | "path"
  | "user-install"
  | "homebrew"
  | "system"
  | "chatgpt-app";

export interface CodexPathResolution {
  path: string;
  source: CodexPathSource;
}

export interface CodexPathDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  includeKnownStandalonePaths?: boolean;
  /** App bundle paths are injectable so discovery remains deterministic in tests. */
  appBundlePaths?: string[];
}

interface CodexPathCandidate {
  path: string;
  source: CodexPathSource;
}

/**
 * Resolve a usable Codex executable for the friendly installer.
 *
 * The supported standalone install locations are checked first. On macOS we
 * then fall back to the Codex binary shipped inside the ChatGPT desktop app.
 * That fallback is intentionally isolated here so the rest of the bridge only
 * receives one executable path and does not need to know how it was found.
 */
export function resolveCodexCliPath(
  options: CodexPathDiscoveryOptions = {},
): CodexPathResolution | undefined {
  for (const candidate of codexPathCandidates(options)) {
    if (isExecutableCodexPath(candidate.path)) {
      return {
        path: resolve(candidate.path),
        source: candidate.source,
      };
    }
  }
  return undefined;
}

export function codexPathCandidates(
  options: CodexPathDiscoveryOptions = {},
): CodexPathCandidate[] {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const candidates: CodexPathCandidate[] = [];

  addCandidate(candidates, environment.CODEX_PATH, "environment");

  const pathCodex = findExecutableInPath("codex", environment.PATH);
  addCandidate(candidates, pathCodex, "path");

  if (options.includeKnownStandalonePaths !== false) {
    addCandidate(candidates, join(homeDirectory, ".local", "bin", "codex"), "user-install");
  }

  if (platform === "darwin") {
    if (options.includeKnownStandalonePaths !== false) {
      addCandidate(candidates, "/opt/homebrew/bin/codex", "homebrew");
      addCandidate(candidates, "/usr/local/bin/codex", "system");
    }
    for (const appBundlePath of chatGptAppBundlePaths(options)) {
      addCandidate(
        candidates,
        join(appBundlePath, "Contents", "Resources", "codex"),
        "chatgpt-app",
      );
    }
  }

  return candidates;
}

export function isExecutableCodexPath(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function codexPathSourceLabel(source: CodexPathSource): string {
  switch (source) {
    case "environment":
      return "CODEX_PATH 环境变量";
    case "path":
      return "系统 PATH";
    case "user-install":
      return "Codex 用户安装目录";
    case "homebrew":
      return "Homebrew";
    case "system":
      return "系统 Codex 路径";
    case "chatgpt-app":
      return "ChatGPT App 内置 Codex";
  }
}

function addCandidate(
  candidates: CodexPathCandidate[],
  path: string | undefined,
  source: CodexPathSource,
): void {
  const value = path?.trim();
  if (!value) return;
  const normalized = resolve(value);
  if (candidates.some((candidate) => resolve(candidate.path) === normalized)) return;
  candidates.push({ path: normalized, source });
}

function chatGptAppBundlePaths(options: CodexPathDiscoveryOptions): string[] {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configured = environment.CHATGPT_APP_PATH;
  const known = [
    "/Applications/ChatGPT.app",
    join(homeDirectory, "Applications", "ChatGPT.app"),
    "/Applications/Codex.app",
    join(homeDirectory, "Applications", "Codex.app"),
  ];
  const indexed = options.appBundlePaths ?? findInstalledChatGptApps();
  return uniquePaths([
    configured,
    ...indexed,
    ...known,
  ]);
}

function findInstalledChatGptApps(): string[] {
  try {
    const output = execFileSync(
      "/usr/bin/mdfind",
      ["kMDItemCFBundleIdentifier == 'com.openai.codex'"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    // Spotlight may be unavailable or denied. Known application locations are
    // still checked by chatGptAppBundlePaths().
    return [];
  }
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path?.trim()) continue;
    const normalized = resolve(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
