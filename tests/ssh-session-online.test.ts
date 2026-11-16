import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("SSH CLI local fallback", () => {
  it("lists fallback snapshots without creating or opening a Bridge database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-ssh-fallback-test-"));
    const dbPath = join(directory, "bridge.db");
    try {
      const encoded = Buffer.from(JSON.stringify({ action: "list_suspended" })).toString("base64");
      const child = Bun.spawn([process.execPath, resolve("src/ssh-session-cli.ts"), "--db", dbPath, "--port", "1", "--request", encoded], {
        env: { ...process.env, HOME: directory, TMUX_CONFIG_PATH: join(directory, "missing-tmux.conf"),
          XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data") }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(status).toBe(0);
      expect(stderr).toBe("");
      const marker = stdout.split("\n").find((line) => line.startsWith("BRIDGE_SSH_RESULT:"));
      expect(marker).toBeTruthy();
      expect(JSON.parse(marker!.slice("BRIDGE_SSH_RESULT:".length))).toMatchObject({ ok: true, result: { sessions: [] } });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
