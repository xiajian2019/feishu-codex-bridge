import { expect, it } from "bun:test";
import { link, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { StateDatabase } from "../src/db.js";
import { ComposerTransferStore } from "../src/composer-transfer.js";
import { ComposerAssetStore } from "../src/composer-assets.js";

function registerDevice(db: StateDatabase, deviceId: string): void {
  if (deviceId === "local") return;
  const now = new Date().toISOString();
  db.createWebAuthSession({ sessionId: deviceId, tokenHash: randomUUID(), deviceName: "fixture", userAgent: null, remoteAddress: null,
    createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null });
}

async function fixture(storageName = () => `${randomUUID()}.png`, bytes = Buffer.from("abc"), deviceId = "fixture", linkFile?: typeof import("node:fs/promises").link, linkCopiedFile?: typeof import("node:fs/promises").link) {
  const root = await mkdtemp(join(tmpdir(), "composer-assets-"));
  const db = new StateDatabase(join(root, "fixture.db"));
  registerDevice(db, deviceId);
  const session = db.recordTmuxSession({ id: "$41", name: "fixture", cwd: root, createdAt: 41 });
  const attachmentDirectory = join(root, "attachments");
  const transferDirectory = join(attachmentDirectory, "composer-transfers");
  const transfers = new ComposerTransferStore({ db, directory: transferDirectory });
  const assets = new ComposerAssetStore({ db, transferDirectory, attachmentDirectory, storageName, linkFile, linkCopiedFile });
  const context = { sessionId: "$41", sessionCreatedAt: 41, sessionRecordId: session.record_id, deviceId };
  const target = await transfers.createTarget({ ...context, tmuxSessionId: context.sessionId });
  const claim = transfers.claim(target.code, null);
  const item = await transfers.createItem(claim.transferId, claim.transferToken, { fileName: "sample.png", contentType: "image/png", sizeBytes: bytes.length });
  await transfers.appendItem(claim.transferId, claim.transferToken, item.item_id, 0, Readable.from([bytes]));
  await transfers.completeItem(claim.transferId, claim.transferToken, item.item_id);
  transfers.setText(claim.transferId, claim.transferToken, "手机文字");
  transfers.finish(claim.transferId, claim.transferToken);
  return { root, db, assets, transfers, context, target, claim, item };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  await f.assets.dispose(); await f.transfers.dispose(); f.db.close(); await rm(f.root, { recursive: true, force: true });
}

it("promotes once, recovers an unacknowledged adoption, and enforces scope", async () => {
  const f = await fixture();
  try {
    const original = await stat(f.item.local_path);
    const first = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    expect(first.text).toBe("手机文字");
    expect(first.assets).toHaveLength(1);
    const asset = first.assets[0]!;
    const saved = await f.assets.getFile(f.context, asset.assetId);
    const promoted = await stat(saved.path);
    expect(promoted.ino).toBe(original.ino);
    expect(promoted.dev).toBe(original.dev);
    expect(await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).toEqual(first);
    expect(f.assets.listPending(f.context).adoptions).toEqual([first]);
    expect(() => f.assets.listPending({ ...f.context, deviceId: "another" })).not.toThrow();
    expect(f.assets.listPending({ ...f.context, deviceId: "another" }).adoptions).toEqual([]);
    await expect(f.assets.getFile({ ...f.context, deviceId: "another" }, asset.assetId)).rejects.toThrow("另一台设备");
    await expect(f.assets.getFile({ ...f.context, sessionCreatedAt: 42 }, asset.assetId)).rejects.toThrow("当前 Session");
    f.assets.acknowledge(f.context, first.transferId);
    expect(f.assets.listPending(f.context).adoptions).toEqual([]);
    const resolved = await f.assets.resolveForSend(f.context, [asset.assetId], () => true);
    expect(resolved[0]?.path).toBe(saved.path);
    f.assets.release(f.context, asset.assetId);
    expect(f.db.getComposerDraftAsset(asset.assetId)?.status).toBe("retained");
    expect((await stat(saved.path)).size).toBe(3);
  } finally { await close(f); }
});

it("does not overwrite or delete a conflicting existing attachment during retry or cancellation", async () => {
  const name = "11111111-1111-4111-8111-111111111111.png";
  const f = await fixture(() => name);
  try {
    const conflicting = join(f.root, "attachments", name);
    await writeFile(conflicting, "abc");
    await expect(f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).rejects.toThrow("目标文件冲突");
    await f.transfers.cancelTarget(f.target.targetId, f.context.sessionId, f.context.sessionCreatedAt, f.context.deviceId);
    await f.assets.discardCancelledTarget(f.target.targetId);
    expect((await stat(conflicting)).size).toBe(3);
    await expect(stat(f.item.local_path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await close(f); }
});


it("recovers an interrupted promotion and unacknowledged reference after a service restart", async () => {
  const name = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
  const f = await fixture(() => name, Buffer.from("abc"), "local");
  let reopened: StateDatabase | null = null;
  let recovered: ComposerAssetStore | null = null;
  try {
    const conflict = join(f.root, "attachments", name);
    await writeFile(conflict, "different");
    await expect(f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).rejects.toThrow("目标文件冲突");
    const planned = f.db.listComposerDraftAssets(f.claim.transferId)[0]!;
    expect(planned.status).toBe("preparing");
    await f.assets.dispose(); await f.transfers.dispose(); f.db.close();
    await rm(conflict);
    reopened = new StateDatabase(join(f.root, "fixture.db"));
    recovered = new ComposerAssetStore({ db: reopened, transferDirectory: join(f.root, "attachments", "composer-transfers"), attachmentDirectory: join(f.root, "attachments"), storageName: () => name });
    const result = await recovered.adopt(f.context, f.target.targetId, f.claim.transferId);
    expect(result.assets[0]?.assetId).toBe(planned.asset_id);
    expect(recovered.listPending(f.context).adoptions.map((entry) => entry.transferId)).toEqual([f.claim.transferId]);
    expect((await stat((await recovered.getFile(f.context, planned.asset_id)).path)).size).toBe(3);
  } finally {
    await recovered?.dispose(); reopened?.close();
    await f.assets.dispose(); await f.transfers.dispose(); f.db.close(); await rm(f.root, { recursive: true, force: true });
  }
});

it("creates a bounded authenticated image thumbnail when macOS conversion is available", async () => {
  if (process.platform !== "darwin") return;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const f = await fixture(() => `${randomUUID()}.png`, png);
  try {
    const result = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    const thumbnail = await f.assets.getThumbnail(f.context, result.assets[0]!.assetId);
    expect(thumbnail).not.toBeNull();
    expect(thumbnail!.sizeBytes).toBeGreaterThan(0);
    expect(thumbnail!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
    await expect(f.assets.getThumbnail({ ...f.context, deviceId: "another" }, result.assets[0]!.assetId)).rejects.toThrow("另一台设备");
  } finally { await close(f); }
});


it("does not resolve or delete a replacement file at an adopted path", async () => {
  const f = await fixture();
  try {
    const result = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    const id = result.assets[0]!.assetId;
    const asset = f.db.getComposerDraftAsset(id)!;
    const path = join(f.root, "attachments", asset.storage_name);
    await rm(path);
    await writeFile(path, "abc");
    await expect(f.assets.getFile(f.context, id)).rejects.toThrow("不存在或已变化");
    f.db.releaseComposerDraftAsset(id, new Date(Date.now() - 1000).toISOString());
    const maintenance = f.assets as unknown as { runMaintenance(): Promise<void> };
    await maintenance.runMaintenance();
    await maintenance.runMaintenance();
    expect((await stat(path)).size).toBe(3);
  } finally { await close(f); }
});

it("releases an unsubmitted draft reference when its device authorization is revoked", async () => {
  const f = await fixture();
  try {
    const result = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    const id = result.assets[0]!.assetId;
    f.db.revokeWebAuthSession("fixture", new Date().toISOString());
    expect(f.db.getComposerDraftAsset(id)?.status).toBe("released");
    await expect(f.assets.getFile(f.context, id)).rejects.toThrow("已过期或移除");
  } finally { await close(f); }
});


it("recovers a cross-filesystem copy after interruption without a second copy or overwriting files", async () => {
  const crossDevice: typeof import("node:fs/promises").link = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
  const f = await fixture(() => `${randomUUID()}.png`, Buffer.from("abc"), "fixture", crossDevice);
  try {
    const finish = f.db.finishComposerAssetAdoption.bind(f.db);
    f.db.finishComposerAssetAdoption = () => false;
    await expect(f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).rejects.toThrow("附件接收状态已变化");
    const planned = f.db.listComposerDraftAssets(f.claim.transferId)[0]!;
    expect(planned.copy_temp_owned).toBe(true);
    const temp = join(f.root, "attachments", `.composer-copy-${planned.asset_id}`);
    const destination = join(f.root, "attachments", planned.storage_name);
    expect((await stat(temp)).ino).toBe((await stat(destination)).ino);
    f.db.finishComposerAssetAdoption = finish;
    const adopted = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    expect(adopted.assets[0]?.assetId).toBe(planned.asset_id);
    for (let attempt = 0; attempt < 100 && !f.db.getComposerAssetAdoption(f.claim.transferId)?.source_cleaned; attempt += 1) await Bun.sleep(10);
    expect(f.db.getComposerAssetAdoption(f.claim.transferId)?.source_cleaned).toBe(true);
    await expect(stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.item.local_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(destination)).size).toBe(3);
  } finally { await close(f); }
});

it("cleans only its own promoted links if a later file conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "composer-multi-assets-"));
  const db = new StateDatabase(":memory:");
  registerDevice(db, "fixture");
  const session = db.recordTmuxSession({ id: "$41", name: "fixture", cwd: root, createdAt: 41 });
  const directory = join(root, "attachments");
  const transfers = new ComposerTransferStore({ db, directory: join(directory, "composer-transfers") });
  const names = { "one.png": "11111111-1111-4111-8111-111111111111.png", "two.png": "22222222-2222-4222-8222-222222222222.png" };
  const assets = new ComposerAssetStore({ db, transferDirectory: join(directory, "composer-transfers"), attachmentDirectory: directory, storageName: (name) => names[name as keyof typeof names] });
  const context = { sessionId: "$41", sessionCreatedAt: 41, sessionRecordId: session.record_id, deviceId: "fixture" };
  try {
    const target = await transfers.createTarget({ ...context, tmuxSessionId: context.sessionId });
    const claim = transfers.claim(target.code, null);
    const items = [];
    for (const name of ["one.png", "two.png"]) {
      const item = await transfers.createItem(claim.transferId, claim.transferToken, { fileName: name, contentType: "image/png", sizeBytes: 3 });
      await transfers.appendItem(claim.transferId, claim.transferToken, item.item_id, 0, Readable.from([Buffer.from("abc")]));
      await transfers.completeItem(claim.transferId, claim.transferToken, item.item_id);
      items.push(item);
    }
    transfers.finish(claim.transferId, claim.transferToken);
    const ordered = [...items].sort((left, right) => left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0);
    const conflict = join(directory, names[ordered[1]!.file_name as keyof typeof names]);
    await writeFile(conflict, "unrelated");
    await expect(assets.adopt(context, target.targetId, claim.transferId)).rejects.toThrow("目标文件冲突");
    const own = join(directory, names[ordered[0]!.file_name as keyof typeof names]);
    expect((await stat(own)).size).toBe(3);
    await transfers.cancelTarget(target.targetId, context.sessionId, context.sessionCreatedAt, context.deviceId);
    await assets.discardCancelledTarget(target.targetId);
    await expect(stat(own)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(conflict)).size).toBe(9);
    for (const item of items) await expect(stat(item.local_path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await assets.dispose(); await transfers.dispose(); db.close(); await rm(root, { recursive: true, force: true }); }
});


it("recovers when the destination filesystem does not support hard links", async () => {
  const crossDevice: typeof import("node:fs/promises").link = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
  const noHardLinks: typeof import("node:fs/promises").link = async () => { throw Object.assign(new Error("not supported"), { code: "EPERM" }); };
  const f = await fixture(() => `${randomUUID()}.png`, Buffer.from("abc"), "fixture", crossDevice, noHardLinks);
  try {
    const finish = f.db.finishComposerAssetAdoption.bind(f.db);
    f.db.finishComposerAssetAdoption = () => false;
    await expect(f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).rejects.toThrow("附件接收状态已变化");
    const planned = f.db.listComposerDraftAssets(f.claim.transferId)[0]!;
    expect(planned.file_identity).toBeTruthy();
    const destination = join(f.root, "attachments", planned.storage_name);
    const copied = await stat(destination);
    f.db.finishComposerAssetAdoption = finish;
    const adopted = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    expect(adopted.assets[0]?.assetId).toBe(planned.asset_id);
    expect((await stat(destination)).ino).toBe(copied.ino);
    for (let attempt = 0; attempt < 100 && !f.db.getComposerAssetAdoption(f.claim.transferId)?.source_cleaned; attempt += 1) await Bun.sleep(10);
    expect(f.db.getComposerAssetAdoption(f.claim.transferId)?.source_cleaned).toBe(true);
    await expect(stat(f.item.local_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(destination)).size).toBe(3);
  } finally { await close(f); }
});


it("does not commit a promotion if the receiving device is revoked during finalization", async () => {
  const f = await fixture();
  try {
    const finish = f.db.finishComposerAssetAdoption.bind(f.db);
    f.db.finishComposerAssetAdoption = (transferId, leaseId, expiresAt) => {
      f.db.revokeWebAuthSession("fixture", new Date().toISOString());
      return finish(transferId, leaseId, expiresAt);
    };
    await expect(f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).rejects.toThrow("附件接收状态已变化");
    expect(f.db.getComposerAssetAdoption(f.claim.transferId)?.status).toBe("preparing");
    expect(f.db.getComposerDraftAsset(f.item.item_id)?.status).toBe("preparing");
  } finally { await close(f); }
});

it("cleans an explicitly released draft asset after its grace period", async () => {
  const f = await fixture();
  try {
    const adopted = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    const id = adopted.assets[0]!.assetId;
    const path = (await f.assets.getFile(f.context, id)).path;
    for (let attempt = 0; attempt < 100 && !f.db.getComposerAssetAdoption(f.claim.transferId)?.source_cleaned; attempt += 1) await Bun.sleep(10);
    expect(f.db.getComposerAssetAdoption(f.claim.transferId)?.source_cleaned).toBe(true);
    expect(f.db.releaseComposerDraftAsset(id, new Date(Date.now() - 1000).toISOString())).toBe(true);
    const maintenance = f.assets as unknown as { runMaintenance(): Promise<void> };
    await maintenance.runMaintenance();
    await maintenance.runMaintenance();
    expect(f.db.getComposerDraftAsset(id)?.status).toBe("deleted");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.assets.listPending(f.context).adoptions[0]?.unavailableItemIds).toEqual([f.item.item_id]);
  } finally { await close(f); }
});


it("does not let an expired promotion lease overwrite a newer owner", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayedLink: typeof link = async (source, target) => { enter(); await gate; await link(source, target); };
  const f = await fixture(() => `${randomUUID()}.png`, Buffer.from("abc"), "fixture", delayedLink);
  let other: ComposerAssetStore | null = null;
  let otherDb: StateDatabase | null = null;
  try {
    const first = f.assets.adopt(f.context, f.target.targetId, f.claim.transferId).then(() => "unexpected", () => "stale");
    await entered;
    const lease = f.db.getComposerAssetAdoption(f.claim.transferId)!;
    expect(f.db.renewComposerAssetAdoptionLease(f.claim.transferId, lease.lease_id!, new Date(Date.now() - 1000).toISOString())).toBe(true);
    otherDb = new StateDatabase(join(f.root, "fixture.db"));
    other = new ComposerAssetStore({ db: otherDb, transferDirectory: join(f.root, "attachments", "composer-transfers"), attachmentDirectory: join(f.root, "attachments"), storageName: () => `${randomUUID()}.png` });
    const adopted = await other.adopt(f.context, f.target.targetId, f.claim.transferId);
    release();
    expect(await first).toBe("stale");
    const path = (await other.getFile(f.context, adopted.assets[0]!.assetId)).path;
    expect((await stat(path)).size).toBe(3);
    expect(f.db.getComposerAssetAdoption(f.claim.transferId)?.status).toBe("ready");
  } finally { release(); await other?.dispose(); otherDb?.close(); await close(f); }
});

it("resumes an interrupted exclusive destination copy without keeping a partial file", async () => {
  const crossDevice: typeof link = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
  const noHardLinks: typeof link = async () => { throw Object.assign(new Error("not supported"), { code: "EPERM" }); };
  const f = await fixture(() => `${randomUUID()}.png`, Buffer.from("abc"), "fixture", crossDevice, noHardLinks);
  try {
    const finish = f.db.finishComposerAssetAdoption.bind(f.db);
    f.db.finishComposerAssetAdoption = () => false;
    await expect(f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).rejects.toThrow("附件接收状态已变化");
    const planned = f.db.listComposerDraftAssets(f.claim.transferId)[0]!;
    const destination = join(f.root, "attachments", planned.storage_name);
    await writeFile(destination, "a");
    f.db.finishComposerAssetAdoption = finish;
    const adopted = await f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    expect(adopted.assets[0]?.assetId).toBe(planned.asset_id);
    expect((await stat(destination)).size).toBe(3);
    expect(f.db.getComposerDraftAsset(planned.asset_id)?.status).toBe("ready");
  } finally { await close(f); }
});


it("keeps a transfer being promoted when expiry cleanup races with it", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayedLink: typeof link = async (source, destination) => { enter(); await gate; await link(source, destination); };
  const f = await fixture(() => `${randomUUID()}.png`, Buffer.from("abc"), "fixture", delayedLink);
  const listExpired = f.db.listExpiredComposerTransfers.bind(f.db);
  try {
    const adoption = f.assets.adopt(f.context, f.target.targetId, f.claim.transferId);
    await entered;
    const cleanup = f.transfers as unknown as { expireTarget(id: string): Promise<void>; cleanupExpired(): Promise<void> };
    await cleanup.expireTarget(f.target.targetId);
    // Simulate a maintenance query made just before another process reserved the adoption.
    f.db.listExpiredComposerTransfers = () => [{ transferId: f.claim.transferId, targetId: f.target.targetId, paths: [f.item.local_path] }];
    await cleanup.cleanupExpired();
    f.db.listExpiredComposerTransfers = listExpired;
    expect((await stat(f.item.local_path)).size).toBe(3);
    expect(f.db.getComposerTransfer(f.claim.transferId)?.status).toBe("ready");
    expect(f.db.getComposerTransferTarget(f.target.targetId)?.status).toBe("claimed");
    release();
    const result = await adoption;
    expect((await stat((await f.assets.getFile(f.context, result.assets[0]!.assetId)).path)).size).toBe(3);
  } finally { f.db.listExpiredComposerTransfers = listExpired; release(); await close(f); }
});

it("still expires and removes a transfer that was not being promoted", async () => {
  const f = await fixture();
  try {
    const cleanup = f.transfers as unknown as { expireTarget(id: string): Promise<void> };
    await cleanup.expireTarget(f.target.targetId);
    expect(f.db.getComposerTransfer(f.claim.transferId)?.status).toBe("expired");
    expect(f.db.getComposerTransferTarget(f.target.targetId)?.status).toBe("expired");
    await expect(stat(f.item.local_path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.assets.adopt(f.context, f.target.targetId, f.claim.transferId)).rejects.toThrow("接收内容已失效");
  } finally { await close(f); }
});
