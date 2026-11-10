import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  disableRenewal, enableRenewal, inspectSignedApp, notifyRenewalIssue, printRenewalStatus, rememberInstallation,
  renewalDue, renewalPaths, runRenewal,
} from "./ios-auto-renew.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleId = "dev.feishu.codex.bridge";

export function parseOptions(args) {
  const options = {
    check: false,
    buildOnly: false,
    wirelessOnly: false,
    allowProvisioningUpdates: false,
    device: null,
    ip: null,
    help: false,
    renewalMode: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--check") options.check = true;
    else if (arg === "--build-only") options.buildOnly = true;
    else if (arg === "--allow-usb") options.wirelessOnly = false;
    else if (arg === "--wireless-only") options.wirelessOnly = true;
    else if (arg === "--allow-provisioning-updates") options.allowProvisioningUpdates = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (["--renew-status", "--renew-now", "--renew-run", "--disable-auto-renew"].includes(arg)) {
      if (options.renewalMode) throw new Error("续签操作不能同时使用。");
      options.renewalMode = arg;
    }
    else if (arg === "--device") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--device 需要设备名称或 UDID。");
      options.device = args[++i];
    } else if (arg === "--ip") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--ip 需要 IPv4 地址。");
      options.ip = args[++i];
    }
    else throw new Error(`无法识别的参数：${arg}`);
  }
  if (options.check && options.buildOnly) throw new Error("--check 和 --build-only 不能同时使用。");
  if (options.renewalMode && (options.check || options.buildOnly || options.device || options.ip || options.wirelessOnly || options.allowProvisioningUpdates)) {
    throw new Error("续签操作不能与设备、构建或签名选项一起使用。");
  }
  if (!options.renewalMode && !options.device && !options.ip) options.ip = process.env.BRIDGE_IOS_DEVICE_IP?.trim() || null;
  if (options.device && options.ip) throw new Error("--device 和 --ip 不能同时使用；请只指定一个无线设备目标。");
  if (options.ip) parseIPv4(options.ip);
  return options;
}

export function parseIPv4(value) {
  if (typeof value !== "string") throw new Error("IPv4 地址必须是文本。");
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
    throw new Error(`无效的 iPhone IPv4 地址：${value}`);
  }
  return value;
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
    const legacyDeveloperMode = row?.deviceProperties?.developerModeStatus;
    const developerMode = typeof legacyDeveloperMode === "string" ? legacyDeveloperMode
      : state.developerModeStatus?.enabled ? "enabled"
        : state.developerModeStatus?.disabled ? "disabled" : "unknown";
    return [{
      udid,
      identifier: row.identifier ?? "",
      name: state.name ?? row?.deviceProperties?.name ?? "未命名设备",
      pairing: connection.pairingState ?? "unknown",
      transport: connection.transportType ?? "unknown",
      connectionState: connection.state ?? row?.connectionProperties?.tunnelState ?? "unknown",
      developerMode,
    }];
  });
}

export function chooseDevice(devices, requested, required = true) {
  const candidates = requested
    ? devices.filter((device) => [device.udid, device.identifier, device.name].some((value) => value === requested))
    : devices.filter((device) => device.pairing === "paired" && ["wired", "localNetwork"].includes(device.transport));
  if (candidates.length > 1) throw new Error("发现多个 iPhone/iPad，请使用 --device 指定设备名称或 UDID。");
  if (candidates.length === 0) {
    if (!requested && !required) return null;
    if (requested) throw new Error("未找到指定的 iPhone/iPad，请使用 --check 查看设备名称。");
    if (devices.some((device) => device.pairing === "paired")) {
      throw new Error("设备已配对，但当前没有可用连接。请保持 iPhone 解锁并检查 Wi-Fi，然后运行 --check。");
    }
    throw new Error("未找到已配对的 iPhone。请先在 Xcode 完成设备配对，然后运行 --check。");
  }
  const device = candidates[0];
  if (device.pairing !== "paired") throw new Error(`“${device.name}”尚未与这台 Mac 完成配对。`);
  if (device.developerMode === "disabled") throw new Error(`请在“${device.name}”上开启开发者模式。`);
  return device;
}

