import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from "react";
import {
  createMobileApp, fetchMobileApps, installMobileAppOnIos, updateMobileApp, uploadMobileAppToTestflight,
  type MobileAppInput, type MobileAppView,
} from "./api.js";
import "./app-management.css";

const emptyIos: NonNullable<MobileAppInput["ios"]> = {
  appStoreName: "", sourcePath: "", projectPath: "", buildDirectory: "", publicDirectory: "", bundleId: "", teamId: "",
  scheme: "App", configuration: "PersonalRelease", targetName: "App", infoPlistPath: "", internalOnly: true,
};
const emptyAndroid: NonNullable<MobileAppInput["android"]> = { packageName: "", apkPath: "", snapshotDirectory: "" };
const emptyForm: MobileAppInput = { name: "", enabled: true, ios: { ...emptyIos }, android: null };

function formatUpdatedAt(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function testflightState(view: MobileAppView): string {
  const state = view.ios?.testflight.state;
  return state === "running" ? "上传中" : state === "succeeded" ? "已提交" : state === "failed" ? "上传失败" : "尚未上传";
}

function appToForm(view: MobileAppView): MobileAppInput {
  return {
    name: view.app.name,
    enabled: view.app.enabled,
    ios: view.ios ? {
      appStoreName: view.ios.config.app_store_name, sourcePath: view.ios.config.source_path, projectPath: view.ios.config.project_path,
      buildDirectory: view.ios.config.build_directory, publicDirectory: view.ios.config.public_directory, bundleId: view.ios.config.bundle_id,
      teamId: view.ios.config.team_id, scheme: view.ios.config.scheme, configuration: view.ios.config.configuration,
      targetName: view.ios.config.target_name, infoPlistPath: view.ios.config.info_plist_path, internalOnly: view.ios.config.internal_only,
    } : null,
    android: view.android ? {
      packageName: view.android.config.package_name, apkPath: view.android.config.apk_path, snapshotDirectory: view.android.config.snapshot_directory,
    } : null,
  };
}

export function AppManagement(): ReactElement {
  const [apps, setApps] = useState<MobileAppView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<MobileAppInput>(emptyForm);
  const [busyId, setBusyId] = useState<string | null>(null);
  const selected = apps.find((view) => view.app.id === selectedId) ?? null;
  const visibleApps = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return apps.filter((view) => !query || `${view.app.name} ${view.ios?.config.bundle_id ?? ""} ${view.android?.config.package_name ?? ""}`.toLocaleLowerCase().includes(query));
  }, [apps, filter]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await fetchMobileApps();
      setApps(next);
      setSelectedId((current) => current && next.some((view) => view.app.id === current) ? current : null);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取App管理配置。"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!apps.some((view) => view.ios?.testflight.state === "running" || view.ios?.deviceInstall.state === "running")) return;
    const timer = window.setInterval(() => { void load(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [apps, load]);

  const openNew = (): void => { setEditing(null); setForm({ ...emptyForm, ios: { ...emptyIos } }); setFormOpen(true); setError(""); };
  const openEdit = (view: MobileAppView): void => { setEditing(view.app.id); setForm(appToForm(view)); setFormOpen(true); setError(""); };
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setBusyId("form"); setError("");
    try {
      const saved = editing ? await updateMobileApp(editing, form) : await createMobileApp(form);
      setFormOpen(false); await load(); setSelectedId(saved.app.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "App配置保存失败。"); }
    finally { setBusyId(null); }
  };
  const upload = async (view: MobileAppView): Promise<void> => {
    if (!view.ios || busyId) return;
    if (!window.confirm(`将“${view.app.name}”构建并上传到TestFlight，预计构建 ${view.ios.testflight.nextBuildNumber}。继续？`)) return;
    setBusyId(view.app.id); setError("");
    try { await uploadMobileAppToTestflight(view.app.id); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "TestFlight 上传失败。"); }
    finally { setBusyId(null); }
  };
  const install = async (view: MobileAppView): Promise<void> => {
    if (!view.ios || busyId) return;
    const devices = view.ios.deviceInstall.devices.filter((device) => device.transport === "wired" && device.pairing === "paired" && device.connectionState === "connected");
    if (devices.length === 0) { setError("请先连接USB。"); return; }
    if (!window.confirm(`将在USB设备上重新构建并安装“${view.app.name}”。继续？`)) return;
    setBusyId(view.app.id); setError("");
    try { await installMobileAppOnIos(view.app.id); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "iOS本地安装失败。"); }
    finally { setBusyId(null); }
  };

  if (selected) return <><AppDetail view={selected} busy={busyId === selected.app.id} error={error} onBack={() => setSelectedId(null)} onEdit={() => openEdit(selected)} onRefresh={() => void load()} onUpload={() => void upload(selected)} onInstall={() => void installSelected(selected, load, setError, setBusyId)} />{formOpen ? <AppFormDialog form={form} editing={Boolean(editing)} busy={busyId === "form"} error={error} onChange={setForm} onClose={() => setFormOpen(false)} onSubmit={save} /> : null}</>;
  return <main className="page-main app-management-page">
    <header className="app-management-header app-list-header"><div><h1>App管理</h1></div><div className="app-management-header-actions"><button className="app-management-icon-button" type="button" onClick={() => void load()} disabled={loading} aria-label="刷新App列表" title="刷新App列表"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 11a8 8 0 0 0-14.93-4M4 4v4h4M4 13a8 8 0 0 0 14.93 4M20 20v-4h-4" /></svg></button><button className="primary" type="button" onClick={openNew}>新增App</button></div></header>
    {error ? <p className="app-management-error" role="alert">{error}</p> : null}
    <section className="app-management-toolbar"><label><span aria-hidden="true">⌕</span><input type="search" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="搜索App、Bundle ID或包名" aria-label="搜索App" /></label><span>{visibleApps.length} / {apps.length}个App</span></section>
    {loading && apps.length === 0 ? <p className="app-management-muted">正在读取App配置…</p> : null}
    <section className="app-management-list" aria-label="App列表">{visibleApps.map((view) => <AppCard key={view.app.id} view={view} busy={busyId === view.app.id} onOpen={() => setSelectedId(view.app.id)} onEdit={() => openEdit(view)} onUpload={() => void upload(view)} onInstall={() => void install(view)} />)}</section>
    {!loading && apps.length === 0 ? <section className="app-management-empty"><strong>还没有App</strong><span>新增App后，再选择它支持iOS、Android或双端。</span><button className="primary" type="button" onClick={openNew}>新增App</button></section> : null}
    {!loading && apps.length > 0 && visibleApps.length === 0 ? <p className="app-management-muted">没有匹配的 App。</p> : null}
    {formOpen ? <AppFormDialog form={form} editing={Boolean(editing)} busy={busyId === "form"} error={error} onChange={setForm} onClose={() => setFormOpen(false)} onSubmit={save} /> : null}
  </main>;
}

