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

  it("accepts isolated web development options and defaults", () => {
    expect(parseMainArguments(["--web-only"], "/tmp/bridge")).toEqual({
      configPath: "/tmp/bridge/config.json",
      dbPath: "/tmp/bridge/runtime/dev/bridge.db",
      once: false,
      executionMode: undefined,
      webOnly: true,
    });
    expect(parseMainArguments(["--web-only", "--web-port=17311", "--db", "./dev.db"], "/tmp/bridge"))
      .toMatchObject({ dbPath: "/tmp/bridge/dev.db", webOnly: true, webPort: 17311 });
  });

  it("rejects an invalid web port", () => {
    expect(() => parseMainArguments(["--web-port", "70000"], "/tmp/bridge"))
      .toThrow(/port from 1 to 65535/);
  });

  it("rejects an unknown execution mode", () => {
    expect(() => parseMainArguments(["--mode", "unknown"], "/tmp/bridge"))
      .toThrow(/未知 execution mode/);
  });
});
