import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeBridgeSshSessionRequest,
  ReadOnlyCodexBridgeSshBackend,
  type BridgeSshBackend,
  type BridgeSshCliOptions,
} from "../src/ssh-session-cli.js";
import { StateDatabase } from "../src/db.js";
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

  it("falls back to read-only Codex app-server queries while the Bridge database is open", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-ssh-codex-fallback-"));
    const home = join(directory, "codex-home");
    const fakeCodex = join(directory, "fake-codex");
    mkdirSync(home);
    writeFileSync(join(home, "state_1.sqlite"), "");
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
    const dbPath = join(directory, "bridge.db");
    const db = new StateDatabase(dbPath);
    db.recordTmuxSession({ id: "$7", name: "alpha", cwd: directory, createdAt: 42, windows: 1, attachedClients: 0 });
    const previousCodexPath = process.env.CODEX_PATH;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_PATH = fakeCodex;
    process.env.CODEX_HOME = home;
    const options: BridgeSshCliOptions = {
      request: { action: "accounts", id: "$7", createdAt: 42 },
      databasePath: dbPath,
      configPath: join(directory, "missing-config.json"),
      ports: [],
      offline: false,
    };
    const backend = new ReadOnlyCodexBridgeSshBackend(options);
    try {
      const accounts = await executeBridgeSshSessionRequest(options.request, backend);
      expect(accounts.homes).toHaveLength(1);
      const homeId = (accounts.homes as Array<{ id: string }>)[0]!.id;
      db.setTmuxSessionCodexHome("$7", homeId);
      const usage = await executeBridgeSshSessionRequest({ action: "usage", id: "$7", createdAt: 42, home: homeId }, backend);
      expect(usage).toMatchObject({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 16 } } } });
    } finally {
      await backend.close?.();
      db.close();
      if (previousCodexPath === undefined) delete process.env.CODEX_PATH; else process.env.CODEX_PATH = previousCodexPath;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
