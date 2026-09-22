import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCodexAppServerEnvironment,
  CodexAppServerClient,
  codexThreadSourceLabel,
} from "./codex-app-server.js";
import { enqueueCodexNotification } from "./codex-notification-inbox.js";
import type { BridgeConfig } from "./types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_DIRECTORY = "feishu-codex-bridge";
const CHAIN_STATE_FILE = "notify-chain.json";
const DELIVERY_STATE_FILE = "notify-delivery.json";
const CHAIN_VERSION = 1;
const COMPLETION_EVENT_TYPE = "agent-turn-complete";

export interface CodexNotifyInstallOptions {
  bridgeConfigPath: string;
  dbPath: string;
  bridgeLauncherPath?: string;
}

interface NotifyChainState {
  version: typeof CHAIN_VERSION;
  legacyCommand: string[] | null;
  bridgeCommand: string[];
  bridgeConfigPath: string;
  dbPath: string;
  updatedAt: string;
}

interface NotifyDeliveryState {
  version: 1;
  turnIds: Record<string, string>;
}

interface NotifyPayload {
  type?: string;
  "thread-id"?: string;
  "turn-id"?: string;
  cwd?: string;
  "input-messages"?: unknown;
  "last-assistant-message"?: unknown;
  [key: string]: unknown;
}

