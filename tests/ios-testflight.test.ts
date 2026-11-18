import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticationArguments,
  exportOptionsPlist,
  parseOptions,
  readAppProjectSettings,
  resolveAuthentication,
} from "../scripts/ios-testflight.mjs";

describe("iOS TestFlight upload", () => {
  test("reads the App PersonalRelease identity from the current Xcode project", () => {
    const { teamId, ...settings } = readAppProjectSettings();
    expect(settings).toEqual({
      bundleId: "dev.feishu.codex.bridge",
      buildNumber: "1",
      marketingVersion: "1.0",
    });
    expect(teamId === null || /^[A-Z0-9]{10}$/.test(teamId)).toBe(true);
  });

  test("parses safe archive and upload options", () => {
    expect(parseOptions([
      "--build-number", "12",
      "--archive-path", "ios/App/build/testflight/Bridge.xcarchive",
      "--export-path", "ios/App/build/testflight/export",
      "--internal-only",
      "--skip-mobile-build",
      "--no-provisioning-updates",
    ])).toMatchObject({
      buildNumber: 12,
      archivePath: "ios/App/build/testflight/Bridge.xcarchive",
      exportPath: "ios/App/build/testflight/export",
      internalOnly: true,
      skipMobileBuild: true,
      allowProvisioningUpdates: false,
    });
    expect(parseOptions(["--upload-only", "--archive-path", "Bridge.xcarchive"]).uploadOnly).toBe(true);
    expect(() => parseOptions(["--upload-only"])).toThrow("--upload-only 必须");
    expect(() => parseOptions(["--archive-only", "--upload-only", "--archive-path", "Bridge.xcarchive"])).toThrow("不能同时");
    expect(() => parseOptions(["--build-number", "0"])).toThrow("正整数");
    expect(() => parseOptions(["--check", "--build-number", "2"])).toThrow("--check");
  });

  test("generates a valid upload-only export options plist", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-ios-testflight-test-"));
    const file = join(directory, "ExportOptions.plist");
    try {
      writeFileSync(file, exportOptionsPlist({ internalOnly: true, teamId: "TEAM123456" }));
      expect(spawnSync("/usr/bin/plutil", ["-lint", file]).status).toBe(0);
      const json = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
      expect(JSON.parse(json.stdout)).toEqual({
        destination: "upload",
        method: "app-store-connect",
        signingStyle: "automatic",
        uploadSymbols: true,
        teamID: "TEAM123456",
        testFlightInternalTestingOnly: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts a complete API key without reading or printing its contents", () => {
    const authentication = resolveAuthentication({}, {
      APP_STORE_CONNECT_API_KEY_PATH: process.execPath,
      APP_STORE_CONNECT_API_KEY_ID: "KEY123",
      APP_STORE_CONNECT_API_ISSUER_ID: "ISSUER123",
    });
    expect(authentication).toEqual({ path: process.execPath, id: "KEY123", issuer: "ISSUER123" });
    expect(authenticationArguments(authentication!)).toEqual([
      "-authenticationKeyPath", process.execPath,
      "-authenticationKeyID", "KEY123",
      "-authenticationKeyIssuerID", "ISSUER123",
    ]);
    expect(() => resolveAuthentication({}, {
      APP_STORE_CONNECT_API_KEY_PATH: process.execPath,
      APP_STORE_CONNECT_API_KEY_ID: "KEY123",
    })).toThrow("需要同时提供");
  });
});
