import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { MobileAndroidBuild } from "../src/mobile-android-build.js";
import { MobileApkStore } from "../src/mobile-apk.js";
import type { StoredMobileApp } from "../src/types.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function completed(build: MobileAndroidBuild, app: StoredMobileApp): Promise<ReturnType<MobileAndroidBuild["status"]>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = build.status(app);
    if (state.state !== "running") return state;
    await pause(50);
  }
  throw new Error("fixture build did not finish");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-managed-android-test-"));
  const apk = join(root, "android/app/build/outputs/apk/debug/app-debug.apk");
  const script = join(root, "scripts/build-apk.mjs");
  mkdirSync(dirname(script), { recursive: true });
  const scriptSource = `import { mkdirSync, writeFileSync } from "node:fs";\nawait Bun.sleep(350);\nmkdirSync(${JSON.stringify(dirname(apk))}, { recursive: true });\nwriteFileSync(${JSON.stringify(apk)}, "new apk bytes");\nwriteFileSync(${JSON.stringify(join(dirname(apk), "output-metadata.json"))}, JSON.stringify({ applicationId: "com.example.android", elements: [{ outputFile: "app-debug.apk", versionCode: 8, versionName: "2.0" }] }));\nconsole.log("fixture build complete");\n`;
  writeFileSync(script, scriptSource);
  const db = new StateDatabase(":memory:");
  const input = { name: "Example", enabled: true, ios: null, android: { package_name: "com.example.android", apk_path: apk, snapshot_directory: join(root, "snapshots") } };
  const app = db.createMobileApp(input);
  return { root, apk, script, scriptSource, db, input, app };
}

describe("managed Android builds", () => {
  test("infers the Android checkout, serializes builds, records logs and snapshots, and preserves old downloads on failure", async () => {
    const f = fixture();
    try {
      const build = new MobileAndroidBuild();
      const otherServer = new MobileAndroidBuild();
      const other = f.db.createMobileApp({ ...f.input, name: "Same checkout", android: { ...f.input.android, snapshot_directory: join(f.root, "other-snapshots") } });
      expect(build.status(f.app).sourcePath).toBe(realpathSync(f.root));
      expect(build.status(f.app).available).toBe(true);
      expect(build.start(f.app).state).toBe("running");
      expect(otherServer.status(f.app).state).toBe("running");
      expect(otherServer.status(other).available).toBe(false);
      expect(() => otherServer.start(other)).toThrow("正在进行中");
      const success = await completed(build, f.app);
      expect(success.state).toBe("succeeded");
      expect(success.log).toContain("fixture build complete");
      const store = new MobileApkStore(f.apk, f.input.android.snapshot_directory, { expectedPackageName: "com.example.android" });
      const latest = await store.latest();
      expect(latest?.versionCode).toBe(8);
      expect(readFileSync((await store.revision(latest!.revision))!.path, "utf8")).toBe("new apk bytes");
      writeFileSync(f.script, 'console.error("fixture failed"); process.exit(4);\n');
      build.start(f.app);
      const failure = await completed(build, f.app);
      expect(failure.state).toBe("failed");
      expect(failure.message).toContain("退出（4）");
      expect(failure.log).toContain("fixture failed");
      expect(await store.revision(latest!.revision)).not.toBeNull();
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  test("does not report success when the APK or metadata belongs to another package", async () => {
    const f = fixture();
    try {
      writeFileSync(f.script, f.scriptSource.replace("com.example.android", "com.example.other"));
      const build = new MobileAndroidBuild();
      build.start(f.app);
      const failure = await completed(build, f.app);
      expect(failure.state).toBe("failed");
      expect(failure.message).toContain("元数据");
      expect(build.status(f.app).available).toBe(true);
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  test("reports an interrupted build when its owner and child have gone away", () => {
    const f = fixture();
    const id = createHash("sha256").update(f.app.id).digest("hex").slice(0, 24);
    const statusFile = join(tmpdir(), "bridge-managed-android-builds", `${id}.json`);
    try {
      const config = f.app.android!;
      const key = createHash("sha256").update(JSON.stringify([config.package_name, config.apk_path, config.snapshot_directory, config.source_path ?? "", config.build_script ?? ""])).digest("hex");
      mkdirSync(dirname(statusFile), { recursive: true });
      writeFileSync(statusFile, JSON.stringify({ state: "running", configKey: key, ownerPid: 2147483647, childPid: 2147483646 }));
      const status = new MobileAndroidBuild().status(f.app);
      expect(status.state).toBe("failed");
      expect(status.message).toContain("未收到结果");
      expect(status.available).toBe(true);
    } finally { rmSync(statusFile, { force: true }); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  test("rejects script traversal and symlinks escaping the configured source", () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "bridge-managed-outside-"));
    try {
      expect(() => f.db.updateMobileApp(f.app.id, { android: { ...f.input.android, source_path: f.root, build_script: "../outside.mjs" } })).toThrow("相对路径");
      const target = join(outside, "outside.mjs");
      writeFileSync(target, "console.log('outside')"); chmodSync(target, 0o755);
      symlinkSync(target, join(f.root, "scripts/outside.mjs"));
      const app = f.db.updateMobileApp(f.app.id, { android: { ...f.input.android, source_path: f.root, build_script: "scripts/outside.mjs" } })!;
      const build = new MobileAndroidBuild();
      expect(build.status(app).available).toBe(false);
      expect(() => build.start(app)).toThrow("源码目录内");
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test("adds Android build settings to an existing database without losing platform records", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-managed-migration-"));
    const path = join(root, "bridge.db");
    try {
      let db = new StateDatabase(path);
      const app = db.createMobileApp({ name: "Legacy", enabled: true, ios: null, android: { package_name: "com.example.android", apk_path: "/tmp/app-debug.apk", snapshot_directory: "/tmp/snapshots" } });
      db.close();
      const old = new Database(path);
      old.exec("ALTER TABLE mobile_apps DROP COLUMN android_source_path; ALTER TABLE mobile_apps DROP COLUMN android_build_script;");
      old.close();
      db = new StateDatabase(path);
      expect(db.getMobileApp(app.id)?.android).toMatchObject({ package_name: "com.example.android", source_path: "", build_script: "" });
      const updated = db.updateMobileApp(app.id, { android: { package_name: "com.example.android", apk_path: "/tmp/app-debug.apk", snapshot_directory: "/tmp/snapshots", source_path: "/tmp/project", build_script: "scripts/custom.mjs" } });
      expect(updated?.android).toMatchObject({ source_path: "/tmp/project", build_script: "scripts/custom.mjs" });
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
