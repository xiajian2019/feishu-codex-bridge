import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import ReactMarkdown from "react-markdown";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { useNavigate, useParams } from "react-router";

import {
  codexHistoryRunAttachmentUrl,
  fetchCodexHistory,
  fetchCodexThreadDetail,
  fetchCodexThreadUpdates,
  fetchCodexThreadWriterStatus,
  interruptCodexThreadMessage,
  sendCodexThreadMessage,
} from "./api.js";
import {
  CodexHistoryMessageComposer,
} from "./CodexHistoryMessageComposer.js";
import {
  CODEX_THREAD_STATUS_TYPES,
  type CodexHistoryDetailResponse,
  type CodexHistoryItem,
  type CodexHistoryListResponse,
  type CodexHistoryRunState,
  type CodexHistoryTurnAttachments,
  type CodexHistoryUpdateEvent,
  type CodexHistoryWriterStatus,
  type CodexThread,
} from "./types.js";

const PAGE_SIZE = 40;

interface HistoryFilters {
  home: string;
  q: string;
  status: string;
}

const EMPTY_FILTERS: HistoryFilters = {
  home: "",
  q: "",
  status: "",
};

const STATUS_LABELS: Record<string, string> = {
  notLoaded: "未加载",
  idle: "已完成",
  active: "运行中",
  systemError: "错误",
};

export function CodexHistory(): ReactElement {
  const navigate = useNavigate();
  const { homeId, threadId } = useParams<{ homeId?: string; threadId?: string }>();
  const isDetailRoute = Boolean(homeId && threadId);
  const [draftFilters, setDraftFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<CodexHistoryListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDetailRoute) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchCodexHistory({
      home: filters.home || undefined,
      q: filters.q.trim() || undefined,
      status: filters.status || undefined,
      archived: "active",
      limit: PAGE_SIZE,
      offset,
    }, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setResult(next);
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, offset, isDetailRoute]);

  const submitFilters = useCallback((event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setOffset(0);
    setFilters({ ...draftFilters });
  }, [draftFilters]);

  const openThread = useCallback((item: CodexHistoryItem): void => {
    navigate(`/codex-history/${encodeURIComponent(item.home.id)}/${encodeURIComponent(item.thread.id)}`);
  }, [navigate]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));
  const homes = result?.homes ?? [];

  if (isDetailRoute) {
    return <CodexThreadPage homeId={homeId!} threadId={threadId!} onBack={() => navigate("/codex-history")} />;
  }

  return (
      <main className="page-main codex-history-page">
        <form className="filters codex-history-filters" onSubmit={submitFilters}>
          <input
            aria-label="搜索 Codex 会话"
            type="search"
            placeholder="搜索会话标题或最近消息"
            value={draftFilters.q}
            onChange={(event) => setDraftFilters((current) => ({ ...current, q: event.target.value }))}
          />
          <select aria-label="Codex home" value={draftFilters.home} onChange={(event) => setDraftFilters((current) => ({ ...current, home: event.target.value }))}>
            <option value="">全部 home</option>
            {homes.map((home) => <option key={home.id} value={home.id}>{home.label}</option>)}
          </select>
          <select aria-label="运行状态" value={draftFilters.status} onChange={(event) => setDraftFilters((current) => ({ ...current, status: event.target.value }))}>
            <option value="">全部状态</option>
            {CODEX_THREAD_STATUS_TYPES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] || status}</option>)}
          </select>
          <button className="primary" type="submit">查询</button>
          <div className="codex-filter-total" aria-live="polite">
            {loading ? "正在读取…" : `共 ${result?.total ?? 0} 个会话 · 显示 ${result?.items.length ? offset + 1 : 0}–${Math.min(offset + (result?.items.length ?? 0), result?.total ?? 0)}`}
          </div>
        </form>

        <section className="codex-history-list" aria-live="polite">
          {error ? (
            <div className="codex-thread-error" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="关闭错误信息" title="关闭" onClick={() => setError(null)}>×</button>
            </div>
          ) : null}
          {!error && loading ? <div className="empty">正在读取不同 Codex home 的会话…</div> : null}
          {!error && !loading && result?.items.length === 0 ? <div className="empty">没有符合条件的 Codex 会话。</div> : null}
          {result?.items.map((item) => <CodexHistoryRow key={`${item.home.id}:${item.thread.id}`} item={item} onOpen={openThread} />)}
        </section>
        <CodexPagination
          page={page}
          pageCount={pageCount}
          total={result?.total ?? 0}
          loading={loading}
          onPrevious={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
          onNext={() => setOffset((value) => value + PAGE_SIZE)}
        />
      </main>
  );
}

