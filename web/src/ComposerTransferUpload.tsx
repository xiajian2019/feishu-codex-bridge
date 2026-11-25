import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import { useLocation } from "react-router";
import { readBridgeJson } from "./bridge-json.js";
import { bridgeUrl, copyMobileText, getBridgeOrigin, isMobileApp } from "./mobile-runtime.js";
import { formatTransferDiagnosticError } from "./composer-transfer-diagnostics.js";
import { useMobileBack } from "./use-mobile-back.js";
import "./composer-transfer.css";

type Claim = {
  transferId: string;
  transferToken: string;
  expiresAt: string;
  target: { sessionId: string; sessionCreatedAt: number };
};

type UploadItem = { itemId: string; offset: number; sizeBytes: number; fileName: string };
type TransferDiagnostics = { record: (message: string) => void; failure: (phase: string, cause: unknown) => void };

const CHUNK_BYTES = 8 * 1024 * 1024;

export function ComposerTransferUpload(): ReactElement {
  const location = useLocation();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [diagnosticLines, setDiagnosticLines] = useState<string[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const claimPromise = useRef<Promise<Claim> | null>(null);
  const diagnosticSecrets = useRef<string[]>([]);
  const code = new URLSearchParams(location.search).get("code")?.trim() ?? "";
  diagnosticSecrets.current = [code, claim?.transferId ?? "", claim?.transferToken ?? "", text, ...files.map((file) => file.name)];
  const record = useCallback((message: string): void => {
    setDiagnosticLines((lines) => [...lines, `[${new Date().toISOString()}] ${message}`].slice(-100));
  }, []);
  const failure = useCallback((phase: string, cause: unknown): void => {
    record(`${phase}：${formatTransferDiagnosticError(cause, diagnosticSecrets.current)}`);
  }, [record]);
  const diagnostics = { record, failure };
  const diagnosticReport = [
    "Composer 传输诊断（不含接收码、令牌、正文和文件名）",
    `环境：${isMobileApp() ? "手机 App" : "浏览器"}；Bridge：${getBridgeOrigin()}；设备在线状态：${navigator.onLine ? "在线" : "离线"}`,
    `客户端：${navigator.userAgent}`,
    ...diagnosticLines,
  ].join("\n");

  useMobileBack(Boolean(previewFile), () => setPreviewFile(null), 900);

  useEffect(() => {
    if (previewFile && !files.includes(previewFile)) setPreviewFile(null);
  }, [files, previewFile]);

  useEffect(() => {
    let cancelled = false;
    if (!code) {
      setError("链接中缺少接收码，请从 Composer 重新生成二维码。");
      record("无法开始：链接中没有接收码。");
      return;
    }
    const request = claimPromise.current ??= transferFetch(bridgeUrl("/api/composer-transfers/claim"), "连接 Bridge", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }, diagnostics).then(async (response) => {
      const payload = await readBridgeJson<Claim & { error?: string }>(response);
      if (!response.ok || !payload.transferId || !payload.transferToken) throw new Error(payload.error || "接收码无效或已过期。");
      return payload;
    });
    void request.then((payload) => {
      if (!cancelled) {
        setClaim(payload);
        record("接收码验证成功。");
      }
    }).catch((cause: unknown) => {
      if (!cancelled) {
        failure("接收码验证失败", cause);
        setDiagnosticsOpen(true);
        setError(cause instanceof Error ? explainUploadError(cause) : "无法连接 Bridge。");
      }
    });
    return () => { cancelled = true; };
  }, [code, failure, record]);

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0) return;
    record(`选择了 ${selected.length} 个文件，总计 ${selected.reduce((sum, file) => sum + file.size, 0)} 字节。`);
    setFiles((current) => {
      const existing = new Set(current.map((file) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`));
      return [...current, ...selected.filter((file) => {
        const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      })];
    });
  };

  const removeFile = (index: number): void => {
    setFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!claim || busy || done) return;
    if (!text.trim() && files.length === 0) {
      setError("请输入文字或选择文件。");
      return;
    }
    setBusy(true);
    setError(null);
    setProgress("");
    record(`开始发送：文字 ${text.trim().length} 字符，文件 ${files.length} 个。`);
    try {
      if (text.trim()) {
        setProgress("正在上传文字…");
        const response = await transferFetch(bridgeUrl(`/api/composer-transfers/${encodeURIComponent(claim.transferId)}/text`), "文字上传", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Bridge-Transfer-Token": claim.transferToken },
          body: JSON.stringify({ text }),
        }, diagnostics);
        const payload = await readBridgeJson<{ error?: string }>(response);
        if (!response.ok) throw new Error(payload.error || "文字上传失败。");
      }
      for (const [index, file] of files.entries()) {
        setProgress(`正在上传 ${index + 1}/${files.length}：${file.name}`);
        await uploadFile(claim, file, index + 1, diagnostics, (bytes) => setProgress(`正在上传 ${index + 1}/${files.length}：${file.name} · ${formatBytes(bytes)} / ${formatBytes(file.size)}`));
      }
      const finish = await transferFetch(bridgeUrl(`/api/composer-transfers/${encodeURIComponent(claim.transferId)}/complete`), "提交传输", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Bridge-Transfer-Token": claim.transferToken },
        body: "{}",
      }, diagnostics);
      const finishPayload = await readBridgeJson<{ error?: string }>(finish);
      if (!finish.ok) throw new Error(finishPayload.error || "传输尚未完成。");
      setDone(true);
      record("传输提交成功，等待目标设备确认加入草稿。");
      setProgress("已发送到目标 Composer，等待目标设备确认加入草稿。");
    } catch (cause) {
      failure("发送中止", cause);
      setDiagnosticsOpen(true);
      setProgress("");
      setError(cause instanceof Error ? explainUploadError(cause) : "上传失败，请复制诊断日志后重试。");
    } finally {
      setBusy(false);
    }
  };

  const copyDiagnostics = async (): Promise<void> => {
    try {
      await copyDiagnosticText(diagnosticReport);
      setCopyStatus("诊断日志已复制。");
    } catch {
      setCopyStatus("复制失败，可长按下方日志手动选择复制。");
    }
  };

  return <main className="page-main composer-transfer-upload-page">
    <section className="composer-transfer-dialog composer-transfer-upload-card">
      <p className="dashboard-eyebrow">BRIDGE COMPOSER</p>
      <h1>发送到 Composer</h1>
      {!claim && !error ? <p role="status">正在验证接收码…</p> : null}
      {claim ? <p className="composer-transfer-hint composer-transfer-context">
        <span className="composer-transfer-context-session" title={claim.target.sessionId}>Session：<code>{claim.target.sessionId}</code></span>
        <span aria-hidden="true">·</span>
        <span className="composer-transfer-context-bridge" title={getBridgeOrigin()}>Bridge：<code>{getBridgeOrigin()}</code></span>
      </p> : null}
      {error ? <p className="composer-transfer-error" role="alert">{error}</p> : null}
      {claim && !done ? <form onSubmit={(event) => void submit(event)}>
        <label className="composer-transfer-field">文字或说明<textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={64_000} disabled={busy} placeholder="可以粘贴调试信息、日志片段或说明…" /></label>
        <label className="composer-transfer-field"><span>图标或文件</span><input type="file" multiple onChange={chooseFiles} disabled={busy} /><small>{files.length ? `已选择 ${files.length} 个文件，可继续添加` : "支持图片、SVG、日志和普通文件，可多次选择"}</small></label>
        {files.length ? <ul className="composer-transfer-file-list">{files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}`}>
          <div className="composer-transfer-file-main">
            {isPreviewableImage(file) ? <FileThumbnail file={file} onPreview={() => setPreviewFile(file)} /> : <span className="composer-transfer-file-type" aria-hidden="true">FILE</span>}
            <button className="composer-transfer-file-name" type="button" title={file.name} onClick={() => { if (isPreviewableImage(file)) setPreviewFile(file); }} disabled={busy || !isPreviewableImage(file)}>{file.name} · {formatBytes(file.size)}</button>
          </div>
          <button type="button" aria-label={`移除 ${file.name}`} disabled={busy} onClick={() => removeFile(index)}>移除</button>
        </li>)}</ul> : null}
        {progress ? <p role="status">{progress}</p> : null}
        <button className="primary" type="submit" disabled={busy}>{busy ? "发送中…" : "发送到 Composer"}</button>
      </form> : null}
      {done ? <p className="composer-transfer-notice" role="status">发送完成。现在可以返回目标设备，点击“加入 Composer”。</p> : null}
      <details className="composer-transfer-diagnostics" open={diagnosticsOpen} onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}>
        <summary>上传诊断日志（{diagnosticLines.length}）</summary>
        <div className="composer-transfer-diagnostics-body">
          <button type="button" onClick={() => void copyDiagnostics()}>复制日志</button>
          {copyStatus ? <span role="status">{copyStatus}</span> : null}
          <pre tabIndex={0} aria-label="上传诊断日志">{diagnosticReport}</pre>
        </div>
      </details>
      {previewFile ? <ComposerTransferPreview file={previewFile} onClose={() => setPreviewFile(null)} /> : null}
    </section>
  </main>;
}

