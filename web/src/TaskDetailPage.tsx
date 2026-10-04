import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchTaskDetail, getJson, postTaskAction, postTaskFollowup, taskAttachmentUrl } from "./api.js";
import { directTaskTitle } from "./task-title.js";
import { TaskFileBrowser } from "./TaskFileBrowser.js";
import type { DirectTaskDetailResponse, StoredRun, TaskDetailResponse } from "./types.js";

const DIRECT_PAGE_SIZE = 50;
const DIRECT_STATUS_LABELS: Record<string, string> = {
  QUEUED: "排队中", RUNNING: "执行中", CANCEL_REQUESTED: "取消中",
  SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消",
};

export function TaskDetailPage(): ReactElement {
  const { source: sourceParam, taskId: taskIdParam } = useParams();
  const source = sourceParam === "direct" ? "direct" : "desk";
  const taskId = taskIdParam ?? "";
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = typeof location.state?.returnTo === "string" && location.state.returnTo.startsWith("/")
    ? location.state.returnTo : "/";
  const [desk, setDesk] = useState<TaskDetailResponse | null>(null);
  const [direct, setDirect] = useState<DirectTaskDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [eventsRequested, setEventsRequested] = useState(false);
  const [detailOffset, setDetailOffset] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const pendingSubmission = useRef<{ text: string; key: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollAfterSubmitRef = useRef(false);
  const draftKey = `bridge-task-draft:${source}:${taskId}`;

  useEffect(() => {
    setDesk(null);
    setDirect(null);
    setEventsRequested(false);
    setDetailOffset(0);
    setFilesOpen(false);
    pendingSubmission.current = null;
    try { setDraft(sessionStorage.getItem(draftKey) ?? ""); } catch { setDraft(""); }
  }, [draftKey]);

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!taskId || (sourceParam !== "desk" && sourceParam !== "direct")) {
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
    if (!text || sending || !canFollowup) return;
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

  const directTask = direct?.task.id === taskId ? direct.task : null;
  const deskTask = desk?.task.task_guid === taskId ? desk.task : null;
  const initialDirectResponse = directTask?.initial_final_response
    || (direct?.followups.total === 0 ? directTask?.final_response : null);
  const title = directTask ? directTaskTitle(directTask.text, 180)
    : deskTask?.input?.summary || (loading ? "正在加载任务…" : "任务详情");
  const status = directTask ? DIRECT_STATUS_LABELS[directTask.status] || directTask.status : deskTask?.state ?? "";
  const canFollowup = source === "direct" ? Boolean(direct?.can_followup) : Boolean(desk?.can_followup);
  const active = source === "direct"
    ? directTask?.status === "RUNNING" || directTask?.status === "QUEUED"
    : deskTask?.state === "RUNNING" || deskTask?.state === "QUEUED";

  return <main className="page-main task-detail-page codex-thread-page-shell">
    <section className="task-detail-panel" aria-labelledby="task-detail-page-title">
      <header className="task-detail-page-head">
        <button className="codex-thread-back" type="button" onClick={() => navigate(returnTo)} aria-label="返回任务列表" title="返回任务列表">‹</button>
        <div className="task-detail-page-heading">
          <h1 id="task-detail-page-title">{title}</h1>
          <div className="task-detail-page-meta">
            <span className="guid">{taskId}</span>
            <span>{source === "direct" ? "飞书 Direct" : deskTask?.origin === "web" ? "Bridge 看板" : "飞书任务"}</span>
            {status ? <span>{status}</span> : null}
            {directTask ? <span>{directTask.attempt} 次执行</span> : deskTask ? <span>{desk?.runs.length ?? 0} 次运行</span> : null}
            {(directTask?.thread_id || deskTask?.thread_id) ? <span className="guid">Thread：{directTask?.thread_id || deskTask?.thread_id}</span> : null}
          </div>
        </div>
        <button className="task-detail-page-refresh" type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading} aria-label="刷新详情" title="刷新详情">↻</button>
      </header>
      {error ? <div className="task-detail-page-error" role="alert">{error}</div> : null}
      <div className="task-detail-page-scroll" ref={scrollRef}>
        {loading && !directTask && !deskTask ? <div className="empty">正在读取任务详情…</div> : null}
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
        {source === "desk" && deskTask && desk ? <>
          {desk.runs.length ? desk.runs.slice().reverse().map((run) => <DeskRunTurn run={run} key={run.run_id} />)
            : <div className="task-detail-message is-user"><small>任务描述</small><div>{deskTask.input?.description || "（无描述）"}</div></div>}
          {deskTask.progress_text && active ? <div className="task-detail-progress">{deskTask.progress_text}</div> : null}
          {deskTask.last_error ? <div className="task-detail-page-error">{deskTask.last_error}</div> : null}
          {desk.attachments.length ? <details className="task-detail-extra"><summary>附件（{desk.attachments.length}）</summary>{desk.attachments.map((item) => <p key={item.attachment_id}><a href={taskAttachmentUrl(taskId, item.attachment_id)} target="_blank" rel="noreferrer">{item.file_name}</a></p>)}</details> : null}
          <details className="task-detail-extra" open={filesOpen} onToggle={(event) => setFilesOpen(event.currentTarget.open)}><summary>服务器文件</summary>{filesOpen ? <TaskFileBrowser taskGuid={taskId} /> : null}</details>
          {active ? <button className="danger" type="button" disabled={interrupting} onClick={() => void interrupt()}>{interrupting ? "正在中断…" : "中断当前执行"}</button> : null}
        </> : null}
      </div>
      <form className="task-detail-composer" onSubmit={(event) => void submit(event)}>
        <textarea aria-label="追加信息" value={draft} onChange={(event) => updateDraft(event.target.value)} maxLength={2000}
          placeholder={canFollowup ? "向当前任务追加信息…" : "当前任务暂时不能追加信息"}
          disabled={!canFollowup || sending}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button className="primary" type="submit" disabled={!canFollowup || !draft.trim() || sending}>{sending ? "发送中…" : "发送"}</button>
      </form>
    </section>
  </main>;
}

function TaskAgentMessage({ text }: { text: string }): ReactElement {
  return <div className="task-detail-message is-agent"><small>执行结果</small><div className="task-detail-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div></div>;
}

function DeskRunTurn({ run }: { run: StoredRun }): ReactElement {
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
    {run.progress_text && (run.state === "RUNNING" || run.state === "QUEUED") ? <div className="task-detail-progress">{run.progress_text}</div> : null}
  </div>;
}
