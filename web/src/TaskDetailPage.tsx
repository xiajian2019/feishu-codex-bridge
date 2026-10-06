import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchTaskDetail, getActionToken, getJson, postTaskAction, postTaskFollowup, taskAttachmentUrl } from "./api.js";
import { directTaskTitle } from "./task-title.js";
import { TaskFileBrowser } from "./TaskFileBrowser.js";
import type { AampTaskDetailResponse, DirectTaskDetailResponse, RunWorkspaceSnapshot, StoredRun, TaskDetailResponse, WebRunReview } from "./types.js";

const DIRECT_PAGE_SIZE = 50;
const DIRECT_STATUS_LABELS: Record<string, string> = {
  QUEUED: "排队中", RUNNING: "执行中", CANCEL_REQUESTED: "取消中",
  SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消",
};
const AAMP_STATUS_LABELS: Record<string, string> = {
  pending: "等待派发", running: "执行中", done: "已完成", failed: "失败", cancelled: "已取消",
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
  const [interrupting, setInterrupting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [currentFileTarget, setCurrentFileTarget] = useState<{ path: string; sequence: number } | null>(null);
  const filesRef = useRef<HTMLDetailsElement | null>(null);
  const fileOpenSequence = useRef(0);
  const pendingSubmission = useRef<{ text: string; key: string } | null>(null);
  const pendingRetry = useRef<{ taskId: string; key: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollAfterSubmitRef = useRef(false);
  const draftKey = `bridge-task-draft:${source}:${taskId}`;

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
    try { setDraft(sessionStorage.getItem(draftKey) ?? ""); } catch { setDraft(""); }
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
    try { if (value) sessionStorage.setItem(draftKey, value); else sessionStorage.removeItem(draftKey); } catch { /* Storage is optional. */ }
  };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || !canFollowup || source === "aamp") return;
    if (pendingSubmission.current?.text !== text) pendingSubmission.current = { text, key: crypto.randomUUID() };
    setSending(true);
    setError(null);
    try {
      await postTaskFollowup(source, taskId, text, pendingSubmission.current.key);
      pendingSubmission.current = null;
      updateDraft("");
      scrollAfterSubmitRef.current = true;
      setRefresh((value) => value + 1);
    } catch (failure) {
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
      : deskTask?.input?.summary || (loading ? "正在加载任务…" : "任务详情");
  const status = directTask ? DIRECT_STATUS_LABELS[directTask.status] || directTask.status
    : aampTask ? AAMP_STATUS_LABELS[aampTask.status] || aampTask.status : deskTask?.state ?? "";
  const canFollowup = source === "direct" ? Boolean(direct?.can_followup) : source === "aamp" ? false : Boolean(desk?.can_followup);
  const active = source === "direct"
    ? directTask?.status === "RUNNING" || directTask?.status === "QUEUED"
    : source === "aamp" ? aampTask?.status === "running" || aampTask?.status === "pending"
      : deskTask?.state === "RUNNING" || deskTask?.state === "QUEUED";

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
            <span className="guid">{taskId}</span>
            <span>{source === "direct" ? "飞书 Direct" : source === "aamp" ? "飞书 AAMP + Relay（只读）" : deskTask?.origin === "web" ? "Bridge 看板" : "飞书任务"}</span>
            {status ? <span>{status}</span> : null}
            {directTask ? <span>{directTask.attempt} 次执行</span> : deskTask ? <span>{desk?.runs.length ?? 0} 次运行</span> : null}
            {(directTask?.thread_id || deskTask?.thread_id) ? <span className="guid">Thread：{directTask?.thread_id || deskTask?.thread_id}</span> : null}
          </div>
        </div>
        <button className="task-detail-page-refresh" type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading} aria-label="刷新详情" title="刷新详情">↻</button>
      </header>
      {error ? <div className="task-detail-page-error" role="alert">{error}</div> : null}
      <div className="task-detail-page-scroll" ref={scrollRef}>
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
            <p className="muted">验收记录与 Codex 执行状态分别保存；后续追加信息会生成新一轮运行。</p>
            <textarea aria-label="验收意见" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={1000} rows={2} placeholder="需要修改时请填写具体问题；验收通过可留空" disabled={reviewBusy} />
            <div className="task-review-actions">
              <button type="button" disabled={reviewBusy} onClick={() => void saveReview("accepted")}>验收通过</button>
              <button type="button" disabled={reviewBusy || !reviewNote.trim()} onClick={() => void saveReview("changes_requested")}>需要修改</button>
            </div>
          </section> : null}
          {deskTask.progress_text && active ? <div className="task-detail-progress">{deskTask.progress_text}</div> : null}
          {deskTask.last_error ? <div className="task-detail-page-error">{deskTask.last_error}</div> : null}
          {desk.attachments.length ? <details className="task-detail-extra"><summary>附件（{desk.attachments.length}）</summary>{desk.attachments.map((item) => <p key={item.attachment_id}><a href={taskAttachmentUrl(taskId, item.attachment_id)} target="_blank" rel="noreferrer">{item.file_name}</a></p>)}</details> : null}
          <details ref={filesRef} className="task-detail-extra" open={filesOpen} onToggle={(event) => setFilesOpen(event.currentTarget.open)}><summary>当前项目文件（实时）</summary><p className="muted">此处是当前工作目录，不是任务产物快照；共享目录中的改动不能自动归因到本任务。</p>{filesOpen ? <TaskFileBrowser key={currentFileTarget?.sequence ?? 0} taskGuid={taskId} initialFilePath={currentFileTarget?.path} /> : null}</details>
          {active ? <button className="danger" type="button" disabled={interrupting} onClick={() => void interrupt()}>{interrupting ? "正在中断…" : "中断当前执行"}</button> : null}
          {desk.can_retry ? <button type="button" disabled={retrying} onClick={() => void retryTask()}>{retrying ? "正在重试…" : "重新执行任务"}</button> : null}
        </> : null}
      </div>
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
          {snapshot.dirtyPaths.map((path) => <li key={`dirty:${path}`}>已跟踪文件有未提交变更：<button type="button" className="task-run-snapshot-path" onClick={() => onOpenCurrentFile(path)} title="查看当前文件（实时）"><code>{path}</code></button></li>)}
          {snapshot.untrackedPaths.map((path) => <li key={`untracked:${path}`}>未跟踪文件：<button type="button" className="task-run-snapshot-path" onClick={() => onOpenCurrentFile(path)} title="查看当前文件（实时）"><code>{path}</code></button></li>)}
        </ul> : <p>未发现未提交变更路径。</p>}
      </> : <p>未能读取此目录的 Git 仓库状态。</p>}
      {snapshot.truncated ? <p className="muted">状态输出受限或采集超时，结果可能不完整。</p> : null}
      <p className="muted">点选路径将打开该文件的当前内容，可能已不同于采集时。</p>
    </section>)}
  </details>;
}

function formatSnapshotTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
