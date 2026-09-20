import { describe, expect, it } from "vitest";

import {
  parsePortableUpdateArguments,
  updateAssetName,
} from "../scripts/update-portable-release.mjs";

describe("portable package updater", () => {
  it("defaults to the current package root and GitHub mode", () => {
    expect(parsePortableUpdateArguments([], "/tmp/bridge")).toMatchObject({
      root: "/tmp/bridge",
      repository: "xiajian2019/feishu-codex-bridge",
      tag: "latest",
      mode: "lite",
      file: undefined,
    });
  });

  it("accepts a local Lite tarball and explicit mode", () => {
    expect(parsePortableUpdateArguments([
      "--file",
      "./update.tar.gz",
      "--mode",
      "lite",
      "--tag=v1.2.3",
    ], "/tmp/bridge")).toMatchObject({
      file: "/tmp/bridge/update.tar.gz",
      mode: "lite",
      tag: "v1.2.3",
    });
  });

  it("maps direct and Lite assets by architecture", () => {
    expect(updateAssetName("darwin", "arm64", "direct")).toBe("feishu-codex-bridge-direct-darwin-arm64.tar.gz");
    expect(updateAssetName("darwin", "x64", "lite")).toBe("feishu-codex-bridge-darwin-x64.tar.gz");
  });
});
