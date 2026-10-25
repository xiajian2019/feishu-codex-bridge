import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";

import { fetchCodexHistory, fetchProjects } from "./api.js";
import {
  createHistoryQueueDraftSubmitter,
  buildForwardedHistoryText,
  deleteHistoryQueueMessage,
  exactHistoryProjectMatches,
  extractHistoryTemplateVariables,
  fetchHistoryActions,
  fetchHistoryQueue,
  fetchHistoryTemplates,
  forkCodexHistoryThread,
  fillHistoryTemplate,
  historyActionElicitationSchema,
  historyActionKind,
  historyActionPermissions,
  historyActionQuestions,
  historyActionSummary,
  historyPreferenceKey,
  historyTarget,
  historyTaskDraftNavigationState,
  normalizeHistoryTags,
  sendHistoryQueueMessage,
  respondToHistoryAction,
  updateHistoryQueueMessage,
  type HistoryQueueMessage,
  type HistoryWorkbenchAction,
  type HistorySelectableMessage,
  type HistoryWorkbenchPreference,
  type HistoryWorkbenchPreferencePatch,
  type HistoryWorkbenchTarget,
  type HistoryWorkbenchTemplate,
  type HistoryActionResponse,
} from "./history-workbench.js";
import type { CodexHistoryHome, CodexHistoryItem, CodexThread } from "./types.js";

export interface HistoryDraftInsertion {
  id: string;
  text: string;
  model?: string;
  reasoningEffort?: string;
}

export function HistoryIcon({ name }: {
  name: "pin" | "mail" | "eye" | "tag" | "forward" | "bookmark" | "queue" | "tools" | "info" | "more";
}): ReactElement {
  return (
    <svg className={`history-icon history-icon-${name}`} aria-hidden="true" viewBox="0 0 24 24">
      {name === "pin" ? <><path d="m16 3 5 5-4 2-3 6-2-2-6 6-2-2 6-6-2-2 6-3Z" /></> : null}
      {name === "mail" ? <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></> : null}
      {name === "eye" ? <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></> : null}
      {name === "tag" ? <><path d="M3 3h7l11 11-7 7L3 10Z" /><circle cx="7.5" cy="7.5" r="1" /></> : null}
      {name === "forward" ? <><path d="m14 4 7 7-7 7v-5c-6 0-9 2-11 6 0-8 4-10 11-10Z" /></> : null}
      {name === "bookmark" ? <path d="M6 3h12v18l-6-4-6 4Z" /> : null}
      {name === "queue" ? <><path d="M4 5h14M4 11h10M4 17h6m8-3v7m-3-3h6" /></> : null}
      {name === "tools" ? <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></> : null}
      {name === "info" ? <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></> : null}
      {name === "more" ? <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></> : null}
    </svg>
  );
}

