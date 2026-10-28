import { useEffect, useRef, useState, type ReactElement } from "react";
import { describeDevice, deviceAccessEnvironment, deviceAuthorizationState, deviceExpiry, deviceLastUsed, matchesDeviceSearch, sameModelCounts, selectableDeviceIds, sortDeviceAuthorizations, type DeviceAuthorization } from "./device-authorizations.js";

function date(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
}

export function DeviceAuthorizations({ devices, loading, busy, onRefresh, onRename, onExtend, onRevoke }: {
  devices: DeviceAuthorization[];
  loading: boolean;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onRename: (device: DeviceAuthorization) => void;
  onExtend: (device: DeviceAuthorization) => Promise<void>;
  onRevoke: (devices: DeviceAuthorization[]) => Promise<void>;
}): ReactElement {
  const [tab, setTab] = useState<"active" | "history">("active");
  const [filter, setFilter] = useState<"all" | "same-model" | "unused" | "expiring">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pendingRevoke, setPendingRevoke] = useState<DeviceAuthorization[] | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const now = Date.now();
  const counts = sameModelCounts(devices, now);
  const active = devices.filter((device) => deviceAuthorizationState(device, now) === "active");
  const history = devices.filter((device) => deviceAuthorizationState(device, now) !== "active");
  const visible = sortDeviceAuthorizations(tab === "active" ? active : history).filter((device) => {
    if (!matchesDeviceSearch(device, query)) return false;
    if (tab === "history" || filter === "all") return true;
    if (filter === "unused") return !device.current && now - Date.parse(device.lastSeenAt) >= 7 * 86_400_000;
    if (filter === "expiring") return Date.parse(device.expiresAt) - now <= 7 * 86_400_000;
    return (counts.get(describeDevice(device).modelKey ?? "") ?? 0) > 1;
  });
  const selectable = selectableDeviceIds(visible, now);
  const selectedDevices = visible.filter((device) => selectable.includes(device.sessionId) && selected.has(device.sessionId));
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));

  useEffect(() => {
    const allowed = new Set(selectableDeviceIds(devices));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => allowed.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [devices]);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedDevices.length > 0 && !allSelected;
  }, [allSelected, selectedDevices.length]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!pendingRevoke || !dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [pendingRevoke]);

  return <section className="device-auth-panel" aria-label="设备授权管理">
    <header className="device-auth-heading">
      <div><h2>设备授权</h2><span>{active.length} 份有效授权</span></div>
      <button className="secondary" type="button" disabled={loading || busy} onClick={() => void onRefresh()}>刷新</button>
    </header>
    <div className="device-auth-toolbar">
      <div className="device-auth-tabs" role="group" aria-label="授权记录范围">
        <button type="button" aria-pressed={tab === "active"} onClick={() => { setTab("active"); setSelected(new Set()); }}>有效 · {active.length}</button>
        <button type="button" aria-pressed={tab === "history"} onClick={() => { setTab("history"); setSelected(new Set()); }}>历史 · {history.length}</button>
      </div>
      <input className="device-auth-search" aria-label="搜索设备授权" placeholder="搜索名称、型号、浏览器或 IP" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(new Set()); }} />
      {tab === "active" ? <select aria-label="筛选有效授权" value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setSelected(new Set()); }}>
        <option value="all">全部有效授权</option><option value="same-model">同型号多份授权</option><option value="unused">7 天未使用</option><option value="expiring">7 天内到期</option>
      </select> : null}
    </div>
    <p className="device-auth-explanation">每条记录代表一个浏览器或 App 的访问授权；同一台设备可有多条记录。</p>
    {tab === "active" && selectable.length > 0 ? <div className="device-auth-bulk">
      <label><input ref={selectAllRef} type="checkbox" aria-label="全选可见授权，不含当前设备" disabled={busy || loading} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable))} />选择可见授权</label>
      <span>当前授权不参与全选</span>
      <button className="secondary" type="button" disabled={busy || loading || selectedDevices.length === 0} onClick={() => setPendingRevoke(selectedDevices)}>撤销所选{selectedDevices.length ? `（${selectedDevices.length}）` : ""}</button>
    </div> : null}
    {loading && devices.length === 0 ? <p className="device-auth-empty">正在读取授权记录…</p> : null}
    {!loading && visible.length === 0 ? <p className="device-auth-empty">{query || filter !== "all" && tab === "active" ? "没有符合条件的授权记录。" : tab === "history" ? "暂无已过期或已撤销的记录。" : "暂无有效授权，请生成二维码添加设备。"}</p> : null}
    <div className="device-auth-list" aria-busy={loading}>
      {visible.map((device) => {
        const profile = describeDevice(device);
        const state = deviceAuthorizationState(device, now);
        const environment = deviceAccessEnvironment(device);
        const sameModel = counts.get(profile.modelKey ?? "") ?? 0;
        const soon = state === "active" && Date.parse(device.expiresAt) - now <= 7 * 86_400_000;
        return <article className={`device-auth-entry${device.current ? " is-current" : ""}`} key={device.sessionId}>
          <div className="device-auth-entry-main">
            <div className="device-auth-title">
              {tab === "active" ? <label className="device-auth-select"><input type="checkbox" aria-label={`选择 ${profile.name} 授权 ${profile.shortId}`} disabled={busy || device.current} checked={selected.has(device.sessionId)} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(device.sessionId)) next.delete(device.sessionId); else next.add(device.sessionId); return next; })} /></label> : null}
              <strong>{profile.name}</strong>
              {device.current ? <span className="device-current-badge">当前授权</span> : null}
              <span className={`device-auth-state is-${state}`}>{state === "active" ? "有效" : state === "revoked" ? "已撤销" : "已过期"}</span>
              <span className="device-auth-id" title="授权编号">#{profile.shortId}</span>
            </div>
            <p className="device-auth-environment"><b>{profile.browser}</b><span>{[profile.system, profile.app ? null : profile.model].filter(Boolean).join(" · ")}</span></p>
            <p className="device-auth-activity"><span>{deviceLastUsed(device.lastSeenAt, now)}</span><span className={soon ? "is-soon" : ""}>{state === "active" ? deviceExpiry(device.expiresAt, now) : state === "revoked" ? `撤销于 ${date(device.revokedAt)}` : `到期于 ${date(device.expiresAt)}`}</span><span className="device-auth-port" title={environment?.origin}>{environment ? `最近访问 :${environment.port}` : "访问入口未记录"}</span>{device.remoteAddress ? <span>IP {device.remoteAddress}</span> : null}</p>
            {state === "active" && sameModel > 1 ? <button className="device-auth-model-hint" type="button" onClick={() => { setQuery(profile.model ?? ""); setFilter("same-model"); setSelected(new Set()); }}>同型号 {sameModel} 份授权 · 查看</button> : null}
            <details className="device-auth-details"><summary>授权详情</summary><dl>
              <dt>授权编号</dt><dd>{device.sessionId}</dd><dt>首次配对</dt><dd>{date(device.createdAt)}</dd><dt>最近访问</dt><dd>{date(device.lastSeenAt)}</dd><dt>授权到期</dt><dd>{date(device.expiresAt)}</dd>
              {device.revokedAt ? <><dt>撤销时间</dt><dd>{date(device.revokedAt)}</dd></> : null}
              <dt>最近访问入口</dt><dd>{environment?.origin ?? "尚未记录"}</dd>
              {environment ? <><dt>入口记录时间</dt><dd>{date(device.lastAccessOriginAt)}</dd></> : null}
              <dt>原始 UA</dt><dd><code>{device.userAgent || "未提供"}</code></dd>
            </dl><p>型号、浏览器和 IP 仅用于辨认，相同信息不代表同一台实体设备。访问入口记录最近一次已授权请求，后台刷新也会更新。</p></details>
          </div>
          {state === "active" ? <div className="device-auth-entry-actions">
            <button className="secondary" type="button" disabled={busy} onClick={() => onRename(device)}>名称 / 备注</button>
            <button className="secondary" type="button" disabled={busy} onClick={() => void onExtend(device)}>延期一年</button>
            <button className="device-revoke-button" type="button" disabled={busy} onClick={() => setPendingRevoke([device])}>撤销</button>
          </div> : null}
        </article>;
      })}
    </div>
    {pendingRevoke ? <dialog ref={dialogRef} className="device-auth-revoke-dialog" aria-labelledby="device-auth-revoke-title" onCancel={(event) => { event.preventDefault(); if (!busy) setPendingRevoke(null); }}>
      <h2 id="device-auth-revoke-title">撤销 {pendingRevoke.length} 份授权？</h2>
      <p>以下登录将失去访问权限，之后需要重新配对。</p>
      <ul>{pendingRevoke.map((device) => { const profile = describeDevice(device); return <li key={device.sessionId}><strong>{profile.name}{device.current ? "（当前授权）" : ""}</strong><span>{profile.browser} · #{profile.shortId}</span><small>{deviceLastUsed(device.lastSeenAt)}</small></li>; })}</ul>
      {pendingRevoke.some((device) => device.current) ? <p className="device-auth-current-warning">这会退出当前设备。</p> : null}
      <div className="device-modal-actions"><button className="secondary" type="button" autoFocus disabled={busy} onClick={() => setPendingRevoke(null)}>取消</button><button className="device-revoke-button" type="button" disabled={busy} onClick={() => { void onRevoke(pendingRevoke).finally(() => setPendingRevoke(null)); }}>{busy ? "正在撤销…" : "确认撤销"}</button></div>
    </dialog> : null}
  </section>;
}
