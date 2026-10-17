import { useCallback, useEffect, useState, type ReactElement } from "react";
import { getActionToken, getJson } from "./api.js";
import type { TaskWorkspaceSummary } from "./types.js";

interface TaskWorkspaceRow extends TaskWorkspaceSummary {
  task_state: string | null;
  task_summary: string;
  active_session_count: number;
  inspection: {
    exists: boolean;
    currentBranch: string | null;
    headCommit: string | null;
    dirtyEntryCount: number;
    remoteBranches: string[];
    commitsAheadOfBase: number | null;
    mergedIntoBase: boolean | null;
    error: string | null;
  };
  blockers: string[];
  can_remove_directory: boolean;
  can_delete_branch: boolean;
}

interface TaskWorkspaceInventory {
  workspaces: TaskWorkspaceRow[];
  unmanaged: Array<{
    projectKey: string;
    path: string;
    branch: string | null;
    commit: string | null;
    prunable: boolean;
    inspection: {
      exists: boolean;
      headCommit: string | null;
      dirtyEntryCount: number;
      remoteBranches: string[];
      baseRef: string | null;
      commitsAheadOfBase: number | null;
      mergedIntoBase: boolean | null;
      error: string | null;
    };
  }>;
  tmuxStatusKnown: boolean;
}

const EMPTY_INVENTORY: TaskWorkspaceInventory = { workspaces: [], unmanaged: [], tmuxStatusKnown: true };