async function uploadFile(claim: Claim, file: File, index: number, diagnostics: TransferDiagnostics, onProgress: (bytes: number) => void): Promise<void> {
  const phase = `文件 ${index}`;
  diagnostics.record(`${phase}：大小 ${file.size} 字节。`);
  const root = `/api/composer-transfers/${encodeURIComponent(claim.transferId)}`;
  const created = await transferFetch(bridgeUrl(`${root}/items`), "创建文件上传任务", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Bridge-Transfer-Token": claim.transferToken },
    body: JSON.stringify({ fileName: file.name, contentType: file.type, sizeBytes: file.size }),
  }, diagnostics);
  const item = await readBridgeJson<UploadItem & { error?: string }>(created);
  if (!created.ok || !item.itemId) throw new Error(item.error || `无法创建 ${file.name} 的上传任务。`);
  let offset = item.offset ?? 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    let chunk: ArrayBuffer;
    try {
      chunk = await file.slice(offset, end).arrayBuffer();
    } catch (cause) {
      diagnostics.failure(`${phase} 读取分片失败`, cause);
      throw cause;
    }
    diagnostics.record(`${phase}：分片偏移 ${offset}，长度 ${end - offset} 字节。`);
    const response = await transferFetch(bridgeUrl(`${root}/items/${encodeURIComponent(item.itemId)}?offset=${offset}`), `${phase} 上传分片`, {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/octet-stream", "X-Bridge-Transfer-Token": claim.transferToken },
      body: chunk,
    }, diagnostics);
    const next = await readBridgeJson<{ received_bytes?: number; receivedBytes?: number; error?: string }>(response);
    if (!response.ok) throw new Error(next.error || `${file.name} 上传分片失败。`);
    offset = Number(next.received_bytes ?? next.receivedBytes ?? end);
    onProgress(offset);
  }
  const complete = await transferFetch(bridgeUrl(`${root}/items/${encodeURIComponent(item.itemId)}/complete`), `${phase} 完成校验`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Bridge-Transfer-Token": claim.transferToken },
    body: "{}",
  }, diagnostics);
  const completed = await readBridgeJson<{ status?: string; error?: string }>(complete);
  if (!complete.ok || completed.status !== "ready") throw new Error(completed.error || `${file.name} 校验失败。`);
}

