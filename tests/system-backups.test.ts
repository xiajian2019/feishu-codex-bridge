import { expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { DashboardServer } from "../src/web.js";

it("backs up, verifies, checks and restores only SQLite through authenticated system APIs without attachment roots", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bridge-system-backups-test-")));
  const databasePath = join(root, "bridge.db");
  const backupRoot = join(root, "backups");
  const db = new StateDatabase(databasePath);
  db.createStagedWebTaskAttachment({ attachmentId: "missing-file", fileName: "missing.txt", mimeType: "text/plain",
    sizeBytes: 3, localPath: join(root, "missing.txt") });
  const auth = new WebPairingAuth({ db });
  const server = new DashboardServer({ db, auth, databasePath, backupRoot, host: "127.0.0.1", port: 0,
    modes: [], cleanupExpiredStagedAttachments: false });
  try {
    const url = await server.start();
    expect((await fetch(`${url}/api/system/backups`)).status).toBe(401);
    const remote = { headers: { "user-agent": "fixture" }, socket: { remoteAddress: "203.0.113.1" } } as unknown as IncomingMessage;
    const sessionToken = auth.claimPairing(remote, auth.startPairing().code);
    const headers = { Cookie: `bridge_session=${sessionToken}`, "User-Agent": "fixture", Origin: url };
    const { actionToken } = await (await fetch(`${url}/api/session`, { headers })).json() as { actionToken: string };
    const list = await fetch(`${url}/api/system/backups`, { headers });
    expect(await list.json()).toMatchObject({ backups: [], restoreDirectory: "restores/",
      schedule: { hour: 1, minute: 0, retentionDays: 3, minimumBackups: 3 } });
    expect((await fetch(`${url}/api/system/backups/create`, { method: "POST", headers })).status).toBe(403);
    const actionHeaders = { ...headers, "X-Bridge-Action-Token": actionToken };
    const created = await fetch(`${url}/api/system/backups/create`, { method: "POST", headers: actionHeaders });
    expect(created.status).toBe(201);
    const { backup } = await created.json() as { backup: { backupId: string; metadata: Record<string, unknown> } };
    expect(backup.metadata).toMatchObject({ scope: "sqlite", source: "manual", formatVersion: 3,
      attachmentCount: 0, attachmentBytes: 0, contentHashesVerified: false });
    const backupDirectory = join(backupRoot, backup.backupId);
    expect((await readdir(backupDirectory)).sort()).toEqual(["bridge.db", "manifest.json"]);
    for (const action of ["verify", "check-upgrade", "restore"]) {
      const endpoint = `${url}/api/system/backups/${backup.backupId}/${action}`;
      expect((await fetch(endpoint, { method: "POST", headers })).status).toBe(403);
      expect((await fetch(endpoint, { method: "POST", headers: { ...actionHeaders, Origin: "https://foreign.example" } })).status).toBe(403);
      const response = await fetch(endpoint, { method: "POST", headers: actionHeaders });
      expect(response.status).toBe(action === "restore" ? 201 : 200);
      const body = await response.json() as { verification: object; compatibility?: { compatible: boolean }; restore?: { restoreId: string } };
      expect(body.verification).toMatchObject({ scope: "sqlite", contentHashesVerified: true, attachmentCount: 0 });
      if (action === "check-upgrade") expect(body.compatibility?.compatible).toBe(true);
      if (action === "restore") {
        const restoreDirectory = join(backupRoot, "restores", body.restore!.restoreId);
        expect(await readdir(restoreDirectory)).toEqual(["bridge.db"]);
        expect(await readFile(join(restoreDirectory, "bridge.db"))).toEqual(await readFile(join(backupDirectory, "bridge.db")));
      }
    }
    expect(db.getStagedWebTaskAttachment("missing-file")?.local_path).toBe(join(root, "missing.txt"));
  } finally {
    await server.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
