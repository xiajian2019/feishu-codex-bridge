import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { getActionToken, getJson } from "./api.js";
import { CodeTextViewer } from "./CodeTextViewer.js";
import { useSystemNavigation } from "./WebNavigation.js";

const API_ROOT = "/tmux-dashboard/api";
const PREVIEW_TEXT_LIMIT = 2 * 1024 * 1024;
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const COMPACT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });
const IMAGE_EXTENSIONS = new Set(["apng", "avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const TEXT_EXTENSIONS = new Set([
  "c", "cc", "conf", "cpp", "css", "csv", "go", "h", "hpp", "html", "ini", "java", "js", "json", "jsx",
  "log", "lua", "md", "markdown", "mjs", "py", "rb", "rs", "sh", "sql", "svg", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
]);

interface SessionFileEntry {
  name: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: number;
}

interface SessionFileListing {
  session: { id: string; name: string };
  root: string;
  path: string;
  entries: SessionFileEntry[];
}

type FilePreview =
  | { name: string; relativePath: string; size: number; type: "image"; url: string; blob: Blob }
  | { name: string; relativePath: string; size: number; type: "markdown" | "text"; text: string };

type SessionFileAction = "view" | "download" | "copy" | "forward";

function SessionFileActionIcon({ action }: { action: SessionFileAction }): ReactElement {
  if (action === "view") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
  }
  if (action === "download") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4 16.5v3h16v-3" /></svg>;
  }
  if (action === "copy") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 4 7 7-7 7" /><path d="M20 11H9a5 5 0 0 0-5 5v2" /></svg>;
}

const SESSION_FILE_MARKDOWN_COMPONENTS: Components = {
  table: ({ node, ...props }) => {
    void node;
    return <div className="codex-markdown-table-scroll"><table {...props} /></div>;
  },
};

function sessionFilesUrl(sessionId: string, action: "list" | "upload" | "download", path: string): string {
  const suffix = action === "list" ? "" : `/${action}`;
  const url = new URL(`${API_ROOT}/sessions/${encodeURIComponent(sessionId)}/files${suffix}`, window.location.origin);
  url.searchParams.set("path", path);
  return url.pathname + url.search;
}

function fileRelativePath(currentPath: string, name: string): string {
  return currentPath ? `${currentPath}/${name}` : name;
}

function lastPathPart(value: string): string {
  return value.split(/[\\/]+/).filter(Boolean).slice(-1)[0] ?? "";
}

function fuzzyFileNameMatch(fileName: string, query: string): boolean {
  const normalizedName = fileName.normalize("NFKC").toLocaleLowerCase();
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "");
  if (!normalizedQuery || normalizedName.includes(normalizedQuery)) return true;
  let queryIndex = 0;
  const queryCharacters = Array.from(normalizedQuery);
  for (const character of Array.from(normalizedName)) {
    if (character === queryCharacters[queryIndex]) queryIndex += 1;
    if (queryIndex === queryCharacters.length) return true;
  }
  return false;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatModifiedAt(value: number): string {
  return FULL_DATE_FORMATTER.format(new Date(value));
}

