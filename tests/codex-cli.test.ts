import { describe, expect, it } from "vitest";

import {
  buildCodexLaunchAgentPlist,
  formatDirectRecent,
  parseCodexCliArguments,
  parseDirectTaskStatuses,
  resolveLaunchAgentNodePath,
} from "../src/codex-cli.js";
import { StateDatabase } from "../src/db.js";

describe("native Codex CLI", () => {
  it("parses global config and database options around a command", () => {
    expect(parseCodexCliArguments([
      "task",
      "bridge_123",
      "--json",
      "--config",
      "./custom.json",
      "--db=./runtime/custom.db",
    ], "/tmp/bridge")).toEqual({
      configPath: "/tmp/bridge/custom.json",
      dbPath: "/tmp/bridge/runtime/custom.db",
      executionMode: undefined,
      nodePath: undefined,
      command: ["task", "bridge_123", "--json"],
      help: false,
    });
  });

  it("parses a direct execution-mode and LaunchAgent Node override", () => {
    expect(parseCodexCliArguments([
      "install",
      "--mode=feishu-sqlite-acp",
      "--node",
      "/opt/node-22/bin/node",
    ], "/tmp/bridge")).toMatchObject({
      executionMode: "feishu-sqlite-acp",
      nodePath: "/opt/node-22/bin/node",
      command: ["install"],
    });
  });

  it("validates direct task status filters", () => {
    expect(parseDirectTaskStatuses(["--status", "FAILED,CANCELLED", "--status=QUEUED"])).toEqual([
      "FAILED",
      "CANCELLED",
      "QUEUED",
    ]);
    expect(() => parseDirectTaskStatuses(["--status", "UNKNOWN"])).toThrow(/未知直连任务状态/);
  });

  it("builds a self-contained background LaunchAgent plist", () => {
    const plist = buildCodexLaunchAgentPlist({
      nodePath: "/opt/node/bin/node",
      projectRoot: "/tmp/bridge & direct",
      configPath: "/tmp/bridge/config.json",
      dbPath: "/tmp/bridge/runtime/bridge.db",
      stdoutPath: "/tmp/bridge/runtime/logs/stdout.log",
      stderrPath: "/tmp/bridge/runtime/logs/stderr.log",
    });
    expect(plist).toContain("com.local.feishu-codex-bridge");
    expect(plist).toContain("<string>/tmp/bridge &amp; direct/dist/main.js</string>");
    expect(plist).toContain("<string>--execution-mode</string>");
    expect(plist).toContain("<string>feishu-sqlite-codex</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>Background</string>");
  });

  it("rejects an explicitly selected unsupported LaunchAgent Node", () => {
    expect(() => resolveLaunchAgentNodePath("/usr/bin/false")).toThrow(/Node/);
  });

  it("formats recent SQLite tasks with bounded messages", () => {
    const db = new StateDatabase(":memory:");
    const task = db.ingestDirectMessage({
      sourceEventId: "evt-cli",
      eventType: "im.message.receive_v1",
      messageId: "om-cli",
      chatId: "oc-cli",
      chatType: "p2p",
      senderId: "ou-cli",
      text: "请处理这个任务",
      sessionKey: "chat:oc-cli",
    }).task;
    const output = formatDirectRecent({ items: [task], total: 1 }, { databasePath: "/tmp/bridge.db" });
    expect(output).toContain("Codex 最近任务（1/1）");
    expect(output).toContain(task.bridge_task_id);
    expect(output).toContain("请处理这个任务");
    db.close();
  });
});
