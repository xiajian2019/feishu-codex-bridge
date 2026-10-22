import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router";

import { getJson } from "./api.js";

type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";

interface GitChangeFile {
  path: string;
  oldPath: string | null;
  status: GitChangeStatus;
  staged: boolean;
  unstaged: boolean;
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
  const path = file.path.replaceAll("\\", "/");
  return section.includes(" b/" + path)
    || section.includes(" a/" + path)
    || (file.oldPath !== null && section.includes(file.oldPath.replaceAll("\\", "/")));
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
              <div className="tmux-git-changes-files-heading">
                <strong>变更文件</strong>
                <span>{data.files.length}</span>
              </div>
              {data.files.length === 0 ? <p className="muted">当前工作区没有未提交变更。</p> : null}
              {data.files.map((file) => (
                <button
                  className={"tmux-git-change-file" + (selectedPath === file.path ? " is-selected" : "")}
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath((current) => current === file.path ? null : file.path)}
                >
                  <span className="tmux-git-change-file-status">{STATUS_LABELS[file.status]}</span>
                  <span className="tmux-git-change-file-path" title={file.path}>{file.path}</span>
                  <span className="tmux-git-change-file-scope">{file.staged && file.unstaged ? "暂存 + 工作区" : file.staged ? "已暂存" : "工作区"}</span>
                </button>
              ))}
            </aside>
            <section className="tmux-git-changes-diff" aria-label="Git diff">
              <header>
                <strong>{selectedFile ? selectedFile.path : "完整 diff"}</strong>
                {selectedFile?.oldPath ? <span>来自 {selectedFile.oldPath}</span> : null}
              </header>
              {!data.patch ? (
                <p className="muted">没有可展示的文本 diff。二进制文件、过大的未跟踪文件或当前工作区为空时会显示在文件列表中。</p>
              ) : selectedFile && !selectedPatch ? (
                <p className="muted">该文件没有可展示的文本 diff，可能是二进制文件或超过单文件读取上限。</p>
              ) : (
                <pre className="tmux-git-change-code"><code>{renderPatch(selectedPatch)}</code></pre>
              )}
            </section>
          </section>
        </>
      ) : null}
    </main>
  );
}
