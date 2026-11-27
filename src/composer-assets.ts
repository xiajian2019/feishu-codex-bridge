import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StateDatabase, StoredComposerDraftAsset, StoredComposerTransfer, StoredComposerTransferItem, StoredComposerTransferTarget } from "./db.js";
import { ComposerTransferError } from "./composer-transfer.js";

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RELEASE_GRACE_MS = 60 * 60 * 1_000;
const LEASE_MS = 2 * 60 * 1_000;
const LEASE_HEARTBEAT_MS = 20 * 1_000;
const STORAGE_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]{1,12}$/i;

export interface ComposerAssetContext {
  sessionId: string;
  sessionCreatedAt: number;
  sessionRecordId: string;
  deviceId: string;
}
export interface ComposerAssetView {
  assetId: string;
  itemId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}
export interface ComposerAssetAdoptionView {
  transferId: string;
  text: string;
  assets: ComposerAssetView[];
  unavailableItemIds: string[];
}

/** Server-owned files referenced by an authenticated, Session-scoped Composer draft. */
export class ComposerAssetStore {
  private readonly db: StateDatabase;
  private readonly transferDirectory: string;
  private readonly attachmentDirectory: string;
  private readonly storageName: (name: string, contentType: string) => string;
  private readonly linkFile: typeof link;
  private readonly linkCopiedFile: typeof link;
  private readonly active = new Map<string, Promise<ComposerAssetAdoptionView>>();
  private readonly thumbnails = new Map<string, Promise<{ path: string; sizeBytes: number } | null>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private maintenance: Promise<void> | null = null;

  constructor(options: { db: StateDatabase; transferDirectory: string; attachmentDirectory: string; storageName: (name: string, contentType: string) => string; linkFile?: typeof link; linkCopiedFile?: typeof link }) {
    this.db = options.db;
    this.transferDirectory = resolve(options.transferDirectory);
    this.attachmentDirectory = resolve(options.attachmentDirectory);
    this.storageName = options.storageName;
    this.linkFile = options.linkFile ?? link;
    this.linkCopiedFile = options.linkCopiedFile ?? link;
    this.timer = setInterval(() => { void this.runMaintenance().catch(() => {}); }, 60_000);
    this.timer.unref?.();
    void this.runMaintenance().catch(() => {});
  }

  public async adopt(context: ComposerAssetContext, targetId: string, transferId: string, authorized: () => boolean = () => true): Promise<ComposerAssetAdoptionView> {
    this.requireTarget(context, targetId, transferId);
    if (!authorized()) throw new ComposerTransferError(401, "设备授权已失效。");
    let operation = this.active.get(transferId);
    if (!operation) {
      operation = this.promote(context, targetId, transferId, authorized);
      this.active.set(transferId, operation);
      void operation.finally(() => { if (this.active.get(transferId) === operation) this.active.delete(transferId); }).catch(() => {});
    }
    const result = await operation;
    if (!authorized()) throw new ComposerTransferError(401, "设备授权已失效。");
    return result;
  }

  public listPending(context: ComposerAssetContext): { adoptions: ComposerAssetAdoptionView[]; preparing: Array<{ targetId: string; transferId: string }> } {
    const pending = this.db.listPendingComposerAssetAdoptions(context.sessionRecordId, context.deviceId);
    return {
      adoptions: pending.filter((adoption) => adoption.status === "ready").map((adoption) => this.publicAdoption(context, adoption.target_id, adoption.transfer_id)),
      preparing: pending.filter((adoption) => adoption.status === "preparing").map((adoption) => ({ targetId: adoption.target_id, transferId: adoption.transfer_id })),
    };
  }

  public acknowledge(context: ComposerAssetContext, transferId: string): void {
    const adoption = this.db.getComposerAssetAdoption(transferId);
    if (!adoption || adoption.status !== "ready") throw new ComposerTransferError(404, "草稿附件接收记录不存在。");
    this.requireTarget(context, adoption.target_id, transferId);
    this.db.acknowledgeComposerAssetAdoption(transferId);
  }

