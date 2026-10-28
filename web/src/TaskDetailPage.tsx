import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchTaskDetail, getActionToken, getJson, postTaskAction, postTaskFollowup, taskAttachmentUrl } from "./api.js";
import { directTaskTitle } from "./task-title.js";
import { TaskFileBrowser } from "./TaskFileBrowser.js";
import { downloadBridgeFile, isMobileApp } from "./mobile-runtime.js";
import { scopedStorageKey } from "./local-draft-scope.js";
import type { AampTaskDetailResponse, DirectTaskDetailResponse, RunWorkspaceSnapshot, StoredRun, TaskDetailResponse, WebRunReview, WorkspaceFileFingerprint } from "./types.js";
import { PromptTemplatePicker } from "./Workbench.js";
import {
  addWorkbenchQueueMessage,
  deleteWorkbenchQueueMessage,
  fetchWorkbenchPreferences,
  fetchWorkbenchQueue,
  patchWorkbenchPreference,
  patchWorkbenchQueueMessage,
  sendWorkbenchQueueMessage,
  type WorkbenchPreference,
  type WorkbenchQueueMessage,
  type WorkbenchTarget,
} from "./workbench-api.js";

const DIRECT_PAGE_SIZE = 50;
const DIRECT_STATUS_LABELS: Record<string, string> = {
  QUEUED: "排队中", RUNNING: "执行中", CANCEL_REQUESTED: "取消中",
  SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消",
};
const AAMP_STATUS_LABELS: Record<string, string> = {
  pending: "等待派发", running: "执行中", done: "已完成", failed: "失败", cancelled: "已取消",
};
const DESK_STATUS_LABELS: Record<string, string> = {
  DISCOVERED: "待处理", BLOCKED_CONFIG: "配置阻塞", QUEUED: "排队中", RUNNING: "执行中",
  WAITING_REVIEW: "待验收", ACCEPTED: "已验收", FAILED: "失败", CANCELED: "已取消",
};

