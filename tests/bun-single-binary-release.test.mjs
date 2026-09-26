import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  parseBunSingleBinaryReleaseArguments,
  targetName,
} from "../scripts/build-bun-single-binary-release.mjs";

describe("Bun single-binary release", () => {
  it("defaults to the direct single-binary package", async () => {
    const parsed = parseBunSingleBinaryReleaseArguments([], "/workspace/bridge");
    expect(parsed.mode).toBe("direct");
    expect(parsed.outputDir).toMatch(/\/release$/);
    expect(parsed.bundleBun).toBeUndefined();
    expect(targetName("darwin", "arm64", parsed.mode)).toBe(
      `feishu-codex-bridge-direct-darwin-arm64-v${JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version}`,
    );
  });

  it("rejects legacy release modes", () => {
    expect(() => parseBunSingleBinaryReleaseArguments(["--mode", "lite"]))
      .toThrow("release:legacy");
    expect(() => parseBunSingleBinaryReleaseArguments(["--bundle-bun"]))
      .toThrow("release:legacy");
  });
});
