import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import { createProject, fetchProjects, updateProject } from "./api.js";
import type { ProjectRecord, ProjectStatus } from "./types.js";

export function ProjectManagement(): ReactElement {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "available" | "disabled" | "unavailable">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("available");

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setProjects(await fetchProjects());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const resetForm = (): void => {
    setEditing(null);
    setFormOpen(false);
    setName("");
    setPath("");
    setStatus("available");
    setError(null);
  };
  const editProject = (project: ProjectRecord): void => {
    setEditing(project.name);
    setName(project.name);
    setPath(project.path);
    setStatus(project.status);
    setError(null);
    setFormOpen(true);
  };
  const saveProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await updateProject(editing, { path: path.trim(), status });
      else await createProject({ name: name.trim(), path: path.trim(), status });
      resetForm();
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const visible = projects.filter((project) => {
    const q = search.trim().toLowerCase();
    const matchesQuery = !q || `${project.name} ${project.path}`.toLowerCase().includes(q);
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "available" && project.available)
      || (statusFilter === "disabled" && project.status === "disabled")
      || (statusFilter === "unavailable" && project.status === "available" && !project.available);
    return matchesQuery && matchesStatus;
  });

  return <main className="page-main project-management-page">
    <header className="project-management-header">
      <h1>项目管理</h1>
      <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="刷新项目">↻</button>
    </header>
    <section className="project-management-filters" aria-label="筛选项目">
      <div className="project-manager-toolbar">
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目名称或目录" aria-label="筛选项目" />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="按项目状态筛选">
          <option value="all">全部状态</option><option value="available">可用</option><option value="disabled">已停用</option><option value="unavailable">路径不可用</option>
        </select>
      </div>
      {error && !formOpen ? <div className="error" role="alert">{error}</div> : null}
    </section>
    <section className="project-management-list" aria-labelledby="project-list-title">
      <header>
        <h2 id="project-list-title">项目列表</h2>
        <span className="muted">{visible.length} / {projects.length} 个项目</span>
        <button className="primary" type="button" onClick={() => { resetForm(); setFormOpen(true); }}>新增项目</button>
      </header>
      <div className="project-manager-list" aria-live="polite">
        {loading && projects.length === 0 ? <p className="muted">正在加载项目…</p> : null}
        {visible.map((project) => <div className="project-manager-row" key={project.name}>
          <div className="project-manager-details">
            <div className="project-manager-title">
              <strong>{project.name}</strong>
              <span className={project.available ? "project-status-available" : "project-status-disabled"}>{project.available ? "可用" : project.status === "disabled" ? "已停用" : "路径不可用"}</span>
            </div>
            <span className="project-manager-path">{project.path}</span>
          </div>
          <button type="button" onClick={() => editProject(project)}>编辑</button>
        </div>)}
        {!loading && projects.length === 0 ? <p className="muted">尚未登记项目。</p> : !loading && visible.length === 0 ? <p className="muted">没有符合条件的项目。</p> : null}
      </div>
    </section>
    {formOpen ? <div className="dialog-backdrop project-management-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) resetForm();
    }}>
      <section className="dialog project-management-dialog" role="dialog" aria-modal="true" aria-labelledby="project-form-title">
        <header className="project-management-dialog-header">
          <h2 id="project-form-title">{editing ? "编辑项目" : "新增项目"}</h2>
          <button type="button" className="project-management-dialog-close" onClick={resetForm} disabled={busy} aria-label="关闭">×</button>
        </header>
        <form className="project-manager-form project-management-form" onSubmit={(event) => void saveProject(event)}>
          <label>项目名称<input autoFocus={!editing} value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} disabled={Boolean(editing) || busy} placeholder="例如 food" /></label>
          <label>本机目录<input value={path} onChange={(event) => setPath(event.target.value)} required disabled={busy} placeholder="/Users/you/work/project 或 ~/work/project" /></label>
          <label>状态<select value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)} disabled={busy}><option value="available">可用</option><option value="disabled">停用</option></select></label>
          {error ? <div className="error" role="alert">{error}</div> : null}
          <button className="primary project-management-save" type="submit" disabled={busy || !name.trim() || !path.trim()}>{busy ? "保存中…" : "保存项目"}</button>
        </form>
      </section>
    </div> : null}
  </main>;
}
