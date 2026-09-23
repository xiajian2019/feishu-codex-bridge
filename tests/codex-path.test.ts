import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { resolveCodexCliPath } from "../src/codex-path.js";

async function createExecutable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

describe("Codex CLI path discovery", () => {
  it("prefers an explicit CODEX_PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-path-env-"));
    const configured = join(directory, "configured-codex");
    const pathCodex = join(directory, "bin", "codex");
    await createExecutable(configured);
    await createExecutable(pathCodex);

    expect(resolveCodexCliPath({
      platform: "darwin",
      homeDirectory: directory,
      environment: { CODEX_PATH: configured, PATH: join(directory, "bin") },
      appBundlePaths: [],
    })).toEqual({ path: configured, source: "environment" });
  });

  it("finds the Codex binary bundled in ChatGPT App", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-path-app-"));
    const appBundle = join(directory, "ChatGPT.app");
    const bundled = join(appBundle, "Contents", "Resources", "codex");
    await createExecutable(bundled);

    expect(resolveCodexCliPath({
      platform: "darwin",
      homeDirectory: directory,
      environment: { PATH: "" },
      includeKnownStandalonePaths: false,
      appBundlePaths: [appBundle],
    })).toEqual({ path: bundled, source: "chatgpt-app" });
  });

  it("accepts the official user install directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-path-user-"));
    const installed = join(directory, ".local", "bin", "codex");
    await createExecutable(installed);

    expect(resolveCodexCliPath({
      platform: "darwin",
      homeDirectory: directory,
      environment: { PATH: "" },
      appBundlePaths: [],
    })).toEqual({ path: installed, source: "user-install" });
  });
});
