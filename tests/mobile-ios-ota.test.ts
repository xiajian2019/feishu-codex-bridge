import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOtaHandler, servicePaths } from "../scripts/ios-ota.mjs";
import { StateDatabase } from "../src/db.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { DashboardServer } from "../src/web.js";

it("requires pairing and an action token to issue OTA links or publish, and serves an authorized immutable release", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-ios-ota-api-"));
  const directory = join(root, "ota"), source = join(root, "source");
  await mkdir(join(directory, "releases"), { recursive: true }); await mkdir(join(source, "scripts"), { recursive: true });
  const content = "isolated IPA fixture", revision = createHash("sha256").update(content).digest("hex"), now = Date.now();
  await writeFile(join(directory, "releases", revision + ".ipa"), content);
  await writeFile(join(directory, "releases", revision + ".json"), JSON.stringify({ schema: 1, bundleId: "dev.feishu.codex.bridge", revision,
    size: content.length, version: "1.0", build: "1", expiresAt: new Date(now + 86400_000).toISOString(), publishedAt: new Date(now).toISOString() }));
  await writeFile(join(directory, "latest.json"), JSON.stringify({ schema: 1, revision }));
  await writeFile(join(source, "scripts", "ios-ota.mjs"), 'console.log("isolated publish fixture")');
  const label = servicePaths(directory).label;
  const ota = createServer(createOtaHandler(directory, label));
  await new Promise<void>((done) => ota.listen(0, "127.0.0.1", done));
  const address = ota.address(); if (!address || typeof address === "string") throw new Error("OTA fixture did not start");
  const otaBase = `https://ota.fixture:${address.port}`;
  await writeFile(join(directory, "service.json"), JSON.stringify({ schema: 1, base: otaBase, port: address.port, direct: null }));
  const db = new StateDatabase(":memory:"), auth = new WebPairingAuth({ db, allowLocalRequests: false });
  const bridge = new DashboardServer({ db, auth, iosOtaDirectory: directory, iosOtaSource: source, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  try {
    const base = await bridge.start();
    expect((await fetch(base + "/api/mobile/ios-ota")).status).toBe(401);
    expect((await fetch(base + "/api/mobile/ios-ota/publish", { method: "POST" })).status).toBe(401);
    const code = auth.startPairing().code;
    const pair = await (await fetch(base + "/api/auth/mobile/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) })).json() as { token: string };
    const headers = { Authorization: "Bearer " + pair.token };
    const status = await (await fetch(base + "/api/mobile/ios-ota", { headers })).json() as { available: boolean; serviceRunning: boolean };
    expect(status.available).toBe(true); expect(status.serviceRunning).toBe(true);
    expect((await fetch(base + "/api/mobile/ios-ota/link", { method: "POST", headers })).status).toBe(403);
    expect((await fetch(base + "/api/mobile/ios-ota/publish", { method: "POST", headers })).status).toBe(403);
    const actionToken = (await (await fetch(base + "/api/session", { headers })).json() as { actionToken: string }).actionToken;
    const action = { ...headers, Origin: base, "X-Bridge-Action-Token": actionToken };
    const nativeAction = { ...headers, Origin: "capacitor://localhost", "X-Bridge-Action-Token": actionToken };
    expect((await fetch(base + "/api/mobile/ios-ota/link", { method: "POST", headers: { ...action, Origin: "https://untrusted.example" } })).status).toBe(403);
    expect((await fetch(base + "/api/mobile/ios-ota/link", { method: "POST", headers: nativeAction })).status).toBe(200);
    const link = await (await fetch(base + "/api/mobile/ios-ota/link", { method: "POST", headers: action })).json() as { url: string };
    const token = new URL(link.url).pathname.split("/")[1];
    const manifest = await (await fetch(`http://127.0.0.1:${address.port}/${token}/manifest.plist`)).text();
    expect(manifest).toContain(`${revision}.ipa`);
    const ipa = await fetch(`http://127.0.0.1:${address.port}/${token}/${revision}.ipa`);
    expect(await ipa.text()).toBe(content);
    expect((await fetch(base + "/api/mobile/ios-ota/publish", { method: "POST", headers: action })).status).toBe(202);
    for (let i = 0; i < 50; i++) {
      const next = await (await fetch(base + "/api/mobile/ios-ota", { headers })).json() as { publish: { state: string } };
      if (next.publish.state !== "running") { expect(next.publish.state).toBe("succeeded"); break; }
      await Bun.sleep(50);
      if (i === 49) throw new Error("fixture publish did not finish");
    }
    auth.revokeAll();
    expect((await fetch(base + "/api/mobile/ios-ota/link", { method: "POST", headers: action })).status).toBe(401);
  } finally { await bridge.stop(); db.close(); ota.close(); await rm(root, { recursive: true, force: true }); }
});
