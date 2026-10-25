import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  createWorkbenchMachine,
  deleteWorkbenchMachine,
  fetchWorkbenchMachines,
  updateWorkbenchMachine,
  type WorkbenchMachine,
} from "./workbench-api.js";
import "./workbench.css";

export function ExecutionMachines(): ReactElement {
  const [machines, setMachines] = useState<WorkbenchMachine[]>([]);
  const [localId, setLocalId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState({ name: "", url: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", url: "" });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWorkbenchMachines();
      setMachines(result.machines);
      setLocalId(result.localId);
    } catch (failure) {
      setError(toError(failure));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const addRemote = async (): Promise<void> => {
    if (saving || !form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createWorkbenchMachine({ name: form.name.trim(), kind: "remote", ...(form.url.trim() ? { url: form.url.trim() } : {}) });
      setMachines((current) => [result.machine, ...current.filter((machine) => machine.id !== result.machine.id)]);
      setForm({ name: "", url: "" });
    } catch (failure) { setError(toError(failure)); }
    finally { setSaving(false); }
  };

  const beginEdit = (machine: WorkbenchMachine): void => {
    setEditingId(machine.id);
    setEditForm({ name: machine.name, url: machine.url ?? "" });
  };

  const saveEdit = async (machine: WorkbenchMachine): Promise<void> => {
    if (busyId || !editForm.name.trim()) return;
    setBusyId(machine.id);
    setError(null);
    try {
      const result = await updateWorkbenchMachine(machine.id, {
        name: editForm.name.trim(),
        url: editForm.url.trim() || null,
      });
      setMachines((current) => current.map((item) => item.id === machine.id ? result.machine : item));
      setEditingId(null);
    } catch (failure) { setError(toError(failure)); }
    finally { setBusyId(null); }
  };

  const remove = async (machine: WorkbenchMachine): Promise<void> => {
    if (busyId || !window.confirm(`删除远程机器登记“${machine.name}”？这只会删除登记信息。`)) return;
    setBusyId(machine.id);
    setError(null);
    try {
      await deleteWorkbenchMachine(machine.id);
      setMachines((current) => current.filter((item) => item.id !== machine.id));
      if (editingId === machine.id) setEditingId(null);
    } catch (failure) { setError(toError(failure)); }
    finally { setBusyId(null); }
  };

  const localMachine = machines.find((machine) => machine.id === localId || machine.kind === "local");
  const remoteMachines = machines.filter((machine) => machine.kind === "remote");

  return <main className="page-main workbench-page">
    <header className="workbench-page-header">
      <div><h1>执行机器</h1><p className="workbench-muted">本机可由 Bridge 执行；远程机器当前仅保存登记信息。</p></div>
      <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>刷新</button>
    </header>

    {error ? <div className="workbench-page-error" role="alert">{error}<button type="button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button></div> : null}
    <p className="workbench-machine-warning">远程主机认证和执行协议尚未配置。登记 URL 不会建立连接，也不能把任务或 Session 迁移到远程主机。</p>

    <section className="workbench-page-card" aria-label="本地执行机器">
      <h2>本机</h2>
      {loading && !localMachine ? <p className="workbench-muted">正在读取…</p> : null}
      {localMachine ? <MachineCard machine={localMachine} local onEdit={() => undefined} onDelete={() => undefined} />
        : !loading ? <p className="workbench-muted">服务尚未返回本机执行机器信息。</p> : null}
    </section>

    <section className="workbench-page-card" aria-label="远程机器登记">
      <h2>登记远程机器</h2>
      <div className="workbench-form-grid">
        <label>名称<input value={form.name} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
        <label>地址（可选）<input value={form.url} placeholder="https://host.example" onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))} /></label>
      </div>
      <div className="workbench-form-actions"><button type="button" className="primary" onClick={() => void addRemote()} disabled={saving || !form.name.trim()}>{saving ? "保存中…" : "保存登记"}</button></div>
    </section>

    <section className="workbench-page-card" aria-label="已登记远程机器">
      <h2>远程登记 <span className="workbench-muted">{remoteMachines.length}</span></h2>
      {!loading && remoteMachines.length === 0 ? <p className="workbench-muted">暂无远程机器登记。</p> : null}
      <ul className="workbench-machine-list">{remoteMachines.map((machine) => <li className="workbench-machine-card" key={machine.id}>
        {editingId === machine.id ? <>
          <div className="workbench-form-grid">
            <label>名称<input value={editForm.name} maxLength={120} onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))} /></label>
            <label>地址（可选）<input value={editForm.url} onChange={(event) => setEditForm((current) => ({ ...current, url: event.target.value }))} /></label>
          </div>
          <div className="workbench-machine-actions">
            <button type="button" className="primary" onClick={() => void saveEdit(machine)} disabled={busyId === machine.id || !editForm.name.trim()}>{busyId === machine.id ? "保存中…" : "保存修改"}</button>
            <button type="button" onClick={() => setEditingId(null)} disabled={busyId === machine.id}>取消</button>
          </div>
        </> : <MachineCard machine={machine} local={false} onEdit={() => beginEdit(machine)} onDelete={() => void remove(machine)} />}
      </li>)}</ul>
    </section>
  </main>;
}

function MachineCard({ machine, local, onEdit, onDelete }: {
  machine: WorkbenchMachine;
  local: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): ReactElement {
  return <div>
    <header><div><h3>{machine.name || (local ? "本机" : "未命名机器")}</h3><div className="workbench-machine-meta">
      <span>{local ? "本地可执行" : machine.status === "unconnected" ? "未连接" : machine.status}</span>
      {machine.url ? <span>{machine.url}</span> : null}
      <span>{local ? `ID ${machine.id}` : `登记 ID ${machine.id}`}</span>
    </div></div>
      {!local ? <div className="workbench-machine-actions"><button type="button" onClick={onEdit}>编辑</button><button type="button" onClick={onDelete}>删除登记</button></div> : null}
    </header>
    <div className="workbench-machine-meta"><span>能力：{formatCapabilities(machine.capabilities)}</span></div>
    {!local ? <p className="workbench-status-note">该条目仅作主机备注，当前不能连接、执行或迁移任务。</p> : null}
  </div>;
}

function formatCapabilities(capabilities: WorkbenchMachine["capabilities"]): string {
  if (Array.isArray(capabilities)) return capabilities.length ? capabilities.join("、") : "未声明";
  const entries = Object.entries(capabilities);
  return entries.length ? entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : "未声明";
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
