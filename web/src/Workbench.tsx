import { useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { useNavigate } from "react-router";

import {
  createWorkbenchTemplate,
  deleteWorkbenchTemplate,
  dismissWorkbenchNotification,
  fetchWorkbenchInbox,
  fetchWorkbenchSettings,
  fetchWorkbenchTemplates,
  respondWorkbenchAction,
  updateWorkbenchTemplate,
  type WorkbenchInbox,
  type WorkbenchActionResponse,
  type WorkbenchNotification,
  type WorkbenchPendingAction,
  type WorkbenchTemplate,
  type WorkbenchTarget,
} from "./workbench-api.js";
import "./workbench.css";

interface WorkbenchSnapshot {
  inbox: WorkbenchInbox;
  loading: boolean;
  error: string | null;
  settingsError: string | null;
}

const EMPTY_INBOX: WorkbenchInbox = { actions: [], notifications: [], connection: { state: "connecting" } };
const INITIAL_SNAPSHOT: WorkbenchSnapshot = { inbox: EMPTY_INBOX, loading: true, error: null, settingsError: null };
const snapshotListeners = new Set<() => void>();
const seenNotificationIds = new Set<string>();
let workbenchSnapshot = INITIAL_SNAPSHOT;
let initialNotificationBaselineEstablished = false;
let workbenchPoll: Promise<void> | null = null;
let navigateToNotification: ((route: string) => void) | null = null;
let inboxMutationRevision = 0;

function subscribeWorkbenchSnapshot(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

function getWorkbenchSnapshot(): WorkbenchSnapshot {
  return workbenchSnapshot;
}

function publishWorkbenchSnapshot(next: WorkbenchSnapshot): void {
  workbenchSnapshot = next;
  for (const listener of snapshotListeners) listener();
}

export function refreshWorkbenchInbox(options: { quiet?: boolean } = {}): Promise<void> {
  if (workbenchPoll) return workbenchPoll;
  const poll = pollWorkbenchInbox(options.quiet === true).finally(() => {
    if (workbenchPoll === poll) workbenchPoll = null;
  });
  workbenchPoll = poll;
  return poll;
}

async function pollWorkbenchInbox(quiet: boolean): Promise<void> {
  const mutationRevision = inboxMutationRevision;
  publishWorkbenchSnapshot({ ...workbenchSnapshot, loading: quiet ? workbenchSnapshot.loading : true, error: null });
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    publishWorkbenchSnapshot({
      ...workbenchSnapshot,
      loading: false,
      error: "当前设备离线。恢复网络后会自动重连。",
      inbox: { ...workbenchSnapshot.inbox, connection: { ...workbenchSnapshot.inbox.connection, state: "disconnected" } },
    });
    return;
  }

  const [inboxResult, settingsResult] = await Promise.allSettled([
    fetchWorkbenchInbox(),
    fetchWorkbenchSettings(),
  ]);
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    publishWorkbenchSnapshot({
      ...workbenchSnapshot,
      loading: false,
      error: "当前设备离线。恢复网络后会自动重连。",
      inbox: { ...workbenchSnapshot.inbox, connection: { ...workbenchSnapshot.inbox.connection, state: "disconnected" } },
    });
    return;
  }
  if (mutationRevision !== inboxMutationRevision) {
    await pollWorkbenchInbox(true);
    return;
  }
  let inbox = workbenchSnapshot.inbox;
  let error: string | null = null;
  let settingsError: string | null = null;

  if (inboxResult.status === "fulfilled") {
    inbox = inboxResult.value;
    const browserNotificationsEnabled = settingsResult.status === "fulfilled"
      && settingsResult.value.settings.notifications.browser;
    observeWorkbenchNotifications(inbox.notifications, browserNotificationsEnabled);
  } else {
    error = toError(inboxResult.reason);
    inbox = { ...inbox, connection: { ...inbox.connection, state: "disconnected" } };
  }
  if (settingsResult.status === "rejected") settingsError = toError(settingsResult.reason);

  publishWorkbenchSnapshot({ inbox, loading: false, error, settingsError });
}