export function assertInstallTransport(device, wirelessOnly = false) {
  if (device.transport === "localNetwork") return;
  if (device.transport === "wired" && !wirelessOnly) return;
  if (device.transport === "wired") {
    throw new Error(`“${device.name}”当前通过 USB 连接；当前命令启用了 --wireless-only，请去掉该选项或改用有线安装。`);
  }
  throw new Error(`“${device.name}”的连接方式为 ${device.transport}，无法确认可安装连接；请运行 --check 检查设备。`);
}

function printHelp() {
  console.log(`用法：bun run mobile:ios:install [选项]
  默认构建最新 iOS App，并安装到唯一的 USB 或 Wi-Fi / 局域网设备。
  --check                        查看已配对设备与连接方式，不构建或安装
  --build-only                   只构建签名 App，不安装；没有设备时使用通用 iOS 目标
  --device <名称或 UDID>         选择设备；多台设备时必须指定
  --ip <IPv4>                    使用 CoreDevice 可识别的设备地址；无法替代无线发现和配对
  --wireless-only                只允许 Wi-Fi / 局域网安装
  --allow-usb                    兼容旧命令；USB 现在默认支持
  --allow-provisioning-updates   允许 Xcode 更新 Apple 签名配置
  --renew-status                 查看自动续签状态和签名到期时间
  --renew-now                    立即尝试为已登记设备续签并安装
  --disable-auto-renew           停用本 checkout 的自动续签任务
  --help                         显示帮助`);
}

function run(command, args, label) {
  if (label) console.log(`\n${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw new Error(`${command} 启动失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 失败（${result.signal ?? result.status}），已停止后续步骤。`);
}

function readDeviceJSON(args) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-ios-device-"));
  const output = join(directory, "result.json");
  try {
    const result = spawnSync("xcrun", ["devicectl", ...args, "--timeout", "20", "--json-output", output, "--quiet"], {
      cwd: root, encoding: "utf8", timeout: 25_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`设备查询失败：${result.error?.message ?? (result.stderr.trim() || `退出码 ${result.status}`)}`);
    }
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function listDevices() {
  return physicalDevices(readDeviceJSON(["list", "devices"]).result?.devices);
}

export function resolveIpDevice(ip, wirelessOnly, readDevice = readDeviceJSON) {
  let result;
  try {
    result = readDevice(["device", "info", "details", "--device", ip]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CoreDevice 无法将 IP ${ip} 识别为设备。请先完成无线发现与配对，再用 --check 查找设备并用 --device 指定名称或 UDID。${detail}`);
  }
  const device = chooseDevice(physicalDevices([result.result]), null);
  assertInstallTransport(device, wirelessOnly);
  return device;
}

function assertGeneratedManifestClean() {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "ios/App/CapApp-SPM/Package.swift"], {
    cwd: root, encoding: "utf8",
  });
  if (result.error || result.status !== 0) throw new Error("无法检查 Capacitor 生成文件的状态。");
  if (result.stdout.trim()) throw new Error("Capacitor 的 Package.swift 存在未提交改动；同步可能覆盖它，请先处理该文件。");
}

function verifyWebAssets(source, destination) {
  const walk = (relative = "") => {
    for (const entry of readdirSync(join(source, relative), { withFileTypes: true })) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const actual = join(destination, next);
        if (!existsSync(actual)) throw new Error(`iOS App 缺少前端文件：${next}`);
        const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
        if (hash(join(source, next)) !== hash(actual)) throw new Error(`iOS App 前端文件不是本次构建：${next}`);
      } else throw new Error(`前端构建包含不支持的文件：${next}`);
    }
  };
  if (!existsSync(join(source, "index.html"))) throw new Error("前端构建缺少 index.html。");
  walk();
}