export function TaskDetailPage(): ReactElement {
  const { source: sourceParam, taskId: taskIdParam } = useParams();
  const source = sourceParam === "direct" ? "direct" : sourceParam === "aamp" ? "aamp" : "desk";
  const taskId = taskIdParam ?? "";
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = typeof location.state?.returnTo === "string" && location.state.returnTo.startsWith("/")
    ? location.state.returnTo : "/";
  const [desk, setDesk] = useState<TaskDetailResponse | null>(null);
  const [direct, setDirect] = useState<DirectTaskDetailResponse | null>(null);
  const [aamp, setAamp] = useState<AampTaskDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [eventsRequested, setEventsRequested] = useState(false);
  const [detailOffset, setDetailOffset] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [followupStatus, setFollowupStatus] = useState<string | null>(null);
  const [interrupting, setInterrupting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [currentFileTarget, setCurrentFileTarget] = useState<{ path: string; sequence: number } | null>(null);
  const filesRef = useRef<HTMLDetailsElement | null>(null);
  const fileOpenSequence = useRef(0);
  const pendingSubmission = useRef<{ text: string; key: string } | null>(null);
  const pendingRetry = useRef<{ taskId: string; key: string } | null>(null);
  const workbenchTarget = useMemo<WorkbenchTarget>(() => ({ kind: "task", source, id: taskId }), [source, taskId]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollAfterSubmitRef = useRef(false);
  const draftKey = scopedStorageKey("task-followup", JSON.stringify([source, taskId]));

  useEffect(() => {
    setDesk(null);
    setDirect(null);
    setAamp(null);
    setEventsRequested(false);
    setDetailOffset(0);
    setFilesOpen(false);
    setCurrentFileTarget(null);
    pendingSubmission.current = null;
    pendingRetry.current = null;
    setFollowupStatus(null);
    try { setDraft(draftKey ? sessionStorage.getItem(draftKey) ?? "" : ""); } catch { setDraft(""); }
  }, [draftKey]);

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!taskId || (sourceParam !== "desk" && sourceParam !== "direct" && sourceParam !== "aamp")) {
      setError("任务地址无效。");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    if (!quiet) setLoading(true);
    try {
      if (source === "direct") {
        const result = await getJson<DirectTaskDetailResponse>(
          `/api/direct/tasks/${encodeURIComponent(taskId)}?limit=${DIRECT_PAGE_SIZE}&offset=${detailOffset}&events=${eventsRequested ? "1" : "0"}`,
          { signal: controller.signal },
        );
        setDirect(result);
      } else if (source === "aamp") {
        setAamp(await getJson<AampTaskDetailResponse>(`/api/task-panel/aamp/${encodeURIComponent(taskId)}`, { signal: controller.signal }));
      } else {
        setDesk(await fetchTaskDetail(taskId, controller.signal));
      }
      setError(null);
      if (scrollAfterSubmitRef.current) {
        scrollAfterSubmitRef.current = false;
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [detailOffset, eventsRequested, source, sourceParam, taskId]);

  useEffect(() => { void load(); }, [load, refresh]);
  useEffect(() => {
    const timer = setInterval(() => void load(true), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const updateDraft = (value: string): void => {
    setDraft(value);
    if (!draftKey) return;
    try { if (value) sessionStorage.setItem(draftKey, value); else sessionStorage.removeItem(draftKey); } catch { /* Storage is optional. */ }
  };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || !canFollowup || source === "aamp") return;
    if (pendingSubmission.current?.text !== text) pendingSubmission.current = { text, key: crypto.randomUUID() };
    setSending(true);
    setError(null);
    setFollowupStatus("正在提交补充信息…");
    try {
      const result = await postTaskFollowup(source, taskId, text, pendingSubmission.current.key);
      pendingSubmission.current = null;
      updateDraft("");
      scrollAfterSubmitRef.current = true;
      setFollowupStatus(result.state === "QUEUED" ? "补充信息已提交，正在排队执行。" : "补充信息已提交，正在执行。");
      setRefresh((value) => value + 1);
    } catch (failure) {
      setFollowupStatus(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };
  const interrupt = async (): Promise<void> => {
    if (source !== "desk" || interrupting || !window.confirm("确认中断该任务当前执行？")) return;
    setInterrupting(true);
    try { await postTaskAction(taskId, "interrupt"); setRefresh((value) => value + 1); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setInterrupting(false); }
  };
  const saveReview = async (decision: WebRunReview["decision"]): Promise<void> => {
    const runId = desk?.runs[0]?.run_id;
    if (source !== "desk" || !runId || reviewBusy) return;
    setReviewBusy(true);
    setError(null);
    try {
      const token = await getActionToken();
      await getJson(`/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
        body: JSON.stringify({ decision, note: reviewNote }),
      });
      setReviewNote("");
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setReviewBusy(false);
    }
  };
  const openWorkspaceInTmux = async (): Promise<void> => {
    const workspace = desk?.workspace;
    const taskIsActive = desk?.task.state === "QUEUED" || desk?.task.state === "RUNNING";
    if (!workspace || (workspace.status !== "ready" && workspace.status !== "retained") || workspaceBusy || taskIsActive || workspace.followups_closed_at) return;
    setWorkspaceBusy(true);
    setError(null);
    try {
      const token = await getActionToken();
      const result = await getJson<{ session: { id: string } }>(
        `/tmux-dashboard/api/workspaces/${encodeURIComponent(workspace.workspace_id)}/session`,
        { method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token }, body: JSON.stringify({}) },
      );
      navigate(`/tmux-dashboard?session=${encodeURIComponent(result.session.id)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setWorkspaceBusy(false);
    }
  };
  const archiveWorkspace = async (): Promise<void> => {
    const workspace = desk?.workspace;
    if (!workspace || !desk?.can_archive_workspace || workspaceBusy) return;
    if (!window.confirm("归档此任务工作区？归档会关闭该任务后续续问；worktree 目录和分支仍会保留，之后可在工作区管理页显式清理。")) return;
    setWorkspaceBusy(true);
    setError(null);
    try {
      const token = await getActionToken();
      await getJson(`/api/task-workspaces/${encodeURIComponent(workspace.workspace_id)}/archive`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token }, body: JSON.stringify({}),
      });
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setWorkspaceBusy(false);
    }
  };
  const retryTask = async (): Promise<void> => {
    if (source !== "desk" || !desk?.can_retry || retrying || !window.confirm("确认重新执行当前任务？原运行记录会保留。")) return;
    if (pendingRetry.current?.taskId !== taskId) pendingRetry.current = { taskId, key: crypto.randomUUID() };
    setRetrying(true);
    setError(null);
    try {
      const token = await getActionToken();
      await getJson(`/api/tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token },
        body: JSON.stringify({ idempotencyKey: pendingRetry.current.key }),
      });
      pendingRetry.current = null;
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRetrying(false);
    }
  };

  const directTask = direct?.task.id === taskId ? direct.task : null;
  const aampTask = aamp?.task.id === taskId ? aamp.task : null;
  const deskTask = desk?.task.task_guid === taskId ? desk.task : null;
  const initialDirectResponse = directTask?.initial_final_response
    || (direct?.followups.total === 0 ? directTask?.final_response : null);
  const title = directTask ? directTaskTitle(directTask.text, 180)
    : aampTask ? aampTask.text?.trim() ? directTaskTitle(aampTask.text, 180) : aampTask.image_count ? "（图片任务）" : "（无标题）"
      : deskTask?.input?.summary ? directTaskTitle(deskTask.input.summary, 120) : (loading ? "正在加载任务…" : "任务详情");
  const status = directTask ? DIRECT_STATUS_LABELS[directTask.status] || directTask.status
    : aampTask ? AAMP_STATUS_LABELS[aampTask.status] || aampTask.status : (DESK_STATUS_LABELS[deskTask?.state ?? ""] || deskTask?.state || "");
  const canFollowup = source === "direct" ? Boolean(direct?.can_followup) : source === "aamp" ? false : Boolean(desk?.can_followup);
  const active = source === "direct"
    ? directTask?.status === "RUNNING" || directTask?.status === "QUEUED"
    : source === "aamp" ? aampTask?.status === "running" || aampTask?.status === "pending"
      : deskTask?.state === "RUNNING" || deskTask?.state === "QUEUED";
  const workspace = desk?.workspace;
  const workspaceOpenDisabled = Boolean(
    !workspace
    || workspaceBusy
    || active
    || workspace.status === "removed"
    || workspace.status === "provisioning"
    || workspace.status === "failed"
    || workspace.followups_closed_at,
  );
  const workspaceOpenHint = workspaceBusy
    ? "正在准备 Tmux Session。"
    : active
      ? "任务正在由 Bridge Codex SDK 执行；执行结束后才会开放可写 Tmux Session。"
      : workspace?.status === "provisioning"
        ? "worktree 仍在创建。"
        : workspace?.status === "failed"
          ? "worktree 创建或恢复失败，请先查看错误。"
          : workspace?.status === "removed"
            ? "worktree 目录已移除。"
            : workspace?.followups_closed_at
              ? "任务工作区已归档。"
              : "打开此任务 worktree 的 Tmux shell。任务本身由 Bridge Codex SDK 执行。";

  const openCurrentFile = (path: string): void => {
    fileOpenSequence.current += 1;
    setCurrentFileTarget({ path, sequence: fileOpenSequence.current });
    setFilesOpen(true);
    window.setTimeout(() => filesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

  return <main className="page-main task-detail-page codex-thread-page-shell">
    <section className="task-detail-panel" aria-labelledby="task-detail-page-title">
      <header className="task-detail-page-head">
        <button className="codex-thread-back" type="button" onClick={() => navigate(returnTo)} aria-label="返回任务列表" title="返回任务列表">‹</button>
        <div className="task-detail-page-heading">
          <h1 id="task-detail-page-title">{title}</h1>
          <div className="task-detail-page-meta">
            {status ? <span className="task-detail-status">{status}</span> : null}
          </div>
        </div>
        <button className="task-detail-page-refresh" type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading} aria-label="刷新详情" title="刷新详情">↻</button>
      </header>
      {source === "desk" && workspace ? <section className="task-workspace-card" aria-label="Git worktree 工作区">
        <div className="task-workspace-copy">
          <div className="task-workspace-heading"><strong>Git worktree</strong><span>{workspace.status === "provisioning" ? "正在创建" : workspace.status === "failed" ? "创建或恢复失败" : workspace.status === "removed" ? "目录已移除" : workspace.followups_closed_at ? "已归档" : active ? "Codex SDK 执行中" : "已保留，可在 Tmux 打开"}</span></div>
          <small>Codex SDK 执行 · Tmux 用于查看或继续编辑</small>
          <details className="task-workspace-details">
            <summary>查看分支、路径与基准</summary>
            <code title={workspace.worktree_path}>{workspace.branch}</code>
            <code title={workspace.worktree_path}>{workspace.worktree_path}</code>
            <small>基准提交：{workspace.base_sha.slice(0, 12)} · {workspace.base_ref}</small>
          </details>
          {workspace.last_error ? <small className="task-detail-page-error">{workspace.last_error}</small> : null}
        </div>
        <div className="task-workspace-actions">
          <button type="button" disabled={workspaceOpenDisabled} title={workspaceOpenHint} aria-label={`在 Tmux 打开任务 worktree（${workspaceOpenHint}）`} onClick={() => void openWorkspaceInTmux()}>
            {workspaceBusy ? "处理中…" : "在 Tmux 打开"}
          </button>
          {desk.can_archive_workspace ? <button type="button" disabled={workspaceBusy} onClick={() => void archiveWorkspace()}>归档并关闭续问</button> : null}
        </div>
      </section> : null}
      {error ? <div className="task-detail-page-error" role="alert">{error}</div> : null}
      <div className="task-detail-page-scroll" ref={scrollRef}>
        <TaskWorkbenchControls target={workbenchTarget} queueAvailable={source !== "aamp"} />
        {loading && !directTask && !deskTask && !aampTask ? <div className="empty">正在读取任务详情…</div> : null}
        {source === "direct" && directTask && direct ? <>
          <div className="task-detail-message is-user"><small>任务描述</small><div>{directTask.text || "（附件任务）"}</div></div>
          {initialDirectResponse ? <TaskAgentMessage text={initialDirectResponse} /> : null}
          {direct.followups.items.slice().reverse().map((followup) => <div className="task-detail-turn" key={followup.followup_id}>
            <div className="task-detail-message is-user"><small>追加信息 · {DIRECT_STATUS_LABELS[followup.status] || followup.status}</small><div>{followup.text}</div></div>
            {followup.final_response ? <TaskAgentMessage text={followup.final_response} /> : null}
            {followup.error ? <div className="task-detail-page-error">{followup.error}</div> : null}
          </div>)}
          {directTask.final_response && directTask.final_response !== initialDirectResponse
            && directTask.final_response !== direct.followups.items[0]?.final_response
            ? <TaskAgentMessage text={directTask.final_response} /> : null}
          {directTask.last_progress_text && active ? <div className="task-detail-progress">{directTask.last_progress_text}</div> : null}
          {directTask.error ? <div className="task-detail-page-error">{directTask.error}</div> : null}
          {direct.attachments.total ? <details className="task-detail-extra"><summary>附件（{direct.attachments.total}）</summary>{direct.attachments.items.map((item) => <p key={item.attachment_id}>{item.file_name || item.type} · {item.status}</p>)}</details> : null}
          <details className="task-detail-extra" onToggle={(event) => { if (event.currentTarget.open) setEventsRequested(true); }}>
            <summary>事件（{direct.events.total}）</summary>
            {eventsRequested ? direct.events.items.length ? direct.events.items.map((item) => <p key={item.id}>{new Date(item.created_at).toLocaleString("zh-CN", { hour12: false })} · {item.event_type}</p>) : <p className="muted">暂无事件</p> : <p className="muted">正在加载事件…</p>}
          </details>
          {Math.max(direct.followups.total, direct.attachments.total, eventsRequested ? direct.events.total : 0) > DIRECT_PAGE_SIZE ? <nav className="task-detail-page-pagination" aria-label="任务详情分页">
            <button type="button" disabled={detailOffset === 0 || loading} onClick={() => setDetailOffset((value) => Math.max(0, value - DIRECT_PAGE_SIZE))}>上一页</button>
            <span>第 {Math.floor(detailOffset / DIRECT_PAGE_SIZE) + 1} 页</span>
            <button type="button" disabled={loading || detailOffset + DIRECT_PAGE_SIZE >= Math.max(direct.followups.total, direct.attachments.total, eventsRequested ? direct.events.total : 0)} onClick={() => setDetailOffset((value) => value + DIRECT_PAGE_SIZE)}>下一页</button>
          </nav> : null}
        </> : null}
        {source === "aamp" && aampTask ? <>
          <div className="task-detail-message is-user"><small>任务描述</small><div>{aampTask.text || (aampTask.image_count ? "（图片任务，没有文本描述）" : "（无描述）")}</div></div>
          {aampTask.last_progress_text ? <TaskAgentMessage text={aampTask.last_progress_text} /> : null}
          {aampTask.image_count ? <details className="task-detail-extra"><summary>图片附件（{aampTask.image_count}）</summary><p className="muted">图片由 AAMP 管理；统一任务视图不展示本机附件路径。</p></details> : null}
          {aampTask.error ? <div className="task-detail-page-error">{aampTask.error}</div> : null}
          <p className="muted">AAMP 任务在此处只读。请在原飞书任务卡片中查看或处理。</p>
        </> : null}
        {source === "desk" && deskTask && desk ? <>
          <div className="workbench-same-config-actions">
            <button type="button" onClick={() => navigate("/", { state: { newTaskDraft: {
              source: "task",
              projectKey: deskTask.project_key,
              mode: deskTask.mode,
              description: deskTask.input?.description || deskTask.input_text,
            } } })}>同配置新建</button>
            <small>带入项目、mode 和描述；不复制附件，也不会自动提交。</small>
          </div>
          {desk.runs.length ? desk.runs.slice().reverse().map((run) => <DeskRunTurn
            run={run}
            review={desk.reviews.find((item) => item.run_id === run.run_id)}
            workspaceSnapshots={desk.workspace_snapshots.filter((item) => item.run_id === run.run_id)}
            showWorkspaceSnapshots={deskTask.origin === "web"}
            onOpenCurrentFile={openCurrentFile}
            key={run.run_id}
          />)
            : <div className="task-detail-message is-user"><small>任务描述</small><div>{deskTask.input?.description || "（无描述）"}</div></div>}
          {deskTask.origin === "web" && desk.runs[0]?.state === "WAITING_REVIEW" ? <section className="task-review" aria-label="人工验收">
            <h2>人工验收</h2>
            <p className="muted">追加信息会生成新一轮运行。</p>
            <textarea aria-label="验收意见" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={1000} rows={2} placeholder="需要修改时请填写具体问题；验收通过可留空" disabled={reviewBusy} />
            <div className="task-review-actions">
              <button type="button" disabled={reviewBusy} onClick={() => void saveReview("accepted")}>验收通过</button>
              <button type="button" disabled={reviewBusy || !reviewNote.trim()} onClick={() => void saveReview("changes_requested")}>需要修改</button>
            </div>
          </section> : null}
          {deskTask.progress_text && active ? <div className="task-detail-progress">{deskTask.progress_text}</div> : null}
          {deskTask.last_error ? <div className="task-detail-page-error">{deskTask.last_error}</div> : null}
          {desk.attachments.length ? <details className="task-detail-extra"><summary>附件（{desk.attachments.length}）</summary>{desk.attachments.map((item) => <p key={item.attachment_id}><a href={taskAttachmentUrl(taskId, item.attachment_id)} target="_blank" rel="noreferrer" onClick={(event) => {
            if (!isMobileApp()) return;
            event.preventDefault();
            void downloadBridgeFile(taskAttachmentUrl(taskId, item.attachment_id), item.file_name)
              .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "附件下载失败。"));
          }}>{item.file_name}</a></p>)}</details> : null}
          <details ref={filesRef} className="task-detail-extra" open={filesOpen} onToggle={(event) => setFilesOpen(event.currentTarget.open)}><summary>{desk.workspace ? "当前任务工作区文件（实时）" : "当前项目文件（实时）"}</summary><p className="muted">此处读取当前工作目录，不是执行时的不可变产物快照；共享目录中的改动不能自动归因到本任务。</p>{filesOpen ? <TaskFileBrowser key={currentFileTarget?.sequence ?? 0} taskGuid={taskId} initialFilePath={currentFileTarget?.path} /> : null}</details>
          {active ? <button className="danger" type="button" disabled={interrupting} onClick={() => void interrupt()}>{interrupting ? "正在中断…" : "中断当前执行"}</button> : null}
          {desk.can_retry ? <button type="button" disabled={retrying} onClick={() => void retryTask()}>{retrying ? "正在重试…" : "重新执行任务"}</button> : null}
        </> : null}
      </div>
      {followupStatus ? <div className="task-detail-followup-status" role="status">{followupStatus}</div> : null}
      {source !== "aamp" ? <div className="workbench-task-template">
        <PromptTemplatePicker onApply={(text) => updateDraft(appendPromptToDraft(draft, text))} />
      </div> : null}
      {source !== "aamp" ? <form className="task-detail-composer" onSubmit={(event) => void submit(event)}>
        <textarea aria-label="追加信息" value={draft} onChange={(event) => updateDraft(event.target.value)} maxLength={2000}
          placeholder={canFollowup ? "向当前任务追加信息…" : "当前任务暂时不能追加信息"}
          disabled={!canFollowup || sending}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button className="primary" type="submit" disabled={!canFollowup || !draft.trim() || sending}>{sending ? "发送中…" : "发送"}</button>
      </form> : null}
    </section>
  </main>;
}

function TaskWorkbenchControls({ target, queueAvailable }: { target: WorkbenchTarget; queueAvailable: boolean }): ReactElement {
  const targetKey = target.kind === "task" ? `task:${target.source}:${target.id}` : `history:${target.homeId ?? ""}:${target.id}`;
  const [preference, setPreference] = useState<WorkbenchPreference>({ target, pinned: false, tags: [], unread: false, keepAttention: false });
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [preferenceLoading, setPreferenceLoading] = useState(true);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [tagsText, setTagsText] = useState("");
  const [titleText, setTitleText] = useState("");
  const [messages, setMessages] = useState<WorkbenchQueueMessage[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueDraft, setQueueDraft] = useState("");
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);
  const [queueRevision, setQueueRevision] = useState(0);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const pendingQueueSubmission = useRef<{ text: string; key: string } | null>(null);

  const loadPreference = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setPreferenceLoading(true);
    setPreferenceError(null);
    try {
      const result = await fetchWorkbenchPreferences(signal);
      if (signal?.aborted) return;
      const found = result.preferences.find((item) => workbenchTargetMatches(item.target, target));
      const next = found ?? { target, pinned: false, tags: [], unread: false, keepAttention: false };
      setPreference(next);
      setTagsText(next.tags.join(", "));
      setTitleText(next.title ?? "");
    } catch (failure) {
      if (!signal?.aborted) setPreferenceError(toWorkbenchError(failure));
    } finally {
      if (!signal?.aborted) setPreferenceLoading(false);
    }
  }, [target, targetKey]);

  const loadQueue = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!queueAvailable) {
      setQueueLoading(false);
      setMessages([]);
      return;
    }
    setQueueLoading(true);
    setQueueError(null);
    try {
      const result = await fetchWorkbenchQueue(target, signal);
      if (signal?.aborted) return;
      setMessages(result.messages);
    } catch (failure) {
      if (!signal?.aborted) setQueueError(toWorkbenchError(failure));
    } finally {
      if (!signal?.aborted) setQueueLoading(false);
    }
  }, [queueAvailable, target, targetKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPreference(controller.signal);
    return () => controller.abort();
  }, [loadPreference]);

  useEffect(() => {
    const controller = new AbortController();
    void loadQueue(controller.signal);
    return () => controller.abort();
  }, [loadQueue, queueRevision]);

  const patchPreference = async (patch: Partial<Pick<WorkbenchPreference, "pinned" | "tags" | "unread" | "keepAttention">> & { title?: string | null }): Promise<void> => {
    if (preferenceBusy) return;
    setPreferenceBusy(true);
    setPreferenceError(null);
    try {
      const result = await patchWorkbenchPreference(target, patch);
      setPreference(result.preference);
      setTagsText(result.preference.tags.join(", "));
      setTitleText(result.preference.title ?? "");
    } catch (failure) { setPreferenceError(toWorkbenchError(failure)); }
    finally { setPreferenceBusy(false); }
  };

  const addToQueue = async (): Promise<void> => {
    const text = queueDraft.trim();
    if (!text || queueBusyId) return;
    if (pendingQueueSubmission.current?.text !== text) pendingQueueSubmission.current = { text, key: createWorkbenchIdempotencyKey() };
    setQueueBusyId("new");
    setQueueError(null);
    setQueueNotice(null);
    try {
      await addWorkbenchQueueMessage(target, text, pendingQueueSubmission.current.key);
      pendingQueueSubmission.current = null;
      setQueueDraft("");
      setQueueNotice("已加入队列，原任务空闲后将自动发送；排队不表示正在运行。");
      setQueueRevision((value) => value + 1);
    } catch (failure) {
      setQueueError(`加入队列失败：${toWorkbenchError(failure)}。草稿已保留；重试会沿用同一幂等键。`);
    } finally { setQueueBusyId(null); }
  };

  const moveQueueMessage = async (message: WorkbenchQueueMessage, move: "up" | "down"): Promise<void> => {
    if (message.status !== "queued" || queueBusyId) return;
    setQueueBusyId(message.id);
    setQueueError(null);
    try {
      await patchWorkbenchQueueMessage(message.id, { move });
      setQueueRevision((value) => value + 1);
    } catch (failure) { setQueueError(toWorkbenchError(failure)); }
    finally { setQueueBusyId(null); }
  };

  const saveQueueMessage = async (message: WorkbenchQueueMessage): Promise<void> => {
    const text = editingQueueText.trim();
    if (!text || queueBusyId || message.status !== "queued") return;
    setQueueBusyId(message.id);
    setQueueError(null);
    try {
      await patchWorkbenchQueueMessage(message.id, { text });
      setEditingQueueId(null);
      setQueueRevision((value) => value + 1);
    } catch (failure) { setQueueError(toWorkbenchError(failure)); }
    finally { setQueueBusyId(null); }
  };

  const removeQueueMessage = async (message: WorkbenchQueueMessage): Promise<void> => {
    if (queueBusyId || message.status !== "queued" || !window.confirm("删除这条待发消息？")) return;
    setQueueBusyId(message.id);
    setQueueError(null);
    try {
      await deleteWorkbenchQueueMessage(message.id);
      setQueueRevision((value) => value + 1);
    } catch (failure) { setQueueError(toWorkbenchError(failure)); }
    finally { setQueueBusyId(null); }
  };

  const sendQueueMessage = async (message: WorkbenchQueueMessage): Promise<void> => {
    if (queueBusyId || message.status !== "queued") return;
    if (!window.confirm("确认将这条消息提交到原任务执行链路？提交不代表执行完成。")) return;
    setQueueBusyId(message.id);
    setQueueError(null);
    setQueueNotice(null);
    try {
      const result = await sendWorkbenchQueueMessage(message.id);
      const status = result.message?.status ?? normalizeQueueStatus(result.status);
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, status } : item));
      setQueueNotice(queueSendMessage(status));
      setQueueRevision((value) => value + 1);
    } catch (failure) {
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, status: "unconfirmed" } : item));
      setQueueError(`发送结果未知：${toWorkbenchError(failure)}。请刷新并核对原任务状态；不会自动重发。`);
    } finally { setQueueBusyId(null); }
  };

  const queuePositions = new Map(messages.filter((item) => item.status === "queued").map((item, index) => [item.id, index]));
  return <section className="workbench-task-controls" aria-label="任务组织与跟进队列">
    <details className="task-detail-extra">
      <summary>组织偏好{preference.pinned ? " · 已置顶" : ""}{preference.keepAttention ? " · 持续关注" : ""}</summary>
      {preferenceError ? <div className="workbench-inline-error" role="alert"><span>{preferenceError}</span><button type="button" onClick={() => void loadPreference()}>重试</button></div> : null}
      {preferenceLoading ? <p className="workbench-muted">正在读取偏好…</p> : <>
        <div className="workbench-preference-toggles">
          <label><input type="checkbox" checked={preference.pinned} disabled={preferenceBusy} onChange={(event) => void patchPreference({ pinned: event.currentTarget.checked })} />置顶</label>
          <label><input type="checkbox" checked={preference.unread} disabled={preferenceBusy} onChange={(event) => void patchPreference({ unread: event.currentTarget.checked })} />标记未读</label>
          <label><input type="checkbox" checked={preference.keepAttention} disabled={preferenceBusy} onChange={(event) => void patchPreference({ keepAttention: event.currentTarget.checked })} />持续关注</label>
        </div>
        <label className="workbench-task-meta-field">自定义标题<input value={titleText} maxLength={120} onChange={(event) => setTitleText(event.target.value)} placeholder="留空使用原任务标题" disabled={preferenceBusy} /></label>
        <label className="workbench-task-meta-field">标签<input value={tagsText} maxLength={500} onChange={(event) => setTagsText(event.target.value)} placeholder="用逗号分隔" disabled={preferenceBusy} /></label>
        <button type="button" onClick={() => void patchPreference({ title: titleText.trim() || null, tags: [...new Set(tagsText.split(",").map((tag) => tag.trim()).filter(Boolean))] })} disabled={preferenceBusy}>{preferenceBusy ? "保存中…" : "保存组织信息"}</button>
      </>}
    </details>

    <details className="task-detail-extra">
      <summary>{queueAvailable ? `跟进队列（${messages.length}）` : "跟进队列（只读）"}</summary>
      {!queueAvailable ? <p className="workbench-muted">AAMP 任务在此处只读；请在原飞书任务卡片中处理。</p> : <>
        <p className="workbench-muted">加入队列即授权在原任务空闲后自动发送；忙碌时可编辑、排序和删除。“立即发送”会尝试派发队首。“已提交”不表示执行已完成。</p>
        <button type="button" onClick={() => setQueueRevision((value) => value + 1)} disabled={queueLoading}>刷新队列状态</button>
        {queueError ? <div className="workbench-inline-error" role="alert"><span>{queueError}</span><button type="button" onClick={() => setQueueRevision((value) => value + 1)}>刷新队列</button></div> : null}
        {queueNotice ? <p className="workbench-muted" role="status">{queueNotice}</p> : null}
        {queueLoading && !messages.length ? <p className="workbench-muted">正在读取队列…</p> : null}
        {!queueLoading && !messages.length && !queueError ? <p className="workbench-muted">暂无待发消息。</p> : null}
        {messages.length ? <ol className="workbench-queue-list">{messages.map((message, index) => <li className="workbench-queue-item" key={message.id}>
          <header><strong>#{index + 1} · {queueStatusLabel(message.status)}</strong><small>{formatTaskWorkbenchTime(message.createdAt)}</small></header>
          {editingQueueId === message.id ? <>
            <textarea value={editingQueueText} maxLength={2000} rows={3} onChange={(event) => setEditingQueueText(event.target.value)} aria-label="编辑队列消息" />
            <div className="workbench-queue-actions"><button type="button" className="primary" onClick={() => void saveQueueMessage(message)} disabled={queueBusyId === message.id || !editingQueueText.trim()}>保存</button><button type="button" onClick={() => setEditingQueueId(null)}>取消</button></div>
          </> : <p>{message.text}</p>}
          {message.error ? <small className="workbench-queue-error">{message.error}</small> : null}
          {message.status === "unconfirmed" ? <small className="workbench-queue-error">结果未知；先核对任务状态，不要重复提交。</small> : null}
          {message.status === "queued" ? <div className="workbench-queue-actions">
            <button type="button" onClick={() => void moveQueueMessage(message, "up")} disabled={queueBusyId !== null || queuePositions.get(message.id) === 0} aria-label="上移队列消息">↑</button>
            <button type="button" onClick={() => void moveQueueMessage(message, "down")} disabled={queueBusyId !== null || queuePositions.get(message.id) === queuePositions.size - 1} aria-label="下移队列消息">↓</button>
            <button type="button" onClick={() => { setEditingQueueId(message.id); setEditingQueueText(message.text); }} disabled={queueBusyId !== null}>编辑</button>
            <button type="button" onClick={() => void removeQueueMessage(message)} disabled={queueBusyId !== null}>删除</button>
            <button type="button" className="primary" onClick={() => void sendQueueMessage(message)} disabled={queueBusyId !== null || queuePositions.get(message.id) !== 0}>{queueBusyId === message.id ? "提交中…" : "立即发送队首"}</button>
          </div> : null}
        </li>)}</ol> : null}
        <div className="workbench-queue-add">
          <label>加入待发消息<textarea value={queueDraft} maxLength={2000} rows={3} onChange={(event) => setQueueDraft(event.target.value)} placeholder="加入后，原任务空闲时会自动发送。" /></label>
          <button type="button" className="primary" onClick={() => void addToQueue()} disabled={!queueDraft.trim() || queueBusyId !== null}>{queueBusyId === "new" ? "保存中…" : "加入队列"}</button>
        </div>
      </>}
    </details>
  </section>;
}

function workbenchTargetMatches(left: WorkbenchTarget, right: WorkbenchTarget): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === "task" && right.kind === "task") return left.source === right.source;
  return left.kind === "history" && right.kind === "history" && left.homeId === right.homeId;
}

function queueStatusLabel(status: WorkbenchQueueMessage["status"]): string {
  if (status === "queued") return "明确排队";
  if (status === "sending") return "提交中";
  if (status === "sent") return "已提交";
  if (status === "failed") return "提交失败";
  return "结果未确认";
}

function normalizeQueueStatus(status?: string): WorkbenchQueueMessage["status"] {
  return status === "sent" || status === "failed" || status === "unconfirmed" || status === "queued" || status === "sending"
    ? status : "sending";
}

function queueSendMessage(status: WorkbenchQueueMessage["status"]): string {
  if (status === "sent") return "消息已提交到原任务链路；Codex 执行状态请查看任务时间线。";
  if (status === "unconfirmed") return "提交结果未知，请刷新并核对任务状态；不会自动重发。";
  if (status === "failed") return "提交失败；查看错误后再决定是否重新排队。";
  return "发送请求已受理；请查看任务时间线确认后续状态。";
}

function appendPromptToDraft(current: string, inserted: string): string {
  const draft = current.trimEnd();
  return draft ? `${draft}\n\n${inserted}` : inserted;
}

function createWorkbenchIdempotencyKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatTaskWorkbenchTime(value?: number): string {
  if (value === undefined) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function toWorkbenchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TaskAgentMessage({ text }: { text: string }): ReactElement {
  return <div className="task-detail-message is-agent"><small>执行结果</small><div className="task-detail-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div></div>;
}

function DeskRunTurn({
  run,
  review,
  workspaceSnapshots,
  showWorkspaceSnapshots,
  onOpenCurrentFile,
}: {
  run: StoredRun;
  review?: WebRunReview;
  workspaceSnapshots: RunWorkspaceSnapshot[];
  showWorkspaceSnapshots: boolean;
  onOpenCurrentFile: (path: string) => void;
}): ReactElement {
  let description = run.input_text;
  try {
    const current = JSON.parse(run.input_text) as { description?: string };
    const previous = run.previous_input_text ? JSON.parse(run.previous_input_text) as { description?: string } : null;
    description = current.description ?? run.input_text;
    if (previous?.description && description.startsWith(previous.description)) description = description.slice(previous.description.length).trim() || description;
  } catch { /* Keep the original input. */ }
  return <div className="task-detail-turn">
    <div className="task-detail-message is-user"><small>{run.previous_input_text ? "追加信息" : "任务描述"} · {run.state}</small><div>{description}</div></div>
    {run.final_response ? <TaskAgentMessage text={run.final_response} /> : null}
    {review ? <div className="task-review-record"><small>人工验收：{review.decision === "accepted" ? "已通过" : "需要修改"} · {new Date(review.reviewed_at).toLocaleString()}</small>{review.note ? <p>{review.note}</p> : null}</div> : null}
    {run.progress_text && (run.state === "RUNNING" || run.state === "QUEUED") ? <div className="task-detail-progress">{run.progress_text}</div> : null}
    {showWorkspaceSnapshots ? <WorkspaceSnapshotDetails snapshots={workspaceSnapshots} onOpenCurrentFile={onOpenCurrentFile} /> : null}
    {run.events?.length ? <details className="task-detail-extra"><summary>运行证据（{run.events.length} 条）</summary>
      <p className="muted">Run {run.run_id} · 开始 {new Date(run.started_at).toLocaleString()}{run.finished_at ? ` · 结束 ${new Date(run.finished_at).toLocaleString()}` : ""}。文件变更事件是本轮 Codex 的报告，不是当前目录的独占变更证明。</p>
      <ul className="task-run-events">{run.events.map((event) => <li key={event.id}><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time> · {event.message}</li>)}</ul>
    </details> : null}
  </div>;
}

function WorkspaceSnapshotDetails({ snapshots, onOpenCurrentFile }: {
  snapshots: RunWorkspaceSnapshot[];
  onOpenCurrentFile: (path: string) => void;
}): ReactElement {
  const ordered = snapshots.slice().sort((left, right) => left.stage === right.stage ? 0 : left.stage === "before" ? -1 : 1);
  return <details className="task-detail-extra">
    <summary>工作区快照（{ordered.length ? `${ordered.length} 个阶段` : "未采集"}）</summary>
    <p className="muted">这是整个 Git 工作区在各采集时刻的状态。共享目录中的已有修改和并行任务修改都可能出现，无法将所有变更归因到本任务。</p>
    {ordered.length === 0 ? <p className="muted">本轮没有保存到工作区快照；采集或保存失败不会影响任务执行。</p> : null}
    {ordered.length === 1 ? <p className="muted">本轮只保存到一个采集阶段；另一个阶段可能因采集失败或任务启动中断而缺失。</p> : null}
    {ordered.map(({ stage, snapshot }) => <section className="task-run-snapshot" key={stage}>
      <h3>{stage === "before" ? "执行前" : "执行后"}</h3>
      <time dateTime={snapshot.capturedAt}>采集时间：{formatSnapshotTime(snapshot.capturedAt)}</time>
      {snapshot.isGitRepository ? <>
        <p>HEAD：<code>{snapshot.headCommit ?? "无提交或不可读取"}</code></p>
        {snapshot.dirtyPaths.length || snapshot.untrackedPaths.length ? <ul>
          {snapshot.dirtyPaths.map((path) => <WorkspaceSnapshotPath key={`dirty:${path}`} label="已跟踪文件有未提交变更" path={path} fingerprint={findFingerprint(snapshot.fileFingerprints, path)} hasFingerprintManifest={snapshot.fileFingerprints !== undefined} onOpenCurrentFile={onOpenCurrentFile} />)}
          {snapshot.untrackedPaths.map((path) => <WorkspaceSnapshotPath key={`untracked:${path}`} label="未跟踪文件" path={path} fingerprint={findFingerprint(snapshot.fileFingerprints, path)} hasFingerprintManifest={snapshot.fileFingerprints !== undefined} onOpenCurrentFile={onOpenCurrentFile} />)}
        </ul> : <p>未发现未提交变更路径。</p>}
      </> : <p>未能读取此目录的 Git 仓库状态。</p>}
      {snapshot.truncated ? <p className="muted">状态输出受限或采集超时，结果可能不完整。</p> : null}
      <p className="muted">SHA-256 与大小记录的是采集时文件字节；点选路径打开当前文件，内容可能已改变。共享目录中的变化无法归因到单个任务。</p>
    </section>)}
  </details>;
}

function WorkspaceSnapshotPath({ label, path, fingerprint, hasFingerprintManifest, onOpenCurrentFile }: {
  label: string;
  path: string;
  fingerprint?: WorkspaceFileFingerprint;
  hasFingerprintManifest: boolean;
  onOpenCurrentFile: (path: string) => void;
}): ReactElement {
  return <li>{label}：<button type="button" className="task-run-snapshot-path" onClick={() => onOpenCurrentFile(path)} title="查看当前文件（实时）"><code>{path}</code></button>
    <FingerprintEvidence fingerprint={fingerprint} hasFingerprintManifest={hasFingerprintManifest} />
  </li>;
}

function FingerprintEvidence({ fingerprint, hasFingerprintManifest }: {
  fingerprint?: WorkspaceFileFingerprint;
  hasFingerprintManifest: boolean;
}): ReactElement {
  if (!hasFingerprintManifest) return <small className="muted"> · 旧快照未采集指纹</small>;
  if (!fingerprint) return <small className="muted"> · 未记录指纹</small>;
  if (fingerprint.status === "hashed" && fingerprint.sha256) {
    return <small> · SHA-256 <code style={{ overflowWrap: "anywhere" }}>{fingerprint.sha256}</code> · {formatSnapshotBytes(fingerprint.sizeBytes)}</small>;
  }
  const status = fingerprint.status === "unsafe" ? "安全跳过" : "未采集指纹";
  return <small className="muted"> · {status}：{fingerprintReasonLabel(fingerprint.reason)}{fingerprint.sizeBytes === null ? "" : ` · ${formatSnapshotBytes(fingerprint.sizeBytes)}`}</small>;
}

function findFingerprint(fingerprints: WorkspaceFileFingerprint[] | undefined, path: string): WorkspaceFileFingerprint | undefined {
  return fingerprints?.find((fingerprint) => fingerprint.path === path);
}

function fingerprintReasonLabel(reason: WorkspaceFileFingerprint["reason"]): string {
  const labels: Record<NonNullable<WorkspaceFileFingerprint["reason"]>, string> = {
    "unsafe-path": "路径不安全",
    symlink: "符号链接",
    "outside-repository": "路径超出仓库",
    "non-directory-parent": "父路径不是目录",
    "not-regular-file": "不是普通文件",
    "safe-open-unavailable": "当前平台缺少安全的非阻塞打开标志",
    "file-too-large": "超过单文件大小上限",
    "byte-budget-exceeded": "超过本次总读取上限",
    "file-limit-reached": "超过本次文件数上限",
    "not-found": "采集时文件不存在",
    unreadable: "文件不可读取",
    "changed-during-read": "读取期间文件发生变化",
  };
  return reason ? labels[reason] : "原因未提供";
}

function formatSnapshotBytes(size: number | null): string {
  if (size === null) return "大小未知";
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`;
  return `${(size / 1_048_576).toFixed(1)} MiB`;
}

function formatSnapshotTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
