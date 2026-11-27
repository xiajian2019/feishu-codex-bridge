import { expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { COMPOSER_TRANSFER_CHUNK_BYTES } from "../src/composer-transfer.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "composer-assets-http-"));
  const db = new StateDatabase(join(root, "fixture.db"));
  const session = { id: "$41", name: "fixture", cwd: root, createdAt: 41, windows: 1, attachedClients: 0 };
  db.recordTmuxSession(session);
  const tmux = new TmuxDashboardApi({ db, attachmentDirectory: join(root, "attachments"), operations: {
    listSessions: async () => [session], findSession: async () => session, createSession: async () => session,
    killSession: async () => {}, inspectReviewPane: async () => ({ paneId: "%41", panePid: 41, paneTty: "/dev/ttys041", currentCommand: "zsh", cwd: root, foregroundCodex: null }),
    pasteTextToPane: async () => {}, sendEnterToPane: async () => {},
  } });
  const auth = new WebPairingAuth({ db });
  const remote = { headers: {}, socket: { remoteAddress: "203.0.113.41" } } as IncomingMessage;
  const cookieA = `bridge_session=${auth.claimPairing(remote, auth.startPairing().code)}`;
  const cookieB = `bridge_session=${auth.claimPairing(remote, auth.startPairing().code)}`;
  const server = new DashboardServer({ db, auth, tmuxDashboard: tmux, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  const base = await server.start();
  const token = async (cookie: string): Promise<string> => (await (await fetch(base + "/api/session", { headers: { Cookie: cookie } })).json() as { actionToken: string }).actionToken;
  const actionA = await token(cookieA);
  const actionB = await token(cookieB);
  const headers = (cookie: string, actionToken: string) => ({ Cookie: cookie, Origin: base, "Content-Type": "application/json", "X-Bridge-Action-Token": actionToken, "X-Bridge-Session-Created-At": "41" });
  return { root, db, server, base, cookieA, cookieB, headersA: headers(cookieA, actionA), headersB: headers(cookieB, actionB) };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  await f.server.stop(); f.db.close(); await rm(f.root, { recursive: true, force: true });
}

it("reuses a 100 MiB transfer through authorized HTTP endpoints without another upload", async () => {
  const f = await fixture();
  try {
    const status = await (await fetch(f.base + "/api/auth/status", { headers: { Cookie: f.cookieA } })).json() as { client: { features: string[] } };
    expect(status.client.features).toContain("composer-transfer-assets");
    const targetResponse = await fetch(f.base + "/tmux-dashboard/api/sessions/%2441/composer-transfer", { method: "POST", headers: f.headersA, body: "{}" });
    expect(targetResponse.status).toBe(201);
    const target = await targetResponse.json() as { targetId: string; code: string };
    const claimResponse = await fetch(f.base + "/api/composer-transfers/claim", { method: "POST", headers: { Origin: "capacitor://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ code: target.code }) });
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json() as { transferId: string; transferToken: string };
    const transferHeaders = { Origin: "capacitor://localhost", "Content-Type": "application/json", "X-Bridge-Transfer-Token": claim.transferToken };
    const total = 100 * 1024 * 1024 + 17;
    const itemResponse = await fetch(`${f.base}/api/composer-transfers/${claim.transferId}/items`, { method: "POST", headers: transferHeaders, body: JSON.stringify({ fileName: "large.png", contentType: "image/png", sizeBytes: total }) });
    expect(itemResponse.status).toBe(201);
    const item = await itemResponse.json() as { itemId: string };
    const chunk = Buffer.alloc(COMPOSER_TRANSFER_CHUNK_BYTES, 7);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    for (let offset = 0; offset < total; offset += COMPOSER_TRANSFER_CHUNK_BYTES) {
      if (offset === 0) png.copy(chunk); else if (offset === COMPOSER_TRANSFER_CHUNK_BYTES) chunk.fill(7);
      const body = chunk.subarray(0, Math.min(chunk.length, total - offset));
      const response = await fetch(`${f.base}/api/composer-transfers/${claim.transferId}/items/${item.itemId}?offset=${offset}`, { method: "PUT", headers: { ...transferHeaders, "Content-Type": "application/octet-stream" }, body });
      expect(response.status).toBe(200);
    }
    expect((await fetch(`${f.base}/api/composer-transfers/${claim.transferId}/items/${item.itemId}/complete`, { method: "POST", headers: transferHeaders, body: "{}" })).status).toBe(200);
    expect((await fetch(`${f.base}/api/composer-transfers/${claim.transferId}/complete`, { method: "POST", headers: transferHeaders, body: "{}" })).status).toBe(200);
    const originalPath = f.db.getComposerTransfer(claim.transferId)!.items[0]!.local_path;
    const original = await stat(originalPath);
    const root = `${f.base}/tmux-dashboard/api/sessions/%2441`;
    const adoptPath = `${root}/composer-transfer/${target.targetId}/${claim.transferId}/adopt`;
    const adoptedResponse = await fetch(adoptPath, { method: "POST", headers: f.headersA, body: "{}" });
    expect(adoptedResponse.status).toBe(200);
    const adopted = await adoptedResponse.json() as { transferId: string; assets: Array<{ assetId: string; sizeBytes: number }> };
    expect(adopted.assets).toHaveLength(1);
    expect(adopted.assets[0]?.sizeBytes).toBe(total);
    const assetId = adopted.assets[0]!.assetId;
    const stored = f.db.getComposerDraftAsset(assetId)!;
    const promotedPath = join(f.root, "attachments", stored.storage_name);
    const promoted = await stat(promotedPath);
    expect(promoted.ino).toBe(original.ino);
    expect(promoted.dev).toBe(original.dev);
    for (let attempt = 0; attempt < 150 && !f.db.getComposerAssetAdoption(claim.transferId)?.source_cleaned; attempt += 1) await Bun.sleep(20);
    expect(f.db.getComposerAssetAdoption(claim.transferId)?.source_cleaned).toBe(true);
    await expect(stat(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await (await fetch(adoptPath, { method: "POST", headers: f.headersA, body: "{}" })).json() as { assets: Array<{ assetId: string }> }).assets[0]?.assetId).toBe(assetId);
    const pending = await (await fetch(`${root}/composer-assets/pending`, { headers: f.headersA })).json() as { adoptions: Array<{ transferId: string }> };
    expect(pending.adoptions.map((entry) => entry.transferId)).toEqual([claim.transferId]);
    expect((await fetch(`${root}/composer-assets/${assetId}/content`, { headers: f.headersB })).status).toBe(403);
    expect((await fetch(`${root}/composer-assets/${assetId}/content`, { headers: { ...f.headersA, "X-Bridge-Session-Created-At": "42" } })).status).toBe(409);
    const thumbnail = await fetch(`${root}/composer-assets/${assetId}/content?thumbnail=1`, { headers: f.headersA });
    if (process.platform === "darwin") {
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
      expect((await thumbnail.arrayBuffer()).byteLength).toBeLessThanOrEqual(1024 * 1024);
    } else expect(thumbnail.status).toBe(204);
    expect((await fetch(`${root}/composer-assets/adoptions/${claim.transferId}/ack`, { method: "POST", headers: f.headersA, body: "{}" })).status).toBe(200);
    expect((await (await fetch(`${root}/composer-assets/pending`, { headers: f.headersA })).json() as { adoptions: unknown[] }).adoptions).toEqual([]);
    const resolvedResponse = await fetch(`${root}/composer-assets/resolve`, { method: "POST", headers: f.headersA, body: JSON.stringify({ assetIds: [assetId] }) });
    expect(resolvedResponse.status).toBe(200);
    const resolved = await resolvedResponse.json() as { assets: Array<{ assetId: string; path: string }> };
    expect(resolved.assets[0]).toMatchObject({ assetId, path: await (await import("node:fs/promises")).realpath(promotedPath) });
    expect(f.db.getComposerDraftAsset(assetId)?.status).toBe("retained");
    expect((await stat(promotedPath)).size).toBe(total);
    expect((await fetch(`${root}/composer-assets/${assetId}`, { method: "DELETE", headers: f.headersA })).status).toBe(200);
    expect((await stat(promotedPath)).size).toBe(total);
  } finally { await close(f); }
}, 60_000);
