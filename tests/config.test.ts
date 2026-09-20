import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

const base = {
  lark: {
    profile: "work",
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
};

describe("config validation", () => {
  it("enables the loopback dashboard by default", () => {
    const config = parseConfig(base, { checkRepositories: false });
    expect(config.web).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 7310,
    });
    expect(config.runTimeoutSeconds).toBe(3600);
    expect(config.execution.mode).toBe("legacy-polling");
    expect(config.aamp).toEqual({ enabled: false, stopOnShutdown: false });
    expect(config.relay).toEqual({ enabled: false });
    expect(config.localNotifications).toEqual({ enabled: false, intervalSeconds: 60 });
    expect(config.direct.retry).toEqual({
      maxAttempts: 3,
      initialDelaySeconds: 5,
      maxDelaySeconds: 120,
    });
  });

  it("selects the native direct mode and keeps the ACP name as an alias", () => {
    const direct = {
      projectKey: "food",
      mode: "review",
      feishu: {},
    };
    expect(parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct,
    }, { checkRepositories: false })).toMatchObject({
      execution: { mode: "feishu-sqlite-codex" },
      direct: {
        projectKey: "food",
        mode: "review",
        feishu: {
          appIdEnv: "FEISHU_APP_ID",
          appSecretEnv: "FEISHU_APP_SECRET",
          dmMode: "open",
        },
        permissions: {
          defaultAllow: true,
          allowAttachments: true,
          allowCancel: true,
          rules: [],
        },
      },
    });
    expect(parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-acp" },
      direct,
    }, { checkRepositories: false }).execution.mode).toBe("feishu-sqlite-acp");
  });

  it("allows the process invocation to override a legacy AAMP default", () => {
    const config = parseConfig({
      ...base,
      aamp: { enabled: true },
      relay: { enabled: true },
      direct: { projectKey: "food", mode: "review", feishu: {} },
    }, {
      checkRepositories: false,
      executionMode: "feishu-sqlite-codex",
    });
    expect(config.execution.mode).toBe("feishu-sqlite-codex");
  });

  it("allows direct startup without fixed project or mode defaults", () => {
    expect(parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: { feishu: {} },
    }, { checkRepositories: false })).toMatchObject({
      execution: { mode: "feishu-sqlite-codex" },
      direct: { feishu: {}, permissions: {} },
    });
    expect(parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: { feishu: {} },
      projects: {},
      modes: {},
    }, { checkRepositories: false })).toMatchObject({
      projects: {},
      modes: {},
    });
  });

  it("allows direct mode to inherit proxy settings from the service environment", () => {
    const config = parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      codex: { cliPath: "/opt/homebrew/bin/codex", env: {} },
      direct: { projectKey: "food", mode: "review", feishu: {} },
    }, { checkRepositories: false });
    expect(config.codex.env).toEqual({});
  });

  it("rejects direct defaults that are not in the task registries", () => {
    expect(() => parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: { projectKey: "missing", mode: "review", feishu: {} },
    }, { checkRepositories: false })).toThrow(/direct\.projectKey/);
    expect(() => parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: { projectKey: "food", mode: "missing", feishu: {} },
    }, { checkRepositories: false })).toThrow(/direct\.mode/);
  });

  it("validates fine-grained direct permissions", () => {
    const config = parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: {
        projectKey: "food",
        mode: "review",
        permissions: {
          defaultAllow: false,
          allowAttachments: false,
          allowCancel: true,
          rules: [{ senderOpenId: "ou_owner", allow: true, allowAttachments: true }],
        },
      },
    }, { checkRepositories: false });
    expect(config.direct.permissions).toEqual({
      defaultAllow: false,
      allowAttachments: false,
      allowCancel: true,
      rules: [{ senderOpenId: "ou_owner", allow: true, allowAttachments: true }],
    });
    expect(() => parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: {
        projectKey: "food",
        mode: "review",
        permissions: { rules: [{}] },
      },
    }, { checkRepositories: false })).toThrow(/at least one of chatId/);
  });

  it("validates bounded transient retry settings", () => {
    const config = parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: {
        feishu: {},
        retry: { maxAttempts: 4, initialDelaySeconds: 2, maxDelaySeconds: 30 },
      },
    }, { checkRepositories: false });
    expect(config.direct.retry).toEqual({
      maxAttempts: 4,
      initialDelaySeconds: 2,
      maxDelaySeconds: 30,
    });
    expect(() => parseConfig({
      ...base,
      execution: { mode: "feishu-sqlite-codex" },
      direct: { feishu: {}, retry: { initialDelaySeconds: 30, maxDelaySeconds: 5 } },
    }, { checkRepositories: false })).toThrow(/maxDelaySeconds/);
  });

  it("rejects duplicate field and option GUIDs", () => {
    expect(() =>
      parseConfig(
        {
          ...base,
          modes: { review: { optionGuid: "project-option", sandboxMode: "read-only" } },
        },
        { checkRepositories: false },
      ),
    ).toThrow(/GUIDs must be unique/);
  });

  it("accepts an exact AAMP profile name and rejects full-access sandbox", () => {
    expect(
      parseConfig(
        {
          ...base,
          lark: { ...base.lark, profile: "aamp-feishu-task-cli_aa1c1a04feb89d24" },
        },
        { checkRepositories: false },
      ).lark.profile,
    ).toBe("aamp-feishu-task-cli_aa1c1a04feb89d24");
    expect(() =>
      parseConfig(
        {
          ...base,
          modes: { review: { optionGuid: "mode-option", sandboxMode: "danger-full-access" } },
        },
        { checkRepositories: false },
      ),
    ).toThrow(/sandboxMode/);
  });

  it("requires an absolute system Codex CLI path", () => {
    expect(() =>
      parseConfig(
        {
          ...base,
          codex: { ...base.codex, cliPath: "codex" },
        },
        { checkRepositories: false },
      ),
    ).toThrow(/codex\.cliPath/);
  });

  it("validates optional AAMP worktree paths", () => {
    const worktree = {
      enabled: true,
      projectMapPath: "/tmp/project-map.yaml",
      globalAgentsPath: "/tmp/AGENTS.md",
      taskDir: "/tmp/tasks",
      worktreeRoot: "/tmp/worktrees",
      baseRef: "main",
      branchPrefix: "xiajian/agent",
    };
    expect(parseConfig({ ...base, aamp: { worktree } }, { checkRepositories: false }).aamp.worktree)
      .toEqual(worktree);
    expect(() => parseConfig({
      ...base,
      aamp: { worktree: { ...worktree, taskDir: "relative/tasks" } },
    }, { checkRepositories: false })).toThrow(/aamp\.worktree\.taskDir/);
  });

  it("rejects exposing the dashboard on a non-loopback address", () => {
    expect(() =>
      parseConfig(
        { ...base, web: { host: "0.0.0.0", port: 7310, enabled: true } },
        { checkRepositories: false },
      ),
    ).toThrow(/web\.host/);
  });

  it("requires an internal AAMP host when Relay mode is enabled", () => {
    expect(() => parseConfig({ ...base, execution: { mode: "aamp-relay" }, relay: { enabled: true } }, { checkRepositories: false }))
      .toThrow(/relay\.aampHost/);
    expect(() => parseConfig({
      ...base,
      execution: { mode: "aamp-relay" },
      relay: { enabled: true, aampHost: "https://meshmail.ai", statusUrl: "http://relay.internal/status" },
    }, { checkRepositories: false })).toThrow(/meshmail/);
    expect(() => parseConfig({
      ...base,
      execution: { mode: "aamp-relay" },
      relay: { enabled: true, aampHost: "https://edge.meshmail.ai" },
    }, { checkRepositories: false })).toThrow(/meshmail/);
    expect(() => parseConfig({
      ...base,
      execution: { mode: "aamp-relay" },
      relay: { enabled: true, aampHost: "ftp://relay.internal" },
    }, { checkRepositories: false })).toThrow(/relay\.aampHost/);
  });
});
