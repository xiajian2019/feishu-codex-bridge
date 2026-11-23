import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
const sourceRoot = resolve(process.env.BRIDGE_IOS_INSTALL_SOURCE?.trim() || process.cwd());
const project = resolve(process.env.BRIDGE_IOS_INSTALL_PROJECT?.trim() || join(sourceRoot, "ios/App/App.xcodeproj"));
const buildDirectory = resolve(process.env.BRIDGE_IOS_INSTALL_BUILD_DIR?.trim() || join(sourceRoot, "ios/App/build/managed-install"));
const bundleId = process.env.BRIDGE_IOS_INSTALL_BUNDLE_ID?.trim() || "dev.feishu.codex.bridge";
const teamId = process.env.BRIDGE_IOS_INSTALL_TEAM?.trim() || "";
const scheme = process.env.BRIDGE_IOS_INSTALL_SCHEME?.trim() || "App";
const configuration = process.env.BRIDGE_IOS_INSTALL_CONFIGURATION?.trim() || "PersonalDebug";
const targetName = process.env.BRIDGE_IOS_INSTALL_TARGET?.trim() || "App";

export function parseOptions(args) {
  const options = { device: null, allowProvisioningUpdates: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--device") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--device 需要设备名称或 UDID。");
      options.device = value;
    } else if (arg === "--allow-provisioning-updates") options.allowProvisioningUpdates = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`无法识别的参数：${arg}`);
  }
  if (!options.help && !options.device) throw new Error("--device 是必需的。");
  return options;
}

function run(command, args, label) {
  if (label) console.log(`\n${label}`);
  const result = spawnSync(command, args, { cwd: sourceRoot, stdio: "inherit", env: process.env });
  if (result.error) throw new Error(`${command} 启动失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${basename(command)} 失败（${result.signal ?? result.status}），已停止后续步骤。`);
}

function readDeviceJSON(args) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-ios-managed-device-"));
  const output = join(directory, "result.json");
  try {
    const result = spawnSync("xcrun", ["devicectl", ...args, "--timeout", "20", "--json-output", output, "--quiet"], {
      cwd: sourceRoot, encoding: "utf8", timeout: 25_000,
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? (result.stderr?.trim() || `退出码 ${result.status}`));
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function physicalDevices(rows) {
  if (!Array.isArray(rows)) throw new Error("无法解析 Xcode 的设备列表。");
  return rows.flatMap((row) => {
    const hardware = row?.properties?.hardware ?? row?.hardwareProperties ?? {};
    const connection = row?.properties?.connection ?? row?.connectionProperties ?? {};
    const state = row?.properties?.state ?? row?.deviceProperties ?? {};
    if (hardware.reality !== "physical" || !["iOS", "iPadOS"].includes(hardware.platform)) return [];
    const udid = hardware.udid ?? row?.hardwareProperties?.udid;
    if (typeof udid !== "string" || !udid) return [];
    const developerMode = state.developerModeStatus?.enabled ? "enabled" : state.developerModeStatus?.disabled ? "disabled" : "unknown";
    return [{
      udid, identifier: row.identifier ?? "", name: state.name ?? row?.deviceProperties?.name ?? "未命名设备",
      pairing: connection.pairingState ?? "unknown", transport: connection.transportType ?? "unknown",
      connectionState: connection.state ?? row?.connectionProperties?.tunnelState ?? "unknown", developerMode,
    }];
  });
}

function listDevices() {
  return physicalDevices(readDeviceJSON(["list", "devices"]).result?.devices);
}

function chooseUsbDevice(requested) {
  const devices = listDevices().filter((device) => device.transport === "wired");
  const candidates = requested ? devices.filter((device) => [device.udid, device.identifier, device.name].includes(requested)) : devices;
  if (candidates.length > 1) throw new Error("发现多个 USB iPhone/iPad，请指定唯一设备。");
  if (candidates.length === 0) throw new Error(requested ? "未找到指定的 USB iPhone/iPad，请确认手机已解锁并信任此 Mac。" : "未发现 USB 连接的 iPhone/iPad，请插入数据线并确认手机已解锁。");
  const device = candidates[0];
  if (device.pairing !== "paired") throw new Error(`“${device.name}”尚未与这台 Mac 完成配对。`);
  if (device.connectionState !== "connected") throw new Error(`“${device.name}”当前不可用，请保持 USB 连接并解锁手机。`);
  if (device.developerMode === "disabled") throw new Error(`请在“${device.name}”上开启开发者模式。`);
  return device;
}

function readPlistValue(file, key) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`无法读取 App 的 ${key}。`);
  return result.stdout.trim();
}

