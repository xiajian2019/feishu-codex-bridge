import { useLocation } from "react-router";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import { Peer } from "peerjs";
import type { TransferNotice } from "@thebkht/rtc-file-transfer";
import { getBridgeOrigin } from "./mobile-runtime.js";
import { parseComposerTransferQrPayload } from "./composer-transfer-link.js";
import {
  COMPOSER_PEER_TEXT_FILE_NAME,
  createComposerPeerManager,
  type ComposerPeerManager,
} from "./composer-peer-transfer-manager.js";
import {
  COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES,
  COMPOSER_PEER_TRANSFER_MAX_FILES,
  COMPOSER_PEER_TRANSFER_MAX_TOTAL_BYTES,
  COMPOSER_PEER_TRANSFER_TEXT_BYTES,
  formatComposerPeerBytes,
} from "./composer-peer-transfer.js";
import "./composer-transfer.css";

const PEER_OPTIONS = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
  debug: 0,
  config: { iceServers: [] },
};

type PeerSession = { manager: ComposerPeerManager; expectedIds: Set<string> };

export function ComposerPeerTransferUpload(): ReactElement {
  const location = useLocation();
  const target = useMemo(() => readPeerTarget(location.search), [location.search]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [status, setStatus] = useState("填写文字或选择图片，点击发送后建立 WebRTC 直连。\n文件内容不会经过 Bridge 服务器。");
  const [error, setError] = useState<string | null>(() => target.error);
  const [done, setDone] = useState(false);
  const activeSession = useRef<PeerSession | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      activeSession.current?.manager.dispose();
      activeSession.current = null;
    };
  }, []);

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length) return;
    const currentTotal = files.reduce((total, file) => total + file.size, 0);
    const next: File[] = [...files];
    const existing = new Set(files.map((file) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`));
    for (const file of selected) {
      if (!file.type.startsWith("image/")) {
        setError("WebRTC 直传目前只支持图片和文字。");
        continue;
      }
      if (file.size > COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES) {
        setError(`单张图片不能超过 ${formatComposerPeerBytes(COMPOSER_PEER_TRANSFER_MAX_FILE_BYTES)}。`);
        continue;
      }
      const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
      if (existing.has(key)) continue;
      if (next.length >= COMPOSER_PEER_TRANSFER_MAX_FILES) {
        setError(`一次最多传输 ${COMPOSER_PEER_TRANSFER_MAX_FILES} 张图片。`);
        break;
      }
      if (currentTotal + next.slice(files.length).reduce((total, item) => total + item.size, 0) + file.size > COMPOSER_PEER_TRANSFER_MAX_TOTAL_BYTES) {
        setError(`图片总大小不能超过 ${formatComposerPeerBytes(COMPOSER_PEER_TRANSFER_MAX_TOTAL_BYTES)}。`);
        break;
      }
      existing.add(key);
      next.push(file);
    }
    setFiles(next);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || done || !target.peerId || !target.token) return;
    if (new TextEncoder().encode(text).byteLength > COMPOSER_PEER_TRANSFER_TEXT_BYTES) {
      setError("文字内容不能超过 64 KiB。");
      return;
    }
    if (!text.trim() && files.length === 0) {
      setError("请输入文字或选择图片。");
      return;
    }
    if (!window.isSecureContext || !globalThis.crypto?.subtle || !globalThis.RTCPeerConnection) {
      setError("当前页面不是安全上下文，无法建立 WebRTC 直连。请使用 HTTPS、localhost 或 VPN 地址打开。");
      return;
    }
    setBusy(true);
    setDone(false);
    setError(null);
    setProgress("");
    setStatus("正在连接目标 Composer…");
    let session: PeerSession | null = null;
    try {
      const peer = await openPeer(target.peerId);
      if (cancelled.current) throw new Error("页面已关闭。");
      const textFile = text.trim()
        ? new File([text], COMPOSER_PEER_TEXT_FILE_NAME, { type: "text/plain;charset=utf-8" })
        : null;
      const entries = [...files, ...(textFile ? [textFile] : [])];
      let expectedIds = new Set<string>();
      let resolveDone: (() => void) | null = null;
      let rejectDone: ((error: Error) => void) | null = null;
      const completed = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      const manager = createComposerPeerManager({
        peer,
        token: target.token,
        onItemsChange: (items) => {
          const outgoing = items.filter((item) => expectedIds.has(item.id));
          const transferring = outgoing.find((item) => item.status === "transferring" || item.status === "connecting");
          if (transferring) {
            const progressItem = transferring.outgoingTransfers?.[0];
            setProgress(`正在发送 ${transferring.name} · ${formatComposerPeerBytes(progressItem?.bytes ?? 0)} / ${formatComposerPeerBytes(transferring.size)}`);
          }
          if (expectedIds.size > 0 && outgoing.length === expectedIds.size && outgoing.every((item) => item.completedTransfers > 0)) resolveDone?.();
        },
        onNotice: (notice: TransferNotice) => {
          if (notice.type === "failed") rejectDone?.(new Error(`${notice.item.name}：${notice.message || notice.code}`));
        },
      });
      session = { manager, expectedIds };
      activeSession.current = session;
      manager.connectTo(target.peerId);
      const result = manager.manager.offerFiles(entries, { batch: true, digest: true });
      if (!result.offered) throw new Error("没有可发送的内容。");
      expectedIds = new Set(manager.manager.getItems().filter((item) => item.direction === "outgoing").map((item) => item.id));
      session.expectedIds = expectedIds;
      setStatus("已建立 WebRTC 直连，等待目标 Composer 确认接收…");
      await Promise.race([completed, new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("等待目标 Composer 接收超时。")), 120_000))]);
      setDone(true);
      setStatus("已发送到目标 Composer，目标端已完成校验。");
      setProgress("发送完成，目标端仍需确认加入草稿。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WebRTC 直传失败。");
      setStatus("直传未完成，可以检查网络后重试。");
      setProgress("");
    } finally {
      session?.manager.dispose();
      if (activeSession.current === session) activeSession.current = null;
      setBusy(false);
    }
  };

  return <main className="page-main composer-transfer-upload-page">
    <section className="composer-transfer-dialog composer-transfer-upload-card composer-peer-transfer-upload-card">
      <h1>WebRTC 直传到 Composer</h1>
      <p className="composer-transfer-hint">{target.sessionName ? `目标：${target.sessionName}` : "目标 Session"}</p>
      {!target.error ? <p className="composer-peer-transfer-status" role="status">{status}</p> : null}
      {error ? <p className="composer-transfer-error" role="alert">{error}</p> : null}
      {target.peerId && target.token && !done ? <form onSubmit={(event) => void submit(event)}>
        <label className="composer-transfer-field">文字或说明<textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={COMPOSER_PEER_TRANSFER_TEXT_BYTES} disabled={busy} placeholder="可以粘贴文字、日志片段或说明…" /></label>
        <label className="composer-transfer-field"><span>图片</span><input type="file" accept="image/*" multiple onChange={chooseFiles} disabled={busy} /><small>{files.length ? `已选择 ${files.length} 张图片，可继续添加` : "仅图片通过 WebRTC 直传；文字请填写在上方"}</small></label>
        {files.length ? <ul className="composer-transfer-file-list">{files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}`}>
          <div className="composer-transfer-file-main"><span className="composer-transfer-file-type" aria-hidden="true">IMG</span><span className="composer-transfer-file-name" title={file.name}>{file.name} · {formatComposerPeerBytes(file.size)}</span></div>
          <button type="button" aria-label={`移除 ${file.name}`} disabled={busy} onClick={() => setFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}>移除</button>
        </li>)}</ul> : null}
        {progress ? <p className="composer-transfer-progress" role="status">{progress}</p> : null}
        <button className="primary" type="submit" disabled={busy}>{busy ? "直传中…" : "开始 WebRTC 直传"}</button>
      </form> : null}
      {done ? <p className="composer-transfer-notice" role="status">发送完成。请返回目标设备，点击“加入 Composer”。</p> : null}
      <p className="composer-peer-transfer-footnote">PeerJS Cloud 只负责发现双方 Peer ID；文件通过 @thebkht/rtc-file-transfer 的 WebRTC DataChannel 直传。</p>
    </section>
  </main>;
}

