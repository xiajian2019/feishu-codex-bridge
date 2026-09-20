import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_GITHUB_REPOSITORY = "xiajian2019/feishu-codex-bridge";

export function parsePortableUpdateArguments(argv, cwd = process.cwd()) {
  const options = {
    root: resolve(cwd),
    file: undefined,
    repository: process.env.FEISHU_CODEX_BRIDGE_GITHUB_REPO || DEFAULT_GITHUB_REPOSITORY,
    tag: "latest",
    mode: "lite",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" || arg === "--github") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--file" || arg.startsWith("--file=")) {
      const value = readOption(argv, index, arg, "--file");
      options.file = resolve(cwd, value.value);
      index += value.consumed;
      continue;
    }
    if (arg === "--root" || arg.startsWith("--root=")) {
      const value = readOption(argv, index, arg, "--root");
      options.root = resolve(cwd, value.value);
      index += value.consumed;
      continue;
    }
    if (arg === "--repo" || arg.startsWith("--repo=")) {
      const value = readOption(argv, index, arg, "--repo");
      options.repository = value.value;
      index += value.consumed;
      continue;
    }
    if (arg === "--tag" || arg.startsWith("--tag=")) {
      const value = readOption(argv, index, arg, "--tag");
      options.tag = value.value;
      index += value.consumed;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const value = readOption(argv, index, arg, "--mode");
      if (!["auto", "lite", "direct"].includes(value.value)) {
        throw new Error(`未知更新模式：${value.value}`);
      }
      options.mode = value.value;
      index += value.consumed;
      continue;
    }
    if (!arg.startsWith("--") && !options.file) {
      options.file = resolve(cwd, arg);
      continue;
    }
    throw new Error(`未知更新参数：${arg}`);
  }
  return options;
}

export function updateAssetName(platform = process.platform, arch = process.arch, mode = "lite") {
  const platformName = platform === "darwin" ? "darwin" : undefined;
  const archName = { arm64: "arm64", x64: "x64" }[arch];
  if (!platformName || !archName) throw new Error(`当前系统不支持 Portable 更新：${platform}/${arch}`);
  return mode === "direct"
    ? `feishu-codex-bridge-direct-${platformName}-${archName}.tar.gz`
    : `feishu-codex-bridge-${platformName}-${archName}.tar.gz`;
}

export async function updatePortableRelease(options = {}) {
  const root = resolve(options.root || process.cwd());
  const currentMode = await readInstalledMode(root);
  const mode = options.mode && options.mode !== "auto" ? options.mode : "lite";
  const archivePath = options.file
    ? resolve(options.file)
    : await downloadGithubAsset({
      repository: options.repository || DEFAULT_GITHUB_REPOSITORY,
      tag: options.tag || "latest",
      assetName: updateAssetName(process.platform, process.arch, mode),
    });
  try {
    const result = await replaceInstalledPackage(root, archivePath, { expectedMode: mode, currentMode });
    console.log(`更新完成：${result.mode} ${result.sourcePackage}`);
    return result;
  } finally {
    if (!options.file) await rm(archivePath, { force: true });
  }
}

export function printPortableUpdateUsage() {
  console.log([
    "用法：feishu-codex-bridge update [选项]",
    "",
    "默认从 GitHub 最新 Release 下载 Lite 包并替换应用文件；直连包会保留本地 lark-cli 依赖。",
    "",
    "选项：",
    "  --root path           当前 Portable 包目录（通常由启动器自动传入）",
    "  --file path           使用本地 tar.gz 更新包，不访问 GitHub",
    "  --repo owner/name     GitHub 仓库（默认：xiajian2019/feishu-codex-bridge）",
    "  --tag TAG             GitHub tag；默认 latest",
    "  --mode lite|direct  更新包模式；默认 lite",
    "",
    "示例：",
    "  feishu-codex-bridge update",
    "  feishu-codex-bridge update --file ./feishu-codex-bridge-darwin-arm64.tar.gz",
  ].join("\n"));
}

