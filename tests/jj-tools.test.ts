import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { buildJjArgs, JjToolsService } from "../src/jj-tools.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("JJ fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-jj-"));
  const executable = join(root, "jj");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const args = process.argv.slice(2);
console.log("TTY=" + Boolean(process.stdout.isTTY));
console.log("ARGS=" + JSON.stringify(args));
if (args[1] === "interactive") {
  process.stdin.setRawMode(true);
  console.log("请选择 Pod");
  process.stdin.once("data", (data) => { console.log("INPUT=" + data.toString()); process.exit(0); });
} else if (args[1] === "watch") {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  console.log("CHILD=" + child.pid);
  setInterval(() => {}, 1000);
} else if (args[1] === "unicode") {
  const bytes = Buffer.from("中文终端输出");
  process.stdout.write(bytes.subarray(0, 2));
  setTimeout(() => { process.stdout.write(bytes.subarray(2)); console.log(" FINAL"); process.exit(0); }, 30);
}
`, { mode: 0o755 });
  const tools = new JjToolsService({ executable });
  cleanups.push(async () => { await tools.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, tools };
}

function start(tools: JjToolsService, job: string, extra: Record<string, unknown> = {}) {
  return tools.start({ action: "run", job, requestId: crypto.randomUUID(), ...extra });
}

describe("JJ command execution", () => {
  it("assembles only supported JJ operations and preserves parameter values as single arguments", () => {
    expect(buildJjArgs({ action: "run", name: "prod", job: "folder/app", interactive: true, parameters: "BRANCH=release/test\nNOTE=$(whoami); echo hello" }))
      .toEqual(["run", "folder/app", "-n", "prod", "-v", "-i", "-a", "BRANCH=release/test", "-a", "NOTE=$(whoami); echo hello"]);
    expect(buildJjArgs({ action: "pods", app: "food", namespace: "app-prod", logs: true, watch: true }))
      .toEqual(["k8s", "pods", "food", "-n", "app-prod", "-l", "--no-follow"]);
    expect(buildJjArgs({ action: "builds", job: "app", buildNumber: "42" })).toEqual(["builds", "app", "42", "-v"]);
    for (const input of [
      { action: "use", name: "prod" }, { action: "restart" }, { action: "run", job: "--help" },
      { action: "run", job: "app,other" }, { action: "run", job: "app", parameters: "INVALID" },
      { action: "pods", app: "-e" }, { action: "pods", namespace: "prod --context=other" },
      { action: "builds", job: "app", name: "prod" }, { action: "builds", job: "app", buildNumber: "-1" },
    ]) expect(() => buildJjArgs(input)).toThrow();
  });

  it("runs a real Bun PTY, keeps complete UTF-8 output and reuses repeated request IDs", async () => {
    const { tools } = await fixture();
    const requestId = crypto.randomUUID();
    const input = { action: "run", job: "unicode", requestId, parameters: "NOTE=$(whoami); echo hello" };
    const run = tools.start(input);
    expect(tools.start(input).id).toBe(run.id);
    expect(() => tools.start({ ...input, job: "another" })).toThrow("此请求已用于其他命令");
    await until(() => tools.read(run.id).state === "exited");
    const result = tools.read(run.id);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("TTY=true");
    expect(result.output).toContain("NOTE=$(whoami); echo hello");
    expect(result.output).toContain("中文终端输出 FINAL");
    expect(result.output).not.toContain("�");
    expect(tools.read(run.id, result.offset).output).toBe("");
    expect(tools.list().runs).toHaveLength(1);
  });

  it("accepts terminal input and resize without restarting an interactive JJ command", async () => {
    const { tools } = await fixture();
    const run = start(tools, "interactive");
    await until(() => tools.read(run.id).output.includes("请选择 Pod"));
    const before = tools.read(run.id);
    tools.resize(run.id, { cols: 72, rows: 18 });
    tools.input(run.id, { data: "2\r" });
    await until(() => tools.read(run.id).state === "exited");
    expect(tools.read(run.id, before.offset).output).toContain("INPUT=2");
    expect(() => tools.input(run.id, { data: "again" })).toThrow("已结束");
  });

  it("stops the JJ process group including its child and cleans up on service shutdown", async () => {
    const { tools } = await fixture();
    const run = start(tools, "watch");
    await until(() => tools.read(run.id).output.includes("CHILD="));
    const childPid = Number(/CHILD=(\d+)/.exec(tools.read(run.id).output)![1]);
    try {
      tools.stop(run.id);
      await until(() => tools.read(run.id).exitCode !== null);
      await until(() => {
        try { process.kill(childPid, 0); return false; } catch { return true; }
      });
      expect(tools.read(run.id).state).toBe("stopped");
      const second = start(tools, "interactive");
      await until(() => tools.read(second.id).output.includes("请选择 Pod"));
      await tools.dispose();
      expect(tools.list().runs).toEqual([]);
    } finally {
      try { process.kill(childPid, "SIGKILL"); } catch { /* Already terminated. */ }
    }
  });
});

describe("JJ Web endpoints", () => {
  it("protects commands and terminal input and serves refreshable page links", async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, "index.html"), "<!doctype html><html><head><title>JJ fixture</title></head><body><div id=\"root\"></div></body></html>");
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db, allowLocalRequests: false });
    const server = new DashboardServer({ db, auth, jjTools: tools, host: "127.0.0.1", port: 0, modes: [], webRoot: root, cleanupExpiredStagedAttachments: false });
    cleanups.push(async () => { await server.stop(); db.close(); });
    const url = await server.start();
    const runId = crypto.randomUUID();
    const paths = ["/api/jj/runs", `/api/jj/runs/${runId}/input`, `/api/jj/runs/${runId}/resize`, `/api/jj/runs/${runId}/stop`];
    expect((await fetch(url + "/api/jj")).status).toBe(401);
    expect((await fetch(url + "/system-management/jj")).status).toBe(401);
    for (const path of paths) expect((await fetch(url + path, { method: "POST", body: "{}" })).status).toBe(401);
    expect(tools.list().runs).toEqual([]);
    const pairing = auth.startPairing();
    const paired = await fetch(url + "/api/auth/pairing/claim", { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code }) });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const { actionToken } = await (await fetch(url + "/api/session", { headers: { Cookie: cookie } })).json() as { actionToken: string };
    const headers = { Cookie: cookie, Origin: url, "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken };
    for (const path of paths) {
      expect((await fetch(url + path, { method: "POST", headers: { Cookie: cookie }, body: "{}" })).status).toBe(403);
      expect((await fetch(url + path, { method: "POST", headers: { ...headers, Origin: "https://foreign.example" }, body: "{}" })).status).toBe(403);
    }
    expect(tools.list().runs).toEqual([]);
    expect((await fetch(url + "/system-management/jj", { headers: { Cookie: cookie } })).status).toBe(200);
    const input = { action: "run", job: "interactive", requestId: runId };
    const execute = async () => fetch(url + "/api/jj/runs", { method: "POST", headers, body: JSON.stringify(input) });
    expect((await execute()).status).toBe(200);
    expect((await execute()).status).toBe(200);
    expect(tools.list().runs).toHaveLength(1);
    await until(() => tools.read(runId).output.includes("请选择 Pod"));
    const output = await fetch(url + `/api/jj/runs/${runId}`, { headers: { Cookie: cookie } });
    expect(output.headers.get("cache-control")).toBe("no-store");
    expect((await output.json() as { output: string }).output).toContain("请选择 Pod");
    expect((await fetch(url + `/api/jj/runs/${runId}/input`, { method: "POST", headers, body: JSON.stringify({ data: "yes\r" }) })).status).toBe(200);
    await until(() => tools.read(runId).state === "exited");
    expect(tools.read(runId).output).toContain("INPUT=yes");
    auth.revokeAll();
    expect((await fetch(url + `/api/jj/runs/${runId}`, { headers: { Cookie: cookie } })).status).toBe(401);
  });
});