function CodexHistoryRow({ item, onOpen }: { item: CodexHistoryItem; onOpen: (item: CodexHistoryItem) => void }): ReactElement {
  const { thread, home } = item;
  const title = thread.name?.trim() || thread.preview?.trim() || "（无标题）";
  return (
    <button className="codex-history-row" type="button" onClick={() => onOpen(item)}>
      <div className="codex-history-row-main">
        <div className="codex-thread-title">{title}</div>
        <div className="guid">{thread.id}</div>
      </div>
      <div className="codex-history-row-meta">
        <span className="badge codex-status-badge">{statusLabel(thread)}</span>
        <span className="codex-home-pill">{home.label}</span>
        <span>{sourceLabel(thread)}</span>
        <span>{formatCodexTime(thread.updatedAt ?? thread.recencyAt ?? thread.createdAt)}</span>
      </div>
      <div className="codex-thread-path" title={thread.cwd || thread.path || ""}>{thread.cwd || thread.path || "—"}</div>
    </button>
  );
}

function CodexPagination({
  page,
  pageCount,
  total,
  loading,
  onPrevious,
  onNext,
}: {
  page: number;
  pageCount: number;
  total: number;
  loading: boolean;
  onPrevious: () => void;
  onNext: () => void;
}): ReactElement | null {
  if (total === 0) return null;
  return (
    <nav className="codex-history-pagination" aria-label="会话分页">
      <button className="codex-page-button" type="button" aria-label="上一页" disabled={page <= 1 || loading} onClick={onPrevious}>‹</button>
      <span className="codex-page-current">{page}</span>
      <span className="codex-page-total">/ {pageCount}</span>
      <button className="codex-page-button" type="button" aria-label="下一页" disabled={page >= pageCount || loading} onClick={onNext}>›</button>
    </nav>
  );
}

function CodexThreadPage({ homeId, threadId, onBack }: { homeId: string; threadId: string; onBack: () => void }): ReactElement {
  return (
    <main className="page-main codex-thread-page codex-thread-page-shell">
      <CodexThreadDetail homeId={homeId} threadId={threadId} onBack={onBack} />
    </main>
  );
}

