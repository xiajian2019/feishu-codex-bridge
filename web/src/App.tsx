import {
  memo,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import {
  createTask,
  deleteTaskAttachment,
  fetchTasks,
  subscribeToChanges,
  uploadTaskAttachment,
  type EventStreamStatus,
} from "./api.js";
import {
  TASK_STATES,
  type CreateTaskInput,
  type DashboardChange,
  type TaskAttachment,
  type TaskListResponse,
} from "./types.js";
import { directTaskTitle } from "./task-title.js";

const PAGE_SIZE = 50;

interface Filters {
  q: string;
  state: string;
  source: string;
  project: string;
  mode: string;
}

type TaskListItem = TaskListResponse["items"][number];
type DeskTaskListItem = Extract<TaskListItem, { source: "desk" }>;

interface SelectedTaskAttachment extends TaskAttachment {
  previewUrl?: string;
}

const EMPTY_FILTERS: Filters = { q: "", state: "", source: "", project: "", mode: "" };

export function App(): ReactElement {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const initialFilters: Filters = {
    ...EMPTY_FILTERS,
    q: searchParams.get("q") ?? "",
    state: searchParams.get("state") ?? "",
    source: searchParams.get("source") ?? "",
  };
  const initialOffset = Number(searchParams.get("offset") ?? 0);
  const [draftFilters, setDraftFilters] = useState<Filters>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(initialFilters);
  const [offset, setOffset] = useState(Number.isSafeInteger(initialOffset) && initialOffset >= 0 ? initialOffset : 0);
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
  useEffect(() => {
    const oldTaskId = searchParams.get("task");
    if (!oldTaskId) return;
    const backParams = new URLSearchParams(searchParams);
    backParams.delete("task");
    navigate(`/tasks/direct/${encodeURIComponent(oldTaskId)}`, { replace: true, state: { returnTo: `/${backParams.size ? `?${backParams}` : ""}` } });
  }, [navigate, searchParams]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newDescription, setNewDescription] = useState("");
  const [newAttachments, setNewAttachments] = useState<SelectedTaskAttachment[]>([]);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [newProjectKey, setNewProjectKey] = useState("");

  const listAbortRef = useRef<AbortController | null>(null);
  const listRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewUrlsRef = useRef(new Set<string>());

  useEffect(() => () => {
    for (const previewUrl of previewUrlsRef.current) URL.revokeObjectURL(previewUrl);
    previewUrlsRef.current.clear();
  }, []);

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
    const nextItem: DeskTaskListItem = {
      ...change.task,
      source: "desk",
      latest_run: change.latest_run,
    };
    setItems((previous) => {
      const index = previous.findIndex((item) => item.source === "desk" && item.task_guid === nextItem.task_guid);
      if (index < 0) return previous;
      if (taskItemEqual(previous[index], nextItem)) return previous;
      const next = previous.slice();
      next[index] = nextItem;
      return next;
    });
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
    }, 10_000);
    return () => clearInterval(timer);
  }, [loadTasks, streamStatus]);

  useEffect(() => {
    if (appliedFilters.source === "desk" || streamStatus !== "connected") return;
    const timer = setInterval(() => void loadTasks(true), 10_000);
    return () => clearInterval(timer);
  }, [appliedFilters.source, loadTasks, streamStatus]);

  const openDetail = useCallback((taskGuid: string): void => {
    navigate(`/tasks/desk/${encodeURIComponent(taskGuid)}`, { state: { returnTo: `${location.pathname}${location.search}` } });
  }, [location.pathname, location.search, navigate]);

  const openDirectDetail = useCallback((taskId: string): void => {
    navigate(`/tasks/direct/${encodeURIComponent(taskId)}`, { state: { returnTo: `${location.pathname}${location.search}` } });
  }, [location.pathname, location.search, navigate]);

  const openCreateTask = (): void => {
    setCreateError(null);
    setNewDescription("");
    setNewAttachments([]);
    setNewProjectKey(filterOptions.projects[0] ?? "");
    setCreateOpen(true);
  };

  const releasePreviewUrl = (previewUrl?: string): void => {
    if (!previewUrl) return;
    URL.revokeObjectURL(previewUrl);
    previewUrlsRef.current.delete(previewUrl);
  };

  const closeCreateTask = (): void => {
    if (createBusy || attachmentsBusy) return;
    setCreateOpen(false);
    for (const attachment of newAttachments) {
      releasePreviewUrl(attachment.previewUrl);
      void deleteTaskAttachment(attachment.attachment_id).catch(() => undefined);
    }
    setNewAttachments([]);
  };

  const handleAttachmentSelection = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (newAttachments.length + selectedFiles.length > 10) {
      setCreateError("每个任务最多添加 10 个附件。");
      return;
    }
    setAttachmentsBusy(true);
    setCreateError(null);
    try {
      for (const file of selectedFiles) {
        const attachment = await uploadTaskAttachment(file);
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        if (previewUrl) previewUrlsRef.current.add(previewUrl);
        setNewAttachments((current) => [...current, { ...attachment, ...(previewUrl ? { previewUrl } : {}) }]);
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setAttachmentsBusy(false);
    }
  };

  const removeSelectedAttachment = async (attachment: SelectedTaskAttachment): Promise<void> => {
    try {
      await deleteTaskAttachment(attachment.attachment_id);
      releasePreviewUrl(attachment.previewUrl);
      setNewAttachments((current) => current.filter((item) => item.attachment_id !== attachment.attachment_id));
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const submissionRef = useRef<{ payload: string; key: string } | null>(null);
  const submittingRef = useRef(false);
  const handleCreateTask = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const input: CreateTaskInput = {
        description: newDescription.trim(),
        projectKey: newProjectKey,
        ...(newAttachments.length > 0 ? { attachmentIds: newAttachments.map((attachment) => attachment.attachment_id) } : {}),
      };
      const payload = JSON.stringify(input);
      if (submissionRef.current?.payload !== payload) {
        submissionRef.current = { payload, key: createWebSubmissionKey() };
      }
      input.idempotencyKey = submissionRef.current.key;
      const result = await createTask(input);
      submissionRef.current = null;
      for (const attachment of newAttachments) releasePreviewUrl(attachment.previewUrl);
      setNewAttachments([]);
      setCreateOpen(false);
      setDraftFilters(EMPTY_FILTERS);
      setAppliedFilters(EMPTY_FILTERS);
      setOffset(0);
      setItems((current) => [
        { ...result.task, source: "desk" as const, latest_run: result.latest_run },
        ...current.filter((item) => item.source !== "desk" || item.task_guid !== result.task.task_guid),
      ].slice(0, PAGE_SIZE));
      setTotal((current) => current + 1);
      setLastUpdated(new Date());
      openDetail(result.task.task_guid);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      submittingRef.current = false;
      setCreateBusy(false);
    }
  }, [createBusy, newAttachments, newDescription, newProjectKey, openDetail]);

  const submitFilters = useCallback((event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setOffset(0);
    setAppliedFilters({ ...draftFilters });
  }, [draftFilters]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <>
      <header className="page-header task-panel-toolbar">
        <h1>任务管理</h1>
        <div className={`live live-${streamStatus}`} role="status" aria-label={streamStatus === "connected" ? "实时连接" : streamStatus === "connecting" ? "连接中" : "轮询中"}>
          <time className="muted" dateTime={lastUpdated?.toISOString()}>{lastUpdated ? lastUpdated.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</time>
        </div>
        <button type="button" onClick={() => void loadTasks()} disabled={listLoading}>刷新</button>
      </header>

      <main className="page-main">
        <form className="filters task-panel-filters" onSubmit={submitFilters}>
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
          <select aria-label="来源" value={draftFilters.source} onChange={(event) => setDraftFilters((current) => ({ ...current, source: event.target.value, state: "", ...(event.target.value === "direct" ? { project: "", mode: "" } : {}) }))}>
            <option value="">全部来源</option><option value="desk">Bridge</option><option value="direct">飞书 Direct</option>
          </select>
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
          <button className="task-panel-create" type="button" onClick={openCreateTask}>新建任务</button>
        </form>

        <div className="summary task-panel-summary">
          <span>
            {listLoading ? "正在加载…" : `共 ${total} 个任务，当前显示 ${items.length ? offset + 1 : 0}–${Math.min(offset + items.length, total)}`}
          </span>
          <div className="pagination">
            <button type="button" disabled={offset === 0 || listLoading} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>上一页</button>
            <span>第 {page} / {pageCount} 页</span>
            <button type="button" disabled={offset + PAGE_SIZE >= total || listLoading} onClick={() => setOffset((value) => value + PAGE_SIZE)}>下一页</button>
          </div>
        </div>

        <div className="table-wrap task-panel-list">
          <table className="task-panel-table">
            <thead>
              <tr><th>任务</th><th>状态 / 进展</th><th>项目 / 模式</th><th>执行方式</th><th>最近运行</th><th>Thread</th><th>更新时间</th></tr>
            </thead>
            <tbody>
              {items.map((item) => <TaskRow key={item.source === "direct" ? `direct:${item.id}` : `desk:${item.task_guid}`} item={item} onOpen={openDetail} onOpenDirect={openDirectDetail} />)}
            </tbody>
          </table>
          {listError ? <div className="error">{listError}</div> : !listLoading && items.length === 0 ? <div className="empty">没有符合条件的任务</div> : null}
        </div>
      </main>

      {createOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreateTask(); }}>
          <section className="dialog task-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-task-title">
            <div className="dialog-head">
              <div><h2 id="create-task-title">新建 Codex 任务</h2><div className="muted">使用当前任务状态与执行记录。</div></div>
              <button type="button" onClick={closeCreateTask} aria-label="关闭" disabled={createBusy || attachmentsBusy}>×</button>
            </div>
            <form className="task-create-form dialog-body" onSubmit={(event) => void handleCreateTask(event)}>
              <label>项目<Select ariaLabel="任务项目" value={newProjectKey} placeholder="选择项目" options={filterOptions.projects} onChange={setNewProjectKey} /></label>
              <label>任务描述<textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} maxLength={20_000} rows={7} required autoFocus placeholder="输入任务内容，Codex 会根据描述推断执行方式。" /></label>
              <label>图片和附件<input type="file" multiple disabled={attachmentsBusy || newAttachments.length >= 10} onChange={(event) => void handleAttachmentSelection(event)} /></label>
              <div className="task-attachment-staging">
                {newAttachments.map((attachment) => (
                  <div className="task-attachment-staged" key={attachment.attachment_id}>
                    {attachment.previewUrl ? <img src={attachment.previewUrl} alt={attachment.file_name} /> : <span className="task-attachment-file-icon">FILE</span>}
                    <span title={attachment.file_name}>{attachment.file_name}<small>{formatBytes(attachment.size_bytes)}</small></span>
                    <button type="button" onClick={() => void removeSelectedAttachment(attachment)} disabled={attachmentsBusy} aria-label={`移除 ${attachment.file_name}`}>移除</button>
                  </div>
                ))}
                {attachmentsBusy ? <span className="muted">附件正在保存到本机…</span> : null}
                <span className="muted">单个附件最大 25 MiB，每个任务最多 10 个；文件保存在本机，可在任务详情查看。</span>
              </div>
              {createError ? <div className="error" role="alert">{createError}</div> : null}
              <div className="dialog-actions task-create-actions">
                <button type="button" onClick={closeCreateTask} disabled={createBusy || attachmentsBusy}>取消</button>
                <button className="primary" type="submit" disabled={createBusy || attachmentsBusy || !newProjectKey || !newDescription.trim()}>{createBusy ? "提交中…" : "提交任务"}</button>
              </div>
            </form>
          </section>
        </div>
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

