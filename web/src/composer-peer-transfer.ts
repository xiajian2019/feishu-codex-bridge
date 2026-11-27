import type { DataConnection } from "peerjs";

export const COMPOSER_PEER_TRANSFER_VERSION = 1;
export const COMPOSER_PEER_TRANSFER_CHUNK_BYTES = 64 * 1024;
export const COMPOSER_PEER_TRANSFER_TEXT_BYTES = 64 * 1024;
export const COMPOSER_PEER_TRANSFER_MAX_FILES = 8;
export const COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const COMPOSER_PEER_TRANSFER_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const COMPOSER_PEER_TRANSFER_TIMEOUT_MS = 30_000;
export const COMPOSER_PEER_QR_KIND = "feishu-composer-peerjs";
export const COMPOSER_PEER_QR_VERSION = 1;
export const COMPOSER_PEER_ID_STORAGE_KEY = "bridge:composer-peer-id:v1";

export type ComposerPeerQrEnvelope = {
  version: typeof COMPOSER_PEER_QR_VERSION;
  kind: typeof COMPOSER_PEER_QR_KIND;
  peerId: string;
  token: string;
  origin: string;
  sessionName?: string;
};

export type ComposerPeerFileMeta = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
};

export type ComposerPeerTransferMessage =
  | { type: "hello"; version: number; token: string }
  | { type: "ready"; version: number }
  | { type: "offer"; version: number; text: string; files: ComposerPeerFileMeta[] }
  | { type: "file-start"; file: ComposerPeerFileMeta }
  | { type: "file-chunk"; fileId: string; offset: number; data: ArrayBuffer | Uint8Array }
  | { type: "chunk-ack"; fileId: string; offset: number }
  | { type: "file-end"; fileId: string }
  | { type: "file-ack"; fileId: string }
  | { type: "complete" }
  | { type: "complete-ack" }
  | { type: "error"; message: string };

export type ComposerPeerIncomingFile = {
  meta: ComposerPeerFileMeta;
  file: File;
};

export type ComposerPeerIncomingTransfer = {
  text: string;
  files: ComposerPeerIncomingFile[];
};

type PeerMessageWaiter = {
  predicate: (message: ComposerPeerTransferMessage) => boolean;
  resolve: (message: ComposerPeerTransferMessage) => void;
  reject: (error: Error) => void;
  timer: number;
};

/**
 * DataConnection's binary serializer carries control objects and ArrayBuffers
 * together. Keeping the framing here makes the sender and receiver share the
 * same validation and timeout behavior without involving Bridge HTTP APIs.
 */
export function sendComposerPeerMessage(connection: DataConnection, message: ComposerPeerTransferMessage): void {
  connection.send(message);
}

export function parseComposerPeerMessage(value: unknown): ComposerPeerTransferMessage | null {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || typeof (candidate as { type?: unknown }).type !== "string") return null;
  return candidate as ComposerPeerTransferMessage;
}

export function peerMessageBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export function createComposerPeerMessageInbox(): {
  accept: (value: unknown) => void;
  wait: (predicate: (message: ComposerPeerTransferMessage) => boolean, timeoutMs?: number) => Promise<ComposerPeerTransferMessage>;
  close: (error?: Error) => void;
} {
  const queue: ComposerPeerTransferMessage[] = [];
  const waiters: PeerMessageWaiter[] = [];
  let closed = false;

  const close = (error = new Error("PeerJS 连接已关闭。")): void => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) {
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    queue.length = 0;
  };

  const accept = (value: unknown): void => {
    const message = parseComposerPeerMessage(value);
    if (!message || closed) return;
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0]!;
      window.clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  };

  const wait = (predicate: (message: ComposerPeerTransferMessage) => boolean, timeoutMs = COMPOSER_PEER_TRANSFER_TIMEOUT_MS): Promise<ComposerPeerTransferMessage> => {
    if (closed) return Promise.reject(new Error("PeerJS 连接已关闭。"));
    const queuedIndex = queue.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]!);
    return new Promise<ComposerPeerTransferMessage>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("等待 PeerJS 对端响应超时。"));
      }, timeoutMs);
      const waiter: PeerMessageWaiter = { predicate, resolve, reject, timer };
      waiters.push(waiter);
    });
  };

  return { accept, wait, close };
}

export function createComposerPeerTransferToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function createComposerPeerTransferUrl(origin: string, peerId: string, token: string): string {
  const url = new URL("/composer-transfer", origin);
  url.searchParams.set("mode", "peerjs");
  url.searchParams.set("peer", peerId);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * WQDrop-compatible QR envelope. WQDrop keeps the wqdrop://pair route for
 * normal LAN pairing, so the Composer capability is distinguished by kind
 * inside the same URL-safe base64 JSON payload.
 */
export function createComposerPeerTransferQr(origin: string, peerId: string, token: string, sessionName?: string): string {
  const payload: ComposerPeerQrEnvelope = {
    version: COMPOSER_PEER_QR_VERSION,
    kind: COMPOSER_PEER_QR_KIND,
    peerId,
    token,
    origin: new URL(origin).origin,
    ...(sessionName?.trim() ? { sessionName: sessionName.trim().slice(0, 120) } : {}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const data = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `wqdrop://pair?data=${data}`;
}

export function parseComposerPeerTransferQr(value: string): ComposerPeerQrEnvelope | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "wqdrop:" || url.hostname !== "pair") return null;
  const encoded = url.searchParams.get("data") ?? "";
  if (!encoded || encoded.length > 8192) return null;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - encoded.length % 4) % 4);
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ComposerPeerQrEnvelope>;
    if (payload.version !== COMPOSER_PEER_QR_VERSION || payload.kind !== COMPOSER_PEER_QR_KIND
      || typeof payload.peerId !== "string" || typeof payload.token !== "string" || typeof payload.origin !== "string") return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(payload.peerId)
      || !/^[A-Za-z0-9_-]{20,128}$/.test(payload.token)) return null;
    const origin = new URL(payload.origin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
    return {
      version: COMPOSER_PEER_QR_VERSION,
      kind: COMPOSER_PEER_QR_KIND,
      peerId: payload.peerId,
      token: payload.token,
      origin: origin.origin,
      ...(typeof payload.sessionName === "string" && payload.sessionName.trim() ? { sessionName: payload.sessionName.trim().slice(0, 120) } : {}),
    };
  } catch {
    return null;
  }
}

export function validateComposerPeerOffer(text: string, files: ComposerPeerFileMeta[]): string | null {
  if (new TextEncoder().encode(text).byteLength > COMPOSER_PEER_TRANSFER_TEXT_BYTES) return "文字内容不能超过 64 KiB。";
  if (files.length > COMPOSER_PEER_TRANSFER_MAX_FILES) return `一次最多传输 ${COMPOSER_PEER_TRANSFER_MAX_FILES} 张图片。`;
  let total = 0;
  for (const file of files) {
    if (!file.id || file.id.length > 100 || !file.name || file.name.length > 255) return "图片信息无效。";
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES) {
      return `单张图片不能超过 ${formatComposerPeerBytes(COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES)}。`;
    }
    total += file.sizeBytes;
  }
  if (total > COMPOSER_PEER_TRANSFER_MAX_TOTAL_BYTES) return `图片总大小不能超过 ${formatComposerPeerBytes(COMPOSER_PEER_TRANSFER_MAX_TOTAL_BYTES)}。`;
  if (!text.trim() && files.length === 0) return "请输入文字或选择图片。";
  return null;
}

export function formatComposerPeerBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
