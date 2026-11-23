import {
  isMobileApp, nearbyAddListener, nearbyConnect, nearbyGetNetworkInfo, nearbyListReceived,
  nearbyStartDiscovery, nearbyStartServer, nearbyTransferAvailable,
} from "./mobile-runtime.js";
import { NEARBY_DEFAULT_PORT } from "./nearby-transfer-contract.js";
import type {
  NearbyConnection, NearbyDiagnostic, NearbyFileOffer, NearbyFileProgress, NearbyNetworkInfo, NearbyPeer,
  NearbyReceivedFile, NearbyServerInfo,
} from "./nearby-transfer-contract.js";

export type NearbyTransferSessionStatus = "idle" | "starting" | "ready" | "unavailable" | "failed";

export interface NearbyTransferSessionSnapshot {
  status: NearbyTransferSessionStatus;
  available: boolean | null;
  server: NearbyServerInfo | null;
  network: NearbyNetworkInfo | null;
  peers: Record<string, NearbyPeer>;
  connections: Record<string, NearbyConnection>;
  offers: Record<string, NearbyFileOffer>;
  progress: Record<string, NearbyFileProgress>;
  received: NearbyReceivedFile[];
  diagnostics: NearbyDiagnostic[];
  error: string;
  notice: string;
}

const initialSnapshot: NearbyTransferSessionSnapshot = {
  status: "idle",
  available: null,
  server: null,
  network: null,
  peers: {},
  connections: {},
  offers: {},
  progress: {},
  received: [],
  diagnostics: [],
  error: "",
  notice: "",
};

let snapshot = initialSnapshot;
const subscribers = new Set<() => void>();
const connectionPeerKeys = new Map<string, string>();
const connectingPeerKeys = new Set<string>();
const acceptedWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: number }>();
let initialization: Promise<void> | null = null;
let listenersAttached = false;
let localDeviceId = "";

export function getNearbyTransferSessionSnapshot(): NearbyTransferSessionSnapshot { return snapshot; }

