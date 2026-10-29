import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createMobileConnectionSwitch } from "../web/src/mobile-connection-switch.js";

it("holds the write barrier while a Request body is being prepared and releases it after failures", async () => {
  const guard = createMobileConnectionSwitch();
  const release = guard.beforeRequest("POST");
  await expect(guard.run(async () => true, () => true)).rejects.toThrow("请求正在提交");
  release(); release();
  await expect(guard.run(async () => { throw new Error("offline"); }, () => true)).rejects.toThrow("offline");
  expect(() => guard.beforeRequest("POST")()).not.toThrow();
  await guard.run(async () => false, () => false);
  expect(() => guard.beforeRequest("POST")()).not.toThrow();
});

it("does not leave the barrier locked when persistence fails before committing", async () => {
  const guard = createMobileConnectionSwitch();
  await expect(guard.run(async () => true, () => { throw new Error("storage denied"); })).rejects.toThrow("storage denied");
  expect(() => guard.beforeRequest("PUT")()).not.toThrow();
});

const fixture = fileURLToPath(new URL("./fixtures/mobile-connection-runtime.ts", import.meta.url));
for (const scenario of ["success", "offline", "unauthorized", "incompatible", "write-active"] as const) {
  it(`real App transport isolates environment switching: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, fixture, scenario], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 8_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally { clearTimeout(timer); }
  }, 10_000);
}
