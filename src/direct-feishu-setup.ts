import { spawn } from "node:child_process";
import { constants as fsConstants, accessSync, chmodSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import * as lark from "@larksuiteoapi/node-sdk";

import { findExecutableInPath } from "./runtime-env.js";
import type { BridgeConfig } from "./types.js";

const DEFAULT_LARK_CONFIG_DIR = join(homedir(), ".lark-cli-aamp-one-click-v1");

// Direct mode only needs bot-side permissions. User-scoped lark-cli OAuth is
// deliberately not requested because the native WebSocket channel authenticates
// with the app credentials returned by registerApp().
const DIRECT_TENANT_SCOPES = [
  "im:message",
  "im:message:send_as_bot",
  "im:message:readonly",
  "im:resource",
  "cardkit:card:write",
];

const DIRECT_TENANT_EVENTS = ["im.message.receive_v1"];

export interface DirectFeishuSetupResult {
  appId: string;
  appSecret: string;
  tenantBrand: "feishu" | "lark";
  appName: string;
  larkCliPath: string;
  larkProfile: string;
  larkConfigDir: string;
}

export interface DirectFeishuSetupOptions {
  configPath: string;
  appName?: string;
  environment?: NodeJS.ProcessEnv;
  openUrl?: boolean;
}

/**
 * Register a direct-mode Feishu bot without invoking AAMP.
 *
 * The QR/device authorization is provided by the official Lark SDK. lark-cli
 * is used only to persist the resulting app profile, so later local tools can
 * use the same account/config directory; no AAMP binding or service is made.
 */
export async function setupDirectFeishuCredentials(
  configPath: string,
  options: Omit<DirectFeishuSetupOptions, "configPath"> = {},
): Promise<DirectFeishuSetupResult> {
  const config = readConfig(await readFile(configPath, "utf8"));
  const inherited = options.environment ?? process.env;
  const larkConfig = isRecord(config.lark) ? config.lark as BridgeConfig["lark"] : {
    profile: "direct",
    tasklistGuid: "direct-tasklist",
    projectFieldGuid: "direct-project-field",
    modeFieldGuid: "direct-mode-field",
  };
  const larkCliPath = resolveLarkCliPath({ lark: larkConfig }, inherited);
  if (!larkCliPath) {
    throw new Error(
      "找不到 lark-cli。直连安装包应包含 lark-cli；源码环境请先将 lark-cli 加入 PATH。",
    );
  }

  let detectedTenantBrand: "feishu" | "lark" = "feishu";
  const result = await lark.registerApp({
    source: "feishu-codex-bridge",
    createOnly: true,
    appPreset: {
      name: options.appName ?? "Feishu Codex Bridge",
      desc: "Feishu Codex direct bridge bot",
    },
    addons: {
      scopes: { tenant: DIRECT_TENANT_SCOPES },
      events: { items: { tenant: DIRECT_TENANT_EVENTS } },
    },
    onQRCodeReady: (info) => {
      console.log(`请打开飞书授权链接（${info.expireIn} 秒内有效）：${info.url}`);
      if (options.openUrl !== false) openUrl(info.url);
    },
    onStatusChange: (info) => {
      if (info.status === "domain_switched") detectedTenantBrand = "lark";
      if (info.status !== "polling") console.log(`Feishu 授权状态：${info.status}`);
    },
  });

  const tenantBrand = result.user_info?.tenant_brand === "lark"
    ? "lark"
    : detectedTenantBrand;
  const appId = result.client_id;
  const appSecret = result.client_secret;
  if (!appId || !appSecret) throw new Error("Feishu 授权没有返回完整的 app_id/app_secret");

  const appName = await readRegisteredAppName(appId, appSecret, tenantBrand, options.appName);
  const larkConfigDir = resolve(config.lark.configDir || inherited.LARKSUITE_CLI_CONFIG_DIR || DEFAULT_LARK_CONFIG_DIR);
  const larkProfile = `aamp-feishu-task-${appId}${tenantBrand === "lark" ? "-lark" : ""}`;
  await ensureLarkCliProfile(larkCliPath, larkProfile, appId, appSecret, tenantBrand, larkConfigDir, inherited);
  await updateDirectConfig(configPath, config, {
    appId,
    appSecret,
    tenantBrand,
    appName,
    larkCliPath,
    larkProfile,
    larkConfigDir,
  });

  return { appId, appSecret, tenantBrand, appName, larkCliPath, larkProfile, larkConfigDir };
}

export function resolveLarkCliPath(
  config: Pick<BridgeConfig, "lark">,
  inherited: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = [
    config.lark.cliPath,
    inherited.LARK_CLI_PATH,
    findExecutableInPath("lark-cli", inherited.PATH),
    join(homedir(), ".aamp", "npm-global", "bin", "lark-cli"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && isExecutable(candidate)));
}

async function ensureLarkCliProfile(
  executable: string,
  profile: string,
  appId: string,
  appSecret: string,
  tenantBrand: "feishu" | "lark",
  configDir: string,
  inherited: NodeJS.ProcessEnv,
): Promise<void> {
  const env = {
    ...inherited,
    LARKSUITE_CLI_CONFIG_DIR: configDir,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
  const listed = await runLarkCli(executable, ["profile", "list"], env);
  if (!listed.stdout.includes(profile)) {
    const added = await runLarkCli(
      executable,
      ["profile", "add", "--name", profile, "--app-id", appId, "--brand", tenantBrand, "--app-secret-stdin"],
      env,
      appSecret,
    );
    if (added.exitCode !== 0) {
      throw new Error(`lark-cli profile 创建失败：${trimCliError(added.stderr || added.stdout)}`);
    }
  }
}

async function readRegisteredAppName(
  appId: string,
  appSecret: string,
  tenantBrand: "feishu" | "lark",
  fallback?: string,
): Promise<string> {
  try {
    const client = new lark.Client({
      appId,
      appSecret,
      domain: tenantBrand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    });
    const response = await client.application.application.get({
      path: { app_id: appId },
      params: { lang: "zh_cn", user_id_type: "open_id" },
    });
    const app = response.data?.app as { app_name?: string; i18n?: Array<{ i18n_key?: string; name?: string }> } | undefined;
    return app?.app_name
      || app?.i18n?.find((item) => item.i18n_key === "zh_cn")?.name
      || fallback
      || "Feishu Codex Bridge";
  } catch (error) {
    console.warn(`无法读取 Feishu 应用名称，将使用默认名称：${error instanceof Error ? error.message : String(error)}`);
    return fallback || "Feishu Codex Bridge";
  }
}

async function updateDirectConfig(
  configPath: string,
  config: Record<string, any>,
  setup: DirectFeishuSetupResult,
): Promise<void> {
  const direct = isRecord(config.direct) ? config.direct : {};
  const feishu = isRecord(direct.feishu) ? direct.feishu : {};
  feishu.appId = setup.appId;
  feishu.appSecret = setup.appSecret;
  direct.feishu = feishu;
  config.direct = direct;
  const larkConfig = isRecord(config.lark) ? config.lark : {};
  larkConfig.profile = setup.larkProfile;
  larkConfig.configDir = setup.larkConfigDir;
  larkConfig.cliPath = setup.larkCliPath;
  config.lark = larkConfig;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" });
  chmodSync(configPath, 0o600);
}

function runLarkCli(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdinValue?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
    if (stdinValue !== undefined) child.stdin.end(`${stdinValue}\n`);
    else child.stdin.end();
  });
}

function openUrl(url: string): void {
  if (process.platform !== "darwin") return;
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function trimCliError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 499)}…` : normalized;
}

function readConfig(raw: string): Record<string, any> {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) throw new Error("config.json 不是 JSON 对象");
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
