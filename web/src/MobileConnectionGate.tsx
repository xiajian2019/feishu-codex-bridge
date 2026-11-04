import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactElement, type ReactNode } from "react";
import { normalizeConfiguredBridgeServer, parseMobilePairingInput } from "./mobile-connection.js";
import {
  BRIDGE_NETWORK_SETTINGS_EVENT, bridgeOriginForPort, getConfiguredGlobalMacHost,
  readBridgeNetworkSettings, saveBridgeNetworkSettings,
} from "./bridge-global-config.js";
import { createMobileVpnRetry } from "./mobile-vpn-retry.js";
import {
  checkMobileApkUpdate, checkMobileConnection, disconnectMobileConnection, downloadMobileApkUpdate, getMobileConnection,
  initializeMobileRuntime, installMobileApkUpdate, MOBILE_CONNECTION_EVENT, MOBILE_RESUME_EVENT, MOBILE_SETTINGS_EVENT,
  MOBILE_SHAKE_EVENT, openMobileConnectionSettings, pairMobileConnection, switchMobileConnection,
  applyConfiguredBridgeNetworkSettings, checkAndConnectMobileVpn, getMobileAppVersion, getMobileAppBuild, readCurrentWifiSsid, supportsMobileApkUpdates,
  type MobileApkUpdate,
} from "./mobile-runtime.js";
import MobileDownloadStatus from "./MobileDownloadStatus.js";
import { getMobileDownloads, subscribeMobileDownloads, type MobileDownloadTask } from "./mobile-download-manager.js";
import MobilePairingScanner from "./MobilePairingScanner.js";
import { bridgeFeatureUnavailable, getBridgeCapabilities } from "./client-capabilities.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import { apkUpdateStorageKey, decideApkUpdate, readApkUpdateState, type ApkUpdateState, type ApkUpdatePhase } from "./mobile-apk-update.js";
import "./mobile-app.css";
import { useMobileBack } from "./use-mobile-back.js";
import { useLocation, useNavigate } from "react-router";
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
    try { return window.localStorage.getItem("bridge.connection.mode") === "ssh" ? "ssh" : "bridge"; }
    catch { return "bridge"; }
  });
  const selectMode = (next: "bridge" | "ssh"): void => {
    setMode(next);
    try { window.localStorage.setItem("bridge.connection.mode", next); } catch { /* preference only */ }
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
  const mobileDownloads = useSyncExternalStore(subscribeMobileDownloads, getMobileDownloads, getMobileDownloads);
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
  const [vpnChecking, setVpnChecking] = useState(false);
  const [vpnMessage, setVpnMessage] = useState<string | null>(null);
  const vpnCheckingRef = useRef(false);
  const vpnMessageTimerRef = useRef<number | null>(null);
  const [appVersion, setAppVersion] = useState("读取中…");
  const returnToWorkbench = useCallback((): void => {
    setMode("bridge");
    setEditing(false);
    setError(null);
    setScannerOpen(false);
    setEnvironmentDialogOpen(false);
    try { window.localStorage.setItem("bridge.connection.mode", "bridge"); } catch { /* preference only */ }
    if (state !== "ready" && getMobileConnection()?.token) setRevision((value) => value + 1);
  }, [state]);
  const returnToWorkbenchRef = useRef(returnToWorkbench);
  returnToWorkbenchRef.current = returnToWorkbench;
  useEffect(() => () => {
    if (vpnMessageTimerRef.current !== null) window.clearTimeout(vpnMessageTimerRef.current);
  }, []);
  useMobileBack(environmentDialogOpen, () => { if (!environmentBusy) closeEnvironmentDialog(); }, 220);
  useMobileBack(editing || mode === "ssh", () => {
    if (!busy) returnToWorkbench();
  }, 50);

  const saveApkState = (update: MobileApkUpdate, state: ApkUpdateState): void => {
    apkStateRef.current = state;
    setApkState(state);
    try { window.localStorage.setItem(apkUpdateStorageKey(update.server), JSON.stringify(state)); } catch { /* Recheck installed version on resume even without storage. */ }
  };

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

  const checkVpnManually = async (): Promise<void> => {
    if (vpnCheckingRef.current) return;
    vpnCheckingRef.current = true;
    if (vpnMessageTimerRef.current !== null) {
      window.clearTimeout(vpnMessageTimerRef.current);
      vpnMessageTimerRef.current = null;
    }
    setVpnChecking(true); setVpnMessage("正在发起 VPN 连接…");
    try {
      const message = await checkAndConnectMobileVpn();
      setVpnMessage(message);
      if (message === "VPN 连接成功") {
        vpnMessageTimerRef.current = window.setTimeout(() => {
          vpnMessageTimerRef.current = null;
          setVpnMessage(null);
        }, 1_500);
      }
    }
    catch (cause) { setVpnMessage(cause instanceof Error ? cause.message : "VPN 检查失败，请重试。"); }
    finally { vpnCheckingRef.current = false; setVpnChecking(false); }
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
  const apkDownloadTask = latestMobileDownload(mobileDownloads, "bridge-update.apk");
  const apkProgress = apkUpdate && (apkUpdateBusy || apkDownloadBusy) && !apkStatus && apkDownloadTask
    ? describeApkDownloadProgress(apkDownloadTask, apkUpdate.size) : null;
  useEffect(() => {
    void setNativeAppUpdateBanner({ visible: Boolean(apkUpdate), detail: apkDetail, status: apkStatus,
      error: apkUpdateError ?? "", busy: apkUpdateBusy || apkDownloadBusy, downloaded: Boolean(apkState?.uri),
      progressPercent: apkProgress?.percent ?? undefined, progressText: apkProgress?.text ?? "" }).catch(() => {});
  }, [apkUpdate, apkDetail, apkStatus, apkUpdateError, apkUpdateBusy, apkDownloadBusy, apkState?.uri,
    apkProgress?.percent, apkProgress?.text]);

  const environmentDialog = environmentDialogOpen ? (
    <MobileEnvironmentDialog
      options={environmentOptions}
      busy={environmentBusy}
      message={environmentMessage}
      currentServer={getMobileConnection()?.server ?? ""}
      vpnChecking={vpnChecking}
      vpnMessage={vpnMessage}
      onCheckVpn={() => { void checkVpnManually(); }}
      appVersion={appVersion}
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

  if (scannerOpen) return <MobilePairingScanner onPair={scanAndPair} onClose={() => setScannerOpen(false)} />;

  if (state === "ready" && !editing && mode === "bridge") return <>
    <MobileNavigationBridge />
    {children}
    {environmentDialog}
  </>;

  return <main className="mobile-connect-page mobile-connection-page">
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
                if (!window.confirm("确认断开并清除本机配对？清除后需要重新配对 Bridge 才能继续使用。")) return;
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
          <MobileAutoVpnSettings disabled={busy} onApplied={() => setAddress(getMobileConnection()?.server ?? "")} />
        </details> : null}
      </>}
      </>}
      {(mode === "ssh" || !getMobileConnection()?.token) && <details className="mobile-connect-maintenance">
        <summary>网络设置</summary>
        <MobileAutoVpnSettings disabled={busy} onApplied={() => setAddress(getMobileConnection()?.server ?? "")} />
      </details>}
    </section>
    {environmentDialog}
  </main>;
}

