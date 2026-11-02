import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("SSH CLI local fallback", () => {
  it("uses the local implementation when the App cannot reach Bridge API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-ssh-fallback-test-"));
    const dbPath = join(directory, "bridge.db");
    try {
      const init = Bun.spawn([process.execPath, "-e",
        `import { StateDatabase } from ${JSON.stringify(resolve("src/db.ts"))}; const db = new StateDatabase(${JSON.stringify(dbPath)}); db.close();`],
        { stdout: "pipe", stderr: "pipe" });
      const [initStatus, initStderr] = await Promise.all([init.exited, new Response(init.stderr).text()]);
      expect({ initStatus, initStderr }).toEqual({ initStatus: 0, initStderr: "" });
      const encoded = Buffer.from(JSON.stringify({ action: "list_suspended" })).toString("base64");
      const child = Bun.spawn([process.execPath, resolve("src/ssh-session-cli.ts"), "--db", dbPath, "--port", "1", "--request", encoded], {
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(status).toBe(0);
      expect(stderr).toBe("");
      const marker = stdout.split("\n").find((line) => line.startsWith("BRIDGE_SSH_RESULT:"));
      expect(marker).toBeTruthy();
      expect(JSON.parse(marker!.slice("BRIDGE_SSH_RESULT:".length))).toMatchObject({ ok: true, result: { sessions: [] } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
