import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runCodexCli } from "./codex-cli.js";
import {
  codexPathSourceLabel,
  isExecutableCodexPath,
  resolveCodexCliPath,
} from "./codex-path.js";
import { isDirectExecutionMode, loadConfig, parseExecutionMode } from "./config.js";
import { setupDirectFeishuCredentials } from "./direct-feishu-setup.js";
import { resolveSharedFeishuCredentials } from "./feishu-credentials.js";
import type { ExecutionMode } from "./types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EXECUTION_MODE: ExecutionMode = "feishu-sqlite-codex";

export interface InstallCliArguments {
  command: "install" | "init" | "doctor";
  configPath: string;
  dbPath: string;
  executionMode: ExecutionMode;
  codexPath?: string;
  repoPath?: string;
  appId?: string;
  appSecret?: string;
  proxyUrl?: string;
  force: boolean;
  noStart: boolean;
  noService: boolean;
  nonInteractive: boolean;
  help: boolean;
}

export function parseInstallCliArguments(
  argv: string[],
  cwd = process.cwd(),
): InstallCliArguments {
  let command: InstallCliArguments["command"] = "install";
  let configPath = resolve(cwd, "config.json");
  let dbPath = resolve(cwd, "runtime", "bridge.db");
  let executionMode: ExecutionMode = DEFAULT_EXECUTION_MODE;
  let codexPath: string | undefined;
  let repoPath: string | undefined;
  let appId: string | undefined;
  let appSecret: string | undefined;
  let proxyUrl: string | undefined;
  let force = false;
  let noStart = false;
  let noService = false;
  let nonInteractive = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "install" || arg === "init" || arg === "doctor") {
      command = arg;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--no-start") {
      noStart = true;
      continue;
    }
    if (arg === "--no-service") {
      noService = true;
      continue;
    }
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }

    const option = readOption(argv, index, arg, [
      "--config",
      "--db",
      "--mode",
      "--execution-mode",
      "--codex",
      "--codex-path",
      "--repo",
      "--app-id",
      "--app-secret",
      "--proxy",
    ]);
    if (option) {
      const [name, value, consumed] = option;
      if (name === "--config") configPath = resolve(cwd, value);
      else if (name === "--db") dbPath = resolve(cwd, value);
      else if (name === "--mode" || name === "--execution-mode") executionMode = parseExecutionMode(value);
      else if (name === "--codex" || name === "--codex-path") codexPath = resolve(cwd, value);
      else if (name === "--repo") repoPath = resolve(cwd, value);
      else if (name === "--app-id") appId = value;
      else if (name === "--app-secret") appSecret = value;
      else if (name === "--proxy") proxyUrl = value;
      index += consumed;
      continue;
    }
    throw new Error(`未知安装参数：${arg}`);
  }

  return {
    command,
    configPath,
    dbPath,
    executionMode,
    codexPath,
    repoPath,
    appId,
    appSecret,
    proxyUrl,
    force,
    noStart,
    noService,
    nonInteractive,
    help,
  };
}

export async function runInstallCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseInstallCliArguments(argv);
  if (args.help) {
    printInstallUsage();
    return;
  }

  if (args.command === "init") {
    await initializeConfig(args);
    return;
  }
  if (args.command === "doctor") {
    await runDoctor(args);
    return;
  }

  await ensureBuiltRuntime();
  console.log("[1/3] 初始化配置");
  await initializeConfig(args);
  await ensureDirectFeishuCredentials(args);
  console.log("[2/3] 检查运行环境");
  await runDoctor(args);
  if (args.noService) {
    console.log("[3/3] 已跳过后台服务安装（--no-service）");
    return;
  }
  console.log("[3/3] 安装后台服务");
  const serviceArgs = [
    "install",
    "--config",
    args.configPath,
    "--db",
    args.dbPath,
    "--mode",
    args.executionMode,
    ...(args.noStart ? [] : ["--start"]),
  ];
  await runCodexCli(serviceArgs);
  console.log(args.noStart ? "安装完成。执行 `feishu-codex-bridge service start` 启动服务。" : "安装完成，后台服务已启动。");
}

