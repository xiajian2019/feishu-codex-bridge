import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { Link } from "react-router";
import * as QRCode from "qrcode";
import {
  nearbyAcceptConnection, nearbyAcceptFile, nearbyBeginFile, nearbyDeleteReceived, nearbyRejectConnection,
  nearbyPickFile, nearbyRejectFile, nearbySendFile, copyMobileText, isMobileApp, openNearbyReceived, scanMobilePairingQr, shareNearbyReceived,
  type NearbyConnection, type NearbyFileOffer, type NearbyFileSelection, type NearbyPeer,
} from "./mobile-runtime.js";
import {
  cancelNearbyFileAccepted, clearNearbyTransferError, connectNearbyHost, connectNearbyPeer, connectNearbyQr, ensureNearbyTransferSession,
  getNearbyConnectionForPeer, getNearbyTransferSessionSnapshot, isNearbyPeerBusy, refreshNearbyDiscovery,
  markNearbyOfferAccepted, refreshNearbyNetwork, refreshNearbyReceived, removeNearbyOffer, subscribeNearbyTransferSession, waitForNearbyFileAccepted, waitForNearbyFileCompleted,
} from "./nearby-transfer-session.js";
import { createNearbyPairingUrl, parseNearbyPairingUrl } from "./nearby-pairing.js";
import { decodePairingImage } from "./pairing-qr.js";
import "./nearby-transfer.css";