export function TaskWorkspaces(): ReactElement {
  const [inventory, setInventory] = useState(EMPTY_INVENTORY);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setInventory(await getJson<TaskWorkspaceInventory>("/api/task-workspaces"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const archive = async (workspace: TaskWorkspaceRow): Promise<void> => {
    if (!window.confirm(`归档任务「${workspace.task_summary}」并关闭后续续问？worktree 和分支仍会保留。`)) return;
    setBusyId(workspace.workspace_id);
    try {
      const token = await getActionToken();
      await getJson(`/api/task-workspaces/${encodeURIComponent(workspace.workspace_id)}/archive`, {
        method: "POST",
        headers: { "X-Bridge-Action-Token": token },
        body: JSON.stringify({}),
      });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (workspace: TaskWorkspaceRow, deleteBranch: boolean): Promise<void> => {
    const action = deleteBranch ? "移除 worktree 并删除已合并的本地分支" : "移除 worktree 目录并保留本地分支";
    if (!window.confirm(`确认${action}？\n${workspace.worktree_path}`)) return;
    setBusyId(workspace.workspace_id);
    try {
      const token = await getActionToken();
      const result = await getJson<{ branchError?: string | null }>(`/api/task-workspaces/${encodeURIComponent(workspace.workspace_id)}`, {
        method: "DELETE",
        headers: { "X-Bridge-Action-Token": token },
        body: JSON.stringify({ deleteBranch }),
      });
      await load();
      if (result.branchError) setError(result.branchError);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  return <main className="page-main task-workspace-manager">
    <header className="page-header">
      <h1>Git 工作区</h1>
      <button type="button" onClick={() => void load()} disabled={loading}>刷新</button>
    </header>
    <p className="muted">Bridge 管理的任务 worktree 与 tmux session 关联状态。预览不会 fetch、prune 或修改 Git。</p>
    {error ? <div className="error" role="alert">{error}</div> : null}
    {!inventory.tmuxStatusKnown ? <div className="task-workspace-warning" role="status">无法确认当前 tmux session 状态；清理操作会被阻止。</div> : null}
    <section className="task-workspace-section" aria-labelledby="managed-task-workspaces-title">
      <h2 id="managed-task-workspaces-title">任务工作区</h2>
      {loading ? <p className="muted">正在读取 worktree 状态…</p> : inventory.workspaces.length === 0 ? <p className="muted">还没有由 Bridge 创建的任务 worktree。</p> : null}
      <div className="task-workspace-list">
        {inventory.workspaces.map((workspace) => <article className="task-workspace-row" key={workspace.workspace_id}>
          <div className="task-workspace-row-heading">
            <div><h3>{workspace.task_summary}</h3><p>{workspace.project_key} · {workspace.task_state ?? "任务记录不可用"} · {workspace.status}</p></div>
            <strong>{workspace.branch}</strong>
          </div>
          <code className="task-workspace-path">{workspace.worktree_path}</code>
          <p className="task-workspace-evidence">HEAD {workspace.inspection.headCommit?.slice(0, 12) ?? "不可用"} · 基准 {workspace.base_sha.slice(0, 12)} · {workspace.inspection.dirtyEntryCount} 项未提交改动 · {workspace.active_session_count} 个关联 session</p>
          {workspace.inspection.remoteBranches.length ? <p className="task-workspace-evidence">远程分支：{workspace.inspection.remoteBranches.join(", ")}</p> : null}
          {workspace.inspection.mergedIntoBase === true ? <p className="task-workspace-evidence">已合并到基准分支。</p> : workspace.inspection.commitsAheadOfBase !== null ? <p className="task-workspace-evidence">相对基准有 {workspace.inspection.commitsAheadOfBase} 个提交。</p> : null}
          {workspace.last_error || workspace.inspection.error ? <p className="error">{workspace.last_error ?? workspace.inspection.error}</p> : null}
          {workspace.blockers.length ? <ul className="task-workspace-blockers">{workspace.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <p className="task-workspace-evidence">当前满足移除 worktree 目录的条件；分支默认保留。</p>}
          <div className="task-workspace-actions">
            {!workspace.followups_closed_at && workspace.task_state !== "QUEUED" && workspace.task_state !== "RUNNING" && workspace.status !== "removed" ? <button type="button" disabled={busyId === workspace.workspace_id} onClick={() => void archive(workspace)}>归档并关闭续问</button> : null}
            <button type="button" disabled={!workspace.can_remove_directory || busyId === workspace.workspace_id} onClick={() => void remove(workspace, false)}>移除目录，保留分支</button>
            {workspace.can_delete_branch ? <button className="danger" type="button" disabled={busyId === workspace.workspace_id} onClick={() => void remove(workspace, true)}>移除目录和已合并分支</button> : null}
          </div>
        </article>)}
      </div>
    </section>
    <section className="task-workspace-section" aria-labelledby="unmanaged-task-workspaces-title">
      <h2 id="unmanaged-task-workspaces-title">Git 中发现的其他 worktree</h2>
      <p className="muted">这些 worktree 未由 Bridge 任务创建或登记；这里只展示，不提供清理操作。</p>
      {inventory.unmanaged.length === 0 ? <p className="muted">没有发现其他 worktree。</p> : <div className="task-workspace-list">
        {inventory.unmanaged.map((worktree) => <article className="task-workspace-row is-unmanaged" key={`${worktree.projectKey}:${worktree.path}`}>
          <div className="task-workspace-row-heading"><h3>{worktree.projectKey}</h3><span>Bridge 未管理</span></div>
          <code className="task-workspace-path">{worktree.path}</code>
          <p className="task-workspace-evidence">{worktree.branch ?? "detached"} · {worktree.inspection.headCommit?.slice(0, 12) ?? worktree.commit?.slice(0, 12) ?? "无 HEAD"} · {worktree.inspection.dirtyEntryCount} 项未提交改动{worktree.prunable ? " · Git 标记为 prunable" : ""}</p>
          {worktree.inspection.remoteBranches.length ? <p className="task-workspace-evidence">远程分支：{worktree.inspection.remoteBranches.join(", ")}</p> : null}
          {worktree.inspection.baseRef ? <p className="task-workspace-evidence">基准 {worktree.inspection.baseRef} · {worktree.inspection.commitsAheadOfBase ?? "提交数未知"} 个提交{worktree.inspection.mergedIntoBase ? " · 已合并" : " · 未确认合并"}</p> : null}
          {worktree.inspection.error ? <p className="error">{worktree.inspection.error}</p> : null}
        </article>)}
      </div>}
    </section>
  </main>;
}
