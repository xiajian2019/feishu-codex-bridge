import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { getJson } from "./api.js";
import { BridgeImage } from "./BridgeMedia.js";
import { copyMobileText, isMobileApp } from "./mobile-runtime.js";
import type { SessionFileForwardRequest } from "./TmuxMessageComposer.js";
import { useMobileBack } from "./use-mobile-back.js";

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
  unconfirmed: "送达结果未知",
  failed: "失败",
};

interface TmuxSessionHistoryProps {
  embedded?: boolean;
  sessionIdOverride?: string | null;
}

export function TmuxSessionHistory({ embedded = false, sessionIdOverride }: TmuxSessionHistoryProps = {}): ReactElement {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const routeSessionId = params.get("session") || "";
  const sessionId = sessionIdOverride === undefined ? routeSessionId : sessionIdOverride || "";
  const [embeddedQuery, setEmbeddedQuery] = useState("");
  const [embeddedOffset, setEmbeddedOffset] = useState(0);
  const query = embedded ? embeddedQuery : params.get("q") || "";
  const rawOffset = Number(params.get("offset") || 0);
  const offset = embedded ? embeddedOffset : Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const [draft, setDraft] = useState(query);
  const [page, setPage] = useState<TmuxSessionActionPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedActionId, setCopiedActionId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [previewImage, setPreviewImage] = useState<TmuxSessionImageAttachment | null>(null);
  useMobileBack(Boolean(previewImage), () => setPreviewImage(null), 950);

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
    if (embedded) {
      if (Object.prototype.hasOwnProperty.call(values, "q")) setEmbeddedQuery(values.q || "");
      if (Object.prototype.hasOwnProperty.call(values, "offset")) setEmbeddedOffset(Number(values.offset || 0));
      return;
    }
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next);
  };
  const copyContent = async (item: TmuxSessionAction): Promise<void> => {
    if (!item.content) return;
    setActionError(null);
    try {
      await copyTextToClipboard(item.content);
      setCopiedActionId(item.action_id);
      window.setTimeout(() => setCopiedActionId((current) => current === item.action_id ? null : current), 1_500);
    } catch (copyError) {
      setActionError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const forwardContent = (item: TmuxSessionAction): void => {
    const images = item.imageAttachments ?? [];
    if ((!item.content && images.length === 0) || !item.tmux_session_id) return;
    const request: SessionFileForwardRequest = {
      id: `history-${item.action_id}-${Date.now()}`,
      sessionId: item.tmux_session_id,
      text: item.content,
      ...(images.length > 0 ? { images } : {}),
    };
    navigate(`/tmux-dashboard?session=${encodeURIComponent(item.tmux_session_id)}`, {
      state: { sessionFileForward: request },
    });
  };

  return (
    <main className={`tmux-history-page${embedded ? " is-embedded" : ""}`}>
      <header className="tmux-history-header">
        <div className="tmux-history-heading">
          {embedded ? (
            <div className="tmux-inspector-compact-heading">
              <strong>{sessionId ? "操作历史" : "全部 Session 历史"}</strong>
            </div>
          ) : (
            <>
              <h1>{sessionId ? "操作历史" : "全部 Session 历史"}</h1>
            </>
          )}
        </div>
        {!embedded ? (
          <div className="tmux-history-header-actions">
            <Link
              className="tmux-history-icon-button"
              to={sessionId ? `/tmux-dashboard?session=${encodeURIComponent(sessionId)}` : "/tmux-dashboard"}
              aria-label={sessionId ? "返回 Session 详情" : "返回 Sessions"}
              title={sessionId ? "返回 Session 详情" : "返回 Sessions"}
            >
              <TmuxHistoryIcon action="back" />
            </Link>
            <button className="tmux-history-icon-button" type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)} aria-label="刷新操作历史" title="刷新操作历史">
              <TmuxHistoryIcon action="refresh" />
            </button>
          </div>
        ) : null}
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
      {actionError ? <p className="tmux-history-action-error" role="alert">{actionError}</p> : null}
      {loading ? <p role="status">加载中…</p> : null}
      {!loading && !error ? (
        <>
          <p className="tmux-history-total">共 {page?.total ?? 0} 条记录</p>
          <section className="tmux-history-list" aria-label="Session 操作记录">
            {page?.items.map((item) => (
              <article className="tmux-history-record" key={item.action_id}>
                {!sessionId ? <p className="tmux-history-record-session">{item.session_name} · {item.project_key || item.working_directory}</p> : null}
                <header>
                  <div className="tmux-history-record-meta">
                    <span className="tmux-history-type">{ACTION_LABELS[item.action_type]}</span>
                    <span className={`tmux-history-status is-${item.status}`}>{STATUS_LABELS[item.status]}</span>
                    <div className="tmux-history-record-actions" aria-label="记录操作">
                      <button
                        className={`tmux-history-record-action${copiedActionId === item.action_id ? " is-copied" : ""}`}
                        type="button"
                        disabled={!item.content}
                        onClick={() => void copyContent(item)}
                        aria-label={copiedActionId === item.action_id ? "已复制内容" : "复制内容"}
                        title={copiedActionId === item.action_id ? "已复制" : "复制内容"}
                      >
                        <TmuxHistoryIcon action="copy" />
                      </button>
                      <button
                        className="tmux-history-record-action"
                        type="button"
                        disabled={(!item.content && !(item.imageAttachments?.length ?? 0)) || !item.tmux_session_id}
                        onClick={() => forwardContent(item)}
                        aria-label="转发到 Session 聊天框"
                        title="转发到 Session 聊天框"
                      >
                        <TmuxHistoryIcon action="forward" />
                      </button>
                    </div>
                  </div>
                  <time dateTime={item.created_at}>{formatTime(item.created_at)}</time>
                </header>
                {item.content ? <pre>{item.content}</pre> : null}
                {item.imageAttachments && item.imageAttachments.length > 0 ? (
                  <div className="tmux-history-images" aria-label="提交的图片">
                    {item.imageAttachments.map((image) => (
                      <button key={image.url} type="button" onClick={() => setPreviewImage(image)} aria-label={`放大查看 ${image.name}`} title={`查看 ${image.name}`}>
                        <BridgeImage src={image.url} alt={image.name} loading="lazy" />
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
          <BridgeImage src={previewImage.url} alt={previewImage.name} />
        </div>
      ) : null}
    </main>
  );
}

function TmuxHistoryIcon({ action }: { action: "back" | "copy" | "forward" | "refresh" }): ReactElement {
  if (action === "back") {
    return <svg className="tmux-history-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 5-7 7 7 7" /><path d="M8 12h11" /></svg>;
  }
  if (action === "copy") {
    return <svg className="tmux-history-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
  }
  if (action === "forward") {
    return <svg className="tmux-history-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m13 4 7 7-7 7" /><path d="M20 11H9a5 5 0 0 0-5 5v2" /></svg>;
  }
  return <svg className="tmux-history-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9A7 7 0 0 1 18 6.3L20 8M4 16l2 1.7A7 7 0 0 0 18.4 15" /></svg>;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (isMobileApp()) return copyMobileText(value);
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Mobile browsers may block Clipboard API on HTTP LAN pages.
    }
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.top = "0";
  field.style.fontSize = "16px";
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, field.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    field.remove();
  }
  if (!copied) throw new Error("此浏览器无法访问剪贴板。");
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}