function readPeerTarget(search: string): { peerId: string; token: string; sessionName?: string; error: string | null } {
  try {
    const payload = parseComposerTransferQrPayload(new URL(`/composer-transfer${search}`, getBridgeOrigin()).toString(), getBridgeOrigin());
    if (payload.mode !== "peerjs") return { peerId: "", token: "", error: "二维码不是 WebRTC 直传二维码。" };
    return { peerId: payload.peerId, token: payload.token, error: null };
  } catch (cause) {
    return { peerId: "", token: "", error: cause instanceof Error ? cause.message : "WebRTC 直传二维码无效。" };
  }
}

function openPeer(remotePeerId: string): Promise<Peer> {
  return new Promise<Peer>((resolve, reject) => {
    const peer = new Peer(PEER_OPTIONS);
    const timer = window.setTimeout(() => {
      if (!peer.destroyed) peer.destroy();
      reject(new Error("连接目标 Composer 超时，请重新扫码后重试。"));
    }, 25_000);
    peer.on("error", (cause) => {
      window.clearTimeout(timer);
      if (!peer.destroyed) peer.destroy();
      reject(new Error(`PeerJS：${cause.message || cause.type || "连接失败"}`));
    });
    peer.on("open", () => {
      window.clearTimeout(timer);
      resolve(peer);
      void remotePeerId;
    });
  });
}
