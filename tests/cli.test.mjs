import { describe, expect, it } from "vitest";

import {
  buildCommand,
  buildPnpmArguments,
  resolveInvocation,
} from "../bin/feishu-codex-bridge.mjs";

const scripts = ["aamp:status", "aamp:task", "test"];

describe("global bridge CLI", () => {
  it("maps install to the single-command installer", () => {
    const invocation = resolveInvocation(["install", "--config", "./custom.json"], ["bridge:install", ...scripts]);
    expect(invocation).toEqual({
      kind: "run",
      script: "bridge:install",
      args: ["--", "--config", "./custom.json"],
    });
    const command = buildCommand(invocation, "pnpm", "/bin/sh");
    expect(command.file).toBe(process.execPath);
    expect(command.args).toEqual(["/bin/sh", "--", "--config", "./custom.json"]);
  });

  it("resolves direct script calls and preserves pnpm separators", () => {
    const invocation = resolveInvocation(["aamp:task", "--", "ff96da58"], scripts);

    expect(invocation).toEqual({
      kind: "run",
      script: "aamp:task",
      args: ["--", "ff96da58"],
    });
    expect(buildPnpmArguments(invocation)).toEqual([
      "run",
      "aamp:task",
      "--",
      "ff96da58",
    ]);
  });

  it("supports the explicit run form and adds pnpm's argument separator", () => {
    const invocation = resolveInvocation(["run", "test", "--coverage"], scripts);

    expect(buildPnpmArguments(invocation)).toEqual([
      "run",
      "test",
      "--",
      "--coverage",
    ]);
  });

  it("rejects unknown scripts instead of running from the caller directory", () => {
    expect(resolveInvocation(["missing"], scripts)).toMatchObject({
      kind: "error",
      script: "missing",
    });
  });
});
