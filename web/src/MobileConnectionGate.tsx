import { useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { parseMobilePairingInput } from "./mobile-connection.js";
import {
  checkMobileApkUpdate, checkMobileConnection, disconnectMobileConnection, downloadMobileApkUpdate, getMobileConnection,
  initializeMobileRuntime, installMobileApkUpdate, MOBILE_CONNECTION_EVENT, MOBILE_RESUME_EVENT, MOBILE_SETTINGS_EVENT,
  MOBILE_SHAKE_EVENT, openMobileConnectionSettings, pairMobileConnection, switchMobileConnection,
  getMobileAppVersion,
  type MobileApkUpdate,
} from "./mobile-runtime.js";
import MobileDownloadStatus from "./MobileDownloadStatus.js";
import MobilePairingScanner from "./MobilePairingScanner.js";
import { getBridgeCapabilities } from "./client-capabilities.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import "./mobile-app.css";

type ConnectionState = "loading" | "setup" | "ready" | "unavailable";
const MOBILE_APK_REVISION_KEY = "bridge.mobile.apk-revision";

export default function MobileConnectionGate({ children }: { children: ReactNode }): ReactElement {
  return <><MobileConnectionContent>{children}</MobileConnectionContent><MobileDownloadStatus /></>;
}

function MobileConnectionContent({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<ConnectionState>("loading");
  const [address, setAddress] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [apkUpdate, setApkUpdate] = useState<MobileApkUpdate | null>(null);
  const [apkUpdateBusy, setApkUpdateBusy] = useState(false);
  const [apkDownloadBusy, setApkDownloadBusy] = useState(false);
  const [apkUpdateError, setApkUpdateError] = useState<string | null>(null);
  const [apkDownloadMessage, setApkDownloadMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);
  const [environmentBusy, setEnvironmentBusy] = useState<string | null>(null);
  const [environmentMessage, setEnvironmentMessage] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("读取中…");

  useEffect(() => { void getMobileAppVersion().then(setAppVersion).catch(() => setAppVersion("暂不可读")); }, []);

  useEffect(() => {
    let active = true;
    const changed = (): void => { setRevision((current) => current + 1); };
    const settings = (event: Event): void => {
      const requestedServer = event instanceof CustomEvent && typeof event.detail?.server === "string" ? event.detail.server : null;
      setAddress(requestedServer ?? getMobileConnection()?.server ?? "");
      setError(null); setPairingInput(""); setEditing(true);
      setEnvironmentDialogOpen(false);
    };
    window.addEventListener(MOBILE_CONNECTION_EVENT, changed);
    window.addEventListener(MOBILE_SETTINGS_EVENT, settings);
    setState("loading");
    void initializeMobileRuntime().then(async () => {
      if (!active) return;
      setAddress(getMobileConnection()?.server ?? "");
      if (!getMobileConnection()?.token) { setState("setup"); return; }
      const authenticated = await checkMobileConnection();
      if (active) setState(authenticated ? "ready" : "setup");
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(connectionError(cause)); setState("unavailable");
    });
    return () => {
      active = false;
      window.removeEventListener(MOBILE_CONNECTION_EVENT, changed);
      window.removeEventListener(MOBILE_SETTINGS_EVENT, settings);
    };
  }, [revision]);

  useEffect(() => {
    const openEnvironmentDialog = (): void => {
      if (document.visibilityState === "hidden" || scannerOpen) return;
      setEnvironmentMessage(null);
      setEnvironmentDialogOpen(true);
    };
    window.addEventListener(MOBILE_SHAKE_EVENT, openEnvironmentDialog);
    return () => window.removeEventListener(MOBILE_SHAKE_EVENT, openEnvironmentDialog);
  }, [scannerOpen]);

  useEffect(() => {
    if (state !== "unavailable" || editing) return;
    const retry = (): void => {
      if (navigator.onLine !== false && document.visibilityState !== "hidden") setRevision((value) => value + 1);
    };
    window.addEventListener("online", retry);
    window.addEventListener(MOBILE_RESUME_EVENT, retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener(MOBILE_RESUME_EVENT, retry);
    };
  }, [state, editing]);

  useEffect(() => {
    if (state !== "ready" || editing) return;
    let active = true;
    const checkForApkUpdate = async (): Promise<void> => {
      try {
        const update = await checkMobileApkUpdate();
        if (!active || !update) return;
        const seenRevision = window.localStorage.getItem(MOBILE_APK_REVISION_KEY);
        if (!seenRevision) {
          window.localStorage.setItem(MOBILE_APK_REVISION_KEY, update.revision);
          return;
        }
        if (seenRevision !== update.revision) {
          setApkUpdate(update);
          setApkUpdateError(null);
        }
      } catch (cause) {
        if (active) setApkUpdateError(cause instanceof Error ? cause.message : "更新检查失败。");
      }
    };
    void checkForApkUpdate();
    const timer = window.setInterval(() => void checkForApkUpdate(), 5 * 60 * 1_000);
    window.addEventListener(MOBILE_RESUME_EVENT, checkForApkUpdate);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(MOBILE_RESUME_EVENT, checkForApkUpdate);
    };
  }, [editing, state]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const parsed = parseMobilePairingInput(pairingInput, "", address);
      await pairMobileConnection(parsed.server, parsed.code);
      window.location.replace("/");
    } catch (cause) { setError(connectionError(cause)); }
    finally { setBusy(false); }
  };

  const scanAndPair = async (value: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const parsed = parseMobilePairingInput(value, "", address);
      setPairingInput(value);
      await pairMobileConnection(parsed.server, parsed.code);
      window.location.replace("/");
    } catch (cause) { throw new Error(connectionError(cause)); }
    finally { setBusy(false); }
  };

  const installApkUpdate = async (): Promise<void> => {
    if (!apkUpdate) return;
    setApkUpdateBusy(true);
    setApkUpdateError(null);
    try {
      await installMobileApkUpdate(apkUpdate);
      window.localStorage.setItem(MOBILE_APK_REVISION_KEY, apkUpdate.revision);
      setApkUpdate(null);
    } catch (cause) {
      setApkUpdateError(cause instanceof Error ? cause.message : "更新安装失败。");
    } finally {
      setApkUpdateBusy(false);
    }
  };

  const downloadApkUpdate = async (): Promise<void> => {
    if (!apkUpdate) return;
    setApkDownloadBusy(true);
    setApkUpdateError(null);
    setApkDownloadMessage(null);
    try {
      await downloadMobileApkUpdate(apkUpdate);
      window.localStorage.setItem(MOBILE_APK_REVISION_KEY, apkUpdate.revision);
    } catch (cause) {
      setApkUpdateError(cause instanceof Error ? cause.message : "APK 下载失败。");
    } finally {
      setApkDownloadBusy(false);
    }
  };

  const downloadLatestApk = async (): Promise<void> => {
    setApkDownloadBusy(true);
    setApkUpdateError(null);
    setApkDownloadMessage(null);
    try {
      const update = await checkMobileApkUpdate();
      if (!update) {
        setApkDownloadMessage("当前 Bridge 没有可下载的 Android APK。");
        return;
      }
      setApkUpdate(update);
      await downloadMobileApkUpdate(update);
      window.localStorage.setItem(MOBILE_APK_REVISION_KEY, update.revision);
    } catch (cause) {
      setApkUpdateError(cause instanceof Error ? cause.message : "APK 下载失败。");
    } finally {
      setApkDownloadBusy(false);
    }
  };

  const dismissApkUpdate = (): void => {
    if (!apkUpdate) return;
    window.localStorage.setItem(MOBILE_APK_REVISION_KEY, apkUpdate.revision);
    setApkUpdate(null);
    setApkUpdateError(null);
  };

  const environmentOptions = buildEnvironmentOptions(getMobileConnection()?.server ?? address);
  const selectEnvironment = async (option: EnvironmentOption): Promise<void> => {
    if (option.server === getMobileConnection()?.server) {
      setEnvironmentDialogOpen(false);
      return;
    }
    setEnvironmentBusy(option.id);
    setEnvironmentMessage(null);
    try {
      if (await switchMobileConnection(option.server)) {
        setEnvironmentDialogOpen(false);
        window.location.replace("/");
        return;
      }
      setEnvironmentDialogOpen(false);
      openMobileConnectionSettings(option.server);
    } catch (cause) {
      setEnvironmentMessage(connectionError(cause));
    } finally {
      setEnvironmentBusy(null);
    }
  };

  const environmentDialog = environmentDialogOpen ? (
    <MobileEnvironmentDialog
      options={environmentOptions}
      busy={environmentBusy}
      message={environmentMessage}
      currentServer={getMobileConnection()?.server ?? ""}
      appVersion={appVersion}
      onSelect={(option) => { void selectEnvironment(option); }}
      onOpenConnectionSettings={() => openMobileConnectionSettings()}
      onClose={() => setEnvironmentDialogOpen(false)}
    />
  ) : null;

  if (scannerOpen) return <MobilePairingScanner onPair={scanAndPair} onClose={() => setScannerOpen(false)} />;

  if (state === "ready" && !editing) return <>
    {apkUpdate ? (
      <aside className="mobile-update-banner" role="status">
        <div>
          <strong>发现新的 Bridge App</strong>
          <span>{formatApkSize(apkUpdate.size)} · {new Date(apkUpdate.modifiedAt).toLocaleString()}</span>
        </div>
        <div className="mobile-update-actions">
          <button type="button" onClick={() => void installApkUpdate()} disabled={apkUpdateBusy || apkDownloadBusy}>{apkUpdateBusy ? "下载中…" : "更新"}</button>
          <button type="button" className="mobile-update-download" onClick={() => void downloadApkUpdate()} disabled={apkUpdateBusy || apkDownloadBusy}>{apkDownloadBusy ? "准备中…" : "下载 APK"}</button>
          <button type="button" className="mobile-update-dismiss" onClick={dismissApkUpdate} disabled={apkUpdateBusy || apkDownloadBusy}>稍后</button>
        </div>
        {apkUpdateError ? <p role="alert">{apkUpdateError}</p> : null}
      </aside>
    ) : null}
    {children}
    {environmentDialog}
  </>;

  return <main className="mobile-connect-page">
    <section className="mobile-connect-card" aria-labelledby="mobile-connect-title">
      <header className="mobile-connect-header">
        <div className="mobile-connect-brand-row">
          <div className="mobile-connect-mark" aria-hidden="true">B</div>
          <div className="mobile-connect-brand-copy">
            <strong>Bridge App</strong>
            <span className={`mobile-connect-status is-${state}`}>
              <i aria-hidden="true" />
              {state === "loading" ? "检查连接" : state === "unavailable" ? "连接不可用" : getMobileConnection()?.token ? "已配对" : "未配对"}
            </span>
          </div>
        </div>
        <h1 id="mobile-connect-title">连接你的 Bridge</h1>
        <p className="mobile-connect-description">把 Mac 上的会话、任务和文件带到手机。</p>
      </header>
      {getMobileConnection()?.token ? <CompatibilityNotice /> : null}
      {state === "loading" && !editing ? <p role="status">正在恢复连接…</p> : <>
        {state === "unavailable" && !editing ? <>
          <div className="mobile-connect-unavailable">
            <span className="mobile-connect-unavailable-label">当前地址</span>
            <p className="mobile-connect-server">{address || "尚未设置服务地址"}</p>
          </div>
          {error && <p className="mobile-connect-error" role="alert">{error}</p>}
          <div className="mobile-connect-actions">
            <button type="button" className="mobile-connect-primary" onClick={() => setRevision((value) => value + 1)}>重试连接</button>
            <button type="button" className="mobile-connect-secondary" onClick={() => { setEditing(true); setError(null); }}>更换连接</button>
          </div>
        </> : <form onSubmit={(event) => { void submit(event); }}>
          <section className="mobile-connect-method" aria-labelledby="mobile-connect-method-title">
            <div className="mobile-connect-section-heading">
              <div>
                <span id="mobile-connect-method-title">快速连接</span>
                <small>推荐</small>
              </div>
              <span>约 10 秒完成</span>
            </div>
            <button className="mobile-connect-scan" type="button" disabled={busy}
              onClick={() => { setError(null); setScannerOpen(true); }}>
              <span className="mobile-connect-scan-icon" aria-hidden="true">▦</span>
              <span className="mobile-connect-scan-copy">
                <strong>扫描配对二维码</strong>
                <small>相机扫描，或选择本地二维码图片</small>
              </span>
              <span className="mobile-connect-scan-arrow" aria-hidden="true">›</span>
            </button>
          </section>

          <div className="mobile-connect-divider" role="separator"><span>或手动输入</span></div>

          <section className="mobile-connect-manual" aria-label="手动输入连接信息">
            <label htmlFor="mobile-pairing-input"><span>配对链接或配对码</span></label>
            <input id="mobile-pairing-input" value={pairingInput} onChange={(event) => setPairingInput(event.target.value)}
              placeholder="粘贴完整配对链接" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              autoComplete="off" required disabled={busy} aria-describedby="mobile-pair-help" />
            <p id="mobile-pair-help" className="mobile-connect-help">完整链接已包含地址和配对码，无需重复填写。</p>
            <details className="mobile-connect-code-only">
              <summary>仅有配对码</summary>
              <label htmlFor="mobile-server">Bridge 地址</label>
              <input id="mobile-server" value={address} onChange={(event) => setAddress(event.target.value)}
                placeholder="http://192.168.1.10:17310" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                inputMode="url" autoComplete="url" disabled={busy} />
              <p className="mobile-connect-help">单独输入配对码时，使用此地址连接。</p>
            </details>
          </section>
          {error && <p className="mobile-connect-error" role="alert">{error}</p>}
          <div className="mobile-connect-actions">
            <button type="submit" className="mobile-connect-primary" disabled={busy || !pairingInput.trim()}>{busy ? "正在配对…" : "连接并配对"}<span aria-hidden="true">→</span></button>
          </div>
          {editing && getMobileConnection()?.token && <div className="mobile-connect-existing-actions">
            <button type="button" className="mobile-connect-secondary" disabled={busy}
              onClick={() => { setEditing(false); setError(null); }}>返回当前连接</button>
            <button type="button" className="mobile-connect-danger" disabled={busy}
              onClick={() => {
                setBusy(true);
                void disconnectMobileConnection().catch(() => {}).finally(() => { setBusy(false); setEditing(false); });
              }}>断开并清除本机配对</button>
          </div>}
        </form>}
        {getMobileConnection()?.token ? <details className="mobile-connect-update">
          <summary>App 更新</summary>
          <div className="mobile-connect-update-heading">
            <span className="mobile-connect-update-icon" aria-hidden="true">↓</span>
            <div>
              <strong>手动更新 App</strong>
              <p>从当前已配对的 Bridge 下载最新 APK，保存后再手动安装。</p>
            </div>
          </div>
          <button type="button" className="mobile-connect-update-button" onClick={() => void downloadLatestApk()} disabled={busy || apkDownloadBusy || apkUpdateBusy}>
            {apkDownloadBusy ? "正在准备下载…" : "手动下载 APK"}
          </button>
          {apkDownloadMessage ? <p className="mobile-connect-update-message" role="status">{apkDownloadMessage}</p> : null}
          {apkUpdateError ? <p className="mobile-connect-error" role="alert">{apkUpdateError}</p> : null}
        </details> : null}
      </>}
    </section>
    {environmentDialog}
  </main>;
}

