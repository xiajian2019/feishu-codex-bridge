import { describe, expect, it } from "bun:test";

import { createTmuxAdapter } from "../src/tmux-adapter.js";
import type { TmuxSessionRecord } from "../src/tmux-verifier-store.js";

const session = {
  machine: "local",
  tmux_socket: "",
  tmux_session: "codex-verify-test",
} as TmuxSessionRecord;

describe("TmuxAdapter", () => {
  it("attaches to the existing tmux server when no socket is configured", () => {
    const adapter = createTmuxAdapter(session);

    expect(adapter.attachCommand(session)).toBe(
      "'tmux' 'attach-session' '-t' 'codex-verify-test'",
    );
  });

  it("supports a named socket when explicitly configured", () => {
    const isolatedSession = { ...session, tmux_socket: "isolated" };
    const adapter = createTmuxAdapter(isolatedSession);

    expect(adapter.attachCommand(isolatedSession)).toBe(
      "'tmux' '-L' 'isolated' 'attach-session' '-t' 'codex-verify-test'",
    );
  });
});