function AppCard({ view, busy, onOpen, onEdit, onUpload, onInstall }: { view: MobileAppView; busy: boolean; onOpen: () => void; onEdit: () => void; onUpload: () => void; onInstall: () => void }): ReactElement {
  const latest = view.android?.latest;
  return <article className={`app-management-card${view.app.enabled ? "" : " is-disabled"}`}>
    <button className="app-management-card-main" type="button" onClick={onOpen}><span className="app-management-card-title"><strong>{view.app.name}</strong><span className="app-management-status-chip">{view.app.enabled ? "启用" : "停用"}</span></span><span className="app-management-platforms">{view.ios ? <span className="platform-chip ios">iOS</span> : null}{view.android ? <span className="platform-chip android">Android</span> : null}</span><small>{view.ios?.config.bundle_id ?? view.android?.config.package_name ?? "未配置平台标识"}</small></button>
    <div className="app-management-card-actions"><div className="app-management-summary">{view.ios ? <span>{`iOS：${testflightState(view)}`}</span> : null}{view.android ? <span>{latest ? `Android：${latest.versionName} (${latest.versionCode})` : view.android.error ? "Android：APK不可用" : "Android：未生成APK"}</span> : null}</div><button type="button" onClick={onEdit}>编辑</button>{view.ios ? <button className="app-management-delivery-action" type="button" disabled={busy || view.ios.testflight.state === "running"} onClick={onUpload}>{busy || view.ios.testflight.state === "running" ? "处理中…" : "上传TestFlight"}</button> : null}{view.android && latest ? <a className="app-management-button app-management-delivery-action" href={latest.downloadUrl}>下载APK</a> : null}{view.ios ? <button type="button" disabled={busy || view.ios.deviceInstall.state === "running"} onClick={onInstall}>USB安装</button> : null}</div>
  </article>;
}