interface EnvironmentOption {
  id: "development" | "stable";
  label: string;
  description: string;
  port: number;
  server: string;
}

function buildEnvironmentOptions(server: string): EnvironmentOption[] {
  if (!server) return [];
  try {
    const base = new URL(server);
    const targets: Array<Omit<EnvironmentOption, "server">> = [
      { id: "development", label: "开发环境", description: "连接开发 API，页面仍为内置版本", port: 5173 },
      { id: "stable", label: "稳定环境", description: "连接稳定 API，页面仍为内置版本", port: 7310 },
    ];
    return targets.map((option) => {
      const target = new URL(base.origin);
      target.port = String(option.port);
      return { ...option, server: target.origin };
    });
  } catch {
    return [];
  }
}

function MobileEnvironmentDialog({
  options, busy, message, currentServer, appVersion, onSelect, onOpenConnectionSettings, onClose,
}: {
  options: EnvironmentOption[];
  busy: string | null;
  message: string | null;
  currentServer: string;
  appVersion: string;
  onSelect: (option: EnvironmentOption) => void;
  onOpenConnectionSettings: () => void;
  onClose: () => void;
}): ReactElement {
  return <div className="mobile-environment-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="mobile-environment-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-environment-title">
      <header className="mobile-environment-header">
        <div className="mobile-environment-icon" aria-hidden="true">⚙</div>
        <div>
          <span>系统管理</span>
          <h2 id="mobile-environment-title">切换 Bridge 环境</h2>
        </div>
        <button type="button" className="mobile-environment-close" aria-label="关闭" onClick={onClose}>×</button>
      </header>
      <p className="mobile-environment-description">切换只更换后端 API，不会加载该环境的网页。当前配对和各环境草稿会保留；未配对的环境需先配对。</p>
      <dl className="mobile-environment-versions">
        <dt>App 安装版本</dt><dd>{appVersion}</dd>
        <dt>内置页面</dt><dd>{import.meta.env.VITE_BRIDGE_FRONTEND_VERSION ?? "开发预览"} · {import.meta.env.VITE_BRIDGE_FRONTEND_BUILD ?? "未打包"}</dd>
        <dt>后端版本</dt><dd>{getBridgeCapabilities()?.version ?? "旧版后端，未提供版本信息"}</dd>
        <dt>当前地址</dt><dd>{currentServer || "未连接"}</dd>
      </dl>
      <CompatibilityNotice />
      {options.length ? <div className="mobile-environment-options">
        {options.map((option) => {
          const active = option.server === currentServer;
          return <button
            key={option.id}
            type="button"
            className={`mobile-environment-option${active ? " is-active" : ""}`}
            disabled={Boolean(busy)}
            onClick={() => onSelect(option)}
          >
            <span className="mobile-environment-option-mark" aria-hidden="true">{active ? "✓" : "↗"}</span>
            <span className="mobile-environment-option-copy">
              <strong>{option.label}</strong>
              <small>{option.description} · :{option.port}</small>
            </span>
            <span className="mobile-environment-option-action">{busy === option.id ? "切换中…" : active ? "当前" : "切换"}</span>
          </button>;
        })}
      </div> : <p className="mobile-environment-empty">当前还没有 Bridge 地址，请先完成配对。</p>}
      {message ? <p className="mobile-connect-error" role="alert">{message}</p> : null}
      <div className="mobile-environment-actions">
        <button type="button" className="mobile-connect-secondary" onClick={onClose}>取消</button>
        <button type="button" className="mobile-connect-primary" onClick={onOpenConnectionSettings}>打开连接管理<span aria-hidden="true">→</span></button>
      </div>
    </section>
  </div>;
}

function CompatibilityNotice(): ReactElement | null {
  if (getBridgeCapabilities() && getLocalDraftScope()) return null;
  return <aside className="mobile-compatibility-notice" role="status">
    {!getBridgeCapabilities() ? "当前后端未提供兼容能力信息，部分功能可能不可用。" : null}
    {!getLocalDraftScope() ? "该后端未提供设备隔离标识，草稿无法跨重启保存，请先升级后端。" : null}
    切换环境仅更换 API，内置页面不会更新。
  </aside>;
}

function connectionError(cause: unknown): string {
  if (cause instanceof TypeError || (cause instanceof DOMException && cause.name === "TimeoutError")) {
    return "连接失败。请确认手机能访问该地址，且 Mac 上的 Bridge 正在运行。";
  }
  return cause instanceof Error ? cause.message : "连接失败，请稍后重试。";
}

function formatApkSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
