import { spawnSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const legacyBundleId = "dev.feishu.codex.bridge";

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `退出码 ${result.status}`;
    throw new Error(`${basename(file)} 失败：${detail}`);
  }
  return result.stdout ?? "";
}

function plistValue(fileOrXml, key, format = "raw", isXml = false) {
  return command("/usr/bin/plutil", ["-extract", key, format, "-o", "-", isXml ? "-" : fileOrXml],
    isXml ? { input: fileOrXml } : {}).trim();
}

export function readProfile(path) {
  const xml = command("/usr/bin/openssl", ["smime", "-verify", "-inform", "DER", "-noverify", "-in", path]);
  const value = (key, format = "raw") => plistValue(xml, key, format, true);
  const team = JSON.parse(value("TeamIdentifier", "json"))[0];
  const devices = JSON.parse(value("ProvisionedDevices", "json"));
  const certificates = [];
  for (let i = 0; i < 50; i++) {
    const item = spawnSync("/usr/bin/plutil", ["-extract", `DeveloperCertificates.${i}`, "raw", "-o", "-", "-"], { input: xml, encoding: "utf8" });
    if (item.status !== 0) break;
    const certificate = new X509Certificate(Buffer.from(item.stdout.trim(), "base64"));
    certificates.push({ fingerprint: certificate.fingerprint.replaceAll(":", ""), expiresAt: new Date(certificate.validTo).toISOString() });
  }
  const profile = {
    name: value("Name"), uuid: value("UUID"), team,
    applicationIdentifier: value("Entitlements.application-identifier"),
    expiresAt: value("ExpirationDate"), devices, certificates,
  };
  if (!team || !profile.uuid || !Number.isFinite(Date.parse(profile.expiresAt)) || !Array.isArray(devices)) {
    throw new Error(`无法读取有效的 iOS 描述文件：${path}`);
  }
  return profile;
}

function signingCertificateExpiry(path) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-ios-cert-"));
  try {
    const prefix = join(directory, "certificate");
    command("/usr/bin/codesign", ["-d", `--extract-certificates=${prefix}`, path]);
    const certificate = new X509Certificate(readFileSync(`${prefix}0`));
    const expiry = Date.parse(certificate.validTo);
    if (!Number.isFinite(expiry)) throw new Error("签名证书缺少有效期。");
    return new Date(expiry).toISOString();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function entitlementsXml(path) {
  return command("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", path]);
}

function signedEntitlements(path) {
  const output = entitlementsXml(path);
  const json = command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: output });
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(JSON.parse(json)))).digest("hex");
}

export function inspectSignedApp(app, deviceUdid) {
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const mainBundleId = plistValue(join(app, "Info.plist"), "CFBundleIdentifier");
  const profiles = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === "embedded.mobileprovision") {
        const bundle = dirname(path);
        const id = plistValue(join(bundle, "Info.plist"), "CFBundleIdentifier");
        const profile = readProfile(path);
        if (!profile.applicationIdentifier.endsWith(`.${id}`) || !profile.devices.includes(deviceUdid)) {
          throw new Error(`描述文件与 ${id} 或目标设备不匹配。`);
        }
        profiles.push({ ...profile, bundleId: id, bundlePath: relative(app, bundle), certificateExpiresAt: signingCertificateExpiry(bundle), entitlementsHash: signedEntitlements(bundle) });
      }
    }
  };
  walk(app);
  const main = profiles.find((profile) => profile.bundleId === mainBundleId);
  if (!main || profiles.some((profile) => profile.team !== main.team) ||
      new Set(profiles.map((profile) => profile.bundleId)).size !== profiles.length) {
    throw new Error("App 和扩展的描述文件不完整或签名团队不一致。");
  }
  return { bundleId: main.bundleId, team: main.team, profiles, effectiveExpiry: effectiveExpiry(profiles) };
}

