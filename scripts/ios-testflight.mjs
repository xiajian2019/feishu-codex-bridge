import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renewalPaths } from "./ios-auto-renew.mjs";
import { readIosDevelopmentTeam } from "./ios-signing-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "ios/App/App.xcodeproj");
const projectFile = join(project, "project.pbxproj");
const scheme = "App";
const configuration = "PersonalRelease";
const bundleId = "dev.feishu.codex.bridge";

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值。`);
  return value;
}

function positiveInteger(value, flag) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${flag} 需要正整数。`);
  }
  return Number(value);
}

export function parseOptions(args) {
  const options = {
    archiveOnly: false,
    archivePath: null,
    authenticationKeyId: null,
    authenticationKeyIssuerId: null,
    authenticationKeyPath: null,
    allowProvisioningUpdates: true,
    buildNumber: null,
    check: false,
    exportPath: null,
    help: false,
    internalOnly: false,
    skipMobileBuild: false,
    uploadOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--archive-only") options.archiveOnly = true;
    else if (arg === "--archive-path") options.archivePath = requireValue(args, ++i, arg);
    else if (arg === "--authentication-key-id") options.authenticationKeyId = requireValue(args, ++i, arg);
    else if (arg === "--authentication-key-issuer-id") options.authenticationKeyIssuerId = requireValue(args, ++i, arg);
    else if (arg === "--authentication-key-path") options.authenticationKeyPath = requireValue(args, ++i, arg);
    else if (arg === "--allow-provisioning-updates") options.allowProvisioningUpdates = true;
    else if (arg === "--build-number") options.buildNumber = positiveInteger(requireValue(args, ++i, arg), arg);
    else if (arg === "--check") options.check = true;
    else if (arg === "--export-path") options.exportPath = requireValue(args, ++i, arg);
    else if (arg === "--internal-only") options.internalOnly = true;
    else if (arg === "--no-provisioning-updates") options.allowProvisioningUpdates = false;
    else if (arg === "--skip-mobile-build") options.skipMobileBuild = true;
    else if (arg === "--upload-only") options.uploadOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`无法识别的参数：${arg}`);
  }

  if (options.archiveOnly && options.uploadOnly) throw new Error("--archive-only 和 --upload-only 不能同时使用。");
  if (options.uploadOnly && !options.archivePath) throw new Error("--upload-only 必须同时指定 --archive-path。");
  if (options.check && (options.archiveOnly || options.uploadOnly || options.archivePath || options.exportPath || options.buildNumber !== null)) {
    throw new Error("--check 不能与构建或上传选项一起使用。");
  }
  return options;
}

export function resolveAuthentication(options, env = process.env) {
  const values = {
    path: options.authenticationKeyPath ?? env.APP_STORE_CONNECT_API_KEY_PATH?.trim() ?? null,
    id: options.authenticationKeyId ?? env.APP_STORE_CONNECT_API_KEY_ID?.trim() ?? null,
    issuer: options.authenticationKeyIssuerId ?? env.APP_STORE_CONNECT_API_ISSUER_ID?.trim() ?? null,
  };
  const supplied = Object.values(values).some(Boolean);
  if (!supplied) return null;
  if (Object.values(values).some((value) => !value)) {
    throw new Error("App Store Connect API Key 需要同时提供路径、Key ID 和 Issuer ID。");
  }
  if (!existsSync(values.path)) throw new Error(`找不到 App Store Connect API 私钥：${values.path}`);
  return values;
}

function settingValue(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"?([^";\\n]+)"?;`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function readAppProjectSettings(source = readFileSync(projectFile, "utf8"), env = process.env) {
  const blocks = [...source.matchAll(/\/\*\s*PersonalRelease\s*\*\/\s*=\s*\{\s*isa = XCBuildConfiguration;\s*buildSettings = \{([\s\S]*?)\n\s*\};\s*name = PersonalRelease;\s*\};/g)];
  const block = blocks.map((match) => match[1]).find((value) =>
    settingValue(value, "INFOPLIST_FILE") === "App/Info.plist" && settingValue(value, "PRODUCT_NAME") === "App");
  if (!block) throw new Error(`找不到 ${scheme}/${configuration} 的 App 构建配置。`);
  return {
    bundleId: settingValue(block, "PRODUCT_BUNDLE_IDENTIFIER"),
    buildNumber: settingValue(block, "CURRENT_PROJECT_VERSION"),
    marketingVersion: settingValue(block, "MARKETING_VERSION"),
    teamId: readIosDevelopmentTeam(env),
  };
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function plistEntry(key, value) {
  const encoded = typeof value === "boolean" ? (value ? "<true/>" : "<false/>") : `<string>${xml(value)}</string>`;
  return `<key>${xml(key)}</key>${encoded}`;
}

