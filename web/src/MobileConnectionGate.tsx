import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { normalizeConfiguredBridgeServer, parseMobilePairingInput } from "./mobile-connection.js";
import { bridgeOriginForPort } from "./bridge-global-config.js";
import { createMobileVpnRetry } from "./mobile-vpn-retry.js";
import {
  checkMobileApkUpdate, checkMobileConnection, disconnectMobileConnection, downloadMobileApkUpdate, getMobileConnection,
  initializeMobileRuntime, installMobileApkUpdate, MOBILE_CONNECTION_EVENT, MOBILE_RESUME_EVENT, MOBILE_SETTINGS_EVENT,
  MOBILE_SHAKE_EVENT, openMobileConnectionSettings, pairMobileConnection, switchMobileConnection,
  getMobileAppVersion, getMobileAppBuild, supportsMobileApkUpdates,
  type MobileApkUpdate,
} from "./mobile-runtime.js";
import MobileDownloadStatus from "./MobileDownloadStatus.js";
import MobilePairingScanner from "./MobilePairingScanner.js";
import { bridgeFeatureUnavailable, getBridgeCapabilities } from "./client-capabilities.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import { apkUpdateStorageKey, decideApkUpdate, readApkUpdateState, type ApkUpdateState, type ApkUpdatePhase } from "./mobile-apk-update.js";
import "./mobile-app.css";
import { useMobileBack } from "./use-mobile-back.js";
import { useLocation, useNavigate } from "react-router";
import { isStandaloneSshPath } from "./ssh-route.js";
import MobileSshLogin from "./MobileSshLogin.js";
import {
  closeNativeSshWorkspace, onNativeAppUpdateAction, onNativeSshReturnToWorkbench,
  setNativeAppUpdateBanner, setNativeSshWorkspaceVisible, type AppUpdateAction,
} from "./ssh-connectbot-native.js";
import { isAppActive } from "./foreground-polling.js";
import { createMobileWorkspaceOverlay } from "./mobile-workspace-overlay.js";
import { MobileHandoffShell, MobileNavigationBridge } from "./MobileHandoff.js";

type ConnectionState = "loading" | "setup" | "ready" | "unavailable";

