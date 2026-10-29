import { expect, it } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MobileApkStore } from "../src/mobile-apk.js";
import { StateDatabase } from "../src/db.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { DashboardServer } from "../src/web.js";

it("serves each advertised revision unchanged after the build output is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-apk-store-"));
  try {
    const path = join(root, "app-debug.apk");
    const metadata = (code: number) => JSON.stringify({ applicationId: "dev.feishu.codex.bridge", elements: [{ outputFile: "app-debug.apk", versionCode: code, versionName: "0.5.0" }] });
    await writeFile(path, "first build"); await writeFile(join(root, "output-metadata.json"), metadata(100));
    const store = new MobileApkStore(path, join(root, "snapshots"));
    const first = (await store.latest())!;
    await writeFile(path, "second build with different bytes"); await writeFile(join(root, "output-metadata.json"), metadata(101));
    const second = (await store.latest())!;
    expect(first.revision).not.toBe(second.revision);
    expect(first.downloadUrl).toEndWith(first.sha256);
    expect(first.versionCode).toBe(100);
    expect(await Bun.file((await store.revision(first.revision))!.path).text()).toBe("first build");
    expect(await Bun.file((await store.revision(second.revision))!.path).text()).toBe("second build with different bytes");
    expect(await store.revision("../app-debug")).toBeNull();
    await writeFile((await store.revision(first.revision))!.path, "truncated");
    expect(await store.revision(first.revision)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("requires App authentication for metadata and revision downloads and never serves a changed build at an old URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-apk-http-"));
  const db = new StateDatabase(":memory:");
  const auth = new WebPairingAuth({ db, allowLocalRequests: false });
  const apkPath = join(root, "app-debug.apk");
  const server = new DashboardServer({ db, auth, mobileApkPath: apkPath, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  try {
    await writeFile(apkPath, "old artifact");
    await writeFile(join(root, "output-metadata.json"), JSON.stringify({ applicationId: "dev.feishu.codex.bridge", elements: [{ outputFile: "app-debug.apk", versionCode: 100, versionName: "0.5.0" }] }));
    const base = await server.start();
    expect((await fetch(base + "/api/mobile/update")).status).toBe(401);
    const code = auth.startPairing().code;
    const { token } = await (await fetch(base + "/api/auth/mobile/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) })).json() as { token: string };
    const headers = { Authorization: "Bearer " + token };
    const metadata = await (await fetch(base + "/api/mobile/update", { headers })).json() as { downloadUrl: string; sha256: string; versionCode: number };
    expect(metadata.versionCode).toBe(100);
    await writeFile(apkPath, "replacement artifact");
    expect((await fetch(base + metadata.downloadUrl)).status).toBe(401);
    const downloaded = await fetch(base + metadata.downloadUrl, { headers });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-length")).toBe(String("old artifact".length));
    expect(await downloaded.text()).toBe("old artifact");
    expect((await fetch(base + "/api/mobile/update/download/" + "0".repeat(64), { headers })).status).toBe(404);
    auth.revokeAll();
    expect((await fetch(base + metadata.downloadUrl, { headers })).status).toBe(401);
  } finally { await server.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
});
