import { afterEach, beforeEach, expect, it } from "bun:test";
import { setAppForeground, startForegroundPolling } from "../web/src/foreground-polling.js";

const original = new Map(["window", "document", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };
let net: { onLine: boolean };
let stop: (() => void) | undefined;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  win = new EventTarget(); doc = Object.assign(new EventTarget(), { visibilityState: "visible" }); net = { onLine: true };
  for (const [key, value] of [["window", win], ["document", doc], ["navigator", net]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
  setAppForeground(true);
});
afterEach(() => {
  stop?.(); stop = undefined; setAppForeground(true);
  for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});
it("pauses invisible/offline/native-background reads and immediately resumes with a fresh signal", async () => {
  const signals: AbortSignal[] = [];
  stop = startForegroundPolling(async (signal) => { signals.push(signal); }, 10_000);
  await settle(); expect(signals).toHaveLength(1);
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
  net.onLine = false; doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
  expect(signals).toHaveLength(1);
  net.onLine = true; win.dispatchEvent(new Event("online")); await settle();
  expect(signals).toHaveLength(2);
  setAppForeground(false); win.dispatchEvent(new Event("bridge:mobile-resume"));
  expect(signals).toHaveLength(2);
  setAppForeground(true); await settle();
  expect(signals).toHaveLength(3);
  win.dispatchEvent(new Event("bridge:mobile-connection"));
  win.dispatchEvent(new Event("bridge:mobile-resume")); await settle();
  expect(signals).toHaveLength(3);
});
it("aborts a stale read and does not let an abort-ignoring read block or schedule over the resumed read", async () => {
  const calls: Array<{ signal: AbortSignal; resolve: () => void }> = [];
  stop = startForegroundPolling((signal) => new Promise<void>((resolve) => { calls.push({ signal, resolve }); }), 10_000);
  win.dispatchEvent(new Event("bridge:mobile-resume")); expect(calls).toHaveLength(1);
  setAppForeground(false); expect(calls[0]!.signal.aborted).toBe(true);
  setAppForeground(true); expect(calls).toHaveLength(2);
  calls[0]!.resolve(); await settle();
  win.dispatchEvent(new Event("online")); expect(calls).toHaveLength(2);
  stop(); expect(calls[1]!.signal.aborted).toBe(true);
  calls[1]!.resolve(); await settle();
});
