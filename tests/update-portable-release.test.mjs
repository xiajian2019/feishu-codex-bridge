import { mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "bun:test";

import {
  buildPortableUpdaterPlist,
  parsePortableUpdateArguments,
  updatePortableRelease,
  updateAssetName,
} from "../scripts/update-portable-release.mjs";

describe("portable package updater", () => {
  it("defaults to the current package root and automatic Direct updates", () => {
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
    expect(updateAssetName("darwin", "arm64", "direct", "0.3.0"))
      .toBe("feishu-codex-bridge-direct-darwin-arm64-v0.3.0.tar.gz");
    expect(updateAssetName("darwin", "x64", "lite")).toBe("feishu-codex-bridge-darwin-x64.tar.gz");
    expect(updateAssetName("darwin", "x64", "auto")).toBe("feishu-codex-bridge-direct-darwin-x64.tar.gz");
  });

  it("writes a user-level periodic updater plist without shell interpolation", () => {
    const plist = buildPortableUpdaterPlist({ root: "/Users/example/Feishu Bridge", intervalSeconds: 1800 });
    expect(plist).toContain("com.local.feishu-codex-bridge-updater");
    expect(plist).toContain("/Users/example/Feishu Bridge/feishu-codex-bridge");
    expect(plist).toContain("<integer>1800</integer>");
    expect(plist).toContain("<string>--auto</string>");
  });

  it("overlays a Core package without replacing direct dependencies or Bun runtime data", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "feishu-codex-update-test-"));
    const root = join(fixture, "installed");
    const packageName = `feishu-codex-bridge-core-darwin-${process.arch}`;
    const source = join(fixture, packageName);
    const archive = join(fixture, "core.tar.gz");
    try {
      await mkdir(join(root, "app", "dist"), { recursive: true });
      await mkdir(join(root, "app", "node_modules", "@larksuite", "cli"), { recursive: true });
      await mkdir(join(root, "runtime", "bin"), { recursive: true });
      await writeFile(join(root, "app", "dist", "main.js"), "old-core");
      await writeFile(join(root, "app", "package.json"), JSON.stringify({
        version: "0.1.0",
        dependencies: { "@larksuite/cli": "1.0.94" },
      }));
      await writeFile(join(root, "app", "node_modules", "@larksuite", "cli", "marker"), "keep-lark-cli");
      await writeFile(join(root, "runtime", "bin", "bun"), "keep-bun");
      await writeFile(join(root, "runtime", ".bundled-bun"), "1.4.2\n");
      await writeFile(join(root, "config.json"), "keep-config");
      await writeFile(join(root, "release-manifest.json"), JSON.stringify({ mode: "direct", version: "0.1.0", runtimeFamily: "bun", runtimeGeneration: "bun-1.4.2", runtimeVersion: "1.4.2" }));

      await mkdir(join(source, "app", "dist"), { recursive: true });
      await mkdir(join(source, "app", "scripts"), { recursive: true });
      await writeFile(join(source, "app", "dist", "main.js"), "new-core");
      await writeFile(join(source, "app", "feishu-codex-bridge"), "new-core-binary");
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
        runtimeFamily: "bun",
        runtimeGeneration: "bun-1.4.2",
        runtimeVersion: "1.4.2",
        compatibleRuntimeGenerations: ["bun-1.4.2", "bun-1.4.2-single-binary"],
        generatedAt: "2026-09-20T00:00:00.000Z",
      }));
      await run("tar", ["-czf", archive, "-C", fixture, packageName]);

      const result = await updatePortableRelease({ root, file: archive, restart: false });
      expect(result.mode).toBe("core-overlay");
      expect(await readFile(join(root, "app", "dist", "main.js"), "utf8")).toBe("new-core");
      expect(await readFile(join(root, "app", "feishu-codex-bridge"), "utf8")).toBe("new-core-binary");
      expect(await readFile(join(root, "app", "package.json"), "utf8")).toContain("@larksuite/cli");
      expect(await readFile(join(root, "app", "node_modules", "@larksuite", "cli", "marker"), "utf8")).toBe("keep-lark-cli");
      expect(await readFile(join(root, "runtime", "bin", "bun"), "utf8")).toBe("keep-bun");
      expect(await readFile(join(root, "config.json"), "utf8")).toBe("keep-config");
      expect(JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"))).toMatchObject({
        mode: "direct",
        version: "0.2.0",
        runtimeFamily: "bun",
        runtimeGeneration: "bun-1.4.2",
        runtimeVersion: "1.4.2",
        coreVersion: "0.2.0",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("rejects Core overlays until a legacy install gets its full Bun migration", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "feishu-codex-update-legacy-test-"));
    const root = join(fixture, "installed");
    const archive = join(fixture, "core.tar.gz");
    try {
      await mkdir(join(root, "app"), { recursive: true });
      await writeFile(join(root, "app", "package.json"), JSON.stringify({ dependencies: { "@larksuite/cli": "1.0.94" } }));
      await writeFile(join(root, "release-manifest.json"), JSON.stringify({ mode: "direct", version: "0.1.0" }));
      await expect(updatePortableRelease({ root, file: archive, mode: "core", restart: false }))
        .rejects.toThrow(/尚未迁移到 Bun/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("deploys a versioned Direct release through current and retains the previous release", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "feishu-codex-update-versioned-test-"));
    const root = join(fixture, "installed");
    const releases = join(root, "releases");
    const previousName = "0.1.0-old-build";
    const previousRelease = join(releases, previousName);
    const packageName = "feishu-codex-bridge-direct-darwin-" + process.arch;
    const source = join(fixture, packageName);
    const archive = join(fixture, "direct.tar.gz");
    try {
      await mkdir(join(previousRelease, "app"), { recursive: true });
      await mkdir(join(root, "runtime"), { recursive: true });
      await writeFile(join(previousRelease, "app", "feishu-codex-bridge"), "old-binary");
      await writeFile(join(previousRelease, "app", "package.json"), JSON.stringify({ dependencies: { "@larksuite/cli": "1.0.94" } }));
      await writeFile(join(previousRelease, "release-manifest.json"), JSON.stringify({
        mode: "direct",
        version: "0.1.0",
        runtimeFamily: "bun",
        runtimeGeneration: "bun-1.4.2-single-binary",
        runtimePackaging: "single-binary",
      }));
      await symlink("releases/" + previousName, join(root, "current"), "dir");
      await writeFile(join(root, "config.json"), "keep-config");
      await writeFile(join(root, "runtime", "bridge.db"), "keep-database");

      await mkdir(join(source, "app"), { recursive: true });
      await writeFile(join(source, "app", "feishu-codex-bridge"), "new-binary");
      await writeFile(join(source, "app", "package.json"), JSON.stringify({ dependencies: { "@larksuite/cli": "1.0.94" } }));
      await writeFile(join(source, "feishu-codex-bridge"), "#!/bin/sh\n");
      await writeFile(join(source, "release-manifest.json"), JSON.stringify({
        mode: "direct",
        version: "0.2.0",
        runtimeFamily: "bun",
        runtimeGeneration: "bun-1.4.2-single-binary",
        runtimePackaging: "single-binary",
        runtimeVersion: "1.4.2",
      }));
      await run("tar", ["-czf", archive, "-C", fixture, packageName]);

      const result = await updatePortableRelease({ root, file: archive, restart: false });
      const currentTarget = await readlink(join(root, "current"));
      const activeRelease = join(root, currentTarget);
      expect(result.mode).toBe("direct");
      expect(currentTarget).toMatch(new RegExp("^releases/0[.]2[.]0-"));
      expect(await readFile(join(activeRelease, "app", "feishu-codex-bridge"), "utf8")).toBe("new-binary");
      expect(await readFile(join(previousRelease, "app", "feishu-codex-bridge"), "utf8")).toBe("old-binary");
      expect(await readFile(join(root, "config.json"), "utf8")).toBe("keep-config");
      expect(await readFile(join(root, "runtime", "bridge.db"), "utf8")).toBe("keep-database");
      expect(await readdir(releases)).toHaveLength(2);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("migrates a Node Direct install to the single-binary package and preserves user data", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "feishu-codex-update-direct-test-"));
    const root = join(fixture, "installed");
    const packageName = `feishu-codex-bridge-direct-darwin-${process.arch}`;
    const source = join(fixture, packageName);
    const archive = join(fixture, "direct.tar.gz");
    try {
      await mkdir(join(root, "app", "dist"), { recursive: true });
      await mkdir(join(root, "app", "runtime", "logs"), { recursive: true });
      await mkdir(join(root, "runtime", "bin"), { recursive: true });
      await writeFile(join(root, "app", "dist", "main.js"), "old-node-app");
      await writeFile(join(root, "app", "package.json"), JSON.stringify({ version: "0.1.0", dependencies: { "@larksuite/cli": "1.0.94" } }));
      await writeFile(join(root, "app", "runtime", "logs", "bridge.log"), "keep-app-log");
      await writeFile(join(root, "config.json"), "keep-config");
      await writeFile(join(root, "runtime", "bridge.db"), "keep-database");
      await writeFile(join(root, "release-manifest.json"), JSON.stringify({ mode: "direct", runtimeFamily: "node", runtimeGeneration: "node-22" }));
      await writeFile(join(root, "runtime", "bin", "node"), "old-bundled-node");
      await writeFile(join(root, "runtime", ".bundled-node"), "22.13.1\n");
      await writeFile(join(root, "runtime", "node-universal.tar.gz"), "old-node-archive");

      await mkdir(join(source, "app", "node_modules", "@larksuite", "cli"), { recursive: true });
      await mkdir(join(source, "runtime"), { recursive: true });
      await writeFile(join(source, "app", "feishu-codex-bridge"), "new-direct-binary");
      await writeFile(join(source, "app", "package.json"), JSON.stringify({
        version: "0.2.0",
        dependencies: { "@larksuite/cli": "1.0.94" },
      }));
      await writeFile(join(source, "app", "node_modules", "@larksuite", "cli", "marker"), "new-lark-cli");
      await writeFile(join(source, "feishu-codex-bridge"), "#!/bin/sh\n");
      await writeFile(join(source, "install.command"), "#!/bin/sh\n");
      await writeFile(join(source, "README.md"), "direct README\n");
      await writeFile(join(source, "release-manifest.json"), JSON.stringify({
        mode: "direct",
        version: "0.2.0",
        runtimeFamily: "bun",
        runtimeGeneration: "bun-1.4.2-single-binary",
        runtimePackaging: "single-binary",
        runtimeVersion: "1.4.2",
      }));
      await run("tar", ["-czf", archive, "-C", fixture, packageName]);

      const result = await updatePortableRelease({ root, file: archive, restart: false });
      expect(result.mode).toBe("direct");
      expect(await readFile(join(root, "app", "feishu-codex-bridge"), "utf8")).toBe("new-direct-binary");
      await expect(readFile(join(root, "app", "dist", "main.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "app", "runtime", "logs", "bridge.log"), "utf8")).toBe("keep-app-log");
      expect(await readFile(join(root, "config.json"), "utf8")).toBe("keep-config");
      expect(await readFile(join(root, "runtime", "bridge.db"), "utf8")).toBe("keep-database");
      expect(JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"))).toMatchObject({ runtimeGeneration: "bun-1.4.2-single-binary", runtimePackaging: "single-binary" });
      expect(await readFile(join(root, "app", "node_modules", "@larksuite", "cli", "marker"), "utf8")).toBe("new-lark-cli");
      await expect(readFile(join(root, "runtime", "bin", "bun"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, "runtime", ".bundled-bun"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, "runtime", "bin", "node"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, "runtime", ".bundled-node"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, "runtime", "node-universal.tar.gz"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
