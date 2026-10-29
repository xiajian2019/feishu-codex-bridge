import { expect, it } from "bun:test";
import { uploadStep } from "../web/src/upload-step.js";

it("times out a stuck request or file read even when it ignores AbortSignal", async () => {
  const started = performance.now();
  await expect(uploadStep(() => new Promise<never>(() => {}), { timeoutMs: 10, message: "fixture timeout" })).rejects.toThrow("fixture timeout");
  expect(performance.now() - started).toBeLessThan(500);
});
it("cancels a pending step and prevents a pre-cancelled step from starting", async () => {
  const controller = new AbortController();
  const pending = uploadStep(() => new Promise<never>(() => {}), { signal: controller.signal, timeoutMs: 5_000, message: "timeout" });
  controller.abort(new Error("cancel fixture"));
  await expect(pending).rejects.toThrow("cancel fixture");
  let started = false;
  await expect(uploadStep(async () => { started = true; return true; }, { signal: controller.signal, timeoutMs: 10, message: "timeout" })).rejects.toThrow("cancel fixture");
  expect(started).toBe(false);
});
