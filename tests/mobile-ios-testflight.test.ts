import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MobileIosTestflight } from "../src/mobile-ios-testflight.js";
import type { StoredIosTestflightApp } from "../src/types.js";

const fixtureApp: StoredIosTestflightApp = {
  id: "fixture", name: "fixture", app_store_name: "fixture", source_path: "/tmp/fixture", project_path: "/tmp/fixture/App.xcodeproj",
  build_directory: "/tmp/fixture/build", public_directory: "/tmp/fixture/public", bundle_id: "com.example.fixture", team_id: "AAAAAAAAAA",
  scheme: "App", configuration: "Release", target_name: "App", info_plist_path: "App/Info.plist", enabled: true, internal_only: true,
  created_at: "", updated_at: "",
};

describe("MobileIosTestflight", () => {
  test("rejects invalid build numbers before starting a process", () => {
    const service = new MobileIosTestflight();
    expect(() => service.startUpload(fixtureApp, 0)).toThrow("正整数");
    expect(() => service.startUpload(fixtureApp, "2")).toThrow("正整数");
  });

  test("reports status without exposing credentials", () => {
    const status = new MobileIosTestflight().status(fixtureApp);
    expect(status).not.toHaveProperty("authenticationKeyPath");
    expect(status).not.toHaveProperty("apiKey");
    expect(status.state).toBe("idle");
    expect(status.nextBuildNumber).toBeGreaterThan(0);
  });

  test("reuses the project build number after a failure before archiving", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-testflight-build-number-"));
    const project = join(root, "OneHandKit.xcodeproj");
    const buildDirectory = join(root, "build");
    mkdirSync(project, { recursive: true });
    mkdirSync(buildDirectory, { recursive: true });
    writeFileSync(join(project, "project.pbxproj"), `/* Release */ = {
      isa = XCBuildConfiguration;
      buildSettings = {
        CURRENT_PROJECT_VERSION = 1;
        INFOPLIST_FILE = OneHandKit/Info.plist;
        PRODUCT_NAME = "$(TARGET_NAME)";
      };
      name = Release;
    };`);
    writeFileSync(join(buildDirectory, ".bridge-web-upload-fixture.json"), JSON.stringify({ state: "failed", buildNumber: 1 }));
    try {
      const status = new MobileIosTestflight().status({
        ...fixtureApp,
        project_path: project,
        build_directory: buildDirectory,
        public_directory: join(root, "public"),
        configuration: "Release",
        target_name: "OneHandKit",
        info_plist_path: "OneHandKit/Info.plist",
      });
      expect(status.nextBuildNumber).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
