import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import {
  appOnlyVpnPocAvailable, clearAppOnlyVpnProfile, connectAppOnlyVpn, disconnectAppOnlyVpn,
  getAppOnlyVpnPocStatus, getMobileConnection, importAppOnlyVpnProfile, openAppOnlyTmuxWebView,
  pickAppOnlyVpnProfile, probeAppOnlyVpnHttp, copyMobileText,
} from "./mobile-runtime.js";
import { CrashDiagnosticsPanel } from "./CrashDiagnosticsPanel.js";
import "./mobile-app-only-vpn-poc.css";

type AppOnlyVpnDiagnosticEvent = {
  at?: string;
  stage?: string;
  message?: string;
  processID?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function displayValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export default function MobileAppOnlyVpnPocPage(): ReactElement {
  const navigate = useNavigate();
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [address, setAddress] = useState("10.15.53.70");
  const [port, setPort] = useState("17310");
  const [path, setPath] = useState("/healthz");
  const [webAddress, setWebAddress] = useState("10.15.53.70");
  const [webPort, setWebPort] = useState("5173");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const statusRequest = useRef(0);

  const refresh = async (): Promise<void> => {
    if (!available) return;
    const request = ++statusRequest.current;
    try {
      const next = await getAppOnlyVpnPocStatus();
      if (request === statusRequest.current) setStatus(next);
    } catch (cause) {
      if (request === statusRequest.current) setError(cause instanceof Error ? cause.message : "读取实验状态失败。");
    }
  };

  useEffect(() => {
    let active = true;
    void appOnlyVpnPocAvailable().then((value) => { if (active) setAvailable(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => { if (available) void refresh(); }, [available]);
  useEffect(() => {
    if (!available || busy !== "connect") return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [available, busy]);

  const vpnState = typeof status?.state === "string" ? status.state : "unknown";
  const probeReady = vpnState === "connected";
  const diagnostics = asRecord(status?.diagnostics);
  const previousProcessAbnormal = diagnostics?.previousProcessAbnormal === true;
  const snapshotAvailable = diagnostics?.snapshotAvailable === true;
  const allDiagnosticEvents = Array.isArray(diagnostics?.events)
    ? diagnostics.events.map(asRecord).filter((event): event is AppOnlyVpnDiagnosticEvent => event !== null)
    : [];
  const diagnosticEvents = allDiagnosticEvents.slice(-12);

  const run = async (name: string, action: () => Promise<void>): Promise<void> => {
    setBusy(name); setMessage(null); setError(null); setResponse(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "App-only VPN 实验操作失败。"); }
    finally { await refresh(); setBusy(null); }
  };

  const importProfile = (): Promise<void> => run("import", async () => {
    const selection = await pickAppOnlyVpnProfile();
    const result = await importAppOnlyVpnProfile(selection.selectionId);
    setMessage(`已导入 ${String(result.title ?? selection.fileName ?? ".ovpn")}；凭据由原生 Keychain 管理。`);
  });

  const connect = (): Promise<void> => run("connect", async () => {
    await connectAppOnlyVpn();
    setMessage("OpenVPN 和 lwIP 已连接，可以执行 HTTP probe。 ");
  });

  const disconnect = (): Promise<void> => run("disconnect", async () => {
    await disconnectAppOnlyVpn();
    setMessage("App-only OpenVPN 已停止。 ");
  });

  const probe = (): Promise<void> => run("probe", async () => {
    const latest = await getAppOnlyVpnPocStatus();
    setStatus(latest);
    if (latest.state !== "connected") {
      throw new Error("App-only VPN 尚未 connected，请先点击“连接 App-only VPN”，等待状态变为 connected 后再探测。 ");
    }
    const result = await probeAppOnlyVpnHttp({ address, port: Number(port), path });
    setResponse(result.bodyUtf8 ?? "");
    setMessage(`收到 ${result.bytes ?? 0} 字节；该请求由 App 内 lwIP/TunnelKit POC 发出。`);
  });

  const clear = (): Promise<void> => run("clear", async () => {
    await clearAppOnlyVpnProfile();
    setMessage("实验配置和 App-only Keychain 凭据已清除。 ");
  });

  const openTmuxWebView = (): Promise<void> => run("webview", async () => {
    const latest = await getAppOnlyVpnPocStatus();
    setStatus(latest);
    if (latest.state !== "connected") throw new Error("请先连接并等待 App-only VPN 状态变为 connected。");
    const selected = getMobileConnection();
    if (!selected?.token) throw new Error("当前 App 没有已配对的 Bridge token，请先完成配对。");
    const portNumber = Number(webPort);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error("请输入有效的 Web 端口。");
    const result = await openAppOnlyTmuxWebView({
      address: webAddress,
      port: portNumber,
      path: "/tmux-dashboard?session=%2424",
      credentialServer: selected.server,
    });
    if (result.opened !== true) throw new Error("实验 WebView 未打开。");
    setMessage(`已在 App 内打开 ${result.target ?? `http://${webAddress}:${portNumber}/tmux-dashboard`}；关闭实验页面后会停止本地代理。`);
  });

  return <main className="app-only-vpn-poc-page">
    <header className="app-only-vpn-poc-header">
      <button type="button" onClick={() => navigate(-1)}>返回</button>
      <div>
        <h1>App-only VPN 实验</h1>
        <p>仅当前 Bridge App 流量；不创建系统 VPN、不使用 Network Extension。</p>
      </div>
    </header>

    {!available ? <section className="app-only-vpn-poc-card" role="status">
      <strong>当前构建未启用实验插件</strong>
      <p>请安装个人团队的 App 实验构建；浏览器和普通非实验构建不会显示真实能力。</p>
    </section> : <>
      <section className="app-only-vpn-poc-card">
        <div className="app-only-vpn-poc-actions">
          <button type="button" disabled={busy !== null} onClick={() => { void importProfile(); }}>
            {busy === "import" ? "正在导入…" : "选择并导入 .ovpn"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => { void connect(); }}>
            {busy === "connect" ? "正在连接…" : "连接 App-only VPN"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => { void disconnect(); }}>
            {busy === "disconnect" ? "正在停止…" : "断开"}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => { void clear(); }}>
            清除实验配置
          </button>
        </div>
        <small>导入时如配置包含 auth-user-pass，会在原生弹窗中输入；密码不会进入 WebView。</small>
        {message ? <p className="app-only-vpn-poc-message" role="status">{message}</p> : null}
        {error ? <p className="app-only-vpn-poc-error" role="alert">{error}</p> : null}
        <section className="app-only-vpn-poc-process" aria-label="连接过程">
          <h2>连接过程</h2>
          <p role="status">当前状态：{vpnState}；{displayValue(diagnostics?.lastMessage, "等待连接")}</p>
          <button type="button" className="secondary" disabled={allDiagnosticEvents.length === 0} onClick={() => {
            const text = allDiagnosticEvents.map((event) => `${event.at ?? "-"}  ${event.stage ?? "unknown"}  ${event.message ?? ""}`).join("\n");
            void copyMobileText(text).then(() => setCopyMessage("连接过程已复制。"))
              .catch(() => setCopyMessage("复制失败，请重试。"));
          }}>复制连接过程</button>
          {copyMessage ? <span role="status">{copyMessage}</span> : null}
          {allDiagnosticEvents.length ? <ol className="app-only-vpn-poc-diagnostic-events">
            {allDiagnosticEvents.map((event, index) => <li key={`${event.at ?? "event"}-${index}`}>
              <time>{event.at ?? "-"}</time><code>{displayValue(event.stage, "unknown")}</code>
              <span>{displayValue(event.message, "-")}</span>
            </li>)}
          </ol> : <p>还没有连接记录。</p>}
        </section>
      </section>

      <section className="app-only-vpn-poc-card">
        <h2>WebView tmux 页面实验</h2>
        <p>这只创建一个临时的原生 WKWebView：目标页面仍是开发机的 tmux-dashboard，Bearer token 由原生从 App Keychain 注入；不会改写当前 App 的默认网络链路。</p>
        <label>Web 地址<input value={webAddress} onChange={(event) => setWebAddress(event.target.value)} inputMode="decimal" /></label>
        <label>Web 端口<input value={webPort} onChange={(event) => setWebPort(event.target.value)} inputMode="numeric" /></label>
        <button type="button" disabled={busy !== null || !probeReady} onClick={() => { void openTmuxWebView(); }}>
          {busy === "webview" ? "正在打开 WebView…" : "在 App 内打开 tmux 页面"}
        </button>
        <small>验证地址：<code>http://{webAddress}:{webPort}/tmux-dashboard?session=%2424</code>。当前构建只作为 POC；如果体验不如现有页面，可整体移除这条入口和原生代理。</small>
      </section>

      <section className="app-only-vpn-poc-card">
        <h2>公司 Mac HTTP Probe</h2>
        <label>IPv4 地址<input value={address} onChange={(event) => setAddress(event.target.value)} inputMode="decimal" /></label>
        <label>端口<input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" /></label>
        <label>路径<input value={path} onChange={(event) => setPath(event.target.value)} autoCapitalize="none" /></label>
        <button type="button" disabled={busy !== null || !probeReady} onClick={() => { void probe(); }}>
          {busy === "probe" ? "正在探测…" : "通过 App-only Tunnel 发 HTTP"}
        </button>
        <small>{probeReady ? "默认目标是当前开发 Bridge 的 /healthz；宿主电脑直连成功不代表手机 Tunnel 成功。" : `请先连接并等待 Tunnel 状态为 connected（当前：${vpnState}）。`}</small>
      </section>

      <section className="app-only-vpn-poc-card">
        <h2>状态</h2>
        <pre>{JSON.stringify(status, null, 2)}</pre>
        {response !== null ? <><h2>HTTP 响应</h2><pre>{response}</pre></> : null}
      </section>
      <section className="app-only-vpn-poc-card app-only-vpn-poc-diagnostics">
        <h2>崩溃诊断</h2>
        {diagnostics ? <>
          <p className={previousProcessAbnormal ? "app-only-vpn-poc-crash" : snapshotAvailable ? "app-only-vpn-poc-diagnostic-ok" : "app-only-vpn-poc-diagnostic-missing"} role={previousProcessAbnormal ? "alert" : undefined}>
            {previousProcessAbnormal
              ? `上次 App 进程没有正常结束。最后阶段：${displayValue(diagnostics.lastStage, "unknown")}；${displayValue(diagnostics.lastMessage, "没有错误描述")}`
              : snapshotAvailable
                ? `当前没有检测到上次异常退出。最后阶段：${displayValue(diagnostics.lastStage, "尚未开始")}`
                : "没有读取到持久化诊断记录；请确认当前 App 已更新到包含诊断功能的版本，然后再复现一次。"}
          </p>
          <dl className="app-only-vpn-poc-diagnostic-meta">
            <dt>当前 App</dt><dd>{displayValue(status?.appVersion, "-")} · build {displayValue(status?.appBuild, "-")}</dd>
            <dt>记录时间</dt><dd>{displayValue(diagnostics.updatedAt, "-")}</dd>
            <dt>进程变化</dt><dd>{previousProcessAbnormal ? `${String(diagnostics.processID ?? "-")} → ${String(diagnostics.currentProcessID ?? "-")}` : "同一进程"}</dd>
          </dl>
          <details open={previousProcessAbnormal}>
            <summary>最近生命周期记录（最多显示 12 条）</summary>
            {diagnosticEvents.length > 0 ? <ol className="app-only-vpn-poc-diagnostic-events">
              {diagnosticEvents.map((event, index) => <li key={`${event.at ?? "event"}-${index}`}>
                <code>{displayValue(event.stage, "unknown")}</code>
                <span>{displayValue(event.message, "-")}</span>
                {event.at ? <time>{event.at}</time> : null}
              </li>)}
            </ol> : <p>还没有连接生命周期记录。</p>}
          </details>
          <small>这些记录只保存阶段、时间和脱敏错误，不保存 VPN 配置、用户名、密码或服务器地址。崩溃堆栈可在下方“本机崩溃报告”中查看，系统诊断交付可能延迟。</small>
        </> : <p>原生诊断信息尚未返回；请重新打开页面或点击刷新状态。</p>}
      </section>
      <CrashDiagnosticsPanel />
    </>}
  </main>;
}
