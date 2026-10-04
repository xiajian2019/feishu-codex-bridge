import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { CodeTextViewer } from "./CodeTextViewer.js";
import {
  codexHistoryRunAttachmentUrl,
  fetchCodexHistory,
  fetchCodexHistoryHomes,
  fetchCodexThreadDetail,
  fetchCodexThreadUpdates,
  fetchCodexThreadWriterStatus,
  interruptCodexThreadMessage,
  sendCodexThreadMessage,
  updateCodexThreadHomePreference,
} from "./api.js";
import {
  CodexHistoryMessageComposer,
  type CodexHistoryComposerSettings,
} from "./CodexHistoryMessageComposer.js";
import {
  CODEX_THREAD_STATUS_TYPES,
  type CodexHistoryDetailResponse,
  type CodexHistoryHome,
  type CodexHistoryItem,
  type CodexHistoryListResponse,
  type CodexHistoryTurnUsage,
  type CodexHistoryRunState,
  type CodexHistoryTurnAttachments,
  type CodexHistoryUpdateEvent,
  type CodexHistoryWriterStatus,
  type CodexThread,
} from "./types.js";

const PAGE_SIZE = 40;

interface CodexFilePreviewTarget {
  relativePath: string;
  lineNumber?: number;
}

type CodexFileLinkTarget = CodexFilePreviewTarget | { outside: true };

interface CodexMarkdownLinkContextValue {
  rootPath: string;
  onOpenFile: (target: CodexFileLinkTarget) => void;
}

const CODEX_MARKDOWN_LINK_CONTEXT = createContext<CodexMarkdownLinkContextValue | null>(null);

interface HistoryFilters {
  q: string;
  status: string;
}

const EMPTY_FILTERS: HistoryFilters = {
  q: "",
  status: "",
};

const CODEX_HISTORY_HOME_STORAGE_KEY = "feishu-codex-bridge.codex-history-home";
const CODEX_HISTORY_DETAIL_CACHE_PREFIX = "feishu-codex-bridge.codex-history-detail.v1:";
const CODEX_HISTORY_DETAIL_CACHE_TTL_MS = 60 * 60 * 1_000;
const CODEX_HISTORY_LIST_VERSION_MAX_AGE_MS = 30 * 1_000;
const CODEX_HISTORY_DETAIL_CACHE_MAX_CHARS = 600_000;
const CODEX_HISTORY_DETAIL_CACHE_MAX_ENTRIES = 3;

interface CodexHistoryDetailCacheEntry {
  version: 1;
  cachedAt: number;
  detail: CodexHistoryDetailResponse;
}

