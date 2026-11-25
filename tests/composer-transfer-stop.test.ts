import { expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ComposerTransferStore, COMPOSER_TRANSFER_CHUNK_BYTES } from "../src/composer-transfer.js";
import { StateDatabase } from "../src/db.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-composer-stop-"));
  const db = new StateDatabase(":memory:");
  const session = db.recordTmuxSession({ id: "$41", name: "fixture", cwd: root, createdAt: 41 });
  const store = new ComposerTransferStore({ db, directory: join(root, "transfers") });
  const target = await store.createTarget({ sessionRecordId: session.record_id, tmuxSessionId: "$41", sessionCreatedAt: 41, deviceId: "fixture" });
  return { root, db, store, target };
}

it("revokes a ready transfer and removes its received file when stopped", async () => {
  const f = await fixture();
  try {
    const claim = f.store.claim(f.target.code, null);
    const item = await f.store.createItem(claim.transferId, claim.transferToken, { fileName: "test.png", contentType: "image/png", sizeBytes: 3 });
    await f.store.appendItem(claim.transferId, claim.transferToken, item.item_id, 0, Readable.from([Buffer.from("abc")]));
    await f.store.completeItem(claim.transferId, claim.transferToken, item.item_id);
    f.store.finish(claim.transferId, claim.transferToken);
    expect((await stat(item.local_path)).size).toBe(3);
    await f.store.cancelTarget(f.target.targetId, "$41", 41, "fixture");
    expect(f.db.getComposerTransferTarget(f.target.targetId)?.status).toBe("cancelled");
    expect(f.db.getComposerTransfer(claim.transferId)?.status).toBe("expired");
    expect(() => f.store.setText(claim.transferId, claim.transferToken, "later")).toThrow("手机传输已结束或过期");
    await expect(f.store.createItem(claim.transferId, claim.transferToken, { fileName: "next", contentType: "text/plain", sizeBytes: 1 })).rejects.toThrow("手机传输已结束或过期");
    await expect(stat(item.local_path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.store.dispose(); f.db.close(); await rm(f.root, { recursive: true, force: true });
  }
});

it("aborts an in-flight file and removes previously received chunks when stopped", async () => {
  const f = await fixture();
  try {
    const claim = f.store.claim(f.target.code, null);
    const item = await f.store.createItem(claim.transferId, claim.transferToken, {
      fileName: "large.bin", contentType: "application/octet-stream", sizeBytes: COMPOSER_TRANSFER_CHUNK_BYTES + 4,
    });
    await f.store.appendItem(claim.transferId, claim.transferToken, item.item_id, 0, Readable.from([Buffer.alloc(COMPOSER_TRANSFER_CHUNK_BYTES)]));
    const source = new PassThrough();
    const upload = f.store.appendItem(claim.transferId, claim.transferToken, item.item_id, COMPOSER_TRANSFER_CHUNK_BYTES, source)
      .then(() => "accepted", () => "aborted");
    source.write(Buffer.from("a"));
    await f.store.cancelTarget(f.target.targetId, "$41", 41, "fixture");
    expect(await upload).toBe("aborted");
    await expect(stat(item.local_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => f.store.finish(claim.transferId, claim.transferToken)).toThrow("手机传输已结束或过期");
  } finally {
    await f.store.dispose(); f.db.close(); await rm(f.root, { recursive: true, force: true });
  }
});

it("rejects an unused code after the receiver stops", async () => {
  const f = await fixture();
  try {
    await f.store.cancelTarget(f.target.targetId, "$41", 41, "fixture");
    expect(() => f.store.claim(f.target.code, null)).toThrow("接收凭证不存在、已使用或已失效");
  } finally {
    await f.store.dispose(); f.db.close(); await rm(f.root, { recursive: true, force: true });
  }
});
