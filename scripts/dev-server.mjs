import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_HASH = createHash("sha1").update(PROJECT_ROOT).digest("hex").slice(0, 10);
const STATE_DIRECTORY = join(tmpdir(), `feishu-codex-bridge-dev-${PROJECT_HASH}`);
const PRODUCTION_DB = join(PROJECT_ROOT, "runtime", "bridge.db");
const STARTUP_TIMEOUT_MS = 30_000;

const SERVICES = [
  {
    id: "api",
    name: "Bridge Web API",
    port: 17310,
    probeUrl: "http://127.0.0.1:17310/healthz",
    args: [
      "--watch",
      join(PROJECT_ROOT, "src", "main.ts"),
      "--web-only",
      "--web-port",
      "17310",
      "--config",
      join(PROJECT_ROOT, "config.example.json"),
      "--db",
      PRODUCTION_DB,
    ],
    environment: { FEISHU_CODEX_BRIDGE_LAN_BIND: "1" },
  },
  {
    id: "web",
    name: "Vite",
    port: 5173,
    probeUrl: "http://127.0.0.1:5173/api/auth/status",
    args: ["run", "--bun", "vite", "--config", join(PROJECT_ROOT, "web", "vite.config.ts")],
    environment: { BRIDGE_WEB_API_TARGET: "http://127.0.0.1:17310" },
  },
];

function statePath(serviceId, suffix) {
  return join(STATE_DIRECTORY, `${serviceId}.${suffix}`);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readPid(serviceId) {
  const value = await readFile(statePath(serviceId, "pid"), "utf8").catch(() => "");
  const pid = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function probe(url) {
  return new Promise((resolvePromise) => {
    const request = httpRequest(url, { method: "GET", timeout: 1_000 }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolvePromise(status >= 200 && status < 300);
    });
    request.once("timeout", () => request.destroy(new Error("probe timed out")));
    request.once("error", () => resolvePromise(false));
    request.end();
  });
}

async function waitForReady(service, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(service.probeUrl)) return;
    if (child.exitStatus || child.exitCode !== null || child.signalCode !== null) {
      const { code, signal } = child.exitStatus ?? { code: child.exitCode, signal: child.signalCode };
      throw new Error(`${service.name} exited before becoming ready (code=${code}, signal=${signal}); log: ${statePath(service.id, "log")}`);
    }
    await sleep(250);
  }
  throw new Error(`${service.name} did not become ready within ${STARTUP_TIMEOUT_MS / 1_000}s; log: ${statePath(service.id, "log")}`);
}

async function launch(service) {
  const logFd = openSync(statePath(service.id, "log"), "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, service.args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...service.environment },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    await new Promise((resolvePromise, rejectPromise) => {
      child.once("spawn", resolvePromise);
      child.once("error", rejectPromise);
    });
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error(`Could not start ${service.name}.`);
  child.exitStatus = null;
  child.once("exit", (code, signal) => {
    child.exitStatus = { code, signal };
  });
  child.unref();
  await writeFile(statePath(service.id, "pid"), `${child.pid}\n`, { mode: 0o600 });
  return child;
}

