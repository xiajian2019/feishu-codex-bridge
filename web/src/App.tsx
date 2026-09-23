import {
  memo,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  createProject,
  createTask,
  deleteTaskAttachment,
  fetchProjects,
  fetchTaskDetail,
  fetchTasks,
  postTaskAction,
  subscribeToChanges,
  taskAttachmentUrl,
  uploadTaskAttachment,
  updateProject,
  type EventStreamStatus,
} from "./api.js";
import {
  TASK_STATES,
  type CreateTaskInput,
  type DashboardChange,
  type ProjectRecord,
  type ProjectStatus,
  type TaskAttachment,
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

interface SelectedTaskAttachment extends TaskAttachment {
  previewUrl?: string;
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
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newDescription, setNewDescription] = useState("");
  const [newAttachments, setNewAttachments] = useState<SelectedTaskAttachment[]>([]);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [newProjectKey, setNewProjectKey] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [managedProjects, setManagedProjects] = useState<ProjectRecord[]>([]);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectStatusFilter, setProjectStatusFilter] = useState<"all" | "available" | "disabled" | "unavailable">("all");
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>("available");

  const listAbortRef = useRef<AbortController | null>(null);
  const listRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedGuidRef = useRef<string | null>(null);
  const previewUrlsRef = useRef(new Set<string>());

  useEffect(() => () => {
    for (const previewUrl of previewUrlsRef.current) URL.revokeObjectURL(previewUrl);
    previewUrlsRef.current.clear();
  }, []);

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

  const handleCreateTask = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const input: CreateTaskInput = {
        description: newDescription.trim(),
        projectKey: newProjectKey,
        ...(newAttachments.length > 0 ? { attachmentIds: newAttachments.map((attachment) => attachment.attachment_id) } : {}),
      };
      const result = await createTask(input);
      for (const attachment of newAttachments) releasePreviewUrl(attachment.previewUrl);
      setNewAttachments([]);
      setCreateOpen(false);
      setDraftFilters(EMPTY_FILTERS);
      setAppliedFilters(EMPTY_FILTERS);
      setOffset(0);
      setItems((current) => [
        { ...result.task, latest_run: result.latest_run },
        ...current.filter((item) => item.task_guid !== result.task.task_guid),
      ].slice(0, PAGE_SIZE));
      setTotal((current) => current + 1);
      setLastUpdated(new Date());
      openDetail(result.task.task_guid);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy, newAttachments, newDescription, newProjectKey, openDetail]);

  const refreshManagedProjects = useCallback(async (): Promise<ProjectRecord[]> => {
    const result = await fetchProjects();
    setManagedProjects(result);
    const availableNames = result.filter((project) => project.available).map((project) => project.name);
    setFilterOptions((current) => ({ ...current, projects: availableNames }));
    return result;
  }, []);

  const openProjects = (): void => {
    setProjectError(null);
    setEditingProject(null);
    setProjectFormOpen(false);
    setProjectSearch("");
    setProjectStatusFilter("all");
    setProjectName("");
    setProjectPath("");
    setProjectStatus("available");
    setProjectsOpen(true);
    void refreshManagedProjects().catch((error) => {
      setProjectError(error instanceof Error ? error.message : String(error));
    });
  };

  const editProject = (project: ProjectRecord): void => {
    setProjectError(null);
    setEditingProject(project.name);
    setProjectFormOpen(true);
    setProjectName(project.name);
    setProjectPath(project.path);
    setProjectStatus(project.status);
  };

  const handleSaveProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (projectBusy) return;
    setProjectBusy(true);
    setProjectError(null);
    try {
      if (editingProject) {
        await updateProject(editingProject, { path: projectPath.trim(), status: projectStatus });
      } else {
        await createProject({ name: projectName.trim(), path: projectPath.trim(), status: projectStatus });
      }
      await refreshManagedProjects();
      setEditingProject(null);
      setProjectFormOpen(false);
      setProjectName("");
      setProjectPath("");
      setProjectStatus("available");
      void loadTasks(true);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectBusy(false);
    }
  };

  const resetProjectForm = (): void => {
    setEditingProject(null);
    setProjectFormOpen(false);
    setProjectName("");
    setProjectPath("");
    setProjectStatus("available");
    setProjectError(null);
  };

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
  const visibleManagedProjects = managedProjects.filter((project) => {
    const query = projectSearch.trim().toLowerCase();
    const matchesQuery = !query || `${project.name} ${project.path}`.toLowerCase().includes(query);
    const matchesStatus = projectStatusFilter === "all"
      || (projectStatusFilter === "available" && project.available)
      || (projectStatusFilter === "disabled" && project.status === "disabled")
      || (projectStatusFilter === "unavailable" && project.status === "available" && !project.available);
    return matchesQuery && matchesStatus;
  });

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
          <button type="button" onClick={openProjects}>管理项目</button>
          <button className="primary" type="button" onClick={openCreateTask}>新建任务</button>
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
              <tr><th>任务</th><th>状态 / 进展</th><th>项目 / 模式</th><th>执行方式</th><th>最近运行</th><th>Thread</th><th>更新时间</th></tr>
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
      {projectsOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectsOpen(false); }}>
          <section className="dialog project-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="project-manager-title">
            <div className="dialog-head">
              <div><h2 id="project-manager-title">项目管理</h2><div className="muted">项目目录保存在 Bridge SQLite，停用项目不会出现在任务和 tmux 选择器中。</div></div>
              <button type="button" onClick={() => setProjectsOpen(false)} aria-label="关闭">×</button>
            </div>
            <div className="dialog-body project-manager-body">
              <div className="project-manager-toolbar">
                <input type="search" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="搜索项目名称或目录" aria-label="筛选项目" />
                <select value={projectStatusFilter} onChange={(event) => setProjectStatusFilter(event.target.value as typeof projectStatusFilter)} aria-label="按项目状态筛选">
                  <option value="all">全部状态</option><option value="available">可用</option><option value="disabled">已停用</option><option value="unavailable">路径不可用</option>
                </select>
                <span className="muted">{visibleManagedProjects.length} / {managedProjects.length} 个项目</span>
                <button className="primary" type="button" onClick={() => {
                  setProjectError(null);
                  setEditingProject(null);
                  setProjectName("");
                  setProjectPath("");
                  setProjectStatus("available");
                  setProjectFormOpen(true);
                }}>新增项目</button>
              </div>
              {projectError && !projectFormOpen ? <div className="error" role="alert">{projectError}</div> : null}
              {projectFormOpen ? <form className="project-manager-form" onSubmit={(event) => void handleSaveProject(event)}>
                <label>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} required maxLength={120} disabled={Boolean(editingProject)} placeholder="例如 food" /></label>
                <label>本机目录<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} required placeholder="/Users/you/work/project 或 ~/work/project" /></label>
                <label>状态<select value={projectStatus} onChange={(event) => setProjectStatus(event.target.value as ProjectStatus)}><option value="available">可用</option><option value="disabled">停用</option></select></label>
                {projectError ? <div className="error" role="alert">{projectError}</div> : null}
                <div className="dialog-actions">
                  <button type="button" onClick={resetProjectForm}>取消</button>
                  <button className="primary" type="submit" disabled={projectBusy || !projectName.trim() || !projectPath.trim()}>{projectBusy ? "保存中…" : editingProject ? "保存项目" : "添加项目"}</button>
                </div>
              </form> : null}
              <div className="project-manager-list" aria-live="polite">
                {visibleManagedProjects.map((project) => (
                  <div className="project-manager-row" key={project.name}>
                    <div><strong>{project.name}</strong><span>{project.path}</span></div>
                    <span className={project.available ? "project-status-available" : "project-status-disabled"}>{project.available ? "可用" : project.status === "disabled" ? "已停用" : "路径不可用"}</span>
                    <button type="button" onClick={() => editProject(project)}>编辑</button>
                  </div>
                ))}
                {managedProjects.length === 0 ? <p className="muted">尚未登记项目。</p> : visibleManagedProjects.length === 0 ? <p className="muted">没有符合条件的项目。</p> : null}
              </div>
            </div>
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
                <Metric label="来源">{task.origin === "web" ? "Bridge 看板" : "飞书任务"}</Metric>
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
                {task.origin === "feishu" ? <form onSubmit={onFeedbackSubmit}>
                  <textarea maxLength={2000} value={feedback} onChange={(event) => onFeedbackChange(event.target.value)} placeholder="给已处理任务追加补充细节；提交后会写回飞书并触发下一轮处理" />
                  <button className="primary" type="submit" disabled={!feedback.trim() || busyAction !== null}>{busyAction === "feedback" ? "提交中…" : "追加反馈"}</button>
                </form> : <span className="muted">看板任务后续内容请新建任务提交。</span>}
              </div>
              <h3>任务描述</h3><pre>{task.input?.description || "（无描述）"}</pre>
              {detail?.attachments?.length ? <>
                <h3>附件（{detail.attachments.length}）</h3>
                <div className="task-attachment-gallery">
                  {detail.attachments.map((attachment) => {
                    const url = taskAttachmentUrl(selectedGuid, attachment.attachment_id);
                    return (
                      <a className="task-attachment-card" key={attachment.attachment_id} href={url} target="_blank" rel="noreferrer">
                        {isPreviewableTaskImage(attachment.mime_type)
                          ? <img src={url} alt={attachment.file_name} loading="lazy" />
                          : <span className="task-attachment-file-icon">FILE</span>}
                        <span title={attachment.file_name}>{attachment.file_name}<small>{formatBytes(attachment.size_bytes)}</small></span>
                      </a>
                    );
                  })}
                </div>
              </> : null}
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
      <div className="muted">执行方式：{run.execution_backend === "tmux-session" ? "tmux session (历史)" : "Codex SDK"}</div>
      {run.tmux_session_id ? <div className="muted">历史 tmux session：{run.tmux_session_id}</div> : null}
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

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isPreviewableTaskImage(mimeType: string): boolean {
  return [
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ].includes(mimeType);
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
    attachments: previous.attachments,
    outbox: change.outbox,
  };
}
