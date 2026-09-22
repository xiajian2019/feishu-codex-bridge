import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { parseConfig } from "../src/config.js";
import {
  readAampCodexBindings,
  resolveSharedFeishuCredentials,
} from "../src/feishu-credentials.js";

const temporaryDirectories: string[] = [];

const config = parseConfig({
  execution: { mode: "feishu-sqlite-codex" },
  direct: { feishu: {} },
  lark: {
    profile: "aamp-codex-profile",
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
  projects: {},
  modes: {},
}, { checkRepositories: false });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("shared Feishu credential adapter", () => {
  it("reads the selected Codex credential from the AAMP binding store", () => {
    const stateHome = makeStateHome();
    writeFileSync(join(stateHome, "bindings-v1.json"), JSON.stringify({
      schema: "aamp.feishu-task-agent.bindings",
      version: 1,
      bindings: [
        {
          binding_id: "binding-other",
          agent_type: "cursor",
          bot: {
            app_id: "cli-other",
            app_secret: "secret-other",
            tenant_brand: "feishu",
          },
          environment: { name: "online" },
          state: "ready",
        },
        {
          binding_id: "binding-codex",
          agent_type: "codex",
          bot: {
            app_id: "cli-codex",
            app_secret: "secret-codex",
            tenant_brand: "lark",
            lark_cli_profile: "aamp-codex-profile",
          },
          environment: { name: "online" },
          state: "ready",
        },
      ],
    }));
    mkdirSync(join(stateHome, "service-v1"), { recursive: true });
    writeFileSync(join(stateHome, "service-v1", "selection.json"), JSON.stringify({
      binding_ids: ["binding-codex"],
    }));

    const result = resolveSharedFeishuCredentials(config, {
      inheritedEnv: { AAMP_TASK_STATE_HOME: stateHome },
    });

    expect(result).toMatchObject({
      appId: "cli-codex",
      appSecret: "secret-codex",
      source: "aamp-binding",
      bindingId: "binding-codex",
      tenantBrand: "lark",
      larkCliProfile: "aamp-codex-profile",
    });
    expect(readAampCodexBindings({ stateHome })).toHaveLength(1);
  });

  it("keeps explicit direct credentials ahead of the shared AAMP store", () => {
    const stateHome = makeStateHome();
    writeFileSync(join(stateHome, "bindings-v1.json"), JSON.stringify({
      schema: "aamp.feishu-task-agent.bindings",
      version: 1,
      bindings: [{
        binding_id: "binding-codex",
        agent_type: "codex",
        bot: { app_id: "cli-aamp", app_secret: "secret-aamp" },
        environment: { name: "online" },
        state: "ready",
      }],
    }));

    const result = resolveSharedFeishuCredentials({
      ...config,
      direct: {
        ...config.direct,
        feishu: { ...config.direct.feishu, appId: "cli-explicit", appSecret: "secret-explicit" },
      },
    }, { stateHome });

    expect(result).toMatchObject({
      appId: "cli-explicit",
      appSecret: "secret-explicit",
      source: "direct-config",
    });
    expect(result.bindingId).toBeUndefined();
  });

  it("preserves the legacy environment fallback when no AAMP binding exists", () => {
    const result = resolveSharedFeishuCredentials({
      ...config,
      direct: {
        ...config.direct,
        feishu: {
          ...config.direct.feishu,
          appIdEnv: "TEST_SHARED_FEISHU_APP_ID",
          appSecretEnv: "TEST_SHARED_FEISHU_APP_SECRET",
        },
      },
    }, {
      inheritedEnv: {
        TEST_SHARED_FEISHU_APP_ID: "cli-env",
        TEST_SHARED_FEISHU_APP_SECRET: "secret-env",
      },
      bindingsPath: "/tmp/feishu-codex-bridge-no-such-bindings.json",
    });

    expect(result).toMatchObject({
      appId: "cli-env",
      appSecret: "secret-env",
      source: "environment",
    });
  });
});

function makeStateHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "feishu-codex-credentials-"));
  temporaryDirectories.push(directory);
  return directory;
}
