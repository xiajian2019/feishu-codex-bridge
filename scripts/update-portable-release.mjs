import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_GITHUB_REPOSITORY = "xiajian2019/feishu-codex-bridge";
const UPDATE_MODES = ["auto", "core", "lite", "direct"];
const SERVICE_LABEL = "com.local.feishu-codex-bridge";
const UPDATE_AGENT_LABEL = "com.local.feishu-codex-bridge-updater";
const DEFAULT_UPDATE_INTERVAL_SECONDS = 6 * 60 * 60;
const UPDATE_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
const SERVICE_WAIT_TIMEOUT_MS = 30_000;
const SERVICE_POLL_INTERVAL_MS = 250;
const CORE_OVERLAY_PATHS = [
  "app/dist",
  "app/scripts",
  "app/config.example.json",
  "feishu-codex-bridge",
  "install.command",
  "install.defaults",
  "README.md",
];
const FULL_PACKAGE_PATHS = [
  "app",
  "feishu-codex-bridge",
  "install.command",
  "install.defaults",
  "README.md",
  "release-manifest.json",
];
const PACKAGE_RUNTIME_ENTRIES = [
  "node-universal.tar.gz",
  "node-universal",
  ".bundled-node",
  "bin",
  "lib",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
];
const ACTIVE_TASK_STATUSES = ["QUEUED", "RUNNING", "CANCEL_REQUESTED"];

export function parsePortableUpdateArguments(argv, cwd = process.cwd()) {
  const options = {
    root: resolve(cwd),
    file: undefined,
    repository: process.env.FEISHU_CODEX_BRIDGE_GITHUB_REPO || DEFAULT_GITHUB_REPOSITORY,
    tag: "latest",
    mode: "auto",
    check: false,
    auto: false,
    schedule: false,
    unschedule: false,
    quiet: false,
    restart: true,
    intervalSeconds: DEFAULT_UPDATE_INTERVAL_SECONDS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" || arg === "--github") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--auto") {
      options.auto = true;
      continue;
    }
    if (arg === "--schedule") {
      options.schedule = true;
      continue;
    }
    if (arg === "--unschedule") {
      options.unschedule = true;
      continue;
    }
    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "--no-restart") {
      options.restart = false;
      continue;
    }
    if (arg === "--restart") {
      options.restart = true;
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
      if (!UPDATE_MODES.includes(value.value)) {
        throw new Error(`未知更新模式：${value.value}`);
      }
      options.mode = value.value;
      index += value.consumed;
      continue;
    }
    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const value = readOption(argv, index, arg, "--interval");
      options.intervalSeconds = parsePositiveInteger(value.value, "--interval");
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

export function updateAssetName(platform = process.platform, arch = process.arch, mode = "core") {
  const platformName = platform === "darwin" ? "darwin" : undefined;
  const archName = { arm64: "arm64", x64: "x64" }[arch];
  if (!platformName || !archName) throw new Error(`当前系统不支持 Portable 更新：${platform}/${arch}`);
  const resolvedMode = mode === "auto" ? "core" : mode;
  if (resolvedMode === "direct") return `feishu-codex-bridge-direct-${platformName}-${archName}.tar.gz`;
  if (resolvedMode === "lite") return `feishu-codex-bridge-${platformName}-${archName}.tar.gz`;
  if (resolvedMode === "core") return `feishu-codex-bridge-core-${platformName}-${archName}.tar.gz`;
  throw new Error(`未知更新模式：${mode}`);
}