export function printInstallUsage(): void {
  console.log([
    "用法：feishu-codex-bridge install [选项]",
    "",
    "install 会依次执行：初始化配置 → doctor 检查 → 安装并启动后台服务。",
    "已有 config.json 时默认保留，不会覆盖。",
    "",
    "选项：",
    "  --config path       配置文件（默认：./config.json）",
    "  --db path           SQLite 文件（默认：./runtime/bridge.db）",
    "  --mode MODE         执行模式（默认：feishu-sqlite-codex）",
    "  --repo path         初始化时登记的 Git 仓库",
    "  --codex path        Codex CLI 路径",
    "  --app-id ID         Feishu App ID",
    "  --app-secret SECRET Feishu App Secret",
    "  --proxy URL         同时设置 HTTP/HTTPS 代理，可省略",
    "  --no-start          只安装服务，不启动",
    "  --no-service        只初始化并检查，不安装服务",
    "  --force             覆盖已有配置（请谨慎使用）",
    "  --non-interactive   缺少参数时直接失败，不进入交互询问",
  ].join("\n"));
}

async function initializeConfig(args: InstallCliArguments): Promise<void> {
  if (existsSync(args.configPath) && !args.force) {
    await repairExistingCodexPath(args.configPath);
    console.log(`保留已有配置：${args.configPath}`);
    return;
  }

  const values = await collectInitValues(args);
  const config = buildDirectConfig(values);
  await mkdir(dirname(args.configPath), { recursive: true, mode: 0o700 });
  await writeFile(args.configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(args.configPath, 0o600);
  console.log(`已生成配置：${args.configPath}`);
}

export interface DirectInitValues {
  repoPath: string;
  codexPath: string;
  appId?: string;
  appSecret?: string;
  proxyUrl?: string;
}

export function buildDirectConfig(values: DirectInitValues): Record<string, unknown> {
  const proxy = values.proxyUrl?.trim();
  return {
    execution: { mode: DEFAULT_EXECUTION_MODE },
    aamp: { enabled: false, stopOnShutdown: false },
    relay: { enabled: false },
    direct: {
      projectKey: "default",
      mode: "implement",
      feishu: {
        ...(values.appId ? { appId: values.appId } : {}),
        ...(values.appSecret ? { appSecret: values.appSecret } : {}),
        appIdEnv: "FEISHU_APP_ID",
        appSecretEnv: "FEISHU_APP_SECRET",
        groupAllowlist: [],
        dmMode: "open",
        dmAllowlist: [],
        allowedSenderOpenIds: [],
        requireMention: true,
        replyInThread: false,
      },
      permissions: {
        defaultAllow: true,
        allowAttachments: true,
        allowCancel: true,
        rules: [],
      },
    },
    web: { enabled: true, host: "127.0.0.1", port: 7310 },
    lark: {
      profile: "direct",
      tasklistGuid: "direct-tasklist",
      projectFieldGuid: "direct-project-field",
      modeFieldGuid: "direct-mode-field",
    },
    codex: {
      cliPath: values.codexPath,
      env: {
        ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}),
      },
    },
    projects: {
      default: { optionGuid: "direct-project-option", repo: values.repoPath },
    },
    modes: {
      implement: { optionGuid: "direct-mode-option", sandboxMode: "workspace-write" },
    },
  };
}

async function collectInitValues(args: InstallCliArguments): Promise<DirectInitValues> {
  const defaultRepo = args.repoPath ?? (isGitRepository(process.cwd()) ? process.cwd() : undefined);
  const detectedCodex = args.codexPath
    ? { path: args.codexPath, source: undefined }
    : resolveCodexCliPath();
  const defaultCodex = detectedCodex?.path;
  const defaultAppId = args.appId ?? process.env.FEISHU_APP_ID;
  const defaultAppSecret = args.appSecret ?? process.env.FEISHU_APP_SECRET;
  const defaultProxy = args.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (detectedCodex && detectedCodex.source) {
    console.log(`自动找到 Codex：${detectedCodex.path}（${codexPathSourceLabel(detectedCodex.source)}）`);
  }

  if (args.nonInteractive || !input.isTTY || !output.isTTY) {
    if (!defaultRepo) throw new Error("初始化需要 Git 仓库路径：请使用 --repo path");
    if (!defaultCodex) {
      throw new Error(
        "未找到可用的 Codex。请先安装 ChatGPT App，或使用官方 Codex CLI 安装程序后重试。",
      );
    }
    return {
      repoPath: defaultRepo,
      codexPath: defaultCodex,
      appId: defaultAppId,
      appSecret: defaultAppSecret,
      proxyUrl: defaultProxy,
    };
  }

  const readline = createInterface({ input, output });
  try {
    const repoPath = await ask(readline, "Git 仓库路径", defaultRepo);
    if (!repoPath || !isGitRepository(repoPath)) {
      throw new Error(`不是有效的 Git 仓库：${repoPath || "(空)"}`);
    }
    const codexPath = await ask(readline, "Codex CLI 路径", defaultCodex);
    if (!codexPath) throw new Error("Codex CLI 路径不能为空");
    const appId = await ask(readline, "Feishu App ID（留空则通过飞书授权创建）", defaultAppId);
    const appSecret = await ask(readline, "Feishu App Secret（留空则通过飞书授权创建）", defaultAppSecret);
    const proxyUrl = await ask(readline, "代理地址（可留空）", defaultProxy);
    return {
      repoPath: resolve(repoPath),
      codexPath: resolve(codexPath),
      appId: appId || undefined,
      appSecret: appSecret || undefined,
      proxyUrl: proxyUrl || undefined,
    };
  } finally {
    readline.close();
  }
}

