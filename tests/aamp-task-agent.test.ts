import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  buildAampEnvironment,
  buildAampNetworkEnvironment,
  buildAampPersistenceEnvironment,
  buildAampWorktreeEnvironment,
  buildAampXattrShim,
  buildBunNodeShim,
  buildBunPackageManagerShim,
  buildLarkCliShim,
  buildOfficialCommandShim,
  buildServiceBootstrapShim,
  mergeAampCardDedupSeedEntries,
  replaceLaunchdBootstrapPath,
  seedAampCardDedupState,
} from "../src/aamp-task-agent.js";
import { parseConfig } from "../src/config.js";

function testConfig() {
  return parseConfig(
    {
      aamp: { enabled: true, stopOnShutdown: false },
      lark: {
        profile: "aamp-feishu-task-cli_aa1c1a04feb89d24",
        configDir: "/tmp/lark-cli-aamp-one-click-v1",
        tasklistGuid: "list",
        projectFieldGuid: "project-field",
        modeFieldGuid: "mode-field",
      },
      codex: {
        cliPath: "/opt/homebrew/bin/codex",
        env: {
          HTTP_PROXY: "http://127.0.0.1:7897",
          HTTPS_PROXY: "http://127.0.0.1:7897",
        },
      },
      projects: { food: { optionGuid: "project-option", repo: "/tmp/food" } },
      modes: { review: { optionGuid: "mode-option", sandboxMode: "read-only" } },
    },
    { checkRepositories: false },
  );
}

