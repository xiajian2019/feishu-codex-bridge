import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { StateDatabase } from "../src/db.js";

const plugin = process.env.BRIDGE_TMUX_TEST_PLUGIN || join(homedir(), ".tmux", "plugins", "tmux-resurrect");
const tmux = Bun.which("tmux");
const installed = Boolean(tmux && existsSync(join(plugin, "scripts", "save.sh")) && existsSync(join(plugin, "scripts", "restore.sh")));

describe.skipIf(!installed)("offline Bridge SSH Session CLI with isolated tmux", () => {
  it("uses isolated snapshot files without opening the occupied Bridge database", async () => {
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
    let heldDb: StateDatabase | undefined;
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
      heldDb = new StateDatabase(dbPath);
      heldDb.recordTmuxSession(initial);
      const original = heldDb.listTmuxSessionsForDashboard();
      const webSnapshotDirectory = join(dataDirectory, "bridge-sessions", createHash("sha256").update("alpha").digest("hex").slice(0, 32));
      mkdirSync(webSnapshotDirectory, { recursive: true });
      writeFileSync(join(webSnapshotDirectory, "snapshot.txt"), "web snapshot must be preserved\n");
      async function call(action: string, includeIdentity = true, identity = initial, cwd?: string) {
        const request = { action, ...(includeIdentity ? { id: identity.id, createdAt: identity.createdAt } : {}), ...(cwd ? { cwd } : {}) };
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
      expect(await call("save")).toEqual({ name: "alpha", source: "ssh-fallback" });
      expect(await call("suspend")).toEqual({ name: "alpha", source: "ssh-fallback" });
      expect(runTmux("list-sessions", "-F", "#{session_name}").trim()).toBe("0");
      expect((await call("list_suspended", false)).sessions).toMatchObject([{ id: initial.id, name: "alpha", cwd: initial.cwd, createdAt: initial.createdAt, source: "ssh-fallback" }]);
      expect(await call("restore")).toEqual({ name: "alpha", source: "ssh-fallback" });
      expect(new Set(runTmux("list-sessions", "-F", "#{session_name}").trim().split("\n"))).toEqual(new Set(["0", "alpha"]));
      expect(runTmux("show-option", "-gqv", "@resurrect-dir").trim()).toBe("/fixture/global-option-must-not-change");
      expect(runTmux("display-message", "-p", "-t", "alpha:0", "#{pane_index}").trim()).toBe("0");
      const snapshotDirectories = [...new Bun.Glob("bridge-ssh-fallback/bridge-sessions/*/snapshot.txt").scanSync({ cwd: dataDirectory })];
      expect(snapshotDirectories).toHaveLength(1);
      const snapshot = readFileSync(join(dataDirectory, snapshotDirectories[0]!), "utf8");
      expect(snapshot).toContain("pane\talpha\t");
      expect(snapshot).not.toContain("pane\t0\t");
      const [restoredId, restoredCreatedAt] = runTmux("display-message", "-p", "-t", "alpha:", "#{session_id}__F__#{session_created}").trim().split("__F__");
      const restoredIdentity = { ...initial, id: restoredId!, createdAt: Number(restoredCreatedAt) };
      expect(await call("end", true, restoredIdentity)).toEqual({ name: "alpha", source: "ssh-fallback" });
      runTmux("new-session", "-d", "-s", "alpha", "-c", repository);
      const [newId, newCreatedAt] = runTmux("display-message", "-p", "-t", "alpha:", "#{session_id}__F__#{session_created}").trim().split("__F__");
      const newIdentity = { ...initial, id: newId!, createdAt: Number(newCreatedAt) };
      expect(await call("save", true, newIdentity)).toEqual({ name: "alpha", source: "ssh-fallback" });
      expect(runTmux("list-sessions", "-F", "#{session_name}")).toContain("0");
      expect(heldDb.listTmuxSessionsForDashboard()).toEqual(original);
      expect(readFileSync(join(webSnapshotDirectory, "snapshot.txt"), "utf8")).toBe("web snapshot must be preserved\n");

      // Suspension of the final Session stops its tmux server; the fallback
      // must still discover and restore its own snapshot after that happens.
      runTmux("kill-server");
      runTmux("-f", "/dev/null", "new-session", "-d", "-s", "solo", "-c", repository);
      const [soloId, soloCreatedAt] = runTmux("display-message", "-p", "-t", "solo:", "#{session_id}__F__#{session_created}").trim().split("__F__");
      const solo = { ...initial, id: soloId!, name: "solo", createdAt: Number(soloCreatedAt) };
      expect(await call("suspend", true, solo)).toEqual({ name: "solo", source: "ssh-fallback" });
      expect((await call("list_suspended", false)).sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: solo.id, createdAt: solo.createdAt, name: "solo" }),
      ]));
      expect(await call("restore", true, solo)).toEqual({ name: "solo", source: "ssh-fallback" });
      expect(runTmux("list-sessions", "-F", "#{session_name}").trim()).toBe("solo");
      expect(heldDb.listTmuxSessionsForDashboard()).toEqual(original);

      // Once Bridge is reachable, its real API adapter can expose the
      // fallback snapshot and rebind the original history record on restore.
      runTmux("new-session", "-d", "-s", "api-recover", "-c", repository);
      const [apiId, apiCreatedAt] = runTmux("display-message", "-p", "-t", "api-recover:", "#{session_id}__F__#{session_created}").trim().split("__F__");
      const apiSession = { ...initial, id: apiId!, name: "api-recover", createdAt: Number(apiCreatedAt) };
      const apiRecord = heldDb.recordTmuxSession(apiSession);
      const logicalCwd = join(directory, "logical-worktree");
      mkdirSync(logicalCwd);
      heldDb.setTmuxSessionWorkingDirectory(apiRecord.record_id, repository, realpathSync(logicalCwd));
      expect(await call("suspend", true, apiSession, realpathSync(logicalCwd))).toEqual({ name: "api-recover", source: "ssh-fallback" });
      expect(heldDb.getTmuxSession(apiRecord.record_id)?.suspended_at).toBeNull();
      const apiScript = `import { Readable } from "node:stream";
import { StateDatabase } from ${JSON.stringify(resolve("src/db.ts"))};
import { TmuxDashboardApi } from ${JSON.stringify(resolve("src/tmux-dashboard-api.ts"))};
const db = new StateDatabase(process.env.BRIDGE_TEST_DB!);
const api = new TmuxDashboardApi({ db });
const call = async (method, url) => {
  const request = Readable.from([]); request.method = method; request.url = url;
  request.headers = { "x-bridge-session-created-at": process.env.BRIDGE_TEST_CREATED! };
  const response = { statusCode: 0, body: "", setHeader() {}, end(value = "") { this.body = value; } };
  await api.handleRequest(request, response); return { status: response.statusCode, data: response.body ? JSON.parse(response.body) : {} };
};
try {
  const list = await call("GET", "/tmux-dashboard/api/sessions?includeHomes=0");
  const result = await call("POST", "/tmux-dashboard/api/sessions/" + encodeURIComponent(process.env.BRIDGE_TEST_ID!) + "/resume?source=ssh-fallback");
  console.log(JSON.stringify({ list, result }));
} finally { await api.stop(); db.close(); }`;
      const apiProcess = Bun.spawn([process.execPath, "-e", apiScript], { env: { ...env, BRIDGE_TEST_DB: dbPath,
        BRIDGE_TEST_ID: apiSession.id, BRIDGE_TEST_CREATED: String(apiSession.createdAt) }, stdout: "pipe", stderr: "pipe" });
      const [apiOutput, apiError, apiStatus] = await Promise.all([new Response(apiProcess.stdout).text(), new Response(apiProcess.stderr).text(), apiProcess.exited]);
      expect({ apiStatus, apiError }).toEqual({ apiStatus: 0, apiError: "" });
      const apiResult = JSON.parse(apiOutput);
      expect(apiResult.list.data.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ name: "api-recover", source: "ssh-fallback", cwd: realpathSync(logicalCwd) })]));
      expect(apiResult.result).toMatchObject({ status: 200, data: { session: { name: "api-recover" } } });
      expect(heldDb.getTmuxSession(apiRecord.record_id)).toMatchObject({
        tmux_session_id: apiResult.result.data.session.id, suspended_at: null, ended_at: null, working_directory: realpathSync(logicalCwd),
      });
      expect(realpathSync(runTmux("display-message", "-p", "-t", "api-recover:", "#{pane_current_path}").trim())).toBe(realpathSync(repository));
      expect(readFileSync(join(webSnapshotDirectory, "snapshot.txt"), "utf8")).toBe("web snapshot must be preserved\n");
    } finally {
      heldDb?.close();
      try { runTmux("kill-server"); } catch { /* It may already have stopped. */ }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);
});
