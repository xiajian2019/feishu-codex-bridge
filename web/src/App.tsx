import {
  memo,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  fetchTaskDetail,
  fetchTasks,
  postTaskAction,
  subscribeToChanges,
  type EventStreamStatus,
} from "./api.js";
import {
  TASK_STATES,
  type DashboardChange,
  type StoredRun,
  type StoredRunEvent,
  type TaskDetailResponse,
  type TaskListResponse,
  type TaskSummary,
} from "./types.js";

const PAGE_SIZE = 50;

interface Filters {
  q: string;
  state: string;
  project: string;
  mode: string;
}

interface TaskListItem extends TaskSummary {
  latest_run: StoredRun | null;
}

const EMPTY_FILTERS: Filters = { q: "", state: "", project: "", mode: "" };

export function App(): ReactElement {
  const [draftFilters, setDraftFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<TaskListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [filterOptions, setFilterOptions] = useState<TaskListResponse["filters"]>({
    states: [...TASK_STATES],
    projects: [],
    modes: [],
  });
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [streamStatus, setStreamStatus] = useState<EventStreamStatus>("connecting");
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [busyAction, setBusyAction] = useState<"interrupt" | "feedback" | null>(null);

  const listAbortRef = useRef<AbortController | null>(null);
  const listRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedGuidRef = useRef<string | null>(null);

  useEffect(() => {
    selectedGuidRef.current = selectedGuid;
  }, [selectedGuid]);

  const loadTasks = useCallback(async (quiet = false): Promise<void> => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    if (!quiet) setListLoading(true);
    setListError(null);
    try {
      const data = await fetchTasks(
        {
          ...appliedFilters,
          limit: PAGE_SIZE,
          offset,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setItems((previous) => mergeTaskItems(previous, data.items));
      setTotal(data.total);
      setFilterOptions(data.filters);
      setLastUpdated(new Date());
    } catch (error) {
      if (controller.signal.aborted) return;
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setListLoading(false);
    }
  }, [appliedFilters, offset]);

  useEffect(() => {
    void loadTasks();
    return () => listAbortRef.current?.abort();
  }, [loadTasks]);

  const scheduleListRefresh = useCallback((): void => {
    if (listRefreshTimerRef.current) clearTimeout(listRefreshTimerRef.current);
    listRefreshTimerRef.current = setTimeout(() => {
      listRefreshTimerRef.current = null;
      void loadTasks(true);
    }, 500);
  }, [loadTasks]);

  useEffect(() => () => {
    if (listRefreshTimerRef.current) clearTimeout(listRefreshTimerRef.current);
  }, []);

  const applyChange = useCallback((change: DashboardChange): void => {
    if (!change.task) return;
    const nextItem: TaskListItem = {
      ...change.task,
      latest_run: change.latest_run,
    };
    setItems((previous) => {
      const index = previous.findIndex((item) => item.task_guid === nextItem.task_guid);
      if (index < 0) return previous;
      if (taskItemEqual(previous[index], nextItem)) return previous;
      const next = previous.slice();
      next[index] = nextItem;
      return next;
    });
    if (selectedGuidRef.current === change.task.task_guid) {
      setDetail((previous) => previous ? mergeDetailChange(previous, change) : previous);
    }
    setLastUpdated(new Date());
    scheduleListRefresh();
  }, [scheduleListRefresh]);

  useEffect(() => subscribeToChanges(applyChange, setStreamStatus), [applyChange]);

  useEffect(() => {
    if (streamStatus === "connected") void loadTasks(true);
  }, [loadTasks, streamStatus]);

  useEffect(() => {
    if (streamStatus === "connected") return;
    const timer = setInterval(() => {
      void loadTasks(true);
      if (selectedGuidRef.current) setDetailRefresh((value) => value + 1);
    }, 10_000);
    return () => clearInterval(timer);
  }, [loadTasks, streamStatus]);

  useEffect(() => {
    if (!selectedGuid) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    void fetchTaskDetail(selectedGuid, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDetail(data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedGuid, detailRefresh]);

  const openDetail = useCallback((taskGuid: string): void => {
    setSelectedGuid(taskGuid);
    setDetail(null);
    setDetailError(null);
    setFeedback("");
    setBusyAction(null);
  }, []);

  const closeDetail = useCallback((): void => {
    setSelectedGuid(null);
    setDetail(null);
    setDetailError(null);
    setFeedback("");
    setBusyAction(null);
  }, []);

  const refreshDetail = useCallback((): void => {
    if (feedback.trim()) {
      window.alert("请先提交或复制补充内容，再刷新详情。");
      return;
    }
    setDetailRefresh((value) => value + 1);
  }, [feedback]);

  const handleInterrupt = useCallback(async (): Promise<void> => {
    if (!selectedGuid || busyAction) return;
    if (!window.confirm("确认中断该任务当前执行？")) return;
    setBusyAction("interrupt");
    try {
      await postTaskAction(selectedGuid, "interrupt");
      setDetailRefresh((value) => value + 1);
      void loadTasks(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, loadTasks, selectedGuid]);

  const handleFeedback = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const details = feedback.trim();
    if (!selectedGuid || !details || busyAction) return;
    setBusyAction("feedback");
    try {
      await postTaskAction(selectedGuid, "feedback", details);
      setFeedback("");
      setDetailRefresh((value) => value + 1);
      void loadTasks(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, feedback, loadTasks, selectedGuid]);

  const submitFilters = useCallback((event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setOffset(0);
    setAppliedFilters({ ...draftFilters });
  }, [draftFilters]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const streamLabel = streamStatus === "connected"
    ? "实时连接"
    : streamStatus === "connecting" ? "连接中" : "轮询兜底";

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Bridge Task Desk</h1>
          <div className="subtitle">飞书任务、Codex 线程与实时执行进展的本地介入视图</div>
        </div>
        <div className={`live live-${streamStatus}`}>
          <span>{streamLabel}</span>
          <span className="muted">{lastUpdated ? lastUpdated.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
        </div>
      </header>

      <main className="page-main">
        <form className="filters" onSubmit={submitFilters}>
          <input
            aria-label="搜索任务"
            type="search"
            placeholder="搜索标题、描述、GUID、thread 或错误"
            value={draftFilters.q}
            onChange={(event) => setDraftFilters((value) => ({ ...value, q: event.target.value }))}
          />
          <Select
            ariaLabel="状态"
            value={draftFilters.state}
            placeholder="全部状态"
            options={filterOptions.states}
            onChange={(value) => setDraftFilters((current) => ({ ...current, state: value }))}
          />
          <Select
            ariaLabel="项目"
            value={draftFilters.project}
            placeholder="全部项目"
            options={filterOptions.projects}
            onChange={(value) => setDraftFilters((current) => ({ ...current, project: value }))}
          />
          <Select
            ariaLabel="模式"
            value={draftFilters.mode}
            placeholder="全部模式"
            options={filterOptions.modes}
            onChange={(value) => setDraftFilters((current) => ({ ...current, mode: value }))}
          />
          <button className="primary" type="submit">查询</button>
        </form>

        <div className="summary">
          <span>
            {listLoading ? "正在加载…" : `共 ${total} 个任务，当前显示 ${items.length ? offset + 1 : 0}–${Math.min(offset + items.length, total)}`}
          </span>
          <div className="pagination">
            <button type="button" disabled={offset === 0 || listLoading} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>上一页</button>
            <span>第 {page} / {pageCount} 页</span>
            <button type="button" disabled={offset + PAGE_SIZE >= total || listLoading} onClick={() => setOffset((value) => value + PAGE_SIZE)}>下一页</button>
            <button type="button" disabled={listLoading} onClick={() => void loadTasks()}>刷新</button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>任务</th><th>状态 / 进展</th><th>项目 / 模式</th><th>最近运行</th><th>Thread</th><th>更新时间</th></tr>
            </thead>
            <tbody>
              {items.map((item) => <TaskRow key={item.task_guid} item={item} onOpen={openDetail} />)}
            </tbody>
          </table>
          {listError ? <div className="error">{listError}</div> : !listLoading && items.length === 0 ? <div className="empty">没有符合条件的任务</div> : null}
        </div>
      </main>

      {selectedGuid ? (
        <TaskDetailDialog
          detail={detail}
          selectedGuid={selectedGuid}
          loading={detailLoading}
          error={detailError}
          feedback={feedback}
          busyAction={busyAction}
          onFeedbackChange={setFeedback}
          onClose={closeDetail}
          onRefresh={refreshDetail}
          onInterrupt={() => void handleInterrupt()}
          onFeedbackSubmit={(event) => void handleFeedback(event)}
        />
      ) : null}
    </>
  );
}

interface SelectProps {
  ariaLabel: string;
  value: string;
  placeholder: string;
  options: string[];
  onChange: (value: string) => void;
}

function Select({ ariaLabel, value, placeholder, options, onChange }: SelectProps): ReactElement {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

const TaskRow = memo(function TaskRow({ item, onOpen }: { item: TaskListItem; onOpen: (guid: string) => void }): ReactElement {
  return (
    <tr className="task-row" onClick={() => onOpen(item.task_guid)}>
      <td>
        <div className="title">{item.input?.summary || "（无标题）"}</div>
        <div className="guid">{item.task_guid}</div>
      </td>
      <td>
        <Badge state={item.state} />
        <ProgressText text={item.progress_text} />
      </td>
      <td>{item.project_key}<div className="muted">{item.mode}</div></td>
      <td>
        {item.latest_run ? <><Badge state={item.latest_run.state} /><div className="guid">{item.latest_run.run_id}</div></> : "—"}
      </td>
      <td className="guid">{item.thread_id || "—"}</td>
      <td>{formatTime(item.updated_at)}</td>
    </tr>
  );
});

interface TaskDetailDialogProps {
  detail: TaskDetailResponse | null;
  selectedGuid: string;
  loading: boolean;
  error: string | null;
  feedback: string;
  busyAction: "interrupt" | "feedback" | null;
  onFeedbackChange: (value: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  onInterrupt: () => void;
  onFeedbackSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const TaskDetailDialog = memo(function TaskDetailDialog({
  detail,
  selectedGuid,
  loading,
  error,
  feedback,
  busyAction,
  onFeedbackChange,
  onClose,
  onRefresh,
  onInterrupt,
  onFeedbackSubmit,
}: TaskDetailDialogProps): ReactElement {
  const task = detail?.task;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <div className="dialog-head">
          <div><h2 id="detail-title">{task?.input?.summary || (loading ? "正在加载…" : "任务详情")}</h2><div className="guid">{selectedGuid}</div></div>
          <div className="dialog-actions"><button type="button" disabled={loading} onClick={onRefresh}>刷新详情</button><button type="button" onClick={onClose}>关闭</button></div>
        </div>
        <div className="dialog-body">
          {error ? <div className="error">{error}</div> : null}
          {!task && loading ? <div className="empty">正在加载任务详情…</div> : null}
          {task ? (
            <>
              <div className="grid">
                <Metric label="状态"><Badge state={task.state} /></Metric>
                <Metric label="项目 / 模式">{task.project_key} / {task.mode}</Metric>
                <Metric label="更新时间">{formatTime(task.updated_at)}</Metric>
                <Metric label="Thread" mono>{task.thread_id || "—"}</Metric>
                <Metric label="Worker PID">{task.worker_pid ?? "—"}</Metric>
                <Metric label="服务实例" mono>{task.service_instance_id || "—"}</Metric>
                <Metric label="仓库" mono>{task.repo}</Metric>
              </div>
              {task.progress_text ? <><h3>当前进展</h3><div className="metric"><Badge state={task.progress_event || "progress"} /><ProgressText text={task.progress_text} /><div className="muted">{formatTime(task.progress_updated_at)}</div></div></> : null}
              <div className="actions">
                {task.state === "RUNNING" || task.state === "QUEUED"
                  ? <button className="danger" type="button" disabled={busyAction !== null} onClick={onInterrupt}>{busyAction === "interrupt" ? "正在中断…" : "中断当前执行"}</button>
                  : <span className="muted">当前没有可中断的执行</span>}
                <form onSubmit={onFeedbackSubmit}>
                  <textarea maxLength={2000} value={feedback} onChange={(event) => onFeedbackChange(event.target.value)} placeholder="给已处理任务追加补充细节；提交后会写回飞书并触发下一轮处理" />
                  <button className="primary" type="submit" disabled={!feedback.trim() || busyAction !== null}>{busyAction === "feedback" ? "提交中…" : "追加反馈"}</button>
                </form>
              </div>
              <h3>任务描述</h3><pre>{task.input?.description || "（无描述）"}</pre>
              {task.last_error ? <><h3>最近错误</h3><pre>{task.last_error}</pre></> : null}
              <h3>运行记录（{detail?.runs.length ?? 0}）</h3>
              {detail?.runs.length ? detail.runs.map((run) => <RunCard key={run.run_id} run={run} />) : <div className="muted">暂无运行记录</div>}
              <h3>飞书回写队列</h3><div className="muted">{detail?.outbox.filter((entry) => !entry.completed_at).length ?? 0} 条待发送 / {detail?.outbox.length ?? 0} 条总记录</div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
});

function Metric({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }): ReactElement {
  return <div className={`metric${mono ? " metric-mono" : ""}`}><small>{label}</small>{children}</div>;
}

const RunCard = memo(function RunCard({ run }: { run: StoredRun }): ReactElement {
  return (
    <section className="run">
      <div className="run-head"><Badge state={run.state} /><strong>{run.run_id}</strong><span className="muted">{formatTime(run.started_at)} → {formatTime(run.finished_at)}</span></div>
      <div className="guid">thread: {run.thread_id || "—"}</div>
      {run.progress_text ? <div className="metric"><small>最后进展 · {run.progress_event || "progress"}</small>{run.progress_text}</div> : null}
      {run.events?.length ? <><h3>执行事件</h3><div>{run.events.map((event) => <RunEventRow key={event.id} event={event} />)}</div></> : null}
      {run.prompt_text ? <details><summary>本轮提示词</summary><pre>{run.prompt_text}</pre></details> : null}
      {run.usage_json ? <details><summary>Token usage</summary><pre>{prettyJson(run.usage_json)}</pre></details> : null}
      {run.final_response ? <><h3>最终响应</h3><pre>{run.final_response}</pre></> : null}
    </section>
  );
});

const RunEventRow = memo(function RunEventRow({ event }: { event: StoredRunEvent }): ReactElement {
  const reference = [event.item_type, event.item_id].filter(Boolean).join(" · ");
  return <div className="run-event"><time>{formatTime(event.created_at)}</time><span><strong>{event.event_type}</strong>{reference ? <span className="guid"> {reference}</span> : null} {event.message}</span></div>;
});

function Badge({ state }: { state: string }): ReactElement {
  return <span className={`badge badge-${state}`}>{state}</span>;
}

function ProgressText({ text }: { text: string | null }): ReactElement | null {
  return text ? <div className="progress">{text}</div> : null;
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function mergeTaskItems(previous: TaskListItem[], incoming: TaskListResponse["items"]): TaskListItem[] {
  const previousByGuid = new Map(previous.map((item) => [item.task_guid, item]));
  return incoming.map((item) => {
    const previousItem = previousByGuid.get(item.task_guid);
    return previousItem && taskItemEqual(previousItem, item) ? previousItem : item;
  });
}

function taskItemEqual(left: TaskListItem, right: TaskListItem): boolean {
  return left.task_guid === right.task_guid
    && left.state === right.state
    && left.updated_at === right.updated_at
    && left.progress_event === right.progress_event
    && left.progress_text === right.progress_text
    && left.progress_updated_at === right.progress_updated_at
    && left.thread_id === right.thread_id
    && left.active_run_id === right.active_run_id
    && left.last_error === right.last_error
    && left.latest_run?.run_id === right.latest_run?.run_id
    && left.latest_run?.state === right.latest_run?.state
    && left.latest_run?.progress_text === right.latest_run?.progress_text
    && left.latest_run?.finished_at === right.latest_run?.finished_at;
}

function mergeDetailChange(previous: TaskDetailResponse, change: DashboardChange): TaskDetailResponse {
  if (!change.task || previous.task.task_guid !== change.task.task_guid) return previous;
  let runs = previous.runs;
  if (change.latest_run) {
    const index = runs.findIndex((run) => run.run_id === change.latest_run?.run_id);
    if (index < 0) {
      runs = [change.latest_run, ...runs];
    } else if (runs[index] !== change.latest_run) {
      const next = runs.slice();
      next[index] = { ...change.latest_run, events: runs[index].events };
      runs = next;
    }
  }
  if (change.run_event) {
    const event = change.run_event;
    const index = runs.findIndex((run) => run.run_id === event.run_id);
    if (index >= 0) {
      const run = runs[index];
      const events = run.events ?? [];
      if (!events.some((item) => item.id === event.id)) {
        const next = runs.slice();
        next[index] = { ...run, events: [...events, event] };
        runs = next;
      }
    }
  }
  return {
    task: change.task,
    runs,
    outbox: change.outbox,
  };
}
