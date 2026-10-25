import { describe, expect, it } from "bun:test";

import {
  CODEX_HOME_LABEL_FALLBACKS,
  mergeCodexHomeOption,
  normalizeCodexHomeOptions,
  resolveCodexHomeLabel,
  UNKNOWN_CODEX_HOME_LABEL,
} from "../web/src/tmux-codex-account.js";

describe("tmux Codex account display fallback", () => {
  it("keeps the two fixed account labels when the response omits labels", () => {
    expect(normalizeCodexHomeOptions([
      { id: "default-id", label: "", available: true },
      { id: "second-id", label: " ", available: true },
    ])).toEqual([
      { id: "default-id", label: CODEX_HOME_LABEL_FALLBACKS[0], available: true },
      { id: "second-id", label: CODEX_HOME_LABEL_FALLBACKS[1], available: true },
    ]);
  });

  it("recovers the account label from a successful quota response", () => {
    const account = { homeId: "second-id", label: "second", available: true } as const;
    const homes = mergeCodexHomeOption([], account);
    expect(homes).toEqual([{ id: "second-id", label: "second", available: true }]);
    expect(resolveCodexHomeLabel("second-id", [], account)).toBe("second");
  });

  it("does not call a missing metadata response an unavailable account", () => {
    expect(resolveCodexHomeLabel("saved-id", [])).toBe(UNKNOWN_CODEX_HOME_LABEL);
  });
});
