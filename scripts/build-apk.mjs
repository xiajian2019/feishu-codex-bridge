#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync, accessSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const usage = "用法：在 Feishu Codex Bridge checkout 内运行 bun scripts/build-apk.mjs [--check]";

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${options.label || command} 无法启动：${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || "").trim().slice(0, 1000) : "";
    throw new Error(`${options.label || command} 失败（${result.signal || result.status}）${detail ? `：${detail}` : ""}`);
  }
  return capture ? result.stdout : "";
}

function executable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

function projectAt(cwd) {
  let root;
  try { root = realpathSync(run("git", ["rev-parse", "--show-toplevel"], { cwd, capture: true }).trim()); }
  catch { throw new Error("当前目录不在 Git checkout 内，请先进入 Feishu Codex Bridge 的目标 checkout。"); }
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); }
  catch { throw new Error(`无法读取 ${root} 的 package.json。`); }
  if (pkg.name !== "feishu-codex-bridge") throw new Error(`当前 checkout 不是 feishu-codex-bridge：${root}`);
  for (const path of [".bun-version", "android/gradlew", "android/variables.gradle", "android/gradle/wrapper/gradle-wrapper.properties", "web/vite.mobile.config.ts", "node_modules/.bin/vite", "node_modules/.bin/cap"]) {
    if (!existsSync(join(root, path))) throw new Error(`当前 checkout 缺少 ${path}；请先准备项目依赖。`);
  }
  if (!executable(join(root, "android/gradlew"))) throw new Error("当前 checkout 的 android/gradlew 不可执行。");
  return root;
}

