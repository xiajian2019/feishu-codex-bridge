import { describe, expect, it } from "bun:test";

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
      "--db",
      "runtime/direct.db",
      "--mode",
      "feishu-sqlite-codex",
      "--output=release-next",
      "--skip-build",
    ], "/workspace/bridge");
    expect(parsed).toEqual({
      configPath: "/workspace/bridge/configs/direct.json",
      dbPath: "/workspace/bridge/runtime/direct.db",
      releaseDir: "/workspace/bridge/release-next",
      executionMode: "feishu-sqlite-codex",
      skipBuild: true,
    });
  });

  it("builds before stopping and starts/status-checks the new launcher", async () => {
    const calls = [];
    const result = await restartPortableRelease({
      projectRoot: "/workspace/bridge",
      releaseDir: "/workspace/bridge/release",
      configPath: "/workspace/bridge/config.json",
      dbPath: "/workspace/bridge/runtime/bridge.db",
      executionMode: "feishu-sqlite-codex",
      buildRelease: async (options) => {
        calls.push(["build", options.outputDir]);
      },
      runCommand: async (file, args) => {
        calls.push(["run", file, ...args]);
      },
      verifyLauncher: false,
    });
    expect(result.launcher).toMatch(/\/release\/feishu-codex-bridge-direct-darwin-(arm64|x64)-v\d+\.\d+\.\d+\/feishu-codex-bridge$/);
    expect(calls[0]).toEqual(["build", "/workspace/bridge/release"]);
    expect(calls.slice(1).map((call) => call[1])).toEqual([
      result.launcher,
      result.launcher,
    ]);
    expect(calls.slice(1).map((call) => call[2])).toEqual(["service", "service"]);
    expect(calls[1].slice(3)).toEqual([
      "restart",
      "--config",
      "/workspace/bridge/config.json",
      "--db",
      "/workspace/bridge/runtime/bridge.db",
      "--mode",
      "feishu-sqlite-codex",
    ]);
    expect(calls[2].slice(3)).toEqual([
      "status",
      "--config",
      "/workspace/bridge/config.json",
      "--db",
      "/workspace/bridge/runtime/bridge.db",
      "--mode",
      "feishu-sqlite-codex",
    ]);
  });
});