export async function installCodexNotifyHook(options: CodexNotifyInstallOptions): Promise<void> {
  const codexHome = resolveCodexHome();
  const configPath = join(codexHome, "config.toml");
  const original = await readTextIfExists(configPath);
  const existingCommand = parseNotifyCommand(original);
  const statePath = join(codexHome, CHAIN_DIRECTORY, CHAIN_STATE_FILE);
  const previousState = await readJson<NotifyChainState>(statePath);
  const legacyCommand = isBridgeCommand(existingCommand)
    ? previousState?.legacyCommand ?? null
    : existingCommand ?? null;
  const bridgeLauncherPath = options.bridgeLauncherPath || resolveBridgeLauncherPath();
  const bridgeCommand = [
    bridgeLauncherPath,
    "codex:notify-dispatch",
    "--config",
    resolve(options.bridgeConfigPath),
    "--db",
    resolve(options.dbPath),
  ];
  const chainState: NotifyChainState = {
    version: CHAIN_VERSION,
    legacyCommand,
    bridgeCommand,
    bridgeConfigPath: resolve(options.bridgeConfigPath),
    dbPath: resolve(options.dbPath),
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(statePath, chainState, 0o600);
  await backupOnce(configPath, original);
  await writeTextAtomic(configPath, replaceNotifyCommand(original, bridgeCommand), 0o600);
  await enableHookNotifications(options.bridgeConfigPath);

  console.log(`已安装 Codex 官方 notify hook：${configPath}`);
  if (legacyCommand) {
    console.log(`已保留原有 notify hook：${legacyCommand[0]}`);
  }
  console.log(`备份文件：${configPath}.feishu-codex-bridge.bak`);
}

export async function runCodexNotifyHook(
  config: BridgeConfig,
  commandArgs: string[],
): Promise<void> {
  const payload = parseNotifyPayload(commandArgs);
  if (!payload) return;

  const chain = await readJson<NotifyChainState>(join(resolveCodexHome(), CHAIN_DIRECTORY, CHAIN_STATE_FILE));
  const payloadText = JSON.stringify(payload);
  const legacyPromise = chain?.legacyCommand
    ? runExternalHook(chain.legacyCommand, payloadText, payload.cwd)
    : Promise.resolve();
  // Preserve the pre-existing Computer Use hook for every payload. Only the
  // Bridge's own delivery path is restricted to the official completion event;
  // otherwise `/threads`/thread lifecycle payloads can become fake alerts.
  const bridgePromise = config.localNotifications.enabled && isCodexCompletionNotifyPayload(payload)
    ? deliverFeishuNotification(config, payload)
    : Promise.resolve();
  const results = await Promise.allSettled([legacyPromise, bridgePromise]);
  const legacyResult = results[0];
  if (legacyResult.status === "rejected") {
    process.stderr.write(`原有 Codex notify hook 执行失败：${errorMessage(legacyResult.reason)}\n`);
  }
  const bridgeResult = results[1];
  if (bridgeResult.status === "rejected") {
    process.stderr.write(`Feishu Codex notify hook 执行失败：${errorMessage(bridgeResult.reason)}\n`);
  }
}

export function parseNotifyPayload(commandArgs: string[]): NotifyPayload | undefined {
  for (let index = commandArgs.length - 1; index >= 0; index -= 1) {
    const value = commandArgs[index]?.trim();
    if (!value || !value.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(value) as NotifyPayload;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Continue searching in case a preceding option contains JSON text.
    }
  }
  return undefined;
}

/**
 * The bridge owns the official Codex hook, not the legacy `turn-ended`
 * argument used by older third-party notification commands. Requiring the
 * typed event also prevents arbitrary JSON passed to the launcher from being
 * interpreted as a completion.
 */
export function isCodexCompletionNotifyPayload(
  payload: NotifyPayload | undefined,
): payload is NotifyPayload & { type: typeof COMPLETION_EVENT_TYPE; "thread-id": string } {
  return payload?.type === COMPLETION_EVENT_TYPE
    && Boolean(stringValue(payload["thread-id"]));
}

export function parseNotifyCommand(text: string): string[] | undefined {
  const located = locateRootNotifyValue(text);
  if (!located) return undefined;
  return parseTomlStringArray(text.slice(located.valueStart, located.valueEnd));
}

export function replaceNotifyCommand(text: string, command: string[]): string {
  const rendered = renderTomlStringArray(command);
  const located = locateRootNotifyValue(text);
  if (located) {
    return `${text.slice(0, located.valueStart)}${rendered}${text.slice(located.valueEnd)}`;
  }
  const tableIndex = text.search(/^\s*\[/m);
  const block = `notify = ${rendered}\n\n`;
  return tableIndex >= 0
    ? `${text.slice(0, tableIndex)}${block}${text.slice(tableIndex)}`
    : `${text.trimEnd()}\n\n${block}`;
}

async function deliverFeishuNotification(config: BridgeConfig, payload: NotifyPayload): Promise<void> {
  const threadId = stringValue(payload["thread-id"]);
  if (!threadId) return;
  const turnId = stringValue(payload["turn-id"]);
  if (turnId && await wasDelivered(turnId)) return;

  let source: "cli" | "appServer" = "cli";
  const client = new CodexAppServerClient({
    executable: config.codex.cliPath,
    cwd: stringValue(payload.cwd) || PROJECT_ROOT,
    env: buildCodexAppServerEnvironment(config),
    clientName: "feishu_codex_bridge_notify_hook",
    clientTitle: "Feishu Codex Bridge Notify Hook",
  });
  try {
    try {
      const result = await client.readThread(threadId, false);
      const sourceLabel = codexThreadSourceLabel(result.thread.source ?? result.thread.threadSource);
      if (sourceLabel === "appServer" || sourceLabel.toLowerCase() === "appserver") {
        source = "appServer";
      }
    } catch (error) {
      // The event itself is authoritative for completion. If the one-shot
      // source lookup fails, still enqueue a CLI-safe notification instead of
      // dropping the completion entirely.
      process.stderr.write(`Codex notify hook source lookup failed; using cli-safe fallback: ${errorMessage(error)}\n`);
    }
  } finally {
    await client.close();
  }

  const sourceLabel = source === "appServer" ? "Codex App" : "Codex CLI";
  const assistantMessage = stringValue(payload["last-assistant-message"]);
  const inputMessages = Array.isArray(payload["input-messages"])
    ? payload["input-messages"].filter((value): value is string => typeof value === "string").join(" ")
    : "";
  const detail = truncate(assistantMessage || inputMessages || stringValue(payload.cwd) || "Codex turn 已结束。", 600);
  await enqueueCodexNotification({
    id: turnId || threadId,
    title: `${sourceLabel}任务已完成`,
    body: `${threadId}\n${detail}`,
    source,
    createdAt: new Date().toISOString(),
  });
  if (turnId) await markDelivered(turnId);
}

function runExternalHook(command: string[], payload: string, cwd?: string): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (command.length === 0) {
      resolvePromise();
      return;
    }
    const child = spawn(command[0], [...command.slice(1), payload], {
      cwd: cwd && existsSync(cwd) ? cwd : process.cwd(),
      env: process.env,
      stdio: "ignore",
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command[0]} exited with ${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

function resolveBridgeLauncherPath(): string {
  const portableRoot = process.env.FEISHU_CODEX_BRIDGE_PORTABLE_ROOT;
  const candidates = [
    process.env.FEISHU_CODEX_BRIDGE_LAUNCHER,
    portableRoot ? join(portableRoot, "feishu-codex-bridge") : undefined,
    join(PROJECT_ROOT, "bin", "feishu-codex-bridge.mjs"),
  ];
  const result = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!result) throw new Error("找不到 Feishu Codex Bridge launcher，无法安装 Codex notify hook");
  return resolve(result);
}

function resolveCodexHome(): string {
  return resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
}

function isBridgeCommand(command: string[] | undefined): boolean {
  return Boolean(command?.some((value) => value === "codex:notify-hook" || value === "codex:notify-dispatch"));
}

async function enableHookNotifications(configPath: string): Promise<void> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
  const existing = raw.localNotifications && typeof raw.localNotifications === "object"
    ? raw.localNotifications
    : {};
  raw.localNotifications = {
    ...existing,
    enabled: true,
    mode: "hook",
    intervalSeconds: Number.isInteger(existing.intervalSeconds) ? existing.intervalSeconds : 60,
  };
  await writeJsonAtomic(configPath, raw, 0o600);
}

async function wasDelivered(turnId: string): Promise<boolean> {
  const state = await readJson<NotifyDeliveryState>(join(resolveCodexHome(), CHAIN_DIRECTORY, DELIVERY_STATE_FILE));
  return Boolean(state?.turnIds?.[turnId]);
}

async function markDelivered(turnId: string): Promise<void> {
  const path = join(resolveCodexHome(), CHAIN_DIRECTORY, DELIVERY_STATE_FILE);
  const state = (await readJson<NotifyDeliveryState>(path)) || { version: 1, turnIds: {} };
  state.turnIds[turnId] = new Date().toISOString();
  const entries = Object.entries(state.turnIds).sort((left, right) => left[1].localeCompare(right[1]));
  for (const [id] of entries.slice(0, Math.max(0, entries.length - 500))) delete state.turnIds[id];
  await writeJsonAtomic(path, state, 0o600);
}

async function backupOnce(path: string, content: string): Promise<void> {
  const backup = `${path}.feishu-codex-bridge.bak`;
  if (!existsSync(backup)) await writeFile(backup, content, { encoding: "utf8", mode: 0o600 });
}

async function writeJsonAtomic(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function writeTextAtomic(path: string, content: string, mode: number): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode });
  await rename(temporaryPath, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function locateRootNotifyValue(text: string): { valueStart: number; valueEnd: number } | undefined {
  const matcher = /^\s*notify\s*=\s*/gm;
  const match = matcher.exec(text);
  if (!match) return undefined;
  const valueStart = match.index + match[0].length;
  return { valueStart, valueEnd: scanTomlValueEnd(text, valueStart) };
}

function scanTomlValueEnd(text: string, start: number): number {
  let index = start;
  while (/\s/.test(text[index] || "")) index += 1;
  if (text[index] !== "[") {
    const newline = text.indexOf("\n", index);
    return newline < 0 ? text.length : newline;
  }
  let depth = 0;
  let quote: "double" | "single" | undefined;
  let escaped = false;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "double") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '"') quote = "double";
    else if (char === "'") quote = "single";
    else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return index + 1;
  }
  throw new Error("Codex config.toml 中的 notify 数组未闭合");
}

function parseTomlStringArray(raw: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < raw.length) {
        const char = raw[index];
        index += 1;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') break;
      }
      const parsed = JSON.parse(raw.slice(start, index));
      if (typeof parsed !== "string") throw new Error("Codex config.toml 的 notify 必须是字符串数组");
      values.push(parsed);
      continue;
    }
    if (raw[index] === "'") {
      const end = raw.indexOf("'", index + 1);
      if (end < 0) throw new Error("Codex config.toml 的 notify 字符串未闭合");
      values.push(raw.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return values;
}

function renderTomlStringArray(values: string[]): string {
  return `[\n${values.map((value) => `  ${JSON.stringify(value)}`).join(",\n")}\n]`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