export function buildPortableUpdaterPlist({ root, intervalSeconds = DEFAULT_UPDATE_INTERVAL_SECONDS } = {}) {
  const packageRoot = resolve(root || process.cwd());
  const launcher = join(packageRoot, "feishu-codex-bridge");
  const logDir = join(packageRoot, "runtime", "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(UPDATE_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(launcher)}</string>
    <string>update</string>
    <string>--auto</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(packageRoot)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, "portable-update.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, "portable-update.stderr.log"))}</string>
</dict>
</plist>
`;
}

export async function updatePortableRelease(options = {}) {
  const root = resolve(options.root || process.cwd());
  if (options.schedule) return installPortableUpdateSchedule(root, options.intervalSeconds);
  if (options.unschedule) return uninstallPortableUpdateSchedule();

  return withUpdateLock(root, async () => {
    if (options.check || options.auto) {
      const check = await checkPortableUpdate({
        root,
        repository: options.repository || DEFAULT_GITHUB_REPOSITORY,
        tag: options.tag || "latest",
      });
      if (!options.quiet) printUpdateCheck(check);
      if (options.check || !check.updateAvailable) return check;
      if (options.auto && await hasActivePortableWork(root)) {
        if (!options.quiet) console.log("检测到活动任务，已延后核心更新。");
        return { ...check, deferred: true };
      }
      return applyPortableRelease({
        ...options,
        root,
        mode: "core",
        check: false,
        auto: false,
      });
    }
    return applyPortableRelease({ ...options, root });
  });
}

export async function checkPortableUpdate({
  root,
  repository = DEFAULT_GITHUB_REPOSITORY,
  tag = "latest",
} = {}) {
  const currentVersion = await readInstalledVersion(resolve(root || process.cwd()));
  const release = await fetchGithubRelease({ repository, tag });
  const remoteVersion = release.version || release.tag;
  return {
    currentVersion: currentVersion || "0.0.0",
    remoteVersion,
    tag: release.tag,
    updateAvailable: compareVersions(remoteVersion, currentVersion || "0.0.0") > 0,
    coreAsset: updateAssetName(process.platform, process.arch, "core"),
    releaseUrl: release.html_url,
  };
}

export function printPortableUpdateUsage() {
  console.log([
    "用法：feishu-codex-bridge update [选项]",
    "",
    "默认从 GitHub 最新 Release 下载 Core 包，只替换 Bridge 核心文件，不下载 Node/lark-cli。",
    "下载、校验完成后才会短暂重启已运行的 LaunchAgent；失败时自动恢复旧文件。",
    "",
    "选项：",
    "  --root path           当前 Portable 包目录（通常由启动器自动传入）",
    "  --file path           使用本地 tar.gz 更新包，不访问 GitHub",
    "  --repo owner/name     GitHub 仓库（默认：xiajian2019/feishu-codex-bridge）",
    "  --tag TAG             GitHub tag；默认 latest",
    "  --mode auto|core|lite|direct",
    "                        auto：本地包自动识别；GitHub 默认使用 core",
    "  --check               只检查版本，不下载或修改文件",
    "  --auto                检查新版本并在无活动任务时自动应用 Core 更新",
    "  --schedule            安装每 6 小时检查一次的用户级 LaunchAgent",
    "  --unschedule          删除自动更新 LaunchAgent",
    "  --interval seconds    自定义自动检查间隔",
    "  --no-restart          更新文件但不自动重启已运行服务",
    "",
    "完整更新 direct 运行时：",
    "  feishu-codex-bridge update --mode direct",
    "本地包自动识别模式：",
    "  feishu-codex-bridge update --file ./update.tar.gz",
  ].join("\n"));
}

async function applyPortableRelease(options) {
  const root = resolve(options.root || process.cwd());
  const currentMode = await readInstalledMode(root);
  const requestedMode = options.mode || "auto";
  const remoteMode = requestedMode === "auto" ? "core" : requestedMode;
  let downloaded;
  let archivePath;
  let prepared;
  try {
    if (options.file) {
      archivePath = resolve(options.file);
    } else {
      downloaded = await downloadGithubAsset({
        repository: options.repository || DEFAULT_GITHUB_REPOSITORY,
        tag: options.tag || "latest",
        assetName: updateAssetName(process.platform, process.arch, remoteMode),
        quiet: options.quiet,
      });
      archivePath = downloaded.path;
    }

    prepared = await preparePackage(archivePath, options.file ? requestedMode : remoteMode);
    const shouldRestart = options.restart !== false && process.platform === "darwin";
    const serviceState = shouldRestart ? await getPortableServiceState() : { loaded: false, running: false };
    try {
      if (serviceState.loaded) {
        await stopPortableService(root);
        await waitForServiceState(false);
      }
      const result = await replaceInstalledPackage(root, prepared, {
        currentMode,
        onApplied: serviceState.loaded
          ? async () => {
              await startPortableService(root);
              await waitForServiceState(true);
            }
          : undefined,
      });
      if (!options.quiet) console.log(`更新完成：${result.mode} ${result.sourcePackage}`);
      return result;
    } catch (error) {
      if (serviceState.loaded) await restorePortableService(root);
      throw error;
    }
  } finally {
    if (prepared) await rm(prepared.staging, { recursive: true, force: true });
    if (downloaded) await rm(downloaded.directory, { recursive: true, force: true });
  }
}

async function downloadGithubAsset({ repository, tag, assetName, quiet = false }) {
  const endpoint = tag === "latest"
    ? `https://github.com/${repository}/releases/latest/download/${assetName}`
    : `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${assetName}`;
  if (!quiet) console.log(`从 GitHub 下载更新包：${endpoint}`);
  const response = await fetch(endpoint, {
    redirect: "follow",
    headers: { "user-agent": "feishu-codex-bridge-updater" },
  });
  if (!response.ok) throw new Error(`GitHub 更新包下载失败：HTTP ${response.status}`);
  const directory = await mkdtemp(join(tmpdir(), "feishu-codex-update-download-"));
  const path = join(directory, assetName);
  try {
    const content = Buffer.from(await response.arrayBuffer());
    await writeFile(path, content, { mode: 0o600 });
    const checksumResponse = await fetch(`${endpoint}.sha256`, {
      redirect: "follow",
      headers: { "user-agent": "feishu-codex-bridge-updater" },
    });
    if (!checksumResponse.ok) throw new Error(`GitHub 更新包缺少 SHA-256 校验文件：HTTP ${checksumResponse.status}`);
    const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(content).digest("hex");
    if (!expected || expected !== actual) throw new Error("GitHub 更新包 SHA-256 校验失败");
    return { path, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function fetchGithubRelease({ repository, tag }) {
  const endpoint = tag === "latest"
    ? `https://api.github.com/repos/${repository}/releases/latest`
    : `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetch(endpoint, {
    redirect: "follow",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "feishu-codex-bridge-updater",
    },
  });
  if (!response.ok) throw new Error(`GitHub 版本检查失败：HTTP ${response.status}`);
  const release = await response.json();
  return {
    tag: typeof release.tag_name === "string" ? release.tag_name : tag,
    version: normalizeVersion(release.tag_name || tag),
    html_url: typeof release.html_url === "string" ? release.html_url : undefined,
  };
}

async function preparePackage(archivePath, expectedMode) {
  const staging = await mkdtemp(join(tmpdir(), "feishu-codex-update-stage-"));
  try {
    await run("tar", ["-xzf", archivePath, "-C", staging]);
    const sourcePackage = await findExtractedPackage(staging);
    const sourceMode = await readPackageMode(sourcePackage);
    if (expectedMode !== "auto" && sourceMode !== expectedMode) {
      throw new Error(`更新包模式不匹配：当前期望 ${expectedMode}，实际为 ${sourceMode}`);
    }
    await validatePackage(sourcePackage, sourceMode);
    return { staging, sourcePackage, sourceMode };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function replaceInstalledPackage(root, prepared, { currentMode, onApplied }) {
  const { sourcePackage, sourceMode } = prepared;
  if (sourceMode === "core" || (currentMode === "direct" && sourceMode === "lite")) {
    return overlayPackage(root, sourcePackage, { currentMode, sourceMode, onApplied });
  }
  return replaceFullPackage(root, sourcePackage, { sourceMode, onApplied });
}

async function overlayPackage(root, sourcePackage, { currentMode, sourceMode, onApplied }) {
  const backup = join(root, `.update-backup-${Date.now()}-${process.pid}`);
  const touchedPaths = new Set();
  try {
    await mkdirIfNeeded(backup);
    for (const relativePath of CORE_OVERLAY_PATHS) {
      const source = join(sourcePackage, relativePath);
      if (!(await exists(source))) continue;
      await backupPath(root, backup, relativePath, touchedPaths);
      await movePath(source, join(root, relativePath));
    }
    await backupPath(root, backup, "release-manifest.json", touchedPaths);
    await writeMergedManifest(root, backup, sourcePackage, currentMode);
    if (onApplied) await onApplied();
    await rm(backup, { recursive: true, force: true });
    return {
      mode: `${sourceMode}-overlay`,
      sourcePackage: basename(sourcePackage),
    };
  } catch (error) {
    await restoreTouchedPaths(root, backup, touchedPaths);
    await rm(backup, { recursive: true, force: true });
    throw error;
  }
}

async function replaceFullPackage(root, sourcePackage, { sourceMode, onApplied }) {
  const backup = join(root, `.update-backup-${Date.now()}-${process.pid}`);
  const touchedPaths = new Set();
  try {
    await mkdirIfNeeded(backup);
    for (const relativePath of FULL_PACKAGE_PATHS) {
      const source = join(sourcePackage, relativePath);
      if (!(await exists(source))) continue;
      await backupPath(root, backup, relativePath, touchedPaths);
      await movePath(source, join(root, relativePath));
    }

    for (const entry of await packageRuntimeEntries(sourcePackage, sourceMode)) {
      const relativePath = join("runtime", entry);
      await backupPath(root, backup, relativePath, touchedPaths);
      const source = join(sourcePackage, relativePath);
      if (await exists(source)) await movePath(source, join(root, relativePath));
    }

    if (onApplied) await onApplied();
    await rm(backup, { recursive: true, force: true });
    return {
      mode: sourceMode,
      sourcePackage: basename(sourcePackage),
    };
  } catch (error) {
    await restoreTouchedPaths(root, backup, touchedPaths);
    await rm(backup, { recursive: true, force: true });
    throw error;
  }
}

async function writeMergedManifest(root, backup, sourcePackage, currentMode) {
  const current = await readJsonIfExists(join(backup, "release-manifest.json"))
    || await readJsonIfExists(join(root, "release-manifest.json"))
    || {};
  const source = await readJsonIfExists(join(sourcePackage, "release-manifest.json")) || {};
  const manifest = {
    ...current,
    version: source.version || current.version || "0.0.0",
    packageName: current.packageName || source.packageName,
    mode: currentMode,
    coreVersion: source.version || current.coreVersion || current.version || "0.0.0",
    corePackageName: source.packageName || current.corePackageName,
    coreUpdatedAt: source.generatedAt || new Date().toISOString(),
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function packageRuntimeEntries(sourcePackage, sourceMode) {
  const sourceRuntime = join(sourcePackage, "runtime");
  const entries = [];
  for (const entry of PACKAGE_RUNTIME_ENTRIES) {
    if (await exists(join(sourceRuntime, entry))) entries.push(entry);
  }
  if (entries.includes("node-universal.tar.gz") && !entries.includes("node-universal")) {
    entries.push("node-universal");
  }
  if (sourceMode === "direct" && entries.includes("node-universal.tar.gz")) {
    for (const entry of [".bundled-node", "bin", "lib", "LICENSE", "README.md", "CHANGELOG.md"]) {
      if (!entries.includes(entry)) entries.push(entry);
    }
  }
  return entries;
}

async function backupPath(root, backup, relativePath, touchedPaths) {
  touchedPaths.add(relativePath);
  await moveIfExists(join(root, relativePath), join(backup, relativePath));
}

async function restoreTouchedPaths(root, backup, touchedPaths) {
  for (const relativePath of [...touchedPaths].sort((left, right) => right.length - left.length)) {
    await rm(join(root, relativePath), { recursive: true, force: true });
    await moveIfExists(join(backup, relativePath), join(root, relativePath));
  }
}

async function readInstalledMode(root) {
  const manifest = await readJsonIfExists(join(root, "release-manifest.json"));
  if (["direct", "lite"].includes(manifest?.mode)) return manifest.mode;
  try {
    const packageJson = JSON.parse(await readFile(join(root, "app", "package.json"), "utf8"));
    return packageJson.dependencies?.["@larksuite/cli"] ? "direct" : "lite";
  } catch {
    return "direct";
  }
}

async function readInstalledVersion(root) {
  const manifest = await readJsonIfExists(join(root, "release-manifest.json"));
  if (typeof manifest?.version === "string") return normalizeVersion(manifest.version);
  try {
    const packageJson = JSON.parse(await readFile(join(root, "app", "package.json"), "utf8"));
    return normalizeVersion(packageJson.version);
  } catch {
    return undefined;
  }
}

async function readPackageMode(packageRoot) {
  const manifest = await readJsonIfExists(join(packageRoot, "release-manifest.json"));
  if (UPDATE_MODES.includes(manifest?.mode)) return manifest.mode;
  if (basename(packageRoot).includes("-core-")) return "core";
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

async function validatePackage(packageRoot, mode) {
  const required = mode === "core"
    ? ["app/dist/main.js", "app/scripts/update-portable-release.mjs", "release-manifest.json", "feishu-codex-bridge"]
    : ["app/dist/main.js", "app/package.json", "feishu-codex-bridge"];
  for (const requiredPath of required) {
    if (!(await exists(join(packageRoot, requiredPath)))) throw new Error(`更新包不完整，缺少 ${requiredPath}`);
  }
  const expectedArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (!basename(packageRoot).includes(`darwin-${expectedArch}`)) {
    throw new Error(`更新包 CPU/平台不匹配：${basename(packageRoot)}，当前为 darwin-${expectedArch}`);
  }
}

async function installPortableUpdateSchedule(root, intervalSeconds = DEFAULT_UPDATE_INTERVAL_SECONDS) {
  if (process.platform !== "darwin") throw new Error("自动更新 LaunchAgent 目前只支持 macOS");
  const uid = currentUid();
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, `${UPDATE_AGENT_LABEL}.plist`);
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "runtime", "logs"), { recursive: true, mode: 0o700 });
  await writeFile(plistPath, buildPortableUpdaterPlist({ root, intervalSeconds }), { encoding: "utf8", mode: 0o600 });
  await chmod(plistPath, 0o600);
  await runCapture("launchctl", ["bootout", `gui/${uid}/${UPDATE_AGENT_LABEL}`]);
  const bootstrapped = await runCapture("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (bootstrapped.exitCode !== 0) {
    throw new Error(`自动更新 LaunchAgent 安装失败：${bootstrapped.stderr || bootstrapped.stdout}`.trim());
  }
  console.log(`自动更新已启用：每 ${intervalSeconds} 秒检查一次`);
  return { plistPath, intervalSeconds };
}

async function uninstallPortableUpdateSchedule() {
  if (process.platform !== "darwin") throw new Error("自动更新 LaunchAgent 目前只支持 macOS");
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${UPDATE_AGENT_LABEL}.plist`);
  const uid = currentUid();
  await runCapture("launchctl", ["bootout", `gui/${uid}/${UPDATE_AGENT_LABEL}`]);
  await rm(plistPath, { force: true });
  console.log("自动更新已关闭。");
  return { plistPath };
}

async function hasActivePortableWork(root) {
  const state = await getPortableServiceState();
  if (!state.loaded) return false;
  const launcher = join(root, "feishu-codex-bridge");
  const result = await runCapture(launcher, ["codex:status", "--json"], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(`无法确认活动任务，自动更新已取消：${result.stderr || result.stdout}`.trim());
  }
  let snapshot;
  try {
    snapshot = JSON.parse(result.stdout);
  } catch {
    throw new Error("无法解析 Bridge 状态，自动更新已取消");
  }
  if (snapshot.runtimeLease?.active) return true;
  return ACTIVE_TASK_STATUSES.some((status) => Number(snapshot.taskCounts?.[status] || 0) > 0);
}

async function getPortableServiceState() {
  if (process.platform !== "darwin") return { loaded: false, running: false };
  const result = await runCapture("launchctl", ["print", `gui/${currentUid()}/${SERVICE_LABEL}`]);
  if (result.exitCode !== 0) return { loaded: false, running: false };
  return {
    loaded: true,
    running: /(?:^|\n)\s*state\s*=\s*running\b/.test(result.stdout),
  };
}

async function waitForServiceState(wantRunning) {
  const deadline = Date.now() + SERVICE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await getPortableServiceState();
    if (wantRunning ? state.running : !state.loaded) return;
    await delay(SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error(wantRunning ? "更新后 Bridge LaunchAgent 未进入 running 状态" : "Bridge LaunchAgent 停止超时");
}

async function stopPortableService(root) {
  await run(join(root, "feishu-codex-bridge"), ["service", "stop"], { cwd: root });
}

async function startPortableService(root) {
  await run(join(root, "feishu-codex-bridge"), ["service", "start"], { cwd: root });
}

async function restorePortableService(root) {
  try {
    await run(join(root, "feishu-codex-bridge"), ["service", "stop"], { cwd: root });
  } catch {}
  try {
    await startPortableService(root);
    await waitForServiceState(true);
  } catch (restoreError) {
    process.stderr.write(`更新回滚后无法恢复 Bridge 服务：${restoreError instanceof Error ? restoreError.message : String(restoreError)}\n`);
  }
}

async function withUpdateLock(root, action) {
  const lockPath = join(root, ".update.lock");
  try {
    await mkdir(lockPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      if (!await isStaleUpdateLock(lockPath)) throw new Error(`已有更新正在进行：${lockPath}`);
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
    } else {
      throw error;
    }
  }
  try {
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function isStaleUpdateLock(lockPath) {
  const lockStat = await stat(lockPath).catch(() => undefined);
  if (!lockStat || Date.now() - lockStat.mtimeMs < UPDATE_LOCK_STALE_MS) return false;
  const owner = await readJsonIfExists(join(lockPath, "owner.json"));
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function moveIfExists(source, destination) {
  if (await exists(source)) {
    await mkdirIfNeeded(dirname(destination));
    await movePath(source, destination);
  }
}

async function movePath(source, destination) {
  await mkdirIfNeeded(dirname(destination));
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
    await rm(source, { recursive: true, force: true });
  }
}

async function mkdirIfNeeded(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readOption(argv, index, arg, name) {
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return { value, consumed: 1 };
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match ? match[1] : undefined;
}

function compareVersions(left, right) {
  const leftVersion = normalizeVersion(left) || "0.0.0";
  const rightVersion = normalizeVersion(right) || "0.0.0";
  const [leftCore, leftSuffix] = leftVersion.split(/[-+]/, 2);
  const [rightCore, rightSuffix] = rightVersion.split(/[-+]/, 2);
  const leftNumbers = leftCore.split(".").map(Number);
  const rightNumbers = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftNumbers[index] !== rightNumbers[index]) return leftNumbers[index] - rightNumbers[index];
  }
  if (!leftSuffix && rightSuffix) return 1;
  if (leftSuffix && !rightSuffix) return -1;
  return String(leftSuffix || "").localeCompare(String(rightSuffix || ""));
}

function printUpdateCheck(check) {
  if (check.updateAvailable) {
    console.log(`发现更新：${check.currentVersion} -> ${check.remoteVersion}（${check.tag}）`);
    if (check.releaseUrl) console.log(`Release：${check.releaseUrl}`);
  } else {
    console.log(`当前已是最新版本：${check.currentVersion}`);
  }
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("当前 Node 不支持读取 macOS 用户 ID");
  return process.getuid();
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: options.stdio || "inherit",
      shell: false,
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${file} ${args.join(" ")} 退出码：${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

function runCapture(file, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.once("close", (exitCode, signal) => resolvePromise({
      exitCode,
      stdout,
      stderr: stderr || (signal ? `signal ${signal}` : ""),
    }));
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
