import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { getActionToken, getJson } from "./api.js";
import { CodeTextViewer } from "./CodeTextViewer.js";
import { BridgeImage } from "./BridgeMedia.js";
import { isBridgeApiPath } from "./mobile-connection.js";
import { useSystemNavigation } from "./WebNavigation.js";
import { copyMobileImage, copyMobileText, downloadBridgeFile, getBridgeOrigin, isMobileApp, openBridgeExternal } from "./mobile-runtime.js";
import { normalizeSessionPathInput, sessionPathName, sessionPathParent } from "./tmux-session-path.js";
import { useMobileBack } from "./use-mobile-back.js";

const API_ROOT = "/tmux-dashboard/api";
const PREVIEW_TEXT_LIMIT = 2 * 1024 * 1024;
const PREVIEW_HISTORY_LIMIT = 50;
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

interface SessionFileMarkdownLinkContextValue {
  sessionId: string;
  currentFilePath: string;
  onOpenFile: (relativePath: string) => void;
  onInvalidLink: () => void;
}

const SESSION_FILE_MARKDOWN_LINK_CONTEXT = createContext<SessionFileMarkdownLinkContextValue | null>(null);

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
  a: ({ node, ...props }) => {
    void node;
    return <SessionFileMarkdownAnchor {...props} />;
  },
  img: ({ node, ...props }) => {
    void node;
    return <SessionFileMarkdownImage {...props} />;
  },
};

function SessionFileMarkdownImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>): ReactElement {
  const context = useContext(SESSION_FILE_MARKDOWN_LINK_CONTEXT);
  if (!isMobileApp()) return <img {...props} src={src} />;
  const path = context && src && !isBridgeApiPath(src.split(/[?#]/, 1)[0] ?? "") && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)
    ? resolveSessionMarkdownFilePath(context.currentFilePath, src) : null;
  return <BridgeImage {...props} src={context && path ? sessionFilesUrl(context.sessionId, "download", path) : src} />;
}

function SessionFileMarkdownAnchor({ href, children, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>): ReactElement {
  const context = useContext(SESSION_FILE_MARKDOWN_LINK_CONTEXT);
  const trimmedHref = href?.trim() ?? "";
  const isExternalWebLink = /^(?:https?:\/\/|\/\/|mailto:|tel:)/i.test(trimmedHref);
  const hasUnsupportedProtocol = /^[a-z][a-z\d+.-]*:/i.test(trimmedHref) && !isExternalWebLink;

  if (!context || !trimmedHref || trimmedHref.startsWith("#")) {
    return <a {...props} href={href} onClick={onClick}>{children}</a>;
  }
  if (isExternalWebLink) {
    return <a {...props} href={href} onClick={(event) => {
      onClick?.(event);
      if (event.defaultPrevented || !isMobileApp() || !/^https?:\/\/|^\/\//i.test(trimmedHref)) return;
      event.preventDefault();
      void openBridgeExternal(trimmedHref).catch(() => context.onInvalidLink());
    }} target={/^https?:\/\/|^\/\//i.test(trimmedHref) ? "_blank" : undefined} rel="noreferrer">{children}</a>;
  }
  if (hasUnsupportedProtocol) return <span>{children}</span>;

  const targetPath = resolveSessionMarkdownFilePath(context.currentFilePath, trimmedHref);
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (targetPath === null) context.onInvalidLink();
        else context.onOpenFile(targetPath);
      }}
    >
      {children}
    </a>
  );
}

function sessionFilesUrl(sessionId: string, action: "list" | "upload" | "download", path: string): string {
  const suffix = action === "list" ? "" : `/${action}`;
  const url = new URL(`${API_ROOT}/sessions/${encodeURIComponent(sessionId)}/files${suffix}`, getBridgeOrigin());
  url.searchParams.set("path", path);
  return url.pathname + url.search;
}

function fileRelativePath(currentPath: string, name: string): string {
  return currentPath ? `${currentPath}/${name}` : name;
}

function resolveSessionMarkdownFilePath(currentFilePath: string, href: string): string | null {
  const pathValue = href.replaceAll("\\", "/").split(/[?#]/, 1)[0] ?? "";
  if (!pathValue) return null;

  const pathParts = pathValue.startsWith("/")
    ? []
    : currentFilePath.split("/").filter(Boolean).slice(0, -1);
  for (const rawPart of pathValue.split("/")) {
    let part: string;
    try {
      part = decodeURIComponent(rawPart);
    } catch {
      return null;
    }
    if (!part || part === ".") continue;
    if (part === "..") {
      if (pathParts.length === 0) return null;
      pathParts.pop();
      continue;
    }
    if (part.includes("/") || part.includes("\\") || part.includes("\0")) return null;
    pathParts.push(part);
  }
  return pathParts.length > 0 ? pathParts.join("/") : null;
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
  const [previewHistory, setPreviewHistory] = useState<string[]>([]);
  const [previewNavigationBusy, setPreviewNavigationBusy] = useState(false);
  const [pathNavigationBusy, setPathNavigationBusy] = useState(false);
  const [filenameQuery, setFilenameQuery] = useState("");
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewGeneration = useRef(0);
  const closePreview = useCallback((): void => {
    previewGeneration.current += 1;
    previewAbortRef.current?.abort();
    setPreview(null); setPreviewHistory([]); setPreviewNavigationBusy(false);
  }, []);
  useMobileBack(Boolean(preview) || previewNavigationBusy, closePreview, 80);
  useMobileBack(true, () => {
    if (currentPath) setCurrentPath(sessionPathParent(currentPath));
    else navigate(`/tmux-dashboard?session=${encodeURIComponent(sessionId)}`);
  }, 0, { escape: false, restoreFocus: false });

  useEffect(() => {
    return () => { previewGeneration.current += 1; previewAbortRef.current?.abort(); };
  }, [sessionId]);

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
      if (event.key === "Escape") {
        closePreview();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [preview, closePreview]);

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

  const shareFile = async (relativePath: string, name: string): Promise<void> => {
    setError("");
    setNotice("");
    try {
      await downloadBridgeFile(sessionFilesUrl(sessionId, "download", relativePath), name);
      if (!isMobileApp()) setNotice(`已开始下载：${name}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "文件下载失败。");
    }
  };

  const copyPreview = async (file: FilePreview): Promise<void> => {
    if (file.type === "image") {
      try {
        if (isMobileApp()) await copyMobileImage(file.blob);
        else await copyImageToClipboard(file.blob);
        setError("");
        setNotice(`已复制图片：${file.relativePath}`);
        return;
      } catch (copyError) {
        if (isMobileApp()) {
          setError(copyError instanceof Error ? copyError.message : "图片复制失败，可保存或分享后重试。");
          return;
        }
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

  const openPreview = useCallback(async (entry: SessionFileEntry, directoryPath = currentPath): Promise<boolean> => {
    previewAbortRef.current?.abort();
    const controller = new AbortController(); previewAbortRef.current = controller;
    const generation = ++previewGeneration.current;
    setError("");
    setNotice("");
    const relativePath = fileRelativePath(directoryPath, entry.name);
    const extension = fileExtension(entry.name);
    if (IMAGE_EXTENSIONS.has(extension)) {
      try {
        const response = await fetch(sessionFilesUrl(sessionId, "download", relativePath), { signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response));
        const blob = await response.blob();
        if (controller.signal.aborted || generation !== previewGeneration.current) return false;
        const url = URL.createObjectURL(blob);
        setPreview({ name: entry.name, relativePath, size: entry.size, type: "image", url, blob });
        return true;
      } catch (previewError) {
        if (controller.signal.aborted) return false;
        setError(previewError instanceof Error ? previewError.message : "Could not preview this image.");
        return false;
      }
    }
    if (!TEXT_EXTENSIONS.has(extension)) {
      setError("该文件类型暂不支持在线预览，请使用下载操作。");
      return false;
    }
    if (entry.size > PREVIEW_TEXT_LIMIT) {
      setError("文件超过 2 MB，请下载后查看。");
      return false;
    }
    try {
      const response = await fetch(sessionFilesUrl(sessionId, "download", relativePath), { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const text = await response.text();
      if (controller.signal.aborted || generation !== previewGeneration.current) return false;
      setPreview({ name: entry.name, relativePath, size: entry.size, type: extension === "md" || extension === "markdown" ? "markdown" : "text", text });
      return true;
    } catch (previewError) {
      if (controller.signal.aborted) return false;
      setError(previewError instanceof Error ? previewError.message : "Could not preview this file.");
      return false;
    }
  }, [currentPath, sessionId]);

  const openSessionFilePreview = useCallback(async (relativePath: string): Promise<boolean> => {
    previewAbortRef.current?.abort();
    const controller = new AbortController(); previewAbortRef.current = controller;
    const generation = ++previewGeneration.current;
    setError("");
    setNotice("");
    const name = lastPathPart(relativePath);
    const directoryPath = relativePath.split("/").filter(Boolean).slice(0, -1).join("/");
    if (!name) {
      setError("此 Markdown 链接没有指向可打开的文件。");
      return false;
    }
    try {
      const directory = await getJson<SessionFileListing>(sessionFilesUrl(sessionId, "list", directoryPath), { signal: controller.signal });
      if (controller.signal.aborted || generation !== previewGeneration.current) return false;
      const entry = directory.entries.find((candidate) => candidate.name === name);
      if (!entry) throw new Error("链接指向的文件不存在或不在此 session 的工作目录内。");
      if (entry.type === "directory") {
        throw new Error("链接指向的是文件夹，请先关闭预览再从文件列表进入。");
      }
      return await openPreview(entry, directoryPath);
    } catch (openError) {
      if (controller.signal.aborted) return false;
      setError(openError instanceof Error ? openError.message : "无法打开这个 Markdown 链接。");
      return false;
    }
  }, [openPreview, sessionId]);

  const openMarkdownFile = useCallback(async (relativePath: string): Promise<void> => {
    if (previewNavigationBusy) return;
    setPreviewNavigationBusy(true);
    const previousPath = preview?.type === "markdown" ? preview.relativePath : null;
    try {
      const opened = await openSessionFilePreview(relativePath);
      if (opened && previousPath) {
        setPreviewHistory((history) => [...history, previousPath].slice(-PREVIEW_HISTORY_LIMIT));
      }
    } finally {
      setPreviewNavigationBusy(false);
    }
  }, [openSessionFilePreview, preview, previewNavigationBusy]);

  const returnToPreviousPreview = useCallback(async (): Promise<void> => {
    if (previewNavigationBusy) return;
    const previousPath = previewHistory.at(-1);
    if (!previousPath) return;
    setPreviewNavigationBusy(true);
    try {
      if (await openSessionFilePreview(previousPath)) {
        setPreviewHistory((history) => history.slice(0, -1));
      }
    } finally {
      setPreviewNavigationBusy(false);
    }
  }, [openSessionFilePreview, previewHistory, previewNavigationBusy]);

  const reportInvalidMarkdownLink = useCallback((): void => {
    setError("此 Markdown 链接无效，或试图访问 session 工作目录之外的路径。");
  }, []);

  const markdownLinkContext = useMemo<SessionFileMarkdownLinkContextValue>(() => ({
    sessionId,
    currentFilePath: preview?.type === "markdown" ? preview.relativePath : "",
    onOpenFile: openMarkdownFile,
    onInvalidLink: reportInvalidMarkdownLink,
  }), [openMarkdownFile, preview, reportInvalidMarkdownLink, sessionId]);

  const navigateToPath = (path: string): void => {
    setFilenameQuery("");
    setPreviewHistory([]);
    setCurrentPath(path);
  };

  const navigateFromPathInput = async (): Promise<void> => {
    const normalized = normalizeSessionPathInput(filenameQuery);
    if (!normalized) {
      setError("请输入当前 Session 根目录下的相对路径，不要使用绝对路径或 ..。");
      return;
    }
    setPathNavigationBusy(true);
    setError("");
    setNotice("");
    try {
      const direct = await getJson<SessionFileListing>(sessionFilesUrl(sessionId, "list", normalized.path)).catch(() => null);
      if (direct) {
        navigateToPath(normalized.path);
        return;
      }
      if (normalized.hasTrailingSlash) {
        throw new Error("目标文件夹不存在，或当前 Session 无权访问。");
      }
      const parentPath = sessionPathParent(normalized.path);
      const parent = await getJson<SessionFileListing>(sessionFilesUrl(sessionId, "list", parentPath)).catch(() => null);
      const name = sessionPathName(normalized.path);
      const entry = parent?.entries.find((candidate) => candidate.name === name);
      if (entry?.type === "file") {
        navigateToPath(parentPath);
        return;
      }
      if (entry?.type === "directory") {
        navigateToPath(normalized.path);
        return;
      }
      throw new Error("找不到这个相对路径，请确认文件或文件夹名称正确。");
    } catch (pathError) {
      setError(pathError instanceof Error ? pathError.message : "无法打开这个相对路径。");
    } finally {
      setPathNavigationBusy(false);
    }
  };

  const openEntry = (entry: SessionFileEntry): void => {
    setError("");
    setNotice("");
    if (entry.type === "directory") {
      navigateToPath(fileRelativePath(currentPath, entry.name));
      return;
    }
    setPreviewHistory([]);
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
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void navigateFromPathInput();
                }
              }}
              placeholder="按文件名检索，输入相对路径后回车"
              aria-label="按文件名检索或输入相对路径跳转"
              disabled={pathNavigationBusy}
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
                    onClick={(event) => {
                      if (!isMobileApp()) return;
                      event.preventDefault();
                      void shareFile(fileRelativePath(currentPath, entry.name), entry.name);
                    }}
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
        <p className="tmux-files-footnote">上传会写入当前目录；{isMobileApp() ? "Android 下载会保存到系统 Downloads，iOS 下载会打开保存/分享面板。" : "下载位置由浏览器的下载设置决定。"}列表复制文件名，预览复制内容；转发会把相对文件名追加到对应 Session 的聊天框。文件访问限制在 session 工作目录内。</p>
      </section>

      {preview ? (
        <div className="tmux-files-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
          <section className="tmux-files-preview" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`}>
            <header>
              <strong title={preview.name}>{preview.name}</strong>
              <div className="tmux-files-preview-actions">
                {previewHistory.length > 0 ? (
                  <button
                    type="button"
                    aria-label="返回上一个文件预览"
                    title={`返回 ${lastPathPart(previewHistory[previewHistory.length - 1]!)}`}
                    disabled={previewNavigationBusy}
                    onClick={() => void returnToPreviousPreview()}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H4m7-7-7 7 7 7" /></svg>
                  </button>
                ) : null}
                <a
                  href={sessionFilesUrl(sessionId, "download", preview.relativePath)}
                  download={preview.name}
                  aria-label={`下载 ${preview.name}`}
                  title={isMobileApp() && preview.type === "image" ? "保存图片" : "下载"}
                  onClick={(event) => {
                    if (!isMobileApp()) return;
                    event.preventDefault();
                    void shareFile(preview.relativePath, preview.name);
                  }}
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
                <button type="button" onClick={closePreview} aria-label="关闭预览" title="关闭预览">×</button>
              </div>
            </header>
            {error ? <div className="tmux-files-message tmux-files-preview-feedback is-error" role="alert">{error}</div> : null}
            {notice ? <div className="tmux-files-message tmux-files-preview-feedback" role="status">{notice}</div> : null}
            {preview.type === "image" ? <img src={preview.url} alt={preview.name} /> : preview.type === "markdown" ? (
              <div className="tmux-files-markdown codex-assistant-markdown">
                <SESSION_FILE_MARKDOWN_LINK_CONTEXT.Provider value={markdownLinkContext}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={SESSION_FILE_MARKDOWN_COMPONENTS}>
                    {preview.text}
                  </ReactMarkdown>
                </SESSION_FILE_MARKDOWN_LINK_CONTEXT.Provider>
              </div>
            ) : <CodeTextViewer fileName={preview.name} text={preview.text} />}
          </section>
        </div>
      ) : null}
    </main>
  );
}
