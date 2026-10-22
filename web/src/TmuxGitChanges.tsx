import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router";

import { getJson } from "./api.js";

const CodeTextViewer = lazy(() => import("./CodeTextViewer.js").then((module) => ({ default: module.CodeTextViewer })));

type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";

interface GitChangeFile {
  path: string;
  oldPath: string | null;
  status: GitChangeStatus;
  staged: boolean;
  unstaged: boolean;
  sizeBytes: number | null;
  downloadable: boolean;
}

interface GitChangesResponse {
  sessionId: string;
  session: { id: string; name: string };
  directory: string;
  gitRoot: string;
  branch: string | null;
  headCommit: string;
  files: GitChangeFile[];
  patch: string;
  patchTruncated: boolean;
}

interface GitFilePreview {
  path: string;
  sizeBytes: number;
  kind: "text" | "binary";
  text: string | null;
  truncated: boolean;
}

function formatSizeKb(size: number | null | undefined): string {
  return typeof size === "number" ? (size / 1024).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " KB" : "";
}

function formatPreviewText(preview: GitFilePreview): string {
  if (!preview.truncated && preview.path.toLowerCase().endsWith(".json") && preview.text) {
    try {
      const formatted = JSON.stringify(JSON.parse(preview.text), null, 2);
      if (formatted.length <= 2 * 1024 * 1024) return formatted;
    } catch {
      // Partial/invalid JSON remains readable as its original text.
    }
  }
  return preview.text ?? "";
}

function gitFileUrl(sessionId: string, gitRoot: string, path: string, action: "content" | "download"): string {
  const query = new URLSearchParams({ path, expectedGitRoot: gitRoot });
  return "/tmux-dashboard/api/sessions/" + encodeURIComponent(sessionId) + "/git-changes/" + action + "?" + query;
}

const STATUS_LABELS: Record<GitChangeStatus, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  untracked: "未跟踪",
};

function patchSections(patch: string): string[] {
  return patch.split(/(?=^diff --git )/m).filter((section) => section.trim());
}

function sectionMatchesFile(section: string, file: GitChangeFile): boolean {
  for (const line of section.split("\n")) {
    if (line.startsWith("@@")) break;
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    let path = line.slice(4).replace(/\t$/, "");
    if (path.startsWith('"')) {
      try { path = JSON.parse(path) as string; } catch { continue; }
    }
    if (path === "b/" + file.path || path === "a/" + file.path
      || (file.oldPath !== null && path === "a/" + file.oldPath)) return true;
  }
  return false;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "tmux-git-change-line is-file";
  if (line.startsWith("+")) return "tmux-git-change-line is-add";
  if (line.startsWith("-")) return "tmux-git-change-line is-delete";
  if (line.startsWith("@@")) return "tmux-git-change-line is-hunk";
  return "tmux-git-change-line";
}

function renderPatch(patch: string): ReactElement[] {
  return patch.split("\n").map((line, index) => (
    <span className={lineClass(line)} key={index}>{line || " "}<br /></span>
  ));
}

interface TmuxGitChangesProps {
  embedded?: boolean;
  sessionId?: string;
}