function observeWorkbenchNotifications(notifications: WorkbenchNotification[], enabled: boolean): void {
  if (!initialNotificationBaselineEstablished) {
    for (const notification of notifications) rememberSeenNotification(notification.id);
    initialNotificationBaselineEstablished = true;
    return;
  }
  for (const notification of notifications) {
    if (seenNotificationIds.has(notification.id)) continue;
    rememberSeenNotification(notification.id);
    if (!enabled || typeof Notification === "undefined" || Notification.permission !== "granted") continue;
    try {
      const notice = new Notification(notification.title, {
        body: notification.body ?? "",
        tag: `bridge-workbench-${notification.id}`,
      });
      notice.onclick = () => {
        window.focus();
        const route = notificationRoute(notification);
        if (navigateToNotification) navigateToNotification(route);
        else window.location.assign(route);
        notice.close();
      };
    } catch {
      // Browser notification failures do not affect the in-app inbox.
    }
  }
}

function rememberSeenNotification(id: string): void {
  seenNotificationIds.add(id);
  while (seenNotificationIds.size > 1_000) {
    const oldest = seenNotificationIds.values().next().value as string | undefined;
    if (!oldest) break;
    seenNotificationIds.delete(oldest);
  }
}

export function WorkbenchNotifications(): null {
  const navigate = useNavigate();
  useEffect(() => {
    const goToNotification = (route: string): void => { void navigate(route); };
    navigateToNotification = goToNotification;
    void refreshWorkbenchInbox();
    const timer = window.setInterval(() => void refreshWorkbenchInbox({ quiet: true }), 30_000);
    const handleOnline = (): void => { void refreshWorkbenchInbox(); };
    const handleOffline = (): void => {
      publishWorkbenchSnapshot({
        ...workbenchSnapshot,
        loading: false,
        error: "当前设备离线。恢复网络后会自动重连。",
        inbox: { ...workbenchSnapshot.inbox, connection: { ...workbenchSnapshot.inbox.connection, state: "disconnected" } },
      });
    };
    const handleVisibility = (): void => {
      if (document.visibilityState === "visible") void refreshWorkbenchInbox({ quiet: true });
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (navigateToNotification === goToNotification) navigateToNotification = null;
    };
  }, [navigate]);
  return null;
}