async function ensureDirectFeishuCredentials(args: InstallCliArguments): Promise<void> {
  if (!isDirectExecutionMode(args.executionMode)) return;
  const config = loadConfig(args.configPath, { executionMode: args.executionMode });
  try {
    resolveSharedFeishuCredentials(config);
    return;
  } catch (error) {
    if (args.nonInteractive || !input.isTTY || !output.isTTY) throw error;
    console.log("未找到直连 Feishu 凭据，开始独立的飞书 Bot 授权流程…");
    const setup = await setupDirectFeishuCredentials(args.configPath, {
      appName: "Feishu Codex Bridge",
      openUrl: true,
    });
    console.log(`授权完成：${setup.appName}（${setup.appId}）`);
  }

  const refreshed = loadConfig(args.configPath, { executionMode: args.executionMode });
  try {
    resolveSharedFeishuCredentials(refreshed);
  } catch (error) {
    throw new Error(
      `飞书授权后仍未找到直连凭据：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function repairExistingCodexPath(configPath: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(raw)) return;

  const codex = isRecord(raw.codex) ? raw.codex : {};
  const configuredPath = typeof codex.cliPath === "string" ? codex.cliPath : undefined;
  if (configuredPath && isExecutableCodexPath(configuredPath)) return;

  const detected = resolveCodexCliPath();
  if (!detected || detected.path === configuredPath) return;

  codex.cliPath = detected.path;
  raw.codex = codex;
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8" });
  chmodSync(configPath, 0o600);
  console.log(`已自动更新 Codex 路径：${detected.path}（${codexPathSourceLabel(detected.source)}）`);
}

async function ask(
  readline: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
  hideDefault = true,
): Promise<string> {
  const suffix = defaultValue && !hideDefault ? ` [${defaultValue}]` : defaultValue ? " [已检测到，回车使用]" : "";
  const value = (await readline.question(`${label}${suffix}：`)).trim();
  return value || defaultValue || "";
}

async function runDoctor(args: InstallCliArguments): Promise<void> {
  await runCodexCli([
    "doctor",
    "--config",
    args.configPath,
    "--db",
    args.dbPath,
    "--mode",
    args.executionMode,
  ]);
}

async function ensureBuiltRuntime(): Promise<void> {
  const mainPath = join(PROJECT_ROOT, "dist", "main.js");
  const sourceEntry = join(PROJECT_ROOT, "src", "main.ts");
  if (existsSync(sourceEntry)) {
    console.log("正在构建 Bridge…");
    await runCommand(process.env.PNPM_BIN || "pnpm", ["run", "build"]);
  }
  if (!existsSync(mainPath)) {
    throw new Error("构建后仍找不到 dist/main.js；请检查构建日志。发布包应当预先包含 dist/。");
  }
}

function isGitRepository(path: string): boolean {
  try {
    return execFileSync("git", ["-C", resolve(path), "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOption(
  argv: string[],
  index: number,
  arg: string,
  names: string[],
): [string, string, number] | undefined {
  const name = names.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
  if (!name) return undefined;
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    if (!value) throw new Error(`${name} 需要一个值`);
    return [name, value, 0];
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return [name, value, 1];
}

function runCommand(file: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: PROJECT_ROOT, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${file} ${args.join(" ")} 退出码：${code ?? "unknown"}`));
    });
  });
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  runInstallCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
