import { useState, type FormEvent, type ReactElement } from "react";

import { getActionToken, getJson } from "./api.js";
import { BridgeImage } from "./BridgeMedia.js";
import { copyMobileText, downloadBridgeFile, isMobileApp } from "./mobile-runtime.js";

type PreviewKind = "image" | "pdf" | "text" | "unknown";

interface LinkPreviewResponse {
  token: string;
  previewUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  sizeBytes: number;
  fileName: string;
  kind: PreviewKind;
  text?: string;
  textTruncated?: boolean;
}

interface LinkDownloadResponse {
  finalUrl: string;
  status: number;
  contentType: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
}

export function LinkTools({ embedded = false }: { embedded?: boolean }): ReactElement {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<LinkPreviewResponse | null>(null);
  const [download, setDownload] = useState<LinkDownloadResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const request = async <T,>(path: string): Promise<T> => {
    const token = await getActionToken();
    return getJson<T>(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Action-Token": token,
      },
      body: JSON.stringify({ url }),
    });
  };

  const previewUrl = async (): Promise<void> => {
    setPreviewBusy(true);
    setError(null);
    setDownload(null);
    setCopiedPath(false);
    setCopyError(null);
    try {
      setPreview(await request<LinkPreviewResponse>("/api/link-tools/preview"));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setPreviewBusy(false);
    }
  };

  const downloadUrl = async (): Promise<void> => {
    setDownloadBusy(true);
    setError(null);
    setCopiedPath(false);
    setCopyError(null);
    try {
      setDownload(await request<LinkDownloadResponse>("/api/link-tools/download"));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setDownloadBusy(false);
    }
  };

  const copyDownloadedPath = async (): Promise<void> => {
    if (!download) return;
    setCopyError(null);
    try {
      await copyTextToClipboard(download.filePath);
      setCopiedPath(true);
    } catch (copyFailure: unknown) {
      setCopiedPath(false);
      setCopyError(copyFailure instanceof Error ? copyFailure.message : String(copyFailure));
    }
  };

  const submitPreview = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void previewUrl();
  };

  const Container = embedded ? "section" : "main";
  return (
    <Container className={embedded ? "link-tools-panel" : "link-tools-page"}>
      {!embedded && <header className="link-tools-header">
        <div>
          <p className="eyebrow">Mac link relay</p>
          <h1>链接工具</h1>
          <p className="subtitle">在手机上提交链接，由 Mac 通过自己的 VPN/代理访问并处理文件。</p>
        </div>
      </header>}

      <section className="link-tools-card link-tools-form-card">
        <form onSubmit={submitPreview}>
          <label htmlFor="link-tools-url">链接</label>
          <div className="link-tools-input-row">
            <input
              id="link-tools-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://example.com/file.pdf"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              spellCheck={false}
            />
            <button className="primary" type="submit" disabled={previewBusy || downloadBusy || !url.trim()}>
              {previewBusy ? "读取中…" : "打开预览"}
            </button>
          </div>
          <div className="link-tools-actions">
            <button type="button" onClick={() => void downloadUrl()} disabled={previewBusy || downloadBusy || !url.trim()}>
              {downloadBusy ? "下载中…" : "下载到 Mac"}
            </button>
            <span className="link-tools-note">保存位置：~/Downloads；同名文件会自动加序号。</span>
          </div>
        </form>
        <p className="link-tools-network-note">
          请求在 Bridge 所在的 Mac 上执行：优先使用配置的 HTTP/HTTPS_PROXY，未配置时使用 Mac 当前网络/VPN。
        </p>
        {error ? <p className="link-tools-error" role="alert">{error}</p> : null}
      </section>

      {preview ? (
        <section className="link-tools-card link-tools-preview-card">
          <header className="link-tools-card-header">
            <div>
              <p className="eyebrow">Preview</p>
              <h2>{preview.fileName}</h2>
            </div>
            <a href={preview.previewUrl} target="_blank" rel="noreferrer" onClick={(event) => {
              if (!isMobileApp()) return;
              event.preventDefault();
              void downloadBridgeFile(preview.previewUrl, preview.fileName).catch((failure: unknown) => {
                setError(failure instanceof Error ? failure.message : "文件下载失败。");
              });
            }}>{isMobileApp() ? "保存或分享" : "新窗口打开"}</a>
          </header>
          <dl className="link-tools-meta">
            <div><dt>类型</dt><dd>{preview.contentType}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(preview.sizeBytes)}</dd></div>
            <div><dt>最终地址</dt><dd title={preview.finalUrl}>{preview.finalUrl}</dd></div>
          </dl>
          <PreviewBody preview={preview} />
        </section>
      ) : null}

      {download ? (
        <section className="link-tools-card link-tools-download-result">
          <p className="eyebrow">Saved on Mac</p>
          <h2>文件已保存</h2>
          <p>{download.fileName} · {formatBytes(download.sizeBytes)}</p>
          <code>{download.filePath}</code>
          <div className="link-tools-download-actions">
            <button type="button" onClick={() => void copyDownloadedPath()}>
              {copiedPath ? "已复制" : "复制文件路径"}
            </button>
            {copyError ? <span className="link-tools-copy-error" role="alert">{copyError}</span> : null}
          </div>
        </section>
      ) : null}
    </Container>
  );
}

function PreviewBody({ preview }: { preview: LinkPreviewResponse }): ReactElement {
  if (preview.kind === "image") {
    return (
      <div className="link-tools-image-preview">
        <BridgeImage src={preview.previewUrl} alt={preview.fileName} />
      </div>
    );
  }
  if (preview.kind === "pdf") {
    if (isMobileApp()) return <p role="status">PDF 可保存到系统后打开。请点击上方“保存或分享”，通过系统面板或文件管理器打开文件。</p>;
    return <iframe className="link-tools-pdf-preview" src={preview.previewUrl} title={preview.fileName} />;
  }
  if (preview.kind === "text") {
    return (
      <div className="link-tools-text-preview">
        <pre>{preview.text ?? ""}</pre>
        {preview.textTruncated ? <p>文本较大，仅显示前 1 MiB；需要完整内容请下载。</p> : null}
      </div>
    );
  }
  return <p className="link-tools-unsupported">已取得文件信息；此类型暂不支持内嵌预览，请使用“下载到 Mac”。</p>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (isMobileApp()) return copyMobileText(value);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "0";
  field.style.top = "0";
  field.style.width = "1px";
  field.style.height = "1px";
  field.style.padding = "0";
  field.style.border = "0";
  field.style.opacity = "0.01";
  field.style.fontSize = "16px";
  document.body.append(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
    copied = document.execCommand("copy");
  } finally {
    field.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // The synchronous fallback above keeps working on HTTP LAN pages and iOS Safari.
    }
  }
  if (!copied) throw new Error("此浏览器无法访问剪贴板。");
}
