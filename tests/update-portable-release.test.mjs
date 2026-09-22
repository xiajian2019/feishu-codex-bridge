import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  buildPortableUpdaterPlist,
  parsePortableUpdateArguments,
  updatePortableRelease,
  updateAssetName,
} from "../scripts/update-portable-release.mjs";

describe("portable package updater", () => {
  it("defaults to the current package root and automatic core updates", () => {
    expect(parsePortableUpdateArguments([], "/tmp/bridge")).toMatchObject({
      root: "/tmp/bridge",
      repository: "xiajian2019/feishu-codex-bridge",
      tag: "latest",
      mode: "auto",
      restart: true,
      file: undefined,
    });
  });

  it("accepts a local package and explicit mode", () => {
    expect(parsePortableUpdateArguments([
      "--file",
      "./update.tar.gz",
      "--mode",
      "auto",
      "--tag=v1.2.3",
      "--check",
      "--no-restart",
    ], "/tmp/bridge")).toMatchObject({
      file: "/tmp/bridge/update.tar.gz",
      mode: "auto",
      tag: "v1.2.3",
      check: true,
      restart: false,
    });
  });

  it("maps core, direct and Lite assets by architecture", () => {
    expect(updateAssetName("darwin", "arm64", "core")).toBe("feishu-codex-bridge-core-darwin-arm64.tar.gz");
    expect(updateAssetName("darwin", "arm64", "direct")).toBe("feishu-codex-bridge-direct-darwin-arm64.tar.gz");
    expect(updateAssetName("darwin", "x64", "lite")).toBe("feishu-codex-bridge-darwin-x64.tar.gz");
    expect(updateAssetName("darwin", "x64", "auto")).toBe("feishu-codex-bridge-core-darwin-x64.tar.gz");
  });

  it("writes a user-level periodic updater plist without shell interpolation", () => {
    const plist = buildPortableUpdaterPlist({ root: "/Users/example/Feishu Bridge", intervalSeconds: 1800 });
    expect(plist).toContain("com.local.feishu-codex-bridge-updater");
    expect(plist).toContain("/Users/example/Feishu Bridge/feishu-codex-bridge");
    expect(plist).toContain("<integer>1800</integer>");
    expect(plist).toContain("<string>--auto</string>");
  });

  it("overlays a Core package without replacing direct dependencies or runtime data", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "feishu-codex-update-test-"));
    const root = join(fixture, "installed");
    const packageName = `feishu-codex-bridge-core-darwin-${process.arch}`;
    const source = join(fixture, packageName);
    const archive = join(fixture, "core.tar.gz");
    try {
      await mkdir(join(root, "app", "dist"), { recursive: true });
      await mkdir(join(root, "app", "node_modules", "@larksuite", "cli"), { recursive: true });
      await mkdir(join(root, "runtime", "node-universal"), { recursive: true });
      await writeFile(join(root, "app", "dist", "main.js"), "old-core");
      await writeFile(join(root, "app", "package.json"), JSON.stringify({
        version: "0.1.0",
        dependencies: { "@larksuite/cli": "1.0.94" },
      }));
      await writeFile(join(root, "app", "node_modules", "@larksuite", "cli", "marker"), "keep-lark-cli");
      await writeFile(join(root, "runtime", "node-universal.tar.gz"), "keep-node");
      await writeFile(join(root, "runtime", "node-universal", "marker"), "keep-extracted-node");
      await writeFile(join(root, "config.json"), "keep-config");
      await writeFile(join(root, "release-manifest.json"), JSON.stringify({ mode: "direct", version: "0.1.0" }));

      await mkdir(join(source, "app", "dist"), { recursive: true });
      await mkdir(join(source, "app", "scripts"), { recursive: true });
      await writeFile(join(source, "app", "dist", "main.js"), "new-core");
      await writeFile(join(source, "app", "scripts", "update-portable-release.mjs"), "// updater");
      await writeFile(join(source, "app", "config.example.json"), "{}\n");
      await writeFile(join(source, "feishu-codex-bridge"), "#!/bin/sh\n");
      await writeFile(join(source, "install.command"), "#!/bin/sh\n");
      await writeFile(join(source, "install.defaults"), "INSTALL_DIR=default\n");
      await writeFile(join(source, "README.md"), "new README\n");
      await writeFile(join(source, "release-manifest.json"), JSON.stringify({
        mode: "core",
        version: "0.2.0",
        packageName,
        generatedAt: "2026-09-20T00:00:00.000Z",
      }));
      await run("tar", ["-czf", archive, "-C", fixture, packageName]);

      const result = await updatePortableRelease({ root, file: archive, restart: false });
      expect(result.mode).toBe("core-overlay");
      expect(await readFile(join(root, "app", "dist", "main.js"), "utf8")).toBe("new-core");
      expect(await readFile(join(root, "app", "package.json"), "utf8")).toContain("@larksuite/cli");
      expect(await readFile(join(root, "app", "node_modules", "@larksuite", "cli", "marker"), "utf8")).toBe("keep-lark-cli");
      expect(await readFile(join(root, "runtime", "node-universal.tar.gz"), "utf8")).toBe("keep-node");
      expect(await readFile(join(root, "config.json"), "utf8")).toBe("keep-config");
      expect(JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"))).toMatchObject({
        mode: "direct",
        version: "0.2.0",
        coreVersion: "0.2.0",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("auto-detects a local direct package and replaces its bundled runtime", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "feishu-codex-update-direct-test-"));
    const root = join(fixture, "installed");
    const packageName = `feishu-codex-bridge-direct-darwin-${process.arch}`;
    const source = join(fixture, packageName);
    const archive = join(fixture, "direct.tar.gz");
    try {
      await mkdir(join(root, "app", "dist"), { recursive: true });
      await mkdir(join(root, "runtime", "bin"), { recursive: true });
      await writeFile(join(root, "app", "dist", "main.js"), "old-lite");
      await writeFile(join(root, "app", "package.json"), JSON.stringify({ version: "0.1.0", dependencies: {} }));
      await writeFile(join(root, "runtime", "bin", "node"), "old-bundled-node");

      await mkdir(join(source, "app", "dist"), { recursive: true });
      await mkdir(join(source, "app", "node_modules", "@larksuite", "cli"), { recursive: true });
      await mkdir(join(source, "runtime"), { recursive: true });
      await writeFile(join(source, "app", "dist", "main.js"), "new-direct");
      await writeFile(join(source, "app", "package.json"), JSON.stringify({
        version: "0.2.0",
        dependencies: { "@larksuite/cli": "1.0.94" },
      }));
      await writeFile(join(source, "app", "node_modules", "@larksuite", "cli", "marker"), "new-lark-cli");
      await writeFile(join(source, "feishu-codex-bridge"), "#!/bin/sh\n");
      await writeFile(join(source, "install.command"), "#!/bin/sh\n");
      await writeFile(join(source, "README.md"), "direct README\n");
      await writeFile(join(source, "runtime", "node-universal.tar.gz"), "new-universal-node");
      await writeFile(join(source, "release-manifest.json"), JSON.stringify({ mode: "direct", version: "0.2.0" }));
      await run("tar", ["-czf", archive, "-C", fixture, packageName]);

      const result = await updatePortableRelease({ root, file: archive, restart: false });
      expect(result.mode).toBe("direct");
      expect(await readFile(join(root, "app", "dist", "main.js"), "utf8")).toBe("new-direct");
      expect(await readFile(join(root, "app", "node_modules", "@larksuite", "cli", "marker"), "utf8")).toBe("new-lark-cli");
      expect(await readFile(join(root, "runtime", "node-universal.tar.gz"), "utf8")).toBe("new-universal-node");
      await expect(readFile(join(root, "runtime", "bin", "node"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

function run(file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, { stdio: "ignore", shell: false });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${file} exited with ${code}`));
    });
  });
}