function CodexThreadDetail({ homeId, threadId, onBack }: { homeId: string; threadId: string; onBack: () => void }): ReactElement {
  const [detail, setDetail] = useState<CodexHistoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<LiveThreadRun | null>(null);
  const [imagePreviews, setImagePreviews] = useState<Record<number, CodexImagePreview[]>>({});
  const [writerStatus, setWriterStatus] = useState<CodexHistoryWriterStatus | null>(null);
  const liveCursorRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchCodexThreadDetail(homeId, threadId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setDetail(next);
          setImagePreviews(buildTurnImagePreviews(homeId, threadId, next.imageAttachments ?? []));
        }
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [homeId, threadId]);

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    const refreshWriterStatus = async (): Promise<void> => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const next = await fetchCodexThreadWriterStatus(homeId, threadId, controller.signal);
        setWriterStatus(next);
        const localRun = next.localRun;
        if (localRun) {
          setLiveRun((current) => current?.runId === localRun.runId
            ? { ...current, state: localRun.state, cursor: Math.max(current.cursor, localRun.cursor) }
            : {
                runId: localRun.runId,
                threadId: localRun.threadId,
                userText: localRun.userText,
                state: localRun.state,
                cursor: localRun.cursor,
                items: [],
              });
        }
      } catch {
        if (!controller.signal.aborted) {
          setWriterStatus({ state: "unknown", checkedAt: new Date().toISOString() });
        }
      } finally {
        checking = false;
      }
    };
    setWriterStatus(null);
    void refreshWriterStatus();
    const timer = window.setInterval(() => void refreshWriterStatus(), 4_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [homeId, threadId]);

  const liveRunId = liveRun?.runId;
  const liveRunState = liveRun?.state;
  useEffect(() => {
    if (!liveRunId || (liveRunState !== "running" && liveRunState !== "cancelling")) return;
    const controller = new AbortController();
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await fetchCodexThreadUpdates(
          homeId,
          threadId,
          liveRunId,
          liveCursorRef.current,
          controller.signal,
        );
        if (cancelled || controller.signal.aborted) return;
        if (next.resetRequired) {
          liveCursorRef.current = 0;
          setLiveRun((current) => current?.runId === next.runId ? { ...current, items: [] } : current);
        } else {
          setLiveRun((current) => current?.runId === next.runId
            ? { ...current, state: next.state, cursor: next.cursor, items: mergeLiveItems(current.items, next.events) }
            : current);
        }
        liveCursorRef.current = next.cursor;
        if (next.state === "completed" || next.state === "failed" || next.state === "cancelled") {
          if (next.state === "failed") setError(next.error || "Codex turn 执行失败。");
          if (next.state === "cancelled") setRunNotice("Codex 执行已中断。");
          const refreshed = await fetchCodexThreadDetail(homeId, threadId, controller.signal);
          if (cancelled || controller.signal.aborted) return;
          setDetail(refreshed);
          setImagePreviews(buildTurnImagePreviews(homeId, threadId, refreshed.imageAttachments ?? []));
          setLiveRun(null);
        }
      } catch (nextError: unknown) {
        if (!cancelled && !controller.signal.aborted) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_200);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [homeId, threadId, liveRunId]);

  const thread = detail?.thread ?? { id: threadId };
  const title = thread.name?.trim() || thread.preview?.trim() || "（无标题）";
  const homeLabel = detail?.home.label ?? "Codex home";
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const liveTurns = liveRun ? [{
    items: [
      { type: "userMessage", text: liveRun.userText || "（已发送附件）" },
      ...liveRun.items,
    ],
  }] : [];
  const displayedTurnCount = turns.length + (liveRun ? 1 : 0);

  const submitMessage = useCallback(async (
    text: string,
    attachmentIds: string[],
  ): Promise<{ ok: boolean; message?: string }> => {
    try {
      const result = await sendCodexThreadMessage(homeId, threadId, {
        text,
        attachmentIds,
        turnIndex: turns.length,
      });
      setRunNotice(null);
      const previews = result.attachments
        .filter((attachment) => attachment.mimeType.startsWith("image/"))
        .map((attachment) => ({
          fileName: attachment.fileName,
          src: codexHistoryRunAttachmentUrl(homeId, threadId, result.runId, attachment.attachmentId),
        }));
      if (previews.length > 0) {
        setImagePreviews((current) => ({ ...current, [result.turnIndex]: previews }));
      }
      liveCursorRef.current = result.cursor;
      setLiveRun({
        runId: result.runId,
        threadId: result.threadId,
        userText: text || "（已发送附件）",
        state: result.state,
        cursor: result.cursor,
        items: [],
      });
      setError(null);
      window.setTimeout(() => scrollCodexTranscript("bottom"), 0);
      return { ok: true };
    } catch (submitError: unknown) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      if (message.includes("正在其他位置使用")) {
        setWriterStatus({ state: "busy", checkedAt: new Date().toISOString() });
      }
      setError(message);
      return { ok: false, message };
    }
  }, [homeId, threadId, turns.length]);

  const interruptRun = useCallback(async (): Promise<void> => {
    if (!liveRun || liveRun.state !== "running") return;
    const runId = liveRun.runId;
    setLiveRun((current) => current?.runId === runId ? { ...current, state: "cancelling" } : current);
    setRunNotice("正在请求 Codex 中断当前执行…");
    try {
      const result = await interruptCodexThreadMessage(homeId, threadId, runId);
      if (!result.ok) throw new Error("当前 Codex 执行已经结束，无需中断。");
      setLiveRun((current) => current?.runId === runId ? { ...current, state: result.state } : current);
    } catch (interruptError: unknown) {
      setLiveRun((current) => current?.runId === runId && current.state === "cancelling"
        ? { ...current, state: "running" }
        : current);
      setRunNotice(null);
      setError(interruptError instanceof Error ? interruptError.message : String(interruptError));
    }
  }, [homeId, threadId, liveRun]);

  return (
    <section className="codex-thread-panel" aria-labelledby="codex-thread-title">
      <div className="codex-thread-view-head">
        <button className="codex-thread-back" type="button" onClick={onBack} aria-label="返回会话列表" title="返回会话列表">‹</button>
        <div className="codex-thread-view-heading">
          <strong id="codex-thread-title" title={title}>{title}</strong>
          <CodexThreadInfo thread={thread} homeLabel={homeLabel} />
          <span>{loading ? "" : `${displayedTurnCount} 轮${liveRun?.state === "running" ? " · 正在运行" : liveRun?.state === "cancelling" ? " · 正在中断" : ""}`}</span>
        </div>
      </div>
      {writerStatus?.state === "busy" && !writerStatus.localRun && !isLiveRunActive(liveRun?.state) ? (
        <div className="codex-thread-writer-status is-busy" role="status">
          此 Codex session 正在其他位置使用。发送已暂停，释放后会自动恢复。
        </div>
      ) : writerStatus?.state === "unknown" ? (
        <div className="codex-thread-writer-status" role="status">
          暂时无法检测此 session 的占用情况，发送时会再检查一次。
        </div>
      ) : writerStatus === null && !loading ? (
        <div className="codex-thread-writer-status" role="status">
          正在检查 Codex session 是否被占用…
        </div>
      ) : null}
      {runNotice ? <div className="codex-thread-run-notice" role="status">{runNotice}</div> : null}
      <div className="codex-thread-view-body">
        <div className="codex-thread-transcript">
          {error ? (
            <div className="codex-thread-error" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="关闭错误信息" title="关闭" onClick={() => setError(null)}>×</button>
            </div>
          ) : null}
          {loading ? <div className="empty">正在读取会话详情…</div> : null}
          {!loading && turns.length === 0 && !liveRun ? <div className="empty">该会话没有可展示的轮次。</div> : null}
          {!loading && (turns.length > 0 || liveRun) ? <CodexAssistantTranscript thread={thread} extraTurns={liveTurns} imagePreviews={imagePreviews} /> : null}
        </div>
        <CodexHistoryMessageComposer
          disabled={loading || !detail}
          sendDisabled={writerStatus === null || (writerStatus.state === "busy" && !writerStatus.localRun) || isLiveRunActive(liveRun?.state)}
          sending={isLiveRunActive(liveRun?.state)}
          cancelling={liveRun?.state === "cancelling"}
          placeholder="发送消息到当前 Codex session…"
          onSubmit={submitMessage}
          onInterrupt={() => void interruptRun()}
          onAttachmentError={(message) => setError(message)}
          onScrollToTop={() => scrollCodexTranscript("top")}
          onScrollToBottom={() => scrollCodexTranscript("bottom")}
        />
      </div>
    </section>
  );
}