function javaVersion(home) {
  const java = join(home, "bin", "java");
  if (!executable(java) || !executable(join(home, "bin", "javac"))) return null;
  const result = spawnSync(java, ["-version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  const match = /version\s+"(\d+)(?:[.\-+\"]|$)/.exec(text);
  return match && Number(match[1]) >= 21 ? match[1] : null;
}

function findJava(env) {
  const candidates = [env.JAVA_HOME, "/opt/homebrew/opt/openjdk"].filter(Boolean);
  if (executable("/usr/libexec/java_home")) {
    const result = spawnSync("/usr/libexec/java_home", ["-v", "21+"], { encoding: "utf8" });
    if (!result.error && result.status === 0 && result.stdout.trim()) candidates.push(result.stdout.trim());
  }
  for (const home of candidates) {
    const version = javaVersion(home);
    if (version) return { home, version };
  }
  throw new Error("找不到可用的 JDK 21+。请检查 JAVA_HOME 或 /opt/homebrew/opt/openjdk；不要仅依据 /usr/bin/java 判断。");
}

function localSdk(root) {
  const file = join(root, "android/local.properties");
  if (!existsSync(file)) return null;
  const match = /^\s*sdk\.dir\s*[:=]\s*(.*?)\s*$/m.exec(readFileSync(file, "utf8"));
  if (!match) return null;
  const value = match[1].replace(/\\([ :\\])/g, "$1");
  return isAbsolute(value) ? value : resolve(root, "android", value);
}

function compareVersions(a, b) {
  const left = a.split(/[.\-]/).map((v) => Number(v) || 0);
  const right = b.split(/[.\-]/).map((v) => Number(v) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (right[i] || 0) - (left[i] || 0);
  }
  return 0;
}

function wrapperCacheStatus(gradleHome, distribution) {
  const archive = distribution.split("/").pop() || "";
  const distributionName = archive.replace(/\.zip$/, "");
  const installName = distributionName.replace(/-(all|bin)$/, "");
  if (!/^gradle-[\w.\-]+$/.test(distributionName)) return "无法自动判断";
  const cacheDir = join(gradleHome, "wrapper", "dists", distributionName);
  if (!existsSync(cacheDir)) return "未发现该版本的缓存，wrapper 可能需要下载";
  return readdirSync(cacheDir).some((entry) => executable(join(cacheDir, entry, installName, "bin", "gradle")))
    ? "已发现该版本的 wrapper 缓存"
    : "未发现完整的 wrapper 缓存，wrapper 可能需要下载";
}

function findSdk(root, env) {
  const configured = localSdk(root);
  const home = configured || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || join(homedir(), "Library/Android/sdk");
  if (!existsSync(home)) throw new Error(`Android SDK 不存在：${home}；请检查 android/local.properties 或 ANDROID_HOME。`);
  const variables = readFileSync(join(root, "android/variables.gradle"), "utf8");
  const major = /^\s*compileSdkVersion\s*=\s*(\d+)\s*(?:\/\/.*)?$/m.exec(variables)?.[1];
  const minor = /^\s*compileSdkMinorApiLevel\s*=\s*(\d+)\s*(?:\/\/.*)?$/m.exec(variables)?.[1];
  if (!major) throw new Error("无法从 android/variables.gradle 读取 compileSdkVersion，请检查当前项目配置。");
  const platform = `android-${major}${minor && minor !== "0" ? `.${minor}` : ""}`;
  if (!existsSync(join(home, "platforms", platform))) throw new Error(`Android SDK 缺少平台 ${platform}：${home}`);
  const toolsDir = join(home, "build-tools");
  const versions = existsSync(toolsDir) ? readdirSync(toolsDir).filter((v) => /^\d/.test(v)).sort(compareVersions) : [];
  for (const version of versions) {
    const aapt = join(toolsDir, version, "aapt");
    const signer = join(toolsDir, version, "apksigner");
    if (executable(aapt) && executable(signer)) return { home, platform, version, aapt, signer, configured: Boolean(configured) };
  }
  throw new Error(`Android SDK 缺少可执行的 aapt 和 apksigner：${toolsDir}`);
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function readApkIndex(apk, env) {
  const result = spawnSync("unzip", ["-p", apk, "assets/public/index.html"], { env, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("无法从 APK 读取 assets/public/index.html。");
  return result.stdout;
}

function acquireLock(root) {
  const id = hashBytes(Buffer.from(root)).slice(0, 20);
  const directory = join(tmpdir(), `bridge-android-apk-${id}.lock`);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`此 checkout 的打包锁已存在：${directory}；请先检查是否有活动构建。`);
    throw error;
  }
  const owner = join(directory, "owner.json");
  try { writeFileSync(owner, JSON.stringify({ pid: process.pid, root, startedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" }); }
  catch (error) { rmdirSync(directory); throw error; }
  return () => {
    try { unlinkSync(owner); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { rmdirSync(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(usage); return; }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error(usage);
  const checkOnly = args[0] === "--check";
  const root = projectAt(process.cwd());
  const status = run("git", ["status", "--short", "--branch"], { cwd: root, capture: true });
  const branchResult = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  if (branchResult.error) throw new Error(`无法检查当前分支：${branchResult.error.message}`);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : "";
  if (!checkOnly && branch === "master") {
    throw new Error("当前 checkout 位于 master，Android 同步可能修改仓库配置。请先由用户指定隔离方式或提供非 master checkout；不要在当前会话自动创建 worktree。");
  }
  const bun = process.env.BRIDGE_BUN_PATH || process.execPath;
  const expectedBun = readFileSync(join(root, ".bun-version"), "utf8").trim();
  const actualBun = run(bun, ["--version"], { cwd: root, capture: true, label: "Bun" }).trim();
  if (actualBun !== expectedBun) throw new Error(`Bun 版本为 ${actualBun}，当前 checkout 的 .bun-version 需要 ${expectedBun}。`);
  const java = findJava(process.env);
  const sdk = findSdk(root, process.env);
  const wrapper = readFileSync(join(root, "android/gradle/wrapper/gradle-wrapper.properties"), "utf8");
  const distribution = /^distributionUrl=(.*)$/m.exec(wrapper)?.[1]?.replace(/\\:/g, ":");
  if (!distribution) throw new Error("无法读取 Gradle wrapper distributionUrl。");
  const gradleHome = process.env.GRADLE_USER_HOME || join(homedir(), ".gradle");
  const env = {
    ...process.env,
    JAVA_HOME: java.home,
    ANDROID_HOME: sdk.home,
    ANDROID_SDK_ROOT: sdk.home,
    BRIDGE_BUN_PATH: bun,
    PATH: `${join(java.home, "bin")}:${join(sdk.home, "platform-tools")}:${process.env.PATH || ""}`,
  };
  console.log(`项目：${root}\n${status.trimEnd()}\nBun：${actualBun} (${bun})\nJDK：${java.version} (${java.home})\nAndroid SDK：${sdk.home}${sdk.configured ? " (local.properties)" : ""}；${sdk.platform}；build-tools ${sdk.version}\nGradle wrapper：${distribution.split("/").pop()}\nGradle 缓存：${gradleHome}；${wrapperCacheStatus(gradleHome, distribution)}`);
  if (checkOnly) { console.log("环境检查通过；未构建 APK。"); return; }

  const releaseLock = acquireLock(root);
  try {
    console.log("\n[1/4] 构建移动端页面");
    run(bun, ["run", "--bun", "vite", "build", "--config", "web/vite.mobile.config.ts"], { cwd: root, env, label: "移动端页面构建" });
    console.log("\n[2/4] 同步 Android 资源");
    run(bun, ["run", "--bun", "cap", "sync", "android"], { cwd: root, env, label: "Capacitor Android 同步" });
    console.log("\n[3/4] 运行 Android 单元测试并构建 debug APK");
    run(join(root, "android/gradlew"), ["--no-parallel", ":app:testDebugUnitTest", ":app:assembleDebug"], { cwd: join(root, "android"), env, label: "Gradle" });

    console.log("\n[4/4] 核验 APK");
    const outputDir = join(root, "android/app/build/outputs/apk/debug");
    const apk = join(outputDir, "app-debug.apk");
    const metadataFile = join(outputDir, "output-metadata.json");
    if (!existsSync(apk) || !existsSync(metadataFile) || statSync(apk).size === 0) throw new Error("Gradle 未产生可用 APK 或 output-metadata.json。");
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    const entries = Array.isArray(metadata.elements) ? metadata.elements.filter((entry) => entry.outputFile === "app-debug.apk") : [];
    if (metadata.variantName !== "debug" || entries.length !== 1 || !metadata.applicationId || !entries[0].versionName || !Number.isSafeInteger(entries[0].versionCode)) {
      throw new Error("APK 元数据不完整或不是预期的 debug 产物。");
    }
    run("unzip", ["-tq", apk], { cwd: root, env, label: "APK 归档校验" });
    run(sdk.signer, ["verify", "--verbose", apk], { cwd: root, env, label: "APK 签名校验" });
    const badging = run(sdk.aapt, ["dump", "badging", apk], { cwd: root, env, capture: true, label: "APK 元数据读取" });
    const packageLine = badging.split(/\r?\n/).find((line) => line.startsWith("package: ")) || "";
    const packageId = /\bname='([^']+)'/.exec(packageLine)?.[1];
    const versionCode = /\bversionCode='(\d+)'/.exec(packageLine)?.[1];
    const versionName = /\bversionName='([^']+)'/.exec(packageLine)?.[1];
    if (packageId !== metadata.applicationId || versionCode !== String(entries[0].versionCode) || versionName !== entries[0].versionName) {
      throw new Error("APK 内容与 output-metadata.json 的包名或版本不一致。");
    }
    const mobileIndex = readFileSync(join(root, "dist/mobile/index.html"));
    const syncedIndex = readFileSync(join(root, "android/app/src/main/assets/public/index.html"));
    const indexHash = hashBytes(mobileIndex);
    if (indexHash !== hashBytes(syncedIndex) || indexHash !== hashBytes(readApkIndex(apk, env))) {
      throw new Error("APK 内页面与本次构建的移动端页面不一致。");
    }
    const stats = statSync(apk);
    const sha256 = await hashFile(apk);
    const abi = badging.split(/\r?\n/).find((line) => line.startsWith("native-code:")) || "native-code: 未声明";
    console.log(`\n打包完成\nAPK：${apk}\n包名：${packageId}\n版本：${versionName} (${versionCode})\n大小：${stats.size} bytes\n修改时间：${stats.mtime.toISOString()}\nSHA-256：${sha256}\n${abi}\n验证：Gradle Android JVM 单元测试任务成功（可能复用缓存）；APK 签名与归档、移动端页面摘要通过。\n真机安装和运行验证未执行。`);
  } finally {
    releaseLock();
  }
}

main().catch((error) => { console.error(`打包失败：${error.message}`); process.exitCode = 1; });
