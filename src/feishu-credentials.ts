import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { BridgeConfig } from "./types.js";

const AAMP_BINDINGS_SCHEMA = "aamp.feishu-task-agent.bindings";
const AAMP_BINDINGS_VERSION = 1;
const DEFAULT_AAMP_STATE_HOME = join(homedir(), ".aamp", "feishu-task-agent");
const DEFAULT_AAMP_LARK_CONFIG_DIR = join(
  homedir(),
  ".lark-cli-aamp-one-click-v1",
);

export type FeishuCredentialSource =
  | "direct-config"
  | "environment"
  | "aamp-binding"
  | "mixed";

export interface AampFeishuBinding {
  bindingId: string;
  agentType: string;
  appId: string;
  appSecret: string;
  tenantBrand: "feishu" | "lark";
  larkCliProfile?: string;
  state: "pending" | "ready";
  environment: "online";
}

export interface ResolvedFeishuCredentials {
  appId: string;
  appSecret: string;
  source: FeishuCredentialSource;
  bindingId?: string;
  tenantBrand?: "feishu" | "lark";
  larkCliProfile?: string;
  larkConfigDir?: string;
}

export interface FeishuCredentialResolutionOptions {
  inheritedEnv?: NodeJS.ProcessEnv;
  /** Override the AAMP state directory, primarily for tests or isolated services. */
  stateHome?: string;
  /** Override the AAMP binding store path. */
  bindingsPath?: string;
  /** Override the AAMP service selection path. */
  selectionPath?: string;
}

interface RawRecord {
  [key: string]: unknown;
}

/**
 * Resolve the same AAMP state locations used by the official controller.
 *
 * This module only reads the store. It never writes bindings, creates a
 * lark-cli profile, or changes the AAMP service selection, so AAMP remains the
 * owner of its existing lifecycle and credential injection behavior.
 */
export function resolveAampStateHome(
  inherited: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(inherited.AAMP_TASK_STATE_HOME || DEFAULT_AAMP_STATE_HOME);
}

export function resolveAampBindingsPath(
  options: FeishuCredentialResolutionOptions = {},
): string {
  const inherited = options.inheritedEnv ?? process.env;
  if (options.bindingsPath) return resolve(options.bindingsPath);
  if (options.stateHome) return join(resolve(options.stateHome), "bindings-v1.json");
  const stateHome = resolveAampStateHome(inherited);
  return resolve(inherited.AAMP_TASK_CONFIG_FILE || join(stateHome, "bindings-v1.json"));
}

export function resolveAampSelectionPath(
  options: FeishuCredentialResolutionOptions = {},
): string {
  const inherited = options.inheritedEnv ?? process.env;
  if (options.selectionPath) return resolve(options.selectionPath);
  const stateHome = options.stateHome
    ? resolve(options.stateHome)
    : resolveAampStateHome(inherited);
  return join(stateHome, "service-v1", "selection.json");
}

/**
 * Resolve the lark-cli store used by AAMP's online environment. The official
 * controller receives this through AAMP_LARK_CLI_CONFIG_DIR; the default is
 * the same isolated AAMP profile store.
 */
export function resolveAampLarkConfigDir(
  inherited: NodeJS.ProcessEnv = process.env,
  configured?: string,
): string {
  return resolve(configured || inherited.AAMP_LARK_CLI_CONFIG_DIR || DEFAULT_AAMP_LARK_CONFIG_DIR);
}

/**
 * Read valid Codex bindings from the AAMP store without exposing secrets in
 * diagnostics. Pending records are accepted because their app credentials
 * are already complete and the direct bridge can connect without starting the
 * AAMP service; ready records are preferred during selection.
 */
export function readAampCodexBindings(
  options: FeishuCredentialResolutionOptions = {},
): AampFeishuBinding[] {
  const store = asRecord(readJson(resolveAampBindingsPath(options)));
  if (!store
    || store.schema !== AAMP_BINDINGS_SCHEMA
    || store.version !== AAMP_BINDINGS_VERSION
    || !Array.isArray(store.bindings)) {
    return [];
  }
  return store.bindings
    .map(normalizeAampBinding)
    .filter((binding): binding is AampFeishuBinding => binding !== undefined);
}

/**
 * Read the official service selection. The controller currently stores
 * binding_ids; accepting the camelCase spelling keeps this adapter tolerant
 * of older local snapshots without affecting the official controller.
 */
export function readAampSelectedBindingIds(
  options: FeishuCredentialResolutionOptions = {},
): string[] {
  const selection = asRecord(readJson(resolveAampSelectionPath(options)));
  if (!selection) return [];
  const value = selection.binding_ids ?? selection.bindingIds;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => (
    typeof item === "string" && item.trim().length > 0
  ));
}

