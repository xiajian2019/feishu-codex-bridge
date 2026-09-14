import { describe, expect, it } from "vitest";

import {
  LarkCliClient,
  sanitizeCommentContent,
  type CommandResult,
} from "../src/lark.js";
import { parseConfig } from "../src/config.js";

function testConfig() {
  return parseConfig(
    {
      lark: {
        profile: "work",
        tasklistGuid: "list-1",
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

function result(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

describe("LarkCliClient", () => {
  it("uses the work profile, paginates, and sends completed=false as raw params", async () => {
    const calls: string[][] = [];
    const client = new LarkCliClient(testConfig(), {
      execute: async (_file, args) => {
        calls.push(args);
        const paramsIndex = args.indexOf("--params");
        const params = JSON.parse(args[paramsIndex + 1]) as Record<string, unknown>;
        if (!params.page_token) {
          return result(JSON.stringify({
            items: [{ guid: "task-1", summary: "one" }],
            has_more: true,
            page_token: "next-page",
          }));
        }
        return result(JSON.stringify({
          items: [{ guid: "task-2", summary: "two" }],
          has_more: false,
          page_token: "",
        }));
      },
    });

    await expect(client.listIncompleteTasks()).resolves.toEqual([
      { guid: "task-1", summary: "one" },
      { guid: "task-2", summary: "two" },
    ]);
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(["--profile", "work"]);
      expect(args).not.toContain("--completed");
      const params = JSON.parse(args[args.indexOf("--params") + 1]) as Record<string, unknown>;
      expect(params.tasklist_guid).toBe("list-1");
      expect(params.page_size).toBe(100);
      expect(params.completed).toBe(false);
    }
    const secondParams = JSON.parse(calls[1][calls[1].indexOf("--params") + 1]) as Record<string, unknown>;
    expect(secondParams.page_token).toBe("next-page");
  });

  it("wraps task get and comment commands with the same profile", async () => {
    const calls: string[][] = [];
    const client = new LarkCliClient(testConfig(), {
      execute: async (_file, args) => {
        calls.push(args);
        if (args.includes("get")) {
          return result(JSON.stringify({ task: { guid: "task-1", status: "todo" } }));
        }
        return result(JSON.stringify({ ok: true }));
      },
    });
    await expect(client.getTask("task-1")).resolves.toMatchObject({ guid: "task-1" });
    await client.addComment("task-1", "hello; $(not-a-shell-command)");
    expect(calls[0].slice(0, 2)).toEqual(["--profile", "work"]);
    expect(calls[1].slice(0, 2)).toEqual(["--profile", "work"]);
    expect(JSON.parse(calls[0][calls[0].indexOf("--params") + 1])).toEqual({ task_guid: "task-1" });
    expect(calls[1]).toContain("hello; $(not-a-shell-command)");
  });

  it("updates descriptions and reopens tasks through the work profile", async () => {
    const calls: string[][] = [];
    const client = new LarkCliClient(testConfig(), {
      execute: async (_file, args) => {
        calls.push(args);
        return result(JSON.stringify({ ok: true, data: { updated_fields: ["description"] } }));
      },
    });
    await client.updateDescription("task-1", "补充反馈");
    await client.reopenTask("task-1");
    expect(calls[0]).toEqual([
      "--profile", "work", "task", "+update", "--as", "user", "--task-id", "task-1",
      "--description", "补充反馈", "--format", "json",
    ]);
    expect(calls[1]).toEqual([
      "--profile", "work", "task", "+reopen", "--as", "user", "--task-id", "task-1",
      "--format", "json",
    ]);
  });

  it("removes local Markdown links before sending task comments", () => {
    expect(
      sanitizeCommentContent(
        "[local](/Users/xiajian/works/boohee/food/app/models/food.rb:12) "
          + "[web](https://example.com/a) [app](applink://client/todo/detail)",
      ),
    ).toBe("local [web](https://example.com/a) [app](applink://client/todo/detail)");
  });

  it("passes the exact profile and isolated config directory without fallback", async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const client = new LarkCliClient(
      parseConfig(
        {
          ...testConfig(),
          lark: {
            ...testConfig().lark,
            profile: "aamp-feishu-task-cli_aa1c1a04feb89d24",
            configDir: "/tmp/lark-cli-aamp-one-click-v1",
            cliPath: "/opt/homebrew/bin/lark-cli",
          },
        },
        { checkRepositories: false },
      ),
      {
        execute: async (_file, args, options) => {
          calls.push({ args, env: options?.env });
          return result(JSON.stringify({ task: { guid: "task-1", status: "todo" } }));
        },
      },
    );

    await client.getTask("task-1");
    expect(calls[0].args.slice(0, 2)).toEqual([
      "--profile",
      "aamp-feishu-task-cli_aa1c1a04feb89d24",
    ]);
    expect(calls[0].env?.LARKSUITE_CLI_CONFIG_DIR).toBe("/tmp/lark-cli-aamp-one-click-v1");
  });

  it("retries transient network errors but does not retry missing profiles", async () => {
    let attempts = 0;
    const client = new LarkCliClient(testConfig(), {
      maxAttempts: 3,
      retryDelayMs: 0,
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          return result(JSON.stringify({
            ok: false,
            error: { type: "network", subtype: "temporary", message: "socket hang up" },
          }));
        }
        return result(JSON.stringify({ task: { guid: "task-1", status: "todo" } }));
      },
    });
    await expect(client.getTask("task-1")).resolves.toMatchObject({ guid: "task-1" });
    expect(attempts).toBe(2);

    attempts = 0;
    const missingProfile = new LarkCliClient(testConfig(), {
      maxAttempts: 3,
      retryDelayMs: 0,
      execute: async () => {
        attempts += 1;
        return result(JSON.stringify({
          ok: false,
          error: { type: "config", subtype: "not_configured", message: "profile not found" },
        }));
      },
    });
    await expect(missingProfile.getTask("task-1")).rejects.toThrow(/profile not found/);
    expect(attempts).toBe(1);
  });
});
