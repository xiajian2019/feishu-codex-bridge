import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import { createIosTestflightApp, fetchIosTestflightApps, getActionToken, updateIosTestflightApp, type IosTestflightApp, type IosTestflightAppInput, type IosTestflightStatus } from "./api.js";
import { readBridgeJson } from "./bridge-json.js";
import { getBridgeOrigin } from "./mobile-runtime.js";
import "./testflight.css";

const emptyForm: IosTestflightAppInput = {
  name: "", appStoreName: "", sourcePath: "", projectPath: "", buildDirectory: "", publicDirectory: "",
  bundleId: "", teamId: "", scheme: "App", configuration: "PersonalRelease", targetName: "App", infoPlistPath: "",
  enabled: true, internalOnly: true,
};

async function testFlightRequest<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const server = getBridgeOrigin();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["X-Bridge-Action-Token"] = await getActionToken();
  }
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const payload = await readBridgeJson<T & { error?: string }>(response);
  if (server !== getBridgeOrigin()) throw new Error("Bridge 环境已切换，请重新操作。");
  if (!response.ok) throw new Error(payload.error || `TestFlight 请求失败（${response.status}）。`);
  return payload;
}

function formatTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function stateText(state: IosTestflightStatus["state"]): string {
  return { idle: "尚未上传", running: "正在上传", succeeded: "已提交", failed: "上传失败" }[state];
}

function betaGroupText(status: IosTestflightStatus): string {
  const name = status.betaGroupName || "测试";
  if (status.betaGroupState === "added") return `${name}（已加入）`;
  if (status.betaGroupState === "pending") return `${name}（等待 Processing）`;
  if (status.betaGroupState === "failed") return `${name}（加入失败）`;
  return `${name}（尚未关联）`;
}

function immutableRows(app: IosTestflightApp): Array<[string, string]> {
  return [
    ["App Store Connect 名称", app.app_store_name], ["Bundle ID", app.bundle_id], ["Apple Team ID", app.team_id],
    ["源码目录", app.source_path], ["Xcode 工程", app.project_path], ["Scheme / Configuration", `${app.scheme} / ${app.configuration}`],
    ["Target", app.target_name], ["Info.plist", app.info_plist_path], ["构建输出", app.build_directory], ["App public", app.public_directory],
  ];
}

