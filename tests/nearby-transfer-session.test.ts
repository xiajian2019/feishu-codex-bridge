import { expect, test } from "bun:test";

test("nearby session retries startup, refreshes discovery and tries QR addresses", () => {
  const result = Bun.spawnSync(["bun", "run", "tests/fixtures/nearby-transfer-runtime.ts"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain("nearby session fixture passed");
});
