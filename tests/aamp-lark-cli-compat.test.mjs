import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCardUpdateArgs,
  cardDedupKey,
  parseInteractiveCardReply,
} from "../scripts/aamp-lark-cli-compat.mjs";

const execFile = promisify(execFileCallback);

function cardArgs(replyTo, content) {
  return [
    "api",
    "POST",
    `/open-apis/im/v1/messages/${replyTo}/reply`,
    "--as",
    "bot",
    "--profile",
    "aamp-profile",
    "--format",
    "json",
    "--data",
    JSON.stringify({ msg_type: "interactive", content, reply_in_thread: false }),
  ];
}

function fakeCliScript(logPath) {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args[1] === "PATCH") {
  console.log(JSON.stringify({ ok: true, data: {} }));
} else if (args[0] === "api" && args[1] === "POST") {
  console.log(JSON.stringify({ ok: true, data: { message_id: "om_created" } }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
`;
}

async function runCompat(scriptPath, statePath, args, extraEnv = {}) {
  return execFile(process.execPath, [
    join(process.cwd(), "scripts", "aamp-lark-cli-compat.mjs"),
    ...args,
  ], {
    env: {
      ...process.env,
      AAMP_REAL_LARK_CLI_BIN: scriptPath,
      AAMP_LARK_CARD_DEDUP_STATE: statePath,
      ...extraEnv,
    },
  });
}

describe("AAMP lark-cli compatibility shim", () => {
  it("recognizes only official interactive reply card calls", () => {
    const parsed = parseInteractiveCardReply(cardArgs("om_original", "{}"));
    expect(parsed).toMatchObject({ replyTo: "om_original", content: "{}" });
    expect(parseInteractiveCardReply([
      "api",
      "POST",
      "/open-apis/im/v1/messages/om_original/reply",
      "--data",
      JSON.stringify({ msg_type: "text", content: "hello" }),
    ])).toBeUndefined();
  });

  it("updates the existing card on a replay instead of creating a second card", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aamp-lark-cli-compat-"));
    try {
      const logPath = join(directory, "calls.jsonl");
      const scriptPath = join(directory, "fake-lark-cli.mjs");
      const statePath = join(directory, "state.json");
      writeFileSync(scriptPath, fakeCliScript(logPath), { mode: 0o700 });
      chmodSync(scriptPath, 0o700);
      const content = JSON.stringify({ schema: "2.0", body: [{ tag: "markdown", content: "help" }] });
      const args = cardArgs("om_original", content);

      const first = await runCompat(scriptPath, statePath, args);
      const second = await runCompat(scriptPath, statePath, args);

      expect(JSON.parse(first.stdout).data.message_id).toBe("om_created");
      expect(JSON.parse(second.stdout).data.message_id).toBe("om_created");
      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call[1])).toEqual(["POST", "PATCH"]);
      expect(calls[1][2]).toBe("/open-apis/im/v1/messages/om_created");
      expect(JSON.parse(readFileSync(statePath, "utf8")).entries[cardDedupKey("om_original", content)])
        .toEqual({ messageId: "om_created" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses a seeded help-card id before the first post-fix send", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aamp-lark-cli-seed-"));
    try {
      const logPath = join(directory, "calls.jsonl");
      const scriptPath = join(directory, "fake-lark-cli.mjs");
      const statePath = join(directory, "state.json");
      writeFileSync(scriptPath, fakeCliScript(logPath), { mode: 0o700 });
      chmodSync(scriptPath, 0o700);
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        entries: { om_original: { messageId: "om_existing_help" } },
      }));
      const args = cardArgs("om_original", "{\"schema\":\"2.0\"}");

      const result = await runCompat(scriptPath, statePath, args);

      expect(JSON.parse(result.stdout).data.message_id).toBe("om_existing_help");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe("PATCH");
      expect(calls[0][2]).toBe("/open-apis/im/v1/messages/om_existing_help");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds the same PATCH payload shape as the official bridge", () => {
    const args = cardArgs("om_original", "{\"schema\":\"2.0\"}");
    const update = buildCardUpdateArgs(args, "om_existing", "{\"schema\":\"2.0\"}");
    expect(update.slice(0, 3)).toEqual([
      "api",
      "PATCH",
      "/open-apis/im/v1/messages/om_existing",
    ]);
    expect(JSON.parse(update.at(-1)).content).toBe("{\"schema\":\"2.0\"}");
  });
});
