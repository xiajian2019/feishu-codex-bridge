import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

test("authorizes managed Android builds and reports a verified result without allowing concurrent config edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-managed-android-api-"));
  const apk = join(root, "android/app/build/outputs/apk/debug/app-debug.apk");
  const script = join(root, "scripts/build-apk.mjs");
  await mkdir(dirname(script), { recursive: true });
  await mkdir(dirname(apk), { recursive: true });
  await writeFile(apk, "previous apk");
  await writeFile(join(dirname(apk), "output-metadata.json"), JSON.stringify({ applicationId: "com.example.api", elements: [{ outputFile: "app-debug.apk", versionCode: 1, versionName: "0.9" }] }));
  await writeFile(script, `import { mkdirSync, rmSync, writeFileSync } from "node:fs";\nrmSync(${JSON.stringify(apk)}, { force: true });\nawait Bun.sleep(700);\nmkdirSync(${JSON.stringify(dirname(apk))}, { recursive: true });\nwriteFileSync(${JSON.stringify(apk)}, "fixture apk");\nwriteFileSync(${JSON.stringify(join(dirname(apk), "output-metadata.json"))}, JSON.stringify({applicationId: "com.example.api", elements: [{outputFile: "app-debug.apk", versionCode: 2, versionName: "1.0"}]}));\nconsole.log("fixture APK done");\n`);
  const db = new StateDatabase(":memory:");
  const auth = new WebPairingAuth({ db, allowLocalRequests: false });
  const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  try {
    const base = await server.start();
    const pairing = auth.startPairing();
    const pair = await (await fetch(base + "/api/auth/mobile/pair", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code }),
    })).json() as { token: string };
    const headers = { Authorization: "Bearer " + pair.token };
    const session = await (await fetch(base + "/api/session", { headers })).json() as { actionToken: string };
    const actionHeaders = { ...headers, Origin: base, "X-Bridge-Action-Token": session.actionToken, "Content-Type": "application/json" };
    const input = { name: "Fixture", enabled: true, ios: null, android: { packageName: "com.example.api", apkPath: apk, snapshotDirectory: join(root, "snapshots"), sourcePath: root, buildScript: "scripts/build-apk.mjs" } };
    const created = await (await fetch(base + "/api/mobile/apps", { method: "POST", headers: actionHeaders, body: JSON.stringify(input) })).json() as { app: { id: string }; android: { config: { source_path: string; build_script: string }; build: { available: boolean } } };
    expect(created.android.config).toMatchObject({ source_path: root, build_script: "scripts/build-apk.mjs" });
    expect(created.android.build.available).toBe(true);
    const legacyInput = { ...input, android: { packageName: input.android.packageName, apkPath: input.android.apkPath, snapshotDirectory: input.android.snapshotDirectory } };
    const legacyPatch = await fetch(base + `/api/mobile/apps/${created.app.id}`, { method: "PATCH", headers: actionHeaders, body: JSON.stringify(legacyInput) });
    expect(legacyPatch.status).toBe(200);
    expect(((await legacyPatch.json()) as typeof created).android.config).toMatchObject({ source_path: root, build_script: "scripts/build-apk.mjs" });
    const endpoint = `/api/mobile/apps/${created.app.id}/android/build`;
    expect((await fetch(base + endpoint, { method: "POST" })).status).toBe(401);
    expect((await fetch(base + endpoint, { method: "POST", headers })).status).toBe(403);
    const started = await fetch(base + endpoint, { method: "POST", headers: actionHeaders, body: "{}" });
    expect(started.status).toBe(202);
    expect(((await started.json()) as { android: { build: { state: string } } }).android.build.state).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const during = await (await fetch(base + `/api/mobile/apps/${created.app.id}`, { headers })).json() as { android: { latest: { versionCode: number; downloadUrl: string } } };
    expect(during.android.latest.versionCode).toBe(1);
    expect(await (await fetch(base + during.android.latest.downloadUrl, { headers })).text()).toBe("previous apk");
    expect((await fetch(base + endpoint, { method: "POST", headers: actionHeaders, body: "{}" })).status).toBe(409);
    expect((await fetch(base + `/api/mobile/apps/${created.app.id}`, { method: "PATCH", headers: actionHeaders, body: JSON.stringify(input) })).status).toBe(409);
    let result: { android: { build: { state: string; log?: string }; latest: { versionCode: number; downloadUrl: string } | null } } | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await (await fetch(base + `/api/mobile/apps/${created.app.id}`, { headers })).json() as typeof result;
      if (result?.android.build.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(result?.android.build.state).toBe("succeeded");
    expect(result?.android.build.log).toContain("fixture APK done");
    expect(result?.android.latest?.versionCode).toBe(2);
    expect(await (await fetch(base + result!.android.latest!.downloadUrl, { headers })).text()).toBe("fixture apk");
  } finally {
    await server.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
