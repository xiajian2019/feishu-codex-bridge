import { describe, expect, it } from "vitest";

import {
  parsePortableRestartArguments,
  restartPortableRelease,
} from "../scripts/restart-portable-release.mjs";

describe("portable release restart", () => {
  it("parses config, output and skip-build options", () => {
    const parsed = parsePortableRestartArguments([
      "--",
      "--config",
      "configs/direct.json",
      "--output=release-next",
      "--skip-build",
    ], "/workspace/bridge");
    expect(parsed).toEqual({
      configPath: "/workspace/bridge/configs/direct.json",
      releaseDir: "/workspace/bridge/release-next",
      skipBuild: true,
    });
  });

  it("builds before stopping and starts/status-checks the new launcher", async () => {
    const calls = [];
    const result = await restartPortableRelease({
      projectRoot: "/workspace/bridge",
      releaseDir: "/workspace/bridge/release",
      configPath: "/workspace/bridge/config.json",
      buildRelease: async (options) => {
        calls.push(["build", options.outputDir]);
      },
      runCommand: async (file, args) => {
        calls.push(["run", file, ...args]);
      },
      verifyLauncher: false,
    });
    expect(result.launcher).toMatch(/\/release\/feishu-codex-bridge-darwin-(arm64|x64)\/feishu-codex-bridge$/);
    expect(calls[0]).toEqual(["build", "/workspace/bridge/release"]);
    expect(calls.slice(1).map((call) => call[1])).toEqual([
      result.launcher,
      result.launcher,
      result.launcher,
    ]);
    expect(calls.slice(1).map((call) => call[2])).toEqual(["codex:stop", "codex:start", "codex:status"]);
  });
});