export function MobileAutoVpnSettings({ disabled = false, onApplied = () => {} }: { disabled?: boolean; onApplied?: () => void }): ReactElement {
  const [globalHost, setGlobalHost] = useState(getConfiguredGlobalMacHost);
  const [wifiSsids, setWifiSsids] = useState(() => readBridgeNetworkSettings().vpnBypassWifiSsids);
  const [wifiInput, setWifiInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [wifiReadBusy, setWifiReadBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = (): void => {
      const settings = readBridgeNetworkSettings();
      setGlobalHost(settings.globalMacHost);
      setWifiSsids(settings.vpnBypassWifiSsids);
      setWifiInput("");
    };
    window.addEventListener(BRIDGE_NETWORK_SETTINGS_EVENT, refresh);
    return () => window.removeEventListener(BRIDGE_NETWORK_SETTINGS_EVENT, refresh);
  }, []);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (disabled) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const manualWifi = wifiInput.trim();
      const nextWifiSsids = manualWifi && !wifiSsids.includes(manualWifi)
        ? [...wifiSsids, manualWifi] : wifiSsids;
      const settings = saveBridgeNetworkSettings({
        globalMacHost: globalHost,
        vpnBypassWifiSsids: nextWifiSsids,
      });
      try {
        await applyConfiguredBridgeNetworkSettings();
        onApplied();
        setMessage("网络配置已保存，并已应用到当前连接。");
      } catch (cause) {
        onApplied();
        setMessage("网络配置已保存；当前连接尚未切换，重新打开 App 后会使用新地址。");
        setError(cause instanceof Error ? cause.message : "当前连接暂未切换，请稍后重试。");
      }
      setGlobalHost(settings.globalMacHost);
      setWifiSsids(settings.vpnBypassWifiSsids);
      setWifiInput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络配置保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const addCurrentWifi = async (): Promise<void> => {
    if (disabled || busy || wifiReadBusy) return;
    setWifiReadBusy(true); setError(null); setMessage(null);
    try {
      const ssid = await readCurrentWifiSsid();
      if (!ssid) throw new Error("未读取到当前 Wi‑Fi，请先连接目标 Wi‑Fi，并允许位置权限后重试。");
      if (wifiSsids.includes(ssid)) {
        setMessage(`当前 Wi‑Fi“${ssid}”已经在免 VPN 列表中。`);
      } else {
        setWifiSsids((current) => [...current, ssid]);
        setMessage(`已选择 Wi‑Fi“${ssid}”，点击“保存网络配置”后生效。`);
      }
      setWifiInput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取当前 Wi‑Fi，请重试。");
    } finally {
      setWifiReadBusy(false);
    }
  };

  return <section className="mobile-connect-network-settings" aria-label="自动 VPN 网络设置">
    <div className="mobile-connect-network-heading">
      <strong>自动 VPN 网络设置</strong>
      <span>除免 VPN 的 Wi‑Fi 外，App 运行时会自动检查并连接 VPN</span>
    </div>
    <form onSubmit={(event) => { void save(event); }}>
      <label className="mobile-connect-network-field" htmlFor="mobile-global-mac-host">
        <span>全局 IP</span>
        <input id="mobile-global-mac-host" value={globalHost} onChange={(event) => setGlobalHost(event.target.value)}
          placeholder="例如 10.15.53.70" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={disabled || busy} />
        <small>用于私有 Bridge 地址和 SSH 默认主机；修改后无需重新配对。</small>
      </label>
      <div className="mobile-connect-network-field">
        <span>免自动 VPN 的 Wi‑Fi</span>
        <div className="mobile-connect-network-input-row">
          <input id="mobile-vpn-bypass-wifi" value={wifiInput} onChange={(event) => setWifiInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); } }}
            placeholder="输入 Wi‑Fi 名称，或点击右侧图标读取" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={disabled || busy || wifiReadBusy} />
          <button type="button" className="mobile-connect-network-read" onClick={() => { void addCurrentWifi(); }}
            disabled={disabled || busy || wifiReadBusy} aria-label="读取当前 Wi‑Fi" title="读取当前 Wi‑Fi">
            {wifiReadBusy ? <span aria-hidden="true">…</span> : <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.5 8.8a15.6 15.6 0 0 1 19 0M5.8 12.5a10.2 10.2 0 0 1 12.4 0M9.2 16.1a5.2 5.2 0 0 1 5.6 0M12 20h.01" /></svg>}
          </button>
        </div>
        <small>可手动输入 Wi‑Fi 名称后直接保存；右侧图标会读取当前已连接的 Wi‑Fi。</small>
        {wifiSsids.length ? <ul className="mobile-connect-network-list">
          {wifiSsids.map((ssid) => <li key={ssid}>
            <span>{ssid}</span>
            <button type="button" aria-label={`移除免 VPN Wi‑Fi ${ssid}`} onClick={() => {
              setWifiSsids((current) => current.filter((item) => item !== ssid));
              setMessage(null); setError(null);
            }} disabled={disabled || busy || wifiReadBusy}>移除</button>
          </li>)}
        </ul> : <small>尚未添加 Wi‑Fi。手机设置里显示的 Wi‑Fi 名称就是 SSID。</small>}
      </div>
      {message ? <p className="mobile-connect-network-message" role="status">{message}</p> : null}
      {error ? <p className="mobile-connect-error" role="alert">{error}</p> : null}
      <button type="submit" className="mobile-connect-secondary mobile-connect-network-save" disabled={disabled || busy}>
        {busy ? "正在保存…" : "保存网络配置"}
      </button>
    </form>
  </section>;
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
  options, busy, message, currentServer, vpnChecking, vpnMessage, onCheckVpn, appVersion, appChecking, appDownloading, appActionsBusy,
  appMessage, appError, onCheckUpdate, onDownloadApp, onSelect, onOpenConnectionSettings, onClose,
}: {
  options: EnvironmentOption[];
  busy: string | null;
  message: string | null;
  currentServer: string;
  vpnChecking: boolean;
  vpnMessage: string | null;
  onCheckVpn: () => void;
  appVersion: string;
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
    <div className="mobile-environment-overlay" role="dialog" aria-modal="true" aria-labelledby="mobile-environment-title">
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
        <dt>当前地址</dt>
        <dd>
          <span>{currentServer || "未连接"}</span>
          <button type="button" className="mobile-environment-vpn-check" aria-label={vpnChecking ? "正在连接 VPN" : "检查并连接 VPN"}
            title={vpnChecking ? "正在连接 VPN" : "检查并连接 VPN"} aria-busy={vpnChecking} data-loading={vpnChecking ? "true" : undefined}
            disabled={vpnChecking} onClick={onCheckVpn}>
            VPN
          </button>
        </dd>
      </dl>
      {vpnMessage ? <p className="mobile-environment-vpn-message" role="status">{vpnMessage}</p> : null}
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

function latestMobileDownload(tasks: readonly MobileDownloadTask[], fileName: string): MobileDownloadTask | null {
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (tasks[index]?.fileName === fileName) return tasks[index];
  }
  return null;
}

function describeApkDownloadProgress(task: MobileDownloadTask, expectedSize: number): { percent: number | null; text: string } {
  const phase = task.state === "preparing" ? "正在准备"
    : task.state === "queued" ? "等待下载"
      : task.state === "downloading" ? "正在下载"
        : task.state === "saving" ? "正在校验更新包"
          : task.state === "done" ? "更新包已处理" : task.message || "正在处理";
  if (task.state === "saving" || task.state === "done") return { percent: 100, text: phase };
  const total = task.totalBytes && task.totalBytes > 0 ? task.totalBytes : expectedSize;
  if (total > 0) {
    const percent = Math.min(100, Math.max(0, Math.floor(task.downloadedBytes / total * 100)));
    return { percent, text: `${phase} · ${percent}%` };
  }
  return { percent: null, text: `${phase} · 已下载 ${formatDownloadBytes(task.downloadedBytes)}` };
}

function formatDownloadBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