function CodexThreadInfo({ thread, homeLabel }: { thread: CodexThread; homeLabel: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const path = thread.cwd || thread.path || "—";
  return (
    <>
      <button
        className={`codex-thread-info-trigger${open ? " is-open" : ""}`}
        type="button"
        aria-label={open ? "收起会话信息" : "展开会话信息"}
        aria-expanded={open}
        title={open ? "收起会话信息" : "展开会话信息"}
        onClick={() => setOpen((current) => !current)}
      >›</button>
      {open ? <div className="codex-thread-info-panel">
        <div className="codex-thread-info-row">
          <span className="codex-home-pill">{homeLabel}</span>
          <span className="badge codex-status-badge">{statusLabel(thread)}</span>
          <span>{sourceLabel(thread)}</span>
          <span>{formatCodexTime(thread.updatedAt ?? thread.recencyAt ?? thread.createdAt)}</span>
        </div>
        <div className="codex-thread-path" title={path}>{path}</div>
        <div className="codex-thread-info-row codex-thread-info-secondary">
          <span>{thread.modelProvider || "—"}{thread.model ? ` / ${thread.model}` : ""}</span>
          <span>创建 {formatCodexTime(thread.createdAt)}</span>
          <code title={thread.id}>{thread.id}</code>
        </div>
      </div> : null}
    </>
  );
}

interface LiveThreadRun {
  runId: string;
  threadId: string;
  userText: string;
  state: CodexHistoryRunState;
  cursor: number;
  items: unknown[];
}

function isLiveRunActive(state: CodexHistoryRunState | undefined): state is "running" | "cancelling" {
  return state === "running" || state === "cancelling";
}

interface CodexImagePreview {
  fileName: string;
  src: string;
}

function buildTurnImagePreviews(
  homeId: string,
  threadId: string,
  turns: CodexHistoryTurnAttachments[],
): Record<number, CodexImagePreview[]> {
  const previews: Record<number, CodexImagePreview[]> = {};
  for (const turn of turns) {
    const images = turn.attachments
      .filter((attachment) => attachment.mimeType.startsWith("image/"))
      .map((attachment) => ({
        fileName: attachment.fileName,
        src: codexHistoryRunAttachmentUrl(homeId, threadId, turn.runId, attachment.attachmentId),
      }));
    if (images.length > 0) previews[turn.turnIndex] = images;
  }
  return previews;
}

function scrollCodexTranscript(position: "top" | "bottom"): void {
  const viewport = document.querySelector<HTMLElement>(".codex-assistant-viewport");
  if (!viewport) return;
  viewport.scrollTo({
    top: position === "top" ? 0 : viewport.scrollHeight,
    behavior: "smooth",
  });
}

function mergeLiveItems(previous: unknown[], events: CodexHistoryUpdateEvent[]): unknown[] {
  const next = previous.slice();
  for (const event of events) {
    if (!event.item || typeof event.item !== "object" || Array.isArray(event.item)) continue;
    const item = event.item as Record<string, unknown>;
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const existingIndex = itemId
      ? next.findIndex((candidate) => {
        const candidateRecord = asRecord(candidate);
        return candidateRecord.id === itemId;
      })
      : -1;
    if (existingIndex >= 0) next[existingIndex] = item;
    else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") next.push(item);
  }
  return next;
}

interface CodexProcessEvent {
  type: string;
  status?: string;
  text: string;
}

interface CodexProcessGroup {
  summary?: CodexProcessEvent;
  commands: CodexProcessEvent[];
  other: CodexProcessEvent[];
}

interface CodexProcessPayload {
  groups: CodexProcessGroup[];
  durationMs?: number;
}

type CodexMessagePart = Exclude<ThreadMessageLike["content"], string>[number];

function CodexAssistantTranscript({
  thread,
  extraTurns = [],
  imagePreviews = {},
}: {
  thread: CodexThread;
  extraTurns?: unknown[];
  imagePreviews?: Record<number, CodexImagePreview[]>;
}): ReactElement {
  const messages = useMemo(
    () => buildCodexMessages(thread, extraTurns, imagePreviews),
    [thread, extraTurns, imagePreviews],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    isDisabled: true,
    isSendDisabled: true,
    onNew: async () => undefined,
    convertMessage: (message) => message,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="codex-assistant-thread">
        <ThreadPrimitive.Viewport autoScroll={false} className="codex-assistant-viewport">
          <ThreadPrimitive.Messages>
            {({ message }) => message.role === "user"
              ? <CodexAssistantUserMessage />
              : <CodexAssistantMessage />}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function CodexAssistantUserMessage(): ReactElement {
  return (
    <MessagePrimitive.Root className="codex-assistant-message codex-assistant-user-message">
      <MessagePrimitive.Parts
        components={{
          data: {
            by_name: {
              "codex-images": CodexImagesPart,
            },
          },
        }}
      />
    </MessagePrimitive.Root>
  );
}

function CodexImagesPart({ data }: { data: { images: CodexImagePreview[] } }): ReactElement {
  return (
    <div className="codex-assistant-user-images">
      {data.images.map((image, index) => (
        <a key={`${image.fileName}:${index}`} href={image.src} target="_blank" rel="noreferrer" title={image.fileName}>
          <img src={image.src} alt={image.fileName} />
        </a>
      ))}
    </div>
  );
}

function CodexAssistantMessage(): ReactElement {
  return (
    <MessagePrimitive.Root className="codex-assistant-message codex-assistant-agent-message">
      <MessagePrimitive.Parts
        components={{
          Text: CodexMarkdownText,
          data: {
            by_name: {
              "codex-process": CodexProcessPart,
            },
          },
        }}
      />
    </MessagePrimitive.Root>
  );
}

function CodexMarkdownText({ text }: { text: string }): ReactElement {
  return <div className="codex-assistant-markdown"><ReactMarkdown>{text}</ReactMarkdown></div>;
}

function CodexProcessPart({ data }: { data: CodexProcessPayload }): ReactElement {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const eventCount = groups.reduce((count, group) => count
    + (group.summary ? 1 : 0)
    + group.commands.length
    + group.other.length, 0);
  return (
    <div className={`codex-assistant-process-row${typeof data.durationMs === "number" ? " has-duration" : ""}`}>
      {groups.length > 0 ? (
        <details className="codex-assistant-process">
          <summary>过程回放 <span>{eventCount} 个事件</span></summary>
          <div className="codex-assistant-process-list">
            {groups.map((group, index) => <CodexProcessGroupView key={`process-group-${index}`} group={group} />)}
          </div>
        </details>
      ) : null}
      {typeof data.durationMs === "number" ? <span className="codex-assistant-duration">用时 {formatDuration(data.durationMs)}</span> : null}
    </div>
  );
}

function CodexProcessGroupView({ group }: { group: CodexProcessGroup }): ReactElement {
  return (
    <section className="codex-assistant-process-group">
      {group.summary ? <div className="codex-assistant-reasoning"><ReactMarkdown>{group.summary.text}</ReactMarkdown></div> : null}
      {group.commands.length > 0 ? (
        <details className="codex-assistant-command-details">
          <summary><span>{group.commands.length} 条</span><span className="codex-command-chevron" aria-hidden="true">›</span></summary>
          <div className="codex-assistant-command-list">
            {group.commands.map((event, index) => <pre className="codex-assistant-command" key={`command-${index}`}>{event.text}</pre>)}
          </div>
        </details>
      ) : null}
      {group.other.map((event, index) => <pre className="codex-assistant-process-other" key={`${event.type}-${index}`}>{event.text}</pre>)}
    </section>
  );
}

function buildCodexMessages(
  thread: CodexThread,
  extraTurns: unknown[] = [],
  imagePreviews: Record<number, CodexImagePreview[]> = {},
): ThreadMessageLike[] {
  const turns = [
    ...(Array.isArray(thread.turns) ? thread.turns : []),
    ...extraTurns,
  ];
  const messages: ThreadMessageLike[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const record = asRecord(turn);
    const items = Array.isArray(record.items) ? record.items : [];
    const userItems = items.filter((item) => isUserMessage(item));
    const assistantItems = items.filter((item) => isAssistantMessage(item));
    const processItems = items.filter((item) => !isAssistantUiMessage(item));

    userItems.forEach((item, itemIndex) => {
      const content: CodexMessagePart[] = [
        { type: "text", text: formatCodexItem(item, "userMessage") },
      ];
      if (itemIndex === userItems.length - 1 && imagePreviews[turnIndex]?.length) {
        content.push({
          type: "data-codex-images",
          data: { images: imagePreviews[turnIndex] },
        });
      }
      messages.push({
        id: `${thread.id}-turn-${turnIndex}-user-${itemIndex}`,
        role: "user",
        content: [{ type: "text", text: formatCodexUserMessage(item) }, ...content.slice(1)],
      });
    });

    const content: CodexMessagePart[] = assistantItems
      .map((item) => ({ type: "text" as const, text: formatCodexItem(item, itemType(item) || "agentMessage") }));
    const durationMs = finiteNumber(record.durationMs);
    if (processItems.length > 0 || durationMs !== null) {
      content.push({
        type: "data-codex-process",
        data: {
          groups: buildCodexProcessGroups(processItems),
          ...(durationMs === null ? {} : { durationMs }),
        } satisfies CodexProcessPayload,
      });
    }
    if (content.length > 0) {
      messages.push({
        id: `${thread.id}-turn-${turnIndex}-assistant`,
        role: "assistant",
        content,
      });
    }
  }
  return messages;
}

function itemType(item: unknown): string | undefined {
  return stringValue(asRecord(item).type);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds}s`;
}

function buildCodexProcessGroups(items: unknown[]): CodexProcessGroup[] {
  const groups: CodexProcessGroup[] = [];
  let current: CodexProcessGroup | null = null;
  for (const item of items) {
    const type = itemType(item) || "event";
    const event: CodexProcessEvent = {
      type,
      ...(stringValue(asRecord(item).status) ? { status: stringValue(asRecord(item).status) } : {}),
      text: formatCodexItem(item, type),
    };
    if (type === "reasoning") {
      if (current) groups.push(current);
      current = { summary: event, commands: [], other: [] };
    } else if (type === "commandExecution" || type === "command_execution") {
      current ??= { commands: [], other: [] };
      current.commands.push(event);
    } else {
      current ??= { commands: [], other: [] };
      current.other.push(event);
    }
  }
  if (current) groups.push(current);
  return groups;
}

function isAssistantUiMessage(item: unknown): boolean {
  return isUserMessage(item) || isAssistantMessage(item);
}

function isUserMessage(item: unknown): boolean {
  const type = itemType(item);
  return type === "userMessage" || type === "user_message";
}

function isAssistantMessage(item: unknown): boolean {
  const type = itemType(item);
  return type === "agentMessage"
    || type === "assistantMessage"
    || type === "agent_message"
    || type === "assistant_message";
}

function statusLabel(thread: CodexThread): string {
  const status = thread.status?.type;
  return STATUS_LABELS[status || ""] || status || "未知";
}

function sourceLabel(thread: CodexThread): string {
  const source = thread.source ?? thread.threadSource;
  if (typeof source === "string" && source) return source;
  if (source && typeof source === "object") {
    const record = asRecord(source);
    if (typeof record.custom === "string") return `custom:${record.custom}`;
    if (record.subAgent && typeof record.subAgent === "object") return "subAgent";
  }
  return "unknown";
}

function formatCodexTime(timestampSeconds: number | null | undefined): string {
  if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) return "—";
  return new Date(timestampSeconds * 1_000).toLocaleString("zh-CN", { hour12: false });
}

function formatCodexItem(item: unknown, type: string): string {
  const record = asRecord(item);
  const parts: string[] = [];
  if ((type === "commandExecution" || type === "command_execution") && typeof record.command === "string") {
    parts.push(`$ ${record.command}`);
  }
  for (const key of ["text", "summary", "content", "aggregatedOutput", "aggregated_output", "output", "error"]) {
    const value = record[key];
    const text = flattenText(value);
    if (text) parts.push(text);
  }
  if (parts.length > 0) return parts.join("\n\n");
  if (typeof record.message === "string" && record.message) return record.message;
  return "（无文本输出）";
}

function formatCodexUserMessage(item: unknown): string {
  return formatCodexItem(item, itemType(item) || "userMessage")
    .replace(/\n*请打开并查看我附上的图片，再结合上面的文字处理：\n(?:<image name=\[Image #\d+\] path="[^"]*">\n?)+/g, "")
    .replace(/\n*请读取我附上的文件，再结合上面的文字处理：\n(?:<file name="[^"]*" path="[^"]*">\n?)+/g, "")
    .trim();
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = asRecord(value);
  if (typeof record.text === "string") return record.text;
  if (typeof record.value === "string") return record.value;
  if (record.type === "image") return "[图片]";
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
