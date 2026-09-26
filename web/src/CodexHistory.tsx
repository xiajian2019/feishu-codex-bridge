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
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "react-router";

import { fetchCodexHistory, fetchCodexThreadDetail } from "./api.js";
import {
  CODEX_THREAD_STATUS_TYPES,
  type CodexHistoryDetailResponse,
  type CodexHistoryItem,
  type CodexHistoryListResponse,
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
          {error ? <div className="error">{error}</div> : null}
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
    <main className="page-main codex-thread-page">
      <CodexThreadDetail homeId={homeId} threadId={threadId} onBack={onBack} />
    </main>
  );
}

function CodexThreadDetail({ homeId, threadId, onBack }: { homeId: string; threadId: string; onBack: () => void }): ReactElement {
  const [detail, setDetail] = useState<CodexHistoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchCodexThreadDetail(homeId, threadId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setDetail(next);
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [homeId, threadId]);

  const thread = detail?.thread ?? { id: threadId };
  const title = thread.name?.trim() || thread.preview?.trim() || "（无标题）";
  const homeLabel = detail?.home.label ?? "Codex home";
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return (
    <section className="codex-thread-panel" aria-labelledby="codex-thread-title">
      <div className="codex-thread-view-head">
        <button className="codex-thread-back" type="button" onClick={onBack} aria-label="返回会话列表" title="返回会话列表">‹</button>
        <div className="codex-thread-view-heading">
          <strong id="codex-thread-title" title={title}>{title}</strong>
          <span>{loading ? "" : `${turns.length} 轮`}</span>
        </div>
      </div>
      <div className="codex-thread-view-body">
        {error ? <div className="error">{error}</div> : null}
        {loading ? <div className="empty">正在读取会话详情…</div> : null}
        {!loading && turns.length === 0 ? <div className="empty">该会话没有可展示的轮次。</div> : null}
        {!loading && turns.length > 0 ? <CodexAssistantTranscript thread={thread} /> : null}
        <details className="codex-thread-meta">
          <summary>会话信息</summary>
          <div className="grid codex-thread-facts">
            <Metric label="标题">{thread.name?.trim() || thread.preview?.trim() || "（无标题）"}</Metric>
            <Metric label="Codex home">{homeLabel}</Metric>
            <Metric label="状态"><span className="badge codex-status-badge">{statusLabel(thread)}</span></Metric>
            <Metric label="来源">{sourceLabel(thread)}</Metric>
            <Metric label="创建时间">{formatCodexTime(thread.createdAt)}</Metric>
            <Metric label="更新时间">{formatCodexTime(thread.updatedAt ?? thread.recencyAt)}</Metric>
            <Metric label="模型">{thread.modelProvider || "—"}{thread.model ? ` / ${thread.model}` : ""}</Metric>
            <Metric label="工作目录" mono>{thread.cwd || thread.path || "—"}</Metric>
            <Metric label="Thread" mono>{thread.id}</Metric>
          </div>
        </details>
      </div>
    </section>
  );
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

function CodexAssistantTranscript({ thread }: { thread: CodexThread }): ReactElement {
  const messages = useMemo(() => buildCodexMessages(thread), [thread]);
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
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
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

function buildCodexMessages(thread: CodexThread): ThreadMessageLike[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const messages: ThreadMessageLike[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const record = asRecord(turn);
    const items = Array.isArray(record.items) ? record.items : [];
    const userItems = items.filter((item) => itemType(item) === "userMessage");
    const assistantItems = items.filter((item) => itemType(item) === "agentMessage" || itemType(item) === "assistantMessage");
    const processItems = items.filter((item) => !isAssistantUiMessage(item));

    userItems.forEach((item, itemIndex) => {
      messages.push({
        id: `${thread.id}-turn-${turnIndex}-user-${itemIndex}`,
        role: "user",
        content: [{ type: "text", text: formatCodexItem(item, "userMessage") }],
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
    } else if (type === "commandExecution") {
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
  const type = itemType(item);
  return type === "userMessage" || type === "agentMessage" || type === "assistantMessage";
}

function Metric({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }): ReactElement {
  return <div className={`metric${mono ? " metric-mono" : ""}`}><small>{label}</small>{children}</div>;
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
  if (type === "commandExecution" && typeof record.command === "string") parts.push(`$ ${record.command}`);
  for (const key of ["text", "summary", "content", "aggregatedOutput", "output", "error"]) {
    const value = record[key];
    const text = flattenText(value);
    if (text) parts.push(text);
  }
  if (parts.length > 0) return parts.join("\n\n");
  if (typeof record.message === "string" && record.message) return record.message;
  return "（无文本输出）";
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
