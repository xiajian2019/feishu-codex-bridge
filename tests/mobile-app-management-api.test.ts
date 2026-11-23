import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

test("serves managed Android metadata and immutable APK downloads behind the existing auth boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-managed-app-api-"));
  const apk = join(root, "demo.apk");
  await writeFile(apk, "managed apk");
  await writeFile(join(root, "output-metadata.json"), JSON.stringify({ applicationId: "com.example.demo", elements: [{ outputFile: "demo.apk", versionCode: 9, versionName: "2.0.0" }] }));
  const db = new StateDatabase(":memory:");
  const auth = new WebPairingAuth({ db, allowLocalRequests: false });
  const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  try {
    const base = await server.start();
    expect((await fetch(base + "/api/mobile/apps")).status).toBe(401);
    const pairing = auth.startPairing();
    const pair = await (await fetch(base + "/api/auth/mobile/pair", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code }),
    })).json() as { token: string };
    const headers = { Authorization: "Bearer " + pair.token };
    const session = await (await fetch(base + "/api/session", { headers })).json() as { actionToken: string };
    const actionHeaders = { ...headers, Origin: base, "X-Bridge-Action-Token": session.actionToken, "Content-Type": "application/json" };
    const created = await (await fetch(base + "/api/mobile/apps", {
      method: "POST", headers: actionHeaders, body: JSON.stringify({
        name: "Managed Demo", enabled: true, ios: null,
        android: { packageName: "com.example.demo", apkPath: apk, snapshotDirectory: join(root, "snapshots") },
      }),
    })).json() as { app: { id: string }; android: { latest: { downloadUrl: string; versionCode: number } } };
    expect(created.android.latest.versionCode).toBe(9);
    const listed = await (await fetch(base + "/api/mobile/apps", { headers })).json() as { apps: Array<{ app: { id: string } }> };
    expect(listed.apps.some((item) => item.app.id === created.app.id)).toBe(true);
    const downloaded = await fetch(base + created.android.latest.downloadUrl, { headers });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("managed apk");
  } finally {
    await server.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
