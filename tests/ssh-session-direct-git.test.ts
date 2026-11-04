import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

describe("database-free SSH Git fallback", () => {
  it("reads Git using the selected Session while the Bridge database is absent or occupied", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-ssh-direct-git-"));
    const bin = join(root, "bin");
    const repository = join(root, "repo");
    const pane = join(root, "pane");
    const dbPath = join(root, "not-created.db");
    mkdirSync(bin); mkdirSync(repository); mkdirSync(pane);
    const wrapper = join(bin, "tmux");
    writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in\n  list-sessions) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' '$7' alpha 1 0 "$BRIDGE_TEST_PANE" 42 ;;\n  display-message) printf '%s\\n' "$BRIDGE_TEST_PANE" ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(wrapper, 0o700);
    const lsof = join(bin, "lsof");
    writeFileSync(lsof, "#!/bin/sh\nexit 99\n");
    chmodSync(lsof, 0o700);
    const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
    try {
      git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repository, "file.txt"), "before\n");
      git("add", "file.txt"); git("commit", "-qm", "initial");
      writeFileSync(join(repository, "file.txt"), "after\n");
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, BRIDGE_TEST_PANE: pane };
      async function call(request: Record<string, unknown>) {
        const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
        const child = Bun.spawn([process.execPath, resolve("src/ssh-session-cli.ts"), "--offline", "--db", dbPath,
          "--config", join(root, "missing-config.json"), "--request", encoded], { env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        const line = stdout.split("\n").find((candidate) => candidate.startsWith("BRIDGE_SSH_RESULT:"));
        expect(line).toBeTruthy();
        return JSON.parse(line!.slice("BRIDGE_SSH_RESULT:".length)) as { ok: boolean; result?: Record<string, unknown>; error?: string };
      }
      const identity = { id: "$7", createdAt: 42, cwd: repository };
      const list = await call({ action: "git_list", ...identity });
      expect(list).toMatchObject({ ok: true, result: { root: realpathSync(repository), files: [{ path: "file.txt", status: " M" }] } });
      const diff = await call({ action: "git_diff", ...identity, root: realpathSync(repository), path: "file.txt" });
      expect(diff.result?.text).toContain("+after");
      const preview = await call({ action: "git_preview", ...identity, root: realpathSync(repository), path: "file.txt" });
      expect(preview.result).toEqual({ text: "after\n", truncated: false });
      expect(await call({ action: "git_list", ...identity, createdAt: 41 })).toMatchObject({ ok: false, error: expect.stringContaining("重建") });
      expect(existsSync(dbPath)).toBe(false);

      // A held, unrelated file at the configured database path must not be
      // inspected, opened or locked by a read-only Git operation either.
      writeFileSync(dbPath, "not a SQLite database");
      const openFile = openSync(dbPath, "r");
      try { expect((await call({ action: "git_list", ...identity })).ok).toBe(true); }
      finally { closeSync(openFile); }
      expect(await Bun.file(dbPath).text()).toBe("not a SQLite database");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
