import { describe, expect, it } from "bun:test";

import {
  CODEX_NOTIFY_CHAIN_DEPTH_ENV,
  isCodexCompletionNotifyPayload,
  isBridgeCommand,
  parseNotifyCommand,
  parseNotifyPayload,
  replaceNotifyCommand,
  runCodexNotifyHook,
  sanitizeLegacyNotifyCommand,
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

  it("accepts only official typed completion events", () => {
    expect(isCodexCompletionNotifyPayload({
      type: "agent-turn-complete",
      "thread-id": "thr_1",
    })).toBe(true);
    expect(isCodexCompletionNotifyPayload({
      type: "turn-ended",
      "thread-id": "thr_1",
    })).toBe(false);
    expect(isCodexCompletionNotifyPayload({ "thread-id": "thr_1" })).toBe(false);
    expect(isCodexCompletionNotifyPayload({ type: "agent-turn-complete" })).toBe(false);
  });

  it("detects and removes a nested Bridge previous-notify command", () => {
    const bridge = ["/tmp/bridge", "codex:notify-dispatch", "--config", "/tmp/config.json"];
    const wrapped = ["/tmp/sky", "turn-ended", "--previous-notify", JSON.stringify(bridge)];

    expect(isBridgeCommand(bridge)).toBe(true);
    expect(isBridgeCommand(wrapped)).toBe(true);
    expect(sanitizeLegacyNotifyCommand(wrapped)).toEqual(["/tmp/sky", "turn-ended"]);
  });

  it("preserves a non-Bridge previous-notify command", () => {
    const previous = ["/tmp/other-hook", "--payload"];
    const wrapped = ["/tmp/sky", "turn-ended", "--previous-notify", JSON.stringify(previous)];

    expect(isBridgeCommand(wrapped)).toBe(false);
    expect(sanitizeLegacyNotifyCommand(wrapped)).toEqual(wrapped);
  });

  it("removes the Sky legacy notification hook", () => {
    expect(sanitizeLegacyNotifyCommand([
      "/Users/me/Codex Computer Use.app/SkyComputerUseClient",
      "turn-ended",
    ])).toBeNull();
  });

  it("does not re-enter a nested Bridge notify chain", async () => {
    await runCodexNotifyHook({} as never, [], {
      [CODEX_NOTIFY_CHAIN_DEPTH_ENV]: "1",
    });
  });

});