export function subscribeNearbyTransferSession(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function update(partial: Partial<NearbyTransferSessionSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  for (const listener of subscribers) listener();
}

function appendDiagnostic(event: NearbyDiagnostic): void {
  update({ diagnostics: [...snapshot.diagnostics, event].slice(-200) });
}

function recordDiagnostic(level: NearbyDiagnostic["level"], phase: string, message: string, connectionId?: string, transferId?: string): void {
  appendDiagnostic({ timestamp: Date.now(), level, phase, message, ...(connectionId ? { connectionId } : {}), ...(transferId ? { transferId } : {}) });
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function peerKey(peer: NearbyPeer): string {
  if (peer.deviceId) return `device:${peer.deviceId}`;
  if (peer.host) return `host:${peer.host}:${peer.port ?? NEARBY_DEFAULT_PORT}`;
  if (peer.id) return `id:${peer.id}`;
  return `name:${peer.name}`;
}

function connectionKey(connection: NearbyConnection): string {
  if (connection.peer.deviceId) return `device:${connection.peer.deviceId}`;
  return connectionPeerKeys.get(connection.id) ?? peerKey(connection.peer);
}

function isActiveConnection(connection: NearbyConnection): boolean {
  return connection.state === "connecting" || connection.state === "requested" || connection.state === "connected";
}

export function getNearbyConnectionForPeer(peer: NearbyPeer): NearbyConnection | null {
  const key = peerKey(peer);
  return Object.values(snapshot.connections).find((connection) => isActiveConnection(connection) && connectionKey(connection) === key) ?? null;
}

export function isNearbyPeerBusy(peer: NearbyPeer): boolean {
  return connectingPeerKeys.has(peerKey(peer)) || getNearbyConnectionForPeer(peer) !== null;
}

export async function ensureNearbyTransferSession(): Promise<void> {
  if (initialization) return initialization;
  initialization = initializeSession();
  return initialization;
}

async function attachListeners(): Promise<void> {
  if (listenersAttached) return;
  await nearbyAddListener("diagnostic", (event) => appendDiagnostic(event));
  await nearbyAddListener("error", ({ message, connectionId, transferId }) => {
    if (connectionId && transferId) rejectAcceptedWaiter(connectionId, transferId, new Error(message));
    update({ error: message });
  });
  await nearbyAddListener("peerFound", ({ peer }) => {
    if (peer.id === localDeviceId) return;
    const peers = { ...snapshot.peers };
    if (peer.deviceId) {
      for (const [id, existing] of Object.entries(peers)) {
        if (id !== peer.id && existing.deviceId === peer.deviceId) delete peers[id];
      }
    }
    peers[peer.id] = peer;
    update({ peers });
  });
  await nearbyAddListener("peerLost", ({ peer }) => {
    const peers = { ...snapshot.peers };
    delete peers[peer.id];
    update({ peers });
  });
  await nearbyAddListener("connectionState", ({ connection }) => {
    const previousKey = connectionPeerKeys.get(connection.id);
    const key = connectionKey(connection);
    if (connection.peer.deviceId) connectionPeerKeys.set(connection.id, key);
    if (connection.state === "connected") {
      connectingPeerKeys.delete(key);
      if (previousKey) connectingPeerKeys.delete(previousKey);
    }
    if (connection.state === "failed" || connection.state === "closed") {
      connectingPeerKeys.delete(key);
      if (previousKey) connectingPeerKeys.delete(previousKey);
      connectionPeerKeys.delete(connection.id);
    }
    update({ connections: { ...snapshot.connections, [connection.id]: connection } });
  });
  await nearbyAddListener("fileOffer", ({ offer }) => {
    update({ offers: { ...snapshot.offers, [`${offer.connectionId}:${offer.transferId}`]: offer } });
  });
  await nearbyAddListener("fileAccepted", ({ connectionId, transferId }) => {
    resolveAcceptedWaiter(connectionId, transferId);
  });
  await nearbyAddListener("fileProgress", ({ progress }) => {
    const key = `${progress.connectionId}:${progress.transferId}`;
    update({
      progress: { ...snapshot.progress, [key]: progress },
      ...(progress.direction === "receive" ? { notice: `正在接收 ${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}` } : {}),
    });
  });
  await nearbyAddListener("fileReceived", async ({ file, connectionId, transferId }) => {
    const offers = { ...snapshot.offers };
    delete offers[`${connectionId}:${transferId}`];
    update({ offers, notice: `已接收 ${file.fileName}` });
    await refreshNearbyReceived().catch((cause) => update({ error: errorMessage(cause, "读取接收文件失败。") }));
  });
  listenersAttached = true;
}

async function initializeSession(): Promise<void> {
  if (!isMobileApp()) {
    update({ status: "unavailable", available: false });
    return;
  }
  const supported = await nearbyTransferAvailable();
  if (!supported) {
    update({ status: "unavailable", available: false });
    return;
  }
  update({ status: "starting", available: true, error: "" });
  await attachListeners();
  recordDiagnostic("info", "web.setup.start", "开始启动附近传文件本机服务");

  const [serverResult, networkResult] = await Promise.allSettled([
    withTimeout(nearbyStartServer("", NEARBY_DEFAULT_PORT), 10_000, "启动本机服务超时（10 秒）。"),
    nearbyGetNetworkInfo(),
  ]);

  let serverReady = false;
  if (serverResult.status === "fulfilled") {
    localDeviceId = serverResult.value.deviceId;
    serverReady = true;
    recordDiagnostic("info", "web.setup.server_ready", `本机服务已返回 port=${serverResult.value.port}`);
    update({ server: serverResult.value });
  } else {
    const message = errorMessage(serverResult.reason, "附近传文件本机服务启动失败。");
    recordDiagnostic("error", "web.setup.server_failed", message);
    update({ error: message });
  }
  if (networkResult.status === "fulfilled") update({ network: networkResult.value });
  else {
    const message = errorMessage(networkResult.reason, "读取本机网络信息失败。");
    recordDiagnostic("error", "web.setup.network_failed", message);
    update({ error: message });
  }

  await refreshNearbyReceived().catch((cause) => {
    const message = errorMessage(cause, "读取接收文件失败。");
    recordDiagnostic("error", "web.setup.received_files_failed", message);
    update({ error: message });
  });
  recordDiagnostic("info", "web.setup.discovery_start", "开始启动附近设备发现");
  try {
    await nearbyStartDiscovery();
  } catch (cause) {
    const message = errorMessage(cause, "附近设备发现启动失败。");
    recordDiagnostic("error", "web.setup.discovery_failed", message);
    update({ error: message });
  }
  update({ status: serverReady ? "ready" : "failed" });
}

export async function connectNearbyPeer(peer: NearbyPeer): Promise<{ connectionId?: string; alreadyConnected: boolean }> {
  await ensureNearbyTransferSession();
  const key = peerKey(peer);
  if (isNearbyPeerBusy(peer)) return { alreadyConnected: true };
  connectingPeerKeys.add(key);
  try {
    const result = await nearbyConnect({ peerId: peer.id, token: peer.token, name: peer.name, source: peer.source });
    connectionPeerKeys.set(result.connectionId, key);
    return { connectionId: result.connectionId, alreadyConnected: false };
  } catch (cause) {
    connectingPeerKeys.delete(key);
    throw cause;
  }
}

export async function connectNearbyHost(host: string, port: number): Promise<{ connectionId?: string; alreadyConnected: boolean }> {
  await ensureNearbyTransferSession();
  const peer: NearbyPeer = { id: host, name: "iPhone 热点", host, port, source: "hotspot" };
  if (isNearbyPeerBusy(peer)) return { alreadyConnected: true };
  connectingPeerKeys.add(peerKey(peer));
  try {
    const result = await nearbyConnect({ host, port, name: peer.name, source: peer.source });
    connectionPeerKeys.set(result.connectionId, peerKey(peer));
    return { connectionId: result.connectionId, alreadyConnected: false };
  } catch (cause) {
    connectingPeerKeys.delete(peerKey(peer));
    throw cause;
  }
}

export async function waitForNearbyFileAccepted(connectionId: string, transferId: string, timeoutMs = 60_000): Promise<void> {
  const key = `${connectionId}:${transferId}`;
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      acceptedWaiters.delete(key);
      reject(new Error("等待对方接受文件超时。"));
    }, timeoutMs);
    acceptedWaiters.set(key, { resolve, reject, timer });
  });
}

