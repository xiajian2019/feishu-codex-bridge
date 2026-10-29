import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL("./fixtures/mobile-notification-runtime.ts", import.meta.url));
for (const scenario of ["permission", "dedupe", "filter", "scope", "server", "revoked"]) {
  it(`isolates device-local native notification behavior: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, fixture, scenario], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 8000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally { clearTimeout(timeout); }
  }, 10_000);
}