function readPlistValue(file, key) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`无法读取 App 的 ${key}。`);
  return result.stdout.trim();
}

export function formatDeviceStatus(device) {
  const transport = device.transport === "localNetwork" ? "Wi-Fi / 局域网" : device.transport === "wired" ? "USB" : "未发现连接";
  const pairing = device.pairing === "paired" ? "已配对" : `配对状态 ${device.pairing}`;
  const developerMode = device.developerMode === "enabled" ? "已开启" : device.developerMode === "disabled" ? "未开启" : "未知";
  const connection = device.connectionState === "connected" ? "已连接" : device.connectionState === "unavailable" ? "不可用" : device.connectionState;
  return `${device.name}：${transport}，${pairing}，开发者模式${developerMode}，连接${connection}`;
}

function printDevice(device) {
  console.log(formatDeviceStatus(device));
  if (device.pairing === "paired" && device.connectionState === "unavailable") {
    console.log("手机已配对，但 Mac 暂未发现它。请保持 iPhone 解锁，确认双方网络可互通；VPN 或 Wi-Fi 隔离也可能影响发现。");
  }
}

function withBuildLock(action) {
  const buildDir = join(root, "ios/App/build");
  const lock = join(buildDir, ".bridge-ios-device-build.lock");
  mkdirSync(buildDir, { recursive: true });
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`iOS 构建锁已存在：${lock}。请先确认其他构建进程及锁状态。`);
    throw error;
  }
  try {
    writeFileSync(join(lock, "pid"), String(process.pid));
    return action(buildDir);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function installedApp(udid) {
  const result = readDeviceJSON(["device", "info", "apps", "--device", udid, "--bundle-id", bundleId, "--include-container-paths"]);
  return result.result?.apps?.find((item) => item.bundleIdentifier === bundleId) ?? null;
}

function installApp(device, app, label) {
  run("xcrun", ["devicectl", "device", "install", "app", "--device", device.udid, app, "--timeout", "120"], label);
}

function renewalAdapter() {
  return {
    device: (record) => {
      const device = chooseDevice(listDevices(), record.udid);
      assertInstallTransport(device, record.wirelessOnly);
      return device;
    },
    installed: installedApp,
    install: (device, app) => installApp(device, app, `重新安装到 ${device.name}`),
  };
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  if (process.platform !== "darwin") throw new Error("iOS 设备构建需要 macOS 和完整 Xcode。");
  const paths = renewalPaths(root);
  // All checkouts share Xcode's profile cache. An OS file lock serializes our
  // builds, cache backup/recovery and renewals, and releases even after a crash.
  if (!process.env.BRIDGE_IOS_SIGNING_LOCK_HELD && !options.check && options.renewalMode !== "--renew-status") {
    const shared = dirname(paths.state);
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    const result = spawnSync("/usr/bin/lockf", ["-k", "-t", "5", join(shared, "signing.lock"), process.execPath,
      fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: root, stdio: "inherit", env: { ...process.env, BRIDGE_IOS_SIGNING_LOCK_HELD: "1" },
    });
    if (result.error || result.status !== 0) {
      if (result.status === 75) {
        console.error("另一个 Bridge iOS 构建或续签正在使用签名配置，请稍后重试。");
        if (options.renewalMode === "--renew-run") notifyRenewalIssue("续签等待其他 iOS 构建，请查看 Mac 上的续签日志。");
      }
      if (result.error) throw new Error(`无法启动 iOS 签名锁：${result.error.message}`);
      process.exitCode = result.status ?? 1;
    }
    return;
  }
  if (options.renewalMode === "--renew-status") { printRenewalStatus(paths); return; }
  if (options.renewalMode === "--disable-auto-renew") { withBuildLock(() => disableRenewal(paths)); console.log("已停用自动续签，已安装 App 和快照保留。"); return; }
  if (options.renewalMode) {
    let entered = false;
    try {
      withBuildLock(() => { entered = true; runRenewal(paths, renewalAdapter(), { force: options.renewalMode === "--renew-now" }); });
    } catch (error) {
      if (!entered && options.renewalMode === "--renew-run") notifyRenewalIssue("续签任务无法取得构建锁，请查看 Mac 上的续签错误日志。");
      throw error;
    }
    return;
  }

  const devices = options.check || (!options.ip && (!options.buildOnly || options.device)) ? listDevices() : [];
  if (options.check) {
    if (devices.length === 0) console.log("未发现已配对的 iOS 真机。");
    else devices.forEach(printDevice);
    return;
  }
  const device = options.ip
    ? (options.buildOnly ? null : resolveIpDevice(options.ip, options.wirelessOnly))
    : chooseDevice(devices, options.device, !options.buildOnly);
  if (device) printDevice(device);
  else console.log("没有选定设备，将构建通用 iOS App。");
  if (!options.buildOnly) assertInstallTransport(device, options.wirelessOnly);
  assertGeneratedManifestClean();

  withBuildLock((buildDir) => {
    run(process.execPath, ["run", "--bun", "vite", "build", "--config", "web/vite.mobile.config.ts"], "[1/4] 构建手机前端");
    run(process.execPath, ["run", "--bun", "cap", "sync", "ios"], "[2/4] 同步 iOS 资源和插件");
    const webOutput = join(root, "dist/mobile");
    verifyWebAssets(webOutput, join(root, "ios/App/App/public"));

    const derived = resolve(process.env.BRIDGE_IOS_DERIVED_DATA || join(buildDir, "DeviceDerivedData"));
    const buildArgs = ["-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Debug",
      "-destination", device ? `platform=iOS,id=${device.udid}` : "generic/platform=iOS", "-derivedDataPath", derived];
    if (process.env.BRIDGE_IOS_SPM_CACHE) buildArgs.push("-clonedSourcePackagesDirPath", resolve(process.env.BRIDGE_IOS_SPM_CACHE));
    if (options.allowProvisioningUpdates) buildArgs.push("-allowProvisioningUpdates");
    buildArgs.push("-quiet", "build");
    run("xcodebuild", buildArgs, "[3/4] 编译并签名 iOS App");
    const app = join(derived, "Build/Products/Debug-iphoneos/App.app");
    const info = join(app, "Info.plist");
    if (readPlistValue(info, "CFBundleIdentifier") !== bundleId) throw new Error("构建结果的 Bundle ID 与 Bridge 不一致，已停止安装。");
    verifyWebAssets(webOutput, join(app, "public"));
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    console.log(`签名 App：${app}`);
    if (options.buildOnly) { console.log("构建完成，未安装到设备。"); return; }

    const signing = inspectSignedApp(app, device.udid);
    const current = chooseDevice(listDevices(), device.udid);
    assertInstallTransport(current, options.wirelessOnly);
    const installTransport = current.transport === "localNetwork" ? "无线" : "USB";
    installApp(current, app, `[4/4] 安装到 ${current.name}（${installTransport}）`);
    const installed = installedApp(current.udid);
    if (!installed) throw new Error("安装命令已返回成功，但设备上未能确认 Bridge；请检查手机上的应用列表。");
    console.log("安装命令成功，已在设备上确认 Bridge 存在。");
    try {
      rememberInstallation(paths, current, app, installed, signing, options.wirelessOnly);
      enableRenewal(paths, root, process.execPath);
    } catch (error) {
      throw new Error(`App 已安装，但自动续签未启用：${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`自动续签已启用；签名最早到期：${new Date(signing.effectiveExpiry).toLocaleString()}。`);
    if (renewalDue(signing)) runRenewal(paths, renewalAdapter());
  });
}

if (import.meta.main) {
  try { main(); }
  catch (error) {
    console.error(`iOS 构建/安装未完成：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
