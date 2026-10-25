import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { ProjectRecord } from "./types.js";
import { getJson } from "./api.js";
import {
  createWorkbenchAutomation,
  deleteWorkbenchAutomation,
  fetchWorkbenchAutomationRuns,
  fetchWorkbenchAutomations,
  runWorkbenchAutomation,
  updateWorkbenchAutomation,
  type WorkbenchAutomation,
  type WorkbenchAutomationRun,
  type WorkbenchTarget,
} from "./workbench-api.js";
import "./workbench.css";

type TargetMode = "project" | "task" | "history";
interface AutomationForm {
  targetMode: TargetMode;
  projectKey: string;
  targetSource: "desk" | "direct";
  targetId: string;
  homeId: string;
  text: string;
  intervalMinutes: string;
  timeZone: string;
  enabled: boolean;
}

const blankForm = (): AutomationForm => ({
  targetMode: "project",
  projectKey: "",
  targetSource: "desk",
  targetId: "",
  homeId: "",
  text: "",
  intervalMinutes: "60",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  enabled: true,
});

export function Automations(): ReactElement {
  const [automations, setAutomations] = useState<WorkbenchAutomation[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState<AutomationForm>(blankForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<{ id: string; message: string } | null>(null);
  const [runs, setRuns] = useState<Record<string, WorkbenchAutomationRun[]>>({});
  const [runsLoading, setRunsLoading] = useState<string | null>(null);
  const runIdempotencyKeys = useRef(new Map<string, string>());

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const [automationResult, projectResult] = await Promise.allSettled([
      fetchWorkbenchAutomations(),
      getJson<{ projects: ProjectRecord[] }>("/api/projects"),
    ]);
    if (automationResult.status === "fulfilled") setAutomations(automationResult.value.automations);
    else setError(toError(automationResult.reason));
    if (projectResult.status === "fulfilled") {
      setProjects(projectResult.value.projects.filter((project) => project.status === "available" && project.available));
      setProjectError(null);
    } else {
      setProjectError(toError(projectResult.reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const beginEdit = (automation?: WorkbenchAutomation): void => {
    if (!automation) {
      setEditingId(null);
      setForm({ ...blankForm(), projectKey: projects[0]?.name ?? "" });
      setRunNotice(null);
      return;
    }
    const target = automation.target;
    const targetMode: TargetMode = automation.projectKey ? "project" : target?.kind === "history" ? "history" : "task";
    setEditingId(automation.id);
    setForm({
      targetMode,
      projectKey: automation.projectKey ?? "",
      targetSource: target?.kind === "task" && target.source === "direct" ? "direct" : "desk",
      targetId: target?.id ?? "",
      homeId: target?.kind === "history" ? target.homeId ?? "" : "",
      text: automation.text,
      intervalMinutes: String(automation.intervalMinutes),
      timeZone: automation.timeZone,
      enabled: automation.enabled,
    });
    setRunNotice(null);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const intervalMinutes = Number(form.intervalMinutes);
    if (!form.text.trim()) { setError("请输入自动化提示词。"); return; }
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525_600) {
      setError("周期须为 1 到 525600 分钟。");
      return;
    }
    try { new Intl.DateTimeFormat("en", { timeZone: form.timeZone }).format(); }
    catch { setError("请输入有效的 IANA 时区，例如 Asia/Shanghai。"); return; }
    if (form.targetMode === "project" && !form.projectKey) { setError("请选择已登记且可用的项目。"); return; }
    if (form.targetMode !== "project" && !form.targetId.trim()) { setError("请输入关联目标 ID。"); return; }
    if (form.targetMode === "history" && !form.homeId.trim()) { setError("History 目标需要 Home ID。"); return; }

    const reference: { target?: WorkbenchTarget; projectKey?: string } = form.targetMode === "project"
      ? { projectKey: form.projectKey }
      : form.targetMode === "task"
        ? { target: { kind: "task", source: form.targetSource, id: form.targetId.trim() } }
        : { target: { kind: "history", homeId: form.homeId.trim(), id: form.targetId.trim() } };
    const payload = {
      ...reference,
      text: form.text,
      intervalMinutes,
      timeZone: form.timeZone.trim(),
      enabled: form.enabled,
    };

    setSaving(true);
    setError(null);
    try {
      const result = editingId
        ? await updateWorkbenchAutomation(editingId, {
            ...payload,
            ...(reference.projectKey ? { target: null } : { projectKey: null }),
          })
        : await createWorkbenchAutomation(payload);
      if (result.automation) {
        setAutomations((current) => [result.automation, ...current.filter((item) => item.id !== result.automation.id)]);
      } else {
        setRefreshKey((value) => value + 1);
      }
      setEditingId(null);
      setForm(blankForm());
    } catch (failure) {
      setError(toError(failure));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (automation: WorkbenchAutomation): Promise<void> => {
    if (busyId) return;
    setBusyId(automation.id);
    setError(null);
    try {
      const result = await updateWorkbenchAutomation(automation.id, { enabled: !automation.enabled });
      setAutomations((current) => current.map((item) => item.id === automation.id ? result.automation : item));
    } catch (failure) { setError(toError(failure)); }
    finally { setBusyId(null); }
  };

  const runNow = async (automation: WorkbenchAutomation): Promise<void> => {
    if (busyId) return;
    setBusyId(automation.id);
    setRunNotice(null);
    setError(null);
    try {
      const idempotencyKey = runIdempotencyKeys.current.get(automation.id) ?? createRunIdempotencyKey();
      runIdempotencyKeys.current.set(automation.id, idempotencyKey);
      const result = await runWorkbenchAutomation(automation.id, idempotencyKey);
      const submissionStatus = result.run?.submissionStatus ?? result.status ?? "accepted";
      if (submissionStatus !== "unconfirmed") runIdempotencyKeys.current.delete(automation.id);
      setRunNotice({
        id: automation.id,
        message: runSubmissionMessage(submissionStatus, result.run?.executionStatus),
      });
      await loadRuns(automation.id);
      setRefreshKey((value) => value + 1);
    } catch (failure) {
      setError(`立即运行请求失败或结果未确认；未自动重发，再次手动尝试会复用同一幂等键。${toError(failure)}`);
    }
    finally { setBusyId(null); }
  };

  const remove = async (automation: WorkbenchAutomation): Promise<void> => {
    if (busyId || !window.confirm(`删除自动化“${automation.title || firstLine(automation.text)}”？`)) return;
    setBusyId(automation.id);
    setError(null);
    try {
      await deleteWorkbenchAutomation(automation.id);
      setAutomations((current) => current.filter((item) => item.id !== automation.id));
      setRuns((current) => { const next = { ...current }; delete next[automation.id]; return next; });
      if (editingId === automation.id) { setEditingId(null); setForm(blankForm()); }
    } catch (failure) { setError(toError(failure)); }
    finally { setBusyId(null); }
  };

  const loadRuns = async (id: string): Promise<void> => {
    setRunsLoading(id);
    try {
      const result = await fetchWorkbenchAutomationRuns(id);
      setRuns((current) => ({ ...current, [id]: result.runs }));
    } catch (failure) {
      setError(`读取执行记录失败：${toError(failure)}`);
    } finally { setRunsLoading(null); }
  };

  return <main className="page-main workbench-page">
    <header className="workbench-page-header">
      <div><h1>自动化</h1><p className="workbench-muted">使用已登记项目或已有任务目标；每次运行状态会单独记录。</p></div>
      <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>刷新</button>
    </header>

    {error ? <div className="workbench-page-error" role="alert">{error}<button type="button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button></div> : null}
    {projectError ? <div className="workbench-page-error" role="status">项目列表不可用：{projectError}</div> : null}

    <section className="workbench-page-card" aria-label={editingId ? "编辑自动化" : "新建自动化"}>
      <h2>{editingId ? "编辑自动化" : "新建自动化"}</h2>
      <p className="workbench-settings-note">标题由提示词第一行生成。周期、时区和启用状态在保存后生效。</p>
      <div className="workbench-form-grid">
        <label>目标类型<select value={form.targetMode} onChange={(event) => setForm((current) => ({ ...current, targetMode: event.target.value as TargetMode }))}>
          <option value="project">创建项目任务</option><option value="task">关联现有任务</option><option value="history">关联 History 会话</option>
        </select></label>
        {form.targetMode === "project" ? <label>已登记项目<select value={form.projectKey} onChange={(event) => setForm((current) => ({ ...current, projectKey: event.target.value }))}>
          <option value="">选择可用项目</option>{projects.map((project) => <option key={project.name} value={project.name}>{project.name}</option>)}
        </select></label> : <>
          {form.targetMode === "task" ? <label>任务来源<select value={form.targetSource} onChange={(event) => setForm((current) => ({ ...current, targetSource: event.target.value as "desk" | "direct" }))}>
            <option value="desk">Bridge Task Desk</option><option value="direct">Feishu Direct</option>
          </select></label> : <label>Codex Home ID<input value={form.homeId} onChange={(event) => setForm((current) => ({ ...current, homeId: event.target.value }))} /></label>}
          <label>目标 ID<input value={form.targetId} onChange={(event) => setForm((current) => ({ ...current, targetId: event.target.value }))} /></label>
        </>}
        <label>周期（分钟）<input type="number" min={1} max={525_600} step={1} value={form.intervalMinutes} onChange={(event) => setForm((current) => ({ ...current, intervalMinutes: event.target.value }))} /></label>
        <label>时区（IANA）<input value={form.timeZone} placeholder="Asia/Shanghai" onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))} /></label>
        <label className="workbench-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />启用</label>
        <label className="workbench-form-wide">提示词<textarea rows={5} maxLength={20_000} value={form.text} onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))} placeholder="自动化执行的任务描述" /></label>
      </div>
      <div className="workbench-form-actions">
        <button type="button" className="primary" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : editingId ? "保存修改" : "创建自动化"}</button>
        {editingId ? <button type="button" onClick={() => { setEditingId(null); setForm(blankForm()); }}>取消</button> : null}
      </div>
    </section>

    <section className="workbench-page-card" aria-label="自动化列表">
      <h2>自动化列表</h2>
      {loading ? <p className="workbench-muted">正在读取…</p> : null}
      {!loading && automations.length === 0 ? <p className="workbench-muted">还没有自动化。创建后可暂停、立即提交一次或查看执行记录。</p> : null}
      <ul className="workbench-automation-list">
        {automations.map((automation) => <li className="workbench-automation-card" key={automation.id}>
          <header><div><h3>{automation.title || firstLine(automation.text)}</h3><div className="workbench-automation-meta">
            <span>{automation.enabled ? "运行中" : "已暂停"}</span>
            <span>每 {automation.intervalMinutes} 分钟 · {automation.timeZone}</span>
            <span>{automation.projectKey ? `项目 ${automation.projectKey}` : automation.target ? targetLabel(automation.target) : "目标未设置"}</span>
          </div></div>
            <button type="button" onClick={() => beginEdit(automation)}>编辑</button>
          </header>
          <p>{automation.text}</p>
          <div className="workbench-automation-meta">
            <span>下次：{formatTime(automation.nextRunAt)}</span><span>上次：{formatTime(automation.lastRunAt)}</span>
          </div>
          {automation.lastError ? <p className="workbench-page-error">最近错误：{automation.lastError}</p> : null}
          {runNotice?.id === automation.id ? <p className="workbench-status-note" role="status">{runNotice.message}</p> : null}
          <div className="workbench-automation-actions">
            <button type="button" onClick={() => void toggleEnabled(automation)} disabled={busyId === automation.id}>{automation.enabled ? "暂停" : "启用"}</button>
            <button type="button" onClick={() => void runNow(automation)} disabled={busyId === automation.id}>立即运行</button>
            <button type="button" onClick={() => void remove(automation)} disabled={busyId === automation.id}>删除</button>
          </div>
          <details onToggle={(event) => { if (event.currentTarget.open && runs[automation.id] === undefined) void loadRuns(automation.id); }}>
            <summary>执行记录</summary>
            {runsLoading === automation.id ? <p className="workbench-muted">正在读取执行记录…</p> : null}
            {runs[automation.id]?.length ? <ul className="workbench-run-list">{runs[automation.id].map((run, index) => <li className="workbench-run-card" key={run.id ?? `${automation.id}-${index}`}>
              <strong>{run.trigger === "manual" ? "手动" : run.trigger === "scheduled" ? "定时" : "触发"}</strong>
              <p><b>提交：</b>{submissionStatusLabel(run.submissionStatus)}。{runSubmissionMessage(run.submissionStatus, run.executionStatus)}</p>
              <p><b>执行：</b>{executionStatusLabel(run.executionStatus)}。</p>
              <small>开始：{formatTime(run.startedAt)} · 提交结束：{formatTime(run.submissionFinishedAt)} · 执行结束：{formatTime(run.executionFinishedAt)}</small>
              {run.taskTarget ? <small>目标：{targetLabel(run.taskTarget)}</small> : null}
              {run.submissionError ? <p>提交错误：{run.submissionError}</p> : null}
              {run.executionError ? <p>执行错误：{run.executionError}</p> : null}
            </li>)}</ul> : runs[automation.id] ? <p className="workbench-muted">暂无执行记录。</p> : null}
            <button type="button" onClick={() => void loadRuns(automation.id)} disabled={runsLoading === automation.id}>刷新记录</button>
          </details>
        </li>)}
      </ul>
    </section>
  </main>;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim() || "未命名自动化";
}