export default function MobileConnectionGate({ children }: { children: ReactNode }): ReactElement {
  return <MobileHandoffShell><MobileConnectionContent>{children}</MobileConnectionContent><MobileDownloadStatus /></MobileHandoffShell>;
}
export function MobileConnectionContent({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<ConnectionState>("loading");
  const [mode, setMode] = useState<"bridge" | "ssh">(() => {
    if (isStandaloneSshPath(location.pathname)) return "ssh";
    try { return window.localStorage.getItem("bridge.connection.mode") === "ssh" ? "ssh" : "bridge"; }
    catch { return "bridge"; }
  });
  const selectMode = (next: "bridge" | "ssh"): void => {
    setMode(next);
    try { window.localStorage.setItem("bridge.connection.mode", next); } catch { /* preference only */ }
    if (next === "bridge" && isStandaloneSshPath(location.pathname)) navigate("/", { replace: true });
    setEditing(true);
  };
  const [address, setAddress] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [apkUpdate, setApkUpdate] = useState<MobileApkUpdate | null>(null);
  const [apkState, setApkState] = useState<ApkUpdateState | null>(null);
  const apkStateRef = useRef<ApkUpdateState | null>(null);
  const apkBusyRef = useRef(false);
  const apkLookupBusyRef = useRef(false);
  const apkCheckSequence = useRef(0);
  const [apkCheckBusy, setApkCheckBusy] = useState(false);
  const [apkCheckMessage, setApkCheckMessage] = useState<string | null>(null);
  const [apkCheckError, setApkCheckError] = useState<string | null>(null);
  const [apkUpdateBusy, setApkUpdateBusy] = useState(false);
  const [apkDownloadBusy, setApkDownloadBusy] = useState(false);
  const [apkUpdateError, setApkUpdateError] = useState<string | null>(null);
  const [apkDownloadMessage, setApkDownloadMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const editingRef = useRef(editing);
  editingRef.current = editing && mode !== "ssh";
  const vpnRecoveryEventsToSkip = useRef(0);
  const vpnRetry = useRef(createMobileVpnRetry(() => setRevision((value) => value + 1))).current;
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);
  const environmentOpening = useRef(false);
  const workspaceOverlay = useRef(createMobileWorkspaceOverlay({
    hide: () => setNativeSshWorkspaceVisible(false),
    show: () => setNativeSshWorkspaceVisible(true),
    close: closeNativeSshWorkspace,
  })).current;
  const closeEnvironmentDialog = (): void => {
    environmentOpening.current = false;
    setEnvironmentDialogOpen(false);
    void workspaceOverlay.dismiss().catch(() => {});
  };
  const leaveSshWorkspace = (): Promise<void> => workspaceOverlay.leave();
  const [environmentBusy, setEnvironmentBusy] = useState<string | null>(null);
  const [environmentMessage, setEnvironmentMessage] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("读取中…");
  const returnToWorkbench = useCallback((): void => {
    setMode("bridge");
    setEditing(false);
    setError(null);
    setScannerOpen(false);
    setEnvironmentDialogOpen(false);
    try { window.localStorage.setItem("bridge.connection.mode", "bridge"); } catch { /* preference only */ }
    if (isStandaloneSshPath(location.pathname)) navigate("/", { replace: true });
    if (state !== "ready" && getMobileConnection()?.token) setRevision((value) => value + 1);
  }, [location.pathname, navigate, state]);
  const returnToWorkbenchRef = useRef(returnToWorkbench);
  returnToWorkbenchRef.current = returnToWorkbench;
  useMobileBack(environmentDialogOpen, () => { if (!environmentBusy) closeEnvironmentDialog(); }, 220);
  useMobileBack(editing || mode === "ssh", () => {
    if (!busy) returnToWorkbench();
  }, 50);

  const saveApkState = (update: MobileApkUpdate, state: ApkUpdateState): void => {
    apkStateRef.current = state;
    setApkState(state);
    try { window.localStorage.setItem(apkUpdateStorageKey(update.server), JSON.stringify(state)); } catch { /* Recheck installed version on resume even without storage. */ }
  };

  useEffect(() => {
    if (isStandaloneSshPath(location.pathname)) setMode("ssh");
  }, [location.pathname]);

  useEffect(() => { void getMobileAppVersion().then(setAppVersion).catch(() => setAppVersion("暂不可读")); }, []);
  useEffect(() => {
    if ((location.state as { mobileOpenConnectionSettings?: boolean } | null)?.mobileOpenConnectionSettings !== true) return;
    setAddress(getMobileConnection()?.server ?? ""); setMode("bridge"); setEditing(true); setError(null);
    try { window.localStorage.setItem("bridge.connection.mode", "bridge"); } catch { /* preference only */ }
    navigate("/", { replace: true, state: null });
  }, [location.state, navigate]);

  useEffect(() => {
    let active = true;
    const changed = (): void => {
      apkCheckSequence.current += 1;
      setApkCheckMessage(null);
      setApkCheckError(apkLookupBusyRef.current && !getMobileConnection()?.token ? "Bridge 配对已失效，请重新配对后再试。" : null);
      setRevision((current) => current + 1);
    };
    const settings = (event: Event): void => {
      const requestedServer = event instanceof CustomEvent && typeof event.detail?.server === "string" ? event.detail.server : null;
      const requestedError = event instanceof CustomEvent && typeof event.detail?.error === "string" ? event.detail.error : null;
      setAddress(requestedServer ?? getMobileConnection()?.server ?? "");
      setError(requestedError); setPairingInput(""); setMode("bridge"); setEditing(true);
      environmentOpening.current = false;
      void leaveSshWorkspace().catch(() => {});
      try { window.localStorage.setItem("bridge.connection.mode", "bridge"); } catch { /* preference only */ }
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
    const onVpnReachable = (): void => {
      if (document.visibilityState === "hidden") return;
      if (vpnRetry.onReachable(stateRef.current, editingRef.current)) vpnRecoveryEventsToSkip.current = 2;
    };
    const onApiUnavailable = (): void => vpnRetry.onUnavailable(stateRef.current, editingRef.current);
    const onApiReachable = (): void => vpnRetry.onReachableApi();
    window.addEventListener("bridge:mobile-vpn-reachable", onVpnReachable);
    window.addEventListener("bridge:api-network-unreachable", onApiUnavailable);
    window.addEventListener("bridge:api-reachable", onApiReachable);
    return () => {
      window.removeEventListener("bridge:mobile-vpn-reachable", onVpnReachable);
      window.removeEventListener("bridge:api-network-unreachable", onApiUnavailable);
      window.removeEventListener("bridge:api-reachable", onApiReachable);
    };
  }, [vpnRetry]);

  useEffect(() => {
    vpnRetry.onState(state, editing && mode !== "ssh");
  }, [state, editing, mode, vpnRetry]);

  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | undefined;
    void onNativeSshReturnToWorkbench(() => {
      if (!disposed) returnToWorkbenchRef.current();
    }).then((listener) => {
      if (disposed) void listener.remove(); else removeListener = () => { void listener.remove(); };
    }).catch(() => { /* Browser and unsupported native platforms do not expose SSH. */ });
    return () => { disposed = true; removeListener?.(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    const openEnvironmentDialog = (): void => {
      if (!isAppActive() || scannerOpen || environmentOpening.current) return;
      environmentOpening.current = true;
      void workspaceOverlay.open().then((opened) => {
        if (disposed) {
          void workspaceOverlay.dismiss().catch(() => {});
          environmentOpening.current = false;
          return;
        }
        if (!opened) { environmentOpening.current = false; return; }
        setEnvironmentMessage(null);
        setEnvironmentDialogOpen(true);
      }).catch(() => { environmentOpening.current = false; });
    };
    window.addEventListener(MOBILE_SHAKE_EVENT, openEnvironmentDialog);
    return () => { disposed = true; window.removeEventListener(MOBILE_SHAKE_EVENT, openEnvironmentDialog); };
  }, [scannerOpen, workspaceOverlay]);

  useEffect(() => () => { void workspaceOverlay.dismiss().catch(() => {}); }, [workspaceOverlay]);

  useEffect(() => {
    if (state !== "unavailable" || (editing && mode !== "ssh")) return;
    const retry = (): void => {
      if (vpnRecoveryEventsToSkip.current > 0) {
        vpnRecoveryEventsToSkip.current -= 1;
        return;
      }
      if (navigator.onLine !== false && isAppActive()) setRevision((value) => value + 1);
    };
    window.addEventListener("online", retry);
    window.addEventListener(MOBILE_RESUME_EVENT, retry);
    // SSH remains usable while Bridge is down; periodically recheck its update source.
    const timer = mode === "ssh" ? window.setInterval(retry, 5 * 60 * 1_000) : null;
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener(MOBILE_RESUME_EVENT, retry);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [state, editing, mode]);

  useEffect(() => {
    if (state !== "ready") { setApkUpdate(null); return; }
    let active = true;
    const checkForApkUpdate = async (): Promise<void> => {
      if (apkBusyRef.current || apkLookupBusyRef.current || !isAppActive()) return;
      const checkId = ++apkCheckSequence.current;
      try {
        const update = await checkMobileApkUpdate();
        const installed = await getMobileAppBuild();
        if (!active || checkId !== apkCheckSequence.current || apkBusyRef.current || apkLookupBusyRef.current) return;
        setApkUpdateError(null);
        if (!Number.isSafeInteger(installed) || installed < 1) throw new Error("无法读取已安装 App 版本，请稍后重试。");
        if (!update) { setApkUpdate(null); return; }
        let saved: ApkUpdateState;
        try { saved = readApkUpdateState(window.localStorage, update); }
        catch { saved = { revision: update.revision, phase: "available", snoozeUntil: 0 }; }
        const decision = decideApkUpdate(update, installed, saved);
        saveApkState(update, decision.state);
        setApkUpdate(decision.offer ? update : null);
      } catch (cause) {
        if (active && checkId === apkCheckSequence.current) setApkUpdateError(cause instanceof Error ? cause.message : "更新检查失败。");
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
  }, [state]);

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

  const transferApk = async (update: MobileApkUpdate, install: boolean): Promise<void> => {
    if (apkBusyRef.current) return;
    apkBusyRef.current = true;
    setApkUpdateBusy(install); setApkDownloadBusy(!install);
    setApkUpdateError(null);
    setApkDownloadMessage(null);
    const existing = apkStateRef.current?.revision === update.revision ? apkStateRef.current : null;
    const onPhase = (phase: ApkUpdatePhase, uri?: string): void => {
      saveApkState(update, { revision: update.revision, phase, snoozeUntil: 0, ...(uri ? { uri } : {}) });
    };
    try {
      if (install) await installMobileApkUpdate(update, existing?.uri, onPhase);
      else {
        await downloadMobileApkUpdate(update, existing?.uri, onPhase);
        setApkDownloadMessage("APK 已校验并保存到系统 Downloads，可手动安装。");
      }
    } catch (cause) {
      setApkUpdateError(cause instanceof Error ? cause.message : "更新失败，请重试。");
    } finally {
      apkBusyRef.current = false;
      setApkUpdateBusy(false); setApkDownloadBusy(false);
    }
  };

  const requireApkUpdateSource = async (): Promise<void> => {
    if (!getMobileConnection()?.token) throw new Error("请先配对 Bridge，再操作 App 更新。");
    if (!(await supportsMobileApkUpdates())) throw new Error("App 更新和 APK 下载仅支持 Android App。");
    const unavailable = bridgeFeatureUnavailable("mobile-apk-update");
    if (unavailable) throw new Error(unavailable);
  };

  const checkForApkUpdateManually = async (): Promise<void> => {
    if (apkLookupBusyRef.current || apkBusyRef.current) return;
    apkLookupBusyRef.current = true;
    const selected = getMobileConnection();
    const checkId = ++apkCheckSequence.current;
    const stillCurrent = (): boolean => checkId === apkCheckSequence.current && selected === getMobileConnection();
    setApkCheckBusy(true);
    setApkCheckMessage(null); setApkCheckError(null); setApkUpdateError(null); setApkDownloadMessage(null);
    try {
      await requireApkUpdateSource();
      const update = await checkMobileApkUpdate();
      if (!stillCurrent()) return;
      if (!update) { setApkUpdate(null); setApkCheckMessage("当前 Bridge 没有可用的 Android APK。"); return; }
      const installed = await getMobileAppBuild();
      if (!stillCurrent()) return;
      if (!Number.isSafeInteger(installed) || installed < 1) throw new Error("无法读取已安装 App 版本，请稍后重试。");
      let saved: ApkUpdateState;
      try { saved = readApkUpdateState(window.localStorage, update); }
      catch { saved = { revision: update.revision, phase: "available", snoozeUntil: 0 }; }
      const decision = decideApkUpdate(update, installed, saved, true);
      saveApkState(update, decision.state);
      setApkUpdate(decision.offer ? update : null);
      setApkCheckMessage(decision.offer ? "发现新版本，请使用顶部提示更新或下载。"
        : installed === update.versionCode ? "当前 App 已是最新版本。" : "当前 App 版本高于 Bridge 提供的版本。");
    } catch (cause) {
      if (stillCurrent()) setApkCheckError(cause instanceof Error ? cause.message : "更新检查失败。");
    } finally {
      apkLookupBusyRef.current = false;
      setApkCheckBusy(false);
    }
  };

  const downloadLatestApk = async (): Promise<void> => {
    if (apkLookupBusyRef.current || apkBusyRef.current) return;
    apkLookupBusyRef.current = true;
    const selected = getMobileConnection();
    const checkId = ++apkCheckSequence.current;
    const stillCurrent = (): boolean => checkId === apkCheckSequence.current && selected === getMobileConnection();
    setApkDownloadBusy(true);
    setApkCheckMessage(null); setApkCheckError(null); setApkUpdateError(null); setApkDownloadMessage(null);
    try {
      await requireApkUpdateSource();
      const update = await checkMobileApkUpdate();
      if (!stillCurrent()) return;
      if (!update) { setApkUpdate(null); setApkDownloadMessage("当前 Bridge 没有可下载的 Android APK。"); return; }
      const installed = await getMobileAppBuild().catch(() => Number.NaN);
      if (!stillCurrent()) return;
      if (Number.isSafeInteger(installed) && installed > 0) setApkUpdate(update.versionCode > installed ? update : null);
      apkLookupBusyRef.current = false;
      setApkDownloadBusy(false);
      await transferApk(update, false);
    } catch (cause) {
      if (stillCurrent()) setApkUpdateError(cause instanceof Error ? cause.message : "APK 下载失败。");
    } finally {
      apkLookupBusyRef.current = false;
      setApkDownloadBusy(false);
    }
  };

  const dismissApkUpdate = (): void => {
    if (!apkUpdate) return;
    saveApkState(apkUpdate, { ...(apkStateRef.current ?? { revision: apkUpdate.revision, phase: "available" }), snoozeUntil: Date.now() + 30 * 60_000 });
    setApkUpdate(null);
    setApkUpdateError(null);
    setApkCheckMessage(null);
  };

  const environmentOptions = buildEnvironmentOptions(getMobileConnection()?.server ?? address);
  const selectEnvironment = async (option: EnvironmentOption): Promise<void> => {
    if (option.server === getMobileConnection()?.server) {
      closeEnvironmentDialog();
      return;
    }
    setEnvironmentBusy(option.id);
    setEnvironmentMessage(null);
    try {
      if (await switchMobileConnection(option.server)) {
        await leaveSshWorkspace();
        environmentOpening.current = false;
        setEnvironmentDialogOpen(false);
        setMode("bridge");
        try { window.localStorage.setItem("bridge.connection.mode", "bridge"); } catch { /* preference only */ }
        window.location.replace("/");
        return;
      }
      await leaveSshWorkspace();
      environmentOpening.current = false;
      setEnvironmentDialogOpen(false);
      openMobileConnectionSettings(option.server);
    } catch (cause) {
      setEnvironmentMessage(connectionError(cause));
    } finally {
      setEnvironmentBusy(null);
    }
  };

  const apkAction = useRef<(action: AppUpdateAction) => void>(() => {});
  apkAction.current = (action): void => {
    if (!apkUpdate) return;
    if (action === "dismiss") dismissApkUpdate();
    else if (action === "install" || action === "download") void transferApk(apkUpdate, action === "install");
  };
  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;
    void onNativeAppUpdateAction((action) => apkAction.current(action)).then((listener) => {
      if (disposed) void listener.remove(); else remove = () => { void listener.remove(); };
    }).catch(() => {});
    return () => { disposed = true; remove?.(); };
  }, []);
  const apkStatus = apkDownloadMessage ?? (apkState?.phase === "installer-opened" ? "已打开安装器；若已取消，可再次安装。"
    : apkState?.phase === "downloaded" ? "更新包已校验，可继续安装。" : "");
  const apkDetail = apkUpdate ? `${apkUpdate.versionName} (${apkUpdate.versionCode}) · ${formatApkSize(apkUpdate.size)}` : "";
  useEffect(() => {
    void setNativeAppUpdateBanner({ visible: Boolean(apkUpdate), detail: apkDetail, status: apkStatus,
      error: apkUpdateError ?? "", busy: apkUpdateBusy || apkDownloadBusy, downloaded: Boolean(apkState?.uri) }).catch(() => {});
  }, [apkUpdate, apkDetail, apkStatus, apkUpdateError, apkUpdateBusy, apkDownloadBusy, apkState?.uri]);

  const apkBanner = apkUpdate ? (
    <aside className="mobile-update-banner" role="status">
      <div>
        <strong>发现新的 Bridge App</strong>
        <span>{apkDetail}</span>
        {apkStatus ? <span>{apkStatus}</span> : null}
      </div>
      <div className="mobile-update-actions">
        <button type="button" onClick={() => void transferApk(apkUpdate, true)} disabled={apkUpdateBusy || apkDownloadBusy}>{apkUpdateBusy ? "处理中…" : apkState?.uri ? "继续安装" : "更新"}</button>
        <button type="button" className="mobile-update-download" onClick={() => void transferApk(apkUpdate, false)} disabled={apkUpdateBusy || apkDownloadBusy}>{apkDownloadBusy ? "处理中…" : "下载 APK"}</button>
        <button type="button" className="mobile-update-dismiss" onClick={dismissApkUpdate} disabled={apkUpdateBusy || apkDownloadBusy}>稍后</button>
      </div>
      {apkUpdateError ? <p role="alert">{apkUpdateError}</p> : null}
    </aside>
  ) : null;

  const environmentDialog = environmentDialogOpen ? (
    <MobileEnvironmentDialog
      options={environmentOptions}
      busy={environmentBusy}
      message={environmentMessage}
      currentServer={getMobileConnection()?.server ?? ""}
      appVersion={appVersion}
      updateBanner={apkBanner}
      appChecking={apkCheckBusy}
      appDownloading={apkDownloadBusy}
      appActionsBusy={apkCheckBusy || apkDownloadBusy || apkUpdateBusy || Boolean(environmentBusy)}
      appMessage={apkCheckMessage ?? apkDownloadMessage}
      appError={apkCheckError ?? (!apkUpdate ? apkUpdateError : null)}
      onCheckUpdate={() => { void checkForApkUpdateManually(); }}
      onDownloadApp={() => { void downloadLatestApk(); }}
      onSelect={(option) => { void selectEnvironment(option); }}
      onOpenConnectionSettings={() => openMobileConnectionSettings()}
      onClose={closeEnvironmentDialog}
    />
  ) : null;

  if (scannerOpen) return <>{apkBanner}<MobilePairingScanner onPair={scanAndPair} onClose={() => setScannerOpen(false)} /></>;

  if (state === "ready" && !editing && mode === "bridge") return <>
    <MobileNavigationBridge />
    {!environmentDialogOpen && apkBanner}
    {children}
    {environmentDialog}
  </>;

  return <main className="mobile-connect-page mobile-connection-page">
    {!environmentDialogOpen && apkBanner}
    <section className="mobile-connect-card mobile-connection-center" aria-labelledby="mobile-connect-title">
      <header className="mobile-connect-header">
        <div className="mobile-connect-brand-row">
          <div className="mobile-connect-mark" aria-hidden="true">B</div>
          <div className="mobile-connect-brand-copy">
            <h1 id="mobile-connect-title">连接你的 Mac</h1>
            <span className={`mobile-connect-status is-${mode === "ssh" ? "ssh" : state}`}>
              <i aria-hidden="true" />
              Bridge App · {mode === "ssh" ? "SSH 直接连接" : state === "loading" ? "检查连接" : state === "unavailable" ? "连接不可用" : getMobileConnection()?.token ? "已配对" : "未配对"}
            </span>
          </div>
          {(editing || mode === "ssh") && getMobileConnection()?.token && <button type="button" className="mobile-connect-return" disabled={busy}
            onClick={returnToWorkbench}>返回工作台</button>}
        </div>
      </header>
      <nav className="mobile-workspace-switcher" aria-label="选择连接方式">
        <button type="button" className={`mobile-workspace-switcher-item${mode === "bridge" ? " is-active" : ""}`}
          aria-pressed={mode === "bridge"} onClick={() => selectMode("bridge")}>
          Bridge
        </button>
        <button type="button" className={`mobile-workspace-switcher-item${mode === "ssh" ? " is-active" : ""}`}
          aria-pressed={mode === "ssh"} onClick={() => selectMode("ssh")}>
          SSH / Mac
        </button>
      </nav>
      {mode === "ssh" ? <MobileSshLogin /> : <>
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
          <section className="mobile-connect-method" aria-label="快速连接">
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
        </form>}
        {getMobileConnection()?.token ? <details className="mobile-connect-maintenance">
          <summary>连接维护与 App 更新</summary>
          {editing && <div className="mobile-connect-existing-actions">
            <button type="button" className="mobile-connect-danger" disabled={busy}
              onClick={() => {
                setBusy(true);
                void disconnectMobileConnection().catch(() => {}).finally(() => { setBusy(false); setEditing(false); });
              }}>断开并清除本机配对</button>
          </div>}
          <div className="mobile-connect-update">
            <div className="mobile-connect-update-heading">
              <span className="mobile-connect-update-icon" aria-hidden="true">↓</span>
              <div>
                <strong>手动更新 App</strong>
                <p>从当前已配对的 Bridge 下载最新 APK，保存后再手动安装。</p>
              </div>
            </div>
            <button type="button" className="mobile-connect-update-button" onClick={() => void downloadLatestApk()} disabled={busy || apkCheckBusy || apkDownloadBusy || apkUpdateBusy}>
              {apkDownloadBusy ? "正在准备下载…" : "手动下载 APK"}
            </button>
            {apkDownloadMessage ? <p className="mobile-connect-update-message" role="status">{apkDownloadMessage}</p> : null}
            {apkUpdateError ? <p className="mobile-connect-error" role="alert">{apkUpdateError}</p> : null}
          </div>
        </details> : null}
      </>}
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
  try {
    const base = new URL(server ? normalizeConfiguredBridgeServer(server) : bridgeOriginForPort(7310));
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

export function MobileEnvironmentDialog({
  options, busy, message, currentServer, appVersion, updateBanner, appChecking, appDownloading, appActionsBusy,
  appMessage, appError, onCheckUpdate, onDownloadApp, onSelect, onOpenConnectionSettings, onClose,
}: {
  options: EnvironmentOption[];
  busy: string | null;
  message: string | null;
  currentServer: string;
  appVersion: string;
  updateBanner: ReactNode;
  appChecking: boolean;
  appDownloading: boolean;
  appActionsBusy: boolean;
  appMessage: string | null;
  appError: string | null;
  onCheckUpdate: () => void;
  onDownloadApp: () => void;
  onSelect: (option: EnvironmentOption) => void;
  onOpenConnectionSettings: () => void;
  onClose: () => void;
}): ReactElement {
  return <div className="mobile-environment-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`mobile-environment-overlay${updateBanner ? " has-update-banner" : ""}`} role="dialog" aria-modal="true" aria-labelledby="mobile-environment-title">
    {updateBanner ? <div className="mobile-environment-update">{updateBanner}</div> : null}
    <section className="mobile-environment-dialog">
      <header className="mobile-environment-header">
        <div className="mobile-environment-icon" aria-hidden="true">⚙</div>
        <div>
          <span>系统管理</span>
          <h2 id="mobile-environment-title">切换 Bridge 环境</h2>
        </div>
        <button type="button" className="mobile-environment-close" aria-label="关闭" onClick={onClose}>×</button>
      </header>
      <p className="mobile-environment-description">切换只更换后端 API，不会加载该环境的网页。当前配对和各环境草稿会保留；未配对的环境需先配对。</p>
      <div className="mobile-environment-app" aria-label="App 版本与更新">
        <div className="mobile-environment-app-version"><span>App 版本</span><strong>{appVersion}</strong></div>
        <div className="mobile-environment-app-actions">
          <button type="button" className="mobile-connect-secondary" disabled={appActionsBusy} onClick={onCheckUpdate}>
            {appChecking ? "检查中…" : "检查更新"}
          </button>
          <button type="button" className="mobile-connect-secondary" disabled={appActionsBusy} onClick={onDownloadApp}>
            {appDownloading ? "正在下载…" : "手动下载 App"}
          </button>
        </div>
        {appMessage ? <p className="mobile-environment-app-message" role="status">{appMessage}</p> : null}
        {appError ? <p className="mobile-connect-error" role="alert">{appError}</p> : null}
        <details className="mobile-environment-version-details">
          <summary>版本详情</summary>
          <dl className="mobile-environment-versions">
            <dt>内置页面</dt><dd>{import.meta.env.VITE_BRIDGE_FRONTEND_VERSION ?? "开发预览"} · {import.meta.env.VITE_BRIDGE_FRONTEND_BUILD ?? "未打包"}</dd>
            <dt>后端版本</dt><dd>{getBridgeCapabilities()?.version ?? "旧版后端，未提供版本信息"}</dd>
          </dl>
        </details>
      </div>
      <dl className="mobile-environment-versions mobile-environment-current">
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
    </div>
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
