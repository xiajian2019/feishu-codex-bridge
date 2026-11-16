import { expect, it } from "bun:test";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVpnCertificate } from "../scripts/ios-ota.mjs";
import { createDualProxy } from "../scripts/dev-vite-dual.mjs";

it("shares one port between HTTP and HTTPS, forwards real peer identity and upgrades sockets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-dev-https-"));
  const tls = ensureVpnCertificate(directory, "127.0.0.1");
  const backend = createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.headers)); });
  backend.on("upgrade", (req, socket) => { socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Real-Peer: ${req.headers["x-bridge-dev-peer"]}\r\n\r\n`); });
  await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done));
  const address = backend.address(); if (!address || typeof address === "string") throw new Error("backend did not start");
  const proxy = await createDualProxy({ targetPort: address.port, cert: tls.cert, key: tls.key, port: 0, host: "127.0.0.1" });
  async function get(secure: boolean): Promise<Record<string, string>> {
    return await new Promise((done, reject) => {
      const req = (secure ? httpsRequest : request)({ host: "127.0.0.1", port: proxy.port, path: "/test", ca: readFileSync(tls.ca),
        headers: { "x-forwarded-for": "203.0.113.4", "x-bridge-dev-peer": "203.0.113.4" } }, (res) => {
        let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => body += chunk); res.on("end", () => done(JSON.parse(body)));
      }); req.on("error", reject); req.end();
    });
  }
  try {
    const plain = await get(false), secure = await get(true);
    expect(plain["x-forwarded-proto"]).toBe("http"); expect(secure["x-forwarded-proto"]).toBe("https");
    expect(plain["x-forwarded-for"]).toBe("127.0.0.1"); expect(secure["x-bridge-dev-peer"]).toBe("127.0.0.1");
    const peer = await new Promise<string>((done, reject) => {
      const req = httpsRequest({ host: "127.0.0.1", port: proxy.port, path: "/socket", ca: readFileSync(tls.ca),
        headers: { Connection: "Upgrade", Upgrade: "websocket" } });
      req.on("upgrade", (res, socket) => { socket.destroy(); done(String(res.headers["x-real-peer"])); }); req.on("error", reject); req.end();
    });
    expect(peer).toBe("127.0.0.1");
  } finally { proxy.close(); backend.close(); rmSync(directory, { recursive: true, force: true }); }
});
