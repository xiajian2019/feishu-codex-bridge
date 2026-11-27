import { useEffect, useRef, useState, type ReactElement } from "react";
import * as QRCode from "qrcode";
import { getActionToken } from "./api.js";
import { readBridgeJson } from "./bridge-json.js";
import { getBridgeOrigin } from "./mobile-runtime.js";
import { acknowledgeComposerAdoption, adoptComposerTransfer, supportsComposerAssets, type ComposerAssetAdoption } from "./composer-asset-client.js";
import { ComposerPeerTransferPanel } from "./ComposerPeerTransferPanel.js";
import { useMobileBack } from "./use-mobile-back.js";
import "./composer-transfer.css";

type TransferItem = {
  itemId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  receivedBytes: number;
  status: string;
  error: string | null;
};

type Transfer = {
  transferId: string;
  text: string;
  status: string;
  expiresAt: string;
  items: TransferItem[];
};

type Target = { targetId: string; code: string; expiresAt: string };

type ComposerTransferReceiverProps = {
  sessionId: string | null;
  sessionCreatedAt: number | null;
  onImportText: (text: string) => void;
  onImportFile: (file: File) => Promise<void>;
  onImportAssets: (adoption: ComposerAssetAdoption) => Promise<void>;
  onClose: () => void;
};

