import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Link, useSearchParams } from "react-router";
import { getJson } from "./api.js";

interface TmuxSessionInfo {
  session_name: string;
  project_key: string | null;
  working_directory: string;
  ended_at: string | null;
}

interface TmuxSessionImageAttachment {
  name: string;
  url: string;
}

interface TmuxSessionAction {
  action_id: string;
  tmux_session_id: string;
  session_name: string;
  project_key: string | null;
  working_directory: string;
  device_id: string | null;
  device_name: string | null;
  action_type: "task_submit" | "terminal_command" | "shortcut" | "control_sequence";
  content: string;
  imageAttachments?: TmuxSessionImageAttachment[];
  status: "sending" | "sent" | "confirmed" | "unconfirmed" | "failed";
  error: string | null;
  created_at: string;
}

interface TmuxSessionActionPage {
  items: TmuxSessionAction[];
  total: number;
  session: TmuxSessionInfo | null;
}

const PAGE_SIZE = 30;
const ACTION_LABELS: Record<TmuxSessionAction["action_type"], string> = {
  task_submit: "任务提交",
  terminal_command: "终端命令",
  shortcut: "快捷操作",
  control_sequence: "控制序列",
};
const STATUS_LABELS: Record<TmuxSessionAction["status"], string> = {
  sending: "提交中",
  sent: "已发送",
  confirmed: "已确认",
  unconfirmed: "待核实",
  failed: "失败",
};

export function TmuxSessionHistory(): ReactElement {
  const [params, setParams] = useSearchParams();
  const sessionId = params.get("session") || "";
  const query = params.get("q") || "";
  const rawOffset = Number(params.get("offset") || 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const [draft, setDraft] = useState(query);
  const [page, setPage] = useState<TmuxSessionActionPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [previewImage, setPreviewImage] = useState<TmuxSessionImageAttachment | null>(null);

  useEffect(() => { setDraft(query); }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (sessionId) search.set("session", sessionId);
    if (query) search.set("q", query);
    setPage(null);
    setLoading(true);
    setError(null);
    void getJson<TmuxSessionActionPage>(`/tmux-dashboard/api/history?${search}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setPage(result); })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, query, offset, refresh]);
  useEffect(() => {
    if (!previewImage) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewImage]);

  const updateQuery = (values: Record<string, string>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next);
  };
  const sessionInfo = page?.session ?? null;

  return (
    <main className="tmux-history-page">
      <header className="tmux-history-header">
        <div className="tmux-history-heading">
          <p className="dashboard-eyebrow">TMUX DASHBOARD / HISTORY</p>
          <h1>{sessionId ? "操作历史" : "全部 Session 历史"}</h1>
          {sessionId ? (
            <div className="tmux-history-session-context">
              <strong>{sessionInfo?.session_name || sessionId}</strong>
              <span>{sessionInfo?.project_key || "未关联项目"}</span>
              <code>{sessionInfo?.working_directory || ""}</code>
            </div>
          ) : <p>查看所有 Session 的任务提交和终端操作。</p>}
        </div>
        <div className="tmux-history-header-actions">
          <Link to={sessionId ? `/tmux-dashboard?session=${encodeURIComponent(sessionId)}` : "/tmux-dashboard"}>
            {sessionId ? "返回 Session 详情" : "返回 Sessions"}
          </Link>
          <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
        </div>
      </header>

      <form className="tmux-history-filter" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        updateQuery({ q: draft.trim(), offset: "" });
      }}>
        <input
          type="search"
          aria-label="搜索 Session 操作历史"
          placeholder="搜索操作文本、Session 或设备"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit">搜索</button>
      </form>

      {error ? <p className="tmux-history-error" role="alert">{error}</p> : null}
      {loading ? <p role="status">加载中…</p> : null}
      {!loading && !error ? (
        <>
          <p className="tmux-history-total">共 {page?.total ?? 0} 条记录</p>
          <section className="tmux-history-list" aria-label="Session 操作记录">
            {page?.items.map((item) => (
              <article className="tmux-history-record" key={item.action_id}>
                {!sessionId ? <p className="tmux-history-record-session">{item.session_name} · {item.project_key || item.working_directory}</p> : null}
                <header>
                  <div><span className="tmux-history-type">{ACTION_LABELS[item.action_type]}</span><span className={`tmux-history-status is-${item.status}`}>{STATUS_LABELS[item.status]}</span></div>
                  <time dateTime={item.created_at}>{formatTime(item.created_at)}</time>
                </header>
                {item.content ? <pre>{item.content}</pre> : null}
                {item.imageAttachments && item.imageAttachments.length > 0 ? (
                  <div className="tmux-history-images" aria-label="提交的图片">
                    {item.imageAttachments.map((image) => (
                      <button key={image.url} type="button" onClick={() => setPreviewImage(image)} aria-label={`放大查看 ${image.name}`} title={`查看 ${image.name}`}>
                        <img src={image.url} alt={image.name} loading="lazy" />
                      </button>
                    ))}
                  </div>
                ) : null}
                <footer>
                  <span>{item.device_name || "本地 / 未识别"}{item.device_id ? ` · ${item.device_id}` : ""}</span>
                  {item.error ? <span className="tmux-history-error">{item.error}</span> : null}
                </footer>
              </article>
            ))}
            {page?.items.length === 0 ? <p className="tmux-history-empty">暂无操作记录。</p> : null}
          </section>
          <nav className="tmux-history-pagination" aria-label="操作历史分页">
            <button type="button" disabled={offset === 0} onClick={() => updateQuery({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}>上一页</button>
            <span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页</span>
            <button type="button" disabled={offset + PAGE_SIZE >= (page?.total ?? 0)} onClick={() => updateQuery({ offset: String(offset + PAGE_SIZE) })}>下一页</button>
          </nav>
        </>
      ) : null}

      {previewImage ? (
        <div className="tmux-history-lightbox" role="dialog" aria-modal="true" aria-label={previewImage.name} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPreviewImage(null);
        }}>
          <button className="tmux-history-lightbox-close" type="button" aria-label="关闭图片预览" onClick={() => setPreviewImage(null)}>×</button>
          <img src={previewImage.url} alt={previewImage.name} />
        </div>
      ) : null}
    </main>
  );
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}