function readStoredCodexHistoryHome(): string {
  try {
    return window.localStorage.getItem(CODEX_HISTORY_HOME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistCodexHistoryHome(homeId: string): void {
  try {
    if (homeId) window.localStorage.setItem(CODEX_HISTORY_HOME_STORAGE_KEY, homeId);
    else window.localStorage.removeItem(CODEX_HISTORY_HOME_STORAGE_KEY);
  } catch {
    // The selector still works for this page if browser storage is unavailable.
  }
}

function codexHistoryDetailCacheKey(homeId: string, threadId: string): string {
  return `${CODEX_HISTORY_DETAIL_CACHE_PREFIX}${encodeURIComponent(homeId)}:${encodeURIComponent(threadId)}`;
}

function readCodexHistoryDetailCache(homeId: string, threadId: string): CodexHistoryDetailResponse | null {
  const key = codexHistoryDetailCacheKey(homeId, threadId);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CodexHistoryDetailCacheEntry;
    const ageMs = Date.now() - entry.cachedAt;
    if (entry.version !== 1 || !Number.isFinite(entry.cachedAt) || ageMs < 0 || ageMs > CODEX_HISTORY_DETAIL_CACHE_TTL_MS
      || entry.detail?.home?.id !== homeId || entry.detail?.thread?.id !== threadId) {
      window.localStorage.removeItem(key);
      return null;
    }
    return entry.detail;
  } catch {
    try { window.localStorage.removeItem(key); } catch { /* Browser storage can be unavailable. */ }
    return null;
  }
}

function writeCodexHistoryDetailCache(detail: CodexHistoryDetailResponse): void {
  const key = codexHistoryDetailCacheKey(detail.home.id, detail.thread.id);
  const cachedDetail: CodexHistoryDetailResponse = {
    ...detail,
    home: { ...detail.home, path: "" },
    // The active workspace is already stored as cwd; avoid retaining the session JSONL path in browser storage.
    thread: detail.thread.cwd ? { ...detail.thread, path: null } : detail.thread,
    imageAttachments: detail.imageAttachments,
  };
  const entry: CodexHistoryDetailCacheEntry = { version: 1, cachedAt: Date.now(), detail: cachedDetail };
  try {
    const encoded = JSON.stringify(entry);
    if (encoded.length > CODEX_HISTORY_DETAIL_CACHE_MAX_CHARS) return;
    window.localStorage.setItem(key, encoded);
    pruneCodexHistoryDetailCache();
  } catch {
    // Large threads or a full browser quota should not block opening history.
  }
}

function removeCodexHistoryDetailCache(homeId: string, threadId: string): void {
  try {
    window.localStorage.removeItem(codexHistoryDetailCacheKey(homeId, threadId));
  } catch {
    // Browser storage is only an optimization.
  }
}

function pruneCodexHistoryDetailCache(): void {
  try {
    const now = Date.now();
    const entries: Array<{ key: string; cachedAt: number }> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(CODEX_HISTORY_DETAIL_CACHE_PREFIX)) continue;
      try {
        const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<CodexHistoryDetailCacheEntry> | null;
        if (!value || value.version !== 1 || typeof value.cachedAt !== "number" || !Number.isFinite(value.cachedAt)
          || now - Number(value.cachedAt) > CODEX_HISTORY_DETAIL_CACHE_TTL_MS) {
          window.localStorage.removeItem(key);
          index -= 1;
          continue;
        }
        entries.push({ key, cachedAt: Number(value.cachedAt) });
      } catch {
        window.localStorage.removeItem(key);
        index -= 1;
      }
    }
    entries.sort((left, right) => right.cachedAt - left.cachedAt);
    for (const entry of entries.slice(CODEX_HISTORY_DETAIL_CACHE_MAX_ENTRIES)) {
      window.localStorage.removeItem(entry.key);
    }
  } catch {
    // Cache eviction is best effort; the history view remains usable without it.
  }
}

const STATUS_LABELS: Record<string, string> = {
  notLoaded: "未加载",
  idle: "已完成",
  active: "运行中",
  systemError: "错误",
};

