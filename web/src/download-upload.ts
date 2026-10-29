import { getActionToken } from "./api.js";
import { isMobileApp } from "./mobile-runtime.js";
import { uploadStep } from "./upload-step.js";

export interface DownloadUploadResult { fileName: string; filePath: string; sizeBytes: number }
export type DownloadUploadPhase = "preparing" | "creating" | "reading" | "uploading" | "confirming" | "saving";
export type UploadMetric =
  | { type: "created"; uploadId: string; sizeBytes: number; chunkBytes: number; elapsedMs: number }
  | { type: "chunk"; index: number; offset: number; bytes: number; attempts: number; elapsedMs: number }
  | { type: "completed"; sizeBytes: number; totalElapsedMs: number };
interface UploadStatus {
  id: string;
  offset: number;
  chunkBytes: number;
  protocol?: "offset" | "parts";
  partCount?: number;
  parts?: Array<{ index: number; sizeBytes: number; sha256?: string }>;
  result?: DownloadUploadResult;
}
const ROOT = "/api/download-uploads";
// Keep the browser request aligned with the server's bounded 8 MiB stream.
// The previous 1 MiB client cap made a 35 MiB file require 35 serial requests.
const CLIENT_CHUNK_BYTES = 8 * 1024 * 1024;

class UploadRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
function payload<T>(status: number, text: string): T {
  let value: (T & { error?: string }) | null = null;
  try { value = JSON.parse(text) as T & { error?: string }; } catch { /* Report invalid responses below. */ }
  if (status < 200 || status >= 300 || !value) throw new UploadRequestError(status, value?.error || `上传失败（${status}）。`);
  return value;
}
function request<T>(path: string, token: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  return uploadStep(async (signal) => {
    const response = await fetch(path, { ...init, signal, headers: { Accept: "application/json", "X-Bridge-Action-Token": token, ...init.headers } });
    return payload<T>(response.status, await response.text());
  }, { signal: init.signal ?? undefined, timeoutMs, message: "Mac 未及时响应，请检查连接后重试。" });
}

function sendChunk(path: string, token: string, bytes: ArrayBuffer, options: {
  signal: AbortSignal;
  onProgress: (loaded: number) => void;
  onSent: () => void;
}): Promise<UploadStatus> {
  if (typeof XMLHttpRequest === "undefined" || isMobileApp()) {
    return request<UploadStatus>(path, token, { method: "PUT", signal: options.signal,
      headers: { "Content-Type": "application/octet-stream" }, body: bytes }, 90_000);
  }
  // XHR exposes actual transmitted bytes; fetch only reports after the server responds.
  return uploadStep((signal) => new Promise<UploadStatus>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (value?: UploadStatus, error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      xhr.onload = xhr.onerror = xhr.onabort = null;
      xhr.upload.onprogress = xhr.upload.onload = null;
      if (error) reject(error); else resolve(value!);
    };
    const cancel = (): void => { xhr.abort(); finish(undefined, signal.reason); };
    xhr.open("PUT", path);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Bridge-Action-Token", token);
    xhr.upload.onprogress = (event) => options.onProgress(Math.min(event.loaded, bytes.byteLength));
    xhr.upload.onload = options.onSent;
    xhr.onload = () => {
      try { finish(payload<UploadStatus>(xhr.status, xhr.responseText)); }
      catch (error) { finish(undefined, error); }
    };
    xhr.onerror = () => finish(undefined, new TypeError("文件传输连接中断，请重试。"));
    xhr.onabort = () => finish(undefined, signal.reason ?? new DOMException("已取消上传。", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    try { xhr.send(bytes); } catch (error) { finish(undefined, error); }
  }), { signal: options.signal, timeoutMs: 90_000, message: "文件传输长时间没有完成，请检查网络后重试。" });
}