function findBuiltApp() {
  const products = join(buildDirectory, "DeviceDerivedData", "Build", "Products");
  const expected = join(products, `${configuration}-iphoneos`, `${targetName}.app`);
  if (existsSync(expected)) return expected;
  const pending = [products];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isSymbolicLink() && entry.name === `${targetName}.app`) return path;
    }
    if (current.endsWith(`${targetName}.app`)) return current;
  }
  throw new Error(`构建完成后找不到 ${targetName}.app，请检查 Scheme、Configuration 和 Target 配置。`);
}

function installedApp(udid) {
  const result = readDeviceJSON(["device", "info", "apps", "--device", udid, "--bundle-id", bundleId]);
  return result.result?.apps?.find((item) => item.bundleIdentifier === bundleId) ?? null;
}

function printHelp() {
  console.log(`用法：bun scripts/ios-app-install.mjs --device <名称或 UDID>\n  构建配置的 iOS App 并安装到 USB 直连的已配对设备。\n  --allow-provisioning-updates 允许 Xcode 自动更新签名配置`);
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  if (process.platform !== "darwin") throw new Error("iOS 本地安装需要 macOS 和完整 Xcode。");
  if (!existsSync(project)) throw new Error(`找不到 Xcode 工程：${project}`);
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("App 的 Apple Team ID 无效。");
  const device = chooseUsbDevice(options.device);
  console.log(`目标设备：${device.name}（USB）`);
  const mobileScript = join(sourceRoot, "scripts", "mobile.mjs");
  if (existsSync(join(sourceRoot, "package.json")) && existsSync(mobileScript)) {
    run(process.execPath, [mobileScript, "build"], "[1/4] 构建并同步移动端资源");
  } else {
    console.log("\n[1/4] 未发现移动端资源脚本，使用现有 Xcode 资源");
  }
  const derived = join(buildDirectory, "DeviceDerivedData");
  const buildArgs = ["-project", project, "-scheme", scheme, "-configuration", configuration,
    "-destination", `platform=iOS,id=${device.udid}`, "-derivedDataPath", derived, `DEVELOPMENT_TEAM=${teamId}`];
  if (options.allowProvisioningUpdates || process.env.BRIDGE_IOS_INSTALL_ALLOW_PROVISIONING_UPDATES === "1") buildArgs.push("-allowProvisioningUpdates");
  buildArgs.push("build");
  run("xcodebuild", buildArgs, "[2/4] 编译并签名 iOS App");
  const app = findBuiltApp();
  if (readPlistValue(join(app, "Info.plist"), "CFBundleIdentifier") !== bundleId) throw new Error(`构建结果的 Bundle ID 不是 ${bundleId}，已停止安装。`);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], "[3/4] 校验签名");
  run("xcrun", ["devicectl", "device", "install", "app", "--device", device.udid, app, "--timeout", "120"], `[4/4] 安装到 ${device.name}`);
  if (!installedApp(device.udid)) throw new Error("安装命令已返回成功，但设备上未能确认该 App。");
  console.log("安装命令成功，已在 USB 设备上确认 App 存在。");
}

if (import.meta.main) {
  try { main(); }
  catch (error) {
    console.error(`iOS 本地构建/安装未完成：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