export function ComposerTransferReceiver({ sessionId, sessionCreatedAt, onImportText, onImportFile, onImportAssets, onClose }: ComposerTransferReceiverProps): ReactElement {
  const [transferMode, setTransferMode] = useState<"server" | "peerjs">("server");
  const [target, setTarget] = useState<Target | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [busy, setBusy] = useState(true);
  const [importing, setImporting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importedTransferId = useRef<string | null>(null);
  const importProgress = useRef<{ transferId: string; textAdded: boolean; itemIds: Set<string> } | null>(null);
  const createPromise = useRef<Promise<Target> | null>(null);
  const closingRef = useRef(false);
  const assetAttempt = useRef<string | null>(null);

  const endpoint = sessionId && target
    ? `/tmux-dashboard/api/sessions/${encodeURIComponent(sessionId)}/composer-transfer/${encodeURIComponent(target.targetId)}`
    : null;

  const stopReceiving = async (): Promise<void> => {
    if (importing || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setError(null);
    try {
      let currentTarget = target;
      if (!currentTarget && createPromise.current) {
        currentTarget = await createPromise.current.catch(() => null);
      }
      if (sessionId && currentTarget && sessionCreatedAt !== null) {
        const signal = AbortSignal.timeout(15_000);
        const actionToken = await getActionToken(signal);
        const response = await fetch(`/tmux-dashboard/api/sessions/${encodeURIComponent(sessionId)}/composer-transfer/${encodeURIComponent(currentTarget.targetId)}`, {
          method: "DELETE",
          headers: { "X-Bridge-Action-Token": actionToken, "X-Bridge-Session-Created-At": String(sessionCreatedAt) },
          signal,
        });
        if (!response.ok && response.status !== 410) {
          const payload = await readBridgeJson<{ error?: string }>(response);
          throw new Error(payload.error || `停止接收失败（${response.status}）。`);
        }
      }
      onClose();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "请重试。";
      setError(`无法停止接收：${detail}`);
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };
  useMobileBack(true, () => { void stopReceiving(); }, 800);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId || sessionCreatedAt === null) {
      setError("请先选择一个有效的 Session。");
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    const request = createPromise.current ??= (async (): Promise<Target> => {
      const signal = AbortSignal.timeout(15_000);
      const actionToken = await getActionToken(signal);
      const response = await fetch(`/tmux-dashboard/api/sessions/${encodeURIComponent(sessionId)}/composer-transfer`, {
        method: "POST",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Bridge-Action-Token": actionToken,
          "X-Bridge-Session-Created-At": String(sessionCreatedAt),
        },
        body: "{}",
      });
      const payload = await readBridgeJson<Target & { error?: string }>(response);
      if (!response.ok || !payload.targetId || !payload.code) throw new Error(payload.error || "无法创建手机接收凭证。");
      return payload;
    })();
    void request.then(async (payload) => {
      if (cancelled) return;
      setTarget(payload);
      const link = new URL("/composer-transfer", getBridgeOrigin());
      link.searchParams.set("code", payload.code);
      try {
        setQrDataUrl(await QRCode.toDataURL(link.toString(), {
          errorCorrectionLevel: "M", margin: 2, width: 240,
          color: { dark: "#111827", light: "#ffffff" },
        }));
      } catch {
        setQrDataUrl(null);
      }
      setBusy(false);
    }).catch((cause: unknown) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : "无法创建手机接收凭证。");
        setBusy(false);
      }
    });
    return () => { cancelled = true; };
  }, [sessionId, sessionCreatedAt]);

  useEffect(() => {
    if (!endpoint || sessionCreatedAt === null || importedTransferId.current) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      if (importedTransferId.current || assetAttempt.current) return;
      try {
        const response = await fetch(endpoint, {
          headers: { Accept: "application/json", "X-Bridge-Session-Created-At": String(sessionCreatedAt) },
          cache: "no-store",
        });
        const payload = await readBridgeJson<{ transfers?: Transfer[]; error?: string }>(response);
        if (!response.ok) throw new Error(payload.error || "读取手机传输状态失败。");
        if (!cancelled && !importedTransferId.current && !assetAttempt.current) setTransfers(Array.isArray(payload.transfers) ? payload.transfers : []);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "读取手机传输状态失败。");
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [endpoint, sessionCreatedAt]);

  const importTransfer = async (transfer: Transfer): Promise<void> => {
    if (!endpoint || sessionCreatedAt === null || importing) return;
    setImporting(true);
    setError(null);
    try {
      if (supportsComposerAssets() && sessionId && transfer.items.length > 0) {
        assetAttempt.current = transfer.transferId;
        const adoption = await adoptComposerTransfer(sessionId, sessionCreatedAt, target!.targetId, transfer.transferId);
        const received = new Set(adoption.assets.map((item) => item.itemId));
        if (adoption.unavailableItemIds.length || transfer.items.some((item) => !received.has(item.itemId))) {
          throw new Error("部分手机附件已失效，请重新发送文件。");
        }
        await onImportAssets(adoption);
        importedTransferId.current = transfer.transferId;
        await acknowledgeComposerAdoption(sessionId, sessionCreatedAt, transfer.transferId);
        onClose();
        return;
      }
      const progress = importProgress.current?.transferId === transfer.transferId
        ? importProgress.current
        : { transferId: transfer.transferId, textAdded: false, itemIds: new Set<string>() };
      importProgress.current = progress;
      const files: Array<{ itemId: string; file: File }> = [];
      for (const item of transfer.items) {
        if (progress.itemIds.has(item.itemId)) continue;
        const response = await fetch(`${endpoint}/${encodeURIComponent(transfer.transferId)}/items/${encodeURIComponent(item.itemId)}`, {
          headers: { "X-Bridge-Session-Created-At": String(sessionCreatedAt) },
          cache: "no-store",
        });
        if (!response.ok) {
          const payload = await readBridgeJson<{ error?: string }>(response);
          throw new Error(payload.error || `读取 ${item.fileName} 失败。`);
        }
        const blob = await response.blob();
        files.push({ itemId: item.itemId, file: new File([blob], item.fileName, { type: item.contentType || blob.type || "application/octet-stream" }) });
      }
      if (!progress.textAdded && transfer.text.trim()) {
        onImportText(transfer.text);
        progress.textAdded = true;
      }
      for (const { itemId, file } of files) {
        await onImportFile(file);
        progress.itemIds.add(itemId);
      }
      importedTransferId.current = transfer.transferId;
      const actionToken = await getActionToken();
      const consumeResponse = await fetch(`${endpoint}/${encodeURIComponent(transfer.transferId)}/consume`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Bridge-Action-Token": actionToken,
          "X-Bridge-Session-Created-At": String(sessionCreatedAt),
        },
        body: "{}",
      });
      const consumePayload = await readBridgeJson<{ error?: string }>(consumeResponse);
      if (!consumeResponse.ok) throw new Error(consumePayload.error || "Composer 已加入，但服务器未确认收件状态。");
      onClose();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "请重试。";
      const progress = importProgress.current;
      if (importedTransferId.current === transfer.transferId) {
        setError(`内容已加入 Composer，但收件确认失败：${detail}。可以重试确认或关闭弹框。`);
      } else if (progress?.transferId === transfer.transferId && (progress.textAdded || progress.itemIds.size > 0)) {
        setError(`部分内容已加入 Composer，重试会继续处理剩余内容：${detail}`);
      } else {
        setError(detail);
      }
    } finally {
      setImporting(false);
    }
  };

  return <div className="composer-transfer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void stopReceiving(); }}>
    <section className="composer-transfer-dialog" role="dialog" aria-modal="true" aria-label="手机导入 Composer">
      <header className="composer-transfer-heading"><h2>从手机导入</h2><button type="button" onClick={() => void stopReceiving()} disabled={importing || closing} aria-label="关闭">×</button></header>
      <div className="composer-transfer-tabs" role="tablist" aria-label="手机导入方式">
        <button type="button" role="tab" aria-selected={transferMode === "server"} className={transferMode === "server" ? "is-active" : ""} onClick={() => setTransferMode("server")}>
          Bridge 中转
        </button>
        <button type="button" role="tab" aria-selected={transferMode === "peerjs"} className={transferMode === "peerjs" ? "is-active" : ""} onClick={() => setTransferMode("peerjs")}>
          WebRTC 直传
        </button>
      </div>
      {transferMode === "server" ? <>
        {busy ? <p role="status">正在生成接收二维码…</p> : null}
        {closing ? <p role="status">正在停止接收…</p> : null}
        {error ? <p className="composer-transfer-error" role="alert">{error}</p> : null}
        {target && !busy ? <div className="composer-transfer-target">
          {qrDataUrl ? <img className="composer-transfer-qr" src={qrDataUrl} alt="手机导入二维码" /> : null}
          <p>用手机扫描二维码，打开上传页面。接收码 <code>{target.code}</code>，10 分钟内有效。</p>
          <p className="composer-transfer-hint">手机提交后会出现在这里；点击“加入 Composer”才会写入当前草稿，不会自动发送。</p>
        </div> : null}
        {transfers.map((transfer) => <article className="composer-transfer-card" key={transfer.transferId}>
          <strong>手机内容已准备好</strong>
          {transfer.text ? <p>{transfer.text.slice(0, 240)}{transfer.text.length > 240 ? "…" : ""}</p> : null}
          {transfer.items.length ? <ul>{transfer.items.map((item) => <li key={item.itemId}>{item.fileName} · {formatBytes(item.sizeBytes)}</li>)}</ul> : null}
          <button type="button" className="primary" disabled={importing || closing} onClick={() => void importTransfer(transfer)}>{importing ? "正在加入…" : importedTransferId.current === transfer.transferId ? "重试确认" : "加入 Composer"}</button>
        </article>)}
      </> : <ComposerPeerTransferPanel
        onImportText={onImportText}
        onImportFile={onImportFile}
        onClose={() => void stopReceiving()}
      />}
    </section>
  </div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
