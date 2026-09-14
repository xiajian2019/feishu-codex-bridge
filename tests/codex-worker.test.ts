import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";
import { buildCodexEnvironment } from "../src/codex-worker.js";

describe("Codex worker environment", () => {
  it("removes Feishu credentials and scopes the required proxy variables", () => {
    const config = parseConfig(
      {
        lark: {
          profile: "work",
          configDir: "/tmp/lark-cli-aamp-one-click-v1",
          cliPath: "/opt/homebrew/bin/lark-cli",
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
    const env = buildCodexEnvironment(config, {
      PATH: "/bin",
      LARK_ACCESS_TOKEN: "secret",
      FEISHU_APP_SECRET: "secret",
      HTTP_PROXY: "http://wrong",
    });
    expect(env.PATH).toBe("/opt/homebrew/bin:/bin");
    expect(env.LARK_ACCESS_TOKEN).toBeUndefined();
    expect(env.FEISHU_APP_SECRET).toBeUndefined();
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.LARKSUITE_CLI_CONFIG_DIR).toBe("/tmp/lark-cli-aamp-one-click-v1");
    expect(env.LARK_CLI_PATH).toBe("/opt/homebrew/bin/lark-cli");
    expect(env.PATH?.startsWith("/opt/homebrew/bin:")).toBe(true);
  });
});