function AppDetail({ view, busy, error, onBack, onEdit, onRefresh, onUpload, onInstall }: { view: MobileAppView; busy: boolean; error: string; onBack: () => void; onEdit: () => void; onRefresh: () => void; onUpload: () => void; onInstall: () => void }): ReactElement {
  const latest = view.android?.latest;
  return <main className="page-main app-management-page"><header className="app-management-header app-detail-header"><div className="app-detail-title-row"><button className="app-management-icon-button app-management-back" type="button" onClick={onBack} aria-label="返回App列表" title="返回App列表"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12H5m7 7-7-7 7-7" /></svg></button><h1 className="app-management-detail-title"><span>{view.app.name}</span><small>更新于 {formatUpdatedAt(view.app.updated_at)}</small></h1></div><div className="app-management-header-actions"><button className="app-management-icon-button" type="button" onClick={onRefresh} aria-label="刷新App状态" title="刷新App状态"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 11a8 8 0 0 0-14.93-4M4 4v4h4M4 13a8 8 0 0 0 14.93 4M20 20v-4h-4" /></svg></button><button className="app-management-icon-button" type="button" onClick={onEdit} aria-label="编辑App配置" title="编辑App配置"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15.5 5.5 3 3M4 20l4.2-.8L19 8.4a2.1 2.1 0 0 0-3-3L5.2 16.2 4 20Z" /></svg></button></div></header>
    {error ? <p className="app-management-error" role="alert">{error}</p> : null}<div className="app-management-detail-grid">
      {view.ios ? <section className="app-management-delivery-card ios-card"><div className="delivery-card-heading"><div><span className="platform-chip ios">iOS</span><h2>TestFlight与本地安装</h2></div><span className={`delivery-state ${view.ios.testflight.state === "failed" ? "is-error" : ""}`}>{testflightState(view)}</span></div><p className="delivery-card-id">{view.ios.config.app_store_name} · {view.ios.config.bundle_id}</p><dl className="delivery-card-stats"><div><dt>当前构建</dt><dd>{view.ios.testflight.buildNumber ?? "—"}</dd></div><div><dt>下一构建</dt><dd>{view.ios.testflight.nextBuildNumber}</dd></div></dl><div className="delivery-actions"><button className="primary" type="button" disabled={busy || view.ios.testflight.state === "running"} onClick={onUpload}>{busy ? "处理中…" : "构建并上传TestFlight"}</button><button type="button" disabled={busy} onClick={onInstall}>构建并USB安装</button></div><p className="delivery-card-note">没有USB设备时仍可上传TestFlight；本地安装只会使用当前Mac直接连接、已配对且可用的iPhone/iPad。</p>{view.ios.testflight.message ? <p className={`delivery-message${view.ios.testflight.state === "failed" ? " is-error" : ""}`} role="status">{view.ios.testflight.message}</p> : null}{view.ios.deviceInstall.message ? <p className={`delivery-message${view.ios.deviceInstall.state === "failed" ? " is-error" : ""}`} role="status">{view.ios.deviceInstall.message}</p> : null}</section> : null}
      {view.android ? <section className="app-management-delivery-card android-card"><div className="delivery-card-heading"><div><span className="platform-chip android">Android</span><h2>APK下载</h2></div><span className={`delivery-state ${view.android.error ? "is-error" : ""}`}>{latest ? "可下载" : view.android.error ? "不可用" : "等待APK"}</span></div><p className="delivery-card-id">{view.android.config.package_name}</p>{latest ? <><dl className="delivery-card-stats"><div><dt>版本</dt><dd>{latest.versionName}</dd></div><div><dt>Version code</dt><dd>{latest.versionCode}</dd></div><div><dt>大小</dt><dd>{formatBytes(latest.size)}</dd></div></dl><div className="delivery-actions"><a className="app-management-button primary" href={latest.downloadUrl}>下载最新APK</a><span className="delivery-card-note">下载地址绑定当前登录会话，文件使用不可变SHA-256快照。</span></div></> : <p className="delivery-card-note">{view.android.error ?? "暂未发现符合包名和output-metadata.json的APK。"}</p>}</section> : null}
    </div><section className="app-management-preservation"><strong>现有更新入口保持不变</strong><span>Android Bridge自更新仍在手机环境切换窗口中；iOS OTA仍在系统设置和iPhone页面中。这里新增的是按App管理的发布/下载入口，不会替代或关闭原有能力。</span></section>
  </main>;
}