export function exportOptionsPlist({ internalOnly = false, teamId = null } = {}) {
  const entries = [
    plistEntry("destination", "upload"),
    plistEntry("method", "app-store-connect"),
    plistEntry("signingStyle", "automatic"),
    plistEntry("uploadSymbols", true),
  ];
  if (teamId) entries.push(plistEntry("teamID", teamId));
  if (internalOnly) entries.push(plistEntry("testFlightInternalTestingOnly", true));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${entries.join("")}</dict></plist>\n`;
}

export function authenticationArguments(authentication) {
  if (!authentication) return [];
  return [
    "-authenticationKeyPath", authentication.path,
    "-authenticationKeyID", authentication.id,
    "-authenticationKeyIssuerID", authentication.issuer,
  ];
}

function printHelp() {
  console.log(`用法：bun run mobile:ios:testflight [选项]
  构建当前 App scheme 的 iOS Archive，并上传到 App Store Connect TestFlight。
  默认会先运行 mobile:build，并允许 Xcode 自动更新签名配置。
  --check                              只检查 Xcode、Bundle ID、Team 和当前版本，不构建或上传
  --build-number <正整数>              覆盖本次上传的 CFBundleVersion
  --archive-path <path.xcarchive>      指定 Archive 路径；--upload-only 时必填
  --export-path <directory>            指定上传导出目录；默认在 ios/App/build/testflight 下生成
  --archive-only                       只归档，不上传
  --upload-only                        使用已有 Archive 上传，不重新构建
  --skip-mobile-build                  不运行 mobile:build，使用已有 iOS 前端资源
  --internal-only                      将构建限制为 TestFlight 内部测试
  --allow-provisioning-updates         允许 Xcode 更新 Apple 签名配置（默认）
  --no-provisioning-updates            只使用现有签名配置
  --authentication-key-path <path>     App Store Connect API 私钥 .p8 路径
  --authentication-key-id <id>         App Store Connect API Key ID
  --authentication-key-issuer-id <id>  App Store Connect Issuer ID
  --help                               显示帮助

  也可使用环境变量：
  APP_STORE_CONNECT_API_KEY_PATH
  APP_STORE_CONNECT_API_KEY_ID
  APP_STORE_CONNECT_API_ISSUER_ID`);
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, env: process.env, encoding: "utf8", ...options });
  if (result.error) throw new Error(`${file} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || `退出码 ${result.status}`;
    throw new Error(`${basename(file)} 失败：${detail}`);
  }
  return result.stdout ?? "";
}

