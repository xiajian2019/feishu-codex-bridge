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
import {
  clearTaskCreateDraft,
  loadLastTaskCreateProjectKey,
  loadTaskCreateDraft,
  rememberLastTaskCreateProjectKey,
  saveTaskCreateDraft,
} from "./task-create-draft-store.js";

const PAGE_SIZE = 50;
const AAMP_STATUS_LABELS: Record<string, string> = {
  ATTENTION: "待处理",
  pending: "等待派发",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

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
  const [attachmentRestoreNotice, setAttachmentRestoreNotice] = useState(false);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [newProjectKey, setNewProjectKey] = useState("");

  const listAbortRef = useRef<AbortController | null>(null);
  const listRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const createDraftSnapshotRef = useRef<{ projectKey: string; description: string; hadStagedAttachments: boolean } | null>(null);

  if (createOpen && newProjectKey) {
    createDraftSnapshotRef.current = {
      projectKey: newProjectKey,
      description: newDescription,
      hadStagedAttachments: newAttachments.length > 0 || attachmentRestoreNotice,
    };
  } else if (!createOpen) {
    createDraftSnapshotRef.current = null;
  }

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
      latest_review: null,
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

  useEffect(() => {
    if (!createOpen || !newProjectKey) return;
    const timeout = window.setTimeout(() => {
      saveTaskCreateDraft(newProjectKey, newDescription, newAttachments.length > 0 || attachmentRestoreNotice);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [attachmentRestoreNotice, createOpen, newAttachments.length, newDescription, newProjectKey]);

  useEffect(() => {
    const flushDraft = (): void => {
      const draft = createDraftSnapshotRef.current;
      if (draft) saveTaskCreateDraft(draft.projectKey, draft.description, draft.hadStagedAttachments);
    };
    const flushWhenHidden = (): void => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flushDraft();
    };
  }, []);

  const openDetail = useCallback((taskGuid: string): void => {
    navigate(`/tasks/desk/${encodeURIComponent(taskGuid)}`, { state: { returnTo: `${location.pathname}${location.search}` } });
  }, [location.pathname, location.search, navigate]);

  const openDirectDetail = useCallback((taskId: string): void => {
    navigate(`/tasks/direct/${encodeURIComponent(taskId)}`, { state: { returnTo: `${location.pathname}${location.search}` } });
  }, [location.pathname, location.search, navigate]);

  const openAampDetail = useCallback((taskId: string): void => {
    navigate(`/tasks/aamp/${encodeURIComponent(taskId)}`, { state: { returnTo: `${location.pathname}${location.search}` } });
  }, [location.pathname, location.search, navigate]);

  const openCreateTask = (): void => {
    setCreateError(null);
    setNewAttachments([]);
    const preferredProjectKey = loadLastTaskCreateProjectKey();
    const projectKey = filterOptions.projects.includes(preferredProjectKey)
      ? preferredProjectKey
      : filterOptions.projects[0] ?? "";
    const draft = loadTaskCreateDraft(projectKey);
    setNewProjectKey(projectKey);
    setNewDescription(draft?.description ?? "");
    setAttachmentRestoreNotice(draft?.hadStagedAttachments ?? false);
    setCreateOpen(true);
  };

  const releasePreviewUrl = (previewUrl?: string): void => {
    if (!previewUrl) return;
    URL.revokeObjectURL(previewUrl);
    previewUrlsRef.current.delete(previewUrl);
  };

  const closeCreateTask = (): void => {
    if (createBusy || attachmentsBusy) return;
    const hadStagedAttachments = newAttachments.length > 0 || attachmentRestoreNotice;
    saveTaskCreateDraft(newProjectKey, newDescription, hadStagedAttachments);
    setCreateOpen(false);
    setAttachmentRestoreNotice(hadStagedAttachments);
    for (const attachment of newAttachments) {
      releasePreviewUrl(attachment.previewUrl);
      void deleteTaskAttachment(attachment.attachment_id).catch(() => undefined);
    }
    setNewAttachments([]);
  };

  const selectCreateProject = (projectKey: string): void => {
    if (projectKey === newProjectKey) return;
    const discardedSelectedAttachments = newAttachments.length > 0;
    saveTaskCreateDraft(newProjectKey, newDescription, newAttachments.length > 0 || attachmentRestoreNotice);
    const draft = loadTaskCreateDraft(projectKey);
    for (const attachment of newAttachments) {
      releasePreviewUrl(attachment.previewUrl);
      void deleteTaskAttachment(attachment.attachment_id).catch(() => undefined);
    }
    rememberLastTaskCreateProjectKey(projectKey);
    setCreateError(discardedSelectedAttachments ? "已移除上一个项目的暂存附件；如需提交文件，请为当前项目重新选择。" : null);
    setNewAttachments([]);
    setNewProjectKey(projectKey);
    setNewDescription(draft?.description ?? "");
    setAttachmentRestoreNotice(draft?.hadStagedAttachments ?? false);
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
        setAttachmentRestoreNotice(false);
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
    const submittedProjectKey = newProjectKey;
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
      clearTaskCreateDraft(submittedProjectKey);
      createDraftSnapshotRef.current = null;
      for (const attachment of newAttachments) releasePreviewUrl(attachment.previewUrl);
      setNewAttachments([]);
      setNewDescription("");
      setAttachmentRestoreNotice(false);
      setCreateOpen(false);
      setDraftFilters(EMPTY_FILTERS);
      setAppliedFilters(EMPTY_FILTERS);
      setOffset(0);
      setItems((current) => [
        { ...result.task, source: "desk" as const, latest_run: result.latest_run, latest_review: null },
        ...current.filter((item) => item.source !== "desk" || item.task_guid !== result.task.task_guid),
      ].slice(0, PAGE_SIZE));
      setTotal((current) => current + 1);
      setLastUpdated(new Date());
      openDetail(result.task.task_guid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("部分附件已过期或已绑定其他任务")) {
        for (const attachment of newAttachments) {
          releasePreviewUrl(attachment.previewUrl);
          void deleteTaskAttachment(attachment.attachment_id).catch(() => undefined);
        }
        setNewAttachments([]);
        setAttachmentRestoreNotice(true);
        const notice = "有附件已过期或已绑定到其他任务，请重新选择附件。项目和任务描述已保留。";
        saveTaskCreateDraft(submittedProjectKey, newDescription, true);
        setCreateError(notice);
      } else {
        saveTaskCreateDraft(submittedProjectKey, newDescription, newAttachments.length > 0 || attachmentRestoreNotice);
        setCreateError(message);
      }
    } finally {
      submittingRef.current = false;
      setCreateBusy(false);
    }
  }, [attachmentRestoreNotice, createBusy, newAttachments, newDescription, newProjectKey, openDetail]);

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
            formatOption={(state) => AAMP_STATUS_LABELS[state] ?? state}
            onChange={(value) => setDraftFilters((current) => ({ ...current, state: value }))}
          />
          <select aria-label="来源" value={draftFilters.source} onChange={(event) => setDraftFilters((current) => ({ ...current, source: event.target.value, state: "", ...(event.target.value !== "desk" ? { project: "", mode: "" } : {}) }))}>
            <option value="">全部来源</option><option value="desk">Bridge</option><option value="direct">飞书 Direct</option><option value="aamp">飞书 AAMP + Relay</option>
          </select>
          <Select
            ariaLabel="项目"
            value={draftFilters.project}
            placeholder="全部项目"
            options={filterOptions.projects}
            onChange={(value) => setDraftFilters((current) => ({ ...current, project: value }))}
            disabled={draftFilters.source === "direct" || draftFilters.source === "aamp"}
          />
          <Select
            ariaLabel="模式"
            value={draftFilters.mode}
            placeholder="全部模式"
            options={filterOptions.modes}
            onChange={(value) => setDraftFilters((current) => ({ ...current, mode: value }))}
            disabled={draftFilters.source === "direct" || draftFilters.source === "aamp"}
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
              {items.map((item) => <TaskRow key={taskItemKey(item)} item={item} onOpen={openDetail} onOpenDirect={openDirectDetail} onOpenAamp={openAampDetail} />)}
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
              <label>项目<Select ariaLabel="任务项目" value={newProjectKey} placeholder="选择项目" options={filterOptions.projects} onChange={selectCreateProject} disabled={createBusy || attachmentsBusy} /></label>
              <label>任务描述<textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} maxLength={20_000} rows={7} required autoFocus disabled={createBusy} placeholder="输入任务内容，Codex 会根据描述推断执行方式。" /></label>
              <label>图片和附件<input type="file" multiple disabled={createBusy || attachmentsBusy || newAttachments.length >= 10} onChange={(event) => void handleAttachmentSelection(event)} /></label>
              <div className="task-attachment-staging">
                {newAttachments.map((attachment) => (
                  <div className="task-attachment-staged" key={attachment.attachment_id}>
                    {attachment.previewUrl ? <img src={attachment.previewUrl} alt={attachment.file_name} /> : <span className="task-attachment-file-icon">FILE</span>}
                    <span title={attachment.file_name}>{attachment.file_name}<small>{formatBytes(attachment.size_bytes)}</small></span>
                    <button type="button" onClick={() => void removeSelectedAttachment(attachment)} disabled={createBusy || attachmentsBusy} aria-label={`移除 ${attachment.file_name}`}>移除</button>
                  </div>
                ))}
                {attachmentsBusy ? <span className="muted">附件正在保存到本机…</span> : null}
                {attachmentRestoreNotice && newAttachments.length === 0 ? <span className="muted" role="status">暂存附件不会跨项目切换或刷新保留，请重新选择需要的文件。</span> : null}
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
  formatOption?: (option: string) => string;
  disabled?: boolean;
}

