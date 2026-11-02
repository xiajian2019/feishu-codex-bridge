import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { StateDatabase } from "../src/db.js";

const plugin = process.env.BRIDGE_TMUX_TEST_PLUGIN || join(homedir(), ".tmux", "plugins", "tmux-resurrect");
const tmux = Bun.which("tmux");
const installed = Boolean(tmux && existsSync(join(plugin, "scripts", "save.sh")) && existsSync(join(plugin, "scripts", "restore.sh")));

describe.skipIf(!installed)("offline Bridge SSH Session CLI with isolated tmux", () => {
  it("shares Web snapshots and database while preserving another Session and global tmux options", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-ssh-offline-test-"));
    const home = join(directory, "home"); const bin = join(directory, "bin"); const repository = join(directory, "repo");
    mkdirSync(home); mkdirSync(bin); mkdirSync(repository);
    const socket = join(directory, "tmux.sock");
    const wrapper = join(bin, "tmux");
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = -S ]; then shift 2; fi\nexec "${tmux}" -S "${socket}" "$@"\n`);
    chmodSync(wrapper, 0o700);
    const dataDirectory = join(directory, "snapshot dir");
    const config = join(directory, "tmux.conf");
    writeFileSync(config, `set -g @resurrect-dir '${dataDirectory}'\n`);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
    Object.assign(env, { HOME: home, PATH: `${bin}${delimiter}${env.PATH || ""}`, TMUX_RESURRECT_PLUGIN_DIR: plugin,
      TMUX_CONFIG_PATH: config, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share") });
    delete env.TMUX; delete env.TMUX_PANE;
    const runTmux = (...args: string[]) => execFileSync(wrapper, args, { env, encoding: "utf8" });
    const runGit = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { env, stdio: "ignore" });
    const dbPath = join(directory, "bridge.db");
    try {
      runGit("init", "-q"); runGit("config", "user.name", "Fixture"); runGit("config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repository, "file.txt"), "old\n"); runGit("add", "file.txt"); runGit("commit", "-qm", "initial");
      writeFileSync(join(repository, "file.txt"), "new\n");
      runTmux("-f", "/dev/null", "new-session", "-d", "-s", "alpha", "-c", repository);
      runTmux("new-session", "-d", "-s", "0", "-c", repository);
      runTmux("split-window", "-t", "alpha:0", "-c", repository);
      runTmux("select-pane", "-t", "alpha:0.0");
      runTmux("set-option", "-g", "@resurrect-dir", "/fixture/global-option-must-not-change");
      runTmux("set-option", "-g", "@resurrect-capture-pane-contents", "on");
      const [id, createdAt] = runTmux("display-message", "-p", "-t", "alpha:", "#{session_id}__F__#{session_created}").trim().split("__F__");
      const initial = { id: id!, name: "alpha", cwd: realpathSync(repository), createdAt: Number(createdAt), windows: 1, attachedClients: 0 };
      // Initialize in a short-lived process so the parent test runner does not
      // keep the SQLite file open while the CLI checks exclusive offline use.
      const init = Bun.spawn([process.execPath, "-e", `import { StateDatabase } from ${JSON.stringify(resolve("src/db.ts"))};
` +
        `const db = new StateDatabase(process.env.BRIDGE_TEST_DB!); db.recordTmuxSession(JSON.parse(process.env.BRIDGE_TEST_SESSION!)); db.close();`],
        { env: { ...env, BRIDGE_TEST_DB: dbPath, BRIDGE_TEST_SESSION: JSON.stringify(initial) }, stdout: "pipe", stderr: "pipe" });
      const [initErr, initStatus] = await Promise.all([new Response(init.stderr).text(), init.exited]);
      expect({ initStatus, initErr }).toEqual({ initStatus: 0, initErr: "" });
      async function call(action: string, includeIdentity = true, identity = initial) {
        const request = { action, ...(includeIdentity ? { id: identity.id, createdAt: identity.createdAt } : {}) };
        const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
        const child = Bun.spawn([process.execPath, resolve("src/ssh-session-cli.ts"), "--offline", "--db", dbPath,
          "--config", join(directory, "missing-config.json"), "--request", encoded], { env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(0);
        const marker = stdout.split("\n").find((line) => line.startsWith("BRIDGE_SSH_RESULT:"));
        expect(marker).toBeTruthy();
        const result = JSON.parse(marker!.slice("BRIDGE_SSH_RESULT:".length)) as { ok: boolean; result?: Record<string, unknown>; error?: string };
        expect({ error: result.error, stderr }).toEqual({ error: undefined, stderr: "" });
        expect(result.ok).toBe(true);
        return result.result!;
      }
      expect(await call("git_list")).toMatchObject({ root: realpathSync(repository), files: [{ path: "file.txt", status: " M" }] });
      expect(await call("save")).toEqual({ name: "alpha" });
      expect(await call("suspend")).toEqual({ name: "alpha" });
      expect(runTmux("list-sessions", "-F", "#{session_name}").trim()).toBe("0");
      expect((await call("list_suspended", false)).sessions).toEqual([{ id: initial.id, name: "alpha", cwd: initial.cwd, createdAt: initial.createdAt }]);
      expect(await call("restore")).toEqual({ name: "alpha" });
      expect(new Set(runTmux("list-sessions", "-F", "#{session_name}").trim().split("\n"))).toEqual(new Set(["0", "alpha"]));
      expect(runTmux("show-option", "-gqv", "@resurrect-dir").trim()).toBe("/fixture/global-option-must-not-change");
      expect(runTmux("display-message", "-p", "-t", "alpha:0", "#{pane_index}").trim()).toBe("0");
      const snapshotDirectories = [...new Bun.Glob("bridge-sessions/*/snapshot.txt").scanSync({ cwd: dataDirectory })];
      expect(snapshotDirectories).toHaveLength(1);
      const snapshot = readFileSync(join(dataDirectory, snapshotDirectories[0]!), "utf8");
      expect(snapshot).toContain("pane\talpha\t");
      expect(snapshot).not.toContain("pane\t0\t");
      const [restoredId, restoredCreatedAt] = runTmux("display-message", "-p", "-t", "alpha:", "#{session_id}__F__#{session_created}").trim().split("__F__");
      const restoredIdentity = { ...initial, id: restoredId!, createdAt: Number(restoredCreatedAt) };
      expect(await call("end", true, restoredIdentity)).toEqual({ name: "alpha" });
      runTmux("new-session", "-d", "-s", "alpha", "-c", repository);
      const [newId, newCreatedAt] = runTmux("display-message", "-p", "-t", "alpha:", "#{session_id}__F__#{session_created}").trim().split("__F__");
      const newIdentity = { ...initial, id: newId!, createdAt: Number(newCreatedAt) };
      expect(await call("save", true, newIdentity)).toEqual({ name: "alpha" });
      expect(runTmux("list-sessions", "-F", "#{session_name}")).toContain("0");
      const after = new StateDatabase(dbPath);
      try {
        const records = after.listTmuxSessionsForDashboard();
        const restoredRecord = records.find((item) => item.tmux_session_id === restoredIdentity.id);
        const newRecord = records.find((item) => item.tmux_session_id === newIdentity.id);
        expect(restoredRecord?.tmux_session_id).not.toBe(initial.id);
        expect(restoredRecord?.suspended_at).toBeNull();
        expect(restoredRecord?.ended_at).not.toBeNull();
        expect(newRecord?.suspended_at).toBeNull();
        expect(newRecord?.ended_at).toBeNull();
      } finally { after.close(); }
    } finally {
      try { runTmux("kill-server"); } catch { /* It may already have stopped. */ }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);
});