async function downloadGithubAsset({ repository, tag, assetName }) {
  const endpoint = tag === "latest"
    ? `https://github.com/${repository}/releases/latest/download/${assetName}`
    : `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${assetName}`;
  console.log(`从 GitHub 下载更新包：${endpoint}`);
  const response = await fetch(endpoint, { redirect: "follow", headers: { "user-agent": "feishu-codex-bridge-updater" } });
  if (!response.ok) throw new Error(`GitHub 更新包下载失败：HTTP ${response.status}`);
  const directory = await mkdtemp(join(tmpdir(), "feishu-codex-update-download-"));
  const path = join(directory, assetName);
  const content = Buffer.from(await response.arrayBuffer());
  await writeFile(path, content, { mode: 0o600 });
  const checksumResponse = await fetch(`${endpoint}.sha256`, { redirect: "follow", headers: { "user-agent": "feishu-codex-bridge-updater" } });
  if (checksumResponse.ok) {
    const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(content).digest("hex");
    if (!expected || expected !== actual) throw new Error("GitHub 更新包 SHA-256 校验失败");
  }
  return path;
}

async function replaceInstalledPackage(root, archivePath, { expectedMode, currentMode }) {
  const staging = await mkdtemp(join(tmpdir(), "feishu-codex-update-stage-"));
  const backup = join(root, `.update-backup-${Date.now()}`);
  let backupCreated = false;
  try {
    await run("tar", ["-xzf", archivePath, "-C", staging]);
    const sourcePackage = await findExtractedPackage(staging);
    const sourceMode = await readPackageMode(sourcePackage);
    if (expectedMode !== "auto" && sourceMode !== expectedMode) {
      throw new Error(`更新包模式不匹配：当前期望 ${expectedMode}，实际为 ${sourceMode}`);
    }
    await validatePackage(sourcePackage);

    if (currentMode === "direct" && sourceMode === "lite") {
      return await overlayLitePackage(root, sourcePackage, staging);
    }

    await mkdirIfNeeded(backup);
    backupCreated = true;
    await moveIfExists(join(root, "app"), join(backup, "app"));
    await moveIfExists(join(root, "feishu-codex-bridge"), join(backup, "feishu-codex-bridge"));
    await moveIfExists(join(root, "install.command"), join(backup, "install.command"));
    await moveIfExists(join(root, "README.md"), join(backup, "README.md"));
    await moveIfExists(join(root, "release-manifest.json"), join(backup, "release-manifest.json"));
    await cp(join(sourcePackage, "app"), join(root, "app"), { recursive: true, verbatimSymlinks: true });
    await cp(join(sourcePackage, "feishu-codex-bridge"), join(root, "feishu-codex-bridge"), { force: true });
    await cp(join(sourcePackage, "install.command"), join(root, "install.command"), { force: true });
    await cp(join(sourcePackage, "README.md"), join(root, "README.md"), { force: true });
    if (await exists(join(sourcePackage, "release-manifest.json"))) {
      await cp(join(sourcePackage, "release-manifest.json"), join(root, "release-manifest.json"), { force: true });
    }
    await chmodIfPresent(join(root, "feishu-codex-bridge"), 0o755);
    await chmodIfPresent(join(root, "install.command"), 0o755);

    // Preserve config.json and runtime/ data. Only replace the bundled direct
    // Node archive when the new package carries one.
    const sourceNodeArchive = join(sourcePackage, "runtime", "node-universal.tar.gz");
    if (await exists(sourceNodeArchive)) {
      await mkdirIfNeeded(join(root, "runtime"));
      await rm(join(root, "runtime", "node-universal"), { recursive: true, force: true });
      await cp(sourceNodeArchive, join(root, "runtime", "node-universal.tar.gz"), { force: true });
    }
    await rm(backup, { recursive: true, force: true });
    backupCreated = false;
    return { mode: sourceMode, sourcePackage: basename(sourcePackage) };
  } catch (error) {
    if (backupCreated) {
      await rm(join(root, "app"), { recursive: true, force: true });
      await rm(join(root, "feishu-codex-bridge"), { force: true });
      await rm(join(root, "install.command"), { force: true });
      await rm(join(root, "README.md"), { force: true });
      await rm(join(root, "release-manifest.json"), { force: true });
      await moveIfExists(join(backup, "app"), join(root, "app"));
      await moveIfExists(join(backup, "feishu-codex-bridge"), join(root, "feishu-codex-bridge"));
      await moveIfExists(join(backup, "install.command"), join(root, "install.command"));
      await moveIfExists(join(backup, "README.md"), join(root, "README.md"));
      await moveIfExists(join(backup, "release-manifest.json"), join(root, "release-manifest.json"));
      await rm(backup, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function overlayLitePackage(root, sourcePackage, staging) {
  const backup = join(root, `.update-backup-${Date.now()}`);
  let backupCreated = false;
  const relativePaths = [
    "app/dist",
    "app/scripts",
    "app/config.example.json",
    "feishu-codex-bridge",
    "install.command",
    "README.md",
  ];
  try {
    await mkdirIfNeeded(backup);
    backupCreated = true;
    for (const relativePath of relativePaths) {
      await moveIfExists(join(root, relativePath), join(backup, relativePath));
    }
    for (const relativePath of relativePaths) {
      const source = join(sourcePackage, relativePath);
      if (!(await exists(source))) continue;
      await mkdirIfNeeded(dirname(join(root, relativePath)));
      await cp(source, join(root, relativePath), { recursive: true, verbatimSymlinks: true });
    }
    await chmodIfPresent(join(root, "feishu-codex-bridge"), 0o755);
    await chmodIfPresent(join(root, "install.command"), 0o755);
    await rm(backup, { recursive: true, force: true });
    return { mode: "lite-overlay", sourcePackage: basename(sourcePackage) };
  } catch (error) {
    if (backupCreated) {
      for (const relativePath of relativePaths) {
        await rm(join(root, relativePath), { recursive: true, force: true });
        await moveIfExists(join(backup, relativePath), join(root, relativePath));
      }
      await rm(backup, { recursive: true, force: true });
    }
    throw error;
  }
}

async function readInstalledMode(root) {
  try {
    const packageJson = JSON.parse(await readFile(join(root, "app", "package.json"), "utf8"));
    return packageJson.dependencies?.["@larksuite/cli"] ? "direct" : "lite";
  } catch {
    return "direct";
  }
}

async function readPackageMode(packageRoot) {
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, "release-manifest.json"), "utf8"));
    if (manifest.mode === "direct" || manifest.mode === "lite") return manifest.mode;
  } catch {}
  try {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "app", "package.json"), "utf8"));
    return packageJson.dependencies?.["@larksuite/cli"] ? "direct" : "lite";
  } catch {
    return "lite";
  }
}