  public async getFile(context: ComposerAssetContext, assetId: string): Promise<{ path: string; item: StoredComposerTransferItem }> {
    const { asset, item } = this.requireAsset(context, assetId);
    return { path: await this.requireDestination(asset, item), item };
  }

  public async getThumbnail(context: ComposerAssetContext, assetId: string): Promise<{ path: string; sizeBytes: number } | null> {
    const { path, item } = await this.getFile(context, assetId);
    if (!item.content_type.startsWith("image/") || process.platform !== "darwin") return null;
    const current = this.thumbnails.get(assetId);
    if (current) return current;
    if (this.thumbnails.size >= 2) return null;
    const operation = this.makeThumbnail(assetId, path);
    this.thumbnails.set(assetId, operation);
    void operation.finally(() => { if (this.thumbnails.get(assetId) === operation) this.thumbnails.delete(assetId); }).catch(() => {});
    return operation;
  }

  public async resolveForSend(context: ComposerAssetContext, assetIds: string[], authorized: () => boolean): Promise<Array<{ assetId: string; path: string; name: string; contentType: string; sizeBytes: number }>> {
    if (!Array.isArray(assetIds) || assetIds.length > 100 || assetIds.some((id) => typeof id !== "string") || new Set(assetIds).size !== assetIds.length) {
      throw new ComposerTransferError(400, "草稿附件引用无效。");
    }
    const result: Array<{ assetId: string; path: string; name: string; contentType: string; sizeBytes: number }> = [];
    for (const assetId of assetIds) {
      const { asset, item } = this.requireAsset(context, assetId);
      const path = await this.requireDestination(asset, item);
      if (await digestFile(path) !== item.sha256) throw new ComposerTransferError(409, "草稿附件内容已变化，请重新添加。");
      result.push({ assetId, path, name: item.file_name, contentType: item.content_type, sizeBytes: item.size_bytes });
    }
    if (!authorized()) throw new ComposerTransferError(401, "设备授权已失效。");
    if (!this.db.retainComposerDraftAssets(assetIds)) throw new ComposerTransferError(409, "草稿附件已失效，请重新添加。");
    if (!authorized()) throw new ComposerTransferError(401, "设备授权已失效。");
    return result;
  }

  public touch(context: ComposerAssetContext, assetIds: string[]): void {
    if (!Array.isArray(assetIds) || assetIds.length > 100 || assetIds.some((id) => typeof id !== "string")) throw new ComposerTransferError(400, "草稿附件引用无效。");
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
    for (const assetId of new Set(assetIds)) {
      const { asset } = this.requireAsset(context, assetId);
      if (asset.status === "ready") this.db.touchComposerDraftAsset(assetId, expiresAt);
    }
  }

  public release(context: ComposerAssetContext, assetId: string): void {
    const { asset } = this.lookupScopedAsset(context, assetId);
    if (asset.status === "ready") this.db.releaseComposerDraftAsset(assetId, new Date(Date.now() + RELEASE_GRACE_MS).toISOString());
  }

  /** Called after the ordinary receiver cancellation has invalidated its target. */
  public async discardCancelledTarget(targetId: string): Promise<void> {
    for (const adoption of this.db.listComposerAssetAdoptionsForTarget(targetId)) {
      if (adoption.status !== "preparing") continue;
      const assets = this.db.listComposerDraftAssets(adoption.transfer_id);
      const transfer = this.db.getComposerTransfer(adoption.transfer_id);
      if (adoption.lease_until && Date.parse(adoption.lease_until) > Date.now()) continue;
      for (const asset of assets) {
        const item = transfer?.items.find((candidate) => candidate.item_id === asset.item_id);
        if (item) await this.removePreparingFiles(asset, item);
      }
      this.db.discardComposerAssetAdoption(adoption.transfer_id);
    }
  }

  public async dispose(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.all([...this.active.values()].map((operation) => operation.catch(() => {})));
    await Promise.all([...this.thumbnails.values()].map((operation) => operation.catch(() => {})));
    await this.maintenance?.catch(() => {});
  }