export function HistoryPreferenceControls({
  preference,
  saving,
  onPatch,
  showLabels = false,
}: {
  preference: HistoryWorkbenchPreference;
  saving: boolean;
  onPatch: (patch: HistoryWorkbenchPreferencePatch) => void;
  showLabels?: boolean;
}): ReactElement {
  const [tagText, setTagText] = useState(preference.tags.join(", "));
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  useEffect(() => setTagText(preference.tags.join(", ")), [preference.tags]);
  return (
    <>
      <div className={`history-preference-controls${showLabels ? " is-labeled" : ""}`} aria-label="会话组织偏好">
        <button
          className="history-icon-button"
          type="button"
          aria-label={preference.pinned ? "取消置顶" : "置顶"}
          title={preference.pinned ? "取消置顶" : "置顶"}
          aria-pressed={preference.pinned}
          disabled={saving}
          onClick={() => onPatch({ pinned: !preference.pinned })}
        ><HistoryIcon name="pin" />{showLabels ? preference.pinned ? "取消置顶" : "置顶" : null}</button>
        <button
          className="history-icon-button"
          type="button"
          aria-label={preference.unread ? "标为已读" : "标为未读"}
          title={preference.unread ? "标为已读" : "标为未读"}
          aria-pressed={preference.unread}
          disabled={saving}
          onClick={() => onPatch({ unread: !preference.unread })}
        ><HistoryIcon name="mail" />{showLabels ? preference.unread ? "标为已读" : "标为未读" : null}</button>
        <button
          className="history-icon-button"
          type="button"
          aria-label={preference.keepAttention ? "取消保留关注" : "保留关注"}
          title={preference.keepAttention ? "取消保留关注" : "保留关注"}
          aria-pressed={preference.keepAttention}
          disabled={saving}
          onClick={() => onPatch({ keepAttention: !preference.keepAttention })}
        ><HistoryIcon name="eye" />{showLabels ? preference.keepAttention ? "取消保留关注" : "保留关注" : null}</button>
        <button
          type="button"
          className="history-icon-button history-tag-edit-button"
          aria-label={preference.tags.length ? `编辑标签（${preference.tags.length}）` : "添加标签"}
          title={preference.tags.length ? `编辑标签：${preference.tags.join("、")}` : "添加标签"}
          disabled={saving}
          onClick={() => {
            setTagText(preference.tags.join(", "));
            setTagDialogOpen(true);
          }}
        ><HistoryIcon name="tag" />{showLabels ? "编辑标签" : null}</button>
      </div>
      {tagDialogOpen ? (
        <div
          className="history-tag-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setTagDialogOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setTagDialogOpen(false);
            }
          }}
        >
          <section className="history-tag-dialog" role="dialog" aria-modal="true" aria-label="编辑会话标签">
            <header>
              <div>
                <strong>编辑标签</strong>
                <small>用逗号分隔多个标签，保存后用于列表筛选。</small>
              </div>
              <button type="button" aria-label="关闭标签编辑" onClick={() => setTagDialogOpen(false)}>×</button>
            </header>
            <label>
              标签
              <input
                autoFocus
                aria-label="会话标签，用逗号分隔"
                value={tagText}
                maxLength={500}
                placeholder="例如：项目、待跟进"
                onChange={(event) => setTagText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setTagDialogOpen(false);
                }}
              />
            </label>
            <div className="history-tag-dialog-actions">
              <button type="button" onClick={() => setTagDialogOpen(false)}>取消</button>
              <button
                className="primary"
                type="button"
                disabled={saving}
                onClick={() => {
                  const tags = normalizeHistoryTags(tagText);
                  setTagText(tags.join(", "));
                  setTagDialogOpen(false);
                  if (JSON.stringify(tags) !== JSON.stringify(preference.tags)) onPatch({ tags });
                }}
              >{saving ? "保存中…" : "保存标签"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function HistoryWorkbench({
  homeId,
  thread,
  title,
  homes,
  preference,
  preferenceSaving,
  preferenceError,
  onPreferencePatch,
  messages,
  selectedMessageIds,
  bookmarks,
  writerBusy,
  onInsertDraft,
  onForwardTo,
  information,
  homeSwitchDisabled,
  onSwitchHome,
}: {
  homeId: string;
  thread: CodexThread;
  title: string;
  homes: CodexHistoryHome[];
  preference: HistoryWorkbenchPreference;
  preferenceSaving: boolean;
  preferenceError: string;
  onPreferencePatch: (patch: HistoryWorkbenchPreferencePatch) => void;
  messages: HistorySelectableMessage[];
  selectedMessageIds: ReadonlySet<string>;
  bookmarks: ReadonlySet<string>;
  writerBusy: boolean;
  onInsertDraft: (insertion: HistoryDraftInsertion) => void;
  onForwardTo: (target: HistoryWorkbenchTarget, text: string, title: string) => void;
  information: ReactNode;
  homeSwitchDisabled: boolean;
  onSwitchHome: (homeId: string) => void;
}): ReactElement {
  const navigate = useNavigate();
  const target = useMemo(() => historyTarget(homeId, thread.id), [homeId, thread.id]);
  const targetKey = historyPreferenceKey(target);
  const currentTargetKeyRef = useRef(targetKey);
  currentTargetKeyRef.current = targetKey;
  const submitQueueDraft = useMemo(() => createHistoryQueueDraftSubmitter(), []);
  const queueSubmissionBusyRef = useRef(false);
  const [templates, setTemplates] = useState<HistoryWorkbenchTemplate[]>([]);
  const [templateError, setTemplateError] = useState("");
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<HistoryWorkbenchAction[]>([]);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [actionsError, setActionsError] = useState("");
  const [actionResponseId, setActionResponseId] = useState("");
  const [actionAnswers, setActionAnswers] = useState<Record<string, Record<string, string>>>({});
  const [actionNotice, setActionNotice] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const queueCloseRef = useRef<HTMLButtonElement | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsCloseRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPane, setMenuPane] = useState<"main" | "home">("main");
  const [utilityDialog, setUtilityDialog] = useState<"info" | "marks" | null>(null);
  const menuRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);
  const utilityCloseRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [queue, setQueue] = useState<HistoryQueueMessage[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [queueDraft, setQueueDraft] = useState("");
  const [queueBusy, setQueueBusy] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [forking, setForking] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardHome, setForwardHome] = useState(homeId);
  const [forwardQuery, setForwardQuery] = useState("");
  const [forwardResults, setForwardResults] = useState<CodexHistoryItem[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);
  const [forwardError, setForwardError] = useState("");
  const [cloneNotice, setCloneNotice] = useState("");
  const selectedText = useMemo(
    () => buildForwardedHistoryText(messages, selectedMessageIds, title),
    [messages, selectedMessageIds, title],
  );
  const activeTemplate = templates.find((template) => template.id === activeTemplateId) ?? null;
  const activeTemplateVariables = activeTemplate ? extractHistoryTemplateVariables(activeTemplate.text) : [];
  const activeTemplatePreview = activeTemplate ? fillHistoryTemplate(activeTemplate.text, templateValues) : null;

  useEffect(() => {
    const controller = new AbortController();
    void fetchHistoryTemplates(controller.signal)
      .then((next) => { if (!controller.signal.aborted) setTemplates(next); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setTemplateError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!queueOpen) return;
    const controller = new AbortController();
    setQueue([]);
    setEditingQueueId(null);
    setQueueLoading(true);
    setQueueError("");
    void fetchHistoryQueue(target, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setQueue(next); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setQueueError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!controller.signal.aborted) setQueueLoading(false); });
    return () => controller.abort();
  }, [queueOpen, target]);

  useEffect(() => {
    if (!menuOpen) return;
    menuPanelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const handleOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const handleMenuKeys = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (menuPane === "home") setMenuPane("main");
        else {
          setMenuOpen(false);
          menuTriggerRef.current?.focus();
        }
        return;
      }
      if (event.key === "Tab") { setMenuOpen(false); return; }
      const items = Array.from(menuPanelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = items.findIndex((item) => item === document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", handleOutside);
    window.addEventListener("keydown", handleMenuKeys);
    return () => {
      document.removeEventListener("pointerdown", handleOutside);
      window.removeEventListener("keydown", handleMenuKeys);
    };
  }, [menuOpen, menuPane]);

  const activeDialog = queueOpen ? "queue" : toolsOpen ? "tools" : utilityDialog;
  useEffect(() => {
    if (!activeDialog) return;
    const closeButton = activeDialog === "queue" ? queueCloseRef.current
      : activeDialog === "tools" ? toolsCloseRef.current : utilityCloseRef.current;
    closeButton?.focus();
    const dialog = closeButton?.closest<HTMLElement>("[role='dialog']");
    const handleDialogKeys = (event: KeyboardEvent): void => {
      if (document.querySelector(".history-tag-dialog")) return;
      if (event.key === "Escape") {
        setQueueOpen(false);
        setToolsOpen(false);
        setUtilityDialog(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]",
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && first && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && last && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      menuTriggerRef.current?.focus();
    };
  }, [activeDialog]);

  const refreshQueue = useCallback(async (failurePrefix = ""): Promise<void> => {
    setQueueLoading(true);
    setQueueError("");
    try {
      const next = await fetchHistoryQueue(target);
      if (currentTargetKeyRef.current === targetKey) setQueue(next);
    } catch (error: unknown) {
      if (currentTargetKeyRef.current === targetKey) {
        setQueueError(failurePrefix + (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if (currentTargetKeyRef.current === targetKey) setQueueLoading(false);
    }
  }, [target, targetKey]);

  const refreshActions = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await fetchHistoryActions(target, signal);
      if (!signal?.aborted) {
        setActions(next);
        setActionsError("");
      }
    } catch (error: unknown) {
      if (!signal?.aborted) setActionsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setActionsLoading(false);
    }
  }, [target]);

  useEffect(() => {
    const controller = new AbortController();
    setActions([]);
    setActionAnswers({});
    setActionNotice("");
    setActionsError("");
    setActionsLoading(true);
    void refreshActions(controller.signal);
    const timer = window.setInterval(() => { void refreshActions(controller.signal); }, 4_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refreshActions]);

  useEffect(() => {
    setForwardHome(homeId);
    setForwardQuery("");
    setForwardResults([]);
  }, [homeId, thread.id]);

  const respondToAction = async (
    action: HistoryWorkbenchAction,
    body: HistoryActionResponse,
  ): Promise<void> => {
    setActionResponseId(action.id);
    setActionNotice("");
    setActionsError("");
    try {
      await respondToHistoryAction(action.id, body);
      setActionNotice("响应已提交。");
      await refreshActions();
    } catch (error: unknown) {
      setActionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionResponseId("");
    }
  };

  const runQueueAction = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setQueueBusy(true);
    setQueueError("");
    try {
      await action();
      await refreshQueue();
      return true;
    } catch (error: unknown) {
      setQueueError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setQueueBusy(false);
    }
  }, [refreshQueue]);

  const addToQueue = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const text = queueDraft.trim();
    if (!text || queueBusy || queueSubmissionBusyRef.current) return;
    queueSubmissionBusyRef.current = true;
    setQueueBusy(true);
    setQueueError("");
    try {
      await submitQueueDraft(target, text);
      if (currentTargetKeyRef.current !== targetKey) return;
      setQueueDraft((current) => current.trim() === text ? "" : current);
      await refreshQueue("消息已加入队列，但刷新失败；请刷新核对，不要重复加入。 ");
    } catch (error: unknown) {
      if (currentTargetKeyRef.current === targetKey) {
        setQueueError(`加入队列失败或结果未确认：${error instanceof Error ? error.message : String(error)}。草稿已保留；重试会沿用同一幂等键。`);
      }
    } finally {
      queueSubmissionBusyRef.current = false;
      setQueueBusy(false);
    }
  };

  const searchForwardTargets = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setForwardLoading(true);
    setForwardError("");
    try {
      const result = await fetchCodexHistory({
        home: forwardHome || undefined,
        q: forwardQuery.trim() || undefined,
        archived: "active",
        limit: 20,
        offset: 0,
      });
      setForwardResults(result.items.filter((item) =>
        !(item.thread.id === thread.id && (item.preferredHomeId || item.home.id) === homeId)));
    } catch (error: unknown) {
      setForwardError(error instanceof Error ? error.message : String(error));
    } finally {
      setForwardLoading(false);
    }
  };

  const forwardTo = (item: CodexHistoryItem): void => {
    const nextTarget = historyTarget(item.preferredHomeId || item.home.id, item.thread.id);
    onForwardTo(nextTarget, selectedText, item.thread.name?.trim() || item.thread.preview?.trim() || "（无标题）");
  };

  const forkThread = async (): Promise<void> => {
    setForking(true);
    setForwardError("");
    try {
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const lastTurn = turns.at(-1);
      const lastTurnId = typeof asRecord(lastTurn).id === "string" ? String(asRecord(lastTurn).id) : undefined;
      const fork = await forkCodexHistoryThread(homeId, thread.id, lastTurnId);
      if (!fork.homeId || !fork.threadId) throw new Error("分叉接口未返回目标 Home 和 Thread。");
      navigate(`/codex-history/${encodeURIComponent(fork.homeId)}/${encodeURIComponent(fork.threadId)}`);
    } catch (error: unknown) {
      setForwardError(error instanceof Error ? error.message : String(error));
    } finally {
      setForking(false);
    }
  };

  const createCloneDraft = async (): Promise<void> => {
    setCloneBusy(true);
    setCloneNotice("");
    try {
      const projects = await fetchProjects();
      const matches = exactHistoryProjectMatches(thread.cwd, projects);
      if (matches.length !== 1) {
        setCloneNotice(matches.length === 0
          ? "没有已启用项目的完整路径与此 History cwd 精确匹配。请先在项目管理中登记该目录，再创建任务草稿。"
          : `有多个已启用项目匹配此目录（${matches.map((project) => project.name).join("、")}），请先整理项目注册表后再创建草稿。`);
        return;
      }
      navigate("/", { state: historyTaskDraftNavigationState(matches[0]!.name) });
    } catch (error: unknown) {
      setCloneNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setCloneBusy(false);
    }
  };

  const insertTemplate = (template: HistoryWorkbenchTemplate, text = template.text): void => {
    onInsertDraft({
      id: createRequestId(),
      text,
      ...(template.model ? { model: template.model } : {}),
      ...(template.reasoningEffort ? { reasoningEffort: template.reasoningEffort } : {}),
    });
    setActiveTemplateId(null);
    setTemplateValues({});
  };

  const selectTemplate = (template: HistoryWorkbenchTemplate): void => {
    if (!/\{\{[^{}]*\}\}/.test(template.text)) {
      insertTemplate(template);
      return;
    }
    setTemplateValues({});
    setActiveTemplateId(template.id);
  };

  const submitTemplate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!activeTemplate || activeTemplatePreview === null) return;
    insertTemplate(activeTemplate, activeTemplatePreview);
  };

  const openDialog = (next: "info" | "queue" | "tools" | "marks"): void => {
    setMenuOpen(false);
    if (next === "queue") setQueueOpen(true);
    else if (next === "tools") setToolsOpen(true);
    else setUtilityDialog(next);
  };
  const currentHomeLabel = homes.find((home) => home.id === homeId)?.label ?? homeId;

  return (
    <section ref={menuRef} className="history-workbench" aria-label="会话操作">
      <button
        ref={menuTriggerRef}
        className="history-session-menu-trigger"
        type="button"
        aria-label="会话操作"
        title="会话操作"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        onClick={() => { setMenuPane("main"); setMenuOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setMenuPane("main");
            setMenuOpen(true);
          }
        }}
      ><HistoryIcon name="more" />{actions.length ? <span className="history-tool-count">{actions.length}</span> : null}</button>
      {menuOpen ? <div ref={menuPanelRef} id={menuId} className="history-session-menu" role="menu" aria-label={menuPane === "home" ? "选择 Codex Home" : "会话操作菜单"}>
        {menuPane === "main" ? <>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => openDialog("info")}><HistoryIcon name="info" /><span>查看会话信息</span></button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => openDialog("queue")}><HistoryIcon name="queue" /><span>跟进队列</span>{queue.length ? <small>{queue.length}</small> : null}</button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => openDialog("tools")}><HistoryIcon name="tools" /><span>会话工具</span>{actions.length ? <small>待处理 {actions.length}</small> : null}</button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => openDialog("marks")}><HistoryIcon name="tag" /><span>标记与标签</span></button>
          <button className="history-session-menu-home" type="button" role="menuitem" tabIndex={-1} aria-haspopup="menu" disabled={homeSwitchDisabled} onClick={() => setMenuPane("home")}><span>Codex Home</span><small>{currentHomeLabel}</small><span aria-hidden="true">›</span></button>
        </> : <>
          <button className="history-session-menu-home-back" type="button" role="menuitem" tabIndex={-1} onClick={() => setMenuPane("main")}><span aria-hidden="true">‹</span><span>Codex Home</span><small>返回</small></button>
          {homes.map((home) => <button
            type="button"
            role="menuitemradio"
            tabIndex={-1}
            key={home.id}
            aria-checked={home.id === homeId}
            disabled={!home.available || homeSwitchDisabled}
            onClick={() => {
              setMenuOpen(false);
              menuTriggerRef.current?.focus();
              onSwitchHome(home.id);
            }}
          ><span>{home.label}{home.available ? "" : "（不可用）"}</span>{home.id === homeId ? <small>当前</small> : null}</button>)}
        </>}
      </div> : null}
      {utilityDialog ? <div className="history-tools-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setUtilityDialog(null);
      }}>
        <section className="history-tools-sheet history-utility-sheet" role="dialog" aria-modal="true" aria-label={utilityDialog === "info" ? "会话信息" : "标记与标签"}>
          <header>
            <div><strong>{utilityDialog === "info" ? "会话信息" : "标记与标签"}</strong><small>{title}</small></div>
            <button ref={utilityCloseRef} type="button" aria-label="关闭" onClick={() => setUtilityDialog(null)}>×</button>
          </header>
          <div className="history-tools-content">
            {utilityDialog === "info" ? information : <>
              <HistoryPreferenceControls preference={preference} saving={preferenceSaving} onPatch={onPreferencePatch} showLabels />
              {preference.tags.length ? <div className="history-preference-saved-tags">{preference.tags.map((tag) => <span className="history-tag-chip" key={tag}>{tag}</span>)}</div> : null}
              {preferenceError ? <p className="history-workbench-error" role="alert">组织偏好保存失败：{preferenceError}</p> : null}
            </>}
          </div>
        </section>
      </div> : null}
      {toolsOpen ? (
        <div className="history-tools-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setToolsOpen(false);
        }}>
          <section className="history-tools-sheet" role="dialog" aria-modal="true" aria-labelledby="history-tools-title">
            <header>
              <div><strong id="history-tools-title">会话工具</strong><small>{title} · {homeId}</small></div>
              <button ref={toolsCloseRef} type="button" aria-label="关闭会话工具" onClick={() => setToolsOpen(false)}>×</button>
            </header>
            <div className="history-tools-content">
          <details className="history-workbench-section" open={actions.length > 0 || undefined}>
            <summary>待处理请求{actions.length ? `（${actions.length}）` : ""}</summary>
            {actionsError ? <p className="history-workbench-error" role="alert">{actionsError}</p> : null}
            {actionNotice ? <p className="history-workbench-muted" role="status">{actionNotice}</p> : null}
            {actionsLoading && actions.length === 0 ? <p className="history-workbench-muted" role="status">正在检查待处理请求…</p> : null}
            {!actionsLoading && !actionsError && actions.length === 0 ? <p className="history-workbench-muted">当前会话没有待处理请求。</p> : null}
            <div className="history-action-list" aria-live="polite">
              {actions.map((action) => {
                const kind = historyActionKind(action);
                const questions = historyActionQuestions(action);
                const requestedPermissions = historyActionPermissions(action);
                const elicitationSchema = historyActionElicitationSchema(action);
                const answers = actionAnswers[action.id] ?? {};
                const status = action.status?.toLowerCase() ?? "pending";
                const expired = typeof action.expiresAt === "number" && action.expiresAt <= Date.now();
                const pending = !expired && ["pending", "waiting", "open", "requested"].includes(status);
                const answered = questions.length > 0 && questions.every((question) => Boolean(answers[question.id]?.trim()));
                return (
                  <article className="history-action-card" key={action.id}>
                    <header>
                      <strong>{kind === "approval" ? "Codex 审批" : kind === "permissions" ? "Codex 权限申请" : kind === "elicitation" ? "MCP 请求" : kind === "question" ? "Codex 提问" : "Codex 请求"}</strong>
                      <span>{expired ? "expired" : status}</span>
                    </header>
                    <p>{historyActionSummary(action)}</p>
                    <small className="history-action-target">Home {homeId} · Thread {thread.id}</small>
                    {kind === "approval" ? (
                      <div className="history-action-controls">
                        <button type="button" disabled={!pending || actionResponseId === action.id} onClick={() => void respondToAction(action, { decision: "accept" })}>允许</button>
                        <button type="button" disabled={!pending || actionResponseId === action.id} onClick={() => void respondToAction(action, { decision: "decline" })}>拒绝</button>
                      </div>
                    ) : kind === "permissions" && requestedPermissions ? (
                      <div className="history-action-permissions">
                        <p>本次请求的权限：</p>
                        <pre>{JSON.stringify(requestedPermissions, null, 2)}</pre>
                        <small>允许仅授予以上权限，并限定在当前 turn；拒绝不会授予任何权限。</small>
                        <div className="history-action-controls">
                          <button
                            type="button"
                            disabled={!pending || actionResponseId === action.id}
                            onClick={() => void respondToAction(action, { permissions: requestedPermissions, scope: "turn" })}
                          >允许本次请求</button>
                          <button
                            type="button"
                            disabled={!pending || actionResponseId === action.id}
                            onClick={() => void respondToAction(action, { permissions: {}, scope: "turn" })}
                          >拒绝</button>
                        </div>
                      </div>
                    ) : kind === "question" && questions.length > 0 ? (
                      <div className="history-action-questions">
                        {questions.map((question) => (
                          <label key={question.id}>
                            <span>{question.prompt}</span>
                            {question.options.length > 0 ? (
                              <select
                                value={answers[question.id] ?? ""}
                                disabled={!pending || actionResponseId === action.id}
                                onChange={(event) => setActionAnswers((current) => ({
                                  ...current,
                                  [action.id]: { ...current[action.id], [question.id]: event.currentTarget.value },
                                }))}
                              >
                                <option value="">选择答案</option>
                                {question.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                              </select>
                            ) : (
                              <textarea
                                rows={2}
                                value={answers[question.id] ?? ""}
                                disabled={!pending || actionResponseId === action.id}
                                onChange={(event) => setActionAnswers((current) => ({
                                  ...current,
                                  [action.id]: { ...current[action.id], [question.id]: event.currentTarget.value },
                                }))}
                              />
                            )}
                          </label>
                        ))}
                        <button type="button" disabled={!pending || !answered || actionResponseId === action.id} onClick={() => void respondToAction(action, { answers })}>
                          {actionResponseId === action.id ? "提交中…" : "提交答案"}
                        </button>
                      </div>
                    ) : kind === "elicitation" ? (
                      <div className="history-action-permissions">
                        {elicitationSchema === null
                          ? <p>此请求未提供可展示的表单 schema，不能安全接受。</p>
                          : <><p>请求 schema（只读）：</p><pre>{JSON.stringify(elicitationSchema, null, 2)}</pre></>}
                        <small>当前仅提供显式拒绝；支持 schema 表单后再开放接受。</small>
                        <div className="history-action-controls">
                          <button
                            type="button"
                            disabled={!pending || actionResponseId === action.id}
                            onClick={() => void respondToAction(action, { action: "decline", content: null })}
                          >拒绝请求</button>
                        </div>
                      </div>
                    ) : (
                      <p className="history-workbench-muted">此请求没有可识别的响应字段，暂不能安全处理。</p>
                    )}
                  </article>
                );
              })}
            </div>
          </details>

          <details className="history-workbench-section">
            <summary>轮次导航与收藏</summary>
            {messages.length === 0 ? <p className="history-workbench-muted">暂无可导航的消息。</p> : (
              <nav className="history-turn-directory" aria-label="History 轮次目录">
                {[...new Set(messages.map((message) => message.turnIndex))].map((turnIndex) => {
                  const turnMessages = messages.filter((message) => message.turnIndex === turnIndex);
                  const excerpt = turnMessages[0]?.text.replace(/\s+/g, " ").slice(0, 72) || "（无文本）";
                  const turnBookmarks = turnMessages.filter((message) => bookmarks.has(message.id)).length;
                  return (
                    <button
                      key={turnIndex}
                      type="button"
                      onClick={() => {
                        setToolsOpen(false);
                        jumpToHistoryMessage(turnMessages[0]?.id);
                      }}
                    >
                      <span>第 {turnIndex + 1} 轮{turnBookmarks ? ` · ${turnBookmarks} 项收藏` : ""}</span>
                      <small>{excerpt}</small>
                    </button>
                  );
                })}
              </nav>
            )}
            <p className="history-workbench-muted">消息右上角的书签用于收藏重要内容；目录会显示每轮收藏数量。收藏保存在当前浏览器，按设备与会话区分。</p>
          </details>

          <details className="history-workbench-section">
            <summary>消息模板</summary>
            {templateError ? <p className="history-workbench-error" role="alert">{templateError}</p> : null}
            {templates.length === 0 && !templateError
              ? <p className="history-workbench-muted">当前没有可用模板。</p>
              : templates.map((template) => (
                  <div className="history-template-row" key={template.id}>
                    <div>
                      <strong>{template.title}</strong>
                      <small>{[template.projectKey, template.model, template.reasoningEffort].filter(Boolean).join(" · ") || "适用于当前草稿"}</small>
                    </div>
                    <button type="button" onClick={() => selectTemplate(template)}>
                      {/\{\{[^{}]*\}\}/.test(template.text) ? "填写变量" : "插入草稿"}
                    </button>
                  </div>
                ))}
            {activeTemplate ? (
              <form className="history-template-fill" onSubmit={submitTemplate}>
                <strong>{activeTemplate.title} · 填写变量</strong>
                {activeTemplateVariables.map((variable) => (
                  <label key={variable}>
                    <span>{variable}</span>
                    <input
                      aria-label={`模板变量：${variable}`}
                      value={templateValues[variable] ?? ""}
                      onChange={(event) => setTemplateValues((current) => ({ ...current, [variable]: event.currentTarget.value }))}
                    />
                  </label>
                ))}
                {activeTemplatePreview === null
                  ? <p className="history-workbench-error" role="status">请填写所有变量；空变量名或未替换的 {"{{…}}"} 不能插入。</p>
                  : <pre aria-label="模板插入预览">{activeTemplatePreview}</pre>}
                <div>
                  <button type="submit" disabled={activeTemplatePreview === null}>插入到当前草稿</button>
                  <button type="button" onClick={() => { setActiveTemplateId(null); setTemplateValues({}); }}>取消</button>
                </div>
              </form>
            ) : null}
          </details>

          <details className="history-workbench-section" open={forwardOpen} onToggle={(event) => setForwardOpen(event.currentTarget.open)}>
            <summary>转发所选消息到草稿{selectedMessageIds.size ? `（${selectedMessageIds.size}）` : ""}</summary>
            <form className="history-forward-search" onSubmit={(event) => void searchForwardTargets(event)}>
              <label>
                <span>目标 Home</span>
                <select value={forwardHome} onChange={(event) => setForwardHome(event.currentTarget.value)}>
                  <option value="">全部 Home</option>
                  {homes.map((home) => <option key={home.id} value={home.id} disabled={!home.available}>{home.label}</option>)}
                </select>
              </label>
              <label>
                <span>查找目标会话</span>
                <input value={forwardQuery} onChange={(event) => setForwardQuery(event.currentTarget.value)} placeholder="标题、最近消息或 Thread ID" />
              </label>
              <button type="submit" disabled={forwardLoading || selectedMessageIds.size === 0}>{forwardLoading ? "查找中…" : "查找会话"}</button>
            </form>
            {forwardError ? <p className="history-workbench-error" role="alert">{forwardError}</p> : null}
            <div className="history-forward-results" aria-live="polite">
              {forwardResults.map((item) => {
                const targetHomeId = item.preferredHomeId || item.home.id;
                const threadTitle = item.thread.name?.trim() || item.thread.preview?.trim() || "（无标题）";
                return (
                  <article key={`${targetHomeId}:${item.thread.id}`}>
                    <div><strong>{threadTitle}</strong><small>Home {targetHomeId} · Thread {item.thread.id}</small></div>
                    <button type="button" onClick={() => forwardTo(item)}>放入此会话草稿</button>
                  </article>
                );
              })}
            </div>
          </details>

          <div className="history-workbench-actions">
            <button type="button" disabled={forking} onClick={() => void forkThread()}>{forking ? "正在分叉…" : "官方分叉"}</button>
            <button type="button" disabled={cloneBusy || !thread.cwd} onClick={() => void createCloneDraft()}>
              {cloneBusy ? "正在检查项目…" : "新建同目录任务草稿"}
            </button>
          </div>
          <p className="history-workbench-muted">
            {!thread.cwd ? "当前 History 会话未提供 cwd，无法匹配项目。" : "仅在 History cwd 与已启用项目路径完全匹配时创建草稿。"}
            {"不会继承 Home 或模型，也不会执行提示词。"}
          </p>
          {cloneNotice ? <p className="history-workbench-muted" role="status">{cloneNotice}</p> : null}
          {forwardError && !forwardOpen ? <p className="history-workbench-error" role="alert">{forwardError}</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {queueOpen ? (
        <div className="history-queue-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setQueueOpen(false);
        }}>
          <section className="history-queue-sheet" role="dialog" aria-modal="true" aria-labelledby="history-queue-title">
            <header>
              <div><strong id="history-queue-title">History 跟进队列</strong><small>{title} · {homeId}</small></div>
              <button ref={queueCloseRef} type="button" aria-label="关闭跟进队列" onClick={() => setQueueOpen(false)}>×</button>
            </header>
            <p className="history-workbench-muted">队列中的消息会在会话空闲后按顺序发送；可编辑、排序或删除。结果未知的消息不会自动重发。</p>
            {queueError ? <p className="history-workbench-error" role="alert">{queueError}</p> : null}
            {queueLoading ? <p className="history-workbench-muted" role="status">正在读取队列…</p> : null}
            <div className="history-queue-list" aria-live="polite">
              {queue.map((message) => {
                const queuedMessages = queue.filter((item) => item.status === "queued");
                const queuedIndex = queuedMessages.findIndex((item) => item.id === message.id);
                return (
                <article key={message.id} className="history-queue-item">
                  {editingQueueId === message.id ? (
                    <textarea aria-label="编辑队列消息" maxLength={8000} value={editingQueueText} onChange={(event) => setEditingQueueText(event.currentTarget.value)} />
                  ) : <p>{message.text}</p>}
                  <div className="history-queue-item-meta">
                    <span className={`history-queue-status is-${message.status}`}>{queueStatusLabel(message.status)}</span>
                    {message.error ? <span>{message.error}</span> : null}
                  </div>
                  <div className="history-queue-item-actions">
                    {message.status === "queued" && editingQueueId === message.id ? (
                      <>
                        <button type="button" disabled={queueBusy} onClick={() => void runQueueAction(async () => {
                          await updateHistoryQueueMessage(message.id, { text: editingQueueText.trim() });
                          setEditingQueueId(null);
                        })}>保存</button>
                        <button type="button" disabled={queueBusy} onClick={() => setEditingQueueId(null)}>取消</button>
                      </>
                    ) : message.status === "queued" ? (
                      <>
                        <button type="button" disabled={queueBusy || queuedIndex <= 0} aria-label="上移队列消息" onClick={() => void runQueueAction(() => updateHistoryQueueMessage(message.id, { move: "up" }))}>↑</button>
                        <button type="button" disabled={queueBusy || queuedIndex < 0 || queuedIndex === queuedMessages.length - 1} aria-label="下移队列消息" onClick={() => void runQueueAction(() => updateHistoryQueueMessage(message.id, { move: "down" }))}>↓</button>
                        <button type="button" disabled={queueBusy} onClick={() => { setEditingQueueId(message.id); setEditingQueueText(message.text); }}>编辑</button>
                        <button type="button" disabled={queueBusy || writerBusy || queuedIndex !== 0} onClick={() => void runQueueAction(() => sendHistoryQueueMessage(message.id))}>立即发送</button>
                        <button type="button" disabled={queueBusy} onClick={() => void runQueueAction(() => deleteHistoryQueueMessage(message.id))}>删除</button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={queueBusy}
                        onClick={() => onInsertDraft({ id: createRequestId(), text: message.text, ...(message.model ? { model: message.model } : {}), ...(message.reasoningEffort ? { reasoningEffort: message.reasoningEffort } : {}) })}
                      >放入草稿</button>
                    )}
                  </div>
                </article>
                );
              })}
              {!queueLoading && queue.length === 0 ? <p className="history-workbench-muted">队列为空。</p> : null}
            </div>
            <form className="history-queue-add" onSubmit={(event) => void addToQueue(event)}>
              <label htmlFor="history-queue-draft">新增跟进</label>
              <textarea id="history-queue-draft" maxLength={8000} value={queueDraft} onChange={(event) => setQueueDraft(event.currentTarget.value)} rows={2} placeholder="加入后会在原会话空闲时自动发送" />
              <button type="submit" disabled={queueBusy || !queueDraft.trim()}>加入队列</button>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export function HistoryMessageActions({
  messageId,
  selected,
  bookmarked,
  onToggleSelected,
  onToggleBookmark,
}: {
  messageId: string;
  selected: boolean;
  bookmarked: boolean;
  onToggleSelected: (messageId: string) => void;
  onToggleBookmark: (messageId: string) => void;
}): ReactElement {
  return (
    <div className="history-message-actions" aria-label="消息操作">
      <button type="button" aria-pressed={selected} aria-label={selected ? "取消转发此消息" : "选择此消息转发"} title={selected ? "取消转发此消息" : "选择此消息转发"} onClick={() => onToggleSelected(messageId)}>
        <HistoryIcon name="forward" />
      </button>
      <button type="button" aria-pressed={bookmarked} aria-label={bookmarked ? "取消收藏此消息" : "收藏此消息"} title={bookmarked ? "取消收藏此消息" : "收藏此消息"} onClick={() => onToggleBookmark(messageId)}>
        <HistoryIcon name="bookmark" />
      </button>
    </div>
  );
}

function jumpToHistoryMessage(messageId?: string): void {
  if (!messageId) return;
  const element = document.getElementById(messageId);
  element?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function queueStatusLabel(status: HistoryQueueMessage["status"]): string {
  const labels: Record<HistoryQueueMessage["status"], string> = {
    queued: "待发送",
    sending: "发送中",
    sent: "已发送",
    failed: "失败",
    unconfirmed: "结果未知",
  };
  return labels[status];
}

function createRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
