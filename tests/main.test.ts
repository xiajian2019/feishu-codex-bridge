import { describe, expect, it } from "bun:test";

import { parseMainArguments } from "../src/main.js";

describe("main execution mode override", () => {
  it("accepts mode aliases without changing the config file", () => {
    expect(parseMainArguments([
      "--config",
      "./config.json",
      "--db=./runtime/direct.db",
      "--execution-mode",
      "feishu-sqlite-codex",
    ], "/tmp/bridge")).toEqual({
      configPath: "/tmp/bridge/config.json",
      dbPath: "/tmp/bridge/runtime/direct.db",
      once: false,
      executionMode: "feishu-sqlite-codex",
    });
  });

  it("rejects an unknown execution mode", () => {
    expect(() => parseMainArguments(["--mode", "unknown"], "/tmp/bridge"))
      .toThrow(/未知 execution mode/);
  });
});