export function effectiveExpiry(profiles) {
  const dates = profiles.flatMap((profile) => [Date.parse(profile.expiresAt), Date.parse(profile.certificateExpiresAt)]);
  if (!dates.length || dates.some((date) => !Number.isFinite(date))) throw new Error("无法确定签名到期时间。");
  return new Date(Math.min(...dates)).toISOString();
}

export function renewalDue(signing, now = Date.now()) {
  const expiry = Date.parse(signing.effectiveExpiry);
  if (!Number.isFinite(expiry)) throw new Error("已保存的签名到期时间无效。");
  return expiry - now <= RENEW_WINDOW_MS;
}

export function validateRenewal(previous, next, deviceUdid, now = Date.now()) {
  if (previous.team !== next.team) throw new Error("新签名团队与原安装不一致。");
  const oldIds = previous.profiles.map((profile) => profile.bundleId).sort();
  const newIds = next.profiles.map((profile) => profile.bundleId).sort();
  if (JSON.stringify(oldIds) !== JSON.stringify(newIds)) throw new Error("新 App 的主程序或扩展标识与原安装不一致。");
  if (next.profiles.some((profile) => !profile.devices.includes(deviceUdid))) throw new Error("新描述文件未包含目标设备。");
  for (const old of previous.profiles) {
    const current = next.profiles.find((profile) => profile.bundleId === old.bundleId);
    if (!old.entitlementsHash || current.entitlementsHash !== old.entitlementsHash || current.applicationIdentifier !== old.applicationIdentifier || current.bundlePath !== old.bundlePath) {
      throw new Error(`新签名更改了 ${old.bundleId} 的身份或权限，已停止安装。`);
    }
  }
  const oldExpiry = Date.parse(previous.effectiveExpiry);
  const newExpiry = Date.parse(next.effectiveExpiry);
  if (!Number.isFinite(oldExpiry) || !Number.isFinite(newExpiry) ||
      newExpiry <= oldExpiry || newExpiry - now <= RENEW_WINDOW_MS) {
    throw new Error("Xcode 未生成有效期更长的新签名；不会覆盖手机上的 App。");
  }
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function plist(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

function stringEntry(key, value) { return `<key>${xml(key)}</key><string>${xml(value)}</string>`; }

export function renewalPaths(root, home = homedir()) {
  const id = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  const label = `com.local.feishu-codex-bridge.ios-renew.${id}`;
  const state = join(home, "Library", "Application Support", "Feishu Codex Bridge", "ios-renew", id);
  return { label, state, devices: join(state, "devices"), plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
    stdout: join(state, "renew.log"), stderr: join(state, "renew-error.log") };
}

export function launchAgentPlist(paths, root, bunPath) {
  const args = [bunPath, join(root, "scripts/ios-device.mjs"), "--renew-run"];
  const path = [dirname(bunPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"].join(":");
  const environment = stringEntry("PATH", path) + (process.env.DEVELOPER_DIR ? stringEntry("DEVELOPER_DIR", process.env.DEVELOPER_DIR) : "");
  return plist(`${stringEntry("Label", paths.label)}<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>` +
    `${stringEntry("WorkingDirectory", root)}<key>EnvironmentVariables</key><dict>${environment}</dict>` +
    `<key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>` +
    `${stringEntry("StandardOutPath", paths.stdout)}${stringEntry("StandardErrorPath", paths.stderr)}`);
}

function stateDirectory(paths, udid) {
  return join(paths.devices, createHash("sha256").update(udid).digest("hex").slice(0, 24));
}

function archiveApp(app, archive, signing) {
  const destination = join(archive, "Products", "Applications", "App.app");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  command("/usr/bin/ditto", [app, destination]);
  const info = join(app, "Info.plist");
  const properties = stringEntry("ApplicationPath", "Applications/App.app") +
    stringEntry("CFBundleIdentifier", plistValue(info, "CFBundleIdentifier")) +
    stringEntry("CFBundleShortVersionString", plistValue(info, "CFBundleShortVersionString")) +
    stringEntry("CFBundleVersion", plistValue(info, "CFBundleVersion")) + stringEntry("Team", signing.team);
  writeFileSync(join(archive, "Info.plist"), plist(`<key>ApplicationProperties</key><dict>${properties}</dict>` +
    `<key>ArchiveVersion</key><integer>2</integer>${stringEntry("Name", "Bridge")}${stringEntry("SchemeName", "App")}` +
    `<key>CreationDate</key><date>${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`), { mode: 0o600 });
}

function stateApp(directory, record) {
  if (!/^snapshot-[a-f0-9-]+\.xcarchive$/.test(record.archive)) throw new Error("续签快照路径无效。");
  return join(directory, record.archive, "Products", "Applications", "App.app");
}

export function assertInstalledMatches(record, installed) {
  const bundleId = record.bundleId ?? legacyBundleId;
  if (!installed || installed.bundleIdentifier !== bundleId || !installed.bundleContainerPath ||
      installed.bundleContainerPath !== record.bundleContainerPath || installed.bundleVersion !== record.bundleVersion) {
    throw new Error("手机上的 Bridge 已被移除或由其他方式更换，已暂停自动覆盖；请重新运行安装命令。");
  }
}

export function rememberInstallation(paths, device, app, installed, signing, wirelessOnly) {
  const bundleId = signing.bundleId ?? installed?.bundleIdentifier ?? legacyBundleId;
  if (!installed?.bundleContainerPath || installed.bundleIdentifier !== bundleId || typeof installed.bundleVersion !== "string") {
    throw new Error("无法确认设备上的 App 安装身份，未启用自动续签。");
  }
  const directory = stateDirectory(paths, device.udid);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = `snapshot-${randomUUID()}.xcarchive`;
  const archivePath = join(directory, archive);
  let previous;
  try { previous = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")); } catch {}
  try {
    archiveApp(app, archivePath, signing);
    const record = { version: 1, bundleId, udid: device.udid, name: device.name, wirelessOnly, archive,
      bundleContainerPath: installed.bundleContainerPath, bundleVersion: installed.bundleVersion,
      signing, installedAt: new Date().toISOString() };
    const staged = join(directory, `state-${randomUUID()}.tmp`);
    writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(staged, join(directory, "state.json"));
    if (previous?.archive && previous.archive !== archive && /^snapshot-[a-f0-9-]+\.xcarchive$/.test(previous.archive)) {
      try { rmSync(join(directory, previous.archive), { recursive: true, force: true }); }
      catch (error) { console.error(`旧续签快照未清理：${error instanceof Error ? error.message : String(error)}`); }
    }
    return record;
  } catch (error) {
    rmSync(archivePath, { recursive: true, force: true });
    throw error;
  }
}

function launchctl(args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

export function enableRenewal(paths, root, bunPath) {
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.plist), { recursive: true, mode: 0o700 });
  const staged = `${paths.plist}.${randomUUID()}.tmp`;
  writeFileSync(staged, launchAgentPlist(paths, root, bunPath), { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${paths.label}`;
  if (launchctl(["print", service]).status === 0) {
    const stopped = launchctl(["bootout", service]);
    if (stopped.status !== 0) { unlinkSync(staged); throw new Error(`无法更新自动续签任务：${stopped.stderr?.trim()}`); }
  }
  renameSync(staged, paths.plist);
  const started = launchctl(["bootstrap", domain, paths.plist]);
  if (started.status !== 0) throw new Error(`无法启用自动续签任务：${started.stderr?.trim()}`);
}

export function disableRenewal(paths) {
  const service = `gui/${process.getuid()}/${paths.label}`;
  if (launchctl(["print", service]).status === 0) {
    const stopped = launchctl(["bootout", service]);
    if (stopped.status !== 0) throw new Error(`无法停止自动续签任务：${stopped.stderr?.trim()}`);
  }
  if (existsSync(paths.plist)) unlinkSync(paths.plist);
  restoreProfileBackups();
}

export function readRecords(paths) {
  if (!existsSync(paths.devices)) return [];
  return readdirSync(paths.devices, { withFileTypes: true }).filter((item) => item.isDirectory() && existsSync(join(paths.devices, item.name, "state.json"))).map((item) => {
    const directory = join(paths.devices, item.name);
    const record = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    if (record.version !== 1 || typeof record.udid !== "string" || stateDirectory(paths, record.udid) !== directory) {
      throw new Error(`自动续签状态无效：${directory}`);
    }
    return { directory, record };
  });
}

export function printRenewalStatus(paths) {
  const service = `gui/${process.getuid()}/${paths.label}`;
  console.log(`自动续签：${launchctl(["print", service]).status === 0 ? "已启用" : "未启用"}`);
  const records = readRecords(paths);
  if (!records.length) console.log("没有由本安装脚本登记的设备；成功安装一次后会自动登记。");
  for (const { record } of records) {
    console.log(`${record.name}：签名最早到期 ${new Date(record.signing.effectiveExpiry).toLocaleString()}；` +
      `${renewalDue(record.signing) ? "已进入续签窗口" : "到期前 24 小时开始续签"}`);
  }
  console.log(`续签日志：${paths.stdout}；错误日志：${paths.stderr}`);
}

function profileDirectories() {
  return [join(homedir(), "Library/MobileDevice/Provisioning Profiles"),
    join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles")];
}

// Store backups outside Xcode's watched profile directory: Xcode may delete
// files with an unfamiliar extension from that directory while provisioning.
function backupDirectory(directory) {
  const id = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  return join(dirname(directory), ".bridge-ios-renew-profile-backups", id);
}

export function restoreProfileBackups(directories = profileDirectories()) {
  for (const directory of directories) {
    const backups = backupDirectory(directory);
    if (!existsSync(backups) || !existsSync(directory)) continue;
    for (const file of readdirSync(backups)) {
      const match = file.match(/^(.*\.mobileprovision)\.bridge-ios-renew-[a-f0-9-]+\.backup$/);
      if (!match) continue;
      const original = join(directory, match[1]);
      if (!existsSync(original)) renameSync(join(backups, file), original);
    }
  }
}

export function withFreshProfileRequest(previous, operation, directories = profileDirectories(), profileReader = readProfile) {
  const hidden = [];
  restoreProfileBackups(directories);
  try {
    for (const directory of directories) {
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory)) {
        if (!file.endsWith(".mobileprovision")) continue;
        const path = join(directory, file);
        if (!lstatSync(path).isFile()) continue;
        let profile;
        try { profile = profileReader(path); } catch { continue; }
        const exact = previous.profiles.some((old) => old.team === profile.team && old.applicationIdentifier === profile.applicationIdentifier);
        if (!exact || !profile.name.startsWith("iOS Team Provisioning Profile:")) continue;
        const backupDir = backupDirectory(directory);
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const backup = join(backupDir, `${file}.bridge-ios-renew-${randomUUID()}.backup`);
        renameSync(path, backup);
        hidden.push({ path, backup });
      }
    }
    return operation();
  } finally {
    for (const { path, backup } of hidden.reverse()) {
      if (!existsSync(backup)) continue;
      if (!existsSync(path)) renameSync(backup, path);
      else console.error(`Xcode 已重新创建描述文件；原文件备份保留在 ${backup}`);
    }
  }
}

export function selectFreshProfiles(previous, udid, profiles, identities, now = Date.now()) {
  for (const identity of identities) {
    const selected = previous.profiles.map((old) => profiles
      .filter((profile) => profile.team === old.team && profile.applicationIdentifier === old.applicationIdentifier &&
        profile.name.startsWith("iOS Team Provisioning Profile:") && profile.devices.includes(udid) &&
        profile.certificates.some((certificate) => certificate.fingerprint === identity && Date.parse(certificate.expiresAt) > now + RENEW_WINDOW_MS))
      .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0]);
    if (selected.some((profile) => !profile)) continue;
    const times = selected.flatMap((profile) => [Date.parse(profile.expiresAt), Date.parse(profile.certificates.find((certificate) => certificate.fingerprint === identity).expiresAt)]);
    const expiry = Math.min(...times);
    if (Number.isFinite(expiry) && expiry > Date.parse(previous.effectiveExpiry) && expiry > now + RENEW_WINDOW_MS) {
      return { profiles: selected, identity };
    }
  }
  return null;
}

function findFreshProfiles(previous, udid, now) {
  const profiles = [];
  for (const directory of profileDirectories()) {
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".mobileprovision")) continue;
      const path = join(directory, file);
      try { profiles.push({ ...readProfile(path), path }); } catch { /* Ignore unrelated or invalid profiles. */ }
    }
  }
  const output = command("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = [...output.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"/gm)].map((match) => match[1]);
  return selectFreshProfiles(previous, udid, profiles, identities, now);
}

function signedMachO(path) {
  const descriptor = openSync(path, "r");
  const bytes = Buffer.alloc(4);
  try { if (readSync(descriptor, bytes, 0, 4, 0) !== 4) return false; }
  finally { closeSync(descriptor); }
  const magic = bytes.readUInt32BE();
  if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return false;
  return spawnSync("/usr/bin/codesign", ["-d", path], { stdio: "ignore" }).status === 0;
}

export function resignSnapshot(snapshot, destination, previous, selection) {
  command("/usr/bin/ditto", [snapshot, destination]);
  for (const old of previous.profiles) {
    const profile = selection.profiles.find((candidate) => candidate.team === old.team && candidate.applicationIdentifier === old.applicationIdentifier);
    if (!profile || old.bundlePath.startsWith("/") || old.bundlePath.split("/").includes("..")) throw new Error("无法安全匹配 App 与描述文件。");
    copyFileSync(profile.path, join(destination, old.bundlePath, "embedded.mobileprovision"));
  }
  const sign = (path) => command("/usr/bin/codesign", ["--force", "--sign", selection.identity,
    "--preserve-metadata=identifier,entitlements,flags,runtime", path]);
  const walk = (directory, isBundle) => {
    let executable = null;
    if (isBundle) executable = plistValue(join(directory, "Info.plist"), "CFBundleExecutable");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "_CodeSignature") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = /\.(app|appex|framework|xpc)$/.test(entry.name) && existsSync(join(path, "Info.plist"));
        walk(path, nested);
        if (nested) sign(path);
      } else if (entry.isFile() && entry.name !== executable && signedMachO(path)) sign(path);
    }
  };
  walk(destination, true);
  sign(destination);
  return destination;
}

// A minimal, disposable target lets Xcode's normal development-signing path
// request a profile even when automatic archive export is unavailable to a
// Personal Team. It never builds or installs the current workspace sources.
export function provisioningProject(snapshot, profile, directory) {
  if (!/^[A-Z0-9]+$/.test(profile.team) || !/^[A-Za-z0-9.-]+$/.test(profile.bundleId) ||
      profile.bundlePath.startsWith("/") || profile.bundlePath.split("/").includes("..")) {
    throw new Error("签名目标的标识或路径无效。");
  }
  const extension = profile.bundlePath.endsWith(".appex");
  if (profile.bundlePath && !extension) throw new Error(`暂不支持的签名目标：${profile.bundlePath}`);
  const bundle = join(snapshot, profile.bundlePath);
  const project = join(directory, "Profile.xcodeproj");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  copyFileSync(join(bundle, "Info.plist"), join(directory, "AppInfo.plist"));
  writeFileSync(join(directory, "App.entitlements"), entitlementsXml(bundle), { mode: 0o600 });
  writeFileSync(join(directory, "main.c"), "int main(int argc, char **argv) { return 0; }\n", { mode: 0o600 });
  const productType = extension ? "com.apple.product-type.app-extension" : "com.apple.product-type.application";
  const wrapperType = extension ? "wrapper.app-extension" : "wrapper.application";
  const productFile = extension ? "App.appex" : "App.app";
  const linker = extension ? 'OTHER_LDFLAGS = "-framework Foundation";' : "";
  const pbx = `// !$*UTF8*$!
{
 archiveVersion = 1; classes = {}; objectVersion = 56;
 objects = {
  A00000000000000000000001 = { isa = PBXProject; attributes = { LastUpgradeCheck = 1600; TargetAttributes = { A00000000000000000000002 = { CreatedOnToolsVersion = 16.0; DevelopmentTeam = ${profile.team}; ProvisioningStyle = Automatic; }; }; }; buildConfigurationList = A00000000000000000000003; compatibilityVersion = "Xcode 14.0"; mainGroup = A00000000000000000000004; productRefGroup = A00000000000000000000005; projectDirPath = ""; projectRoot = ""; targets = (A00000000000000000000002,); };
  A00000000000000000000002 = { isa = PBXNativeTarget; buildConfigurationList = A00000000000000000000006; buildPhases = (A00000000000000000000007,); buildRules = (); dependencies = (); name = App; productName = App; productReference = A00000000000000000000008; productType = "${productType}"; };
  A00000000000000000000003 = { isa = XCConfigurationList; buildConfigurations = (A00000000000000000000009,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
  A00000000000000000000004 = { isa = PBXGroup; children = (A0000000000000000000000A,A00000000000000000000005,); sourceTree = "<group>"; };
  A00000000000000000000005 = { isa = PBXGroup; children = (A00000000000000000000008,); name = Products; sourceTree = "<group>"; };
  A00000000000000000000006 = { isa = XCConfigurationList; buildConfigurations = (A0000000000000000000000B,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
  A00000000000000000000007 = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A0000000000000000000000C,); runOnlyForDeploymentPostprocessing = 0; };
  A00000000000000000000008 = { isa = PBXFileReference; explicitFileType = ${wrapperType}; includeInIndex = 0; path = ${productFile}; sourceTree = BUILT_PRODUCTS_DIR; };
  A00000000000000000000009 = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = iphoneos; }; name = Debug; };
  A0000000000000000000000A = { isa = PBXFileReference; lastKnownFileType = sourcecode.c.c; path = main.c; sourceTree = "<group>"; };
  A0000000000000000000000B = { isa = XCBuildConfiguration; buildSettings = { CODE_SIGN_STYLE = Automatic; CODE_SIGN_ENTITLEMENTS = App.entitlements; DEVELOPMENT_TEAM = ${profile.team}; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = AppInfo.plist; IPHONEOS_DEPLOYMENT_TARGET = 15.0; ${linker} PRODUCT_BUNDLE_IDENTIFIER = ${profile.bundleId}; PRODUCT_NAME = App; SDKROOT = iphoneos; TARGETED_DEVICE_FAMILY = "1,2"; }; name = Debug; };
  A0000000000000000000000C = { isa = PBXBuildFile; fileRef = A0000000000000000000000A; };
 };
 rootObject = A00000000000000000000001;
}
`;
  writeFileSync(join(project, "project.pbxproj"), pbx, { mode: 0o600 });
  return project;
}

export function requestProfilesByBuilding(snapshot, previous, directory) {
  for (const [index, profile] of previous.profiles.entries()) {
    const work = join(directory, `profile-target-${index}`);
    try {
      const project = provisioningProject(snapshot, profile, work);
      command("/usr/bin/xcodebuild", ["-project", project, "-target", "App", "-configuration", "Debug", "-sdk", "iphoneos",
        "-allowProvisioningUpdates", `SYMROOT=${join(work, "products")}`, `OBJROOT=${join(work, "objects")}`, "-quiet", "build"],
        { timeout: 2 * 60_000, stdio: "inherit" });
    } catch (error) {
      console.log(`Xcode 请求 ${profile.bundleId} 描述文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function requestRenewedApp(directory, record, temp, now) {
  restoreProfileBackups();
  let selection = findFreshProfiles(record.signing, record.udid, now);
  if (!selection) {
    selection = withFreshProfileRequest(record.signing, () => {
      requestProfilesByBuilding(stateApp(directory, record), record.signing, temp);
      const fresh = findFreshProfiles(record.signing, record.udid, now);
      if (!fresh) throw new Error("Xcode 未提供包含目标设备且有效期更长的主 App 和扩展描述文件。");
      for (const [index, profile] of fresh.profiles.entries()) {
        const copy = join(temp, `fresh-${index}.mobileprovision`);
        copyFileSync(profile.path, copy);
        profile.path = copy;
      }
      return fresh;
    });
  }
  const snapshot = stateApp(directory, record);
  const app = resignSnapshot(snapshot, join(temp, "Renewed.app"), record.signing, selection);
  const signing = inspectSignedApp(app, record.udid);
  validateRenewal(record.signing, signing, record.udid, now);
  return { app, signing };
}

export function renewOne(directory, record, api, options = {}) {
  const now = options.now ?? Date.now();
  if (!options.force && !renewalDue(record.signing, now)) return false;
  const snapshot = api.inspect(stateApp(directory, record), record.udid);
  if (snapshot.effectiveExpiry !== record.signing.effectiveExpiry || snapshot.team !== record.signing.team) {
    throw new Error("续签快照与已登记的签名不一致，请重新运行安装命令。");
  }
  const device = api.device(record);
  assertInstalledMatches(record, api.installed(device.udid, record.bundleId ?? legacyBundleId));
  const temp = mkdtempSync(join(tmpdir(), "bridge-ios-renew-"));
  try {
    const candidate = api.renew(directory, record, temp, now);
    validateRenewal(snapshot, candidate.signing, record.udid, now);
    assertInstalledMatches(record, api.installed(device.udid, record.bundleId ?? legacyBundleId));
    api.install(device, candidate.app);
    const installed = api.installed(device.udid, record.bundleId ?? legacyBundleId);
    if (!installed?.bundleContainerPath || installed.bundleIdentifier !== (record.bundleId ?? legacyBundleId)) throw new Error("安装后无法确认 Bridge，未更新续签记录。");
    api.remember(device, candidate.app, installed, candidate.signing, record.wirelessOnly);
    return true;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function notifyRenewalIssue(message) {
  const script = 'on run argv\n display notification (item 1 of argv) with title "Bridge iOS 自动续签"\nend run';
  spawnSync("/usr/bin/osascript", ["-e", script, message], { stdio: "ignore", timeout: 10_000 });
}

export function runRenewal(paths, adapter, options = {}) {
  restoreProfileBackups();
  const records = readRecords(paths);
  if (!records.length) throw new Error("没有已登记的 iOS 安装，请先运行安装命令。");
  let errors = 0;
  for (const { directory, record } of records) {
    try {
      const changed = renewOne(directory, record, {
        inspect: inspectSignedApp,
        device: adapter.device,
        installed: adapter.installed,
        install: adapter.install,
        renew: requestRenewedApp,
        remember: (device, app, installed, signing, wirelessOnly) => rememberInstallation(paths, device, app, installed, signing, wirelessOnly),
      }, options);
      if (changed) { console.log(`${record.name} 自动续签并安装成功。`); notifyRenewalIssue(`${record.name} 的 Bridge 已重新签名并安装。`); }
      else console.log(`${record.name} 尚未进入续签窗口。`);
    } catch (error) {
      errors++;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`${record.name} 自动续签失败：${detail}`);
      notifyRenewalIssue(`${record.name} 续签失败，请连接 iPhone 并查看 Mac 上的续签日志。`);
    }
  }
  if (errors) throw new Error(`${errors} 台设备续签失败，将在下次定时检查时重试。`);
}
