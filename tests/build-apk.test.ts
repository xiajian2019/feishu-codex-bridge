import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/build-apk.mjs", import.meta.url));
const created: string[] = [];

function write(file: string, content: string, executable = false) {
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, content);
  if (executable) chmodSync(file, 0o755);
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "bridge-apk-skill-test-"));
  created.push(base);
  const root = join(base, "checkout");
  const sdk = join(base, "sdk");
  const jdk = join(base, "jdk");
  const trace = join(base, "trace.log");
  const temp = join(base, "temp");
  mkdirSync(root, { recursive: true });
  mkdirSync(temp);
  const init = Bun.spawnSync(["git", "init", "-q", root], { stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  const branch = Bun.spawnSync(["git", "symbolic-ref", "HEAD", "refs/heads/fixture"], { cwd: root, stderr: "pipe" });
  if (branch.exitCode !== 0) throw new Error(branch.stderr.toString());
  write(join(root, "package.json"), JSON.stringify({ name: "feishu-codex-bridge", version: "1.2.3" }));
  write(join(root, ".bun-version"), process.versions.bun!);
  write(join(root, "web/vite.mobile.config.ts"), "// fixture\n");
  write(join(root, "android/variables.gradle"), "compileSdkVersion = 37\ncompileSdkMinorApiLevel = 2\n");
  write(join(root, "android/gradle/wrapper/gradle-wrapper.properties"), "distributionUrl=https\\://fixture/gradle.zip\n");
  write(join(root, "node_modules/.bin/vite"), "", true);
  write(join(root, "node_modules/.bin/cap"), "", true);
  mkdirSync(join(sdk, "platforms/android-37.2"), { recursive: true });
  write(join(jdk, "bin/java"), "#!/bin/sh\nprintf 'openjdk version \"21\"\\n' >&2\n", true);
  write(join(jdk, "bin/javac"), "#!/bin/sh\nexit 0\n", true);
  write(join(sdk, "build-tools/37.0.0/aapt"), String.raw`#!/bin/sh
printf 'aapt:%s\n' "$*" >> "$MOCK_TRACE"
if [ "$MOCK_FAILURE" = metadata ]; then
  printf "package: name='dev.feishu.codex.bridge' versionCode='999' versionName='1.2.3'\n"
else
  printf "package: name='dev.feishu.codex.bridge' versionCode='42' versionName='1.2.3'\n"
fi
printf "native-code: 'arm64-v8a'\n"
`, true);
  write(join(sdk, "build-tools/37.0.0/apksigner"), String.raw`#!/bin/sh
printf 'signer:%s\n' "$*" >> "$MOCK_TRACE"
if [ "$MOCK_FAILURE" = signature ]; then exit 12; fi
printf 'Verifies\n'
`, true);
  const mockBun = join(base, "bin/bun");
  write(mockBun, String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' "$MOCK_BUN_VERSION"; exit 0; fi
printf 'bun:%s\n' "$*" >> "$MOCK_TRACE"
if [ "$3" = vite ]; then
  if [ "$MOCK_FAILURE" = vite ]; then exit 11; fi
  mkdir -p dist/mobile
  printf 'fresh mobile index\n' > dist/mobile/index.html
elif [ "$3" = cap ]; then
  if [ "$MOCK_FAILURE" = sync ]; then exit 11; fi
  mkdir -p android/app/src/main/assets/public
  cp dist/mobile/index.html android/app/src/main/assets/public/index.html
else
  exit 13
fi
`, true);
  write(join(root, "android/gradlew"), String.raw`#!/bin/sh
printf 'gradle:%s\n' "$*" >> "$MOCK_TRACE"
printf 'gradle-cache:%s\n' "$GRADLE_USER_HOME" >> "$MOCK_TRACE"
printf 'gradle-bun:%s\n' "$BRIDGE_BUN_PATH" >> "$MOCK_TRACE"
if [ "$MOCK_FAILURE" = gradle ]; then exit 14; fi
out="$PWD/app/build/outputs/apk/debug"
mkdir -p "$out" "$MOCK_STAGE/assets/public"
cp ../dist/mobile/index.html "$MOCK_STAGE/assets/public/index.html"
if [ "$MOCK_FAILURE" = stale ]; then printf 'stale index\n' > "$MOCK_STAGE/assets/public/index.html"; fi
(cd "$MOCK_STAGE" && zip -q "$out/app-debug.apk" assets/public/index.html) || exit 15
printf '%s\n' '{"variantName":"debug","applicationId":"dev.feishu.codex.bridge","elements":[{"outputFile":"app-debug.apk","versionCode":42,"versionName":"1.2.3"}]}' > "$out/output-metadata.json"
`, true);
  const env = {
    ...process.env,
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    BRIDGE_BUN_PATH: mockBun,
    GRADLE_USER_HOME: join(base, "existing-gradle-cache"),
    MOCK_BUN_VERSION: process.versions.bun!,
    MOCK_TRACE: trace,
    MOCK_STAGE: join(base, "apk-stage"),
    TMPDIR: temp,
  };
  return { base, root, sdk, jdk, trace, temp, env };
}

function execute(f: ReturnType<typeof fixture>, args: string[] = [], extra: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: join(f.root, "android"),
    env: { ...f.env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Bridge Android APK skill script", () => {
  test("builds the current nested checkout, keeps the configured Gradle cache, and validates the artifact", () => {
    const f = fixture();
    const result = execute(f);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`APK：${realpathSync(f.root)}/android/app/build/outputs/apk/debug/app-debug.apk`);
    expect(result.stdout).toContain("版本：1.2.3 (42)");
    expect(result.stdout).toContain("SHA-256：");
    const trace = readFileSync(f.trace, "utf8");
    expect(trace).toContain("bun:run --bun vite build --config web/vite.mobile.config.ts");
    expect(trace).toContain("bun:run --bun cap sync android");
    expect(trace).toContain("gradle:--no-parallel :app:testDebugUnitTest :app:assembleDebug");
    expect(trace).toContain(`gradle-cache:${f.base}/existing-gradle-cache`);
    expect(trace).toContain(`gradle-bun:${f.base}/bin/bun`);
    expect(trace.indexOf("vite build")).toBeLessThan(trace.indexOf("cap sync android"));
    expect(trace.indexOf("cap sync android")).toBeLessThan(trace.indexOf("gradle:"));
    expect(trace).toContain("signer:verify --verbose");
    expect(trace).toContain("aapt:dump badging");
    expect(existsSync(join(f.temp, `bridge-android-apk-${createHash("sha256").update(realpathSync(f.root)).digest("hex").slice(0, 20)}.lock`))).toBe(false);
  });

  test("environment-only check performs no build or version allocation", () => {
    const f = fixture();
    const result = execute(f, ["--check"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("环境检查通过；未构建 APK");
    expect(existsSync(f.trace)).toBe(false);
    expect(existsSync(join(f.root, "android/.bridge-version.json"))).toBe(false);
  });

  test.each(["vite", "sync", "gradle"]) ("stops on %s failure without reporting an old APK as success", (phase) => {
    const f = fixture();
    const oldApk = join(f.root, "android/app/build/outputs/apk/debug/app-debug.apk");
    write(oldApk, "old fixture APK");
    const result = execute(f, [], { MOCK_FAILURE: phase });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("打包失败");
    expect(result.stdout).not.toContain("打包完成");
    expect(readFileSync(oldApk, "utf8")).toBe("old fixture APK");
    const trace = readFileSync(f.trace, "utf8");
    if (phase === "vite") expect(trace).not.toContain("cap sync");
    if (phase !== "gradle") expect(trace).not.toContain("gradle:");
  });

  test.each(["stale", "metadata", "signature"]) ("rejects %s artifact verification failures", (phase) => {
    const f = fixture();
    const result = execute(f, [], { MOCK_FAILURE: phase });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("打包失败");
    expect(result.stdout).not.toContain("打包完成");
  });

  test("refuses to build another repository", () => {
    const f = fixture();
    write(join(f.root, "package.json"), JSON.stringify({ name: "not-bridge" }));
    const result = execute(f);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("不是 feishu-codex-bridge");
    expect(existsSync(f.trace)).toBe(false);
  });

  test("checks master read-only but refuses a build that could rewrite tracked Android configuration", () => {
    const f = fixture();
    const changeBranch = Bun.spawnSync(["git", "symbolic-ref", "HEAD", "refs/heads/master"], { cwd: f.root });
    expect(changeBranch.exitCode).toBe(0);
    expect(execute(f, ["--check"]).code).toBe(0);
    const result = execute(f);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("位于 master");
    expect(existsSync(f.trace)).toBe(false);
  });

  test("uses the Android SDK selected by local.properties", () => {
    const f = fixture();
    write(join(f.root, "android/local.properties"), `sdk.dir=${f.sdk}\n`);
    const result = execute(f, ["--check"], { ANDROID_HOME: join(f.base, "missing-sdk"), ANDROID_SDK_ROOT: join(f.base, "missing-sdk") });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${f.sdk} (local.properties)`);
  });

  test("refuses a concurrent build of the same checkout", () => {
    const f = fixture();
    const id = createHash("sha256").update(realpathSync(f.root)).digest("hex").slice(0, 20);
    mkdirSync(join(f.temp, `bridge-android-apk-${id}.lock`));
    const result = execute(f);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("打包锁已存在");
    expect(existsSync(f.trace)).toBe(false);
  });
});
