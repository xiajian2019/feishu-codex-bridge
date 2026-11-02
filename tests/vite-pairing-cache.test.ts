import { expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `
  import { createServer, loadConfigFromFile } from "vite";
  const mode = process.env.BRIDGE_TEST_MODE;
  const loaded = await loadConfigFromFile({ command: "serve", mode }, "web/vite.config.ts");
  if (!loaded) throw new Error("Vite config did not load");
  const config = loaded.config;
  // Simulate another Vite process that optimizes a different dependency set.
  if (mode === "pairing-second") config.optimizeDeps = { force: true, noDiscovery: true, include: ["react"] };
  const server = await createServer({ ...config, configFile: false, mode,
    logLevel: "silent", server: { ...config.server, host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  console.log("FIXTURE_READY " + server.httpServer.address().port);
  process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
`;

async function startVite(directory: string, mode: string): Promise<{ process: ChildProcess; base: string }> {
  const child = spawn(process.execPath, ["--eval", script], {
    cwd: root, detached: true, env: { ...process.env, TMPDIR: directory, BRIDGE_TEST_MODE: mode, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr!.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const match = /FIXTURE_READY (\d+)/.exec(output);
      if (match) return { process: child, base: `http://127.0.0.1:${match[1]}` };
      if (child.exitCode !== null) throw new Error(`Vite exited: ${output}`);
      await Bun.sleep(50);
    }
    throw new Error(`Vite did not start: ${output}`);
  } catch (error) {
    await stopVite(child);
    throw error;
  }
}

async function stopVite(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, "exit");
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  const graceful = await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
  if (!graceful) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
    await exited;
  }
}

async function dependencyUrl(base: string, source: string, name: string): Promise<string> {
  const response = await fetch(`${base}/src/${source}`);
  expect(response.status).toBe(200);
  const text = await response.text();
  const match = text.match(new RegExp(`["']([^"']*/${name}\\.js\\?v=[^"']+)["']`));
  if (!match) throw new Error(`No optimized ${name} import in ${source}`);
  return new URL(match[1]!, base).toString();
}

it("keeps both QR decoders available when another Vite process optimizes dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-vite-pairing-"));
  const children: ChildProcess[] = [];
  try {
    const first = await startVite(directory, "pairing-first");
    children.push(first.process);
    const firstUrls = await Promise.all([
      dependencyUrl(first.base, "pairing-qr.ts", "jsqr"),
      dependencyUrl(first.base, "pairing-scanner.ts", "qr-scanner"),
    ]);
    // Leave the lazy QR modules unfetched, as on a device before its first scan.
    // The other process forces a rebuild with a different dependency set.
    // Its optimized files must not share the first server's cache directory.
    const second = await startVite(directory, "pairing-second");
    children.push(second.process);
    const secondUrl = await dependencyUrl(second.base, "main.tsx", "react");
    expect((await fetch(secondUrl)).status).toBe(200);
    const firstCache = new URL(firstUrls[0]!).pathname.replace(/\/deps\/jsqr\.js$/, "");
    const secondCache = new URL(secondUrl).pathname.replace(/\/deps\/react\.js$/, "");
    expect(firstCache).not.toBe(secondCache);
    for (const url of firstUrls) expect((await fetch(url)).status).toBe(200);
  } finally {
    for (const child of children.reverse()) await stopVite(child);
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);
