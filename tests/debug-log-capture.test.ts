import { afterEach, describe, expect, test } from "bun:test";

import {
  beginDebugLogCapture,
  cancelDebugLogCapture,
  finishDebugLogCapture,
  isDebugLogCaptureActive,
} from "../web/src/debug-log-capture.js";

const globalWithWindow = globalThis as typeof globalThis & { window?: Window };
const originalWindow = globalWithWindow.window;
const originalInfo = console.info;
const originalLog = console.log;

afterEach(() => {
  cancelDebugLogCapture();
  console.info = originalInfo;
  console.log = originalLog;
  if (originalWindow) {
    globalWithWindow.window = originalWindow;
  } else {
    delete globalWithWindow.window;
  }
});

describe("debug log capture", () => {
  test("captures console output and returns it as a file", async () => {
    const calls: unknown[][] = [];
    console.info = ((...args: unknown[]) => calls.push(args)) as typeof console.info;
    console.log = ((...args: unknown[]) => calls.push(args)) as typeof console.log;
    globalWithWindow.window = {} as Window;

    expect(beginDebugLogCapture()).toBe(true);
    expect(isDebugLogCaptureActive()).toBe(true);
    console.log("viewport changed", { height: 412 });
    const file = finishDebugLogCapture();

    expect(file).not.toBeNull();
    expect(file?.name).toMatch(/^tmux-debug-.*\.log$/);
    const text = await file!.text();
    expect(text).toContain("capture-start");
    expect(text).toContain("viewport changed");
    expect(text).toContain("capture-finish");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(isDebugLogCaptureActive()).toBe(false);
  });

  test("does not leave console patched after cancellation", () => {
    globalWithWindow.window = {} as Window;
    console.log = (() => {}) as typeof console.log;
    const before = console.log;
    beginDebugLogCapture();
    expect(console.log).not.toBe(before);
    cancelDebugLogCapture();
    expect(console.log).toBe(before);
    expect(finishDebugLogCapture()).toBeNull();
  });
});