export function Workbench(): ReactElement {
  const navigate = useNavigate();
  const snapshot = useSyncExternalStore(subscribeWorkbenchSnapshot, getWorkbenchSnapshot, getWorkbenchSnapshot);
  const { inbox, loading, error, settingsError } = snapshot;
  const [activePanel, setActivePanel] = useState<"actions" | "notifications" | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());

  const nextActionExpiry = inbox.actions.reduce<number | null>((earliest, action) => {
    const expiresAt = action.expiresAt;
    return typeof expiresAt === "number" && expiresAt > clockNow && (earliest === null || expiresAt < earliest) ? expiresAt : earliest;
  }, null);
  useEffect(() => {
    if (nextActionExpiry === null) return;
    const timer = window.setTimeout(() => setClockNow(Date.now()), Math.max(0, nextActionExpiry - Date.now() + 5));
    return () => window.clearTimeout(timer);
  }, [clockNow, nextActionExpiry]);

  const openTarget = (target?: WorkbenchTarget, route?: string): void => {
    navigate(safeWorkbenchRoute(route) ?? targetRoute(target));
  };

  const dismiss = async (id: string): Promise<void> => {
    if (dismissingId) return;
    setDismissingId(id);
    setDismissError(null);
    try {
      await dismissWorkbenchNotification(id);
      inboxMutationRevision += 1;
      publishWorkbenchSnapshot({ ...workbenchSnapshot, inbox: {
        ...workbenchSnapshot.inbox,
        notifications: workbenchSnapshot.inbox.notifications.filter((item) => item.id !== id),
      } });
      await refreshWorkbenchInbox({ quiet: true });
    } catch (failure) {
      setDismissError(toError(failure));
    } finally {
      setDismissingId(null);
    }
  };

  const respond = async (action: WorkbenchPendingAction, response: WorkbenchActionResponse): Promise<void> => {
    if (respondingId || action.status === "expired" || (action.expiresAt !== undefined && action.expiresAt <= Date.now())) return;
    setRespondingId(action.id);
    setActionErrors((current) => { const next = { ...current }; delete next[action.id]; return next; });
    try {
      await respondWorkbenchAction(action.id, response);
      inboxMutationRevision += 1;
      publishWorkbenchSnapshot({ ...workbenchSnapshot, inbox: {
        ...workbenchSnapshot.inbox,
        actions: workbenchSnapshot.inbox.actions.filter((item) => item.id !== action.id),
      } });
      await refreshWorkbenchInbox({ quiet: true });
    } catch (failure) {
      setActionErrors((current) => ({ ...current, [action.id]: toError(failure) }));
    } finally { setRespondingId(null); }
  };

  const connectionState = inbox.connection.state;
  const connectionLabel = connectionState === "connected" ? "已连接"
    : connectionState === "connecting" ? "连接中" : "连接中断";
  const actions = inbox.actions.filter((action) => action.status !== "resolved");

  return <section className="workbench-inbox" aria-label="待处理与通知中心">
    <div className="workbench-inbox-summary">
      <button id="workbench-actions-trigger" className={`workbench-inbox-trigger${actions.length ? " has-items" : ""}`} type="button" aria-expanded={activePanel === "actions"} aria-controls="workbench-actions-panel" onClick={() => setActivePanel((value) => value === "actions" ? null : "actions")}>
        待处理 <span>{actions.length}</span>
      </button>
      <button id="workbench-notifications-trigger" className={`workbench-inbox-trigger${inbox.notifications.length ? " has-items" : ""}`} type="button" aria-expanded={activePanel === "notifications"} aria-controls="workbench-notifications-panel" onClick={() => setActivePanel((value) => value === "notifications" ? null : "notifications")}>
        通知 <span>{inbox.notifications.length}</span>
      </button>
      {loading || (!actions.length && !inbox.notifications.length && !error) ? <span className="workbench-inbox-idle">{loading ? "读取中…" : "暂无新动态"}</span> : null}
      <span className={`workbench-connection workbench-inbox-connection workbench-connection-${connectionState === "connected" ? "connected" : connectionState === "connecting" ? "connecting" : "disconnected"}`} role="status" aria-label={`通知${connectionLabel}`} title={`通知${connectionLabel}`} />
    </div>

    {error ? <div className="workbench-inline-error" role="alert">
      <span>读取待处理与通知失败：{error}</span>
      <button type="button" onClick={() => void refreshWorkbenchInbox()} disabled={loading}>重试</button>
    </div> : null}
    {settingsError ? <p className="workbench-muted" role="status">浏览器通知偏好暂不可用；站内通知仍可查看。{settingsError}</p> : null}
    {dismissError ? <div className="workbench-inline-error" role="alert">通知操作失败：{dismissError}<button type="button" onClick={() => void refreshWorkbenchInbox()}>刷新</button></div> : null}

    <section className="workbench-inbox-panel" id="workbench-actions-panel" aria-labelledby="workbench-actions-trigger" hidden={activePanel !== "actions"}>
      <header className="workbench-inbox-panel-head"><h3>待处理请求</h3><button type="button" onClick={() => setActivePanel(null)}>收起</button></header>
      {actions.length ? <ul className="workbench-card-list">
        {actions.map((action) => <PendingActionCard
          action={action}
          now={clockNow}
          busy={respondingId === action.id}
          error={actionErrors[action.id]}
          onOpen={openTarget}
          onRespond={(response) => void respond(action, response)}
          key={action.id}
        />)}
      </ul> : <p className="workbench-empty">{loading ? "正在读取…" : "暂无待处理请求"}</p>}
    </section>
    <section className="workbench-inbox-panel" id="workbench-notifications-panel" aria-labelledby="workbench-notifications-trigger" hidden={activePanel !== "notifications"}>
      <header className="workbench-inbox-panel-head"><h3>站内通知</h3><button type="button" onClick={() => setActivePanel(null)}>收起</button></header>
      {inbox.notifications.length ? <ul className="workbench-card-list">
        {inbox.notifications.map((notification) => <NotificationCard
          notification={notification}
          busy={dismissingId === notification.id}
          onOpen={openTarget}
          onDismiss={() => void dismiss(notification.id)}
          key={notification.id}
        />)}
      </ul> : <p className="workbench-empty">{loading ? "正在读取…" : "暂无新通知"}</p>}
    </section>
  </section>;
}

