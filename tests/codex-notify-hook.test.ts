import { describe, expect, it } from "vitest";

import {
  parseNotifyCommand,
  parseNotifyPayload,
  replaceNotifyCommand,
} from "../src/codex-notify-hook.js";

describe("Codex official notify hook", () => {
  it("parses and replaces a multiline root notify array without touching tables", () => {
    const config = [
      "model = \"gpt-5.6-luna\"",
      "notify = [",
      "  \"/Applications/Sky.app/Contents/MacOS/Sky\",",
      "  \"turn-ended\",",
      "]",
      "",
      "[tui]",
      "notifications = true",
      "",
    ].join("\n");
    expect(parseNotifyCommand(config)).toEqual([
      "/Applications/Sky.app/Contents/MacOS/Sky",
      "turn-ended",
    ]);
    const replaced = replaceNotifyCommand(config, ["/tmp/bridge", "codex:notify-hook"]);
    expect(replaced).toContain('notify = [\n  "/tmp/bridge",\n  "codex:notify-hook"\n]');
    expect(replaced).toContain("[tui]\nnotifications = true");
  });

  it("inserts a user-level notify key before the first table", () => {
    const replaced = replaceNotifyCommand("model = \"gpt-5.6-luna\"\n\n[tui]\n", ["/tmp/bridge"]);
    expect(replaced.indexOf("notify =")).toBeLessThan(replaced.indexOf("[tui]"));
  });

  it("finds the official completion payload after hook options", () => {
    expect(parseNotifyPayload([
      "--config",
      "/tmp/config.json",
      JSON.stringify({ type: "agent-turn-complete", "thread-id": "thr_1" }),
    ])).toEqual({ type: "agent-turn-complete", "thread-id": "thr_1" });
  });
});
