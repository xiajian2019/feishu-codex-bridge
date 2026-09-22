import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isSingleBinaryRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.FEISHU_CODEX_BRIDGE_SINGLE_BINARY === "1";
}

export function resolveBridgeProjectRoot(moduleUrl: string): string {
  const appRoot = process.env.FEISHU_CODEX_BRIDGE_APP_ROOT;
  if (appRoot) return resolve(appRoot);
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

export function resolveBridgeDataRoot(moduleUrl: string): string {
  const installRoot = process.env.FEISHU_CODEX_BRIDGE_INSTALL_ROOT;
  return installRoot ? resolve(installRoot) : resolveBridgeProjectRoot(moduleUrl);
}
