import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  parsePortableReleaseArguments,
  targetName,
} from "../scripts/build-portable-release.mjs";

describe("portable release", () => {
  it("uses the repository release directory by default", () => {
    const parsed = parsePortableReleaseArguments([], "/workspace/bridge");
    expect(parsed.outputDir).toMatch(/\/release$/);
    expect(parsed.outputDir).not.toContain("tmp/portable-release");
  });

  it("parses pnpm's separator and release options", () => {
    const parsed = parsePortableReleaseArguments([
      "--",
      "--output",
      "tmp/releases",
      "--node=/tmp/node",
      "--skip-build",
      "--keep-source-maps",
      "--json",
    ], "/workspace/bridge");

    expect(parsed.outputDir).toBe("/workspace/bridge/tmp/releases");
    expect(parsed.nodePath).toBe("/tmp/node");
    expect(parsed.skipBuild).toBe(true);
    expect(parsed.keepSourceMaps).toBe(true);
    expect(parsed.json).toBe(true);
  });

  it("names supported platform archives", () => {
    expect(targetName("darwin", "arm64")).toBe("feishu-codex-bridge-darwin-arm64");
    expect(targetName("darwin", "x64")).toBe("feishu-codex-bridge-darwin-x64");
    expect(() => targetName("linux", "x64")).toThrow("只支持");
  });

  it("ships a launcher that does not invoke pnpm", async () => {
    const source = await readFile(new URL("../scripts/portable-launcher.sh", import.meta.url), "utf8");
    expect(source).toContain('RUNTIME_DIR="$SELF_DIR/runtime"');
    expect(source).toContain('bundled_node="$RUNTIME_DIR/bin/node"');
    expect(source).toContain("download_node_runtime");
    expect(source).toContain("run_entry");
    expect(source).not.toContain("pnpm run");
  });
});
