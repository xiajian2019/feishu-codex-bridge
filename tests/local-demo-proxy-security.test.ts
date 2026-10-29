import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(strict = false) {
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
  const auth = new WebPairingAuth({ db, allowLocalRequests: !strict });
  const bridge = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
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
  return { url, forwarded, auth, path: "/api/local-demos/food-photo/fixture" };
}

it("opens a Demo in a clean browser using a scoped cookie without granting Bridge management access", async () => {
  const f = await fixture(true);
  const code = f.auth.startPairing().code;
  const pairing = await fetch(f.url + "/api/auth/mobile/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  const { token } = await pairing.json() as { token: string };
  const bearer = { Authorization: "Bearer " + token };
  const { actionToken } = await (await fetch(f.url + "/api/session", { headers: bearer })).json() as { actionToken: string };
  const headers = { ...bearer, "X-Bridge-Action-Token": actionToken, "Content-Type": "application/json" };
  const ticketPath = "/api/local-demos/food-photo/browser-ticket";
  expect((await fetch(f.url + ticketPath, { method: "POST", headers: bearer, body: "{}" })).status).toBe(403);
  for (const path of ["/api/tasks", "https://evil.fixture/", "/api/local-demos/food-photo/logs", "/api/local-demos/food-photo/../openai-clip/"]) {
    const rejected = await fetch(f.url + ticketPath, { method: "POST", headers, body: JSON.stringify({ path }) });
    expect(rejected.status).toBe(400); await rejected.text();
  }
  const issued = await fetch(f.url + ticketPath, { method: "POST", headers, body: JSON.stringify({ path: "/api/local-demos/food-photo/?scene=multidish" }) });
  const { url } = await issued.json() as { url: string };
  expect(url).not.toContain(token);
  const exchanged = await fetch(f.url + url, { redirect: "manual" });
  expect(exchanged.status).toBe(303);
  expect(exchanged.headers.get("location")).toBe("/api/local-demos/food-photo/?scene=multidish");
  expect(exchanged.headers.get("referrer-policy")).toBe("no-referrer");
  const cookieHeader = exchanged.headers.get("set-cookie")!;
  expect(cookieHeader).toContain("Path=/api/local-demos/food-photo/");
  expect(cookieHeader).toContain("HttpOnly");
  const cookie = { Cookie: cookieHeader.split(";", 1)[0]! };
  expect((await fetch(f.url + url, { redirect: "manual" })).status).toBe(401);
  const demo = await fetch(f.url + f.path, { headers: cookie });
  expect(demo.status).toBe(200); await demo.text();
  for (const path of ["/api/session", "/api/local-demos/openai-clip/", "/api/local-demos/food-photo/logs"]) {
    const response = await fetch(f.url + path, { headers: cookie });
    expect(response.status).toBe(401); await response.text();
  }
  const crossOrigin = await fetch(f.url + f.path, { method: "POST", headers: { ...cookie, Origin: "https://evil.fixture" }, body: "bad" });
  expect(crossOrigin.status).toBe(403); await crossOrigin.text();
  const written = await fetch(f.url + f.path, { method: "POST", headers: { ...cookie, Origin: f.url }, body: "demo input" });
  expect(written.status).toBe(200); await written.text();
  f.auth.revokeAll();
  expect((await fetch(f.url + f.path, { headers: cookie })).status).toBe(401);
});

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