function PendingActionCard({ action, now, busy, error, onOpen, onRespond }: {
  action: WorkbenchPendingAction;
  now: number;
  busy: boolean;
  error?: string;
  onOpen: (target?: WorkbenchTarget, route?: string) => void;
  onRespond: (response: WorkbenchActionResponse) => void;
}): ReactElement {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [elicitationText, setElicitationText] = useState("{}");
  const [responseError, setResponseError] = useState<string | null>(null);
  const expired = action.status === "expired" || (typeof action.expiresAt === "number" && action.expiresAt <= now);
  const method = action.method ?? stringValue(action.payload?.method);
  const params = action.params ?? recordValue(action.payload?.params) ?? action.payload ?? {};
  const payloadText = action.body ?? getActionPrompt(params);
  const questions = Array.isArray(params.questions) ? params.questions.map(readActionQuestion).filter((question): question is ActionQuestion => question !== null) : [];
  const permissions = recordValue(params.permissions) ?? {};
  const simpleApproval = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "applyPatchApproval", "execCommandApproval"].includes(method ?? "");
  const questionAction = method === "item/tool/requestUserInput" && questions.length > 0;
  const permissionAction = method === "item/permissions/requestApproval";
  const elicitationAction = method === "mcpServer/elicitation/request";
  const canRespond = simpleApproval || questionAction || permissionAction || elicitationAction;
  const submitAnswers = (): void => {
    if (questions.some((question) => !answerIsFilled(answers[question.id]))) return;
    onRespond({ answers });
  };
  const submitPermissions = (): void => {
    onRespond({ permissions: Object.fromEntries(selectedPermissions.map((key) => [key, permissions[key]])), scope: "turn" });
  };
  const acceptElicitation = (): void => {
    try { onRespond({ action: "accept", content: JSON.parse(elicitationText) as unknown }); }
    catch { setResponseError("请输入有效 JSON。"); }
  };
  return <li className={`workbench-card${expired ? " is-expired" : ""}`}>
    <div className="workbench-card-heading">
      <strong>{action.title || actionTypeLabel(action.type)}</strong>
      <span className={expired ? "workbench-expired" : "workbench-pending"}>{expired ? "已过期" : "待处理"}</span>
    </div>
    {payloadText ? <p>{payloadText}</p> : null}
    {method && params && Object.keys(params).length ? <details className="workbench-action-details"><summary>请求详情</summary><pre>{compactActionParams(params)}</pre></details> : null}
    <small>{action.runId ? `Run ${action.runId}` : action.requestId ? `请求 ${action.requestId}` : ""}</small>
    {error ? <div className="workbench-action-error" role="alert">{error}</div> : null}
    {responseError ? <div className="workbench-action-error" role="alert">{responseError}</div> : null}
    {simpleApproval ? <div className="workbench-action-controls">
      <button type="button" className="primary" disabled={expired || busy} onClick={() => onRespond({ decision: "accept" })}>{busy ? "提交中…" : "允许一次"}</button>
      <button type="button" disabled={expired || busy} onClick={() => onRespond({ decision: "decline" })}>拒绝</button>
    </div> : null}
    {questionAction ? <div className="workbench-action-form">
      {questions.map((question) => <label key={question.id}>{question.question}
        {question.options.length ? <select value={typeof answers[question.id] === "string" ? answers[question.id] as string : ""} disabled={expired || busy} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}>
          <option value="">选择答案</option>{question.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select> : <textarea rows={2} value={typeof answers[question.id] === "string" ? answers[question.id] as string : ""} disabled={expired || busy} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
      </label>)}
      <button type="button" className="primary" disabled={expired || busy || questions.some((question) => !answerIsFilled(answers[question.id]))} onClick={submitAnswers}>{busy ? "提交中…" : "提交回答"}</button>
    </div> : null}
    {permissionAction ? <div className="workbench-action-form">
      <p className="workbench-muted">只会提交你明确勾选的请求权限，并限定在本轮。</p>
      {Object.entries(permissions).map(([key, value]) => <label className="workbench-permission-option" key={key}><input type="checkbox" checked={selectedPermissions.includes(key)} disabled={expired || busy} onChange={(event) => setSelectedPermissions((current) => event.target.checked ? [...current, key] : current.filter((item) => item !== key))} /><span><strong>{key}</strong><small>{JSON.stringify(value)}</small></span></label>)}
      <div className="workbench-action-controls"><button type="button" className="primary" disabled={expired || busy || !selectedPermissions.length} onClick={submitPermissions}>仅批准所选权限</button><button type="button" disabled={expired || busy} onClick={() => onRespond({ permissions: {}, scope: "turn" })}>拒绝全部</button></div>
    </div> : null}
    {elicitationAction ? <div className="workbench-action-form">
      <label>回应内容（JSON）<textarea rows={4} value={elicitationText} disabled={expired || busy} onChange={(event) => setElicitationText(event.target.value)} /></label>
      <div className="workbench-action-controls"><button type="button" className="primary" disabled={expired || busy} onClick={acceptElicitation}>接受</button><button type="button" disabled={expired || busy} onClick={() => onRespond({ action: "decline", content: null })}>拒绝</button></div>
    </div> : null}
    {expired ? <span className="workbench-expired">已过期，无法操作</span> : !canRespond ? <p className="workbench-muted">此请求类型目前只展示原始信息，请在关联会话中处理。</p> : null}
    <button type="button" className="workbench-secondary-button" disabled={expired} onClick={() => onOpen(action.target, action.route)}>
      {expired ? "请求已过期" : action.target?.kind === "history" ? "打开关联会话" : "打开关联任务"}
    </button>
  </li>;
}

