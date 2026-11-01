import { expect, test } from "bun:test";

test("Android offline Composer defaults match the Web shortcut catalog and terminal bytes", () => {
  const result = Bun.spawnSync(["bun", "scripts/generate-native-composer-defaults.ts", "--check"], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