/**
 * Resolve native SDK credentials using the following compatibility order:
 *
 * 1. explicit direct.feishu values;
 * 2. the configured environment variable names (legacy direct behavior);
 * 3. the selected/available Codex binding saved by AAMP.
 *
 * A direct config or environment value is never silently replaced. If only an
 * app ID is supplied, an AAMP binding with the same app ID may provide the
 * matching secret; credentials from unrelated bindings are not combined.
 */
export function resolveSharedFeishuCredentials(
  config: BridgeConfig,
  options: FeishuCredentialResolutionOptions = {},
): ResolvedFeishuCredentials {
  const inherited = options.inheritedEnv ?? process.env;
  const feishu = config.direct.feishu;
  const explicitAppId = nonEmpty(feishu.appId);
  const explicitAppSecret = nonEmpty(feishu.appSecret);
  const environmentAppId = nonEmpty(inherited[feishu.appIdEnv]);
  const environmentAppSecret = nonEmpty(inherited[feishu.appSecretEnv]);
  const appId = explicitAppId ?? environmentAppId;
  const appSecret = explicitAppSecret ?? environmentAppSecret;

  if (appId && appSecret) {
    return {
      appId,
      appSecret,
      source: explicitAppId && explicitAppSecret
        ? "direct-config"
        : explicitAppId || explicitAppSecret
          ? "mixed"
          : "environment",
      larkConfigDir: resolveAampLarkConfigDir(inherited, config.lark.configDir),
    };
  }

  const bindings = readAampCodexBindings(options);
  const binding = selectAampCodexBinding(bindings, config.lark.profile, options);
  const canCompleteWithBinding = !appSecret;
  if (binding && canCompleteWithBinding && (!appId || binding.appId === appId)) {
    return {
      appId: appId ?? binding.appId,
      appSecret: appSecret ?? binding.appSecret,
      source: appId || appSecret ? "mixed" : "aamp-binding",
      bindingId: binding.bindingId,
      tenantBrand: binding.tenantBrand,
      larkCliProfile: binding.larkCliProfile,
      larkConfigDir: resolveAampLarkConfigDir(inherited, config.lark.configDir),
    };
  }

  const expectedId = feishu.appId ? "direct.feishu.appId" : feishu.appIdEnv;
  const expectedSecret = feishu.appSecret
    ? "direct.feishu.appSecret"
    : feishu.appSecretEnv;
  if (!appId) {
    throw new Error(
      `missing Feishu app id: set ${expectedId} or run aamp:install to create a Codex binding`,
    );
  }
  throw new Error(
    `missing Feishu app secret: set ${expectedSecret} or run aamp:install to create a Codex binding`,
  );
}

function selectAampCodexBinding(
  bindings: AampFeishuBinding[],
  profile: string,
  options: FeishuCredentialResolutionOptions,
): AampFeishuBinding | undefined {
  if (bindings.length === 0) return undefined;
  const byId = new Map(bindings.map((binding) => [binding.bindingId, binding]));
  const selected = readAampSelectedBindingIds(options)
    .map((bindingId) => byId.get(bindingId))
    .filter((binding): binding is AampFeishuBinding => binding !== undefined);
  const ordered = [
    ...selected,
    ...bindings.filter((binding) => binding.larkCliProfile === profile),
    ...bindings,
  ];
  const deduplicated = [...new Map(ordered.map((binding) => [binding.bindingId, binding])).values()];
  return deduplicated.find((binding) => binding.state === "ready")
    ?? deduplicated.find((binding) => binding.state === "pending");
}

function normalizeAampBinding(value: unknown): AampFeishuBinding | undefined {
  const binding = asRecord(value);
  const bot = asRecord(binding?.bot);
  const environment = asRecord(binding?.environment);
  const bindingId = nonEmpty(binding?.binding_id);
  const agentType = nonEmpty(binding?.agent_type);
  const appId = nonEmpty(bot?.app_id);
  const appSecret = nonEmpty(bot?.app_secret);
  const larkCliProfile = nonEmpty(bot?.lark_cli_profile);
  const environmentName = nonEmpty(environment?.name);
  const stateValue = nonEmpty(binding?.state) ?? "ready";
  const tenantBrandValue = nonEmpty(bot?.tenant_brand) ?? "feishu";
  if (!bindingId || !agentType || agentType !== "codex" || !appId || !appSecret || !larkCliProfile) {
    return undefined;
  }
  if (environmentName !== "online"
    || (stateValue !== "pending" && stateValue !== "ready")
    || (tenantBrandValue !== "feishu" && tenantBrandValue !== "lark")) {
    return undefined;
  }
  return {
    bindingId,
    agentType,
    appId,
    appSecret,
    tenantBrand: tenantBrandValue,
    larkCliProfile,
    state: stateValue,
    environment: environmentName,
  };
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): RawRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RawRecord
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