  private async promote(context: ComposerAssetContext, targetId: string, transferId: string, authorized: () => boolean): Promise<ComposerAssetAdoptionView> {
    const { transfer } = this.requireTarget(context, targetId, transferId);
    const leaseId = randomUUID();
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
    const assets = transfer.items.map((item) => ({ assetId: item.item_id, itemId: item.item_id, storageName: this.storageName(item.file_name, item.content_type) }));
    const state = this.db.beginComposerAssetAdoption({ targetId, transferId, leaseId, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), expiresAt, assets });
    if (state === "ready") {
      void this.cleanSourceFiles(transferId).catch(() => {});
      return this.publicAdoption(context, targetId, transferId);
    }
    if (state === "busy") throw new ComposerTransferError(409, "附件正在加入草稿，请稍后重试。");
    if (state !== "acquired") throw new ComposerTransferError(410, "接收内容已失效，请重新发送。");
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try { if (!this.db.renewComposerAssetAdoptionLease(transferId, leaseId, new Date(Date.now() + LEASE_MS).toISOString())) leaseLost = true; }
      catch { leaseLost = true; }
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      await mkdir(this.attachmentDirectory, { recursive: true, mode: 0o700 });
      const planned = this.db.listComposerDraftAssets(transferId);
      if (!planned.length || planned.length !== transfer.items.length) throw new ComposerTransferError(409, "草稿附件记录不完整。");
      for (const asset of planned) {
        const item = transfer.items.find((candidate) => candidate.item_id === asset.item_id);
        if (!item || item.status !== "ready" || !item.sha256) throw new ComposerTransferError(409, "传输文件尚未准备好。");
        if (!authorized() || leaseLost) throw new ComposerTransferError(409, "附件接收状态已变化，请重试。");
        this.assertLease(transferId, leaseId);
        const identity = await this.linkOrCopy(item, asset, transferId, leaseId);
        if (!this.db.markComposerAssetFileIdentity(asset.asset_id, transferId, leaseId, identity)) throw new ComposerTransferError(409, "附件接收状态已变化，请重试。");
      }
      if (!authorized()) throw new ComposerTransferError(401, "设备授权已失效。");
      if (leaseLost || !this.db.finishComposerAssetAdoption(transferId, leaseId, expiresAt)) throw new ComposerTransferError(409, "附件接收状态已变化，请重试。");
      void this.cleanSourceFiles(transferId).catch(() => {});
      return this.publicAdoption(context, targetId, transferId);
    } catch (error) {
      this.db.releaseComposerAssetAdoptionLease(transferId, leaseId);
      const target = this.db.getComposerTransferTarget(targetId);
      if (target && target.status !== "claimed" && target.status !== "completed") void this.discardCancelledTarget(targetId).catch(() => {});
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private requireTarget(context: ComposerAssetContext, targetId: string, transferId: string): { target: StoredComposerTransferTarget; transfer: StoredComposerTransfer } {
    const target = this.db.getComposerTransferTarget(targetId);
    const transfer = this.db.getComposerTransfer(transferId);
    if (!target || !transfer || transfer.target_id !== targetId || target.tmux_session_id !== context.sessionId
      || target.session_created_at !== context.sessionCreatedAt || target.session_record_id !== context.sessionRecordId) {
      throw new ComposerTransferError(404, "草稿附件不属于当前 Session。");
    }
    if ((target.device_id ?? "local") !== context.deviceId) throw new ComposerTransferError(403, "草稿附件属于另一台设备。");
    return { target, transfer };
  }

  private lookupScopedAsset(context: ComposerAssetContext, assetId: string): { asset: StoredComposerDraftAsset; item: StoredComposerTransferItem } {
    const asset = this.db.getComposerDraftAsset(assetId);
    if (!asset) throw new ComposerTransferError(404, "草稿附件不存在。");
    const adoption = this.db.getComposerAssetAdoption(asset.transfer_id);
    if (!adoption || adoption.status !== "ready") throw new ComposerTransferError(409, "草稿附件尚未准备好。");
    const { transfer } = this.requireTarget(context, adoption.target_id, asset.transfer_id);
    const item = transfer.items.find((candidate) => candidate.item_id === asset.item_id);
    if (!item) throw new ComposerTransferError(404, "草稿附件不存在。");
    return { asset, item };
  }

  private requireAsset(context: ComposerAssetContext, assetId: string): { asset: StoredComposerDraftAsset; item: StoredComposerTransferItem } {
    const result = this.lookupScopedAsset(context, assetId);
    if (!["ready", "retained"].includes(result.asset.status) || (result.asset.status === "ready" && Date.parse(result.asset.expires_at) <= Date.now())) {
      throw new ComposerTransferError(410, "草稿附件已过期或移除，请重新添加。");
    }
    return result;
  }

  private publicAdoption(context: ComposerAssetContext, targetId: string, transferId: string): ComposerAssetAdoptionView {
    const { transfer } = this.requireTarget(context, targetId, transferId);
    const byItem = new Map(this.db.listComposerDraftAssets(transferId).map((asset) => [asset.item_id, asset]));
    const assets = transfer.items.flatMap((item) => {
      const asset = byItem.get(item.item_id);
      if (!asset || !["ready", "retained"].includes(asset.status) || (asset.status === "ready" && Date.parse(asset.expires_at) <= Date.now())) return [];
      return [{ assetId: asset.asset_id, itemId: item.item_id, name: item.file_name, contentType: item.content_type, sizeBytes: item.size_bytes }];
    });
    const present = new Set(assets.map((asset) => asset.itemId));
    return { transferId, text: transfer.text, assets, unavailableItemIds: transfer.items.filter((item) => !present.has(item.item_id)).map((item) => item.item_id) };
  }

  private async requireDestination(asset: StoredComposerDraftAsset, item: StoredComposerTransferItem): Promise<string> {
    if (!STORAGE_NAME.test(asset.storage_name) || basename(asset.storage_name) !== asset.storage_name) throw new ComposerTransferError(409, "草稿附件路径无效。");
    const root = await realpath(this.attachmentDirectory).catch(() => null);
    const path = join(this.attachmentDirectory, asset.storage_name);
    const info = await lstat(path).catch(() => null);
    const canonical = info?.isFile() && !info.isSymbolicLink() ? await realpath(path).catch(() => null) : null;
    if (!root || !canonical || dirname(canonical) !== root || info?.size !== item.size_bytes || !asset.file_identity
      || await fileIdentity(path) !== asset.file_identity) throw new ComposerTransferError(404, "草稿附件文件不存在或已变化。");
    return canonical;
  }

  private async sourcePath(item: StoredComposerTransferItem): Promise<string | null> {
    const root = await realpath(this.transferDirectory).catch(() => null);
    const info = await lstat(item.local_path).catch(() => null);
    if (!info) return null;
    const canonical = info.isFile() && !info.isSymbolicLink() ? await realpath(item.local_path).catch(() => null) : null;
    if (!root || !canonical || !canonical.startsWith(root + sep) || dirname(canonical) !== join(root, item.transfer_id) || info.size !== item.size_bytes) {
      throw new ComposerTransferError(409, "传输文件路径无效或大小已变化。");
    }
    return canonical;
  }

  private copyTempPath(asset: StoredComposerDraftAsset): string {
    if (!/^composer_item_[a-f0-9-]{36}$/i.test(asset.asset_id)) throw new ComposerTransferError(409, "草稿附件标识无效。");
    return join(this.attachmentDirectory, `.composer-copy-${asset.asset_id}`);
  }

  private async linkOrCopy(item: StoredComposerTransferItem, asset: StoredComposerDraftAsset, transferId: string, leaseId: string): Promise<string> {
    if (!STORAGE_NAME.test(asset.storage_name)) throw new ComposerTransferError(409, "草稿附件路径无效。");
    const destination = join(this.attachmentDirectory, asset.storage_name);
    const temporary = this.copyTempPath(asset);
    const source = await this.sourcePath(item);
    const existing = await lstat(destination).catch(() => null);
    if (existing) {
      const sourceInfo = source ? await lstat(source).catch(() => null) : null;
      const tempInfo = asset.copy_temp_owned ? await lstat(temporary).catch(() => null) : null;
      const identity = existing.isFile() && !existing.isSymbolicLink() ? await fileIdentity(destination) : null;
      const recorded = Boolean(identity && asset.file_identity === identity);
      const owned = sameFile(existing, sourceInfo) || sameFile(existing, tempInfo) || recorded;
      if (!owned || !identity) throw new ComposerTransferError(409, "草稿附件目标文件冲突。");
      if (existing.size === item.size_bytes && await digestFile(destination) === item.sha256) return identity;
      if (!recorded || !asset.copy_temp_owned) throw new ComposerTransferError(409, "草稿附件目标文件冲突。");
      this.assertLease(transferId, leaseId);
      await rm(destination, { force: true });
      if (!this.db.clearComposerAssetFileIdentity(asset.asset_id, transferId, leaseId, identity)) throw new ComposerTransferError(409, "附件接收状态已变化，请重试。");
      return this.linkOrCopy(item, { ...asset, file_identity: null }, transferId, leaseId);
    }
    if (asset.file_identity && !this.db.clearComposerAssetFileIdentity(asset.asset_id, transferId, leaseId, asset.file_identity)) {
      throw new ComposerTransferError(409, "附件接收状态已变化，请重试。");
    }
    if (!source || await digestFile(source) !== item.sha256) throw new ComposerTransferError(409, "传输文件不存在或校验失败。");
    this.assertLease(transferId, leaseId);
    try {
      await this.linkFile(source, destination);
      return fileIdentity(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return this.linkOrCopy(item, this.db.getComposerDraftAsset(asset.asset_id) ?? asset, transferId, leaseId);
      if (!["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP"].includes(code ?? "")) throw error;
    }
    let tempInfo = await lstat(temporary).catch(() => null);
    if (tempInfo && (!asset.copy_temp_owned || !tempInfo.isFile() || tempInfo.isSymbolicLink())) throw new ComposerTransferError(409, "草稿附件临时文件冲突。");
    if (tempInfo && (tempInfo.size !== item.size_bytes || await digestFile(temporary) !== item.sha256)) {
      this.assertLease(transferId, leaseId);
      await rm(temporary, { force: true });
      tempInfo = null;
    }
    if (!tempInfo) {
      const handle = await open(temporary, "wx", 0o600);
      const opened = await handle.stat({ bigint: true });
      const identity = `${opened.dev}:${opened.ino}`;
      if (await fileIdentity(temporary).catch(() => null) !== identity || !this.db.markComposerAssetCopyTempOwned(asset.asset_id, transferId, leaseId)) {
        await handle.close();
        if (await fileIdentity(temporary).catch(() => null) === identity) await rm(temporary, { force: true });
        throw new ComposerTransferError(409, "草稿附件状态已变化。");
      }
      const digest = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; digest.update(chunk); callback(null, chunk); } });
      await pipeline(createReadStream(source), meter, handle.createWriteStream());
      if (bytes !== item.size_bytes || digest.digest("hex") !== item.sha256) throw new ComposerTransferError(409, "传输文件复制校验失败。");
    }
    this.assertLease(transferId, leaseId);
    try { await this.linkCopiedFile(temporary, destination); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return this.linkOrCopy(item, this.db.getComposerDraftAsset(asset.asset_id) ?? asset, transferId, leaseId);
      if (!["EPERM", "EOPNOTSUPP", "ENOTSUP"].includes(code ?? "")) throw error;
      this.assertLease(transferId, leaseId);
      let handle;
      try { handle = await open(destination, "wx", 0o600); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return this.linkOrCopy(item, this.db.getComposerDraftAsset(asset.asset_id) ?? asset, transferId, leaseId);
        throw cause;
      }
      const opened = await handle.stat({ bigint: true });
      const identity = `${opened.dev}:${opened.ino}`;
      if (await fileIdentity(destination).catch(() => null) !== identity || !this.db.markComposerAssetFileIdentity(asset.asset_id, transferId, leaseId, identity)) {
        await handle.close();
        if (await fileIdentity(destination).catch(() => null) === identity) await rm(destination, { force: true });
        throw new ComposerTransferError(409, "附件接收状态已变化，请重试。");
      }
      const digest = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; digest.update(chunk); callback(null, chunk); } });
      await pipeline(createReadStream(temporary), meter, handle.createWriteStream());
      if (bytes !== item.size_bytes || digest.digest("hex") !== item.sha256 || await fileIdentity(destination) !== identity) {
        throw new ComposerTransferError(409, "草稿附件复制校验失败。");
      }
      return identity;
    }
    const final = await lstat(destination).catch(() => null);
    const copied = await lstat(temporary).catch(() => null);
    if (!sameFile(final, copied) || !final?.isFile() || final.isSymbolicLink() || final.size !== item.size_bytes || await digestFile(destination) !== item.sha256) {
      throw new ComposerTransferError(409, "草稿附件目标文件冲突。");
    }
    return fileIdentity(destination);
  }

  private assertLease(transferId: string, leaseId: string): void {
    if (!this.db.renewComposerAssetAdoptionLease(transferId, leaseId, new Date(Date.now() + LEASE_MS).toISOString())) {
      throw new ComposerTransferError(409, "附件接收状态已变化，请重试。");
    }
  }

  private async removePreparingFiles(asset: StoredComposerDraftAsset, item: StoredComposerTransferItem): Promise<void> {
    if (!STORAGE_NAME.test(asset.storage_name)) return;
    const destination = join(this.attachmentDirectory, asset.storage_name);
    const temporary = this.copyTempPath(asset);
    const source = await this.sourcePath(item);
    const destinationInfo = await lstat(destination).catch(() => null);
    const sourceInfo = source ? await lstat(source).catch(() => null) : null;
    const tempInfo = asset.copy_temp_owned ? await lstat(temporary).catch(() => null) : null;
    const recorded = asset.file_identity && destinationInfo?.isFile() && !destinationInfo.isSymbolicLink()
      ? await fileIdentity(destination).catch(() => null) === asset.file_identity : false;
    if (sameFile(destinationInfo, sourceInfo) || sameFile(destinationInfo, tempInfo) || recorded) await rm(destination, { force: true });
    if (asset.copy_temp_owned && tempInfo?.isFile() && !tempInfo.isSymbolicLink()) await rm(temporary, { force: true });
    if (source) await rm(source, { force: true });
  }

  private async cleanSourceFiles(transferId: string): Promise<void> {
    const adoption = this.db.getComposerAssetAdoption(transferId);
    const transfer = this.db.getComposerTransfer(transferId);
    if (!adoption || adoption.status !== "ready" || !transfer) return;
    for (const asset of this.db.listComposerDraftAssets(transferId)) {
      const item = transfer.items.find((candidate) => candidate.item_id === asset.item_id);
      if (!item) throw new Error("Missing transfer item");
      const destination = await this.requireDestination(asset, item);
      if (await digestFile(destination) !== item.sha256) throw new Error("Destination digest mismatch");
      const source = await this.sourcePath(item);
      if (source) await rm(source, { force: true });
      if (asset.copy_temp_owned) await rm(this.copyTempPath(asset), { force: true });
    }
    this.db.markComposerAssetSourcesCleaned(transferId);
  }

  private async removeDestination(asset: StoredComposerDraftAsset): Promise<void> {
    if (!STORAGE_NAME.test(asset.storage_name)) return;
    const path = join(this.attachmentDirectory, asset.storage_name);
    const info = await lstat(path).catch(() => null);
    if (info && info.isFile() && !info.isSymbolicLink()) {
      if (!asset.file_identity || await fileIdentity(path) !== asset.file_identity) throw new Error("草稿附件文件身份已变化，未清理。");
      await rm(path, { force: true });
    }
    if (/^composer_item_[a-f0-9-]{36}$/i.test(asset.asset_id)) {
      const root = await realpath(this.attachmentDirectory).catch(() => null);
      const directory = join(this.attachmentDirectory, ".composer-thumbnails");
      const actual = await realpath(directory).catch(() => null);
      if (root && actual && dirname(actual) === root) await rm(join(actual, `${asset.asset_id}.jpg`), { force: true });
    }
  }

  private async makeThumbnail(assetId: string, source: string): Promise<{ path: string; sizeBytes: number } | null> {
    if (!/^composer_item_[a-f0-9-]{36}$/i.test(assetId)) return null;
    const directory = join(this.attachmentDirectory, ".composer-thumbnails");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await realpath(this.attachmentDirectory).catch(() => null);
    const actual = await realpath(directory).catch(() => null);
    if (!root || !actual || dirname(actual) !== root) return null;
    const target = join(directory, `${assetId}.jpg`);
    const inspect = async (): Promise<{ path: string; sizeBytes: number } | null> => {
      const info = await lstat(target).catch(() => null);
      return info?.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 1024 * 1024 ? { path: target, sizeBytes: info.size } : null;
    };
    const cached = await inspect();
    if (cached) return cached;
    const temporary = join(directory, `.thumb-${randomUUID()}.jpg`);
    try {
      const converted = await runSipsThumbnail(source, temporary);
      if (!converted || !this.thumbnailAssetActive(assetId)) return null;
      const info = await lstat(temporary).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 1024 * 1024) return null;
      await chmod(temporary, 0o600);
      try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!this.thumbnailAssetActive(assetId)) {
        const targetInfo = await lstat(target).catch(() => null);
        const tempInfo = await lstat(temporary).catch(() => null);
        if (sameFile(targetInfo, tempInfo)) await rm(target, { force: true });
        return null;
      }
      return await inspect();
    } catch { return null; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  private thumbnailAssetActive(assetId: string): boolean {
    const asset = this.db.getComposerDraftAsset(assetId);
    return Boolean(asset && (asset.status === "retained" || (asset.status === "ready" && Date.parse(asset.expires_at) > Date.now())));
  }

  private runMaintenance(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.maintenance) return this.maintenance;
    const operation = this.maintain();
    this.maintenance = operation;
    void operation.finally(() => { if (this.maintenance === operation) this.maintenance = null; }).catch(() => {});
    return operation;
  }

  private async maintain(): Promise<void> {
    const now = new Date().toISOString();
    for (const adoption of this.db.listComposerAssetAdoptionsForRecovery(now)) {
      if (this.stopped) return;
      if (adoption.status === "ready") { await this.cleanSourceFiles(adoption.transfer_id).catch(() => {}); continue; }
      const target = this.db.getComposerTransferTarget(adoption.target_id);
      if (!target || target.status !== "claimed") { await this.discardCancelledTarget(adoption.target_id); continue; }
      if (Date.parse(adoption.created_at) + DRAFT_TTL_MS <= Date.now()) {
        this.db.cancelComposerTransferTarget(target.target_id);
        await this.discardCancelledTarget(target.target_id);
        continue;
      }
      const deviceId = target.device_id ?? "local";
      const deviceActive = deviceId === "local" || this.db.listWebAuthSessions().some((device) => device.sessionId === deviceId && device.revokedAt === null && Date.parse(device.expiresAt) > Date.now());
      if (!deviceActive) {
        this.db.cancelComposerTransferTarget(target.target_id);
        await this.discardCancelledTarget(target.target_id);
        continue;
      }
      const context = { sessionId: target.tmux_session_id, sessionCreatedAt: target.session_created_at, sessionRecordId: target.session_record_id, deviceId };
      await this.adopt(context, adoption.target_id, adoption.transfer_id).catch(() => {});
    }
    for (const asset of this.db.claimExpiredComposerDraftAssets(now)) {
      if (this.stopped) return;
      try { await this.removeDestination(asset); this.db.finishComposerDraftAssetCleanup(asset.asset_id); } catch { /* Retry on the next pass. */ }
    }
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>> | null, right: Awaited<ReturnType<typeof lstat>> | null): boolean {
  return Boolean(left && right && left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino);
}

async function fileIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new ComposerTransferError(409, "草稿附件不是普通文件。");
  return `${info.dev}:${info.ino}`;
}

async function runSipsThumbnail(source: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", "256", source, "--out", target], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    let settled = false;
    const finish = (success: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(success); };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}
