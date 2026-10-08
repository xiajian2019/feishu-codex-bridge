import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPortableRelease,
  parsePortableReleaseArguments,
} from "./build-bun-single-binary-release.mjs";
import { updatePortableRelease } from "./update-portable-release.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RELEASE_DIR = join(PROJECT_ROOT, "release");
const DEFAULT_INSTALL_ROOT = join(homedir(), "Applications", "Feishu Codex Bridge");

export function parsePortableDeployArguments(argv, cwd = process.cwd()) {
  let installRoot = resolve(
    process.env.FEISHU_CODEX_BRIDGE_INSTALL_ROOT || DEFAULT_INSTALL_ROOT,
  );
  let releaseDir = DEFAULT_RELEASE_DIR;
  let configPath;
  let dbPath;
  let executionMode = "feishu-sqlite-codex";
  let skipBuild = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }

    const option = readOption(argv, index, arg, [
      "--root",
      "--output",
      "--config",
      "--db",
      "--mode",
      "--execution-mode",
    ]);
    if (!option) throw new Error(`未知参数：${arg}`);
    const [name, value, consumed] = option;
    if (name === "--root") installRoot = resolve(cwd, value);
    else if (name === "--output") releaseDir = resolve(cwd, value);
    else if (name === "--config") configPath = resolve(cwd, value);
    else if (name === "--db") dbPath = resolve(cwd, value);
    else if (name === "--mode" || name === "--execution-mode") executionMode = value;
    index += consumed;
  }

  return {
    installRoot,
    releaseDir: resolve(cwd, releaseDir),
    configPath: configPath || join(installRoot, "config.json"),
    dbPath: dbPath || join(installRoot, "runtime", "bridge.db"),
    executionMode,
    skipBuild,
    help,
  };
}

export async function deployPortableRelease(options = {}) {
  const projectRoot = resolve(options.projectRoot || PROJECT_ROOT);
  const installRoot = resolve(options.installRoot || DEFAULT_INSTALL_ROOT);
  const releaseDir = resolve(options.releaseDir || join(projectRoot, "release"));
  const configPath = resolve(options.configPath || join(installRoot, "config.json"));
  const dbPath = resolve(options.dbPath || join(installRoot, "runtime", "bridge.db"));
  const executionMode = options.executionMode || "feishu-sqlite-codex";

  assertExistingInstall({
    installRoot,
    releaseDir,
    configPath,
    dbPath,
  });

  const buildOptions = parsePortableReleaseArguments(["--output", releaseDir], projectRoot);
  buildOptions.skipBuild = options.skipBuild === true;
  console.log(`构建 Portable Runtime：${releaseDir}`);
  const buildResult = await (options.buildRelease || buildPortableRelease)(buildOptions);
  if (!buildResult?.archivePath || !existsSync(buildResult.archivePath)) {
    throw new Error("Portable 发布包未生成，取消安装目录更新。");
  }

  console.log(`部署到现有安装目录：${installRoot}`);
  const update = options.updateRelease || updatePortableRelease;
  const updateResult = await update({
    root: installRoot,
    file: buildResult.archivePath,
    mode: "auto",
    restart: true,
  });

  const launcher = installedLauncherPath(installRoot);
  if (!existsSync(launcher)) throw new Error(`安装目录启动器不存在：${launcher}`);
  const runCommand = options.runCommand || run;
  const serviceArgs = [
    "--config",
    configPath,
    "--db",
    dbPath,
    "--mode",
    executionMode,
  ];

  console.log("启动并检查已安装的 Bridge 服务…");
  await runCommand(launcher, ["service", "start", ...serviceArgs], installRoot);
  await runCommand(launcher, ["service", "status", ...serviceArgs], installRoot);
  return {
    installRoot,
    releaseDir,
    archivePath: buildResult.archivePath,
    launcher,
    configPath,
    dbPath,
    executionMode,
    updateResult,
  };
}

function assertExistingInstall({ installRoot, releaseDir, configPath, dbPath }) {
  if (!existsSync(installRoot)) {
    throw new Error(`Portable 安装目录不存在：${installRoot}`);
  }
  const installedManifest = [
    join(installRoot, "current", "release-manifest.json"),
    join(installRoot, "release-manifest.json"),
  ].find(existsSync);
  if (!installedManifest || !existsSync(installedLauncherPath(installRoot))) {
    throw new Error(`目录中没有可更新的 Portable Runtime 安装：${installRoot}`);
  }
  if (!existsSync(configPath)) throw new Error(`安装配置不存在：${configPath}`);
  if (!existsSync(dbPath)) throw new Error(`运行数据库不存在：${dbPath}`);

  const outputPath = relative(installRoot, releaseDir);
  const outputIsInsideInstall = outputPath === ""
    || (!isAbsolute(outputPath) && outputPath !== ".." && !outputPath.startsWith(`..${sep}`));
  if (outputIsInsideInstall) {
    throw new Error(`构建输出不能放在固定安装目录内：${releaseDir}`);
  }
}

function installedLauncherPath(installRoot) {
  const versionedLauncher = join(installRoot, "current", "feishu-codex-bridge");
  return existsSync(versionedLauncher)
    ? versionedLauncher
    : join(installRoot, "feishu-codex-bridge");
}

function readOption(argv, index, arg, names) {
  const name = names.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
  if (!name) return undefined;
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    if (!value) throw new Error(`${name} 需要一个路径或执行模式`);
    return [name, value, 0];
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个路径或执行模式`);
  return [name, value, 1];
}

function printUsage() {
  console.log([
    "用法：bun run portable:deploy [选项]",
    "",
    "构建当前源码，将 Portable Runtime 更新到已有安装目录并启动 Bridge 服务。",
    "",
    "选项：",
    "  --root path       已有安装目录（默认：~/Applications/Feishu Codex Bridge）",
    "  --output path     release 包输出目录（默认：./release）",
    "  --config path     已安装配置文件",
    "  --db path         已安装 SQLite 数据库",
    "  --mode MODE       Bridge 执行模式（默认：feishu-sqlite-codex）",
    "  --skip-build      使用现有 dist 构建发布包",
  ].join("\n"));
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
  try {
    const options = parsePortableDeployArguments(process.argv.slice(2));
    if (options.help) printUsage();
    else await deployPortableRelease(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