async function transferFetch(url: string, phase: string, init: RequestInit, diagnostics: TransferDiagnostics): Promise<Response> {
  const startedAt = Date.now();
  diagnostics.record(`${phase}：开始 ${init.method ?? "GET"} 请求。`);
  try {
    const response = await fetch(url, init);
    diagnostics.record(`${phase}：HTTP ${response.status}，耗时 ${Date.now() - startedAt} ms，响应类型 ${response.type}。`);
    return response;
  } catch (cause) {
    diagnostics.failure(`${phase}请求失败（耗时 ${Date.now() - startedAt} ms）`, cause);
    throw new Error(`${phase}请求未完成，请检查连接并复制诊断日志。`);
  }
}

function explainUploadError(error: Error): string {
  return error.message || "上传失败，请复制诊断日志后重试。";
}

async function copyDiagnosticText(value: string): Promise<void> {
  if (isMobileApp()) return copyMobileText(value);
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Try the browser fallback. */ }
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;font-size:16px";
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
    if (!document.execCommand("copy")) throw new Error("复制失败");
  } finally {
    field.remove();
  }
}

function isPreviewableImage(file: File): boolean {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(file.name);
}

function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

function FileThumbnail({ file, onPreview }: { file: File; onPreview: () => void }): ReactElement {
  const url = useObjectUrl(file);
  return <button className="composer-transfer-file-thumbnail" type="button" onClick={onPreview} aria-label={`预览 ${file.name}`}>
    {url ? <img src={url} alt="" /> : <span aria-hidden="true">IMG</span>}
  </button>;
}

function ComposerTransferPreview({ file, onClose }: { file: File; onClose: () => void }): ReactElement {
  const url = useObjectUrl(file);
  return <div className="composer-transfer-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="composer-transfer-preview" role="dialog" aria-modal="true" aria-label={`预览 ${file.name}`}>
      <header>
        <div><strong>图片预览</strong><small>{file.name} · {formatBytes(file.size)}</small></div>
        <button type="button" aria-label="关闭预览" onClick={onClose}>×</button>
      </header>
      <div className="composer-transfer-preview-canvas">
        {url ? <img src={url} alt={file.name} /> : <p role="status">正在加载预览…</p>}
      </div>
    </section>
  </div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