export function CodexHistory(): ReactElement {
  const navigate = useNavigate();
  const { homeId, threadId } = useParams<{ homeId?: string; threadId?: string }>();
  const [searchParams] = useSearchParams();
  const expectedUpdatedAt = searchParams.get("updatedAt");
  const listCheckedAt = searchParams.get("listCheckedAt");
  const isDetailRoute = Boolean(homeId && threadId);
  const [selectedHome, setSelectedHome] = useState(readStoredCodexHistoryHome);
  const [queryHome, setQueryHome] = useState(readStoredCodexHistoryHome);
  const [draftFilters, setDraftFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<CodexHistoryListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingHomeThreadIds, setSavingHomeThreadIds] = useState<Set<string>>(() => new Set());
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0);

  const rememberHome = useCallback((nextHomeId: string): void => {
    persistCodexHistoryHome(nextHomeId);
    setSelectedHome((current) => current === nextHomeId ? current : nextHomeId);
  }, []);

  const selectListHome = useCallback((nextHomeId: string): void => {
    rememberHome(nextHomeId);
    setQueryHome(nextHomeId);
    setOffset(0);
  }, [rememberHome]);

  useEffect(() => {
    if (isDetailRoute) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchCodexHistory({
      home: queryHome || undefined,
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
        if (controller.signal.aborted) return;
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        if (queryHome && message.includes("找不到 Codex home")) {
          rememberHome("");
          setQueryHome("");
          setError(null);
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, queryHome, offset, isDetailRoute, historyRefreshVersion, rememberHome]);

  const submitFilters = useCallback((event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setOffset(0);
    setQueryHome(selectedHome);
    setFilters({ ...draftFilters });
  }, [draftFilters, selectedHome]);

  const openThread = useCallback((item: CodexHistoryItem): void => {
    const detailHomeId = item.preferredHomeId || item.home.id;
    const path = `/codex-history/${encodeURIComponent(detailHomeId)}/${encodeURIComponent(item.thread.id)}`;
    const params = new URLSearchParams();
    if (detailHomeId === item.home.id) {
      if (typeof item.thread.updatedAt === "number") params.set("updatedAt", String(item.thread.updatedAt));
      if (result?.generatedAt) params.set("listCheckedAt", result.generatedAt);
    }
    const query = params.toString();
    navigate(query ? `${path}?${query}` : path);
  }, [navigate, result?.generatedAt]);

  const saveListItemHome = useCallback(async (item: CodexHistoryItem, nextHomeId: string): Promise<void> => {
    const currentHomeId = item.preferredHomeId || item.home.id;
    if (nextHomeId === currentHomeId) return;
    setSavingHomeThreadIds((current) => new Set(current).add(item.thread.id));
    setError(null);
    try {
      const saved = await updateCodexThreadHomePreference(item.thread.id, nextHomeId);
      setResult((current) => {
        if (!current) return current;
        const remappedItems = current.items.map((candidate) => candidate.thread.id === item.thread.id
          ? { ...candidate, preferredHomeId: saved.preferredHomeId }
          : candidate);
        const items = queryHome
          ? remappedItems.filter((candidate) => (candidate.preferredHomeId || candidate.home.id) === queryHome)
          : remappedItems;
        const removedCount = current.items.length - items.length;
        return { ...current, items, total: Math.max(0, current.total - removedCount) };
      });
      setHistoryRefreshVersion((current) => current + 1);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingHomeThreadIds((current) => {
        const next = new Set(current);
        next.delete(item.thread.id);
        return next;
      });
    }
  }, [queryHome]);

  const switchThreadHome = useCallback(async (nextHomeId: string): Promise<void> => {
    if (!threadId) return;
    await updateCodexThreadHomePreference(threadId, nextHomeId);
    navigate(`/codex-history/${encodeURIComponent(nextHomeId)}/${encodeURIComponent(threadId)}`);
  }, [navigate, threadId]);

  const backToHistoryList = useCallback((): void => {
    setQueryHome(selectedHome);
    setOffset(0);
    navigate("/codex-history");
  }, [navigate, selectedHome]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));
  const homes = result?.homes ?? [];

  if (isDetailRoute) {
    return (
      <CodexThreadPage
        homeId={homeId!}
        threadId={threadId!}
        expectedUpdatedAt={expectedUpdatedAt}
        listCheckedAt={listCheckedAt}
        onBack={backToHistoryList}
        onSwitchHome={switchThreadHome}
      />
    );
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
          <select aria-label="Codex账户" value={selectedHome} onChange={(event) => selectListHome(event.target.value)}>
            <option value="">Codex账户</option>
            {homes.map((home) => (
              <option key={home.id} value={home.id} disabled={!home.available}>
                {home.label}{home.available ? "" : "（不可用）"}
              </option>
            ))}
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
          {!error && loading ? <div className="empty">正在读取{selectedHome ? "此 Codex Home" : "所有 Codex Home"}的会话…</div> : null}
          {!error && !loading && result?.items.length === 0 ? <div className="empty">没有符合条件的 Codex 会话。</div> : null}
          {result?.items.map((item) => (
            <CodexHistoryRow
              key={`${item.home.id}:${item.thread.id}`}
              item={item}
              homes={homes}
              savingHome={savingHomeThreadIds.has(item.thread.id)}
              onOpen={openThread}
              onSwitchHome={saveListItemHome}
            />
          ))}
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

function CodexHistoryRow({
  item,
  homes,
  savingHome,
  onOpen,
  onSwitchHome,
}: {
  item: CodexHistoryItem;
  homes: CodexHistoryHome[];
  savingHome: boolean;
  onOpen: (item: CodexHistoryItem) => void;
  onSwitchHome: (item: CodexHistoryItem, nextHomeId: string) => Promise<void>;
}): ReactElement {
  const { thread, home } = item;
  const title = thread.name?.trim() || thread.preview?.trim() || "（无标题）";
  const preferredHomeId = item.preferredHomeId || home.id;
  return (
    <article className="codex-history-row">
      <button className="codex-history-row-open" type="button" disabled={savingHome} onClick={() => onOpen(item)}>
        <div className="codex-history-row-main">
          <div className="codex-thread-title">{title}</div>
          <div className="guid">{thread.id}</div>
        </div>
        <div className="codex-thread-path" title={thread.cwd || thread.path || ""}>{thread.cwd || thread.path || "—"}</div>
      </button>
      <div className="codex-history-row-meta">
        <span className="badge codex-status-badge">{statusLabel(thread)}</span>
        <select
          className="codex-history-row-home-switch"
          aria-label={`切换“${title}”所在的 Codex Home`}
          title="修改此会话使用的 Home；不会改变顶部账户筛选"
          value={preferredHomeId}
          disabled={savingHome}
          onChange={(event) => { void onSwitchHome(item, event.target.value); }}
        >
          {!homes.some((option) => option.id === preferredHomeId) ? (
            <option value={preferredHomeId}>
              {preferredHomeId === home.id ? home.label : "已保存 Home（当前不可用）"}
            </option>
          ) : null}
          {homes.map((option) => (
            <option key={option.id} value={option.id} disabled={!option.available}>
              {option.label}{option.available ? "" : "（不可用）"}
            </option>
          ))}
        </select>
        <span>{sourceLabel(thread)}</span>
        <span>{formatCodexTime(thread.updatedAt ?? thread.recencyAt ?? thread.createdAt)}</span>
      </div>
    </article>
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

function CodexThreadPage({ homeId, threadId, expectedUpdatedAt, listCheckedAt, onBack, onSwitchHome }: {
  homeId: string;
  threadId: string;
  expectedUpdatedAt: string | null;
  listCheckedAt: string | null;
  onBack: () => void;
  onSwitchHome: (homeId: string) => Promise<void>;
}): ReactElement {
  return (
    <main className="page-main codex-thread-page codex-thread-page-shell">
      <CodexThreadDetail
        homeId={homeId}
        threadId={threadId}
        expectedUpdatedAt={expectedUpdatedAt}
        listCheckedAt={listCheckedAt}
        onBack={onBack}
        onSwitchHome={onSwitchHome}
      />
    </main>
  );
}

function CodexThreadDetail({ homeId, threadId, expectedUpdatedAt, listCheckedAt, onBack, onSwitchHome }: {
  homeId: string;
  threadId: string;
  expectedUpdatedAt: string | null;
  listCheckedAt: string | null;
  onBack: () => void;
  onSwitchHome: (homeId: string) => Promise<void>;
}): ReactElement {
  const [detail, setDetail] = useState<CodexHistoryDetailResponse | null>(null);
  const [homes, setHomes] = useState<CodexHistoryHome[]>([]);
  const [homesLoading, setHomesLoading] = useState(true);
  const [homeSwitching, setHomeSwitching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<LiveThreadRun | null>(null);
  const [imagePreviews, setImagePreviews] = useState<Record<number, CodexImagePreview[]>>({});
  const [filePreviewTarget, setFilePreviewTarget] = useState<CodexFilePreviewTarget | null>(null);
  const [writerStatus, setWriterStatus] = useState<CodexHistoryWriterStatus | null>(null);
  const liveCursorRef = useRef(0);

  const changeThreadHome = useCallback(async (nextHomeId: string): Promise<void> => {
    if (nextHomeId === homeId || homeSwitching) return;
    setHomeSwitching(true);
    try {
      await onSwitchHome(nextHomeId);
    } catch (switchError: unknown) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setHomeSwitching(false);
    }
  }, [homeId, homeSwitching, onSwitchHome]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCodexHistoryHomes(controller.signal)
      .then((nextHomes) => {
        if (!controller.signal.aborted) setHomes(nextHomes);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setHomesLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const cachedDetail = readCodexHistoryDetailCache(homeId, threadId);
    const listUpdatedAt = expectedUpdatedAt === null ? Number.NaN : Number(expectedUpdatedAt);
    const listCheckedAtMs = listCheckedAt === null ? Number.NaN : Date.parse(listCheckedAt);
    const cacheMatchesFreshList = Boolean(cachedDetail)
      && Number.isFinite(listUpdatedAt)
      && cachedDetail?.thread.updatedAt === listUpdatedAt
      && Number.isFinite(listCheckedAtMs)
      && Date.now() >= listCheckedAtMs
      && Date.now() - listCheckedAtMs <= CODEX_HISTORY_LIST_VERSION_MAX_AGE_MS;
    setLoading(!cachedDetail);
    setError(null);
    setDetail(cachedDetail);
    setImagePreviews(buildTurnImagePreviews(homeId, threadId, cachedDetail?.imageAttachments ?? []));
    setFilePreviewTarget(null);
    if (cacheMatchesFreshList) {
      return () => controller.abort();
    }
    void fetchCodexThreadDetail(homeId, threadId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          const cachedTurns = cachedDetail?.thread.turns;
          const nextTurns = next.thread.turns;
          const sameVersion = typeof cachedDetail?.thread.updatedAt === "number"
            && cachedDetail.thread.updatedAt === next.thread.updatedAt
            && (Array.isArray(cachedTurns) ? cachedTurns.length : 0) === (Array.isArray(nextTurns) ? nextTurns.length : 0);
          setDetail(sameVersion && cachedDetail ? { ...next, thread: cachedDetail.thread } : next);
          setImagePreviews(buildTurnImagePreviews(homeId, threadId, next.imageAttachments ?? []));
          writeCodexHistoryDetailCache(next);
        }
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [homeId, threadId, expectedUpdatedAt, listCheckedAt]);

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
            ? { ...current, state: localRun.state, cursor: Math.max(current.cursor, localRun.cursor), turnIndex: localRun.turnIndex }
            : {
                runId: localRun.runId,
                threadId: localRun.threadId,
                userText: localRun.userText,
                state: localRun.state,
                cursor: localRun.cursor,
                turnIndex: localRun.turnIndex,
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
  const liveRunTurnIndex = liveRun?.turnIndex;
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
          setLiveRun((current) => current?.runId === next.runId
            ? { ...current, items: [], ...(next.usage ? { usage: next.usage } : {}) }
            : current);
        } else {
          setLiveRun((current) => current?.runId === next.runId
            ? {
                ...current,
                state: next.state,
                cursor: next.cursor,
                items: mergeLiveItems(current.items, next.events),
                ...(next.usage ? { usage: next.usage } : {}),
              }
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
          writeCodexHistoryDetailCache(refreshed);
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
  }, [homeId, threadId, liveRunId, liveRunTurnIndex]);

  const thread = detail?.thread ?? { id: threadId };
  const title = thread.name?.trim() || thread.preview?.trim() || "（无标题）";
  const homeLabel = detail?.home.label ?? "Codex home";
  const homeOptions = homes.some((home) => home.id === homeId)
    ? homes
    : [detail?.home ?? { id: homeId, label: homeLabel, path: "", available: true }, ...homes];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const liveTurns = liveRun ? [{
    items: [
      { type: "userMessage", text: liveRun.userText || "（已发送附件）" },
      ...liveRun.items,
    ],
    ...(liveRun.usage ? { usage: liveRun.usage } : {}),
  }] : [];
  const turnUsages = useMemo<Record<number, CodexHistoryTurnUsage>>(() => {
    const result: Record<number, CodexHistoryTurnUsage> = {};
    for (const { turnIndex, usage } of detail?.turnUsages ?? []) result[turnIndex] = usage;
    return result;
  }, [detail?.turnUsages]);
  const displayedTurnCount = turns.length + (liveRun ? 1 : 0);
  const busyInOtherLocation = writerStatus?.state === "busy"
    && !writerStatus.localRun
    && !isLiveRunActive(liveRun?.state);
  const openFilePreview = useCallback((target: CodexFileLinkTarget): void => {
    if ("outside" in target) {
      setError("此文件链接不在当前 Codex session 的工作目录内，无法在此预览。");
      return;
    }
    setError(null);
    setFilePreviewTarget(target);
  }, []);
  const markdownLinkContext = useMemo<CodexMarkdownLinkContextValue>(() => ({
    rootPath: thread.cwd ?? "",
    onOpenFile: openFilePreview,
  }), [openFilePreview, thread.cwd]);

  const submitMessage = useCallback(async (
    text: string,
    attachmentIds: string[],
    settings: CodexHistoryComposerSettings,
  ): Promise<{ ok: boolean; message?: string }> => {
    try {
      const result = await sendCodexThreadMessage(homeId, threadId, {
        text,
        attachmentIds,
        turnIndex: turns.length,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
      });
      removeCodexHistoryDetailCache(homeId, threadId);
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
        turnIndex: result.turnIndex,
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
    <CODEX_MARKDOWN_LINK_CONTEXT.Provider value={markdownLinkContext}>
      <section className="codex-thread-panel" aria-labelledby="codex-thread-title">
      <div className="codex-thread-view-head">
        <button className="codex-thread-back" type="button" onClick={onBack} aria-label="返回会话列表" title="返回会话列表">‹</button>
        <div className="codex-thread-view-content">
          <div className="codex-thread-view-heading">
            <strong id="codex-thread-title" title={title}>{title}</strong>
            <select
              className="codex-thread-home-switch"
              aria-label="切换 Codex Home"
              title="切换 Codex Home"
              value={homeId}
              disabled={homesLoading || homeSwitching || homeOptions.length < 2}
              onChange={(event) => { void changeThreadHome(event.target.value); }}
            >
              {homeOptions.map((home) => (
                <option key={home.id} value={home.id} disabled={!home.available}>{home.label}</option>
              ))}
            </select>
            <span>{loading ? "" : `${displayedTurnCount} 轮${liveRun?.state === "running" ? " · 正在运行" : liveRun?.state === "cancelling" ? " · 正在中断" : ""}`}</span>
            <CodexThreadInfo thread={thread} homeLabel={homeLabel} />
          </div>
          {busyInOtherLocation ? (
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
          {error ? (
            <div className="codex-thread-error" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="关闭错误信息" title="关闭" onClick={() => setError(null)}>×</button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="codex-thread-view-body">
        <div className="codex-thread-transcript">
          {loading ? <div className="empty">正在读取会话详情…</div> : null}
          {!loading && !error && detail !== null && turns.length === 0 && !liveRun ? <div className="empty">该会话没有可展示的轮次。</div> : null}
          {!loading && (turns.length > 0 || liveRun) ? <CodexAssistantTranscript thread={thread} extraTurns={liveTurns} imagePreviews={imagePreviews} turnUsages={turnUsages} /> : null}
        </div>
        <div className="codex-history-composer-slot" hidden={busyInOtherLocation}>
          <CodexHistoryMessageComposer
            disabled={loading || !detail}
            sendDisabled={writerStatus === null || (writerStatus.state === "busy" && !writerStatus.localRun) || isLiveRunActive(liveRun?.state)}
            sending={isLiveRunActive(liveRun?.state)}
            cancelling={liveRun?.state === "cancelling"}
            placeholder="发送消息到当前 Codex session…"
            settingsScopeKey={`${homeId}:${threadId}`}
            models={detail?.models ?? []}
            modelCatalogAvailable={detail?.models !== undefined}
            currentModel={thread.model}
            currentReasoningEffort={thread.reasoningEffort}
            onSubmit={submitMessage}
            onInterrupt={() => void interruptRun()}
            onAttachmentError={(message) => setError(message)}
            onScrollToTop={() => scrollCodexTranscript("top")}
            onScrollToBottom={() => scrollCodexTranscript("bottom")}
          />
        </div>
      </div>
      {filePreviewTarget ? (
        <CodexFilePreviewDialog
          key={`${filePreviewTarget.relativePath}:${filePreviewTarget.lineNumber ?? ""}`}
          homeId={homeId}
          threadId={threadId}
          rootPath={thread.cwd ?? ""}
          target={filePreviewTarget}
          onClose={() => setFilePreviewTarget(null)}
        />
      ) : null}
      </section>
    </CODEX_MARKDOWN_LINK_CONTEXT.Provider>
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
  turnIndex: number;
  items: unknown[];
  usage?: CodexHistoryTurnUsage;
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
  usage?: CodexHistoryTurnUsage;
}

type CodexMessagePart = Exclude<ThreadMessageLike["content"], string>[number];

function CodexAssistantTranscript({
  thread,
  extraTurns = [],
  imagePreviews = {},
  turnUsages = {},
}: {
  thread: CodexThread;
  extraTurns?: unknown[];
  imagePreviews?: Record<number, CodexImagePreview[]>;
  turnUsages?: Record<number, CodexHistoryTurnUsage>;
}): ReactElement {
  const messages = useMemo(
    () => buildCodexMessages(thread, extraTurns, imagePreviews, turnUsages),
    [thread, extraTurns, imagePreviews, turnUsages],
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
  return <div className="codex-assistant-markdown"><CodexMarkdown text={text} /></div>;
}

const CODEX_MARKDOWN_COMPONENTS: Components = {
  table: ({ node, ...props }) => {
    void node;
    return <div className="codex-markdown-table-scroll"><table {...props} /></div>;
  },
};

function resolveCodexFileLink(href: string, rootPath: string): CodexFileLinkTarget | null {
  let value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin) return null;
      value = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  } else if (/^(mailto|tel|javascript|data|file):/i.test(value)) {
    return null;
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
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep literal percent characters when the href is not URI-encoded.
  }
  value = value.replaceAll("\\", "/");
  const lineSuffix = /:(\d+)(?::\d+)?$/.exec(value);
  if (lineSuffix) {
    lineNumber ??= Number(lineSuffix[1]);
    value = value.slice(0, lineSuffix.index);
  }

  const normalizedRoot = rootPath.replaceAll("\\", "/").replace(/\/+$/, "");
  let pathParts: string[];
  if (normalizedRoot && value === normalizedRoot) return { outside: true };
  if (normalizedRoot && value.startsWith(`${normalizedRoot}/`)) {
    value = value.slice(normalizedRoot.length + 1);
    pathParts = [];
  } else if (value.startsWith("/")) {
    return /^\/(Users|private|home|tmp|var|opt|Volumes)\//.test(value) ? { outside: true } : null;
  } else {
    if (!normalizedRoot) return { outside: true };
    pathParts = [];
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
  if (pathParts.length === 0) return { outside: true };
  return { relativePath: pathParts.join("/"), ...(lineNumber ? { lineNumber } : {}) };
}

function CodexMarkdown({ text }: { text: string }): ReactElement {
  const linkContext = useContext(CODEX_MARKDOWN_LINK_CONTEXT);
  const components = useMemo<Components>(() => ({
    ...CODEX_MARKDOWN_COMPONENTS,
    a: ({ node, href, children, ...props }) => {
      void node;
      const target = typeof href === "string" && linkContext
        ? resolveCodexFileLink(href, linkContext.rootPath)
        : null;
      return (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            if (!target || !linkContext) return;
            event.preventDefault();
            linkContext.onOpenFile(target);
          }}
        >{children}</a>
      );
    },
  }), [linkContext]);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

const CODEX_FILE_IMAGE_EXTENSIONS = new Set(["apng", "avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);

function codexFilePreviewUrl(homeId: string, threadId: string, relativePath: string): string {
  const url = new URL(
    `/api/codex/threads/${encodeURIComponent(homeId)}/${encodeURIComponent(threadId)}/files/preview`,
    window.location.origin,
  );
  url.searchParams.set("path", relativePath);
  return url.pathname + url.search;
}

function CodexFilePreviewDialog({
  homeId,
  threadId,
  rootPath,
  target,
  onClose,
}: {
  homeId: string;
  threadId: string;
  rootPath: string;
  target: CodexFilePreviewTarget;
  onClose: () => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const previewUrl = codexFilePreviewUrl(homeId, threadId, target.relativePath);
  const fileName = target.relativePath.split("/").filter(Boolean).at(-1) ?? target.relativePath;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const isImage = CODEX_FILE_IMAGE_EXTENSIONS.has(extension);

  useEffect(() => {
    if (isImage) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch(previewUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error || `请求失败：${response.status}`);
        }
        return response.text();
      })
      .then((contents) => {
        if (!controller.signal.aborted) setText(contents);
      })
      .catch((previewError: unknown) => {
        if (!controller.signal.aborted) setError(previewError instanceof Error ? previewError.message : "读取文件失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isImage, previewUrl]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const absolutePath = `${rootPath.replace(/[\\/]+$/, "")}/${target.relativePath}`;
  return (
    <div className="codex-file-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="codex-file-preview" role="dialog" aria-modal="true" aria-label={`预览 ${fileName}`}>
        <header>
          <div><strong title={absolutePath}>{fileName}{target.lineNumber ? `:${target.lineNumber}` : ""}</strong><small title={absolutePath}>{absolutePath}</small></div>
          <button type="button" onClick={onClose} aria-label="关闭文件预览">×</button>
        </header>
        <div className="codex-file-preview-body">
          {loading ? <div className="empty">正在读取文件…</div> : null}
          {error ? <div className="codex-file-preview-error" role="alert">{error}</div> : null}
          {!loading && !error && isImage ? <img src={previewUrl} alt={fileName} onError={() => setError("无法读取图片文件。")} /> : null}
          {!loading && !error && !isImage && (extension === "md" || extension === "markdown") ? (
            <div className="codex-file-preview-markdown codex-assistant-markdown"><CodexMarkdown text={text} /></div>
          ) : null}
          {!loading && !error && !isImage && extension !== "md" && extension !== "markdown" ? (
            <CodeTextViewer fileName={fileName} text={text} lineNumber={target.lineNumber} />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CodexProcessPart({ data }: { data: CodexProcessPayload }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const eventCount = groups.reduce((count, group) => count
    + (group.summary ? 1 : 0)
    + group.commands.length
    + group.other.length, 0);
  const hasDuration = typeof data.durationMs === "number";
  return (
    <>
      {eventCount > 0 || hasDuration ? (
        <div className="codex-assistant-process-row">
          {eventCount > 0 ? (
            <button
              className="codex-assistant-process-toggle"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              <span className={`codex-process-chevron${expanded ? " is-open" : ""}`} aria-hidden="true">›</span>
              <strong>过程回放</strong>
              <span>{eventCount} 个事件</span>
            </button>
          ) : null}
          {hasDuration ? <span className="codex-assistant-duration">用时 {formatDuration(data.durationMs!)}</span> : null}
        </div>
      ) : null}
      {expanded && groups.length > 0 ? (
        <div className="codex-assistant-process-list">
          {groups.map((group, index) => <CodexProcessGroupView key={`process-group-${index}`} group={group} />)}
        </div>
      ) : null}
      {data.usage ? <div className="codex-assistant-usage" title="本轮 Codex Token 用量">{formatTokenUsage(data.usage)}</div> : null}
    </>
  );
}

function CodexProcessGroupView({ group }: { group: CodexProcessGroup }): ReactElement {
  return (
    <section className="codex-assistant-process-group">
      {group.summary ? <div className="codex-assistant-reasoning"><CodexMarkdown text={group.summary.text} /></div> : null}
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
  turnUsages: Record<number, CodexHistoryTurnUsage> = {},
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
    const usage = parseTurnUsage(record.usage)
      ?? parseTurnUsage(record.tokenUsage)
      ?? turnUsages[turnIndex];
    if (processItems.length > 0 || durationMs !== null || usage) {
      content.push({
        type: "data-codex-process",
        data: {
          groups: buildCodexProcessGroups(processItems),
          ...(durationMs === null ? {} : { durationMs }),
          ...(usage ? { usage } : {}),
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

function parseTurnUsage(value: unknown): CodexHistoryTurnUsage | null {
  const record = asRecord(value);
  const usage = Object.keys(asRecord(record.last)).length > 0 ? asRecord(record.last) : record;
  const inputTokens = finiteNumber(usage.inputTokens ?? usage.input_tokens);
  const cachedInputTokens = finiteNumber(usage.cachedInputTokens ?? usage.cached_input_tokens);
  const outputTokens = finiteNumber(usage.outputTokens ?? usage.output_tokens);
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null
    || inputTokens < 0 || cachedInputTokens < 0 || outputTokens < 0) return null;
  const reasoningOutputTokens = finiteNumber(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(reasoningOutputTokens === null ? {} : { reasoningOutputTokens }),
  };
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

function formatTokenUsage(usage: CodexHistoryTurnUsage): string {
  // Match Codex CLI's blended total: uncached input plus output, with cached input shown separately.
  const freshInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const totalTokens = freshInputTokens + usage.outputTokens;
  const reasoning = usage.reasoningOutputTokens === undefined
    ? "未知"
    : formatTokenCount(usage.reasoningOutputTokens);
  return `总计=${formatTokenCount(totalTokens)} 输入=${formatTokenCount(freshInputTokens)}（+ ${formatTokenCount(usage.cachedInputTokens)} 缓存） 输出=${formatTokenCount(usage.outputTokens)}（推理 ${reasoning}）`;
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
