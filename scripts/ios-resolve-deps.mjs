import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };

function proxyDescription(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "<invalid proxy URL>";
  }
}

async function assertProxyReachable(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Swift dependency proxy URL: ${proxyDescription(value)}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) return;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  await new Promise((resolveConnection, rejectConnection) => {
    const socket = createConnection({ host: url.hostname, port, timeout: 1_500 });
    const fail = (error) => {
      socket.destroy();
      rejectConnection(new Error(`Swift dependency proxy is unreachable at ${proxyDescription(value)}: ${error.message}`));
    };
    socket.once("connect", () => { socket.end(); resolveConnection(); });
    socket.once("timeout", () => fail(new Error("connection timeout")));
    socket.once("error", fail);
  });
}

// Git/SwiftPM invocations do not consistently agree on proxy variable casing.
// Mirror whichever form the caller provided without embedding a machine-local
// proxy in the repository. Explicit uppercase values win over inherited
// lowercase values so `HTTP_PROXY=... bun run ...` can override a shell default.
for (const [upper, lower] of [
  ["HTTP_PROXY", "http_proxy"],
  ["HTTPS_PROXY", "https_proxy"],
  ["NO_PROXY", "no_proxy"],
]) {
  const value = env[upper] || env[lower];
  if (value) {
    env[upper] = value;
    env[lower] = value;
  }
}

const proxySummary = [env.HTTPS_PROXY ? `HTTPS_PROXY=${proxyDescription(env.HTTPS_PROXY)}` : null, env.HTTP_PROXY ? `HTTP_PROXY=${proxyDescription(env.HTTP_PROXY)}` : null]
  .filter(Boolean)
  .join(" ");
if (env.HTTPS_PROXY || env.HTTP_PROXY) {
  await assertProxyReachable(env.HTTPS_PROXY || env.HTTP_PROXY);
  // Xcode's SwiftPM process launches Git internally. Pass proxy settings via
  // Git's ephemeral environment config as well; do not mutate ~/.gitconfig.
  const gitProxyEntries = [
    ["http.proxy", env.HTTP_PROXY || env.HTTPS_PROXY],
    ["https.proxy", env.HTTPS_PROXY || env.HTTP_PROXY],
  ].filter(([, value]) => value);
  const existingGitConfigCount = Number(env.GIT_CONFIG_COUNT);
  const offset = Number.isSafeInteger(existingGitConfigCount) && existingGitConfigCount >= 0 ? existingGitConfigCount : 0;
  env.GIT_CONFIG_COUNT = String(offset + gitProxyEntries.length);
  gitProxyEntries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${offset + index}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
}
if (proxySummary) console.log(`Resolving iOS Swift packages with ${proxySummary}`);
else console.log("Resolving iOS Swift packages without an explicit HTTP proxy.");

const result = spawnSync("xcodebuild", [
  "-resolvePackageDependencies",
  "-project", "ios/App/App.xcodeproj",
  "-scheme", "App",
], { cwd: root, env, stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
