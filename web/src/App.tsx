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
import { useMobileBack } from "./use-mobile-back.js";
import { startForegroundPolling } from "./foreground-polling.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import { getMobileConnection, isMobileApp, listMobileShares, readMobileShareFiles } from "./mobile-runtime.js";

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
import { PromptTemplatePicker, refreshWorkbenchInbox, Workbench } from "./Workbench.js";
import { fetchWorkbenchPreferences, type WorkbenchNewTaskDraft, type WorkbenchPreference } from "./workbench-api.js";
import {
  clearTaskCreateDraft,
  loadLastTaskCreateProjectKey,
  loadTaskCreateDraft,
  rememberLastTaskCreateProjectKey,
  saveTaskCreateDraft,
} from "./task-create-draft-store.js";

const PAGE_SIZE = 50;
const TASK_STATUS_LABELS: Record<string, string> = {
  ATTENTION: "待处理",
  DISCOVERED: "待派发",
  BLOCKED_CONFIG: "配置受阻",
  QUEUED: "排队中",
  RUNNING: "执行中",
  WAITING_REVIEW: "待验收",
  ACCEPTED: "验收通过",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCEL_REQUESTED: "取消中",
  CANCELED: "已取消",
  CANCELLED: "已取消",
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
  mobileShareFile?: string;
}
type MobileTaskShare = { id: string; project: string; scope: string; server: string };

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
  const [workbenchPreferences, setWorkbenchPreferences] = useState<WorkbenchPreference[]>([]);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [onlyPinned, setOnlyPinned] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  useEffect(() => {
    const oldTaskId = searchParams.get("task");
    if (!oldTaskId) return;
    const backParams = new URLSearchParams(searchParams);
    backParams.delete("task");
    navigate(`/tasks/direct/${encodeURIComponent(oldTaskId)}`, { replace: true, state: { returnTo: `/${backParams.size ? `?${backParams}` : ""}` } });
  }, [navigate, searchParams]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  useMobileBack(createOpen, () => closeCreateTask(), 100);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newDescription, setNewDescription] = useState("");
  const [newAttachments, setNewAttachments] = useState<SelectedTaskAttachment[]>([]);
  const [attachmentRestoreNotice, setAttachmentRestoreNotice] = useState(false);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [newProjectKey, setNewProjectKey] = useState("");
  const [newMode, setNewMode] = useState("");
  const [newTaskDraftNotice, setNewTaskDraftNotice] = useState("");
  const [keepDraftOnProjectChange, setKeepDraftOnProjectChange] = useState(false);
  const [newCreateWorktree, setNewCreateWorktree] = useState(false);
  const incomingTaskDraft = parseWorkbenchNewTaskDraft(location.state);
  const [mobileShareImport, setMobileShareImport] = useState<MobileTaskShare | null>(null);
  const mobileImportingRef = useRef(false);
  const mobileImportedFilesRef = useRef(new Set<string>());
  const mobileViewActiveRef = useRef(true);
  useEffect(() => { mobileViewActiveRef.current = true; return () => { mobileViewActiveRef.current = false; }; }, []);

  const listAbortRef = useRef<AbortController | null>(null);
  const listRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const handledTaskDraftRef = useRef<string | null>(null);
  const createDraftSnapshotRef = useRef<{ projectKey: string; description: string; hadStagedAttachments: boolean; createWorktree: boolean } | null>(null);

  if (createOpen && newProjectKey) {
    createDraftSnapshotRef.current = {
      projectKey: newProjectKey,
      description: newDescription,
      hadStagedAttachments: newAttachments.length > 0 || attachmentRestoreNotice,
      createWorktree: newCreateWorktree,
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

  const loadOrganizationPreferences = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setPreferencesLoading(true);
    setPreferencesError(null);
    try {
      const result = await fetchWorkbenchPreferences(signal);
      if (signal?.aborted) return;
      setWorkbenchPreferences(result.preferences);
    } catch (error) {
      if (!signal?.aborted) setPreferencesError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setPreferencesLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadOrganizationPreferences(controller.signal);
    return () => controller.abort();
  }, [loadOrganizationPreferences, preferencesRevision]);

  useEffect(() => {
    const refreshAfterReconnect = (): void => {
      if (navigator.onLine === false) return;
      void loadTasks(true);
      void loadOrganizationPreferences();
    };
    window.addEventListener("online", refreshAfterReconnect);
    return () => window.removeEventListener("online", refreshAfterReconnect);
  }, [loadOrganizationPreferences, loadTasks]);

  useEffect(() => {
    if (!incomingTaskDraft || (!lastUpdated && !listError)) return;
    const incomingKey = JSON.stringify(incomingTaskDraft);
    if (handledTaskDraftRef.current === incomingKey) return;
    handledTaskDraftRef.current = incomingKey;
    const nativeShare = (location.state as { mobileShareImport?: MobileTaskShare } | null)?.mobileShareImport;
    const validShare = isMobileApp() && nativeShare && nativeShare.scope === getLocalDraftScope()
      && nativeShare.server === getMobileConnection()?.server && nativeShare.project === incomingTaskDraft.projectKey ? nativeShare : null;
    setMobileShareImport(validShare ?? null); mobileImportedFilesRef.current.clear();
    const projectAvailable = Boolean(incomingTaskDraft.projectKey && filterOptions.projects.includes(incomingTaskDraft.projectKey));
    setCreateError(projectAvailable || !incomingTaskDraft.projectKey
      ? null
      : `项目 ${incomingTaskDraft.projectKey} 当前未登记或不可用；描述已保留，请手动选择项目。`);
    setNewAttachments([]);
    setAttachmentRestoreNotice(validShare ? loadTaskCreateDraft(validShare.project)?.hadStagedAttachments ?? false : false);
    setNewProjectKey(projectAvailable ? incomingTaskDraft.projectKey! : "");
    setNewMode(projectAvailable ? incomingTaskDraft.mode ?? "" : "");
    setNewDescription(incomingTaskDraft.description);
    setNewCreateWorktree(validShare ? loadTaskCreateDraft(validShare.project)?.createWorktree ?? false : false);
    setKeepDraftOnProjectChange(!projectAvailable && Boolean(incomingTaskDraft.projectKey));
    setNewTaskDraftNotice(validShare ? "手机分享只加入新任务草稿，确认提交后才执行；原分享继续保存在本机收件箱。" : incomingTaskDraft.source === "history"
      ? `History 草稿只沿用提供的项目和描述；Home 与模型不会继承，新任务按项目当前配置执行。${incomingTaskDraft.projectKey ? "" : "未提供精确匹配的项目，请手动选择。"}`
      : `已带入源任务的项目、mode${incomingTaskDraft.mode ? `（${incomingTaskDraft.mode}）` : ""}和描述；附件未复制。点击“提交任务”后才会创建新任务。${projectAvailable ? "" : "项目不可用时，mode 不会套用到其他项目。"}`);
    setCreateOpen(true);
    if (projectAvailable) rememberLastTaskCreateProjectKey(incomingTaskDraft.projectKey!);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [filterOptions.projects, incomingTaskDraft?.description, incomingTaskDraft?.homeId, incomingTaskDraft?.mode, incomingTaskDraft?.model, incomingTaskDraft?.projectKey, incomingTaskDraft?.source, lastUpdated, listError, location.pathname, location.search, navigate]);

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
    return startForegroundPolling(async () => { await loadTasks(true); }, 10_000);
  }, [loadTasks, streamStatus]);

  useEffect(() => {
    if (appliedFilters.source === "desk" || streamStatus !== "connected") return;
    return startForegroundPolling(async () => { await loadTasks(true); }, 10_000);
  }, [appliedFilters.source, loadTasks, streamStatus]);

  useEffect(() => {
    if (!createOpen || !newProjectKey) return;
    const timeout = window.setTimeout(() => {
      saveTaskCreateDraft(newProjectKey, newDescription, newAttachments.length > 0 || attachmentRestoreNotice, newCreateWorktree);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [attachmentRestoreNotice, createOpen, newAttachments.length, newCreateWorktree, newDescription, newProjectKey]);

  useEffect(() => {
    const flushDraft = (): void => {
      const draft = createDraftSnapshotRef.current;
      if (draft) saveTaskCreateDraft(draft.projectKey, draft.description, draft.hadStagedAttachments, draft.createWorktree);
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
    setNewTaskDraftNotice("");
    setKeepDraftOnProjectChange(false);
    setNewAttachments([]);
    const preferredProjectKey = loadLastTaskCreateProjectKey();
    const projectKey = filterOptions.projects.includes(preferredProjectKey)
      ? preferredProjectKey
      : filterOptions.projects[0] ?? "";
    const draft = loadTaskCreateDraft(projectKey);
    setNewProjectKey(projectKey);
    setNewMode("");
    setNewDescription(draft?.description ?? "");
    setNewCreateWorktree(draft?.createWorktree ?? false);
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
    setMobileShareImport(null); mobileImportedFilesRef.current.clear();
    const hadStagedAttachments = newAttachments.length > 0 || attachmentRestoreNotice;
    saveTaskCreateDraft(newProjectKey, newDescription, hadStagedAttachments, newCreateWorktree);
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
    setMobileShareImport(null); mobileImportedFilesRef.current.clear();
    const discardedSelectedAttachments = newAttachments.length > 0;
    saveTaskCreateDraft(newProjectKey, newDescription, newAttachments.length > 0 || attachmentRestoreNotice, newCreateWorktree);
    const draft = loadTaskCreateDraft(projectKey);
    for (const attachment of newAttachments) {
      releasePreviewUrl(attachment.previewUrl);
      void deleteTaskAttachment(attachment.attachment_id).catch(() => undefined);
    }
    rememberLastTaskCreateProjectKey(projectKey);
    const preserveInheritedDescription = keepDraftOnProjectChange;
    setCreateError(discardedSelectedAttachments ? "已移除上一个项目的暂存附件；如需提交文件，请为当前项目重新选择。" : null);
    setNewAttachments([]);
    setNewProjectKey(projectKey);
    setNewMode("");
    if (newMode) setNewTaskDraftNotice("项目已切换；源任务 mode 不再沿用，新任务按所选项目当前配置执行。");
    setNewDescription(preserveInheritedDescription ? newDescription : draft?.description ?? "");
    setKeepDraftOnProjectChange(false);
    setNewCreateWorktree(draft?.createWorktree ?? false);
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

  const importMobileShareAttachments = async (): Promise<void> => {
    const incoming = mobileShareImport;
    if (!incoming || mobileImportingRef.current || incoming.project !== newProjectKey) return;
    mobileImportingRef.current = true; setAttachmentsBusy(true); setCreateError(null);
    const assertTarget = (): void => {
      if (!mobileViewActiveRef.current || getLocalDraftScope() !== incoming.scope || getMobileConnection()?.server !== incoming.server
        || createDraftSnapshotRef.current?.projectKey !== incoming.project) throw new Error("草稿或环境已变化，未继续导入，原分享仍保留。");
    };
    try {
      assertTarget();
      const share = (await listMobileShares()).find((item) => item.id === incoming.id); assertTarget();
      if (!share) throw new Error("找不到原分享，请回到分享收件箱重试。");
      const pending = share.files.filter((file) => !mobileImportedFilesRef.current.has(`${share.id}:${file.id}`));
      if (newAttachments.length + pending.length > 10 || pending.some((file) => file.size > 25 * 1024 * 1024)) throw new Error("任务沿用每次 10 个附件、每个 25 MiB 的现有限制；原分享仍保留，可选择 Tmux 目标。");
      const files = await readMobileShareFiles({ ...share, files: pending }); assertTarget();
      for (let index = 0; index < files.length; index++) {
        assertTarget();
        const file = files[index]!;
        const attachment = await uploadTaskAttachment(file); assertTarget();
        const key = `${share.id}:${pending[index]!.id}`;
        mobileImportedFilesRef.current.add(key);
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        if (previewUrl) previewUrlsRef.current.add(previewUrl);
        setNewAttachments((current) => [...current, { ...attachment, mobileShareFile: key, ...(previewUrl ? { previewUrl } : {}) }]);
        setAttachmentRestoreNotice(false);
      }
    } catch (cause) { if (mobileViewActiveRef.current) setCreateError(cause instanceof Error ? cause.message : "分享附件导入失败，原件仍在收件箱。"); }
    finally { mobileImportingRef.current = false; if (mobileViewActiveRef.current) setAttachmentsBusy(false); }
  };
  useEffect(() => {
    if (createOpen && mobileShareImport?.project === newProjectKey) void importMobileShareAttachments();
  }, [createOpen, mobileShareImport?.id]);

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
      const input: CreateTaskInput & { mode?: string } = {
        description: newDescription.trim(),
        projectKey: newProjectKey,
        createWorktree: newCreateWorktree,
        ...(newMode ? { mode: newMode } : {}),
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
      setNewMode("");
      setNewTaskDraftNotice("");
      setKeepDraftOnProjectChange(false);
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
        saveTaskCreateDraft(submittedProjectKey, newDescription, true, newCreateWorktree);
        setCreateError(notice);
      } else {
        saveTaskCreateDraft(submittedProjectKey, newDescription, newAttachments.length > 0 || attachmentRestoreNotice, newCreateWorktree);
        setCreateError(message);
      }
    } finally {
      submittingRef.current = false;
      setCreateBusy(false);
    }
  }, [attachmentRestoreNotice, createBusy, newAttachments, newCreateWorktree, newDescription, newMode, newProjectKey, openDetail]);

  const submitFilters = useCallback((event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setOffset(0);
    setAppliedFilters({ ...draftFilters });
  }, [draftFilters]);

  const refreshTaskPanel = (): void => {
    void loadTasks();
    setPreferencesRevision((value) => value + 1);
    void refreshWorkbenchInbox();
  };

  const clearOrganizationFilters = (): void => {
    setOnlyPinned(false);
    setOnlyUnread(false);
    setOnlyAttention(false);
    setTagFilter("");
  };

  const clearFilters = (): void => {
    setDraftFilters({ ...EMPTY_FILTERS });
    setAppliedFilters({ ...EMPTY_FILTERS });
    setOffset(0);
    clearOrganizationFilters();
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const detailFilterCount = [draftFilters.state, draftFilters.source, draftFilters.project, draftFilters.mode, tagFilter.trim()].filter(Boolean).length;
  const hasOrganizationFilters = onlyPinned || onlyUnread || onlyAttention || Boolean(tagFilter.trim());
  const hasFilters = hasOrganizationFilters || Object.values(draftFilters).some(Boolean) || Object.values(appliedFilters).some(Boolean);
  const appliedFilterSummary = [
    appliedFilters.state ? TASK_STATUS_LABELS[appliedFilters.state] ?? appliedFilters.state : "",
    appliedFilters.source === "desk" ? "Bridge" : appliedFilters.source === "direct" ? "飞书 Direct" : appliedFilters.source === "aamp" ? "飞书 AAMP + Relay" : "",
    appliedFilters.project,
    appliedFilters.mode,
  ].filter(Boolean).join(" · ");
  const tagNeedle = tagFilter.trim().toLocaleLowerCase();
  const organizationRows = items
    .map((item, index) => ({ item, index, preference: taskOrganizationPreference(item, workbenchPreferences) }))
    .filter(({ preference }) => (!onlyPinned || preference?.pinned)
      && (!onlyUnread || preference?.unread)
      && (!onlyAttention || preference?.keepAttention)
      && (!tagNeedle || preference?.tags.some((tag) => tag.toLocaleLowerCase().includes(tagNeedle))))
    .sort((left, right) => Number(Boolean(right.preference?.pinned)) - Number(Boolean(left.preference?.pinned)) || left.index - right.index);
  const visibleItems = organizationRows.map(({ item }) => item);
  const organizationFiltersDisabled = preferencesLoading || preferencesError !== null;
  return (
    <>
      <header className="page-header task-panel-toolbar">
        <h1>任务面板</h1>
        <div className={`live live-${streamStatus}`} role="status" aria-label={streamStatus === "connected" ? "实时连接" : streamStatus === "connecting" ? "连接中" : "轮询中"}>
          <time className="muted" dateTime={lastUpdated?.toISOString()}>{lastUpdated ? lastUpdated.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</time>
        </div>
        <button className="task-panel-refresh" type="button" onClick={refreshTaskPanel} disabled={listLoading || preferencesLoading} aria-label="刷新任务面板" title="刷新任务、通知与偏好">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" /></svg>
        </button>
        <button className="primary task-panel-create" type="button" onClick={openCreateTask}><span aria-hidden="true">＋</span>新建任务</button>
      </header>

      <main className="page-main task-panel-page">
        <section className="task-panel-controls" aria-label="任务工具栏">
          <Workbench />
          <form className="task-panel-filters" onSubmit={submitFilters}>
            <div className="task-panel-search">
              <input
                aria-label="搜索任务"
                type="search"
                placeholder="搜索任务、描述或 ID"
                value={draftFilters.q}
                onChange={(event) => setDraftFilters((value) => ({ ...value, q: event.target.value }))}
              />
              <button className="primary" type="submit">查询</button>
              <button className="task-panel-filter-toggle" type="button" aria-expanded={filtersOpen} aria-controls="task-panel-detail-filters" onClick={() => setFiltersOpen((value) => !value)}>
                筛选{detailFilterCount ? <span className="task-panel-filter-count">{detailFilterCount}</span> : null}
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={filtersOpen ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} /></svg>
              </button>
            </div>
            <div className="task-panel-detail-filters" id="task-panel-detail-filters" hidden={!filtersOpen}>
              <div className="task-panel-filter-fields">
                <label>状态<Select
                  ariaLabel="状态"
                  value={draftFilters.state}
                  placeholder="全部状态"
                  options={filterOptions.states}
                  formatOption={(state) => TASK_STATUS_LABELS[state] ?? state}
                  onChange={(value) => setDraftFilters((current) => ({ ...current, state: value }))}
                /></label>
                <label>来源<select aria-label="来源" value={draftFilters.source} onChange={(event) => setDraftFilters((current) => ({ ...current, source: event.target.value, state: "", ...(event.target.value !== "desk" ? { project: "", mode: "" } : {}) }))}>
                  <option value="">全部来源</option><option value="desk">Bridge</option><option value="direct">飞书 Direct</option><option value="aamp">飞书 AAMP + Relay</option>
                </select></label>
                <label>项目<Select
                  ariaLabel="项目"
                  value={draftFilters.project}
                  placeholder="全部项目"
                  options={filterOptions.projects}
                  onChange={(value) => setDraftFilters((current) => ({ ...current, project: value }))}
                  disabled={draftFilters.source === "direct" || draftFilters.source === "aamp"}
                /></label>
                <label>模式<Select
                  ariaLabel="模式"
                  value={draftFilters.mode}
                  placeholder="全部模式"
                  options={filterOptions.modes}
                  onChange={(value) => setDraftFilters((current) => ({ ...current, mode: value }))}
                  disabled={draftFilters.source === "direct" || draftFilters.source === "aamp"}
                /></label>
                <label>标签（本页）<input type="search" aria-label="按标签筛选本页任务" placeholder="输入标签" value={tagFilter} disabled={organizationFiltersDisabled} onChange={(event) => setTagFilter(event.target.value)} /></label>
              </div>
              <p id="task-panel-organization-hint">置顶优先；置顶、未读、关注和标签仅筛选当前页。</p>
            </div>
            <div className="task-panel-quick-filters" role="group" aria-label="本页任务筛选" aria-describedby="task-panel-organization-hint">
              <span className="task-panel-filter-scope">本页</span>
              <button type="button" aria-pressed={!hasOrganizationFilters} onClick={clearOrganizationFilters}>全部</button>
              <button type="button" aria-pressed={onlyPinned} disabled={organizationFiltersDisabled} onClick={() => setOnlyPinned((value) => !value)}>置顶</button>
              <button type="button" aria-pressed={onlyUnread} disabled={organizationFiltersDisabled} onClick={() => setOnlyUnread((value) => !value)}>未读</button>
              <button type="button" aria-pressed={onlyAttention} disabled={organizationFiltersDisabled} onClick={() => setOnlyAttention((value) => !value)} title="持续关注">关注</button>
              {hasFilters ? <button className="task-panel-clear-filters" type="button" onClick={clearFilters}>清除筛选</button> : null}
            </div>
            {appliedFilterSummary || tagFilter.trim() ? <p className="task-panel-applied-filters" role="status">已筛选：{[appliedFilterSummary, tagFilter.trim() ? `本页标签「${tagFilter.trim()}」` : ""].filter(Boolean).join(" · ")}</p> : null}
            {preferencesError ? <div className="workbench-inline-error" role="alert"><span>任务标记读取失败：{preferencesError}</span><button type="button" onClick={() => setPreferencesRevision((value) => value + 1)}>重试</button></div> : null}
          </form>
        </section>

        <div className="summary task-panel-summary">
          <span role="status">
            {listLoading ? "正在加载…" : `共 ${total} 个任务${hasOrganizationFilters ? ` · 本页显示 ${visibleItems.length} / ${items.length}` : pageCount > 1 ? ` · ${items.length ? offset + 1 : 0}–${Math.min(offset + items.length, total)}` : ""}`}
          </span>
          {pageCount > 1 || offset > 0 ? <div className="pagination">
            <button type="button" disabled={offset === 0 || listLoading} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>上一页</button>
            <span>{page} / {pageCount}</span>
            <button type="button" disabled={offset + PAGE_SIZE >= total || listLoading} onClick={() => setOffset((value) => value + PAGE_SIZE)}>下一页</button>
          </div> : null}
        </div>

        <div className="table-wrap task-panel-list">
          <table className="task-panel-table">
            <thead>
              <tr><th>任务</th><th>状态 / 进展</th><th>项目 / 模式</th><th>执行方式</th><th>最近运行</th><th>Thread</th><th>更新时间</th></tr>
            </thead>
            <tbody>
              {organizationRows.map(({ item, preference }) => <TaskRow key={taskItemKey(item)} item={item} preference={preference} onOpen={openDetail} onOpenDirect={openDirectDetail} onOpenAamp={openAampDetail} />)}
            </tbody>
          </table>
          {listError ? <div className="error">{listError}</div> : !listLoading && items.length === 0 ? <div className="empty">没有符合条件的任务</div> : !listLoading && visibleItems.length === 0 ? <div className="empty">本页没有符合标记或标签的任务</div> : null}
        </div>
      </main>

      {createOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreateTask(); }}>
          <section className="dialog task-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-task-title">
            <div className="dialog-head">
              <div><h2 id="create-task-title">新建 Codex 任务</h2></div>
              <button type="button" onClick={closeCreateTask} aria-label="关闭" disabled={createBusy || attachmentsBusy}>×</button>
            </div>
            <form className="task-create-form dialog-body" onSubmit={(event) => void handleCreateTask(event)}>
              {newTaskDraftNotice ? <p className="workbench-status-note" role="status">{newTaskDraftNotice}</p> : null}
              <label>项目<Select ariaLabel="任务项目" value={newProjectKey} placeholder="选择项目" options={filterOptions.projects} onChange={selectCreateProject} disabled={createBusy || attachmentsBusy} /></label>
              {mobileShareImport?.project === newProjectKey ? <button type="button" disabled={createBusy || attachmentsBusy} onClick={() => void importMobileShareAttachments()}>重试导入分享附件（不提交任务）</button> : null}
              <PromptTemplatePicker
                projectKey={newProjectKey}
                projects={filterOptions.projects}
                disabled={createBusy || attachmentsBusy}
                onApply={(text, template) => {
                  if (template.projectKey && filterOptions.projects.includes(template.projectKey) && template.projectKey !== newProjectKey) {
                    const nextDescription = appendTaskPrompt(newDescription, text);
                    selectCreateProject(template.projectKey);
                    setNewDescription(nextDescription);
                    setNewTaskDraftNotice(`已沿用模板项目 ${template.projectKey}；源任务 mode 已清除，新任务按此项目当前配置执行。`);
                  } else {
                    setNewDescription((current) => appendTaskPrompt(current, text));
                    if (template.projectKey && !filterOptions.projects.includes(template.projectKey)) {
                      setCreateError(`模板项目 ${template.projectKey} 当前不可用；提示词已插入，请手动选择项目。`);
                    }
                  }
                }}
              />
              <p className="muted">新建任务会沿用模板项目；当前新建接口不接收模板中的模型和推理强度。</p>
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
              <label className="task-worktree-option"><input type="checkbox" checked={newCreateWorktree} onChange={(event) => setNewCreateWorktree(event.target.checked)} disabled={createBusy || attachmentsBusy} /><span><strong>使用 Git worktree</strong></span></label>
              {createError ? <div className="error" role="alert">{createError}</div> : null}
              <div className="dialog-actions task-create-actions">
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

const TaskRow = memo(function TaskRow({ item, preference, onOpen, onOpenDirect, onOpenAamp }: {
  item: TaskListItem;
  preference?: WorkbenchPreference;
  onOpen: (guid: string) => void;
  onOpenDirect: (taskId: string) => void;
  onOpenAamp: (taskId: string) => void;
}): ReactElement {
  if (item.source === "direct") {
    const project = item.text.match(/^[ \t]*(?:项目|project)[ \t]*[:：=][ \t]*(\S+)[ \t]*$/imu)?.[1];
    return <tr className="task-row" tabIndex={0} onClick={() => onOpenDirect(item.id)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenDirect(item.id); }
    }}>
      <td><div className="title" title={preference?.title ? directTaskTitle(item.text) : undefined}>{preference?.title || directTaskTitle(item.text)}</div><TaskOrganizationBadges preference={preference} /><div className="guid">{item.id}</div></td>
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
      <td><div className="title" title={preference?.title ? title : undefined}>{preference?.title || title}</div><TaskOrganizationBadges preference={preference} /><div className="guid">{item.id}</div></td>
      <td><Badge state={item.status} label={TASK_STATUS_LABELS[item.status] ?? item.status} /><ProgressText text={item.last_progress_text} /></td>
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
        <div className="title" title={preference?.title ? item.input?.summary || undefined : undefined}>{preference?.title || item.input?.summary || "（无标题）"}</div>
        <TaskOrganizationBadges preference={preference} />
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

function TaskOrganizationBadges({ preference }: { preference?: WorkbenchPreference }): ReactElement | null {
  if (!preference || (!preference.pinned && !preference.unread && !preference.keepAttention && !preference.tags.length)) return null;
  return <div className="workbench-task-row-badges">
    {preference.pinned ? <span>置顶</span> : null}
    {preference.unread ? <span>未读</span> : null}
    {preference.keepAttention ? <span>关注</span> : null}
    {preference.tags.map((tag) => <span key={tag}>{tag}</span>)}
  </div>;
}

function Badge({ state, label = TASK_STATUS_LABELS[state] ?? state }: { state: string; label?: string }): ReactElement {
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

function taskOrganizationPreference(item: TaskListItem, preferences: WorkbenchPreference[]): WorkbenchPreference | undefined {
  const id = item.source === "desk" ? item.task_guid : item.id;
  return preferences.find((preference) => preference.target.kind === "task"
    && preference.target.source === item.source
    && preference.target.id === id);
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

function parseWorkbenchNewTaskDraft(state: unknown): WorkbenchNewTaskDraft | null {
  if (!state || typeof state !== "object" || !("newTaskDraft" in state)) return null;
  const value = (state as { newTaskDraft?: unknown }).newTaskDraft;
  if (!value || typeof value !== "object" || !("description" in value)) return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.description !== "string") return null;
  return {
    source: draft.source === "history" ? "history" : "task",
    ...(typeof draft.projectKey === "string" ? { projectKey: draft.projectKey } : {}),
    ...(typeof draft.mode === "string" ? { mode: draft.mode } : {}),
    description: draft.description,
    ...(typeof draft.model === "string" ? { model: draft.model } : {}),
    ...(typeof draft.homeId === "string" ? { homeId: draft.homeId } : {}),
  };
}

function appendTaskPrompt(current: string, inserted: string): string {
  const draft = current.trimEnd();
  return draft ? `${draft}\n\n${inserted}` : inserted;
}