async function uploadParts(
  file: File,
  options: {
    signal: AbortSignal;
    onProgress: (bytes: number, saving: boolean) => void;
    onPhase?: (phase: DownloadUploadPhase) => void;
  },
  root: string,
  token: string,
  upload: UploadStatus,
  readChunk: (start: number, end: number) => Promise<ArrayBuffer>,
  emitMetric: (metric: UploadMetric) => void,
  startedAt: number,
): Promise<DownloadUploadResult> {
  const partSize = Math.min(upload.chunkBytes, CLIENT_CHUNK_BYTES);
  const partCount = upload.partCount ?? Math.ceil(file.size / partSize);
  const uploadedBytes = new Map<number, number>();
  for (const part of upload.parts ?? []) uploadedBytes.set(part.index, part.sizeBytes);
  const reportProgress = (saving = false): void => {
    let total = 0;
    for (const bytes of uploadedBytes.values()) total += bytes;
    options.onProgress(Math.min(total, file.size), saving);
  };
  reportProgress();
  let cursor = 0;
  const nextIndex = (): number | null => {
    while (cursor < partCount) {
      const index = cursor;
      cursor += 1;
      if (!uploadedBytes.has(index)) return index;
    }
    return null;
  };
  const worker = async (): Promise<void> => {
    while (true) {
      options.signal.throwIfAborted();
      const index = nextIndex();
      if (index === null) return;
      const start = index * partSize;
      const end = Math.min(start + partSize, file.size);
      options.onPhase?.("reading");
      const bytes = await readChunk(start, end);
      let accepted = false;
      let attempts = 0;
      const chunkStartedAt = performance.now();
      for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
        attempts = attempt + 1;
        options.onPhase?.("uploading");
        try {
          const status = await sendChunk(`${root}/${upload.id}/parts/${index}`, token, bytes, {
            signal: options.signal,
            onProgress: (loaded) => { uploadedBytes.set(index, Math.min(loaded, end - start)); reportProgress(); },
            onSent: () => options.onPhase?.("confirming"),
          });
          const part = status.parts?.find((candidate) => candidate.index === index);
          if (part?.sizeBytes === end - start || !status.parts) {
            uploadedBytes.set(index, end - start);
            reportProgress();
            accepted = true;
          }
        } catch (error) {
          options.signal.throwIfAborted();
          if (error instanceof UploadRequestError && ![409, 500, 502, 503, 504].includes(error.status)) throw error;
          if (attempt === 2) throw error;
          const status = await request<UploadStatus>(`${root}/${upload.id}`, token, { signal: options.signal });
          const part = status.parts?.find((candidate) => candidate.index === index);
          if (part?.sizeBytes === end - start) {
            uploadedBytes.set(index, end - start);
            reportProgress();
            accepted = true;
          }
        }
      }
      if (!accepted) throw new Error("上传分片未确认，请重试。");
      emitMetric({ type: "chunk", index, offset: start, bytes: end - start, attempts, elapsedMs: performance.now() - chunkStartedAt });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, Math.max(1, partCount)) }, () => worker()));
  options.signal.throwIfAborted();
  options.onPhase?.("saving");
  reportProgress(true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await request<DownloadUploadResult>(`${root}/${upload.id}/complete`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [...uploadedBytes.keys()].sort((left, right) => left - right) }),
      });
      emitMetric({ type: "completed", sizeBytes: file.size, totalElapsedMs: performance.now() - startedAt });
      return result;
    } catch (error) {
      if (error instanceof UploadRequestError && error.status < 500) throw error;
      const status = await request<UploadStatus>(`${root}/${upload.id}`, token).catch(() => null);
      if (status?.result) return status.result;
      if (attempt === 2) throw new Error("无法确认保存结果，请检查 Mac 的 Downloads 目录后再重试。");
    }
  }
  throw new Error("无法确认保存结果。");
}

