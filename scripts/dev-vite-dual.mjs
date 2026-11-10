import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function listen(server, port = 0, host = "127.0.0.1") {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, host, done); });
  return server.address().port;
}
async function freePort() { const server = createNetServer(); const port = await listen(server); await new Promise((done) => server.close(done)); return port; }

/** One external TCP port, with local HTTP and HTTPS proxies forwarding to the same Vite instance. */
export async function createDualProxy({ targetPort, cert, key, port = 5173, host = "0.0.0.0" }) {
  const peers = new Map();
  const clientHeaders = (request, secure) => {
    const peer = peers.get(request.socket.remotePort) ?? "unknown";
    const headers = { ...request.headers, "x-forwarded-for": peer, "x-forwarded-proto": secure ? "https" : "http", "x-bridge-dev-peer": peer };
    if (request.headers.host) headers["x-forwarded-host"] = request.headers.host;
    else delete headers["x-forwarded-host"];
    delete headers["x-forwarded-port"];
    return headers;
  };
  const forward = (secure) => (request, response) => {
    const upstream = httpRequest({ hostname: "127.0.0.1", port: targetPort, path: request.url, method: request.method,
      headers: clientHeaders(request, secure) }, (result) => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  };
  const forwardUpgrade = (secure) => (request, socket, head) => {
    const upstreamRequest = httpRequest({ hostname: "127.0.0.1", port: targetPort, path: request.url, method: request.method,
      headers: clientHeaders(request, secure) });
    upstreamRequest.on("upgrade", (response, upstream, upstreamHead) => {
      const lines = [`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstreamRequest.on("response", (response) => { socket.end(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`); response.resume(); });
    upstreamRequest.on("error", () => socket.destroy()); upstreamRequest.end();
  };
  const plain = createHttpServer(forward(false));
  const secure = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key), minVersion: "TLSv1.2" }, forward(true));
  plain.on("upgrade", forwardUpgrade(false)); secure.on("upgrade", forwardUpgrade(true));
  const plainPort = await listen(plain), securePort = await listen(secure);
  const sockets = new Set();
  const front = createNetServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy()); socket.once("error", () => {});
    socket.once("data", (first) => {
      socket.pause(); socket.setTimeout(0);
      let peerPort;
      const upstream = connect(first[0] === 0x16 ? securePort : plainPort, "127.0.0.1", () => {
        peerPort = upstream.localPort;
        peers.set(peerPort, socket.remoteAddress ?? "unknown");
        upstream.write(first); socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => { if (peerPort) peers.delete(peerPort); });
    });
  });
  try { await listen(front, port, host); }
  catch (error) { plain.close(); secure.close(); throw error; }
  return { port: front.address().port, close: () => { for (const socket of sockets) socket.destroy(); front.close(); plain.close(); secure.close(); } };
}

async function main() {
  const settings = JSON.parse(readFileSync(join(root, "ios/App/build/dev-https/settings.json"), "utf8"));
  if (settings.schema !== 1 || !settings.cert || !settings.key) throw new Error("开发 HTTPS 配置无效。");
  const targetPort = await freePort();
  const child = spawn(process.execPath, ["run", "--bun", "vite", "--config", join(root, "web/vite.config.ts"), "--host", "127.0.0.1", "--port", String(targetPort), "--strictPort"], {
    cwd: root, stdio: "inherit", env: { ...process.env, BRIDGE_DEV_PROXY_INTERNAL: "1", BRIDGE_DEV_PUBLIC_PORT: "5173" },
  });
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try { const response = await fetch(`http://127.0.0.1:${targetPort}/`, { signal: AbortSignal.timeout(1_000) }); if (response.ok) { ready = true; break; } } catch { /* wait for Vite */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  if (!ready) { child.kill(); throw new Error("Vite 未能启动，未开放开发 HTTPS 端口。"); }
  let proxy;
  try { proxy = await createDualProxy({ targetPort, cert: settings.cert, key: settings.key }); }
  catch (error) { child.kill(); throw error; }
  console.log(`开发服务已支持 HTTP 与 HTTPS：端口 5173，证书 IP ${settings.ip}。`);
  const stop = () => { proxy.close(); child.kill(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  child.once("exit", (code) => { proxy.close(); process.exitCode = code ?? 1; });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
