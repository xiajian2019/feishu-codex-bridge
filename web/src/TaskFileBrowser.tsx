import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { getJson } from "./api.js";
import { CodeTextViewer } from "./CodeTextViewer.js";

const TEXT_EXTENSIONS = new Set([
  "c", "cc", "conf", "cpp", "css", "csv", "go", "h", "hpp", "html", "ini", "java", "js", "json", "jsx",
  "log", "lua", "md", "markdown", "mjs", "py", "rb", "rs", "sh", "sql", "svg", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
]);
const IMAGE_EXTENSIONS = new Set(["apng", "avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024;

interface TaskFileEntry {
  name: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: number;
}

interface TaskFileListing {
  root: string;
  path: string;
  entries: TaskFileEntry[];
}

type TaskFilePreview =
  | { name: string; path: string; type: "image"; url: string }
  | { name: string; path: string; lineNumber?: number; type: "markdown" | "code"; text: string };

type MarkdownFileTarget = { path: string; lineNumber?: number } | { outside: true };

const TASK_FILE_MARKDOWN_COMPONENTS: Components = {
  table: ({ node, ...props }) => {
    void node;
    return <div className="codex-markdown-table-scroll"><table {...props} /></div>;
  },
};

function taskFileUrl(taskGuid: string, action: "list" | "content" | "download", path: string): string {
  const suffix = action === "list" ? "" : `/${action}`;
  const url = new URL(`/api/tasks/${encodeURIComponent(taskGuid)}/files${suffix}`, window.location.origin);
  url.searchParams.set("path", path);
  return url.pathname + url.search;
}

function joinTaskFilePath(currentPath: string, name: string): string {
  return currentPath ? `${currentPath}/${name}` : name;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
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

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatModifiedAt(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `请求失败：${response.status}`;
}

function resolveMarkdownFileTarget(
  href: string,
  rootPath: string,
  markdownPath: string,
): MarkdownFileTarget | null {
  let value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const url = new URL(value, window.location.origin);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== window.location.origin) return null;
      value = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  }

  let lineNumber: number | undefined;
  const hashIndex = value.indexOf("#");
  if (hashIndex >= 0) {
    const fragment = value.slice(hashIndex + 1);
    const lineFragment = /^L(\d+)(?:-L?\d+)?$/i.exec(fragment);
    if (lineFragment) lineNumber = Number(lineFragment[1]);
    else if (hashIndex === 0) return null;
    value = value.slice(0, hashIndex);
  }
  const queryIndex = value.indexOf("?");
  if (queryIndex >= 0) value = value.slice(0, queryIndex);
  const lineSuffix = /:(\d+)(?::\d+)?$/.exec(value);
  if (lineSuffix) {
    lineNumber ??= Number(lineSuffix[1]);
    value = value.slice(0, lineSuffix.index);
  }

  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep a literal percent sign in a filesystem name when it is not URI encoded.
  }
  value = value.replaceAll("\\", "/");
  const normalizedRoot = rootPath.replaceAll("\\", "/").replace(/\/+$/, "");
  let pathParts: string[];
  if (value === normalizedRoot) {
    pathParts = [];
    value = "";
  } else if (value.startsWith(`${normalizedRoot}/`)) {
    pathParts = [];
    value = value.slice(normalizedRoot.length + 1);
  } else if (value.startsWith("/")) {
    return /^\/(Users|private|home|tmp|var|opt|Volumes)\//.test(value) ? { outside: true } : null;
  } else {
    pathParts = markdownPath.split("/").filter(Boolean).slice(0, -1);
  }

  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (pathParts.length === 0) return { outside: true };
      pathParts.pop();
    } else {
      pathParts.push(part);
    }
  }
  return { path: pathParts.join("/"), ...(lineNumber ? { lineNumber } : {}) };
}

