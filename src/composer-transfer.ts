import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, truncate } from "node:fs/promises";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  StateDatabase,
  StoredComposerTransfer,
  StoredComposerTransferItem,
  StoredComposerTransferTarget,
} from "./db.js";

export const COMPOSER_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
const COMPOSER_TRANSFER_TTL_MS = 10 * 60 * 1_000;
const COMPOSER_TRANSFER_TEXT_LIMIT = 64 * 1024;
const COMPOSER_TRANSFER_MAX_ITEMS = 16;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class ComposerTransferError extends Error {
  public constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface ComposerTransferTargetResult {
  targetId: string;
  code: string;
  expiresAt: string;
}

export interface ComposerTransferClaimResult {
  transferId: string;
  transferToken: string;
  expiresAt: string;
  target: {
    sessionId: string;
    sessionCreatedAt: number;
    sessionName: string | null;
  };
}

export class ComposerTransferStore {
  private readonly db: StateDatabase;
  private readonly directory: string;
  private readonly activeWrites = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  public constructor(options: { db: StateDatabase; directory: string }) {
    this.db = options.db;
    this.directory = options.directory;
    this.cleanupTimer = setInterval(() => { void this.cleanupExpired(); }, 60_000);
    this.cleanupTimer.unref?.();
  }

  public async createTarget(input: {
    sessionRecordId: string;
    tmuxSessionId: string;
    sessionCreatedAt: number;
    deviceId: string | null;
  }): Promise<ComposerTransferTargetResult> {
    this.ensureAvailable();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = makeComposerTransferCode();
      const targetId = `composer_target_${randomUUID()}`;
      const expiresAt = new Date(Date.now() + COMPOSER_TRANSFER_TTL_MS).toISOString();
      try {
        this.db.createComposerTransferTarget({
          targetId,
          sessionRecordId: input.sessionRecordId,
          tmuxSessionId: input.tmuxSessionId,
          sessionCreatedAt: input.sessionCreatedAt,
          deviceId: input.deviceId,
          codeHash: hashToken(code),
          expiresAt,
        });
        return { targetId, code, expiresAt };
      } catch (error) {
        if (attempt === 4 || !(error instanceof Error) || !/UNIQUE|constraint/i.test(error.message)) throw error;
      }
    }
    throw new ComposerTransferError(503, "无法创建手机接收凭证，请重试。");
  }

  public claim(code: string, sourceDeviceId: string | null): ComposerTransferClaimResult {
    this.ensureAvailable();
    const normalizedCode = code.trim().replace(/[-\s]/g, "").toUpperCase();
    if (!/^[A-Z2-9]{8,32}$/.test(normalizedCode)) throw new ComposerTransferError(400, "手机接收码无效。");
    const target = this.db.getComposerTransferTargetByCodeHash(hashToken(normalizedCode));
    if (!target || target.status !== "waiting") throw new ComposerTransferError(404, "接收凭证不存在、已使用或已失效。");
    if (Date.parse(target.expires_at) <= Date.now()) {
      this.db.cancelComposerTransferTarget(target.target_id);
      throw new ComposerTransferError(410, "接收凭证已过期，请在 Composer 中重新生成。");
    }
    const session = this.db.getTmuxSession(target.session_record_id);
    const sessionName = session?.tmux_session_id === target.tmux_session_id && session.tmux_created_at === target.session_created_at
      ? session.session_name : null;
    const transferToken = randomBytes(32).toString("base64url");
    const transferId = `composer_transfer_${randomUUID()}`;
    const transfer = this.db.claimComposerTransferTarget({
      targetId: target.target_id,
      transferId,
      transferTokenHash: hashToken(transferToken),
      sourceDeviceId,
      expiresAt: target.expires_at,
    });
    if (!transfer) throw new ComposerTransferError(409, "接收凭证刚刚被其他设备使用，请重新生成。");
    return {
      transferId,
      transferToken,
      expiresAt: transfer.expires_at,
      target: { sessionId: target.tmux_session_id, sessionCreatedAt: target.session_created_at, sessionName },
    };
  }

  public setText(transferId: string, transferToken: string, value: unknown): StoredComposerTransfer {
    const transfer = this.authorizeTransfer(transferId, transferToken);
    if (typeof value !== "string") throw new ComposerTransferError(400, "文字内容无效。");
    const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
    if (Buffer.byteLength(text, "utf8") > COMPOSER_TRANSFER_TEXT_LIMIT) {
      throw new ComposerTransferError(413, "文字内容不能超过 64 KiB。");
    }
    return this.db.updateComposerTransferText(transfer.transfer_id, text)!;
  }

  public async createItem(transferId: string, transferToken: string, input: {
    fileName: unknown;
    contentType: unknown;
    sizeBytes: unknown;
    sha256?: unknown;
  }): Promise<StoredComposerTransferItem> {
    const transfer = this.authorizeTransfer(transferId, transferToken);
    if (transfer.items.length >= COMPOSER_TRANSFER_MAX_ITEMS) throw new ComposerTransferError(413, "一次最多传输 16 个文件。");
    const fileName = safeFileName(input.fileName);
    const contentType = normalizeContentType(input.contentType);
    if (!Number.isSafeInteger(input.sizeBytes) || Number(input.sizeBytes) <= 0) {
      throw new ComposerTransferError(400, "文件大小无效。");
    }
    const sha256 = input.sha256 === undefined || input.sha256 === null || input.sha256 === ""
      ? null
      : typeof input.sha256 === "string" && /^[a-f0-9]{64}$/i.test(input.sha256) ? input.sha256.toLowerCase() : null;
    if (input.sha256 !== undefined && input.sha256 !== null && input.sha256 !== "" && !sha256) {
      throw new ComposerTransferError(400, "文件校验值无效。");
    }
    const itemId = `composer_item_${randomUUID()}`;
    const itemDirectory = join(this.directory, transfer.transfer_id);
    const localPath = join(itemDirectory, itemId + extname(fileName).toLowerCase().slice(0, 16));
    await mkdir(itemDirectory, { recursive: true, mode: 0o700 });
    this.authorizeTransfer(transferId, transferToken);
    return this.db.createComposerTransferItem({
      itemId,
      transferId: transfer.transfer_id,
      fileName,
      contentType,
      sizeBytes: Number(input.sizeBytes),
      localPath,
      sha256,
    });
  }

  public async appendItem(transferId: string, transferToken: string, itemId: string, offset: number, source: Readable): Promise<StoredComposerTransferItem> {
    const transfer = this.authorizeTransfer(transferId, transferToken);
    const item = transfer.items.find((candidate) => candidate.item_id === itemId);
    if (!item) throw new ComposerTransferError(404, "上传文件不存在或已失效。");
    if (item.status === "ready") throw new ComposerTransferError(409, "文件已经上传完成。");
    if (!Number.isSafeInteger(offset) || offset !== item.received_bytes) throw new ComposerTransferError(409, "上传进度已变化，请重新读取进度。");
    if (this.activeWrites.has(itemId)) throw new ComposerTransferError(409, "该文件正在上传，请等待当前分片完成。");
    const expectedBytes = Math.min(COMPOSER_TRANSFER_CHUNK_BYTES, item.size_bytes - offset);
    if (expectedBytes <= 0) throw new ComposerTransferError(409, "文件已经上传完成。");
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    this.activeWrites.set(itemId, { controller, settled });
    let bytes = 0;
    const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      bytes += chunk.length;
      if (bytes > expectedBytes) return callback(new ComposerTransferError(413, "上传分片超过预期大小。"));
      callback(null, chunk);
    } });
    try {
      await pipeline(source, meter, createWriteStream(item.local_path, { flags: offset === 0 ? "w" : "r+", start: offset, mode: 0o600 }), { signal: controller.signal });
      if (bytes !== expectedBytes) throw new ComposerTransferError(400, "上传分片大小不正确。");
      this.authorizeTransfer(transferId, transferToken);
      return this.db.updateComposerTransferItemProgress(itemId, offset + bytes)!;
    } catch (error) {
      const target = this.db.getComposerTransferTarget(transfer.target_id);
      if (!target || target.status !== "claimed") await rm(item.local_path, { force: true }).catch(() => {});
      else await truncate(item.local_path, offset).catch(() => {});
      throw error;
    } finally {
      this.activeWrites.delete(itemId);
      settle();
    }
  }

  public async completeItem(transferId: string, transferToken: string, itemId: string): Promise<StoredComposerTransferItem> {
    const transfer = this.authorizeTransfer(transferId, transferToken);
    const item = transfer.items.find((candidate) => candidate.item_id === itemId);
    if (!item) throw new ComposerTransferError(404, "上传文件不存在或已失效。");
    if (item.status === "ready") return item;
    if (item.received_bytes !== item.size_bytes) throw new ComposerTransferError(409, "文件尚未上传完成。");
    const digest = createHash("sha256");
    try {
      for await (const chunk of createReadStream(item.local_path)) digest.update(chunk as Uint8Array);
      const sha256 = digest.digest("hex");
      if (item.sha256 && item.sha256 !== sha256) {
        return this.db.finishComposerTransferItem({ itemId, status: "failed", sha256, error: "文件校验失败。" })!;
      }
      return this.db.finishComposerTransferItem({ itemId, status: "ready", sha256 })!;
    } catch (error) {
      return this.db.finishComposerTransferItem({ itemId, status: "failed", error: error instanceof Error ? error.message : "文件校验失败。" })!;
    }
  }

  public finish(transferId: string, transferToken: string): StoredComposerTransfer {
    const transfer = this.authorizeTransfer(transferId, transferToken);
    if (!transfer.text.trim() && transfer.items.length === 0) throw new ComposerTransferError(400, "请输入文字或选择文件。");
    if (transfer.items.some((item) => item.status !== "ready")) throw new ComposerTransferError(409, "仍有文件未上传完成。");
    return this.db.markComposerTransferReady(transfer.transfer_id)!;
  }

  public listForTarget(targetId: string, sessionId: string, sessionCreatedAt: number, deviceId: string | null): StoredComposerTransfer[] {
    const storedTarget = this.db.getComposerTransferTarget(targetId);
    if (storedTarget?.status === "completed") {
      if (storedTarget.tmux_session_id !== sessionId || storedTarget.session_created_at !== sessionCreatedAt
        || (storedTarget.device_id ?? "local") !== (deviceId ?? "local")) {
        throw new ComposerTransferError(403, "此接收凭证属于另一台设备。");
      }
      return [];
    }
    const target = this.requireTarget(targetId, sessionId, sessionCreatedAt, deviceId);
    if (Date.parse(target.expires_at) <= Date.now()) {
      void this.expireTarget(target.target_id);
      return [];
    }
    return this.listTargetTransfers(target.target_id);
  }

  public getTargetItem(targetId: string, sessionId: string, sessionCreatedAt: number, deviceId: string | null, transferId: string, itemId: string): StoredComposerTransferItem {
    const target = this.requireTarget(targetId, sessionId, sessionCreatedAt, deviceId);
    const transfer = this.db.getComposerTransfer(transferId);
    if (!transfer || transfer.target_id !== target.target_id || transfer.status !== "ready") throw new ComposerTransferError(404, "传输内容不存在或已失效。");
    const item = transfer.items.find((candidate) => candidate.item_id === itemId);
    if (!item || item.status !== "ready") throw new ComposerTransferError(404, "传输文件不存在或尚未准备好。");
    return item;
  }

  public consumeTargetTransfer(targetId: string, sessionId: string, sessionCreatedAt: number, deviceId: string | null, transferId: string): StoredComposerTransfer {
    const target = this.requireTarget(targetId, sessionId, sessionCreatedAt, deviceId);
    const transfer = this.db.getComposerTransfer(transferId);
    if (!transfer || transfer.target_id !== target.target_id || transfer.status !== "ready") throw new ComposerTransferError(404, "传输内容不存在或尚未准备好。");
    if (this.db.getComposerAssetAdoption(transferId)?.status === "preparing") throw new ComposerTransferError(409, "附件正在加入草稿，请稍后重试。");
    const consumed = this.db.consumeComposerTransfer(transferId)!;
    void Promise.all(consumed.items.map((item) => rm(item.local_path, { force: true }).catch(() => {})));
    return consumed;
  }

  public async cancelTarget(targetId: string, sessionId: string, sessionCreatedAt: number, deviceId: string | null): Promise<void> {
    const target = this.requireTarget(targetId, sessionId, sessionCreatedAt, deviceId);
    const transfers = this.db.listComposerTransfersForTarget(target.target_id);
    if (!this.db.cancelComposerTransferTarget(target.target_id)) {
      const active = this.db.listComposerAssetAdoptionsForTarget(target.target_id).some((adoption) => adoption.status === "preparing" && adoption.lease_until && Date.parse(adoption.lease_until) > Date.now());
      if (active) throw new ComposerTransferError(409, "附件正在加入草稿，请稍后关闭。");
      throw new ComposerTransferError(410, "接收凭证已结束，请重新生成。");
    }
    const writes = transfers.flatMap((transfer) => transfer.items.flatMap((item) => {
      const active = this.activeWrites.get(item.item_id);
      return active ? [active] : [];
    }));
    for (const write of writes) write.controller.abort();
    await Promise.all(writes.map((write) => write.settled));
    await Promise.all(transfers.flatMap((transfer) => this.db.getComposerAssetAdoption(transfer.transfer_id)?.status === "preparing"
      ? [] : transfer.items.map((item) => rm(item.local_path, { force: true }))));
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    clearInterval(this.cleanupTimer);
    await this.cleanupExpired();
    this.disposed = true;
  }

  private authorizeTransfer(transferId: string, transferToken: string): StoredComposerTransfer {
    if (!transferToken || transferToken.length < 20) throw new ComposerTransferError(401, "手机传输凭证无效。");
    const transfer = this.db.getComposerTransferByTokenHash(hashToken(transferToken));
    if (!transfer || transfer.transfer_id !== transferId) throw new ComposerTransferError(401, "手机传输凭证无效或已失效。");
    const target = this.db.getComposerTransferTarget(transfer.target_id);
    if (this.db.getComposerAssetAdoption(transferId)?.status === "preparing") throw new ComposerTransferError(409, "附件正在加入草稿。");
    if (!target || target.status !== "claimed" || Date.parse(target.expires_at) <= Date.now()
      || Date.parse(transfer.expires_at) <= Date.now() || ["expired", "imported", "failed"].includes(transfer.status)) {
      throw new ComposerTransferError(410, "手机传输已结束或过期。");
    }
    return transfer;
  }

  private requireTarget(targetId: string, sessionId: string, sessionCreatedAt: number, deviceId: string | null): StoredComposerTransferTarget {
    const target = this.db.getComposerTransferTarget(targetId);
    if (!target || target.tmux_session_id !== sessionId || target.session_created_at !== sessionCreatedAt) {
      throw new ComposerTransferError(409, "目标 Session 已变化，请重新生成接收凭证。");
    }
    if ((target.device_id ?? "local") !== (deviceId ?? "local")) throw new ComposerTransferError(403, "此接收凭证属于另一台设备。");
    if (["expired", "cancelled", "completed"].includes(target.status)) throw new ComposerTransferError(410, "接收凭证已结束，请重新生成。");
    return target;
  }

  private listTargetTransfers(targetId: string): StoredComposerTransfer[] {
    // The database returns the transfer by id, so query the target's recent
    // transfer ids through the scoped helper rather than exposing the SQLite
    // handle to the transport layer.
    const candidates = this.db.listComposerTransfersForTarget(targetId);
    return candidates.filter((transfer) => transfer.status === "ready");
  }

  private async expireTarget(targetId: string): Promise<void> {
    const transfers = this.listTargetTransfers(targetId);
    for (const transfer of transfers) {
      if (!this.db.expireComposerTransfer(transfer.transfer_id)) continue;
      await Promise.all(transfer.items.map((item) => rm(item.local_path, { force: true })));
    }
  }

  private async cleanupExpired(): Promise<void> {
    if (this.disposed) return;
    const expired = this.db.listExpiredComposerTransfers(new Date().toISOString());
    for (const transfer of expired) {
      if (!this.db.expireComposerTransfer(transfer.transferId)) continue;
      await Promise.all(transfer.paths.map((path) => rm(path, { force: true }).catch(() => {})));
    }
  }

  private ensureAvailable(): void {
    if (this.disposed) throw new ComposerTransferError(503, "手机传输服务已停止。");
  }
}

function makeComposerTransferCode(): string {
  const bytes = randomBytes(10);
  let result = "";
  for (const byte of bytes) result += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return result.slice(0, 10);
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileName(value: unknown): string {
  const raw = typeof value === "string" ? value : "attachment";
  const normalized = raw.replaceAll("\\", "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  let result = normalized || "attachment";
  while (Buffer.byteLength(result, "utf8") > 180) result = result.slice(0, Math.max(1, result.length - 1));
  return result;
}

function normalizeContentType(value: unknown): string {
  const raw = typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(raw) ? raw : "application/octet-stream";
}