describe("AAMP runtime environment", () => {
  it("keeps the official package as the owner while injecting stable runtime paths", () => {
    const env = buildAampEnvironment(testConfig(), {
      PATH: "/bin",
      HTTP_PROXY: "http://wrong",
      HTTPS_PROXY: "http://wrong",
    }, "/tmp/bridge-aamp-bin", "/tmp/bridge-aamp-bin/feishu-task-agent-bootstrap");

    expect(env.PATH).toBe("/tmp/bridge-aamp-bin:/bin");
    expect(env.AAMP_LARK_CLI_CONFIG_DIR).toBe("/tmp/lark-cli-aamp-one-click-v1");
    expect(env.LARKSUITE_CLI_CONFIG_DIR).toBe("/tmp/lark-cli-aamp-one-click-v1");
    expect(env.AAMP_TASK_BOOTSTRAP_PATH).toBe("/tmp/bridge-aamp-bin/feishu-task-agent-bootstrap");
    expect(env.NPM_CONFIG_CACHE).toBe(join(homedir(), ".aamp", "npm-cache"));
    expect(env.npm_config_cache).toBe(join(homedir(), ".aamp", "npm-cache"));
    expect(env.AAMP_TASK_HTTP_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.AAMP_TASK_HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.AAMP_TASK_SKIP_MACOS_QUARANTINE).toBe("1");
    // Preserve unrelated inherited values; the loader uses the adapter-owned
    // values above after the official package strips proxy variables.
    expect(env.HTTP_PROXY).toBe("http://wrong");
    expect(env.HTTPS_PROXY).toBe("http://wrong");
  });

  it("uses an absolute lark-cli shim for the official profile and Agent prompt", () => {
    const larkShim = buildLarkCliShim({
      target: "/Users/xiajian/.aamp/npm-global/bin/lark-cli",
      configDir: "/tmp/lark-cli-aamp-one-click-v1",
      cardDedupStatePath: "/tmp/bridge/runtime/aamp/lark-card-dedup.json",
      compatScriptPath: "/tmp/bridge/scripts/aamp-lark-cli-compat.mjs",
      bunPath: "/opt/homebrew/bin/bun",
    });
    const serviceShim = buildServiceBootstrapShim({
      target: "/tmp/bridge/runtime/aamp/bin/aamp-task-agent-command",
      taskCommandPath: "/tmp/bridge/runtime/aamp/bin/feishu-task-agent-bootstrap",
      taskAgentName: "@larktask/aamp-feishu-task-agent",
      taskAgentVersion: "0.1.1-dev.7",
      larkCliShimPath: "/tmp/bridge/runtime/aamp/bin/lark-cli",
      configDir: "/tmp/lark-cli-aamp-one-click-v1",
      shimDir: "/tmp/bridge/runtime/aamp/bin",
      environment: {
        ...buildAampNetworkEnvironment(testConfig()),
        AAMP_TASK_SKIP_MACOS_QUARANTINE: "1",
      },
    });

    expect(larkShim).toContain("export LARKSUITE_CLI_CONFIG_DIR='/tmp/lark-cli-aamp-one-click-v1'");
    expect(larkShim).toContain("export AAMP_REAL_LARK_CLI_BIN='/Users/xiajian/.aamp/npm-global/bin/lark-cli'");
    expect(larkShim).toContain("exec '/opt/homebrew/bin/bun' '/tmp/bridge/scripts/aamp-lark-cli-compat.mjs'");
    const commandShim = buildOfficialCommandShim({
      target: "/tmp/bridge/node_modules/@larktask/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh",
      bootstrapPath: "/tmp/bridge/runtime/aamp/bin/feishu-task-agent-bootstrap",
    });
    expect(commandShim).toContain("export AAMP_TASK_COMMAND_PATH='/tmp/bridge/runtime/aamp/bin/feishu-task-agent-bootstrap'");
    expect(commandShim).toContain("exec /bin/bash -s -- \"$@\" < '/tmp/bridge/node_modules/@larktask/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'");
    const bunCommandShim = buildOfficialCommandShim({
      target: "/tmp/bridge/node_modules/@larktask/aamp-feishu-task-agent/bin/aamp-feishu-task-agent.mjs",
      bootstrapPath: "/tmp/bridge/runtime/aamp/bin/feishu-task-agent-cli",
      bunPath: "/opt/homebrew/bin/bun",
    });
    expect(bunCommandShim).toContain("exec '/opt/homebrew/bin/bun' '/tmp/bridge/node_modules/@larktask/aamp-feishu-task-agent/bin/aamp-feishu-task-agent.mjs' \"$@\"");
    expect(bunCommandShim).not.toContain("exec /bin/bash -s");
    expect(serviceShim).toContain("export AAMP_LARK_CLI_BIN='/tmp/bridge/runtime/aamp/bin/lark-cli'");
    expect(serviceShim).toContain("AAMP_TASK_AGENT_VERSION=\"0.1.1-dev.7\"");
    expect(serviceShim).toContain("export AAMP_TASK_COMMAND_PATH='/tmp/bridge/runtime/aamp/bin/feishu-task-agent-bootstrap'");
    expect(serviceShim).toContain("export PATH='/tmp/bridge/runtime/aamp/bin':\"${PATH:-}\"");
    expect(serviceShim).toContain("export AAMP_TASK_HTTP_PROXY='http://127.0.0.1:7897'");
    expect(serviceShim).toContain("export AAMP_TASK_HTTPS_PROXY='http://127.0.0.1:7897'");
    expect(serviceShim).toContain("export AAMP_TASK_SKIP_MACOS_QUARANTINE='1'");
  });

  it("creates Bun-backed node and npm compatibility shims", () => {
    expect(buildBunNodeShim("/opt/homebrew/bin/bun")).toContain("exec '/opt/homebrew/bin/bun' \"$@\"");
    expect(buildBunPackageManagerShim(
      "/opt/homebrew/bin/bun",
      "/tmp/bridge/scripts/aamp-bun-package-manager.mjs",
      "npm",
    )).toContain("exec '/opt/homebrew/bin/bun' '/tmp/bridge/scripts/aamp-bun-package-manager.mjs' npm \"$@\"");
  });

  it("skips macOS quarantine through a scoped xattr shim", () => {
    const shim = buildAampXattrShim();

    expect(shim).toContain("AAMP_TASK_SKIP_MACOS_QUARANTINE");
    expect(shim).toContain("exec '/usr/bin/xattr' \"$@\"");
  });

  it("keeps the Bun package-manager cache and prefix in the runtime environment", () => {
    const serviceShim = buildServiceBootstrapShim({
      target: "/tmp/bridge/runtime/aamp/bin/aamp-task-agent-command",
      larkCliShimPath: "/tmp/bridge/runtime/aamp/bin/lark-cli",
      configDir: "/tmp/lark",
      shimDir: "/tmp/bridge/runtime/aamp/bin",
      environment: {
        NPM_CONFIG_CACHE: "/tmp/aamp-npm-cache",
        NPM_GLOBAL_PREFIX: "/tmp/bridge/runtime/aamp/bun-global",
      },
    });

    expect(serviceShim).toContain("export NPM_CONFIG_CACHE='/tmp/aamp-npm-cache'");
    expect(serviceShim).toContain("export NPM_GLOBAL_PREFIX='/tmp/bridge/runtime/aamp/bun-global'");
  });

  it("passes worktree isolation settings into the launchd-owned ACP bridge", () => {
    const config = testConfig();
    config.aamp.worktree = {
      enabled: true,
      projectMapPath: "/Users/xiajian/.codex/project-map.yaml",
      globalAgentsPath: "/Users/xiajian/.codex/AGENTS.md",
      taskDir: "/Users/xiajian/works/ai_work/codex/tasks",
      worktreeRoot: "/Users/xiajian/.codex/worktrees",
      baseRef: "main",
      branchPrefix: "xiajian/agent",
    };
    const environment = buildAampWorktreeEnvironment(config, "/tmp/bridge/runtime/aamp/worktree-tasks");
    const serviceShim = buildServiceBootstrapShim({
      target: "/tmp/bridge/runtime/aamp/bin/aamp-task-agent-command",
      larkCliShimPath: "/tmp/bridge/runtime/aamp/bin/lark-cli",
      configDir: "/tmp/lark",
      shimDir: "/tmp/bridge/runtime/aamp/bin",
      environment,
    });

    expect(environment.AAMP_CODEX_PROJECT_MAP).toBe("/Users/xiajian/.codex/project-map.yaml");
    expect(serviceShim).toContain("export AAMP_CODEX_WORKTREE_ENABLED='1'");
    expect(serviceShim).toContain("export AAMP_CODEX_WORKTREE_BASE_REF='main'");
  });

  it("passes the shared SQLite and internal Relay settings into the AAMP service", () => {
    const config = testConfig();
    config.relay = {
      enabled: true,
      aampHost: "http://127.0.0.1:8787",
      statusUrl: "http://127.0.0.1:8787/api/tasks",
    };
    const environment = buildAampPersistenceEnvironment(
      config,
      "/tmp/bridge/runtime/bridge.db",
      "/tmp/bridge/runtime/aamp/attachments",
    );
    expect(environment).toEqual({
      AAMP_BRIDGE_SQLITE_PATH: "/tmp/bridge/runtime/bridge.db",
      AAMP_BRIDGE_ATTACHMENTS_DIR: "/tmp/bridge/runtime/aamp/attachments",
      AAMP_TASK_AAMP_HOST: "http://127.0.0.1:8787",
    });
    const shim = buildServiceBootstrapShim({
      target: "/tmp/aamp-service",
      larkCliShimPath: "/tmp/bridge/bin/lark-cli",
      configDir: "/tmp/lark",
      shimDir: "/tmp/bridge/bin",
      environment,
    });
    expect(shim).toContain("export AAMP_BRIDGE_SQLITE_PATH='/tmp/bridge/runtime/bridge.db'");
    expect(shim).toContain("export AAMP_TASK_AAMP_HOST='http://127.0.0.1:8787'");
  });

  it("seeds a previous help card by its original reply message", () => {
    const entries = mergeAampCardDedupSeedEntries({}, {
      tasks: {
        task: {
          bridgeMessageId: "om_original",
          helpCardMessageId: "om_existing_help",
        },
      },
    });

    expect(entries).toEqual({ om_original: { messageId: "om_existing_help" } });
  });

  it("reconciles a stale wildcard mapping with the official latest card", () => {
    const entries = mergeAampCardDedupSeedEntries(
      { om_original: { messageId: "om_stale_help" } },
      {
        tasks: {
          task: {
            bridgeMessageId: "om_original",
            helpCardMessageId: "om_latest_help",
          },
        },
      },
    );

    expect(entries).toEqual({ om_original: { messageId: "om_latest_help" } });
  });

  it("migrates the official IM state into the persistent dedup store", () => {
    const directory = mkdtempSync(join(tmpdir(), "aamp-card-state-"));
    try {
      const runtimeHome = join(directory, "runtime-v1");
      const statePath = join(
        runtimeHome,
        "bindings",
        "binding",
        "feishu-bridge",
        "task-runtime",
        "instances",
        "instance",
        "im",
        "state.json",
      );
      const dedupPath = join(directory, "project", "runtime", "aamp", "lark-card-dedup.json");
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({
        tasks: {
          task: {
            bridgeMessageId: "om_original",
            helpCardMessageId: "om_existing_help",
          },
        },
      }));

      seedAampCardDedupState(dedupPath, { AAMP_TASK_RUNTIME_HOME: runtimeHome });

      expect(JSON.parse(readFileSync(dedupPath, "utf8")).entries).toEqual({
        om_original: { messageId: "om_existing_help" },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("can replace only the launchd program entry", () => {
    const plist = [
      "<key>ProgramArguments</key>",
      "<array>",
      "<string>/Users/xiajian/.aamp/bin/feishu-task-agent</string>",
      "<string>__service-run</string>",
      "</array>",
    ].join("\n");

    expect(replaceLaunchdBootstrapPath(plist, "/tmp/bridge/runtime/aamp/bin/feishu-task-agent-bootstrap"))
      .toContain("<string>/tmp/bridge/runtime/aamp/bin/feishu-task-agent-bootstrap</string>");
  });
});