export async function uploadFileInChunks(file: File, options: {
  endpoint?: string;
  signal: AbortSignal;
  onProgress: (bytes: number, saving: boolean) => void;
  onPhase?: (phase: DownloadUploadPhase) => void;
  onMetric?: (metric: UploadMetric) => void;
  parallel?: boolean;
}): Promise<DownloadUploadResult> {
  const root = options.endpoint ?? ROOT;
  // A desktop browser can afford one read-ahead chunk. Keep mobile at one
  // resident chunk because iOS WebViews are more aggressively memory-limited.
  const prefetchEnabled = !isMobileApp();
  const startedAt = performance.now();
  const emitMetric = (metric: UploadMetric): void => {
    try { options.onMetric?.(metric); } catch { /* Diagnostics must never interrupt an upload. */ }
  };
  const readChunk = (start: number, end: number): Promise<ArrayBuffer> => uploadStep(
    () => file.slice(start, end).arrayBuffer(),
    { signal: options.signal, timeoutMs: 45_000, message: "读取文件超时，请确认文件已下载到本机，再重新选择上传。" },
  );
  options.onPhase?.("preparing");
  const token = await uploadStep((signal) => getActionToken(signal), { signal: options.signal,
    timeoutMs: 15_000, message: "连接 Mac 超时，请检查连接后重试。" });
  options.onPhase?.("creating");
  const upload = await request<UploadStatus>(root, token, { method: "POST", signal: options.signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      fileName: file.name, sizeBytes: file.size, contentType: file.type, ...(options.parallel ? { protocol: "parts" } : {}),
    }) });
  emitMetric({ type: "created", uploadId: upload.id, sizeBytes: file.size, chunkBytes: Math.min(upload.chunkBytes, CLIENT_CHUNK_BYTES), elapsedMs: performance.now() - startedAt });
  let completed = false;
  let pendingRead: { start: number; end: number; promise: Promise<ArrayBuffer> } | null = null;
  try {
    if (!Number.isSafeInteger(upload.chunkBytes) || upload.chunkBytes <= 0) throw new Error("上传服务返回了无效配置。");
    if (options.parallel && upload.protocol === "parts") {
      const result = await uploadParts(file, options, root, token, upload, readChunk, emitMetric, startedAt);
      completed = true;
      return result;
    }
    let offset = upload.offset;
    while (offset < file.size) {
      options.signal.throwIfAborted();
      const end = Math.min(offset + Math.min(upload.chunkBytes, CLIENT_CHUNK_BYTES), file.size);
      let currentRead: { start: number; end: number; promise: Promise<ArrayBuffer> };
      if (pendingRead) {
        currentRead = pendingRead;
        pendingRead = null;
      } else {
        currentRead = { start: offset, end, promise: readChunk(offset, end) };
      }
      const chunkOffset = currentRead.start;
      options.onPhase?.("reading");
      // Read one bounded piece ahead while the current piece is in flight. At
      // most two chunks are resident, so this overlaps disk/iCloud reads with
      // network transfer without turning the upload into unbounded buffering.
      const bytes = await currentRead.promise;
      const nextStart: number = currentRead.end;
      if (prefetchEnabled && nextStart < file.size) {
        const nextEnd = Math.min(nextStart + Math.min(upload.chunkBytes, CLIENT_CHUNK_BYTES), file.size);
        const nextPromise = readChunk(nextStart, nextEnd);
        // Attach a rejection handler immediately; the promise is awaited on the
        // next iteration unless the current upload fails first.
        void nextPromise.catch(() => {});
        pendingRead = { start: nextStart, end: nextEnd, promise: nextPromise };
      }
      let accepted = false;
      let attempts = 0;
      const chunkStartedAt = performance.now();
      for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
        attempts = attempt + 1;
        options.onPhase?.("uploading");
        options.onProgress(offset, false);
        try {
          const status = await sendChunk(`${root}/${upload.id}?offset=${offset}`, token, bytes, {
            signal: options.signal, onProgress: (loaded) => options.onProgress(Math.min(offset + loaded, end), false),
            onSent: () => options.onPhase?.("confirming"),
          });
          if (status.offset !== end) throw new Error("上传进度不一致，请重新上传。");
          offset = status.offset;
          accepted = true;
        } catch (error) {
          options.signal.throwIfAborted();
          if (error instanceof UploadRequestError && ![409, 500, 502, 503, 504].includes(error.status)) throw error;
          if (attempt === 2) throw error;
          const status = await request<UploadStatus>(`${root}/${upload.id}`, token, { signal: options.signal });
          if (status.offset === end) { offset = end; accepted = true; }
          else if (status.offset !== offset) throw new Error("上传进度不一致，请重新上传。");
        }
      }
      emitMetric({ type: "chunk", index: Math.floor(chunkOffset / Math.min(upload.chunkBytes, CLIENT_CHUNK_BYTES)), offset: chunkOffset, bytes: end - chunkOffset, attempts, elapsedMs: performance.now() - chunkStartedAt });
      options.onProgress(offset, false);
    }
    options.signal.throwIfAborted();
    options.onPhase?.("saving");
    options.onProgress(file.size, true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await request<DownloadUploadResult>(`${root}/${upload.id}/complete`, token, { method: "POST" });
        completed = true;
        emitMetric({ type: "completed", sizeBytes: file.size, totalElapsedMs: performance.now() - startedAt });
        return result;
      } catch (error) {
        if (error instanceof UploadRequestError && error.status < 500) throw error;
        const status = await request<UploadStatus>(`${root}/${upload.id}`, token).catch(() => null);
        if (status?.result) { completed = true; return status.result; }
        if (attempt === 2) throw new Error("无法确认保存结果，请检查 Mac 的 Downloads 目录后再重试。");
      }
    }
    throw new Error("无法确认保存结果。");
  } finally {
    if (pendingRead) void pendingRead.promise.catch(() => {});
    // Cleanup must not keep a cancelled/failed upload stuck in the uploading state.
    if (!completed) void request(`${root}/${upload.id}`, token, { method: "DELETE", keepalive: true }, 5_000).catch(() => {});
  }
}

export function uploadToDownloads(file: File, options: Parameters<typeof uploadFileInChunks>[1]): Promise<DownloadUploadResult> {
  return uploadFileInChunks(file, options);
}
