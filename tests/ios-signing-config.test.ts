import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readIosDevelopmentTeam } from "../scripts/ios-signing-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("iOS signing configuration", () => {
  test("uses the local xcconfig and lets the process environment override it", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-signing-test-"));
    const config = join(directory, ".xcconfig");
    try {
      writeFileSync(config, [
        "// BRIDGE_IOS_DEVELOPMENT_TEAM = IGNORED000",
        "BRIDGE_IOS_DEVELOPMENT_TEAM = AAAAAAAAAA",
        "BRIDGE_IOS_DEVELOPMENT_TEAM = BBBBBBBBBB // local team",
      ].join("\n"));
      expect(readIosDevelopmentTeam({}, config)).toBe("BBBBBBBBBB");
      expect(readIosDevelopmentTeam({ BRIDGE_IOS_DEVELOPMENT_TEAM: " CCCCCCCCCC " }, config)).toBe("CCCCCCCCCC");
      expect(() => readIosDevelopmentTeam({ BRIDGE_IOS_DEVELOPMENT_TEAM: "invalid" }, config)).toThrow("BRIDGE_IOS_DEVELOPMENT_TEAM");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("handles missing and invalid local values without exposing their contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-signing-test-"));
    const config = join(directory, ".xcconfig");
    try {
      expect(readIosDevelopmentTeam({}, config)).toBeNull();
      writeFileSync(config, "OTHER_SETTING = value\n");
      expect(readIosDevelopmentTeam({}, config)).toBeNull();
      writeFileSync(config, "BRIDGE_IOS_DEVELOPMENT_TEAM = invalid-private-value\n");
      expect(() => readIosDevelopmentTeam({}, config)).toThrow("BRIDGE_IOS_DEVELOPMENT_TEAM");
      try { readIosDevelopmentTeam({}, config); } catch (error) {
        expect(String(error)).not.toContain("invalid-private-value");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps Xcode team overrides and the local config out of version control", () => {
    const project = readFileSync(join(root, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
    expect(project).not.toMatch(/\b(?:DEVELOPMENT_TEAM|DevelopmentTeam)\s*=/);
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "ios/.xcconfig"], { cwd: root });
    expect(ignored.status).toBe(0);
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "ios/.xcconfig"], { cwd: root });
    expect(tracked.status).not.toBe(0);
  });
});