async function installSelected(view: MobileAppView, load: () => Promise<void>, setError: (value: string) => void, setBusyId: (value: string | null) => void): Promise<void> {
  if (!view.ios?.deviceInstall.usbAvailable) { setError("请先连接USB。"); return; }
  setBusyId(view.app.id); setError("");
  try { await installMobileAppOnIos(view.app.id); await load(); }
  catch (cause) { setError(cause instanceof Error ? cause.message : "iOS本地安装失败。"); }
  finally { setBusyId(null); }
}

function AppFormDialog({ form, editing, busy, error, onChange, onClose, onSubmit }: { form: MobileAppInput; editing: boolean; busy: boolean; error: string; onChange: (form: MobileAppInput) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }): ReactElement {
  const field = (label: string, value: string, onValue: (value: string) => void, required = true): ReactElement => <label>{label}<input required={required} value={value} disabled={busy} onChange={(event) => onValue(event.currentTarget.value)} /></label>;
  const [activePlatform, setActivePlatform] = useState<"ios" | "android">(form.ios ? "ios" : "android");
  const setPlatform = (platform: "ios" | "android", value: NonNullable<MobileAppInput[typeof platform]> | null): void => onChange({ ...form, [platform]: value } as MobileAppInput);
  const addPlatform = (platform: "ios" | "android"): void => {
    setPlatform(platform, platform === "ios" ? { ...emptyIos } : { ...emptyAndroid });
    setActivePlatform(platform);
  };
  const removePlatform = (platform: "ios" | "android"): void => {
    setPlatform(platform, null);
    if (platform === activePlatform && (platform === "ios" ? form.android : form.ios)) setActivePlatform(platform === "ios" ? "android" : "ios");
  };
  const iosPanel = form.ios ? <section className="app-management-platform-panel" aria-labelledby="app-management-ios-panel-title"><div className="app-management-platform-heading"><strong id="app-management-ios-panel-title">iOS配置</strong><button type="button" onClick={() => removePlatform("ios")} disabled={busy}>移除平台</button></div>{field("App Store Connect名称", form.ios.appStoreName, (value) => setPlatform("ios", { ...form.ios!, appStoreName: value }))}{field("Bundle ID", form.ios.bundleId, (value) => setPlatform("ios", { ...form.ios!, bundleId: value }))}{field("Apple Team ID", form.ios.teamId, (value) => setPlatform("ios", { ...form.ios!, teamId: value }))}{field("源码目录", form.ios.sourcePath, (value) => setPlatform("ios", { ...form.ios!, sourcePath: value }))}{field("Xcode工程(.xcodeproj)", form.ios.projectPath, (value) => setPlatform("ios", { ...form.ios!, projectPath: value }))}<div className="app-management-form-two">{field("Scheme", form.ios.scheme, (value) => setPlatform("ios", { ...form.ios!, scheme: value }))}{field("Configuration", form.ios.configuration, (value) => setPlatform("ios", { ...form.ios!, configuration: value }))}</div>{field("Target", form.ios.targetName, (value) => setPlatform("ios", { ...form.ios!, targetName: value }))}<label className="app-management-checkbox"><input type="checkbox" checked={form.ios.internalOnly} disabled={busy} onChange={(event) => setPlatform("ios", { ...form.ios!, internalOnly: event.currentTarget.checked })} />仅上传TestFlight内部测试</label></section> : <PlatformEmpty platform="iOS" onAdd={() => addPlatform("ios")} />;
  const androidPanel = form.android ? <section className="app-management-platform-panel" aria-labelledby="app-management-android-panel-title"><div className="app-management-platform-heading"><strong id="app-management-android-panel-title">Android配置</strong><button type="button" onClick={() => removePlatform("android")} disabled={busy}>移除平台</button></div>{field("Application ID/包名", form.android.packageName, (value) => setPlatform("android", { ...form.android!, packageName: value }))}{field("APK文件路径", form.android.apkPath, (value) => setPlatform("android", { ...form.android!, apkPath: value }))}{field("快照目录（可选）", form.android.snapshotDirectory, (value) => setPlatform("android", { ...form.android!, snapshotDirectory: value }), false)}<p className="app-management-form-note">APK旁边需要有Gradle的output-metadata.json；下载前会校验包名、版本、大小和SHA-256。</p></section> : <PlatformEmpty platform="Android" onAdd={() => addPlatform("android")} />;
  return <div className="dialog-backdrop app-management-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="dialog app-management-dialog" role="dialog" aria-modal="true" aria-labelledby="app-management-form-title"><header><h2 id="app-management-form-title">{editing ? `编辑${form.name || "App"}` : "新增App"}</h2><button type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button></header><form onSubmit={onSubmit}>
    {editing ? null : field("App名称", form.name, (value) => onChange({ ...form, name: value }))}
    <label className="app-management-checkbox"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={(event) => onChange({ ...form, enabled: event.currentTarget.checked })} />启用此App</label>
    <div className="app-management-platform-tabs" role="tablist" aria-label="平台配置"><button type="button" role="tab" aria-label={`iOS，${form.ios ? "已配置" : "未配置"}`} aria-selected={activePlatform === "ios"} aria-controls="app-management-ios-panel" className={activePlatform === "ios" ? "is-active" : ""} onClick={() => setActivePlatform("ios")}><span>iOS</span><span className={`app-management-platform-status-icon${form.ios ? " is-configured" : ""}`} aria-hidden="true">{form.ios ? "✓" : "+"}</span></button><button type="button" role="tab" aria-label={`Android，${form.android ? "已配置" : "未配置"}`} aria-selected={activePlatform === "android"} aria-controls="app-management-android-panel" className={activePlatform === "android" ? "is-active" : ""} onClick={() => setActivePlatform("android")}><span>Android</span><span className={`app-management-platform-status-icon${form.android ? " is-configured" : ""}`} aria-hidden="true">{form.android ? "✓" : "+"}</span></button></div>
    <div id={activePlatform === "ios" ? "app-management-ios-panel" : "app-management-android-panel"} role="tabpanel" className="app-management-platform-content">{activePlatform === "ios" ? iosPanel : androidPanel}</div>
    {error ? <p className="app-management-error" role="alert">{error}</p> : null}<div className="app-management-form-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" type="submit" disabled={busy || (!form.ios && !form.android)}>{busy ? "保存中…" : "保存App"}</button></div>
  </form></section></div>;
}

function PlatformEmpty({ platform, onAdd }: { platform: string; onAdd: () => void }): ReactElement {
  return <div className="app-management-platform-empty"><strong>尚未配置{platform}</strong><span>添加后填写该平台的构建和分发信息。</span><button type="button" onClick={onAdd}>添加{platform}配置</button></div>;
}