export function TestFlight(): ReactElement {
  const [apps, setApps] = useState<IosTestflightApp[]>([]);
  const [statusById, setStatusById] = useState<Record<string, IosTestflightStatus>>({});
  const [busyById, setBusyById] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<IosTestflightAppInput>(emptyForm);
  const [filter, setFilter] = useState("");
  const selectedApp = apps.find((app) => app.id === selectedId) ?? null;
  const selectedStatus = selectedId ? statusById[selectedId] : null;
  const visibleApps = apps.filter((app) => {
    const query = filter.trim().toLocaleLowerCase();
    return !query || `${app.name} ${app.app_store_name} ${app.bundle_id}`.toLocaleLowerCase().includes(query);
  });

  const refreshStatus = useCallback(async (appId: string): Promise<IosTestflightStatus> => {
    const result = await testFlightRequest<{ appId: string; status: IosTestflightStatus }>(`/api/mobile/testflight?appId=${encodeURIComponent(appId)}`);
    setStatusById((current) => ({ ...current, [appId]: result.status }));
    return result.status;
  }, []);

  const loadApps = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await fetchIosTestflightApps();
      setApps(next);
      setSelectedId((current) => current && next.some((app) => app.id === current) ? current : null);
      const results = await Promise.all(next.map(async (app) => [app.id, await refreshStatus(app.id)] as const));
      setStatusById(Object.fromEntries(results));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 TestFlight App 配置。"); }
    finally { setLoading(false); }
  }, [refreshStatus]);

  useEffect(() => { void loadApps(); }, [loadApps]);
  useEffect(() => {
    if (!apps.some((app) => statusById[app.id]?.state === "running")) return;
    const timer = window.setInterval(() => { for (const app of apps) if (statusById[app.id]?.state === "running") void refreshStatus(app.id); }, 3_000);
    return () => window.clearInterval(timer);
  }, [apps, refreshStatus, statusById]);

  const openNew = (): void => { setEditing(null); setForm(emptyForm); setFormOpen(true); setError(""); };
  const openEdit = (app: IosTestflightApp): void => {
    setEditing(app.id);
    setForm({
      name: app.name, appStoreName: app.app_store_name, sourcePath: app.source_path, projectPath: app.project_path,
      buildDirectory: app.build_directory, publicDirectory: app.public_directory, bundleId: app.bundle_id, teamId: app.team_id,
      scheme: app.scheme, configuration: app.configuration, targetName: app.target_name, infoPlistPath: app.info_plist_path,
      enabled: app.enabled, internalOnly: app.internal_only,
    });
    setFormOpen(true); setError("");
  };
  const saveApp = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setError("");
    try {
      const saved = editing ? await updateIosTestflightApp(editing, form) : await createIosTestflightApp(form);
      setFormOpen(false); await loadApps(); setSelectedId(saved.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "TestFlight App 保存失败。"); }
  };
  const startUpload = async (app: IosTestflightApp): Promise<void> => {
    const currentStatus = statusById[app.id];
    if (currentStatus?.state === "running" || busyById[app.id]) return;
    if (!window.confirm(`将“${app.name}”自动递增构建${currentStatus?.nextBuildNumber ? `（预计构建 ${currentStatus.nextBuildNumber}）` : ""}并上传到 TestFlight。继续？`)) return;
    setBusyById((current) => ({ ...current, [app.id]: true })); setError("");
    try {
      const result = await testFlightRequest<{ appId: string; status: IosTestflightStatus }>("/api/mobile/testflight/upload", "POST", { appId: app.id });
      setStatusById((current) => ({ ...current, [app.id]: result.status }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : `无法开始“${app.name}”的 TestFlight 上传。`); }
    finally { setBusyById((current) => ({ ...current, [app.id]: false })); }
  };

  if (selectedApp) return <main className="page-main testflight-page">
    <header className="testflight-header"><div><button className="testflight-back" type="button" onClick={() => setSelectedId(null)}>← 返回 App 列表</button><h1>{selectedApp.name}</h1><p>{selectedApp.app_store_name} · {selectedApp.bundle_id}</p></div><div className="testflight-header-actions"><button type="button" onClick={() => void refreshStatus(selectedApp.id)} disabled={loading}>刷新</button><button type="button" onClick={() => openEdit(selectedApp)}>编辑可编辑项</button></div></header>
    {error ? <p className="testflight-error" role="alert">{error}</p> : null}
    {!selectedStatus ? <p className="testflight-muted">正在读取 App 详情…</p> : <>
      <section className="testflight-card" aria-labelledby="testflight-status-title"><div className="testflight-section-header"><h2 id="testflight-status-title">上传状态</h2><span>{selectedStatus.buildNumber ? `构建 ${selectedStatus.buildNumber}` : "尚未上传"}</span></div><dl className="testflight-status-grid"><div><dt>当前状态</dt><dd>{stateText(selectedStatus.state)}</dd></div><div><dt>测试群组</dt><dd>{betaGroupText(selectedStatus)}</dd></div><div><dt>源码与工程</dt><dd>{selectedStatus.sourceAvailable ? "可用" : "不可用"}</dd></div><div><dt>API Key</dt><dd>{selectedStatus.apiKeyConfigured ? "已配置" : "未配置"}</dd></div><div><dt>开始时间</dt><dd>{formatTime(selectedStatus.startedAt)}</dd></div><div><dt>结束时间</dt><dd>{formatTime(selectedStatus.finishedAt)}</dd></div></dl>{selectedStatus.message ? <p className={`testflight-message${selectedStatus.state === "failed" || selectedStatus.betaGroupState === "failed" ? " is-error" : ""}`} role={selectedStatus.state === "failed" || selectedStatus.betaGroupState === "failed" ? "alert" : "status"}>{selectedStatus.message}</p> : null}</section>
      <section className="testflight-card" aria-labelledby="testflight-fixed-title"><h2 id="testflight-fixed-title">应用固定信息</h2><dl className="testflight-fixed-info">{immutableRows(selectedApp).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="testflight-muted">这些值来自应用配置记录；构建输出目录、App public 目录和 Info.plist 路径由工程配置推导，不在编辑表单中单独维护。</p></section>
    </>}
    {formOpen ? <AppFormDialog editing={editing !== null} form={form} busy={false} error={error} onChange={setForm} onClose={() => setFormOpen(false)} onSubmit={saveApp} /> : null}
  </main>;

  return <main className="page-main testflight-page"><header className="testflight-header"><div><h1>TestFlight 上传</h1><p>每个 App 一行管理；构建号自动递增，上传按钮直接放在列表中，低频配置进入详情页。</p></div><div className="testflight-header-actions"><button type="button" onClick={() => void loadApps()} disabled={loading}>刷新</button><button className="primary" type="button" onClick={openNew}>新增 App</button></div></header>{error ? <p className="testflight-error" role="alert">{error}</p> : null}<section className="testflight-app-list-section" aria-label="TestFlight App 列表"><label className="testflight-list-filter"><span aria-hidden="true">⌕</span><input type="search" placeholder="筛选 App" aria-label="筛选 App" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} /></label><div className="testflight-list-heading"><strong>应用</strong><span>{visibleApps.length} / {apps.length}</span></div><div className="testflight-session-list">{visibleApps.map((app) => { const appStatus = statusById[app.id]; const waitingForGroup = appStatus?.betaGroupState === "pending" && appStatus.state === "succeeded"; const appBusy = Boolean(busyById[app.id]) || appStatus?.state === "running" || waitingForGroup; return <article className="testflight-app-row" key={app.id}><button type="button" className="testflight-app-open" onClick={() => setSelectedId(app.id)}><span className="testflight-app-title"><strong>{app.name}</strong></span><span>{app.source_path}</span><span className="testflight-app-meta"><small>{app.app_store_name} · {app.bundle_id}</small><small>{app.scheme} · {app.configuration}</small></span></button><div className="testflight-list-upload"><span className="testflight-next-build">{appStatus ? `下一构建 ${appStatus.nextBuildNumber}` : "正在计算下一构建"}</span><button className="primary" type="button" onClick={() => void startUpload(app)} disabled={appBusy || !appStatus?.available}>{waitingForGroup ? "等待群组…" : appBusy ? "上传中…" : "构建上传"}</button><button type="button" onClick={() => setSelectedId(app.id)}>详情</button><button type="button" onClick={() => openEdit(app)}>编辑</button></div></article>; })}</div>{!loading && apps.length === 0 ? <p className="testflight-muted">尚未配置 App，请新增一条应用记录。</p> : null}{!loading && apps.length > 0 && visibleApps.length === 0 ? <p className="testflight-muted">没有匹配的 App。</p> : null}</section>{formOpen ? <AppFormDialog editing={false} form={form} busy={false} error={error} onChange={setForm} onClose={() => setFormOpen(false)} onSubmit={saveApp} /> : null}</main>;
}

