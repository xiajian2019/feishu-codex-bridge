import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPortableRelease,
  parsePortableReleaseArguments,
  targetName,
} from "./build-bun-single-binary-release.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RELEASE_DIR = join(PROJECT_ROOT, "release");

export function parsePortableRestartArguments(argv, cwd = process.cwd()) {
  let configPath = resolve(cwd, "config.json");
  let dbPath = resolve(cwd, "runtime", "bridge.db");
  let releaseDir = DEFAULT_RELEASE_DIR;
  let executionMode = "feishu-sqlite-codex";
  let skipBuild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      const value = arg.startsWith("--config=") ? arg.slice("--config=".length) : argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--config 需要一个路径");
      configPath = resolve(cwd, value);
      continue;
    }
    if (arg === "--db" || arg.startsWith("--db=")) {
      const value = arg.startsWith("--db=") ? arg.slice("--db=".length) : argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--db 需要一个路径");
      dbPath = resolve(cwd, value);
      continue;
    }
    if (
      arg === "--mode"
      || arg === "--execution-mode"
      || arg.startsWith("--mode=")
      || arg.startsWith("--execution-mode=")
    ) {
      const prefix = arg.startsWith("--execution-mode=")
        ? "--execution-mode="
        : arg.startsWith("--mode=")
          ? "--mode="
          : undefined;
      const value = prefix ? arg.slice(prefix.length) : argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${prefix ? prefix.slice(0, -1) : arg} 需要一个执行模式`);
      executionMode = value;
      continue;
    }
    if (arg === "--output" || arg.startsWith("--output=")) {
      const value = arg.startsWith("--output=") ? arg.slice("--output=".length) : argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--output 需要一个路径");
      releaseDir = resolve(cwd, value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { configPath, dbPath, releaseDir, executionMode, skipBuild };
}

export async function restartPortableRelease(options = {}) {
  const projectRoot = resolve(options.projectRoot || PROJECT_ROOT);
  const releaseDir = resolve(options.releaseDir || join(projectRoot, "release"));
  const configPath = resolve(options.configPath || join(projectRoot, "config.json"));
  const dbPath = resolve(options.dbPath || join(projectRoot, "runtime", "bridge.db"));
  const executionMode = options.executionMode || "feishu-sqlite-codex";
  const buildRelease = options.buildRelease || buildPortableRelease;
  const runCommand = options.runCommand || run;
  const target = targetName(process.platform, process.arch);
  const launcher = join(releaseDir, target, "feishu-codex-bridge");

  console.log(`构建 portable release：${releaseDir}`);
  const buildOptions = parsePortableReleaseArguments(["--output", releaseDir], projectRoot);
  buildOptions.skipBuild = options.skipBuild === true;
  await buildRelease(buildOptions);
  if (options.verifyLauncher !== false && !existsSync(launcher)) {
    throw new Error(`portable 启动器未生成：${launcher}`);
  }

  console.log("从新 release 重启 Codex 直连服务…");
  const serviceArgs = [
    "service",
    "restart",
    "--config",
    configPath,
    "--db",
    dbPath,
    "--mode",
    executionMode,
  ];
  await runCommand(launcher, serviceArgs, projectRoot);
  await runCommand(launcher, [
    "service",
    "status",
    "--config",
    configPath,
    "--db",
    dbPath,
    "--mode",
    executionMode,
  ], projectRoot);
  return { releaseDir, launcher, configPath, dbPath, executionMode };
}

function run(file, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${file} ${args.join(" ")} 退出码：${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

if (pathToFileURL(resolve(process.argv[1] || "")).href === import.meta.url) {
  const args = parsePortableRestartArguments(process.argv.slice(2));
  restartPortableRelease(args).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
