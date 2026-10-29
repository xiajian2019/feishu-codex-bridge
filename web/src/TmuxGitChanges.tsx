import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router";

import { getJson } from "./api.js";
import { downloadBridgeFile, isMobileApp } from "./mobile-runtime.js";
import "./git-review.css";
import {
  createGitReviewDraftForward,
  gitReviewLocation,
  gitReviewGutterDigits,
  gitReviewRangeContains,
  gitReviewSnippet,
  gitReviewTextLines,
  loadGitReviewComments,
  makeDiffAnchor,
  makeTextAnchor,
  makeGitReviewRange,
  newGitReviewComment,
  parseGitReviewLines,
  saveGitReviewComments,
  type GitReviewAnchor,
  type GitReviewComment,
  type GitReviewDiffLine,
} from "./git-review-drafts.js";

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

type ReviewCommentStatus = { stale: boolean; reason: string | null };
const MAX_REVIEW_COMMENTS_PER_DELIVERY = 20;
const MAX_REVIEW_BLOCK_BYTES = 24 * 1024;

function isReviewableSnippet(value: string): boolean {
  return value.length <= 2_048 && new TextEncoder().encode(value).byteLength <= 2_048;
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

function reviewCommentStatus(
  comment: GitReviewComment,
  data: GitChangesResponse,
  untrackedPreview?: GitFilePreview,
): ReviewCommentStatus {
  const { anchor } = comment;
  if (anchor.headCommit !== data.headCommit) return { stale: true, reason: "HEAD 已变化，请重新检查并添加锚点。" };
  const file = data.files.find((candidate) => candidate.path === anchor.path);
  if (!file) {
    if (data.files.some((candidate) => candidate.oldPath === anchor.path)) {
      return { stale: true, reason: "文件已重命名；请在新路径重新添加锚点。" };
    }
    return { stale: true, reason: "文件已不在当前变更中；意见保留原路径和片段。" };
  }
  if (file.status === "untracked") {
    if (file.sizeBytes !== null && file.sizeBytes > 512 * 1024) {
      return { stale: true, reason: "未跟踪文件超过 512 KiB 安全预览上限，不能验证行锚点。" };
    }
    if (untrackedPreview?.path === file.path && untrackedPreview.truncated) {
      return { stale: true, reason: "未跟踪文件预览已截断，不能验证行锚点。" };
    }
    if (untrackedPreview?.path !== file.path || untrackedPreview.kind !== "text" || !untrackedPreview.text) {
      return { stale: false, reason: null };
    }
    const lines = untrackedPreview.text.split(/\r?\n/);
    if (untrackedPreview.text.endsWith("\n")) lines.pop();
    const line = anchor.newLine === null ? undefined : lines.slice(anchor.newLine - 1, anchor.newEndLine ?? anchor.newLine).join("\n");
    if (line !== anchor.snippet) return { stale: true, reason: "未跟踪文件的锚点行已变化或移动。" };
    const noNewline = (anchor.newEndLine ?? anchor.newLine) === lines.length && !untrackedPreview.text.endsWith("\n");
    if (noNewline !== anchor.noNewline) return { stale: true, reason: "文件末尾换行状态已变化。" };
    return { stale: false, reason: null };
  }
  const patch = patchSections(data.patch).find((section) => sectionMatchesFile(section, file));
  if (!patch) return { stale: true, reason: "当前 diff 已没有该文件的文本锚点。" };
  if (anchor.kind === "range") {
    try {
      const end = { ...anchor, ...(anchor.side === "old" ? { oldLine: anchor.oldEndLine! } : { newLine: anchor.newEndLine! }) };
      const current = makeGitReviewRange(anchor, end, parseGitReviewLines(patch));
      return current.snippet === anchor.snippet && current.noNewline === anchor.noNewline
        ? { stale: false, reason: null } : { stale: true, reason: "所选行范围内容已变化，请核对保存的片段。" };
    } catch { return { stale: true, reason: "当前 diff 已不包含完整的原行范围。" }; }
  }
  const line = parseGitReviewLines(patch).find((candidate) =>
    candidate.oldLine === anchor.oldLine && candidate.newLine === anchor.newLine
    && (anchor.side === "old" ? candidate.kind !== "add" : candidate.kind !== "delete"));
  if (!line || line.text !== anchor.snippet) return { stale: true, reason: "锚点行已变化或移动，请重新添加。" };
  if (line.noNewline !== anchor.noNewline) return { stale: true, reason: "文件末尾换行状态已变化。" };
  return { stale: false, reason: null };
}

function reviewLineLocation(anchor: GitReviewAnchor): string {
  return gitReviewLocation(anchor);
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

function reviewLineClass(kind: GitReviewDiffLine["kind"]): string {
  return kind === "add" ? "tmux-git-change-line is-add"
    : kind === "delete" ? "tmux-git-change-line is-delete"
      : "tmux-git-change-line";
}

function renderPatch(patch: string): ReactElement[] {
  return patch.split("\n").map((line, index) => (
    <span className={lineClass(line)} key={index}>{line || " "}<br /></span>
  ));
}

function renderReviewablePatch(
  patch: string,
  file: GitChangeFile,
  headCommit: string,
  onAddAnchor: (anchor: GitReviewAnchor) => void,
  rangeStart: GitReviewAnchor | null,
): ReactElement[] {
  const reviewLines = parseGitReviewLines(patch);
  let reviewIndex = 0;
  let inHunk = false;
  return patch.split("\n").map((rawLine, index) => {
    if (rawLine.startsWith("diff --git ")) inHunk = false;
    if (rawLine.startsWith("@@")) {
      inHunk = true;
      return <span className={lineClass(rawLine)} key={index}>{rawLine || " "}<br /></span>;
    }
    if (inHunk && (rawLine.startsWith(" ") || rawLine.startsWith("+") || rawLine.startsWith("-"))) {
      const line = reviewLines[reviewIndex++];
      if (!line) return <span className={lineClass(rawLine)} key={index}>{rawLine || " "}<br /></span>;
      const addButton = (side: "old" | "new", number: number | null): ReactElement => (
        number === null ? <span className="tmux-git-review-line-number is-empty" key={side} /> : (
          <button
            className={"tmux-git-review-line-number" + (gitReviewRangeContains(rangeStart, side, number) ? " is-range-start" : "")}
            key={side}
            type="button"
            disabled={!isReviewableSnippet(line.text)}
            title={!isReviewableSnippet(line.text) ? "该行过长，不能安全地加入评论请求。" : `选择${side === "old" ? "旧" : "新"}第 ${number} 行`}
            aria-label={`选择 ${file.path} 的${side === "old" ? "旧" : "新"}第 ${number} 行`}
            aria-pressed={gitReviewRangeContains(rangeStart, side, number)}
            onClick={() => onAddAnchor(makeDiffAnchor(file.path, file.oldPath, headCommit, line, side))}
          >{number}</button>
        )
      );
      const showOld = line.oldLine !== null;
      const showNew = line.newLine !== null;
      return (
        <span className={"tmux-git-review-diff-row" + (rangeStart && gitReviewRangeContains(rangeStart, rangeStart.side, rangeStart.side === "old" ? line.oldLine : line.newLine) ? " is-range-selected" : "")} key={index}>
          <span className="tmux-git-review-line-gutter">
            {showOld ? addButton("old", line.oldLine) : <span className="tmux-git-review-line-number is-empty" />}
            {showNew ? addButton("new", line.newLine) : <span className="tmux-git-review-line-number is-empty" />}
          </span>
          <span className={reviewLineClass(line.kind)}>{rawLine || " "}</span>
        </span>
      );
    }
    if (!inHunk && (rawLine.startsWith("--- ") || rawLine.startsWith("+++ "))) {
      return <span className={lineClass(rawLine)} key={index}>{rawLine || " "}<br /></span>;
    }
    if (inHunk && rawLine.startsWith("\\ No newline at end of file")) {
      return <span className={lineClass(rawLine)} key={index}>{rawLine}<br /></span>;
    }
    if (inHunk && rawLine && ![" ", "+", "-"].includes(rawLine[0]!)) inHunk = false;
    return <span className={lineClass(rawLine)} key={index}>{rawLine || " "}<br /></span>;
  });
}

function renderReviewableText(
  text: string,
  file: GitChangeFile,
  headCommit: string,
  onAddAnchor: (anchor: GitReviewAnchor) => void,
  rangeStart: GitReviewAnchor | null,
): ReactElement[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  const hasFinalNewline = text.endsWith("\n");
  return lines.map((line, index) => (
    <span className={"tmux-git-review-text-row" + (gitReviewRangeContains(rangeStart, "new", index + 1) ? " is-range-selected" : "")} key={index}>
      <span className="tmux-git-review-line-gutter is-text">
      <button
        className={"tmux-git-review-line-number" + (gitReviewRangeContains(rangeStart, "new", index + 1) ? " is-range-start" : "")}
        type="button"
        disabled={!isReviewableSnippet(line)}
        title={!isReviewableSnippet(line) ? "该行过长，不能安全地加入评论请求。" : `选择第 ${index + 1} 行`}
        aria-label={`选择 ${file.path} 的第 ${index + 1} 行`}
        aria-pressed={gitReviewRangeContains(rangeStart, "new", index + 1)}
        onClick={() => onAddAnchor(makeTextAnchor(file.path, headCommit, index + 1, line, index === lines.length - 1 && !hasFinalNewline))}
      >{index + 1}</button>
      </span>
      <span>{line || " "}</span>
    </span>
  ));
}

interface GitChangesFileListProps {
  files: GitChangeFile[];
  filteredFiles: GitChangeFile[];
  selectedPath: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelectPath: (path: string) => void;
}

const GitChangesFileList = memo(function GitChangesFileList({
  files,
  filteredFiles,
  selectedPath,
  search,
  onSearchChange,
  onSelectPath,
}: GitChangesFileListProps): ReactElement {
  return (
    <aside className="tmux-git-changes-files" aria-label="变更文件">
      <div className="tmux-git-changes-files-toolbar">
        <div className="tmux-git-changes-files-heading">
          <strong>变更文件</strong>
          <span aria-live="polite">{search.trim() ? filteredFiles.length + " / " + files.length : files.length}</span>
        </div>
        <label className="tmux-git-changes-search">
          <span className="sr-only">过滤变更文件</span>
          <input type="search" placeholder="搜索文件名或路径" value={search}
            onChange={(event) => onSearchChange(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      </div>
      {files.length === 0 ? <p className="tmux-git-changes-message">当前工作区没有未提交变更。</p>
        : filteredFiles.length === 0 ? <p className="tmux-git-changes-message">没有匹配的文件。</p> : null}
      {filteredFiles.map((file) => (
        <button
          className={"tmux-git-change-file" + (selectedPath === file.path ? " is-selected" : "")}
          key={file.path}
          type="button"
          aria-pressed={selectedPath === file.path}
          onClick={() => onSelectPath(file.path)}
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
  );
});

interface GitChangeDiffProps {
  sessionId: string;
  data: GitChangesResponse;
  selectedFile: GitChangeFile | null;
  selectedPatch: string;
  viewMode: "diff" | "content";
  onViewModeChange: (mode: "diff" | "content") => void;
  filePreview: GitFilePreview | undefined;
  contentError: string | undefined;
  contentLoading: boolean;
  formattedText: string;
  showTextPreview: boolean;
  onAddAnchor: (anchor: GitReviewAnchor) => void;
  rangeStart: GitReviewAnchor | null;
  rangeError: string;
  onClearSelection: () => void;
  reviewAction: ReactElement;
}

const GitChangeDiff = memo(function GitChangeDiff({
  sessionId,
  data,
  selectedFile,
  selectedPatch,
  viewMode,
  onViewModeChange,
  filePreview,
  contentError,
  contentLoading,
  formattedText,
  showTextPreview,
  onAddAnchor,
  rangeStart, rangeError, onClearSelection, reviewAction,
}: GitChangeDiffProps): ReactElement {
  const [downloadError, setDownloadError] = useState("");
  useEffect(() => setDownloadError(""), [selectedFile?.path]);
  const renderedPatch = useMemo(() => selectedPatch
    ? selectedFile
      ? renderReviewablePatch(selectedPatch, selectedFile, data.headCommit, onAddAnchor, rangeStart)
      : renderPatch(selectedPatch)
    : null, [data.headCommit, onAddAnchor, selectedFile, selectedPatch, rangeStart]);
  const gutterStyle = useMemo(() => {
    const lines = selectedFile?.status === "untracked" && filePreview?.kind === "text"
      ? gitReviewTextLines(filePreview.text ?? "") : selectedFile ? parseGitReviewLines(selectedPatch) : [];
    const { oldDigits, newDigits } = gitReviewGutterDigits(lines);
    return { "--git-review-old-digits": oldDigits, "--git-review-new-digits": newDigits } as CSSProperties;
  }, [selectedFile, selectedPatch, filePreview]);

  return (
    <section className="tmux-git-changes-diff" aria-label="Git diff">
      <header>
        <div className="tmux-git-changes-file-heading">
          <strong title={selectedFile?.path}>{selectedFile ? selectedFile.path : "完整 diff"}</strong>
          {selectedFile?.oldPath ? <span>来自 {selectedFile.oldPath}</span> : null}
        </div>
        <div className="tmux-git-changes-file-actions">
          {selectedFile ? <>
            <span>{formatSizeKb(filePreview?.sizeBytes ?? selectedFile.sizeBytes)}</span>
            {filePreview?.kind === "text" && selectedPatch && selectedFile.status !== "untracked" ? (
              <>
                <button type="button" aria-pressed={viewMode === "diff"} onClick={() => onViewModeChange("diff")}>变更</button>
                <button type="button" aria-pressed={showTextPreview} onClick={() => onViewModeChange("content")}>预览</button>
              </>
            ) : null}
            {selectedFile.downloadable ? (
              <a href={gitFileUrl(sessionId, data.gitRoot, selectedFile.path, "download")}
                download={selectedFile.path.split("/").pop()} onClick={(event) => {
                  if (!isMobileApp()) return;
                  event.preventDefault();
                  setDownloadError("");
                  void downloadBridgeFile(gitFileUrl(sessionId, data.gitRoot, selectedFile.path, "download"), selectedFile.path.split("/").pop())
                    .catch((failure: unknown) => setDownloadError(failure instanceof Error ? failure.message : "文件下载失败。"));
                }}>下载</a>
            ) : null}
          </> : null}
          {reviewAction}
        </div>
      </header>
      {downloadError ? <p className="tmux-git-changes-message is-error" role="alert">{downloadError}</p> : null}
      {selectedFile && (!showTextPreview || selectedFile.status === "untracked") && filePreview?.kind !== "binary" ? <div className="tmux-git-range-hint" role="status">
        <span>{rangeStart ? `已选${rangeStart.side === "old" ? "旧" : "新"}行 ${rangeStart.side === "old" ? rangeStart.oldLine : rangeStart.newLine}${rangeStart.kind === "range" ? `–${rangeStart.side === "old" ? rangeStart.oldEndLine : rangeStart.newEndLine}` : ""}，点上方“意见”填写` : "点击起止行号选择范围，再点上方“意见”"}</span>
        {rangeStart ? <button type="button" onClick={onClearSelection}>清除选择</button> : null}
      </div> : null}
      {rangeError ? <p className="tmux-git-changes-message is-error" role="alert">{rangeError}</p> : null}
      {contentError ? <p className="tmux-git-changes-message is-error" role="alert">{contentError}</p> : null}
      {contentLoading ? (
        <p className="tmux-git-changes-message" role="status">正在读取文件…</p>
      ) : filePreview?.kind === "binary" ? (
        <p className="tmux-git-changes-message">二进制文件无法显示为文本（{formatSizeKb(filePreview.sizeBytes)}），可点击“下载”保存文件。</p>
      ) : showTextPreview ? (
        <>
          {filePreview?.truncated ? <p className="tmux-git-changes-message">文件较大，仅预览前 512 KB；下载可获取完整内容。</p> : null}
          {selectedFile?.status === "untracked" ? (
            filePreview?.text ? <pre className="tmux-git-review-text" style={gutterStyle}><code>{renderReviewableText(filePreview.text, selectedFile, data.headCommit, onAddAnchor, rangeStart)}</code></pre>
              : <p className="tmux-git-changes-message">空文件没有可定位的行；二进制或不可读文件不支持行评论。</p>
          ) : (
            <>
              <p className="tmux-git-changes-message">行级评论请切回“变更”视图并选择 diff 行。</p>
              <Suspense fallback={<p className="tmux-git-changes-message">正在加载预览…</p>}>
                <CodeTextViewer fileName={selectedFile!.path} text={formattedText} />
              </Suspense>
            </>
          )}
        </>
      ) : renderedPatch ? (
        <pre className="tmux-git-change-code" style={gutterStyle}><code>{renderedPatch}</code></pre>
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
  );
});

interface GitChangesWorkspaceProps {
  sessionId: string;
  data: GitChangesResponse;
}

const GitChangesWorkspace = memo(function GitChangesWorkspace({ sessionId, data }: GitChangesWorkspaceProps): ReactElement {
  const navigate = useNavigate();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"diff" | "content">("diff");
  const [contentState, setContentState] = useState<{ url: string; preview?: GitFilePreview; error?: string } | null>(null);
  const [comments, setComments] = useState<GitReviewComment[]>(() => loadGitReviewComments(sessionId, data.gitRoot));
  const [storageError, setStorageError] = useState("");
  const [mobilePane, setMobilePane] = useState<"files" | "diff">("files");
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const diffReviewTriggerRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [commentEditor, setCommentEditor] = useState<{ anchor: GitReviewAnchor; commentId?: string } | null>(null);
  const [commentEditorText, setCommentEditorText] = useState("");
  const [commentEditorError, setCommentEditorError] = useState("");
  const [stageError, setStageError] = useState("");
  const [rangeStart, setRangeStart] = useState<GitReviewAnchor | null>(null);
  const [rangeSelection, setRangeSelection] = useState<GitReviewAnchor | null>(null);
  const [rangeError, setRangeError] = useState("");

  useEffect(() => {
    setSelectedPath((current) => current && data.files.some((file) => file.path === current) ? current : null);
  }, [data]);

  const sections = useMemo(() => patchSections(data.patch), [data.patch]);
  const selectedFile = useMemo(
    () => data.files.find((file) => file.path === selectedPath) ?? null,
    [data.files, selectedPath],
  );
  const selectedPatch = useMemo(() => {
    if (!selectedFile) return data.patch;
    return sections.find((section) => sectionMatchesFile(section, selectedFile)) ?? "";
  }, [data.patch, sections, selectedFile]);
  const filteredFiles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return data.files.filter((file) => !query
      || file.path.toLocaleLowerCase().includes(query)
      || file.oldPath?.toLocaleLowerCase().includes(query));
  }, [data.files, search]);
  const contentUrl = selectedFile?.downloadable
    ? gitFileUrl(sessionId, data.gitRoot, selectedFile.path, "content")
    : null;
  const filePreview = contentState?.url === contentUrl ? contentState.preview : undefined;
  const contentError = contentState?.url === contentUrl ? contentState.error : undefined;
  const contentLoading = Boolean(contentUrl && !filePreview && !contentError);
  const showTextPreview = filePreview?.kind === "text"
    && (viewMode === "content" || !selectedPatch || selectedFile?.status === "untracked");
  const formattedText = useMemo(() => filePreview?.kind === "text" ? formatPreviewText(filePreview) : "", [filePreview]);

  useEffect(() => { setRangeStart(null); setRangeSelection(null); setRangeError(""); }, [selectedPath, viewMode, data.headCommit, data.patch]);

  useEffect(() => {
    try {
      saveGitReviewComments(sessionId, data.gitRoot, comments);
      setStorageError("");
    } catch (failure) {
      setStorageError(failure instanceof Error ? failure.message : "无法保存行级评论草稿。");
    }
  }, [comments, data.gitRoot, sessionId]);

  useEffect(() => {
    if (!contentUrl) {
      setContentState(null);
      return;
    }
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

  const handleSelectPath = useCallback((path: string): void => {
    setSelectedPath(path);
    setViewMode("diff");
    setMobilePane("diff");
  }, []);
  const handleViewModeChange = useCallback((mode: "diff" | "content"): void => {
    setViewMode(mode);
  }, []);

  const handleAddAnchor = useCallback((anchor: GitReviewAnchor): void => {
    setRangeError("");
    if (!rangeStart || rangeStart.side !== anchor.side) {
      setRangeStart(anchor); setRangeSelection(anchor); return;
    }
    const field = anchor.side === "old" ? "oldLine" : "newLine";
    if (anchor[field] === rangeStart[field]) {
      if (rangeSelection?.kind === "range") setRangeSelection(rangeStart);
      else { setRangeStart(null); setRangeSelection(null); }
      return;
    }
    try {
      const lines = selectedFile?.status === "untracked" && filePreview?.kind === "text"
        ? gitReviewTextLines(filePreview.text ?? "") : parseGitReviewLines(selectedPatch);
      setRangeSelection(makeGitReviewRange(rangeStart, anchor, lines));
    } catch (error) { setRangeError(error instanceof Error ? error.message : "无法选择该行范围。"); }
  }, [rangeStart, rangeSelection, selectedFile, filePreview, selectedPatch]);

  const updateCommentText = useCallback((commentId: string, text: string): void => {
    setComments((current) => current.map((comment) => comment.id === commentId
      ? { ...comment, text, updatedAt: Date.now() }
      : comment));
  }, []);

  const commentStatuses = useMemo(() => new Map(comments.map((comment) => [
    comment.id,
    reviewCommentStatus(comment, data, filePreview),
  ])), [comments, data, filePreview]);
  const selectedReviewComments = useMemo(() => comments.filter((comment) =>
    comment.selected
    && comment.text.trim()
    && comment.text.length <= 20_000), [comments]);
  const selectedButStaleCount = comments.filter((comment) =>
    comment.selected && commentStatuses.get(comment.id)?.stale).length;

  const saveComment = (): void => {
    if (!commentEditor) return;
    if (!commentEditorText.trim()) {
      setCommentEditorError("请写下这条意见，空评论不会保存。");
      return;
    }
    if (commentEditorText.length > 20_000) {
      setCommentEditorError("单条意见最多 20,000 个字符。");
      return;
    }
    if (commentEditor.commentId) {
      updateCommentText(commentEditor.commentId, commentEditorText);
    } else {
      setComments((current) => [...current, newGitReviewComment(commentEditor.anchor, commentEditorText)]);
    }
    setCommentEditor(null);
    setRangeStart(null); setRangeSelection(null);
  };

  const stageSelectedComments = (): void => {
    if (selectedReviewComments.length === 0) return;
    setStageError("");
    try {
      if (selectedReviewComments.length > MAX_REVIEW_COMMENTS_PER_DELIVERY) throw new Error("每次最多加入 20 条意见，请分批加入。");
      const forward = createGitReviewDraftForward(sessionId, selectedReviewComments);
      if (new TextEncoder().encode(forward.text).byteLength > MAX_REVIEW_BLOCK_BYTES) {
        throw new Error("评论内容超过 24 KiB；请缩短意见或分批加入原 Session 草稿。");
      }
      const updatedComments = comments.map((comment) => comment.selected
        ? { ...comment, selected: false, updatedAt: Date.now() }
        : comment);
      saveGitReviewComments(sessionId, data.gitRoot, updatedComments);
      setComments(updatedComments);
      navigate("/tmux-dashboard?session=" + encodeURIComponent(sessionId), {
        state: { sessionFileForward: forward },
      });
    } catch (failure) {
      setStageError(failure instanceof Error ? failure.message : "无法加入草稿，意见仍保留在本机。");
    }
  };

  const overlayOpen = reviewOpen || commentEditor !== null;
  useEffect(() => {
    if (!overlayOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const target = overlayRef.current?.querySelector<HTMLElement>(".tmux-git-review-dialog textarea")
        ?? overlayRef.current?.querySelector<HTMLElement>("button, input");
      target?.focus();
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setReviewOpen(false); setCommentEditor(null); return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(overlayRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, input:not(:disabled), [tabindex='0']") ?? [])];
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
      else [diffReviewTriggerRef.current, reviewTriggerRef.current].find((button) => button?.getClientRects().length)?.focus();
    };
  }, [overlayOpen]);

  const reviewLabel = `意见${rangeSelection ? ` · ${rangeSelection.kind === "range" ? ((rangeSelection.side === "old" ? rangeSelection.oldEndLine! - rangeSelection.oldLine! : rangeSelection.newEndLine! - rangeSelection.newLine!) + 1) : 1} 行` : comments.length ? ` ${comments.length}` : ""}`;
  const openReview = (): void => {
    setStageError("");
    if (rangeSelection) { setCommentEditor({ anchor: rangeSelection }); setCommentEditorText(""); setCommentEditorError(""); }
    else setReviewOpen(true);
  };

  return (
    <div className="tmux-git-review-workspace">
      <div className="tmux-git-workspace-toolbar">
        <div className="tmux-git-mobile-tabs" role="tablist" aria-label="Git 变更视图">
          <button type="button" role="tab" aria-selected={mobilePane === "files"} onClick={() => setMobilePane("files")}>文件 {data.files.length}</button>
          <button type="button" role="tab" aria-selected={mobilePane === "diff"} onClick={() => setMobilePane("diff")}>Diff</button>
        </div>
        <button ref={reviewTriggerRef} type="button" className="tmux-git-review-trigger" aria-haspopup="dialog" onClick={openReview}>
          {reviewLabel}
        </button>
      </div>
      <section className="tmux-git-changes-layout" data-mobile-pane={mobilePane}>
        <GitChangesFileList
          files={data.files}
          filteredFiles={filteredFiles}
          selectedPath={selectedPath}
          search={search}
          onSearchChange={setSearch}
          onSelectPath={handleSelectPath}
        />
        <GitChangeDiff
          sessionId={sessionId}
          data={data}
          selectedFile={selectedFile}
          selectedPatch={selectedPatch}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          filePreview={filePreview}
          contentError={contentError}
          contentLoading={contentLoading}
          formattedText={formattedText}
          showTextPreview={showTextPreview}
          onAddAnchor={handleAddAnchor}
          rangeStart={rangeSelection} rangeError={rangeError}
          onClearSelection={() => { setRangeStart(null); setRangeSelection(null); setRangeError(""); }}
          reviewAction={<button ref={diffReviewTriggerRef} type="button" className="tmux-git-review-trigger" aria-haspopup="dialog" onClick={openReview}>{reviewLabel}</button>}
        />
      </section>
      {reviewOpen ? createPortal(<div ref={overlayRef} className="tmux-git-review-backdrop" role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewOpen(false); }}>
      <section className="tmux-git-review-panel" role="dialog" aria-modal="true" aria-labelledby="git-review-list-title">
        <header>
          <div><strong id="git-review-list-title">行级意见</strong><span>{comments.length} 条已保存 · 已选 {selectedReviewComments.length} 条</span></div>
          <button className="tmux-git-review-close" type="button" onClick={() => setReviewOpen(false)} aria-label="关闭行级意见">×</button>
        </header>
        <p>仅填入「{data.session.name}」的输入框，保留现有草稿，不会自动发送。</p>
        {storageError ? <p className="is-error" role="alert">{storageError}</p> : null}
        {stageError ? <p className="is-error" role="alert">{stageError}</p> : null}
        {selectedButStaleCount ? <p role="status">有 {selectedButStaleCount} 条意见引用了旧版本；加入草稿后可继续编辑。</p> : null}
        {selectedReviewComments.length > MAX_REVIEW_COMMENTS_PER_DELIVERY ? <p role="status">每次最多加入 {MAX_REVIEW_COMMENTS_PER_DELIVERY} 条评论，请取消选择部分评论后分批加入。</p> : null}
        {comments.length === 0 ? <p className="tmux-git-review-empty">在 diff 行号旁选择“评论”，意见会按 Session 和仓库保存在本机。</p> : null}
        <div className="tmux-git-review-comments">
          {comments.map((comment) => {
            const status = commentStatuses.get(comment.id) ?? { stale: false, reason: null };
            return (
              <article className={`tmux-git-review-comment${status.stale ? " is-stale" : ""}`} key={comment.id}>
                <label className="tmux-git-review-comment-select">
                  <input type="checkbox" checked={comment.selected}
                    onChange={(event) => setComments((current) => current.map((item) => item.id === comment.id
                      ? { ...item, selected: event.target.checked, updatedAt: Date.now() }
                      : item))} />
                  <span><code>{comment.anchor.path}</code> · {reviewLineLocation(comment.anchor)} · {comment.anchor.side === "old" ? "删除前" : "当前行"}</span>
                </label>
                <pre className="tmux-git-review-snippet"><code>{gitReviewSnippet(comment.anchor)}{comment.anchor.noNewline ? "  [无末尾换行]" : ""}</code></pre>
                {status.reason ? <p className={status.stale ? "is-error" : "is-pending"}>{status.reason}</p> : null}
                <textarea aria-label={`编辑 ${comment.anchor.path} 的行级意见`} value={comment.text} maxLength={20_000}
                  onChange={(event) => updateCommentText(comment.id, event.target.value)} />
                <div className="tmux-git-review-comment-actions">
                  <span>{comment.text.length}/20,000</span>
                  <button type="button" onClick={() => setComments((current) => current.filter((item) => item.id !== comment.id))}>删除</button>
                </div>
              </article>
            );
          })}
        </div>
        <footer><button type="button" className="tmux-git-review-stage" disabled={!selectedReviewComments.length || selectedReviewComments.length > MAX_REVIEW_COMMENTS_PER_DELIVERY}
          onClick={stageSelectedComments}>加入输入框草稿{selectedReviewComments.length ? `（${selectedReviewComments.length}）` : ""}</button></footer>
      </section>
      </div>, document.body) : null}
      {commentEditor ? createPortal(
        <div ref={overlayRef} className="tmux-git-review-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommentEditor(null); }}>
          <section className="tmux-git-review-dialog" role="dialog" aria-modal="true" aria-labelledby="git-review-editor-title">
            <header><strong id="git-review-editor-title">{commentEditor.anchor.kind === "range" ? "添加多行意见" : "添加行级意见"}</strong><button className="tmux-git-review-close" type="button" onClick={() => setCommentEditor(null)} aria-label="关闭意见输入框">×</button></header>
            <p><code>{commentEditor.anchor.path}</code> · {reviewLineLocation(commentEditor.anchor)} · {commentEditor.anchor.side === "old" ? "删除前" : "当前行"}</p>
            <pre className="tmux-git-review-snippet"><code>{gitReviewSnippet(commentEditor.anchor)}{commentEditor.anchor.noNewline ? "  [无末尾换行]" : ""}</code></pre>
            <label>意见<textarea autoFocus value={commentEditorText} maxLength={20_000}
              onChange={(event) => setCommentEditorText(event.target.value)} placeholder="描述希望 Codex 检查或修改的内容…" /></label>
            {commentEditorError ? <p className="is-error" role="alert">{commentEditorError}</p> : null}
            <footer><button type="button" onClick={() => setCommentEditor(null)}>取消</button><button type="button" onClick={saveComment}>保存评论</button></footer>
          </section>
        </div>
      , document.body) : null}
    </div>
  );
});

interface TmuxGitChangesProps {
  embedded?: boolean;
  sessionId?: string;
}

export function TmuxGitChanges({ embedded = false, sessionId: sessionIdOverride }: TmuxGitChangesProps = {}): ReactElement {
  const routeParams = useParams<{ sessionId: string }>();
  const sessionId = sessionIdOverride ?? routeParams.sessionId ?? "";
  const [data, setData] = useState<GitChangesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setData(null);
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
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, sessionId]);

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
              <div className="tmux-git-changes-title"><h1>Git 变更</h1><strong title={data?.session.name}>{data?.session.name || sessionId}</strong></div>
              <div className="tmux-git-changes-context">
                <span title={data?.branch || undefined}>{data?.branch || "detached HEAD"}</span>
              </div>
            </>
          )}
        </div>
        {!embedded ? (
          <div className="tmux-git-changes-actions">
            <Link to={"/tmux-dashboard?session=" + encodeURIComponent(sessionId)}>返回</Link>
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
            <details className="tmux-git-repository-info"><summary>仓库信息</summary><div>
              <code>HEAD {data.headCommit.slice(0, 12)}</code><code>{data.gitRoot}</code>
              {data.directory !== data.gitRoot ? <code>当前目录：{data.directory}</code> : null}
            </div></details>
          </section>
          {data.patchTruncated ? <details className="tmux-git-changes-warning"><summary>Diff 已截断 · 文件列表完整</summary><p>diff 超过页面安全上限，仅展示前一部分；文件列表仍来自完整的 Git status。</p></details> : null}
          <GitChangesWorkspace key={`${sessionId}\u0000${data.gitRoot}`} sessionId={sessionId} data={data} />
        </>
      ) : null}
    </main>
  );
}