function targetLabel(target: WorkbenchTarget): string {
  if (target.kind === "task") return `${target.source} · ${target.id}`;
  return `History · ${target.homeId ?? ""} · ${target.id}`;
}

function formatTime(value: number | null | undefined): string {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function submissionStatusLabel(status: string): string {
  if (status === "pending") return "提交中";
  if (status === "accepted") return "已受理";
  if (status === "failed") return "提交失败";
  if (status === "unconfirmed") return "提交结果未确认";
  return status;
}

function executionStatusLabel(status: string): string {
  if (status === "not_started") return "尚未开始";
  if (status === "running") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "执行失败";
  if (status === "unconfirmed") return "执行结果未知";
  return status;
}

function runSubmissionMessage(submissionStatus: string, executionStatus?: string): string {
  const submission = submissionStatusLabel(submissionStatus);
  if (submissionStatus === "accepted" && (!executionStatus || executionStatus === "not_started")) {
    return `${submission}只代表提交成功，Codex 执行尚未开始或尚无结果。`;
  }
  if (submissionStatus === "unconfirmed") return `提交结果未知${executionStatus ? `；执行状态：${executionStatusLabel(executionStatus)}` : ""}；不会自动重发，请先核对关联任务与执行状态。`;
  if (submissionStatus === "failed") return `提交失败${executionStatus ? `；执行状态：${executionStatusLabel(executionStatus)}` : ""}，请查看提交错误。`;
  if (executionStatus) return `提交状态：${submission}；执行状态：${executionStatusLabel(executionStatus)}。`;
  return `提交状态：${submission}，Codex 执行结果尚未确认。`;
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRunIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
