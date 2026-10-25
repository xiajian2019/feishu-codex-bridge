import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const forwarded: Array<{ method: string | undefined; path: string | undefined; origin: string | undefined; body: string }> = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    forwarded.push({ method: request.method, path: request.url, origin: request.headers.origin, body });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fake upstream has no TCP port");

  const db = new StateDatabase(":memory:");
  cleanups.push(() => db.close());
  const bridge = new DashboardServer({ db, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  cleanups.push(() => bridge.stop());
  // Keep real routing, auth and proxy logic; redirect only the immutable Demo
  // target's network port to this fixture instead of contacting a real Demo.
  type DemoTarget = { id: string; prefix: string; hostname: string; port: number; workingDirectory: string; startScript: string; startArgs: readonly string[] };
  const proxy = bridge as unknown as {
    proxyLocalDemo(request: IncomingMessage, response: ServerResponse, url: URL, target: DemoTarget): Promise<void>;
  };
  const forward = proxy.proxyLocalDemo.bind(bridge);
  proxy.proxyLocalDemo = (request, response, url, target) => forward(request, response, url, { ...target, port: address.port });
  const url = await bridge.start();
  return { url, forwarded, path: "/api/local-demos/food-photo/fixture" };
}

describe("local Demo proxy origin protection", () => {
  it("rejects cross-origin writes before forwarding to the Demo even for a trusted local browser", async () => {
    const f = await fixture();
    for (const method of ["POST", "DELETE"]) {
      const response = await fetch(f.url + f.path, {
        method,
        headers: { Origin: "https://untrusted.example", "Content-Type": "text/plain" },
        body: "must-not-reach-the-demo",
      });
      expect({ method, status: response.status, upstreamRequests: f.forwarded.length })
        .toEqual({ method, status: 403, upstreamRequests: 0 });
      expect(await response.json()).toEqual({ error: "cross-origin action rejected" });
    }
    const opaque = await fetch(f.url + f.path, { method: "POST", headers: { Origin: "null" }, body: "blocked" });
    expect(opaque.status).toBe(403);
    await opaque.text();
    expect(f.forwarded).toEqual([]);
  });

  it("forwards same-origin Demo writes without requiring a Bridge action token or exposing Origin upstream", async () => {
    const f = await fixture();
    const response = await fetch(f.url + f.path + "?view=compact", {
      method: "POST", headers: { Origin: f.url, "Content-Type": "text/plain" }, body: "demo input",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(f.forwarded).toEqual([{ method: "POST", path: "/fixture?view=compact", origin: undefined, body: "demo input" }]);
  });

  it("accepts the development proxy's public origin and browser same-origin metadata", async () => {
    const f = await fixture();
    for (const headers of [
      { Origin: "http://localhost:5173", "X-Forwarded-Host": "localhost:5173", "X-Forwarded-Proto": "http" },
      { Origin: "http://localhost:5173", "Sec-Fetch-Site": "same-origin" },
    ]) {
      const response = await fetch(f.url + f.path, { method: "POST", headers, body: "dev demo input" });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(f.forwarded).toHaveLength(2);
    expect(f.forwarded.every((request) => request.origin === undefined)).toBe(true);
  });

  it("keeps Demo static reads available without applying a write-only origin check", async () => {
    const f = await fixture();
    const response = await fetch(f.url + f.path, { headers: { Origin: "https://reader.example" } });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.forwarded).toEqual([{ method: "GET", path: "/fixture", origin: undefined, body: "" }]);
  });
});
