import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  executeBridgeSshSessionRequest,
  type BridgeSshBackend,
} from "../src/ssh-session-cli.js";
import { parseCodexHomeEnvironment } from "../src/tmux-dashboard.js";

type Call = { method: string; path: string; body?: Record<string, unknown>; createdAt?: number };
const identity = { id: "$7", createdAt: 42 };
const session = { ...identity, name: "alpha", cwd: "/fixture", codexHomeId: "codex-second" };
const git = {
  gitRoot: "/fixture", branch: "feature/example", patchTruncated: false,
  files: [
    { path: "a file.txt", oldPath: null, status: "modified", staged: false, unstaged: true, sizeBytes: 4 },
    { path: "new.txt", oldPath: null, status: "untracked", staged: false, unstaged: true, sizeBytes: 2 },
  ],
  patch: "diff --git a/a file.txt b/a file.txt\n--- a/a file.txt\n+++ b/a file.txt\n@@ -1 +1 @@\n-old\n+new\n" +
    "diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n",
};

function backendFixture(): { backend: BridgeSshBackend; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, backend: { async request(method, path, body, createdAt) {
    calls.push({ method, path, body, createdAt });
    if (path.endsWith("/identity")) return { session };
    if (path.endsWith("/git-changes")) return git;
    if (path.includes("/git-changes/content?")) return { kind: "text", text: "new\n", truncated: false };
    if (path.endsWith("/codex-homes")) return { codexHomes: [
      { id: "codex-second", label: "second", available: true }, { id: "missing", label: "missing", available: false },
    ] };
    if (path === "/api/codex/homes") return { homes: [
      { id: "codex-second", path: "/home/.codex/accounts/second", label: "second", available: true },
      { id: "missing", path: "/missing", label: "missing", available: false },
    ] };
    if (path.endsWith("/codex-account")) return { session: { codexHomeId: body?.homeId } };
    if (path.endsWith("/codex-account/check")) return { status: "matched", home: { id: "codex-second" } };
    if (path.startsWith("/api/codex/usage?")) return { accounts: [{ homeId: "codex-second", quota: {
      planType: "plus", buckets: [{ limitId: "codex", primary: { usedPercent: 16 } }],
    } }] };
    if (path.endsWith("/sessions/suspended")) return { sessions: [{ ...identity, name: "alpha", cwd: "/fixture" }] };
    if (path.endsWith("/resume")) return { session: { id: "$8", name: "alpha" } };
    return {};
  } } };
}