export function TmuxGitChanges({ embedded = false, sessionId: sessionIdOverride }: TmuxGitChangesProps = {}): ReactElement {
  const routeParams = useParams<{ sessionId: string }>();
  const sessionId = sessionIdOverride ?? routeParams.sessionId ?? "";
  const [data, setData] = useState<GitChangesResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"diff" | "content">("diff");
  const [contentState, setContentState] = useState<{ url: string; preview?: GitFilePreview; error?: string } | null>(null);

  useEffect(() => {
    setData(null);
    setSelectedPath(null);
    setSearch("");
    setViewMode("diff");
    setContentState(null);
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getJson<GitChangesResponse>(
      "/tmux-dashboard/api/sessions/" + encodeURIComponent(sessionId) + "/git-changes",
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setSelectedPath((current) => current && result.files.some((file) => file.path === current) ? current : null);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, sessionId]);

  const sections = useMemo(() => patchSections(data?.patch ?? ""), [data?.patch]);
  const selectedFile = data?.files.find((file) => file.path === selectedPath) ?? null;
  const selectedPatch = selectedFile
    ? sections.find((section) => sectionMatchesFile(section, selectedFile)) ?? ""
    : data?.patch ?? "";
  const filteredFiles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (data?.files ?? []).filter((file) => !query
      || file.path.toLocaleLowerCase().includes(query)
      || file.oldPath?.toLocaleLowerCase().includes(query));
  }, [data?.files, search]);
  const contentUrl = selectedFile?.downloadable && data
    ? gitFileUrl(sessionId, data.gitRoot, selectedFile.path, "content")
    : null;
  const filePreview = contentState?.url === contentUrl ? contentState?.preview : undefined;
  const contentError = contentState?.url === contentUrl ? contentState?.error : undefined;
  const contentLoading = Boolean(contentUrl && !filePreview && !contentError);
  const showTextPreview = filePreview?.kind === "text"
    && (viewMode === "content" || !selectedPatch || selectedFile?.status === "untracked");
  const formattedText = useMemo(() => filePreview?.kind === "text" ? formatPreviewText(filePreview) : "", [filePreview]);

  useEffect(() => {
    if (!contentUrl) return;
    const controller = new AbortController();
    setContentState({ url: contentUrl });
    void getJson<GitFilePreview>(contentUrl, { signal: controller.signal })
      .then((preview) => {
        if (!controller.signal.aborted) setContentState({ url: contentUrl, preview });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setContentState({
          url: contentUrl, error: failure instanceof Error ? failure.message : String(failure),
        });
      });
    return () => controller.abort();
  }, [contentUrl, data]);

  const counts = useMemo(() => {
    const result = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0 };
    for (const file of data?.files ?? []) result[file.status] += 1;
    return result;
  }, [data?.files]);

  return (
    <main className={`tmux-git-changes-page${embedded ? " is-embedded" : ""}`}>
      <header className="tmux-git-changes-header">
        <div>
          {embedded ? (
            <div className="tmux-inspector-compact-heading">
              <strong>Git 变更</strong>
              <span>{data?.session.name || sessionId}</span>
              <span>{data?.branch || "detached HEAD"}</span>
            </div>
          ) : (
            <>
              <p className="dashboard-eyebrow">TMUX DASHBOARD / GIT CHANGES</p>
              <h1>Git 变更</h1>
              <div className="tmux-git-changes-context">
                <strong>{data?.session.name || sessionId}</strong>
                {data?.branch ? <span>{data.branch}</span> : <span>detached HEAD</span>}
                <code>{data?.directory || "正在读取当前 pane 目录…"}</code>
              </div>
            </>
          )}
        </div>
        {!embedded ? (
          <div className="tmux-git-changes-actions">
            <Link to={"/tmux-dashboard?session=" + encodeURIComponent(sessionId)}>返回 Session</Link>
            <button type="button" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}>刷新</button>
          </div>
        ) : null}
      </header>

      {error ? <div className="error" role="alert">{error}</div> : null}
      {loading && !data ? <p className="muted">正在读取当前 Git 变更…</p> : null}
      {data ? (
        <>
          <section className="tmux-git-changes-summary" aria-label="Git 状态摘要">
            <span>{data.files.length} 个文件</span>
            <span>新增 {counts.added + counts.untracked}</span>
            <span>修改 {counts.modified}</span>
            <span>删除 {counts.deleted}</span>
            <span>HEAD {data.headCommit.slice(0, 12)}</span>
            <code>{data.gitRoot}</code>
          </section>
          {data.patchTruncated ? <p className="tmux-git-changes-warning">diff 超过页面安全上限，仅展示前一部分；文件列表仍来自完整的 Git status。</p> : null}
          <section className="tmux-git-changes-layout">
            <aside className="tmux-git-changes-files" aria-label="变更文件">
              <div className="tmux-git-changes-files-toolbar">
                <div className="tmux-git-changes-files-heading">
                  <strong>变更文件</strong>
                  <span aria-live="polite">{search.trim() ? filteredFiles.length + " / " + data.files.length : data.files.length}</span>
                </div>
                <label className="tmux-git-changes-search">
                  <span className="sr-only">过滤变更文件</span>
                  <input type="search" placeholder="搜索文件名或路径" value={search}
                    onChange={(event) => setSearch(event.target.value)} autoComplete="off" spellCheck={false} />
                </label>
              </div>
              {data.files.length === 0 ? <p className="tmux-git-changes-message">当前工作区没有未提交变更。</p>
                : filteredFiles.length === 0 ? <p className="tmux-git-changes-message">没有匹配的文件。</p> : null}
              {filteredFiles.map((file) => (
                <button
                  className={"tmux-git-change-file" + (selectedPath === file.path ? " is-selected" : "")}
                  key={file.path}
                  type="button"
                  aria-pressed={selectedPath === file.path}
                  onClick={() => {
                    setSelectedPath((current) => current === file.path ? null : file.path);
                    setViewMode("diff");
                  }}
                >
                  <span className="tmux-git-change-file-status">{STATUS_LABELS[file.status]}</span>
                  <span className="tmux-git-change-file-path" title={file.path}>{file.path}</span>
                  <span className="tmux-git-change-file-meta">
                    <span>{file.staged && file.unstaged ? "暂存 + 工作区" : file.staged ? "已暂存" : "工作区"}</span>
                    {file.sizeBytes !== null ? <span>{formatSizeKb(file.sizeBytes)}</span> : null}
                  </span>
                </button>
              ))}
            </aside>
            <section className="tmux-git-changes-diff" aria-label="Git diff">
              <header>
                <div className="tmux-git-changes-file-heading">
                  <strong title={selectedFile?.path}>{selectedFile ? selectedFile.path : "完整 diff"}</strong>
                  {selectedFile?.oldPath ? <span>来自 {selectedFile.oldPath}</span> : null}
                </div>
                {selectedFile ? (
                  <div className="tmux-git-changes-file-actions">
                    <span>{formatSizeKb(filePreview?.sizeBytes ?? selectedFile.sizeBytes)}</span>
                    {filePreview?.kind === "text" && selectedPatch && selectedFile.status !== "untracked" ? (
                      <>
                        <button type="button" aria-pressed={!showTextPreview} onClick={() => setViewMode("diff")}>变更</button>
                        <button type="button" aria-pressed={showTextPreview} onClick={() => setViewMode("content")}>预览</button>
                      </>
                    ) : null}
                    {selectedFile.downloadable ? (
                      <a href={gitFileUrl(sessionId, data.gitRoot, selectedFile.path, "download")}
                        download={selectedFile.path.split("/").pop()}>下载</a>
                    ) : null}
                  </div>
                ) : null}
              </header>
              {contentError ? <p className="tmux-git-changes-message is-error" role="alert">{contentError}</p> : null}
              {contentLoading ? (
                <p className="tmux-git-changes-message" role="status">正在读取文件…</p>
              ) : filePreview?.kind === "binary" ? (
                <p className="tmux-git-changes-message">二进制文件无法显示为文本（{formatSizeKb(filePreview.sizeBytes)}），可点击“下载”保存文件。</p>
              ) : showTextPreview ? (
                <>
                  {filePreview.truncated ? <p className="tmux-git-changes-message">文件较大，仅预览前 512 KB；下载可获取完整内容。</p> : null}
                  <Suspense fallback={<p className="tmux-git-changes-message">正在加载预览…</p>}>
                    <CodeTextViewer fileName={selectedFile!.path} text={formattedText} />
                  </Suspense>
                </>
              ) : selectedPatch ? (
                <pre className="tmux-git-change-code"><code>{renderPatch(selectedPatch)}</code></pre>
              ) : selectedFile ? (
                <p className="tmux-git-changes-message">{selectedFile.status === "deleted"
                  ? "文件已删除，当前工作区中无法预览或下载。"
                  : contentError ? "请刷新列表后重试。" : "当前文件不可读取，请刷新列表确认文件状态。"}</p>
              ) : (
                <p className="tmux-git-changes-message">{data.files.length
                  ? "请选择文件查看内容和下载。"
                  : "当前工作区没有未提交变更。"}</p>
              )}
            </section>
          </section>
        </>
      ) : null}
    </main>
  );
}
