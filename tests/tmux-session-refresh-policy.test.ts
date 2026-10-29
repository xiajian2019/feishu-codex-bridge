import { describe, expect, it } from "bun:test";
import {
  isSessionListRefreshStale,
  shouldRefreshSessionListOnPageShow,
  shouldRefreshSessionListOnVisibilityChange,
} from "../web/src/tmux-session-refresh-policy.js";

describe("tmux session lifecycle refresh policy", () => {
  const now = 100_000;

  it("refreshes only after the lifecycle cache is stale", () => {
    expect(isSessionListRefreshStale(40_001, now, 60_000)).toBe(false);
    expect(isSessionListRefreshStale(40_000, now, 60_000)).toBe(true);
    expect(isSessionListRefreshStale(0, now, 60_000)).toBe(true);
  });

  it("refreshes only on hidden to visible", () => {
    expect(shouldRefreshSessionListOnVisibilityChange("visible", "visible", 0, now)).toBe(false);
    expect(shouldRefreshSessionListOnVisibilityChange("visible", "hidden", 0, now)).toBe(false);
    expect(shouldRefreshSessionListOnVisibilityChange("hidden", "visible", 40_000, now)).toBe(true);
    expect(shouldRefreshSessionListOnVisibilityChange("hidden", "visible", 40_001, now)).toBe(false);
  });

  it("refreshes pageshow only for BFCache restores", () => {
    expect(shouldRefreshSessionListOnPageShow(false, "visible", 0, now)).toBe(false);
    expect(shouldRefreshSessionListOnPageShow(true, "hidden", 0, now)).toBe(false);
    expect(shouldRefreshSessionListOnPageShow(true, "visible", 40_000, now)).toBe(true);
    expect(shouldRefreshSessionListOnPageShow(true, "visible", 40_001, now)).toBe(false);
  });
});