function Select({ ariaLabel, value, placeholder, options, onChange, formatOption, disabled }: SelectProps): ReactElement {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      <option value="">{placeholder}</option>
      {options.map((option) => <option key={option} value={option}>{formatOption?.(option) ?? option}</option>)}
    </select>
  );
}

const TaskRow = memo(function TaskRow({ item, onOpen, onOpenDirect, onOpenAamp }: {
  item: TaskListItem;
  onOpen: (guid: string) => void;
  onOpenDirect: (taskId: string) => void;
  onOpenAamp: (taskId: string) => void;
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
  if (item.source === "aamp") {
    const title = item.text?.trim()
      ? directTaskTitle(item.text, 180)
      : item.image_count > 0 ? "（图片任务）" : "（无标题）";
    return <tr className="task-row" tabIndex={0} onClick={() => onOpenAamp(item.id)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenAamp(item.id); }
    }}>
      <td><div className="title">{title}</div><div className="guid">{item.id}</div></td>
      <td><Badge state={item.status} label={AAMP_STATUS_LABELS[item.status] ?? item.status} /><ProgressText text={item.last_progress_text} /></td>
      <td>—<div className="muted">飞书 AAMP + Relay</div><small>只读记录</small></td>
      <td>官方 AAMP Agent</td>
      <td>{item.image_count ? `${item.image_count} 个图片附件` : "—"}</td>
      <td className="guid">—</td>
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
        {item.latest_review ? <div className="muted">人工验收：{item.latest_review.decision === "accepted" ? "已通过" : "需要修改"}</div> : null}
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

function Badge({ state, label = state }: { state: string; label?: string }): ReactElement {
  return <span className={`badge badge-${state}`}>{label}</span>;
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
  const previousByGuid = new Map(previous.map((item) => [taskItemKey(item), item]));
  return incoming.map((item) => {
    const previousItem = previousByGuid.get(taskItemKey(item));
    return previousItem && taskItemEqual(previousItem, item) ? previousItem : item;
  });
}

function taskItemKey(item: TaskListItem): string {
  return item.source === "desk" ? `desk:${item.task_guid}` : `${item.source}:${item.id}`;
}

function taskItemEqual(left: TaskListItem, right: TaskListItem): boolean {
  if (left.source !== right.source) return false;
  if (left.source === "direct" && right.source === "direct") {
    return left.id === right.id && left.updated_at === right.updated_at
      && left.status === right.status && left.last_progress_text === right.last_progress_text;
  }
  if (left.source === "aamp" && right.source === "aamp") {
    return left.id === right.id && left.updated_at === right.updated_at
      && left.status === right.status && left.last_progress_text === right.last_progress_text
      && left.error === right.error && left.image_count === right.image_count;
  }
  if (left.source !== "desk" || right.source !== "desk") return false;
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
    && left.latest_run?.finished_at === right.latest_run?.finished_at
    && left.latest_review?.decision === right.latest_review?.decision
    && left.latest_review?.reviewed_at === right.latest_review?.reviewed_at;
}

function createWebSubmissionKey(): string {
  // getRandomValues also works on an explicitly enabled HTTP LAN connection.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
