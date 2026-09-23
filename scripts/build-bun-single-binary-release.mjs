import { resolve, join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPortableRelease as buildLegacyPortableRelease,
  targetName as legacyTargetName,
} from "./build-portable-release.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, "release");
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
).version;

export function parseBunSingleBinaryReleaseArguments(argv, cwd = process.cwd()) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    bunPath: process.execPath,
    skipBuild: false,
    keepSourceMaps: false,
    json: false,
    help: false,
    mode: "direct",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      args.skipBuild = true;
      continue;
    }
    if (arg === "--keep-source-maps") {
      args.keepSourceMaps = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=") || arg === "--bundle-bun") {
      throw new Error("新的 release 只支持 Bun 单一二进制包；旧模式请使用 bun run release:legacy");
    }
    const option = readOption(argv, index, arg, ["--output", "--bun"]);
    if (!option) throw new Error("未知参数：" + arg);
    const [name, value, consumed] = option;
    if (name === "--output") args.outputDir = resolve(cwd, value);
    if (name === "--bun") args.bunPath = resolve(cwd, value);
    index += consumed;
  }
  return args;
}

export const parsePortableReleaseArguments = parseBunSingleBinaryReleaseArguments;

export async function buildBunSingleBinaryRelease(options = {}) {
  return buildLegacyPortableRelease({
    ...options,
    mode: "direct",
    versionedNames: true,
  });
}

export const buildPortableRelease = buildBunSingleBinaryRelease;

export function targetName(
  platform = process.platform,
  arch = process.arch,
  mode = "direct",
  version = PACKAGE_VERSION,
) {
  return legacyTargetName(platform, arch, mode, version);
}

function readOption(argv, index, arg, names) {
  const name = names.find((candidate) => arg === candidate || arg.startsWith(candidate + "="));
  if (!name) return undefined;
  if (arg.startsWith(name + "=")) {
    const value = arg.slice(name.length + 1);
    if (!value) throw new Error(name + " 需要一个值");
    return [name, value, 0];
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(name + " 需要一个值");
  return [name, value, 1];
}

function printUsage() {
  console.log([
    "用法：bun run release [选项]",
    "",
    "构建当前 macOS 架构的 Bun 单一二进制包。",
    "",
    "选项：",
    "  --output path          输出目录（默认：./release）",
    "  --bun path             用于构建的 Bun 可执行文件（默认：当前 Bun）",
    "  --skip-build           复用现有 dist，不重新执行 bun run build",
    "  --keep-source-maps     保留 dist 中的 source map",
    "  --json                 以 JSON 输出产物信息",
    "",
    "旧版 core/lite/direct 多模式打包：bun run release:legacy",
  ].join("\n"));
}

if (pathToFileURL(resolve(process.argv[1] || "")).href === import.meta.url) {
  try {
    const options = parseBunSingleBinaryReleaseArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      await buildBunSingleBinaryRelease(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