function formatCompactModifiedAt(value: number): string {
  return COMPACT_DATE_FORMATTER.format(new Date(value));
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

async function copyTextToClipboard(value: string): Promise<void> {
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

async function copyImageToClipboard(blob: Blob): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined" || !blob.type.startsWith("image/")) {
    throw new Error("此浏览器不支持复制图片。");
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export function TmuxSessionFiles(): ReactElement {
  const navigate = useNavigate();
  const { collapsed: navigationCollapsed } = useSystemNavigation();
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  const [currentPath, setCurrentPath] = useState("");
  const [listing, setListing] = useState<SessionFileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [filenameQuery, setFilenameQuery] = useState("");
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getJson<SessionFileListing>(sessionFilesUrl(sessionId, "list", currentPath), { signal: controller.signal })
      .then(setListing)
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : "Could not read this directory.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [currentPath, refreshKey, sessionId]);

  useEffect(() => {
    if (preview?.type !== "image") return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  useEffect(() => {
    if (!preview) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [preview]);

  const breadcrumbSegments = useMemo(() => currentPath.split("/").filter(Boolean), [currentPath]);
  const visibleEntries = useMemo(() => {
    const entries = listing?.entries ?? [];
    const query = filenameQuery.trim();
    return query ? entries.filter((entry) => fuzzyFileNameMatch(entry.name, query)) : entries;
  }, [filenameQuery, listing]);
  const currentDirectoryName = currentPath.split("/").filter(Boolean).slice(-1)[0]
    || lastPathPart(listing?.root ?? "")
    || listing?.session.name
    || "Session files";
  const currentDirectoryPath = listing
    ? currentPath
      ? `${listing.root.replace(/[\\/]+$/, "")}/${currentPath}`
      : listing.root
    : "读取 session 工作目录…";

  const goBackToSession = (): void => {
    navigate(`/tmux-dashboard?session=${encodeURIComponent(sessionId)}`);
  };

  const forwardFileToSession = (relativePath: string): void => {
    navigate(`/tmux-dashboard?session=${encodeURIComponent(sessionId)}`, {
      state: {
        sessionFileForward: {
          id: `${Date.now()}-${Math.random()}`,
          sessionId,
          text: relativePath,
        },
      },
    });
  };

  const copyFileName = async (relativePath: string): Promise<void> => {
    setError("");
    setNotice("");
    try {
      await copyTextToClipboard(relativePath);
      setNotice(`已复制文件名：${relativePath}`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制文件失败。");
    }
  };

  const copyPreview = async (file: FilePreview): Promise<void> => {
    if (file.type === "image") {
      try {
        await copyImageToClipboard(file.blob);
        setError("");
        setNotice(`已复制图片：${file.relativePath}`);
        return;
      } catch {
        // Fall through to copying the relative file name.
      }
    } else {
      try {
        await copyTextToClipboard(file.text);
        setError("");
        setNotice(`已复制文件内容：${file.relativePath}`);
        return;
      } catch (copyError) {
        setError(copyError instanceof Error ? copyError.message : "复制文件失败。");
        return;
      }
    }
    try {
      await copyTextToClipboard(file.relativePath);
      setError("");
      setNotice(`已复制文件名：${file.relativePath}`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制文件失败。");
    }
  };

  const uploadFiles = useCallback(async (files: FileList | File[]): Promise<void> => {
    const selectedFiles = Array.from(files);
    if (selectedFiles.length === 0) return;
    setError("");
    setNotice("");
    setUploading(`准备上传 ${selectedFiles.length} 个文件…`);
    let uploadedCount = 0;
    try {
      const token = await getActionToken();
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index]!;
        setUploading(`上传中 ${index + 1}/${selectedFiles.length}：${file.name}`);
        const response = await fetch(sessionFilesUrl(sessionId, "upload", currentPath), {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
            "X-Bridge-Action-Token": token,
          },
          body: file,
        });
        if (!response.ok) throw new Error(await responseError(response));
        uploadedCount += 1;
      }
      setNotice(`已上传 ${uploadedCount} 个文件。`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
      if (uploadedCount > 0) setNotice(`已上传 ${uploadedCount} 个文件，其余文件未完成。`);
    } finally {
      setUploading("");
      if (uploadedCount > 0) setRefreshKey((value) => value + 1);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }, [currentPath, sessionId]);

  const openPreview = async (entry: SessionFileEntry): Promise<void> => {
    setPreview(null);
    setError("");
    setNotice("");
    const relativePath = fileRelativePath(currentPath, entry.name);
    const extension = fileExtension(entry.name);
    if (IMAGE_EXTENSIONS.has(extension)) {
      try {
        const response = await fetch(sessionFilesUrl(sessionId, "download", relativePath));
        if (!response.ok) throw new Error(await responseError(response));
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setPreview({ name: entry.name, relativePath, size: entry.size, type: "image", url, blob });
      } catch (previewError) {
        setError(previewError instanceof Error ? previewError.message : "Could not preview this image.");
      }
      return;
    }
    if (!TEXT_EXTENSIONS.has(extension)) {
      setError("该文件类型暂不支持在线预览，请使用下载操作。");
      return;
    }
    if (entry.size > PREVIEW_TEXT_LIMIT) {
      setError("文件超过 2 MB，请下载后查看。");
      return;
    }
    try {
      const response = await fetch(sessionFilesUrl(sessionId, "download", relativePath));
      if (!response.ok) throw new Error(await responseError(response));
      setPreview({ name: entry.name, relativePath, size: entry.size, type: extension === "md" || extension === "markdown" ? "markdown" : "text", text: await response.text() });
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not preview this file.");
    }
  };

  const navigateToPath = (path: string): void => {
    setFilenameQuery("");
    setCurrentPath(path);
  };

  const openEntry = (entry: SessionFileEntry): void => {
    setError("");
    setNotice("");
    if (entry.type === "directory") {
      navigateToPath(fileRelativePath(currentPath, entry.name));
      return;
    }
    void openPreview(entry);
  };

  const refresh = (): void => setRefreshKey((value) => value + 1);

  return (
    <main className={`tmux-files-page${navigationCollapsed ? " is-navigation-collapsed" : ""}`}>
      <header className="tmux-files-header">
        <div className="tmux-files-title">
          <h1>{currentDirectoryName}</h1>
          <p title={currentDirectoryPath}>{currentDirectoryPath}</p>
        </div>
        <button className="tmux-files-back" type="button" onClick={goBackToSession}>返回 <span>Session</span></button>
      </header>

      <section className="tmux-files-body" aria-label="Session 文件管理器">
        <div className="tmux-files-location">
          <div className="tmux-files-location-bar">
            <nav aria-label="文件路径">
              <button type="button" onClick={() => navigateToPath("")} title={listing?.root ?? "Session root"}>Session 根目录</button>
              {breadcrumbSegments.map((segment, index) => {
                const path = breadcrumbSegments.slice(0, index + 1).join("/");
                return (
                  <span className="tmux-files-crumb" key={path}>
                    <span aria-hidden="true">/</span>
                    <button type="button" onClick={() => navigateToPath(path)}>{segment}</button>
                  </span>
                );
              })}
            </nav>
            <div className="tmux-files-actions">
              <button type="button" onClick={refresh} disabled={loading || Boolean(uploading)}>刷新</button>
              <button className="is-upload" type="button" onClick={() => uploadInputRef.current?.click()} disabled={loading || Boolean(uploading) || !listing}>
                {uploading ? "上传中…" : "上传"}
              </button>
              <input ref={uploadInputRef} type="file" multiple hidden onChange={(event) => void uploadFiles(event.currentTarget.files ?? [])} />
            </div>
          </div>
          <label className="tmux-files-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={filenameQuery}
              onChange={(event) => setFilenameQuery(event.currentTarget.value)}
              placeholder="按文件名模糊检索当前目录"
              aria-label="按文件名模糊检索当前目录"
            />
            {filenameQuery ? <span className="tmux-files-search-count">{visibleEntries.length} 项</span> : null}
          </label>
        </div>

        {error ? <div className="tmux-files-message is-error" role="alert">{error}</div> : null}
        {notice ? <div className="tmux-files-message" role="status">{notice}</div> : null}
        {uploading ? <div className="tmux-files-upload-status" role="status">{uploading}</div> : null}

        <div className="tmux-files-list" aria-live="polite">
          <div className="tmux-files-list-heading"><span>名称</span><span>大小</span><span>修改时间</span><span>操作</span></div>
          {loading ? <p className="tmux-files-empty">正在读取目录…</p> : null}
          {!loading && !error && visibleEntries.length === 0 ? (
            <p className="tmux-files-empty">{filenameQuery.trim() ? "没有匹配的文件。" : "这个目录为空。"}</p>
          ) : null}
          {!loading && visibleEntries.map((entry) => (
            <div className={`tmux-files-row${entry.type === "file" ? " has-actions" : ""}`} key={entry.name}>
              <div className="tmux-files-row-content">
                <div className={`tmux-files-name${entry.type === "directory" ? " is-directory" : ""}`}>
                  <span aria-hidden="true">{entry.type === "directory" ? "▰" : "▤"}</span><span>{entry.name}</span>
                </div>
                <span className="tmux-files-size">{entry.type === "directory" ? "—" : formatFileSize(entry.size)}</span>
                <span className="tmux-files-date">
                  <span className="tmux-files-date-full">{formatModifiedAt(entry.modifiedAt)}</span>
                  <span className="tmux-files-date-compact">{formatCompactModifiedAt(entry.modifiedAt)}</span>
                </span>
              </div>
              <button
                className="tmux-files-row-open"
                type="button"
                aria-label={entry.type === "directory" ? `打开文件夹 ${entry.name}` : `预览文件 ${entry.name}`}
                onClick={() => openEntry(entry)}
              />
              <div className="tmux-files-row-actions">
                {entry.type === "file" && (IMAGE_EXTENSIONS.has(fileExtension(entry.name)) || TEXT_EXTENSIONS.has(fileExtension(entry.name))) ? (
                  <button type="button" aria-label={`查看 ${entry.name}`} title="查看" onClick={() => void openPreview(entry)}>
                    <SessionFileActionIcon action="view" />
                  </button>
                ) : null}
                {entry.type === "file" ? (
                  <a
                    href={sessionFilesUrl(sessionId, "download", fileRelativePath(currentPath, entry.name))}
                    download={entry.name}
                    aria-label={`下载 ${entry.name}`}
                    title="下载"
                  >
                    <SessionFileActionIcon action="download" />
                  </a>
                ) : null}
                {entry.type === "file" ? (
                  <button
                    type="button"
                    aria-label={`复制 ${entry.name}`}
                    title="复制文件名"
                    onClick={() => void copyFileName(fileRelativePath(currentPath, entry.name))}
                  >
                    <SessionFileActionIcon action="copy" />
                  </button>
                ) : null}
                {entry.type === "file" ? (
                  <button
                    type="button"
                    aria-label={`转发 ${entry.name} 到 Session 聊天框`}
                    title="转发到 Session 聊天框"
                    onClick={() => forwardFileToSession(fileRelativePath(currentPath, entry.name))}
                  >
                    <SessionFileActionIcon action="forward" />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <p className="tmux-files-footnote">上传会写入当前目录；下载位置由浏览器的下载设置决定。列表复制文件名，预览复制内容；转发会把相对文件名追加到对应 Session 的聊天框。文件访问限制在 session 工作目录内。</p>
      </section>

      {preview ? (
        <div className="tmux-files-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
          <section className="tmux-files-preview" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`}>
            <header>
              <strong title={preview.name}>{preview.name}</strong>
              <div className="tmux-files-preview-actions">
                <a
                  href={sessionFilesUrl(sessionId, "download", preview.relativePath)}
                  download={preview.name}
                  aria-label={`下载 ${preview.name}`}
                  title="下载"
                >
                  <SessionFileActionIcon action="download" />
                </a>
                <button type="button" aria-label={`复制 ${preview.name}`} title="复制内容" onClick={() => void copyPreview(preview)}>
                  <SessionFileActionIcon action="copy" />
                </button>
                <button
                  type="button"
                  aria-label={`转发 ${preview.name} 到 Session 聊天框`}
                  title="转发到 Session 聊天框"
                  onClick={() => forwardFileToSession(preview.relativePath)}
                >
                  <SessionFileActionIcon action="forward" />
                </button>
                <button type="button" onClick={() => setPreview(null)} aria-label="关闭预览" title="关闭预览">×</button>
              </div>
            </header>
            {error ? <div className="tmux-files-message tmux-files-preview-feedback is-error" role="alert">{error}</div> : null}
            {notice ? <div className="tmux-files-message tmux-files-preview-feedback" role="status">{notice}</div> : null}
            {preview.type === "image" ? <img src={preview.url} alt={preview.name} /> : preview.type === "markdown" ? (
              <div className="tmux-files-markdown codex-assistant-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={SESSION_FILE_MARKDOWN_COMPONENTS}>
                  {preview.text}
                </ReactMarkdown>
              </div>
            ) : <CodeTextViewer fileName={preview.name} text={preview.text} />}
          </section>
        </div>
      ) : null}
    </main>
  );
}