async function findExtractedPackage(staging) {
  const entries = await readdir(staging, { withFileTypes: true });
  const directory = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("feishu-codex-bridge-"));
  if (!directory) throw new Error("更新包中找不到 Bridge 根目录");
  return join(staging, directory.name);
}

async function validatePackage(packageRoot) {
  for (const required of ["app/dist/main.js", "app/package.json", "feishu-codex-bridge"]) {
    if (!(await exists(join(packageRoot, required)))) throw new Error(`更新包不完整，缺少 ${required}`);
  }
  const expectedArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (!basename(packageRoot).includes(`darwin-${expectedArch}`)) {
    throw new Error(`更新包 CPU/平台不匹配：${basename(packageRoot)}，当前为 darwin-${expectedArch}`);
  }
}

async function moveIfExists(source, destination) {
  if (await exists(source)) {
    await mkdirIfNeeded(dirname(destination));
    await rename(source, destination);
  }
}

async function mkdirIfNeeded(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function chmodIfPresent(path, mode) {
  if (await exists(path)) await chmod(path, mode);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readOption(argv, index, arg, name) {
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return { value, consumed: 1 };
}

function run(file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, { stdio: "inherit", shell: false });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${file} ${args.join(" ")} 退出码：${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parsePortableUpdateArguments(process.argv.slice(2));
  if (args.help) printPortableUpdateUsage();
  else updatePortableRelease(args).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