const TaskRow = memo(function TaskRow({ item, onOpen, onOpenDirect }: {
  item: TaskListItem;
  onOpen: (guid: string) => void;
  onOpenDirect: (taskId: string) => void;
}): ReactElement {
  if (item.source === "direct") {
    const project = item.text.match(/^[ \t]*(?:项目|project)[ \t]*[:：=][ \t]*(\S+)[ \t]*$/imu)?.[1];
    return <tr className="task-row" tabIndex={0} onClick={() => onOpenDirect(item.id)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenDirect(item.id); }
    }}>
      <td><div className="title">{directTaskTitle(item.text)}</div><div className="guid">{item.id}</div></td>
      <td><Badge state={item.status} /><ProgressText text={item.last_progress_text} /></td>
      <td>{project || "未指定项目"}<div className="muted">飞书 Direct</div><small>飞书消息</small></td>
      <td>Codex SDK</td>
      <td>{item.attempt ? `${item.attempt} 次执行` : "—"}</td>
      <td className="guid">{item.thread_id || "—"}</td>
      <td>{formatTime(item.updated_at)}</td>
    </tr>;
  }
  return (
    <tr className="task-row" tabIndex={0} onClick={() => onOpen(item.task_guid)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(item.task_guid); }
    }}>
      <td>
        <div className="title">{item.input?.summary || "（无标题）"}</div>
        <div className="guid">{item.task_guid}</div>
      </td>
      <td>
        <Badge state={item.state} />
        <ProgressText text={item.progress_text} />
      </td>
      <td>{item.project_key}<div className="muted">{item.mode}</div><small>{item.origin === "web" ? "Bridge 看板" : "飞书任务"}</small></td>
      <td>
        <div>{item.latest_run?.execution_backend === "tmux-session" ? "tmux session (历史)" : "Codex SDK"}</div>
        {item.latest_run?.tmux_session_id ? <small>{item.latest_run.tmux_session_id}</small> : null}
      </td>
      <td>
        {item.latest_run ? <><Badge state={item.latest_run.state} /><div className="guid">{item.latest_run.run_id}</div></> : "—"}
      </td>
      <td className="guid">{item.thread_id || "—"}</td>
      <td>{formatTime(item.updated_at)}</td>
    </tr>
  );
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

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function mergeTaskItems(previous: TaskListItem[], incoming: TaskListResponse["items"]): TaskListItem[] {
  const previousByGuid = new Map(previous.map((item) => [item.source === "direct" ? `direct:${item.id}` : `desk:${item.task_guid}`, item]));
  return incoming.map((item) => {
    const previousItem = previousByGuid.get(item.source === "direct" ? `direct:${item.id}` : `desk:${item.task_guid}`);
    return previousItem && taskItemEqual(previousItem, item) ? previousItem : item;
  });
}

function taskItemEqual(left: TaskListItem, right: TaskListItem): boolean {
  if (left.source === "direct" || right.source === "direct") {
    return left.source === "direct" && right.source === "direct"
      && left.id === right.id && left.updated_at === right.updated_at
      && left.status === right.status && left.last_progress_text === right.last_progress_text;
  }
  return left.task_guid === right.task_guid
    && left.origin === right.origin
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
    && left.latest_run?.execution_backend === right.latest_run?.execution_backend
    && left.latest_run?.tmux_session_id === right.latest_run?.tmux_session_id
    && left.latest_run?.progress_text === right.latest_run?.progress_text
    && left.latest_run?.finished_at === right.latest_run?.finished_at;
}

function createWebSubmissionKey(): string {
  // getRandomValues also works on an explicitly enabled HTTP LAN connection.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