export function TaskFileBrowser({ taskGuid, initialFilePath }: { taskGuid: string; initialFilePath?: string }): ReactElement {
  const [currentPath, setCurrentPath] = useState("");
  const [listing, setListing] = useState<TaskFileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [filenameQuery, setFilenameQuery] = useState("");
  const [preview, setPreview] = useState<TaskFilePreview | null>(null);
  const previewRequestRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getJson<TaskFileListing>(taskFileUrl(taskGuid, "list", currentPath), { signal: controller.signal })
      .then(setListing)
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : "读取任务目录失败。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [currentPath, refreshKey, taskGuid]);

  useEffect(() => () => previewAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!preview) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closePreview();
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
  const currentDirectoryName = breadcrumbSegments.at(-1) || listing?.root.split(/[\\/]+/).filter(Boolean).at(-1) || "项目文件";
  const currentDirectoryPath = listing
    ? currentPath ? `${listing.root.replace(/[\\/]+$/, "")}/${currentPath}` : listing.root
    : "读取任务工作目录…";

  const navigateToPath = (path: string): void => {
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    setFilenameQuery("");
    setCurrentPath(path);
    setPreview(null);
    setError("");
  };

  const openPreview = async (entry: TaskFileEntry, basePath = currentPath, lineNumber?: number): Promise<void> => {
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    setPreview(null);
    setError("");
    const extension = extensionOf(entry.name);
    const isImage = IMAGE_EXTENSIONS.has(extension);
    if (!isImage && !TEXT_EXTENSIONS.has(extension)) {
      setError("该文件类型暂不支持在线预览，请下载后查看。");
      return;
    }
    if (entry.size > (isImage ? IMAGE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT)) {
      setError(isImage ? "图片超过 20 MiB，请下载后查看。" : "文件超过 2 MiB，请下载后查看。");
      return;
    }

    const requestId = previewRequestRef.current;
    const controller = new AbortController();
    previewAbortRef.current = controller;
    try {
      const path = joinTaskFilePath(basePath, entry.name);
      if (isImage) {
        setPreview({ name: entry.name, path, type: "image", url: taskFileUrl(taskGuid, "content", path) });
        return;
      }
      const response = await fetch(taskFileUrl(taskGuid, "content", path), { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const text = await response.text();
      if (previewRequestRef.current !== requestId) return;
      setPreview({ name: entry.name, path, lineNumber, type: extension === "md" || extension === "markdown" ? "markdown" : "code", text });
    } catch (previewError) {
      if (!controller.signal.aborted && previewRequestRef.current === requestId) {
        setError(previewError instanceof Error ? previewError.message : "预览文件失败。");
      }
    }
  };

  const openMarkdownTarget = async (target: MarkdownFileTarget): Promise<void> => {
    if ("outside" in target) {
      setError("此链接不在当前任务目录内，无法打开。");
      return;
    }
    if (!target.path) {
      navigateToPath("");
      return;
    }
    const parts = target.path.split("/");
    const name = parts.pop() ?? "";
    const parentPath = parts.join("/");
    try {
      const parent = await getJson<TaskFileListing>(taskFileUrl(taskGuid, "list", parentPath));
      const entry = parent.entries.find((item) => item.name === name);
      if (!entry) {
        setError("Markdown 链接指向的文件或目录不存在。");
        return;
      }
      if (entry.type === "directory") {
        navigateToPath(target.path);
        return;
      }
      setFilenameQuery("");
      setCurrentPath(parentPath);
      setError("");
      void openPreview(entry, parentPath, target.lineNumber);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法打开 Markdown 链接。");
    }
  };

  useEffect(() => {
    if (initialFilePath) void openMarkdownTarget({ path: initialFilePath });
  }, [initialFilePath, taskGuid]);

  const closePreview = (): void => {
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    setPreview(null);
  };

  const openEntry = (entry: TaskFileEntry): void => {
    if (entry.type === "directory") {
      navigateToPath(joinTaskFilePath(currentPath, entry.name));
      return;
    }
    void openPreview(entry);
  };

  return (
    <div className="task-files-browser" aria-label="任务项目文件">
      <div className="task-files-toolbar">
        <nav className="task-files-breadcrumbs" aria-label="文件路径">
          <button type="button" onClick={() => navigateToPath("")} title={listing?.root ?? "项目根目录"}>项目根目录</button>
          {breadcrumbSegments.map((segment, index) => {
            const path = breadcrumbSegments.slice(0, index + 1).join("/");
            return <span key={path}><span aria-hidden="true">/</span><button type="button" onClick={() => navigateToPath(path)}>{segment}</button></span>;
          })}
        </nav>
        <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>刷新</button>
      </div>
      <div className="task-files-location" title={currentDirectoryPath}>{currentDirectoryName} · {currentDirectoryPath}</div>
      <label className="task-files-search">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={filenameQuery}
          onChange={(event) => setFilenameQuery(event.currentTarget.value)}
          placeholder="按文件名模糊检索当前目录"
          aria-label="按文件名模糊检索当前目录"
        />
        {filenameQuery ? <span>{visibleEntries.length} 项</span> : null}
      </label>

      {error ? <div className="task-files-error" role="alert">{error}</div> : null}
      <div className="task-files-list" aria-live="polite">
        <div className="task-files-list-heading"><span>名称</span><span>大小</span><span>修改时间</span><span>操作</span></div>
        {loading ? <p className="task-files-empty">正在读取目录…</p> : null}
        {!loading && !error && visibleEntries.length === 0 ? (
          <p className="task-files-empty">{filenameQuery.trim() ? "没有匹配的文件。" : "这个目录为空。"}</p>
        ) : null}
        {!loading && visibleEntries.map((entry) => {
          const path = joinTaskFilePath(currentPath, entry.name);
          const extension = extensionOf(entry.name);
          const previewable = IMAGE_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension);
          return (
            <div className="task-files-row" key={entry.name}>
              <button
                className={`task-files-name${entry.type === "directory" ? " is-directory" : ""}`}
                type="button"
                onClick={() => openEntry(entry)}
                title={entry.name}
              >
                <span aria-hidden="true">{entry.type === "directory" ? "▰" : "▤"}</span><span>{entry.name}</span>
              </button>
              <span className="task-files-size">{entry.type === "directory" ? "—" : formatFileSize(entry.size)}</span>
              <span className="task-files-date">{formatModifiedAt(entry.modifiedAt)}</span>
              <div className="task-files-row-actions">
                {entry.type === "file" && previewable ? <button type="button" onClick={() => void openPreview(entry)}>预览</button> : null}
                {entry.type === "file" ? <a href={taskFileUrl(taskGuid, "download", path)} download={entry.name}>下载</a> : null}
              </div>
            </div>
          );
        })}
      </div>

      {preview ? (
        <div className="task-files-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
          <section className="task-files-preview" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`}>
            <header>
              <strong title={preview.name}>{preview.name}</strong>
              <div><a href={taskFileUrl(taskGuid, "download", preview.path)} download={preview.name}>下载</a><button type="button" onClick={closePreview}>关闭预览</button></div>
            </header>
            {preview.type === "image" ? <img src={preview.url} alt={preview.name} onError={() => setError("无法读取图片文件，请刷新目录后重试。")} /> : preview.type === "markdown" ? (
              <div className="task-files-markdown codex-assistant-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    ...TASK_FILE_MARKDOWN_COMPONENTS,
                    a: ({ node, href, children, ...props }) => {
                      void node;
                      const target = typeof href === "string" && listing
                        ? resolveMarkdownFileTarget(href, listing.root, preview.path)
                        : null;
                      return (
                        <a
                          {...props}
                          href={href}
                          onClick={(event) => {
                            if (!target) return;
                            event.preventDefault();
                            void openMarkdownTarget(target);
                          }}
                        >{children}</a>
                      );
                    },
                  }}
                >{preview.text}</ReactMarkdown>
              </div>
            ) : <CodeTextViewer fileName={preview.name} text={preview.text} lineNumber={preview.lineNumber} />}
          </section>
        </div>
      ) : null}
    </div>
  );
}