async function stopService(service) {
  const pid = await readPid(service.id);
  if (!pid) {
    console.log(`${service.name}: no managed process`);
    return;
  }
  if (!processGroupExists(pid)) {
    await rm(statePath(service.id, "pid"), { force: true });
    console.log(`${service.name}: stale PID removed`);
    return;
  }

  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + 8_000;
  while (processGroupExists(pid) && Date.now() < deadline) await sleep(200);
  if (processGroupExists(pid)) {
    process.kill(-pid, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (processGroupExists(pid) && Date.now() < killDeadline) await sleep(100);
  }
  if (processGroupExists(pid)) throw new Error(`${service.name} process group ${pid} did not stop.`);
  await rm(statePath(service.id, "pid"), { force: true });
  console.log(`${service.name}: stopped`);
}

async function startService(service, startedThisRun) {
  const pid = await readPid(service.id);
  if (pid && !processGroupExists(pid)) await rm(statePath(service.id, "pid"), { force: true });
  if (pid && processGroupExists(pid)) {
    if (!await probe(service.probeUrl)) {
      throw new Error(`${service.name} process group ${pid} exists but its endpoint is not ready; inspect ${statePath(service.id, "log")}`);
    }
    console.log(`${service.name}: already running (PID ${pid})`);
    return;
  }

  if (await probe(service.probeUrl)) {
    throw new Error(`${service.name} is already responding on port ${service.port}, but has no PID record from this script; stop it manually before using dev:start.`);
  }

  const child = await launch(service);
  startedThisRun.push(service);
  await waitForReady(service, child);
  console.log(`${service.name}: started (PID ${child.pid})`);
}

function networkUrls(port) {
  const addresses = Object.values(networkInterfaces()).flatMap((items) => items ?? [])
    .filter((item) => (item.family === "IPv4" || item.family === 4) && !item.internal)
    .map((item) => `http://${item.address}:${port}/`);
  return [...new Set(addresses)];
}

async function start() {
  await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  const startedThisRun = [];
  try {
    for (const service of SERVICES) await startService(service, startedThisRun);
  } catch (error) {
    for (const service of [...startedThisRun].reverse()) {
      await stopService(service).catch((stopError) => console.error(String(stopError)));
    }
    throw error;
  }

  console.log("Development services are detached; they remain running after this command exits.");
  console.log("Vite: http://0.0.0.0:5173/");
  for (const url of networkUrls(5173)) console.log(`LAN:  ${url}`);
  console.log(`API:  http://0.0.0.0:17310/`);
  console.log(`DB:   ${await realpath(PRODUCTION_DB).catch(() => PRODUCTION_DB)}`);
  console.log(`Logs: ${STATE_DIRECTORY}`);
}

async function startWebOnly() {
  const api = SERVICES.find((service) => service.id === "api");
  const web = SERVICES.find((service) => service.id === "web");
  if (!api || !web) throw new Error("Development API or Vite service is not configured.");
  if (!await probe(api.probeUrl)) {
    throw new Error(`Bridge Web API is not ready on port ${api.port}; start it before Vite.`);
  }

  await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  const startedThisRun = [];
  try {
    await startService(web, startedThisRun);
  } catch (error) {
    for (const service of [...startedThisRun].reverse()) {
      await stopService(service).catch((stopError) => console.error(String(stopError)));
    }
    throw error;
  }

  console.log("Vite is detached and remains running after this command exits.");
  console.log("Vite: http://0.0.0.0:5173/");
  for (const url of networkUrls(web.port)) console.log(`LAN:  ${url}`);
  console.log(`API:  http://127.0.0.1:${api.port}/`);
  console.log(`Logs: ${STATE_DIRECTORY}`);
}

async function status() {
  for (const service of SERVICES) {
    const pid = await readPid(service.id);
    const managed = Boolean(pid && processGroupExists(pid));
    if (pid && !managed) await rm(statePath(service.id, "pid"), { force: true });
    const ready = await probe(service.probeUrl);
    const state = ready ? `ready${managed ? "" : " (unmanaged)"}` : managed ? "starting/unavailable" : "stopped";
    console.log(`${service.name}: ${state}${managed ? ` (PID ${pid})` : ""}`);
  }
  console.log(`Logs: ${STATE_DIRECTORY}`);
}

async function main() {
  const command = process.argv[2] ?? "start";
  if (command === "start") return start();
  if (command === "web") return startWebOnly();
  if (command === "stop") {
    for (const service of [...SERVICES].reverse()) await stopService(service);
    return;
  }
  if (command === "restart") {
    for (const service of [...SERVICES].reverse()) await stopService(service);
    return start();
  }
  if (command === "status") return status();
  if (command === "--help" || command === "-h" || command === "help") {
    console.log("Usage: bun run dev:start [start|web|status|stop|restart]");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
