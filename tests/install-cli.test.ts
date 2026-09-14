import { describe, expect, it } from "vitest";

import { parseInstallCliArguments, buildDirectConfig } from "../src/install-cli.js";
import { parseConfig } from "../src/config.js";

describe("single-command installer", () => {
  it("parses an install command and its initialization overrides", () => {
    expect(parseInstallCliArguments([
      "--config",
      "./settings.json",
      "--db=./runtime/state.db",
      "--repo",
      "./repo",
      "--codex",
      "/opt/homebrew/bin/codex",
      "--no-start",
      "--no-service",
    ], "/tmp/bridge")).toEqual({
      command: "install",
      configPath: "/tmp/bridge/settings.json",
      dbPath: "/tmp/bridge/runtime/state.db",
      executionMode: "feishu-sqlite-codex",
      codexPath: "/opt/homebrew/bin/codex",
      repoPath: "/tmp/bridge/repo",
      appId: undefined,
      appSecret: undefined,
      proxyUrl: undefined,
      force: false,
      noStart: true,
      noService: true,
      nonInteractive: false,
      help: false,
    });
  });

  it("creates a valid direct-mode config without requiring a proxy", () => {
    const config = parseConfig(buildDirectConfig({
      repoPath: "/tmp/repository",
      codexPath: "/opt/homebrew/bin/codex",
    }), { checkRepositories: false });
    expect(config.execution.mode).toBe("feishu-sqlite-codex");
    expect(config.direct.projectKey).toBe("default");
    expect(config.codex.env).toEqual({});
    expect(config.projects.default.repo).toBe("/tmp/repository");
  });
});
