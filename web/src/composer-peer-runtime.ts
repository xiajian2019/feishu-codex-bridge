import { useSyncExternalStore } from "react";
import { Peer } from "peerjs";
import { COMPOSER_PEER_ID_STORAGE_KEY, createComposerPeerTransferToken } from "./composer-peer-transfer.js";

export const COMPOSER_PEER_TOKEN_STORAGE_KEY = "bridge:composer-peer-token:v1";

const PEER_OPTIONS = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
  debug: 0,
  config: { iceServers: [] },
};

export type ComposerPeerRuntimeSnapshot = {
  peer: Peer | null;
  peerId: string;
  token: string;
  status: "idle" | "connecting" | "ready" | "disconnected" | "error";
  error: string | null;
};

const EMPTY_SNAPSHOT: ComposerPeerRuntimeSnapshot = { peer: null, peerId: "", token: "", status: "idle", error: null };
let snapshot = EMPTY_SNAPSHOT;
let listeners = new Set<() => void>();
let peer: Peer | null = null;
let reconnectTimer: number | null = null;
let usedStoredId = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function setSnapshot(next: Partial<ComposerPeerRuntimeSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  notify();
}

function storageValue(key: string): string {
  try { return window.localStorage.getItem(key)?.trim() ?? ""; } catch { return ""; }
}

function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Private storage may be unavailable. */ }
}

function removeStorage(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* Private storage may be unavailable. */ }
}

function validPeerId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function validToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(value);
}

function createPeer(): void {
  usedStoredId = validPeerId(storageValue(COMPOSER_PEER_ID_STORAGE_KEY));
  const storedId = usedStoredId ? storageValue(COMPOSER_PEER_ID_STORAGE_KEY) : "";
  const token = validToken(storageValue(COMPOSER_PEER_TOKEN_STORAGE_KEY))
    ? storageValue(COMPOSER_PEER_TOKEN_STORAGE_KEY)
    : createComposerPeerTransferToken();
  writeStorage(COMPOSER_PEER_TOKEN_STORAGE_KEY, token);
  peer = storedId ? new Peer(storedId, PEER_OPTIONS) : new Peer(PEER_OPTIONS);
  setSnapshot({ peer, peerId: storedId, token, status: "connecting", error: null });
  peer.on("open", (id) => {
    writeStorage(COMPOSER_PEER_ID_STORAGE_KEY, id);
    setSnapshot({ peer, peerId: id, token, status: "ready", error: null });
  });
  peer.on("disconnected", () => {
    setSnapshot({ status: "disconnected", error: "PeerJS Cloud 已断开，正在重连…" });
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (peer && !peer.destroyed) peer.reconnect();
    }, 1000);
  });
  peer.on("error", (cause) => {
    if (cause.type === "unavailable-id" && usedStoredId && peer && !peer.destroyed) {
      removeStorage(COMPOSER_PEER_ID_STORAGE_KEY);
      peer.destroy();
      peer = null;
      snapshot = { ...EMPTY_SNAPSHOT, token, status: "connecting" };
      notify();
      createPeer();
      return;
    }
    setSnapshot({ status: "error", error: `PeerJS：${cause.message || cause.type || "连接失败"}` });
  });
}

function ensurePeer(): void {
  if (peer && !peer.destroyed) return;
  createPeer();
}

export function useComposerPeerRuntime(): ComposerPeerRuntimeSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      ensurePeer();
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => EMPTY_SNAPSHOT,
  );
}

export function composerPeerRuntimeSnapshot(): ComposerPeerRuntimeSnapshot {
  ensurePeer();
  return snapshot;
}
