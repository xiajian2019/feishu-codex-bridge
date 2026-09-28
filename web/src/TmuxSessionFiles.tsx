import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";

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
  "log", "lua", "md", "mjs", "py", "rb", "rs", "sh", "sql", "svg", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
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

type FilePreview = { name: string; type: "image"; url: string } | { name: string; type: "text"; text: string };

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
    const extension = fileExtension(entry.name);
    if (IMAGE_EXTENSIONS.has(extension)) {
      setError("");
      try {
        const response = await fetch(sessionFilesUrl(sessionId, "download", fileRelativePath(currentPath, entry.name)));
        if (!response.ok) throw new Error(await responseError(response));
        const url = URL.createObjectURL(await response.blob());
        setPreview({ name: entry.name, type: "image", url });
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
    setError("");
    try {
      const response = await fetch(sessionFilesUrl(sessionId, "download", fileRelativePath(currentPath, entry.name)));
      if (!response.ok) throw new Error(await responseError(response));
      setPreview({ name: entry.name, type: "text", text: await response.text() });
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
            <div className="tmux-files-row" key={entry.name}>
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
                  <button type="button" onClick={() => void openPreview(entry)}>预览</button>
                ) : null}
                {entry.type === "file" ? (
                  <a href={sessionFilesUrl(sessionId, "download", fileRelativePath(currentPath, entry.name))} download={entry.name}>下载</a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <p className="tmux-files-footnote">上传会写入当前目录；下载位置由浏览器的下载设置决定。文件访问限制在 session 工作目录内。</p>
      </section>

      {preview ? (
        <div className="tmux-files-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
          <section className="tmux-files-preview" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`}>
            <header><strong title={preview.name}>{preview.name}</strong><button type="button" onClick={() => setPreview(null)} aria-label="关闭预览">×</button></header>
            {preview.type === "image" ? <img src={preview.url} alt={preview.name} /> : <CodeTextViewer fileName={preview.name} text={preview.text} />}
          </section>
        </div>
      ) : null}
    </main>
  );
}
