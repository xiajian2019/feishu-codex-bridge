import { useEffect, useRef, useState, type ReactElement } from "react";
import * as QRCode from "qrcode";
import type { FileItem, TransferNotice } from "@thebkht/rtc-file-transfer";
import {
  COMPOSER_PEER_TEXT_FILE_NAME,
  createComposerPeerManager,
  type ComposerPeerManager,
} from "./composer-peer-transfer-manager.js";
import { createComposerPeerTransferQr, formatComposerPeerBytes } from "./composer-peer-transfer.js";
import { useComposerPeerRuntime } from "./composer-peer-runtime.js";
import { getBridgeOrigin } from "./mobile-runtime.js";
import "./composer-transfer.css";

type ComposerPeerTransferPanelProps = {
  onImportText: (text: string) => void;
  onImportFile: (file: File) => Promise<void>;
  onClose: () => void;
};

type PendingRequest = { resolve: (file: File) => void; reject: (error: Error) => void };

export function ComposerPeerTransferPanel({ onImportText, onImportFile, onClose }: ComposerPeerTransferPanelProps): ReactElement {
  const runtime = useComposerPeerRuntime();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [offers, setOffers] = useState<FileItem[]>([]);
  const [status, setStatus] = useState("正在创建 WebRTC 接收端…");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const managerRef = useRef<ComposerPeerManager | null>(null);
  const receivedRef = useRef(new Map<string, File>());
  const pendingRef = useRef(new Map<string, PendingRequest>());

  useEffect(() => {
    if (!window.isSecureContext || !globalThis.crypto?.subtle || !globalThis.RTCPeerConnection) {
      setError("当前页面不是安全上下文，无法接收 WebRTC 直传。请使用 HTTPS、localhost 或 VPN 地址打开。");
      setStatus("WebRTC 不可用。");
      return;
    }
    if (runtime.status !== "ready" || !runtime.peer || !runtime.peerId || !runtime.token) {
      if (runtime.status === "disconnected") setStatus("PeerJS Cloud 已断开，正在重连…");
      else if (runtime.status === "error") setStatus("WebRTC 接收端不可用。");
      else if (runtime.status === "connecting") setStatus("正在连接 PeerJS Cloud…");
      return;
    }
    let cancelled = false;
    const qr = createComposerPeerTransferQr(getBridgeOrigin(), runtime.peerId, runtime.token);
    void QRCode.toDataURL(qr, {
      errorCorrectionLevel: "M", margin: 2, width: 240,
      color: { dark: "#111827", light: "#ffffff" },
    }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    }).catch(() => {
      if (!cancelled) setQrDataUrl(null);
    });
    const composer = createComposerPeerManager({
      peer: runtime.peer,
      token: runtime.token,
      destroyPeer: false,
      onItemsChange: (items) => {
        if (cancelled) return;
        const incoming = items.filter((item) => item.direction === "incoming" && item.status !== "revoked");
        setOffers(incoming);
        if (incoming.length && !incoming.some((item) => item.status === "done")) {
          setStatus(`手机已发送 ${incoming.length} 项，点击“接收并加入 Composer”。`);
        }
      },
      onNotice: (notice) => handleNotice(notice),
    });
    managerRef.current = composer;
    setError(null);
    setStatus("请用 WQDrop 或 Bridge 手机 App 扫描二维码。");
    return () => {
      cancelled = true;
      for (const pending of pendingRef.current.values()) pending.reject(new Error("直传已结束。"));
      pendingRef.current.clear();
      composer.dispose();
      if (managerRef.current === composer) managerRef.current = null;
    };
  }, [runtime.peer, runtime.peerId, runtime.status, runtime.token]);

  const handleNotice = (notice: TransferNotice): void => {
    if (notice.type === "incoming-offer") {
      setError(null);
      setStatus(`收到 ${notice.item.name === COMPOSER_PEER_TEXT_FILE_NAME ? "文字" : notice.item.name}，等待确认接收。`);
      return;
    }
    if (notice.type === "failed") {
      pendingRef.current.get(notice.item.id)?.reject(new Error(notice.message || "PeerJS 文件传输失败。"));
      pendingRef.current.delete(notice.item.id);
      setError(`${notice.item.name}：${notice.message || notice.code}`);
      return;
    }
    if (notice.type !== "received") return;
    const blob = notice.item.blob;
    if (!blob) {
      pendingRef.current.get(notice.item.id)?.reject(new Error("接收端没有拿到文件内容。"));
      pendingRef.current.delete(notice.item.id);
      return;
    }
    const file = new File([blob], notice.item.name, { type: notice.item.mime || blob.type || "application/octet-stream" });
    receivedRef.current.set(notice.item.id, file);
    pendingRef.current.get(notice.item.id)?.resolve(file);
    pendingRef.current.delete(notice.item.id);
    setStatus(`已接收 ${notice.item.name} · ${formatComposerPeerBytes(notice.item.size)}。`);
  };

  const requestFile = (item: FileItem): Promise<File> => {
    const ready = receivedRef.current.get(item.id);
    if (ready) return Promise.resolve(ready);
    return new Promise<File>((resolve, reject) => {
      pendingRef.current.set(item.id, { resolve, reject });
      if (!managerRef.current?.manager.request(item.id)) {
        pendingRef.current.delete(item.id);
        reject(new Error(`${item.name} 无法开始接收。`));
      }
    });
  };

  const importTransfer = async (): Promise<void> => {
    if (!offers.length || importing) return;
    setImporting(true);
    setError(null);
    try {
      for (const item of offers) {
        const file = await requestFile(item);
        if (item.name === COMPOSER_PEER_TEXT_FILE_NAME) {
          onImportText(await file.text());
        } else {
          await onImportFile(file);
        }
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加入 Composer 失败，请重试。");
    } finally {
      setImporting(false);
    }
  };

  return <div className="composer-peer-transfer-panel">
    {qrDataUrl ? <img className="composer-transfer-qr" src={qrDataUrl} alt="WebRTC 直传二维码" /> : null}
    <p className="composer-peer-transfer-status" role="status">{status}</p>
    {runtime.peerId ? <p className="composer-transfer-hint">Peer ID：<code>{runtime.peerId}</code></p> : null}
    {error || runtime.error ? <p className="composer-transfer-error" role="alert">{error || runtime.error}</p> : null}
    {offers.length ? <article className="composer-transfer-card">
      <strong>手机直传内容已准备好</strong>
      <ul>{offers.map((item) => <li key={item.id}>{item.name === COMPOSER_PEER_TEXT_FILE_NAME ? "文字" : item.name} · {formatComposerPeerBytes(item.size)}</li>)}</ul>
      <button type="button" className="primary" disabled={importing} onClick={() => void importTransfer()}>{importing ? "正在接收并加入…" : "接收并加入 Composer"}</button>
    </article> : null}
    <p className="composer-peer-transfer-footnote">二维码使用 WQDrop pair envelope；文件通过 PeerJS Cloud 的 WebRTC DataChannel 和 @thebkht/rtc-file-transfer 直传。</p>
  </div>;
}
