import { describe, expect, it } from "bun:test";

import { resolveBunPackageManagerInvocation } from "../scripts/aamp-bun-package-manager.mjs";

const environment = {
  NPM_CONFIG_PREFIX: "/tmp/bridge/runtime/aamp/bun-global",
  NPM_CONFIG_CACHE: "/tmp/bridge/runtime/aamp/npm-cache",
  NPM_CONFIG_REGISTRY: "https://registry.example.test/",
};

describe("AAMP Bun package-manager compatibility", () => {
  it("routes global npm installs into the project-owned Bun global directories", () => {
    const invocation = resolveBunPackageManagerInvocation("npm", [
      "install",
      "-g",
      "--registry",
      environment.NPM_CONFIG_REGISTRY,
      "--cache",
      environment.NPM_CONFIG_CACHE,
      "--prefix",
      environment.NPM_CONFIG_PREFIX,
      "--force",
      "@larktask/aamp-feishu-task-agent@dev",
    ], environment);

    expect(invocation.args).toEqual([
      "add",
      "-g",
      `--registry=${environment.NPM_CONFIG_REGISTRY}`,
      `--cache-dir=${environment.NPM_CONFIG_CACHE}`,
      "--force",
      "@larktask/aamp-feishu-task-agent@dev",
    ]);
    expect(invocation.env.BUN_INSTALL_GLOBAL_DIR).toBe(`${environment.NPM_CONFIG_PREFIX}/lib/node_modules`);
    expect(invocation.env.BUN_INSTALL_BIN).toBe(`${environment.NPM_CONFIG_PREFIX}/bin`);
    expect(invocation.env.BUN_INSTALL_CACHE_DIR).toBe(environment.NPM_CONFIG_CACHE);
  });

  it("keeps npm installs with --prefix local to that project", () => {
    const invocation = resolveBunPackageManagerInvocation("npm", [
      "install",
      "--prefix",
      "/tmp/aamp-register-helper",
      "--registry",
      environment.NPM_CONFIG_REGISTRY,
      "--cache",
      environment.NPM_CONFIG_CACHE,
      "@larktask/registration-sdk",
    ], environment);

    expect(invocation.args).toEqual([
      "add",
      "--cwd",
      "/tmp/aamp-register-helper",
      "--registry=https://registry.example.test/",
      "--cache-dir=/tmp/bridge/runtime/aamp/npm-cache",
      "@larktask/registration-sdk",
    ]);
    expect(invocation.args).not.toContain("--global");
    expect(invocation.env.BUN_INSTALL_GLOBAL_DIR).toBe("/tmp/bridge/runtime/aamp/bun-global/lib/node_modules");
  });

  it("maps npm exec package resolution to bun x without requiring Node", () => {
    const invocation = resolveBunPackageManagerInvocation("npm", [
      "exec",
      "--yes",
      "--registry",
      environment.NPM_CONFIG_REGISTRY,
      "--cache",
      environment.NPM_CONFIG_CACHE,
      "--package",
      "@larktask/aamp-acp-bridge@dev",
      "--",
      "aamp-acp-bridge",
      "--help",
    ], environment);

    expect(invocation.file).toBe(process.execPath);
    expect(invocation.args).toEqual([
      "x",
      "--package",
      "@larktask/aamp-acp-bridge@dev",
      "--",
      "aamp-acp-bridge",
      "--help",
    ]);
    expect(invocation.env.BUN_CONFIG_REGISTRY).toBe(environment.NPM_CONFIG_REGISTRY);
    expect(invocation.env.BUN_INSTALL_CACHE_DIR).toBe(environment.NPM_CONFIG_CACHE);
  });

  it("maps npx invocations while preserving executable arguments", () => {
    const invocation = resolveBunPackageManagerInvocation("npx", [
      "-y",
      "--package",
      "@larktask/aamp-feishu-task-agent@dev",
      "feishu-task-agent",
      "install",
    ], environment);
    expect(invocation.args).toEqual([
      "x",
      "--package",
      "@larktask/aamp-feishu-task-agent@dev",
      "feishu-task-agent",
      "install",
    ]);
  });

  it("reports the npm-compatible global package paths", () => {
    expect(resolveBunPackageManagerInvocation("npm", ["root", "-g"], environment).stdout)
      .toBe(`${environment.NPM_CONFIG_PREFIX}/lib/node_modules\n`);
    expect(resolveBunPackageManagerInvocation("npm", ["prefix", "-g"], environment).stdout)
      .toBe(`${environment.NPM_CONFIG_PREFIX}\n`);
  });
});