function run(file, args, label) {
  if (label) console.log(`\n${label}`);
  const result = spawnSync(file, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw new Error(`${file} 启动失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${basename(file)} 失败（${result.signal ?? result.status}），已停止后续步骤。`);
}

function resolvePath(value) {
  return value ? resolve(root, value) : null;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function defaultArchivePath() {
  return join(root, "ios/App/build/testflight", `Bridge-${timestamp()}.xcarchive`);
}

function archiveAppPath(archivePath) {
  return join(archivePath, "Products/Applications/App.app");
}

function readPlistValue(file, key) {
  return command("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file]).trim();
}

function assertProject() {
  if (process.platform !== "darwin") throw new Error("TestFlight 上传需要 macOS 和完整 Xcode。");
  if (!existsSync(project)) throw new Error(`找不到 Xcode 工程：${project}`);
  if (!existsSync(projectFile)) throw new Error(`找不到 Xcode 工程配置：${projectFile}`);
  const settings = readAppProjectSettings();
  if (settings.bundleId !== bundleId) throw new Error(`App Bundle ID 应为 ${bundleId}，实际为 ${settings.bundleId ?? "空"}。`);
  if (!settings.teamId) throw new Error("请在运行命令的环境中设置 BRIDGE_IOS_DEVELOPMENT_TEAM（Apple Team ID）。");
  if (!settings.marketingVersion || !settings.buildNumber) throw new Error("App 构建配置缺少版本号或构建号。");
  const schemeFile = join(project, "xcshareddata/xcschemes/App.xcscheme");
  if (!existsSync(schemeFile) || !readFileSync(schemeFile, "utf8").includes('buildConfiguration = "PersonalRelease"')) {
    throw new Error("App scheme 没有使用 PersonalRelease 归档配置。");
  }
  return settings;
}

function checkTooling() {
  const developerDir = command("xcode-select", ["-p"]).trim();
  const version = command("xcodebuild", ["-version"]).trim().split("\n")[0] ?? "未知版本";
  console.log(`Xcode：${version}（${developerDir}）`);
}

function assertMobileAssets() {
  const source = join(root, "dist/mobile/index.html");
  const destination = join(root, "ios/App/App/public/index.html");
  if (!existsSync(source) || !existsSync(destination)) {
    throw new Error("找不到已同步的 iOS 前端资源；请先运行 mobile:build，或去掉 --skip-mobile-build。");
  }
}

function archiveArgs(options, archivePath, authentication, teamId) {
  const args = [
    "-project", project,
    "-scheme", scheme,
    "-configuration", configuration,
    "-destination", "generic/platform=iOS",
    "-archivePath", archivePath,
  ];
  if (process.env.BRIDGE_IOS_DERIVED_DATA) args.push("-derivedDataPath", resolve(process.env.BRIDGE_IOS_DERIVED_DATA));
  if (process.env.BRIDGE_IOS_SPM_CACHE) args.push("-clonedSourcePackagesDirPath", resolve(process.env.BRIDGE_IOS_SPM_CACHE));
  if (options.allowProvisioningUpdates) args.push("-allowProvisioningUpdates");
  if (options.buildNumber !== null) args.push(`CURRENT_PROJECT_VERSION=${options.buildNumber}`);
  args.push(`DEVELOPMENT_TEAM=${teamId}`);
  args.push(...authenticationArguments(authentication), "archive");
  return args;
}

function validateArchive(archivePath, settings, requestedBuildNumber = null) {
  const app = archiveAppPath(archivePath);
  if (!existsSync(app)) throw new Error(`Archive 中找不到 App.app：${app}`);
  const actualBundleId = readPlistValue(join(app, "Info.plist"), "CFBundleIdentifier");
  const version = readPlistValue(join(app, "Info.plist"), "CFBundleShortVersionString");
  const build = readPlistValue(join(app, "Info.plist"), "CFBundleVersion");
  if (actualBundleId !== bundleId) throw new Error(`Archive 的 Bundle ID 为 ${actualBundleId}，不是 ${bundleId}。`);
  if (requestedBuildNumber !== null && build !== String(requestedBuildNumber)) {
    throw new Error(`Archive 的构建号为 ${build}，不是请求的 ${requestedBuildNumber}。`);
  }
  console.log(`Archive：${archivePath}`);
  console.log(`版本：${version} (${build})，Bundle ID：${actualBundleId}，Team：${settings.teamId}`);
  return { app, build, version };
}

function exportArchive(options, archivePath, settings, authentication) {
  const exportPath = resolvePath(options.exportPath) ?? join(dirname(archivePath), `${basename(archivePath, extname(archivePath))}-export`);
  mkdirSync(exportPath, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(tmpdir(), "bridge-ios-testflight-"));
  const exportOptions = join(temporary, "ExportOptions.plist");
  writeFileSync(exportOptions, exportOptionsPlist({ internalOnly: options.internalOnly, teamId: settings.teamId }), { mode: 0o600 });
  try {
    const args = ["-exportArchive", "-archivePath", archivePath, "-exportPath", exportPath, "-exportOptionsPlist", exportOptions];
    if (options.allowProvisioningUpdates) args.push("-allowProvisioningUpdates");
    args.push(...authenticationArguments(authentication));
    run("xcodebuild", args, "[3/3] 导出并上传到 App Store Connect");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`上传命令已完成，导出目录：${exportPath}`);
  console.log("请在 App Store Connect 的 TestFlight 中等待 Processing 完成，并处理 Export Compliance（如有提示）。");
  return exportPath;
}

function withSigningLock(args) {
  if (process.env.BRIDGE_IOS_SIGNING_LOCK_HELD === "1") return false;
  const paths = renewalPaths(root);
  const lockDirectory = dirname(paths.state);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const lock = join(lockDirectory, "signing.lock");
  const result = spawnSync("/usr/bin/lockf", ["-k", "-t", "5", lock, process.execPath, fileURLToPath(import.meta.url), ...args], {
    cwd: root,
    env: { ...process.env, BRIDGE_IOS_SIGNING_LOCK_HELD: "1" },
    stdio: "inherit",
  });
  if (result.error) throw new Error(`无法启动 iOS 签名锁：${result.error.message}`);
  if (result.status === 75) throw new Error("另一个 Bridge iOS 构建或上传正在使用签名配置，请稍后重试。");
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return true;
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const settings = assertProject();
  const authentication = resolveAuthentication(options);
  if (options.check) {
    checkTooling();
    console.log(`工程：${project}`);
    console.log(`归档：${scheme}/${configuration}`);
    console.log(`Bundle ID：${settings.bundleId}`);
    console.log(`Team：${settings.teamId}`);
    console.log(`默认版本：${settings.marketingVersion} (${settings.buildNumber})`);
    console.log(`上传认证：${authentication ? "App Store Connect API Key" : "Xcode 已登录账号"}`);
    console.log("检查完成；未构建、未签名、未上传。");
    return;
  }
  if (withSigningLock(process.argv.slice(2))) return;

  const archivePath = resolvePath(options.archivePath) ?? defaultArchivePath();
  if (options.uploadOnly) {
    if (!existsSync(archivePath)) throw new Error(`找不到已有 Archive：${archivePath}`);
    validateArchive(archivePath, settings, options.buildNumber);
  } else {
    if (existsSync(archivePath)) throw new Error(`Archive 已存在：${archivePath}；请换路径或使用 --upload-only。`);
    mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
    if (options.skipMobileBuild) assertMobileAssets();
    else run(process.execPath, ["run", "mobile:build"], "[1/3] 构建并同步移动端资源");
    run("xcodebuild", archiveArgs(options, archivePath, authentication, settings.teamId), "[2/3] 归档并签名 iOS App");
    validateArchive(archivePath, settings, options.buildNumber);
  }
  if (!options.archiveOnly) exportArchive(options, archivePath, settings, authentication);
  else console.log("归档完成，未上传；可使用 --upload-only --archive-path <path.xcarchive> 重试上传。");
}

if (import.meta.main) {
  try { main(); }
  catch (error) {
    console.error(`TestFlight 构建/上传未完成：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
