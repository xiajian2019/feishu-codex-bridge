import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("system health HTTP boundary", () => {
  it("keeps liveness public while requiring pairing for the read-only status and page", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-health-http-test-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "bridge.db");
    const webRoot = join(root, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<html>health page __BRIDGE_ACTION_TOKEN__</html>");
    const db = new StateDatabase(path);
    cleanup.push(() => db.close());
    const auth = new WebPairingAuth({ db });
    const server = new DashboardServer({
      db, auth, databasePath: path, executionMode: "web-only", webRoot,
      host: "127.0.0.1", port: 0, modes: [],
    });
    cleanup.push(() => server.stop());
    const url = await server.start();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/api/system/health`)).status).toBe(401);
    expect((await fetch(`${url}/system-management/health`)).status).toBe(401);

    const pairing = auth.startPairing();
    const request = { headers: { "user-agent": "fixture" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
    const token = auth.claimPairing(request, pairing.code);
    const headers = { Cookie: `bridge_session=${token}` };
    const status = await fetch(`${url}/api/system/health`, { headers });
    expect(status.status).toBe(200);
    const snapshot = await status.json() as { mode: string; database: { available: boolean }; outbox: { pending: number } };
    expect(snapshot).toMatchObject({ mode: "web-only", database: { available: true }, outbox: { pending: 0 } });
    expect(JSON.stringify(snapshot)).not.toContain(path);
    const deepLink = await fetch(`${url}/system-management/health`, { headers });
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("health page");
  });
});
