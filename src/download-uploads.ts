import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, open, rename, rm, truncate } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sanitizeLinkToolFileName } from "./link-tools.js";

export const DOWNLOAD_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
export type DownloadUploadProtocol = "offset" | "parts";

export class DownloadUploadError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

export interface DownloadUploadResult { fileName: string; filePath: string; sizeBytes: number }
interface Upload {
  id: string;
  owner: string;
  fileName: string;
  sizeBytes: number;
  protocol: DownloadUploadProtocol;
  partCount: number;
  offset: number;
  directory: string;
  path: string;
  touchedAt: number;
  operation?: Promise<unknown>;
  completion?: Promise<DownloadUploadResult>;
  controller?: AbortController;
  partOperations: Map<number, Promise<unknown>>;
  parts: Map<number, UploadPart>;
  cancelled?: boolean;
  result?: DownloadUploadResult;
}

interface UploadPart {
  index: number;
  sizeBytes: number;
  sha256: string;
  path: string;
}

/** Only a bounded chunk is in flight; the complete file has no application size ceiling. */
export class DownloadUploadsService {
  private readonly uploads = new Map<string, Upload>();
  private readonly directory: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: { directory?: string } = {}) {
    this.directory = options.directory ?? join(homedir(), "Downloads");
    this.timer = setInterval(() => {
      for (const item of this.uploads.values()) {
        if (!item.operation && item.partOperations.size === 0 && Date.now() - item.touchedAt > UPLOAD_TTL_MS) {
          void this.cancel(item.id, item.owner).catch(() => {});
        }
      }
    }, 60_000);
    this.timer.unref?.();
  }

  async create(owner: string, fileName: unknown, sizeBytes: unknown, protocol: DownloadUploadProtocol = "offset") {
    if (this.closed) throw new DownloadUploadError(503, "上传服务已停止。");
    if (typeof fileName !== "string" || !fileName.trim()) throw new DownloadUploadError(400, "请选择文件。");
    if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0) throw new DownloadUploadError(400, "文件大小无效。");
    await mkdir(this.directory, { recursive: true });
    if (protocol !== "offset" && protocol !== "parts") throw new DownloadUploadError(400, "上传协议无效。");
    const directory = await mkdtemp(join(this.directory, ".bridge-upload-"));
    try {
      const path = join(directory, "content");
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      if (protocol === "parts") await mkdir(join(directory, "parts"), { mode: 0o700 });
      if (this.closed) throw new DownloadUploadError(503, "上传服务已停止。");
      const normalizedSize = Number(sizeBytes);
      const item: Upload = { id: randomUUID(), owner, fileName: safeFileName(fileName), sizeBytes: normalizedSize,
        protocol, partCount: Math.ceil(normalizedSize / DOWNLOAD_UPLOAD_CHUNK_BYTES), offset: 0, directory, path,
        touchedAt: Date.now(), partOperations: new Map(), parts: new Map() };
      this.uploads.set(item.id, item);
      return this.view(item);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  status(id: string, owner: string) { return this.view(this.require(id, owner)); }

  async appendPart(id: string, owner: string, index: number, source: Readable, authorized: () => boolean = () => true) {
    const item = this.require(id, owner);
    if (item.protocol !== "parts") throw new DownloadUploadError(409, "该上传任务不支持并行分片。");
    if (!Number.isSafeInteger(index) || index < 0 || index >= item.partCount) throw new DownloadUploadError(400, "上传分片序号无效。");
    if (item.result) throw new DownloadUploadError(409, "该文件已上传完成。");
    const expectedBytes = Math.min(DOWNLOAD_UPLOAD_CHUNK_BYTES, item.sizeBytes - index * DOWNLOAD_UPLOAD_CHUNK_BYTES);
    const existing = item.parts.get(index);
    if (existing) {
      // A response can be lost after the server committed the part. Drain the
      // retry body before returning so the HTTP keep-alive connection remains usable.
      let duplicateBytes = 0;
      for await (const chunk of source) {
        if (!authorized()) throw new DownloadUploadError(401, "设备授权已失效。");
        duplicateBytes += Buffer.byteLength(chunk as Uint8Array);
        if (duplicateBytes > existing.sizeBytes) throw new DownloadUploadError(413, "重复上传分片超出预期大小。");
      }
      if (duplicateBytes !== existing.sizeBytes) throw new DownloadUploadError(400, "重复上传分片大小不正确。");
      return this.view(item);
    }
    if (item.partOperations.has(index)) throw new DownloadUploadError(409, "该分片正在上传。");
    const partsDirectory = join(item.directory, "parts");
    const finalPath = join(partsDirectory, `${String(index).padStart(8, "0")}.part`);
    const tempPath = join(partsDirectory, `${String(index).padStart(8, "0")}.${randomUUID()}.part`);
    const operation = (async () => {
      let bytes = 0;
      const digest = createHash("sha256");
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        if (!authorized()) return callback(new DownloadUploadError(401, "设备授权已失效。"));
        bytes += chunk.length;
        if (bytes > expectedBytes) return callback(new DownloadUploadError(413, "当前上传分片超出预期大小。"));
        digest.update(chunk);
        callback(null, chunk);
      } });
      try {
        await pipeline(source, meter, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
        if (bytes !== expectedBytes) throw new DownloadUploadError(400, "上传分片大小不正确。");
        await rename(tempPath, finalPath);
        item.parts.set(index, { index, sizeBytes: bytes, sha256: digest.digest("hex"), path: finalPath });
        item.touchedAt = Date.now();
        return this.view(item);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    })();
    item.partOperations.set(index, operation);
    try { return await operation; }
    finally { item.partOperations.delete(index); }
  }

  async append(id: string, owner: string, offset: number, source: Readable, authorized: () => boolean = () => true) {
    const item = this.require(id, owner);
    if (item.operation || item.result) throw new DownloadUploadError(409, "该文件正在处理或已上传完成。");
    if (!Number.isSafeInteger(offset) || offset !== item.offset) throw new DownloadUploadError(409, "上传进度已变化，请重新读取进度。");
    item.controller = new AbortController();
    const controller = item.controller;
    const operation = (async () => {
      let bytes = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        if (!authorized()) return callback(new DownloadUploadError(401, "设备授权已失效。"));
        bytes += chunk.length;
        if (bytes > DOWNLOAD_UPLOAD_CHUNK_BYTES || offset + bytes > item.sizeBytes) {
          return callback(new DownloadUploadError(413, "当前上传数据超出预期，请重试。"));
        }
        callback(null, chunk);
      } });
      try {
        await pipeline(source, meter, createWriteStream(item.path, { flags: "r+", start: offset }), { signal: controller.signal });
        if (!bytes) throw new DownloadUploadError(400, "未收到文件数据。");
        item.offset += bytes;
        item.touchedAt = Date.now();
        return this.view(item);
      } catch (error) {
        await truncate(item.path, offset);
        throw error;
      }
    })();
    item.operation = operation;
    try { return await operation; }
    finally { item.operation = undefined; item.controller = undefined; }
  }

  async complete(id: string, owner: string): Promise<DownloadUploadResult> {
    const item = this.require(id, owner);
    if (item.result) return item.result;
    if (item.completion) return item.completion;
    if (item.protocol === "parts") return this.completeParts(item);
    if (item.operation || item.offset !== item.sizeBytes) throw new DownloadUploadError(409, "文件尚未上传完成。");
    const operation = (async () => {
      return this.finalize(item);
    })();
    item.operation = operation;
    item.completion = operation;
    try { return await operation; } finally { item.operation = undefined; item.completion = undefined; }
  }

  async cancel(id: string, owner: string): Promise<void> {
    const item = this.uploads.get(id);
    if (!item || item.owner !== owner) return;
    item.cancelled = true;
    item.controller?.abort();
    await item.operation?.catch(() => {});
    await Promise.all([...item.partOperations.values()].map((operation) => operation.catch(() => {})));
    await rm(item.directory, { recursive: true, force: true });
    this.uploads.delete(id);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([...this.uploads.values()].map((item) => this.cancel(item.id, item.owner)));
  }

  private require(id: string, owner: string): Upload {
    const item = this.uploads.get(id);
    if (this.closed || !item || item.owner !== owner || item.cancelled) throw new DownloadUploadError(404, "上传记录不存在或已过期，请重新上传。");
    return item;
  }

  private view(item: Upload) {
    return { id: item.id, fileName: item.fileName, sizeBytes: item.sizeBytes, offset: item.offset,
      protocol: item.protocol, chunkBytes: DOWNLOAD_UPLOAD_CHUNK_BYTES, partCount: item.partCount,
      ...(item.protocol === "parts" ? { parts: [...item.parts.values()]
        .sort((left, right) => left.index - right.index)
        .map(({ index, sizeBytes, sha256 }) => ({ index, sizeBytes, sha256 })) } : {}),
      ...(item.result ? { result: item.result } : {}) };
  }

  private async completeParts(item: Upload): Promise<DownloadUploadResult> {
    if (item.partOperations.size > 0 || item.parts.size !== item.partCount) {
      throw new DownloadUploadError(409, "文件尚未上传完成。");
    }
    const operation = (async () => {
      await truncate(item.path, 0);
      let offset = 0;
      for (let index = 0; index < item.partCount; index += 1) {
        const part = item.parts.get(index);
        if (!part) throw new DownloadUploadError(409, "上传分片不完整。");
        await pipeline(createReadStream(part.path), createWriteStream(item.path, { flags: index === 0 ? "w" : "r+", start: offset }));
        offset += part.sizeBytes;
      }
      return this.finalize(item);
    })();
    item.operation = operation;
    item.completion = operation;
    try { return await operation; }
    finally { item.operation = undefined; item.completion = undefined; }
  }

  private async finalize(item: Upload): Promise<DownloadUploadResult> {
    const extension = extname(item.fileName);
    const stem = item.fileName.slice(0, item.fileName.length - extension.length);
    for (let index = 0; index < 10_000; index += 1) {
      const fileName = index ? `${stem} (${index})${extension}` : item.fileName;
      const filePath = join(this.directory, fileName);
      try { await link(item.path, filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      item.result = { fileName, filePath, sizeBytes: item.sizeBytes };
      item.touchedAt = Date.now();
      await rm(item.directory, { recursive: true, force: true });
      return item.result;
    }
    throw new DownloadUploadError(409, "同名文件过多，请更换文件名。");
  }
}

function safeFileName(value: string): string {
  const normalized = sanitizeLinkToolFileName(value);
  // Leave space for collision suffixes within macOS's 255-byte filename limit.
  let result = "";
  for (const character of normalized) {
    if (Buffer.byteLength(result + character) > 220) break;
    result += character;
  }
  return result || "upload";
}