export function NearbyTransferPage(): ReactElement {
  const session = useSyncExternalStore(subscribeNearbyTransferSession, getNearbyTransferSessionSnapshot, getNearbyTransferSessionSnapshot);
  const { available, server, network, peers, connections, offers, progress, received, diagnostics } = session;
  const [hotspotHost, setHotspotHost] = useState(network?.gateway ?? "");
  const [hotspotPort, setHotspotPort] = useState(String(server?.port ?? 43_891));
  const previousGateway = useRef(network?.gateway ?? "");
  const qrImageInput = useRef<HTMLInputElement>(null);
  const [pairingQr, setPairingQr] = useState("");
  const [selectedFile, setSelectedFile] = useState<NearbyFileSelection | null>(null);
  const [sending, setSending] = useState<{ transferId: string; connectionId: string; bytes: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [diagnosticsClearedAt, setDiagnosticsClearedAt] = useState(0);
  const displayedError = error || session.error;
  const displayedNotice = notice || session.notice;

  const connected = useMemo(() => uniqueConnections(Object.values(connections).filter((item) => item.state === "connected")), [connections]);
  const pendingConnections = useMemo(() => uniqueConnections(Object.values(connections).filter((item) => item.state === "requested")), [connections]);
  const connectionProblems = useMemo(() => Object.values(connections).filter((item) => item.state === "connecting" || item.state === "failed"), [connections]);
  const visibleDiagnostics = useMemo(() => diagnostics.filter((item) => item.timestamp > diagnosticsClearedAt), [diagnostics, diagnosticsClearedAt]);
  const diagnosticText = useMemo(() => visibleDiagnostics.map((item) => {
    const time = new Date(item.timestamp).toLocaleTimeString();
    const context = [item.connectionId ? `connection=${item.connectionId}` : "", item.transferId ? `transfer=${item.transferId}` : ""].filter(Boolean).join(" ");
    return `${time} [${item.level}] ${item.phase} ${context}${context ? " " : ""}${item.message}`;
  }).join("\n"), [visibleDiagnostics]);

  useEffect(() => {
    void ensureNearbyTransferSession().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "附近传文件初始化失败。"));
  }, []);

  useEffect(() => {
    const nextGateway = network?.gateway ?? "";
    setHotspotHost((value) => !value || value === previousGateway.current ? nextGateway : value);
    previousGateway.current = nextGateway;
    if (server?.port && hotspotPort === "43891") setHotspotPort(String(server.port));
  }, [hotspotPort, network?.gateway, server?.port]);

  useEffect(() => { setPairingQr(""); }, [server?.deviceId, server?.port, server?.token, network?.addresses.join(",")]);

  useEffect(() => {
    if (!sending) return;
    const current = progress[`${sending.connectionId}:${sending.transferId}`];
    if (!current || current.direction !== "send") return;
    setSending((previous) => previous && previous.transferId === sending.transferId
      ? { ...previous, bytes: current.bytes, total: current.totalBytes }
      : previous);
  }, [progress, sending?.connectionId, sending?.transferId]);

  async function connectPeer(peer: NearbyPeer): Promise<void> {
    setBusy(true); setError(""); clearNearbyTransferError();
    try {
      const result = await connectNearbyPeer(peer);
      setNotice(result.alreadyConnected ? `${peer.name} 已连接或正在连接。` : `正在连接 ${peer.name}…`);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "附近设备连接失败。"); }
    finally { setBusy(false); }
  }

  async function connectHotspot(): Promise<void> {
    const host = hotspotHost.trim();
    const port = Number(hotspotPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) { setError("请输入有效的热点网关和端口。"); return; }
    setBusy(true); setError(""); clearNearbyTransferError();
    try {
      const result = await connectNearbyHost(host, port);
      setNotice(result.alreadyConnected ? `热点 ${host}:${port} 已连接或正在连接。` : `正在连接热点 ${host}:${port}…`);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "热点直连失败。"); }
    finally { setBusy(false); }
  }

  async function showPairingQr(): Promise<void> {
    setBusy(true); setError(""); clearNearbyTransferError();
    try {
      await ensureNearbyTransferSession();
      const current = getNearbyTransferSessionSnapshot().server;
      if (!current) throw new Error("本机附近传文件服务尚未启动，请刷新后重试。");
      const currentNetwork = await refreshNearbyNetwork();
      const value = createNearbyPairingUrl(current, currentNetwork);
      setPairingQr(await QRCode.toDataURL(value, { width: 280, margin: 2 }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "生成附近设备二维码失败。"); }
    finally { setBusy(false); }
  }

  async function connectPairingValue(value: string): Promise<void> {
    const info = parseNearbyPairingUrl(value);
    setNotice(`正在连接 ${info.name}，请保持双方 App 前台…`);
    try {
      const result = await connectNearbyQr(info);
      setNotice(result.alreadyConnected ? `${info.name} 已连接或正在连接。` : `已向 ${info.name} 发送连接请求。`);
    } catch (error) { setNotice(""); throw error; }
  }

  async function scanPairingQr(): Promise<void> {
    setBusy(true); setError(""); clearNearbyTransferError();
    try {
      const value = await scanMobilePairingQr("扫描另一台设备的附近传文件二维码");
      if (value) await connectPairingValue(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "扫码连接失败。"); }
    finally { setBusy(false); }
  }

  async function readPairingImage(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy(true); setError(""); clearNearbyTransferError();
    try { await connectPairingValue(await decodePairingImage(file)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "识别二维码失败。"); }
    finally { setBusy(false); }
  }

  async function acceptConnection(connection: NearbyConnection): Promise<void> {
    try { await nearbyAcceptConnection(connection.id); setNotice(`已接受 ${connection.peer.name} 的连接。`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "接受连接失败。"); }
  }

  async function rejectConnection(connection: NearbyConnection): Promise<void> {
    try { await nearbyRejectConnection(connection.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "拒绝连接失败。"); }
  }

  async function acceptOffer(offer: NearbyFileOffer): Promise<void> {
    try { await nearbyAcceptFile(offer.connectionId, offer.transferId); markNearbyOfferAccepted(offer.connectionId, offer.transferId); setNotice(`已接受 ${offer.fileName}，等待文件传输…`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "接受文件失败。"); }
  }

  async function pickFile(): Promise<void> {
    try {
      const selection = await nearbyPickFile();
      setSelectedFile(selection);
      setNotice(`已选择 ${selection.fileName}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "选择文件失败。"); }
  }

  async function rejectOffer(offer: NearbyFileOffer): Promise<void> {
    try {
      await nearbyRejectFile(offer.connectionId, offer.transferId);
      removeNearbyOffer(offer.connectionId, offer.transferId);
      setNotice(offer.accepted ? `已取消接收 ${offer.fileName} 并断开连接。` : `已拒绝 ${offer.fileName}。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "拒绝文件失败。"); }
  }

  async function openReceivedFile(file: import("./nearby-transfer-contract.js").NearbyReceivedFile): Promise<void> {
    try {
      await openNearbyReceived(file);
      setNotice(`正在打开 ${file.fileName}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "打开接收文件失败。"); }
  }

  async function sendFile(connectionId: string): Promise<void> {
    if (!selectedFile || sending) return;
    const file = selectedFile;
    const transferId = crypto.randomUUID();
    const verifiedTransfer = connections[connectionId]?.verifiedTransfer === true;
    setSending({ transferId, connectionId, bytes: 0, total: file.size }); setError("");
    try {
      const accepted = waitForNearbyFileAccepted(connectionId, transferId);
      void accepted.catch(() => {});
      await nearbyBeginFile({ connectionId, transferId, selectionId: file.selectionId });
      await accepted;
      await nearbySendFile({ connectionId, transferId, selectionId: file.selectionId });
      if (verifiedTransfer) await waitForNearbyFileCompleted(connectionId, transferId);
      setSending({ transferId, connectionId, bytes: file.size, total: file.size });
      setNotice(verifiedTransfer ? `对方已接收并校验 ${file.fileName}` : `已发送 ${file.fileName}；对方版本不支持接收确认，请在对方设备检查。`);
      setSelectedFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "文件发送失败。");
    } finally { cancelNearbyFileAccepted(connectionId, transferId); setSending(null); }
  }

  async function copyDiagnostics(): Promise<void> {
    if (!diagnosticText) return;
    try {
      await copyMobileText(diagnosticText);
      setNotice("诊断日志已复制。可以直接粘贴给开发者分析。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复制诊断日志失败。");
    }
  }

  if (!isMobileApp()) return <main className="page-main nearby-transfer-page"><header className="workbench-page-header"><div><h1>附近传文件</h1><p>此能力仅在 Capacitor 手机 App 中提供。</p></div><Link to="/tasks">返回</Link></header></main>;
  if (available === false) return <main className="page-main nearby-transfer-page"><header className="workbench-page-header"><div><h1>附近传文件</h1><p>当前 App 未包含附近传输原生插件，请重新构建移动包。</p></div><Link to="/tasks">返回</Link></header></main>;

  return <main className="page-main nearby-transfer-page">
    <header className="workbench-page-header"><div><h1>附近传文件</h1><p>通过 Wi‑Fi 自动发现设备；找不到时可扫码或通过热点地址连接。双方保持 App 前台。</p></div><Link to="/tasks">返回工作页</Link></header>
    {displayedError ? <p className="nearby-transfer-error" role="alert">{displayedError}</p> : null}
    {displayedNotice ? <p className="nearby-transfer-notice" role="status">{displayedNotice}</p> : null}
    <section className="nearby-transfer-card" aria-label="本机附近传文件服务">
      <div className="nearby-transfer-card-header"><div><h2>本机服务</h2><p>{server ? `${server.displayName} · TCP ${server.port}` : session.status === "failed" ? "启动失败，请刷新重试" : "正在启动…"}</p></div><button type="button" disabled={busy} onClick={() => void refreshNearbyDiscovery().catch((cause) => setError(cause instanceof Error ? cause.message : "刷新发现失败。"))}>刷新发现</button></div>
      <p className="nearby-transfer-muted">连接和服务由 App 全局会话维持，离开此页或打开文件选择器不会主动断开。收到文件会先保存到 App 私有缓存，不会自动执行或上传。当前文件连接未加密，请在可信网络使用。</p>
      <div className="nearby-transfer-hotspot"><strong>热点或手动直连</strong><div className="nearby-transfer-form"><label>热点网关或设备地址<input value={hotspotHost} onChange={(event) => setHotspotHost(event.target.value)} placeholder={network?.gateway ?? "例如 172.20.x.1"} /></label><label>端口<input inputMode="numeric" value={hotspotPort} onChange={(event) => setHotspotPort(event.target.value)} /></label><button type="button" disabled={busy || !server} onClick={() => void connectHotspot()}>连接</button></div><small>连接对方热点后可使用热点网关；也可以输入对方的局域网地址。</small></div>
    </section>
    <section className="nearby-transfer-card" aria-label="扫码连接附近设备">
      <div className="nearby-transfer-card-header"><div><h2>扫码连接</h2><p>发现不到设备时，一台显示二维码，另一台扫码。</p></div></div>
      <div className="nearby-transfer-actions"><button type="button" disabled={busy || !server} onClick={() => void showPairingQr()}>显示本机二维码</button><button type="button" disabled={busy || !server} onClick={() => void scanPairingQr()}>扫码连接</button><button type="button" disabled={busy || !server} onClick={() => qrImageInput.current?.click()}>选择二维码图片</button></div>
      <input ref={qrImageInput} type="file" accept="image/*" hidden aria-label="选择附近设备二维码图片" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readPairingImage(file); }} />
      {pairingQr ? <div className="nearby-transfer-qr"><img src={pairingQr} alt="本机附近传文件二维码" /><p>请让对方扫码，收到连接请求后在本机确认。</p><button type="button" onClick={() => setPairingQr("")}>关闭二维码</button></div> : null}
    </section>
    {connectionProblems.length ? <section className="nearby-transfer-card" aria-label="连接状态诊断"><div className="nearby-transfer-card-header"><h2>连接状态</h2><span>{connectionProblems.length} 条</span></div><ul className="nearby-transfer-list">{connectionProblems.map((connection) => <li key={connection.id}><div><strong>{connection.peer.name}</strong><small>{connection.state === "connecting" ? "正在连接，等待对方确认或返回网络错误…" : `连接失败：${connection.error ?? "未提供错误信息"}`}</small></div><span className={`nearby-transfer-state nearby-transfer-state-${connection.state}`}>{connection.state === "connecting" ? "连接中" : "失败"}</span></li>)}</ul><p className="nearby-transfer-muted">如果一直停在“连接中”，请在 iPhone 的附近传文件页查看是否出现待确认连接；同时把下面的诊断日志复制出来。</p></section> : null}
    <section className="nearby-transfer-card" aria-label="发现的附近设备"><div className="nearby-transfer-card-header"><h2>附近设备</h2><span>{Object.keys(peers).length} 台</span></div>{!Object.keys(peers).length ? <p className="nearby-transfer-muted">暂未发现设备。请让另一台 App 打开此页面并确认局域网权限。</p> : <ul className="nearby-transfer-list">{Object.values(peers).map((peer) => { const existing = getNearbyConnectionForPeer(peer); const peerBusy = isNearbyPeerBusy(peer); return <li key={peer.id}><div><strong>{peer.name}</strong><small>{describePeer(peer)}</small></div><button type="button" disabled={busy || peerBusy} onClick={() => void connectPeer(peer)}>{existing?.state === "connected" ? "已连接" : peerBusy ? "连接中" : "连接"}</button></li>; })}</ul>}</section>
    {pendingConnections.length ? <section className="nearby-transfer-card" aria-label="待确认连接"><h2>待确认连接</h2><ul className="nearby-transfer-list">{pendingConnections.map((connection) => <li key={connection.id}><div><strong>{connection.peer.name}</strong><small>{describePeer(connection.peer)} · 请求连接附近传文件</small></div><span className="nearby-transfer-actions"><button type="button" onClick={() => void acceptConnection(connection)}>接受</button><button type="button" onClick={() => void rejectConnection(connection)}>拒绝</button></span></li>)}</ul></section> : null}
    {connected.length ? <section className="nearby-transfer-card" aria-label="已连接设备"><div className="nearby-transfer-card-header"><h2>已连接设备</h2><span>{connected.length} 台</span></div><ul className="nearby-transfer-list">{connected.map((connection) => <li key={connection.id}><div><strong>{connection.peer.name}</strong><small>已连接 · {describePeer(connection.peer)}</small></div><span className="nearby-transfer-actions"><button type="button" onClick={() => void pickFile()}>选择文件</button><button type="button" disabled={!selectedFile || Boolean(sending)} onClick={() => void sendFile(connection.id)}>发送</button></span></li>)}</ul>{selectedFile ? <p className="nearby-transfer-selected">待发送：{selectedFile.fileName} · {formatBytes(selectedFile.size)}{sending ? ` · ${formatBytes(sending.bytes)} / ${formatBytes(sending.total)}` : ""}</p> : null}</section> : null}
    {Object.values(offers).length ? <section className="nearby-transfer-card" aria-label="待接收文件"><h2>待接收文件</h2><ul className="nearby-transfer-list">{Object.values(offers).map((offer) => <li key={`${offer.connectionId}:${offer.transferId}`}><div><strong>{offer.fileName}</strong><small>{formatBytes(offer.size)} · {offer.accepted ? "接收中" : "等待确认"}</small></div><span className="nearby-transfer-actions">{!offer.accepted ? <button type="button" onClick={() => void acceptOffer(offer)}>接收</button> : null}<button type="button" onClick={() => void rejectOffer(offer)}>{offer.accepted ? "取消并断开" : "拒绝"}</button></span></li>)}</ul></section> : null}
    <section className="nearby-transfer-card" aria-label="已接收文件"><div className="nearby-transfer-card-header"><h2>已接收文件</h2><button type="button" onClick={() => void refreshNearbyReceived().catch((cause) => setError(cause instanceof Error ? cause.message : "读取接收文件失败。"))}>刷新</button></div>{!received.length ? <p className="nearby-transfer-muted">还没有接收文件。</p> : <ul className="nearby-transfer-list">{received.map((file) => <li key={file.id}><div><strong>{file.fileName}</strong><small>{formatBytes(file.size)} · {new Date(file.createdAt).toLocaleString()}</small></div><span className="nearby-transfer-actions"><button type="button" onClick={() => void openReceivedFile(file)}>打开查看</button><button type="button" onClick={() => void shareNearbyReceived(file).catch((cause) => setError(cause instanceof Error ? cause.message : "打开系统保存/分享失败。"))}>保存/分享</button><button type="button" onClick={() => void nearbyDeleteReceived(file.id).then(() => refreshNearbyReceived()).catch((cause) => setError(cause instanceof Error ? cause.message : "删除接收文件失败。"))}>删除</button></span></li>)}</ul>}</section>
    <section className="nearby-transfer-card" aria-label="诊断日志"><div className="nearby-transfer-card-header"><div><h2>诊断日志</h2><p>最近保留 200 条；同时写入 Android Logcat（BridgeNearbyTransfer）或 iOS 控制台（[BridgeNearbyTransfer]）。</p></div><span>{visibleDiagnostics.length} 条</span></div><div className="nearby-transfer-actions"><button type="button" disabled={!diagnosticText} onClick={() => void copyDiagnostics()}>复制日志</button><button type="button" disabled={!visibleDiagnostics.length} onClick={() => setDiagnosticsClearedAt(Date.now())}>清空</button></div>{diagnosticText ? <pre className="nearby-transfer-log">{diagnosticText}</pre> : <p className="nearby-transfer-muted">正在等待原生服务事件。若页面仍显示“启动中”，请先保留此页，日志会在事件到达后出现。</p>}</section>
  </main>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function uniqueConnections(connections: NearbyConnection[]): NearbyConnection[] {
  const unique = new Map<string, NearbyConnection>();
  for (const connection of connections) {
    const key = connection.peer.deviceId
      ? `device:${connection.peer.deviceId}`
      : connection.peer.host && connection.peer.port
        ? `endpoint:${connection.peer.host}:${connection.peer.port}`
        : `connection:${connection.id}`;
    if (!unique.has(key)) unique.set(key, connection);
  }
  return [...unique.values()];
}

function describePeer(peer: NearbyPeer): string {
  const platform = peer.platform === "ios" ? "iPhone/iPad" : peer.platform === "android" ? "Android" : "附近设备";
  const endpoint = peer.host ? `${peer.host}${peer.port ? `:${peer.port}` : ""}` : peer.source === "qr" ? "扫码连接" : peer.source === "hotspot" ? "热点直连" : "Bonjour";
  const identity = peer.deviceId ? `设备 ${peer.deviceId.slice(0, 8)}` : "";
  return [platform, endpoint, identity].filter(Boolean).join(" · ");
}
