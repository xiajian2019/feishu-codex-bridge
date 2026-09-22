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
    expect(parsed.mode).toBe("direct");
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

  it("supports the direct self-contained release mode", () => {
    const parsed = parsePortableReleaseArguments(["--mode", "direct"], "/workspace/bridge");
    expect(parsed.mode).toBe("direct");
    expect(parsed.bundleNode).toBe(false);
    expect(targetName("darwin", "arm64", "direct")).toBe("feishu-codex-bridge-direct-darwin-arm64");
  });

  it("supports the dependency-free core update mode", () => {
    const parsed = parsePortableReleaseArguments(["--mode", "core"], "/workspace/bridge");
    expect(parsed.mode).toBe("core");
    expect(targetName("darwin", "arm64", "core")).toBe("feishu-codex-bridge-core-darwin-arm64");
  });

  it("names supported platform archives", () => {
    expect(targetName("darwin", "arm64")).toBe("feishu-codex-bridge-direct-darwin-arm64");
    expect(targetName("darwin", "x64", "lite")).toBe("feishu-codex-bridge-darwin-x64");
    expect(() => targetName("linux", "x64")).toThrow("只支持");
  });

  it("ships a launcher that does not invoke pnpm", async () => {
    const source = await readFile(new URL("../scripts/portable-launcher.sh", import.meta.url), "utf8");
    expect(source).toContain('RUNTIME_DIR="$SELF_DIR/runtime"');
    expect(source).toContain('bundled_node="$RUNTIME_DIR/bin/node"');
    expect(source).toContain("download_node_runtime");
    expect(source).toContain("node-universal.tar.gz");
    expect(source).toContain("run_entry");
    expect(source).not.toContain("pnpm run");
  });

  it("prefers the local Node universal archive when building direct releases", async () => {
    const source = await readFile(new URL("../scripts/build-portable-release.mjs", import.meta.url), "utf8");
    expect(source).toContain('join(PROJECT_ROOT, "runtime", "node", "node-universal.tar.gz")');
    expect(source).toContain("validateUniversalNodeArchive");
  });

  it("ships a double-click installer", async () => {
    const source = await readFile(new URL("../install.command", import.meta.url), "utf8");
    expect(source).toContain('"$SELF_DIR/feishu-codex-bridge" install');
    expect(source).toContain("INSTALL_DIR");
    expect(source).toContain("ditto");
    expect(source).toContain("按回车关闭窗口");
  });

  it("ships editable installation defaults", async () => {
    const source = await readFile(new URL("../install.defaults", import.meta.url), "utf8");
    expect(source).toContain("Applications/Feishu Codex Bridge");
  });
});
