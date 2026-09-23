#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const CLI_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CLI_PATH), "..");
const PACKAGE_JSON_PATH = resolve(PROJECT_ROOT, "package.json");
const INSTALL_RUNTIME_PATH = resolve(PROJECT_ROOT, "dist", "install-cli.js");

export function readPackageManifest(packagePath = PACKAGE_JSON_PATH) {
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

export function resolveInvocation(args, scriptNames) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }
  if (args[0] === "--version" || args[0] === "-v") {
    return { kind: "version" };
  }
  if (args[0] === "list" || args[0] === "scripts") {
    return { kind: "list" };
  }

  const builtin = resolveBuiltinInvocation(args, scriptNames);
  if (builtin) return builtin;

  const invocationArgs = [...args];
  if (invocationArgs[0] === "run") invocationArgs.shift();
  const script = invocationArgs.shift();
  if (!script || !scriptNames.includes(script)) {
    return {
      kind: "error",
      script,
      message: script
        ? `未知脚本：${script}`
        : "缺少脚本名称",
    };
  }

  const forwarded = invocationArgs[0] === "--"
    ? invocationArgs
    : invocationArgs.length > 0
      ? ["--", ...invocationArgs]
      : [];
  return { kind: "run", script, args: forwarded };
}

function forwardedArguments(args) {
  return args.length > 0 ? ["--", ...args] : [];
}

export function resolveBuiltinInvocation(args, scriptNames) {
  if (scriptNames.includes("bridge:install") && args[0] === "install") {
    return { kind: "run", script: "bridge:install", args: forwardedArguments(args.slice(1)) };
  }
  if (scriptNames.includes("bridge:install") && args[0] === "init") {
    return {
      kind: "run",
      script: "bridge:install",
      args: ["init", ...forwardedArguments(args.slice(1))],
    };
  }
  if (scriptNames.includes("bridge:install") && args[0] === "doctor") {
    return {
      kind: "run",
      script: "bridge:install",
      args: ["doctor", ...forwardedArguments(args.slice(1))],
    };
  }

  if (args[0] === "service" && args[1]) {
    const serviceScripts = {
      install: "codex:install",
      start: "codex:start",
      stop: "codex:stop",
      restart: "codex:restart",
      status: "codex:status",
      logs: "codex:logs",
      uninstall: "codex:uninstall",
    };
    const script = serviceScripts[args[1]];
    if (script && scriptNames.includes(script)) {
      return { kind: "run", script, args: forwardedArguments(args.slice(2)) };
    }
  }

  return undefined;
}

export function buildBunArguments(invocation) {
  return ["run", invocation.script, ...invocation.args];
}

export function buildCommand(
  invocation,
  bun = process.env.BUN_BIN || "bun",
  installRuntimePath = INSTALL_RUNTIME_PATH,
) {
  if (invocation.kind === "run"
    && invocation.script === "bridge:install"
    && existsSync(installRuntimePath)) {
    return {
      file: process.execPath,
      args: [installRuntimePath, ...invocation.args],
    };
  }
  return { file: bun, args: buildBunArguments(invocation) };
}

export function usage(scriptNames) {
  return [
    "用法：",
    "  feishu-codex-bridge install       初始化、检查并安装/启动服务",
    "  feishu-codex-bridge init          只初始化配置",
    "  feishu-codex-bridge doctor        只执行环境检查",
    "  feishu-codex-bridge service <命令> 管理后台服务",
    "  feishu-codex-bridge <script> [-- <参数...>]",
    "  feishu-codex-bridge run <script> [-- <参数...>]",
    "  feishu-codex-bridge list",
    "",
    "示例：",
    "  feishu-codex-bridge aamp:status",
    "  feishu-codex-bridge aamp:task -- ff96da58",
    "  feishu-codex-bridge codex:status",
    "  feishu-codex-bridge codex:install -- --mode feishu-sqlite-codex",
    "  feishu-codex-bridge codex:recent -- --limit 10",
    "  feishu-codex-bridge test",
    "",
    `可用脚本：${scriptNames.join(", ")}`,
  ].join("\n");
}

function main() {
  const manifest = readPackageManifest();
  const scripts = manifest.scripts && typeof manifest.scripts === "object"
    ? Object.keys(manifest.scripts)
    : [];
  const invocation = resolveInvocation(process.argv.slice(2), scripts);

  if (invocation.kind === "help") {
    console.log(usage(scripts));
    return 0;
  }
  if (invocation.kind === "version") {
    console.log(manifest.version || "0.0.0");
    return 0;
  }
  if (invocation.kind === "list") {
    console.log(scripts.join("\n"));
    return 0;
  }
  if (invocation.kind === "error") {
    console.error(`${invocation.message}。使用 feishu-codex-bridge list 查看可用脚本。`);
    return 2;
  }

  const command = buildCommand(invocation);
  const child = spawn(command.file, command.args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`无法启动 ${command.file}：${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 128 : 1);
  });
  return undefined;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(CLI_PATH);
if (isMain) {
  const exitCode = main();
  if (typeof exitCode === "number") process.exit(exitCode);
}
