import { readFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";

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
    expect(parsed.bundleBun).toBe(false);
  });

  it("parses Bun runtime and release options", () => {
    const parsed = parsePortableReleaseArguments([
      "--",
      "--output",
      "tmp/releases",
      "--bun=/tmp/bun",
      "--bundle-bun",
      "--skip-build",
      "--keep-source-maps",
      "--json",
    ], "/workspace/bridge");

    expect(parsed.outputDir).toBe("/workspace/bridge/tmp/releases");
    expect(parsed.bunPath).toBe("/tmp/bun");
    expect(parsed.bundleBun).toBe(true);
    expect(parsed.skipBuild).toBe(true);
    expect(parsed.keepSourceMaps).toBe(true);
    expect(parsed.json).toBe(true);
  });

  it("supports the direct self-contained Bun release mode", () => {
    const parsed = parsePortableReleaseArguments(["--mode", "direct"], "/workspace/bridge");
    expect(parsed.mode).toBe("direct");
    expect(parsed.bundleBun).toBe(false);
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

  it("ships a launcher that resolves Bun without invoking Node or pnpm", async () => {
    const source = await readFile(new URL("../scripts/portable-launcher.sh", import.meta.url), "utf8");
    expect(source).toContain('RUNTIME_DIR="$SELF_DIR/runtime"');
    expect(source).toContain('bundled_bun="$RUNTIME_DIR/bin/bun"');
    expect(source).toContain("download_bun_runtime");
    expect(source).toContain("BUN_VERSION_REQUIRED=");
    expect(source).toContain("run_entry");
    expect(source).not.toContain("node_is_supported");
    expect(source).not.toContain("pnpm run");
  });

  it("records Bun runtime identity in releases", async () => {
    const source = await readFile(new URL("../scripts/build-portable-release.mjs", import.meta.url), "utf8");
    expect(source).toContain('runtimeFamily: "bun"');
    expect(source).toContain('runtimeGeneration: mode === "direct"');
    expect(source).toContain('runtimePackaging: mode === "direct" ? "single-binary"');
    expect(source).toContain("compilePortableBinary");
    expect(source).toContain("trimSingleBinaryDirectPackage");
  });

  it("ships a double-click installer", async () => {
    const source = await readFile(new URL("../install.command", import.meta.url), "utf8");
    expect(source).toContain('"$INSTALL_DIR/current/feishu-codex-bridge" install');
    expect(source).toContain("INSTALL_DIR");
    expect(source).toContain('release_dir="$INSTALL_DIR/releases/$release_id"');
    expect(source).toContain('mv -fh "$next_path" "$INSTALL_DIR/current"');
    expect(source).toContain('temporary_path="$destination_path.migrate.$$"');
    expect(source).toContain('launch_agent_backup="$INSTALL_DIR/.launch-agent-backup-$$.plist"');
    expect(source.indexOf('cp -p "$launch_agent_backup" "$launch_agent_plist"'))
      .toBeLessThan(source.indexOf('service start >/dev/null 2>&1 || true'));
    expect(source).toContain('"$@"');
    expect(source).not.toContain("--no-start");
    expect(source).toContain("ditto");
    expect(source).toContain("按回车关闭窗口");
  });

  it("ships editable installation defaults", async () => {
    const source = await readFile(new URL("../install.defaults", import.meta.url), "utf8");
    expect(source).toContain("Applications/Feishu Codex Bridge");
  });
});
