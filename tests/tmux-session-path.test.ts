import { describe, expect, it } from "bun:test";

import { normalizeSessionPathInput, sessionPathName, sessionPathParent } from "../web/src/tmux-session-path.js";

describe("tmux session path input", () => {
  it("normalizes a safe relative path and keeps trailing folder intent", () => {
    expect(normalizeSessionPathInput(" ./android\\app/build/ ")).toEqual({
      path: "android/app/build",
      hasTrailingSlash: true,
    });
  });

  it("rejects absolute paths and parent traversal", () => {
    expect(normalizeSessionPathInput("/Users/xiajian/project")).toBeNull();
    expect(normalizeSessionPathInput("android/../ios")).toBeNull();
    expect(normalizeSessionPathInput("C:\\project")).toBeNull();
  });

  it("finds the parent folder for a file path", () => {
    const path = "android/app/build/outputs/apk/debug/app-debug.apk";
    expect(sessionPathParent(path)).toBe("android/app/build/outputs/apk/debug");
    expect(sessionPathName(path)).toBe("app-debug.apk");
  });
});