function AppFormDialog({ editing, form, busy, error, onChange, onClose, onSubmit }: {
  editing: boolean;
  form: IosTestflightAppInput;
  busy: boolean;
  error: string;
  onChange: (form: IosTestflightAppInput) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactElement {
  const field = (key: keyof IosTestflightAppInput, label: string, options: { placeholder?: string } = {}): ReactElement => <label>{label}<input required value={String(form[key])} placeholder={options.placeholder} disabled={busy} onChange={(event) => onChange({ ...form, [key]: event.currentTarget.value })} /></label>;
  const fixed = (key: keyof IosTestflightAppInput, label: string): ReactElement => <div className="testflight-form-readonly"><span>{label}</span><strong>{String(form[key])}</strong></div>;
  return <div className="dialog-backdrop testflight-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="dialog testflight-dialog" role="dialog" aria-modal="true" aria-labelledby="testflight-form-title"><header className="testflight-dialog-header"><div><h2 id="testflight-form-title">{editing ? "编辑 App 设置" : "新增 TestFlight App"}</h2><p>{editing ? "仅可修改显示名称、启用状态和测试范围。工程身份创建后保持不变。" : "首次创建需要填写工程身份；构建目录、public 目录和 Info.plist 路径会由工程路径推导。"}</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button></header><form className="testflight-form" onSubmit={onSubmit}>{field("name", "配置名称", { placeholder: "例如 bjump" })}{editing ? <div className="testflight-form-readonly"><span>App Store Connect 名称</span><strong>{form.appStoreName}</strong></div> : field("appStoreName", "App Store Connect 名称", { placeholder: "例如 bjump" })}{editing ? fixed("bundleId", "Bundle ID") : field("bundleId", "Bundle ID", { placeholder: "com.example.app" })}{editing ? fixed("teamId", "Apple Team ID") : field("teamId", "Apple Team ID", { placeholder: "XXXXXXXXXX" })}{editing ? fixed("sourcePath", "源码目录") : field("sourcePath", "源码目录", { placeholder: "/Users/you/work/app" })}{editing ? fixed("projectPath", "Xcode 工程目录") : field("projectPath", "Xcode 工程目录", { placeholder: "/Users/you/work/app/ios/App/App.xcodeproj" })}<div className="testflight-form-two">{editing ? fixed("scheme", "Scheme") : field("scheme", "Scheme")}{editing ? fixed("configuration", "Configuration") : field("configuration", "Configuration")}</div><div className="testflight-form-two">{editing ? fixed("targetName", "Target") : field("targetName", "Target")}<div className="testflight-form-readonly"><span>Info.plist / 输出目录</span><strong>由工程配置自动推导</strong></div></div><label className="testflight-checkbox"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={(event) => onChange({ ...form, enabled: event.currentTarget.checked })} />启用此 App 配置</label><label className="testflight-checkbox"><input type="checkbox" checked={form.internalOnly} disabled={busy} onChange={(event) => onChange({ ...form, internalOnly: event.currentTarget.checked })} />仅上传 TestFlight 内部测试</label>{error ? <p className="testflight-error" role="alert">{error}</p> : null}<button className="primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</button></form></section></div>;
}