function NotificationCard({ notification, busy, onOpen, onDismiss }: {
  notification: WorkbenchNotification;
  busy: boolean;
  onOpen: (target?: WorkbenchTarget, route?: string) => void;
  onDismiss: () => void;
}): ReactElement {
  return <li className="workbench-card">
    <button className="workbench-card-main" type="button" onClick={() => onOpen(notification.target, notification.route)}>
      <strong>{notification.title}</strong>
      {notification.body ? <span>{notification.body}</span> : null}
      <small>{categoryLabel(notification.category)} · {formatWorkbenchDate(notification.createdAt)}</small>
    </button>
    <button type="button" className="workbench-secondary-button" onClick={onDismiss} disabled={busy}>
      {busy ? "处理中…" : "知道了"}
    </button>
  </li>;
}

export function PromptTemplatePicker({
  projectKey,
  projects,
  onApply,
  disabled = false,
}: {
  projectKey?: string;
  projects?: string[];
  onApply: (text: string, template: WorkbenchTemplate) => void;
  disabled?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<WorkbenchTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", text: "", projectKey: "", model: "", reasoningEffort: "" });
  const [saving, setSaving] = useState(false);
  const [variableTemplate, setVariableTemplate] = useState<WorkbenchTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWorkbenchTemplates();
      setTemplates(result.templates);
      setLoaded(true);
    } catch (failure) {
      setError(toError(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  const beginEdit = (template?: WorkbenchTemplate): void => {
    setEditingId(template?.id ?? "new");
    setForm({
      title: template?.title ?? "",
      text: template?.text ?? "",
      projectKey: template?.projectKey ?? "",
      model: template?.model ?? "",
      reasoningEffort: template?.reasoningEffort ?? "",
    });
    setError(null);
  };

  const save = async (): Promise<void> => {
    if (!form.title.trim() || !form.text.trim() || saving) return;
    setSaving(true);
    setError(null);
    const payload = {
      title: form.title.trim(),
      text: form.text,
      ...(form.projectKey.trim() ? { projectKey: form.projectKey.trim() } : {}),
      ...(form.model.trim() ? { model: form.model.trim() } : {}),
      ...(form.reasoningEffort.trim() ? { reasoningEffort: form.reasoningEffort.trim() } : {}),
    };
    try {
      const result = editingId && editingId !== "new"
        ? await updateWorkbenchTemplate(editingId, payload)
        : await createWorkbenchTemplate(payload);
      setTemplates((current) => [result.template, ...current.filter((item) => item.id !== result.template.id)]);
      setEditingId(null);
    } catch (failure) {
      setError(toError(failure));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (template: WorkbenchTemplate): Promise<void> => {
    if (!window.confirm(`删除提示词模板“${template.title}”？`)) return;
    setError(null);
    try {
      await deleteWorkbenchTemplate(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
    } catch (failure) {
      setError(toError(failure));
    }
  };

  const insert = (template: WorkbenchTemplate): void => {
    const names = templateVariables(template.text);
    if (!names.length) {
      onApply(template.text, template);
      return;
    }
    setVariableTemplate(template);
    setVariableValues(Object.fromEntries(names.map((name) => [name, ""])));
  };

  const applyVariables = (): void => {
    if (!variableTemplate) return;
    const names = templateVariables(variableTemplate.text);
    if (names.some((name) => !variableValues[name]?.trim())) return;
    const text = variableTemplate.text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name: string) => variableValues[name.trim()] ?? "");
    onApply(text, variableTemplate);
    setVariableTemplate(null);
    setVariableValues({});
  };

  return <details className="workbench-template-picker" onToggle={(event) => {
    const nextOpen = event.currentTarget.open;
    setOpen(nextOpen);
    if (nextOpen && !loaded && !loading) void load();
  }}>
    <summary>提示词模板 <span>仅插入草稿，不会发送</span></summary>
    {open ? <div className="workbench-template-content">
      {error ? <div className="workbench-inline-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div> : null}
      {loading ? <p className="workbench-muted">正在读取模板…</p> : null}
      {!loading && !templates.length && !error ? <p className="workbench-muted">还没有提示词模板。</p> : null}
      {templates.map((template) => <article className="workbench-template-row" key={template.id}>
        <div><strong>{template.title}</strong>
          <small>{template.projectKey ? `项目 ${template.projectKey}` : "通用"}{template.model ? ` · ${template.model}` : ""}{template.reasoningEffort ? ` · ${template.reasoningEffort}` : ""}</small>
          {projectKey && template.projectKey && projectKey !== template.projectKey ? <small className="workbench-muted">模板关联其他项目；插入时不会自动切换当前任务项目。</small> : null}
        </div>
        <div className="workbench-template-actions">
          <button type="button" onClick={() => insert(template)} disabled={disabled}>插入</button>
          <button type="button" className="workbench-secondary-button" onClick={() => beginEdit(template)} disabled={disabled}>编辑</button>
          <button type="button" className="workbench-secondary-button" onClick={() => void remove(template)} disabled={disabled}>删除</button>
        </div>
      </article>)}

      {variableTemplate ? <section className="workbench-variable-form" aria-label="填写模板变量">
        <strong>填写“{variableTemplate.title}”中的变量</strong>
        {templateVariables(variableTemplate.text).map((name) => <label key={name}>{name}
          <input autoComplete="off" value={variableValues[name] ?? ""} onChange={(event) => setVariableValues((current) => ({ ...current, [name]: event.target.value }))} />
        </label>)}
        <div className="workbench-template-actions">
          <button type="button" className="primary" onClick={applyVariables} disabled={templateVariables(variableTemplate.text).some((name) => !variableValues[name]?.trim())}>插入草稿</button>
          <button type="button" onClick={() => setVariableTemplate(null)}>取消</button>
        </div>
      </section> : null}

      {editingId ? <section className="workbench-template-editor" aria-label={editingId === "new" ? "新建模板" : "编辑模板"}>
        <h4>{editingId === "new" ? "新建模板" : "编辑模板"}</h4>
        <label>名称<input value={form.title} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label>
        <label>提示词<textarea value={form.text} maxLength={20_000} rows={5} onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))} /></label>
        <div className="workbench-template-editor-grid">
          <label>项目 key<input value={form.projectKey} list="workbench-project-keys" onChange={(event) => setForm((current) => ({ ...current, projectKey: event.target.value }))} /></label>
          <label>模型<input value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} /></label>
          <label>推理强度<input value={form.reasoningEffort} onChange={(event) => setForm((current) => ({ ...current, reasoningEffort: event.target.value }))} /></label>
        </div>
        {projects?.length ? <datalist id="workbench-project-keys">{projects.map((project) => <option value={project} key={project} />)}</datalist> : null}
        <div className="workbench-template-actions">
          <button type="button" className="primary" onClick={() => void save()} disabled={saving || !form.title.trim() || !form.text.trim()}>{saving ? "保存中…" : "保存模板"}</button>
          <button type="button" onClick={() => setEditingId(null)} disabled={saving}>取消</button>
        </div>
      </section> : <button type="button" onClick={() => beginEdit()} disabled={disabled}>＋ 新建模板</button>}
    </div> : null}
  </details>;
}

export function workbenchTargetRoute(target?: WorkbenchTarget): string {
  return target?.kind === "task"
    ? `/tasks/${encodeURIComponent(target.source)}/${encodeURIComponent(target.id)}`
    : target?.kind === "history" && target.homeId
      ? `/codex-history/${encodeURIComponent(target.homeId)}/${encodeURIComponent(target.id)}`
      : target?.kind === "history" ? "/codex-history" : "/";
}

function targetRoute(target?: WorkbenchTarget): string {
  return workbenchTargetRoute(target);
}

function notificationRoute(notification: WorkbenchNotification): string {
  return safeWorkbenchRoute(notification.route) ?? targetRoute(notification.target);
}

function safeWorkbenchRoute(route?: string): string | null {
  return route && route.startsWith("/") && !route.startsWith("//") ? route : null;
}

function getActionPrompt(payload?: Record<string, unknown>): string {
  if (!payload) return "";
  for (const key of ["question", "prompt", "message", "summary", "description"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

interface ActionQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; value: string }>;
}

function readActionQuestion(value: unknown): ActionQuestion | null {
  const question = recordValue(value);
  if (!question || typeof question.id !== "string") return null;
  const options = Array.isArray(question.options) ? question.options.flatMap((option) => {
    if (typeof option === "string") return [{ label: option, value: option }];
    const item = recordValue(option);
    if (!item) return [];
    const label = typeof item.label === "string" ? item.label : typeof item.value === "string" ? item.value : null;
    const optionValue = typeof item.value === "string" ? item.value : label;
    return label && optionValue ? [{ label, value: optionValue }] : [];
  }) : [];
  return {
    id: question.id,
    question: stringValue(question.question) ?? stringValue(question.prompt) ?? "请回答",
    options,
  };
}

function answerIsFilled(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
}

function compactActionParams(params: Record<string, unknown>): string {
  const serialized = JSON.stringify(params, null, 2);
  return serialized.length > 2_000 ? `${serialized.slice(0, 2_000)}…` : serialized;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function actionTypeLabel(type?: string): string {
  return type === "approval" ? "等待审批" : type === "question" ? "等待回答" : "需要处理";
}

function categoryLabel(category: WorkbenchNotification["category"]): string {
  return category === "completion" ? "已完成" : category === "failure" ? "执行失败" : "需要处理";
}

function formatWorkbenchDate(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function templateVariables(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g), (match) => match[1].trim()).filter(Boolean))];
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