describe("Bridge SSH Session CLI contract", () => {
  it("does not guess a default account when process environment is unavailable", () => {
    expect(parseCodexHomeEnvironment("/usr/bin/codex", "/fixture/home")).toBeUndefined();
    expect(parseCodexHomeEnvironment("/usr/bin/codex HOME=/fixture/home PATH=/usr/bin", "/fixture/home"))
      .toBe("/fixture/home/.codex");
    expect(parseCodexHomeEnvironment("codex HOME=/fixture/home CODEX_HOME=/fixture/account with spaces PATH=/usr/bin", "/fixture/home"))
      .toBe("/fixture/account with spaces");
    expect(parseCodexHomeEnvironment("codex HOME=/fixture/home CODEX_HOME= PATH=/usr/bin", "/fixture/home")).toBeUndefined();
  });

  it("maps the shared Git inspection into the native file list and per-file Diff", async () => {
    const { backend, calls } = backendFixture();
    const list = await executeBridgeSshSessionRequest({ action: "git_list", ...identity }, backend);
    expect(list).toMatchObject({ root: "/fixture", branch: "feature/example", files: [
      { path: "a file.txt", status: " M", size: 4 }, { path: "new.txt", status: "??", size: 2 },
    ] });
    const diff = await executeBridgeSshSessionRequest({ action: "git_diff", ...identity, root: "/fixture", path: "a file.txt" }, backend);
    expect(diff.text).toContain("+new");
    expect(diff.text).not.toContain("+hi");
    const preview = await executeBridgeSshSessionRequest({ action: "git_preview", ...identity, root: "/fixture", path: "a file.txt" }, backend);
    expect(preview).toEqual({ text: "new\n", truncated: false });
    expect(calls.every((call) => call.createdAt === 42)).toBe(true);
    await expect(executeBridgeSshSessionRequest({ action: "git_diff", ...identity, root: "/other", path: "a file.txt" }, backend)).rejects.toThrow("仓库已变化");
    await expect(executeBridgeSshSessionRequest({ action: "git_preview", ...identity, root: "/fixture", path: "../secret" }, backend)).rejects.toThrow("不在当前变更列表");
  });

  it("uses the Web account ID and its official usage response", async () => {
    const { backend, calls } = backendFixture();
    expect(await executeBridgeSshSessionRequest({ action: "accounts", ...identity }, backend)).toEqual({
      homes: [{ id: "codex-second", path: "/home/.codex/accounts/second", label: "second" }], selected: "codex-second",
    });
    expect(await executeBridgeSshSessionRequest({ action: "mark_account", ...identity, home: "codex-second" }, backend)).toEqual({ selected: "codex-second" });
    expect(await executeBridgeSshSessionRequest({ action: "refresh_account", ...identity }, backend)).toEqual({ selected: "codex-second" });
    expect(await executeBridgeSshSessionRequest({ action: "usage", ...identity, home: "codex-second" }, backend)).toMatchObject({
      rateLimitsByLimitId: { codex: { planType: "plus", primary: { usedPercent: 16 } } },
    });
    expect(calls.find((call) => call.path.endsWith("/codex-account"))?.body).toEqual({ homeId: "codex-second" });
    await expect(executeBridgeSshSessionRequest({ action: "usage", ...identity, home: "different" }, backend)).rejects.toThrow("账号标记已变化");
  });

  it("forwards Session identity to every lifecycle action and resumes by the stored ID", async () => {
    const { backend, calls } = backendFixture();
    for (const action of ["save", "suspend", "end"]) {
      expect(await executeBridgeSshSessionRequest({ action, ...identity }, backend)).toEqual({ name: "alpha" });
    }
    expect(await executeBridgeSshSessionRequest({ action: "restore", ...identity }, backend)).toEqual({ name: "alpha" });
    expect(calls.filter((call) => call.method !== "GET").map((call) => [call.path, call.createdAt])).toEqual([
      ["/tmux-dashboard/api/sessions/%247/resurrect/save", 42],
      ["/tmux-dashboard/api/sessions/%247/suspend", 42],
      ["/tmux-dashboard/api/sessions/%247", 42],
      ["/tmux-dashboard/api/sessions/%247/resume", 42],
    ]);
    await expect(executeBridgeSshSessionRequest({ action: "restore", id: "$7", createdAt: 99 }, backend)).rejects.toThrow("挂起的 Session 已变化");
    await expect(executeBridgeSshSessionRequest({ action: "end", id: "name;kill", createdAt: 42 }, backend)).rejects.toThrow("Session 标识无效");
  });

  it("reads and marks accounts through tmux and Codex without a Bridge database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-ssh-codex-fallback-"));
    const home = join(directory, "codex-home");
    const fakeCodex = join(directory, "fake-codex");
    const bin = join(directory, "bin");
    const marker = join(directory, "tmux-home");
    mkdirSync(home);
    mkdirSync(bin);
    const fakeTmux = join(bin, "tmux");
    writeFileSync(fakeTmux, `#!/bin/sh
case "$1" in
  list-sessions) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' '$7' alpha 1 0 "$HOME" 42 ;;
  display-message) printf '999998\\n' ;;
  show-environment) if [ -f "$BRIDGE_TEST_MARKER" ]; then printf 'CODEX_HOME=%s\\n' "$(cat "$BRIDGE_TEST_MARKER")"; else echo 'unknown variable: CODEX_HOME' >&2; exit 1; fi ;;
  set-environment) printf '%s' "$5" > "$BRIDGE_TEST_MARKER" ;;
  *) exit 1 ;;
esac
`);
    chmodSync(fakeTmux, 0o700);
    const fakePs = join(bin, "ps");
    writeFileSync(fakePs, `#!/bin/sh
case "$*" in
  '-axo pid=,ppid=') printf '999998 1\\n999999 999998\\n' ;;
  '-ww -p 999999 -o command=') printf '/usr/bin/codex\\n' ;;
  '-ww -p 999998 -o command=') printf 'zsh\\n' ;;
  'eww -p 999999 -o command=') printf 'codex HOME=%s CODEX_HOME=%s PATH=/usr/bin\\n' "$HOME" "$CODEX_HOME" ;;
  *) exit 1 ;;
esac
`);
    chmodSync(fakePs, 0o700);
    writeFileSync(fakeCodex, `#!/usr/bin/env node
const readline = require("node:readline");
const output = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") output({ id: request.id, result: {} });
  else if (request.method === "account/rateLimits/read") output({ id: request.id, result: { rateLimitsByLimitId: { codex: { limitId: "codex", planType: "plus", primary: { usedPercent: 16 } } } } });
  else if (request.method === "account/usage/read") output({ id: request.id, result: { summary: { lifetimeTokens: 123 }, dailyUsageBuckets: [{ startDate: "2026-11-02", tokens: 123 }] } });
});
`);
    chmodSync(fakeCodex, 0o700);
    const dbPath = join(directory, "does-not-exist.db");
    const env = { ...process.env, HOME: directory, CODEX_PATH: fakeCodex, CODEX_HOME: home,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, BRIDGE_TEST_MARKER: marker };
    async function call(request: Record<string, unknown>) {
      const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
      const child = Bun.spawn([process.execPath, resolve("src/ssh-session-cli.ts"), "--offline", "--db", dbPath,
        "--config", join(directory, "missing-config.json"), "--request", encoded], { env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("BRIDGE_SSH_RESULT:"));
      expect(line).toBeTruthy();
      return JSON.parse(line!.slice("BRIDGE_SSH_RESULT:".length)) as { ok: boolean; result?: Record<string, unknown>; error?: string };
    }
    try {
      const accounts = await call({ action: "accounts", ...identity });
      expect(accounts.ok).toBe(true);
      expect(accounts.result?.homes).toHaveLength(1);
      expect(accounts.result?.selected).toBe("");
      const homeId = (accounts.result!.homes as Array<{ id: string }>)[0]!.id;
      expect(await call({ action: "refresh_account", ...identity })).toMatchObject({ ok: true, result: { selected: homeId, source: "ssh-fallback" } });
      expect(await call({ action: "mark_account", ...identity, home: homeId })).toMatchObject({ ok: true, result: { selected: homeId, source: "ssh-fallback" } });
      const usage = await call({ action: "usage", ...identity, home: homeId });
      expect(usage).toMatchObject({ ok: true, result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 16 } } } } });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