function resolveAcceptedWaiter(connectionId: string, transferId: string): void {
  const key = `${connectionId}:${transferId}`;
  const waiter = acceptedWaiters.get(key);
  if (!waiter) return;
  window.clearTimeout(waiter.timer);
  acceptedWaiters.delete(key);
  waiter.resolve();
}

function rejectAcceptedWaiter(connectionId: string, transferId: string, cause: Error): void {
  const key = `${connectionId}:${transferId}`;
  const waiter = acceptedWaiters.get(key);
  if (!waiter) return;
  window.clearTimeout(waiter.timer);
  acceptedWaiters.delete(key);
  waiter.reject(cause);
}

export async function refreshNearbyReceived(): Promise<NearbyReceivedFile[]> {
  const received = await nearbyListReceived();
  update({ received });
  return received;
}

export function clearNearbyTransferError(): void { update({ error: "" }); }

export function removeNearbyOffer(connectionId: string, transferId: string): void {
  const offers = { ...snapshot.offers };
  delete offers[`${connectionId}:${transferId}`];
  update({ offers });
}

export async function refreshNearbyDiscovery(): Promise<void> {
  update({ peers: {} });
  await nearbyStartDiscovery();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (cause: unknown) => { window.clearTimeout(timer); reject(cause); });
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
