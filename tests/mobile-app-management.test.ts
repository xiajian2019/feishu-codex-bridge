import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileApkStore } from "../src/mobile-apk.js";
import { StateDatabase } from "../src/db.js";

describe("App management", () => {
  test("keeps legacy iOS records and supports iOS-only, Android-only, and dual-platform records", () => {
    const db = new StateDatabase(":memory:");
    const legacy = db.createIosTestflightApp({
      name: "Legacy", app_store_name: "Legacy", source_path: "/tmp/legacy", project_path: "/tmp/legacy/App.xcodeproj",
      build_directory: "/tmp/legacy/build", public_directory: "/tmp/legacy/public", bundle_id: "com.example.legacy", team_id: "AAAAAAAAAA",
      scheme: "App", configuration: "PersonalRelease", target_name: "App", info_plist_path: "App/Info.plist", enabled: true, internal_only: true,
    });
    const android = db.createMobileApp({
      name: "Android only", enabled: true, ios: null,
      android: { package_name: "com.example.android", apk_path: "/tmp/android/app-debug.apk", snapshot_directory: "" },
    });
    const dual = db.createMobileApp({
      name: "Dual", enabled: true,
      ios: {
        app_store_name: "Dual", source_path: "/tmp/dual", project_path: "/tmp/dual/App.xcodeproj", build_directory: "/tmp/dual/build",
        public_directory: "/tmp/dual/public", bundle_id: "com.example.dual", team_id: "BBBBBBBBBB", scheme: "App", configuration: "Release",
        target_name: "App", info_plist_path: "App/Info.plist", internal_only: false,
      },
      android: { package_name: "com.example.dual", apk_path: "/tmp/dual/app-debug.apk", snapshot_directory: "" },
    });
    const apps = db.listMobileApps();
    expect(apps.map((app) => app.id)).toEqual(expect.arrayContaining([legacy.id, android.id, dual.id]));
    expect(db.getMobileApp(legacy.id)?.ios?.bundle_id).toBe("com.example.legacy");
    expect(db.getMobileApp(android.id)?.ios).toBeNull();
    expect(db.getMobileApp(android.id)?.android?.snapshot_directory).toBe("/tmp/android/.bridge-mobile-apps/" + android.id);
    expect(db.getMobileApp(dual.id)?.android?.package_name).toBe("com.example.dual");
    db.close();
  });

  test("uses the same immutable APK snapshot contract for managed Android apps", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-managed-apk-"));
    try {
      const apk = join(root, "demo.apk");
      await writeFile(apk, "demo artifact");
      await writeFile(join(root, "output-metadata.json"), JSON.stringify({ applicationId: "com.example.demo", elements: [{ outputFile: "demo.apk", versionCode: 7, versionName: "1.2.3" }] }));
      const store = new MobileApkStore(apk, join(root, "snapshots"), {
        expectedPackageName: "com.example.demo", downloadPath: "/api/mobile/apps/demo/android/download",
      });
      const metadata = await store.latest();
      expect(metadata?.downloadUrl).toContain("/api/mobile/apps/demo/android/download?revision=");
      expect(metadata?.packageName).toBe("com.example.demo");
      expect(metadata?.versionCode).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
