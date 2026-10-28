import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi, submissionFingerprint } from "../src/tmux-dashboard-api.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

it("uploads Composer files above 100 MiB and retains large-image preview, authentication and path boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-unlimited-tmux-"));
  const attachmentDirectory = join(root, "attachments");
  const db = new StateDatabase(":memory:");
  const tmux = new TmuxDashboardApi({ db, attachmentDirectory });
  const auth = new WebPairingAuth({ db });
  const remote = { headers: {}, socket: { remoteAddress: "203.0.113.1" } } as IncomingMessage;
  const token = auth.claimPairing(remote, auth.startPairing().code);
  const other = auth.claimPairing(remote, auth.startPairing().code);
  const server = new DashboardServer({ db, auth, tmuxDashboard: tmux, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false });
  try {
    const base = await server.start();
    const cookie = { Cookie: `bridge_session=${token}` };
    const { actionToken } = await (await fetch(base + "/api/session", { headers: cookie })).json() as { actionToken: string };
    const headers = { ...cookie, "X-Bridge-Action-Token": actionToken, Origin: base };
    const endpoint = base + "/tmux-dashboard/api/attachments/uploads";
    const size = 100 * 1024 * 1024 + 17;
    const metadata = JSON.stringify({ fileName: "large.png", sizeBytes: size, contentType: "image/png" });
    expect((await fetch(endpoint, { method: "POST", body: metadata })).status).toBe(401);
    expect((await fetch(endpoint, { method: "POST", headers: cookie, body: metadata })).status).toBe(403);
    const created = await fetch(endpoint, { method: "POST", headers, body: metadata });
    expect(created.status).toBe(201);
    const upload = await created.json() as { id: string; chunkBytes: number };
    expect((await fetch(`${endpoint}/${upload.id}`, { headers: { Cookie: `bridge_session=${other}` } })).status).toBe(404);
    expect((await fetch(`${endpoint}/${upload.id}?offset=0`, { method: "PUT", headers: cookie, body: "x" })).status).toBe(403);
    const chunk = Buffer.alloc(upload.chunkBytes, 0x61);
    for (let offset = 0; offset < size;) {
      const bytes = Math.min(upload.chunkBytes, size - offset);
      const response = await fetch(`${endpoint}/${upload.id}?offset=${offset}`, { method: "PUT", headers, body: chunk.subarray(0, bytes) });
      expect(response.status).toBe(200);
      const next = await response.json() as { offset: number };
      expect(next.offset).toBe(offset + bytes); offset = next.offset;
    }
    const complete = await fetch(`${endpoint}/${upload.id}/complete`, { method: "POST", headers });
    expect(complete.status).toBe(200);
    const saved = await complete.json() as { filePath: string; sizeBytes: number };
    expect(saved.filePath.startsWith(attachmentDirectory + "/")).toBe(true);
    expect(basename(saved.filePath)).toMatch(/^[a-f0-9-]{36}\.png$/);
    expect((await stat(saved.filePath)).size).toBe(size);
    const preview = await fetch(base + "/tmux-dashboard/api/attachments/images/" + basename(saved.filePath), { headers: cookie });
    expect(preview.status).toBe(200);
    let received = 0;
    for await (const data of preview.body!) received += data.length;
    expect(received).toBe(size);
    const outside = join(root, "outside.txt"); await writeFile(outside, "outside");
    const linked = `${randomUUID()}.png`; await symlink(outside, join(attachmentDirectory, linked));
    expect((await fetch(base + "/tmux-dashboard/api/attachments/images/" + linked, { headers: cookie })).status).toBe(404);

    // The old raw endpoint must not retain a hidden 10 MiB rejection either.
    const data = Buffer.alloc(11 * 1024 * 1024 + 3, 0x62);
    const uploadRaw = async () => {
      const response = await fetch(base + "/tmux-dashboard/api/attachments", { method: "POST",
        headers: { ...headers, "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent("document.pdf") }, body: data });
      expect(response.status).toBe(201);
      return (await response.json() as { path: string }).path;
    };
    const first = await uploadRaw(); const second = await uploadRaw();
    expect((await stat(first)).size).toBe(data.length);
    const prompt = (path: string) => `<file name="document.pdf" path="${path}">`;
    const fingerprint = (path: string) => submissionFingerprint(prompt(path), [attachmentDirectory]);
    expect(await fingerprint(first)).toBe(await fingerprint(second));
    const handle = await open(second, "r+");
    try { await handle.write(Buffer.from("different"), 0, 9, 10 * 1024 * 1024); } finally { await handle.close(); }
    expect(await fingerprint(first)).not.toBe(await fingerprint(second));
    expect(await readFile(outside, "utf8")).toBe("outside");
  } finally { await server.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
