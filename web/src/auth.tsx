import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import * as QRCode from "qrcode";
import { getActionToken } from "./api.js";
import { clearLocalDraftsAfterDeviceRevocation } from "./local-draft-cleanup.js";
import { getLocalDraftScope, setLocalDraftScope } from "./local-draft-scope.js";
import { readBridgeJson } from "./bridge-json.js";
import { parseBridgeCapabilities, setBridgeCapabilities } from "./client-capabilities.js";
import { copyMobileText, getBridgeOrigin, isMobileApp, openBridgeExternal } from "./mobile-runtime.js";
import { clearBridgeJsonCache, isTransientBridgeFailure, markBridgeRequestFailure, markBridgeRequestStart, markBridgeRequestSuccess } from "./connection-state.js";

import { PairingClaim } from "./PairingClaim.js";
import { recordAuthStatus, type AuthStatus } from "./pairing-diagnostics.js";
import { DeviceAuthorizations } from "./DeviceAuthorizations.js";
import "./device-authorizations.css";
import { describeDevice, deviceAuthorizationState, type DeviceAuthorization as WebAuthDevice } from "./device-authorizations.js";

const PAIRING_COMMAND = "feishu-codex-bridge web:pair";
const LAST_KNOWN_AUTH_KEY = "bridge:last-known-authenticated";

interface ApiError {
  error?: string;
}

class PairingClaimFailure extends Error {
  constructor(message: string, public readonly status: AuthStatus) { super(message); }
}

interface PairingInfo {
  pairingUrl: string;
  expiresAt: number;
}

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offlineFallback, setOfflineFallback] = useState(false);
  const pairingClaimRef = useRef<Promise<AuthStatus> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadAuthStatus(pairingClaimRef)
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        if (navigator.onLine === false && hasLastKnownAuth()) {
          setOfflineFallback(true);
          return;
        }
        if (requestError instanceof PairingClaimFailure) setStatus(requestError.status);
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!status && !offlineFallback) return;
    let cancelled = false;
    let pending = false;
    const revalidate = (): void => {
      if (pending || navigator.onLine === false || document.visibilityState === "hidden") return;
      pending = true;
      void loadAuthStatus()
        .then((nextStatus) => {
          if (cancelled) return;
          setStatus(nextStatus);
          setOfflineFallback(false);
          setError(null);
        })
        .catch((requestError: unknown) => {
          if (cancelled || isTransientBridgeFailure(requestError)) return;
          forgetLastKnownAuth();
          setStatus(null);
          setOfflineFallback(false);
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        })
        .finally(() => { pending = false; });
    };
    // Also refresh a long-open terminal tab after an admin extends this device.
    const timer = window.setInterval(revalidate, status?.authenticated ? 60_000 : 15_000);
    window.addEventListener("online", revalidate);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", revalidate);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [offlineFallback, status?.authenticated]);

  if (status?.authenticated || offlineFallback) return <Fragment key={getLocalDraftScope() ?? "legacy"}>{children}</Fragment>;
  if (!status && !error) return <AuthShell><div className="route-loading">正在检查访问权限…</div></AuthShell>;
  return <AuthShell><PairingClaim status={status} error={error} onRefresh={async () => {
    const nextStatus = await loadAuthStatus();
    setStatus(nextStatus);
    setError(null);
  }} onClaim={async (code) => {
    try {
      const nextStatus = await claimBrowserPairing(code);
      setStatus(nextStatus);
      setError(null);
    } catch (failure) {
      if (failure instanceof PairingClaimFailure) setStatus(failure.status);
      throw failure;
    }
  }} /></AuthShell>;
}

async function loadAuthStatus(
  pairingClaimRef?: { current: Promise<AuthStatus> | null },
): Promise<AuthStatus> {
  markBridgeRequestStart();
  let requestEnded = false;
  const requestOrigin = getBridgeOrigin();
  try {
    const statusResponse = await fetch("/api/auth/status", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    const statusBody = await readBridgeJson<AuthStatus & ApiError>(statusResponse);
    if (requestOrigin !== getBridgeOrigin()) throw new DOMException("Bridge connection changed", "AbortError");
    if (!statusResponse.ok) {
      markBridgeRequestFailure(new Error("鉴权状态读取失败（" + statusResponse.status + "）"), statusResponse.status);
      requestEnded = true;
      if (statusResponse.status === 401) clearBridgeJsonCache();
      throw new Error("鉴权状态读取失败（" + statusResponse.status + "）");
    }
    if (typeof statusBody.authenticated !== "boolean") throw new Error("当前后端的鉴权响应不兼容，请检查服务版本。");
    markBridgeRequestSuccess();
    requestEnded = true;
    if (!statusBody.authenticated) await clearLocalDraftsAfterDeviceRevocation();
    const capabilities = statusBody.authenticated ? parseBridgeCapabilities(statusBody.client) : null;
    setLocalDraftScope(statusBody.authenticated ? statusBody.draftScope : null, isMobileApp() ? requestOrigin : undefined);
    setBridgeCapabilities(capabilities);
    if (!isMobileApp()) recordAuthStatus(statusBody);
    if (statusBody.authenticated) {
      rememberLastKnownAuth(statusBody.draftScope);
      return statusBody;
    }
    forgetLastKnownAuth();
    clearBridgeJsonCache();
    // Native pairing is handled by MobileConnectionGate, which stores a device token.
    if (isMobileApp()) return statusBody;

    // StrictMode can start two status reads before the first claim completes.
    // Join the in-flight claim even after its one-time URL fragment was removed.
    if (pairingClaimRef?.current) return pairingClaimRef.current;
    const code = readPairingCodeFromHash();
    if (!code) return statusBody;

    const claimPromise = claimBrowserPairing(code).catch((error: unknown) => {
      if (error instanceof PairingClaimFailure) throw error;
      throw new PairingClaimFailure(error instanceof Error ? error.message : "配对失败，请重试。", statusBody);
    });
    if (pairingClaimRef) {
      pairingClaimRef.current = claimPromise;
      try {
        return await claimPromise;
      } finally {
        if (pairingClaimRef.current === claimPromise) pairingClaimRef.current = null;
      }
    }
    return claimPromise;
  } catch (error) {
    if (!requestEnded) {
      markBridgeRequestFailure(error);
    }
    throw error;
  }
}

async function claimBrowserPairing(code: string): Promise<AuthStatus> {
  // A one-time code belongs only in the claim request, not browser history or logs.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  const response = await fetch("/api/auth/pairing/claim", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ code }),
  });
  const body = await response.json() as ApiError;
  if (!response.ok) {
    const message = response.status === 429 ? "配对尝试过多，请稍后重试。"
      : body.error === "pairing code expired or unavailable" ? "二维码已过期、已使用或尚未生成，请在 Mac 上重新生成。"
      : body.error === "invalid pairing code" ? "配对码不正确，请扫描最新的二维码。"
      : "配对失败（" + response.status + "），请重新生成二维码后重试。";
    throw new Error(message);
  }
  const status = await loadAuthStatus();
  if (!status.authenticated) {
    throw new PairingClaimFailure("配对已受理，但浏览器没有保存或发送登录 Cookie。请检查 Cookie 设置及当前访问地址，再生成二维码重试。", status);
  }
  return status;
}

function hasLastKnownAuth(): boolean {
  try {
    const value = JSON.parse(sessionStorage.getItem(LAST_KNOWN_AUTH_KEY) ?? "null");
    if (value?.origin !== getBridgeOrigin() || typeof value.scope !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.scope)) return false;
    setLocalDraftScope(value.scope, isMobileApp() ? value.origin : undefined);
    return true;
  } catch { return false; }
}

function rememberLastKnownAuth(scope: string | null | undefined): void {
  try { sessionStorage.setItem(LAST_KNOWN_AUTH_KEY, JSON.stringify({ origin: getBridgeOrigin(), scope })); } catch { /* unavailable in private browsing */ }
}

function forgetLastKnownAuth(): void {
  try { sessionStorage.removeItem(LAST_KNOWN_AUTH_KEY); } catch { /* unavailable in private browsing */ }
}

function readPairingCodeFromHash(): string | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const code = params.get("pair")?.trim();
  return code || null;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (isMobileApp()) return copyMobileText(value);
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for browsers that expose the API but deny access on HTTP pages.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器未允许访问剪贴板。");
}

export function PairingAdmin(): ReactElement {
  const [notice, setNotice] = useState<string | null>(null);
  const [devices, setDevices] = useState<WebAuthDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingLinkCopied, setPairingLinkCopied] = useState(false);
  const [pairingLinkCopyError, setPairingLinkCopyError] = useState<string | null>(null);
  const [pairingCommandError, setPairingCommandError] = useState<string | null>(null);
  const [pairingCommandCopied, setPairingCommandCopied] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingDeviceName, setEditingDeviceName] = useState("");
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);

  const loadManagement = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [, devicesResponse] = await Promise.all([
        loadAuthStatus(),
        fetch("/api/auth/devices?includeInactive=1", {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);
      const body = await devicesResponse.json() as { devices?: WebAuthDevice[] } & ApiError;
      if (!devicesResponse.ok) {
        throw new Error(body.error || "设备列表读取失败（" + devicesResponse.status + "）");
      }
      setDevices(body.devices ?? []);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadManagement();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refreshDevices = async (): Promise<void> => {
      if (pending || controller.signal.aborted || document.visibilityState === "hidden" || navigator.onLine === false) return;
      pending = true;
      try {
        const response = await fetch("/api/auth/devices?includeInactive=1", {
          headers: { Accept: "application/json" }, credentials: "same-origin",
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) return;
        const body = await response.json() as { devices?: WebAuthDevice[] };
        if (!controller.signal.aborted && body.devices) setDevices(body.devices);
      } catch { /* Keep the last device list until the next refresh. */ }
      finally { pending = false; }
    };
    const refresh = (): void => { void refreshDevices(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    if (!pairing) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    setQrDataUrl(null);
    void QRCode.toDataURL(pairing.pairingUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((qrError: unknown) => {
        if (!cancelled) {
          const message = qrError instanceof Error ? qrError.message : String(qrError);
          setPairingError(redactPairingSecrets(message));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  const copyPairingCommand = async (): Promise<void> => {
    setPairingCommandError(null);
    try {
      await copyTextToClipboard(PAIRING_COMMAND);
      setPairingCommandCopied(true);
    } catch (copyError: unknown) {
      setPairingCommandCopied(false);
      setPairingCommandError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const copyPairingLink = async (): Promise<void> => {
    if (!pairing) return;
    setPairingLinkCopyError(null);
    setPairingLinkCopied(false);
    try {
      await copyTextToClipboard(pairing.pairingUrl);
      setPairingLinkCopied(true);
    } catch (copyError: unknown) {
      setPairingLinkCopyError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const generatePairingQr = async (): Promise<void> => {
    setPairingBusy(true);
    setPairingError(null);
    setPairing(null);
    setPairingLinkCopied(false);
    setPairingLinkCopyError(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/auth/pairing/start", {
        method: "POST",
        headers: { Accept: "application/json", "X-Bridge-Action-Token": await getActionToken() },
        credentials: "same-origin",
        signal: controller.signal,
      });
      let body: { pairingUrl?: string; expiresAt?: number } & ApiError;
      try {
        body = await response.json() as { pairingUrl?: string; expiresAt?: number } & ApiError;
      } catch {
        throw new Error("服务端没有返回有效的 JSON 响应。");
      }
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign("/");
          return;
        }
        throw new Error(body.error || "二维码生成失败（" + response.status + "）");
      }
      if (typeof body.pairingUrl !== "string" || typeof body.expiresAt !== "number") {
        throw new Error("二维码响应不完整。");
      }
      const serverPairingUrl = new URL(body.pairingUrl);
      const currentPairingUrl = new URL("/", getBridgeOrigin());
      currentPairingUrl.hash = serverPairingUrl.hash;
      setPairing({ pairingUrl: currentPairingUrl.toString(), expiresAt: body.expiresAt });
    } catch (requestError: unknown) {
      const message = requestError instanceof DOMException && requestError.name === "AbortError"
        ? "请求超过 10 秒没有返回。"
        : requestError instanceof Error ? requestError.message : String(requestError);
      setPairingError(redactPairingSecrets(message));
    } finally {
      window.clearTimeout(timeoutId);
      setPairingBusy(false);
    }
  };

  const saveDeviceName = async (sessionId: string): Promise<void> => {
    const deviceName = editingDeviceName.trim();
    if (!deviceName) {
      setError("设备名称不能为空。");
      return;
    }
    setRenamingDeviceId(sessionId);
    setError(null);
    try {
      const response = await fetch("/api/auth/devices/" + encodeURIComponent(sessionId), {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Bridge-Action-Token": await getActionToken(),
        },
        credentials: "same-origin",
        body: JSON.stringify({ deviceName }),
      });
      const body = await response.json() as ApiError;
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign("/");
          return;
        }
        throw new Error(body.error || "设备名称保存失败（" + response.status + "）");
      }
      setEditingDeviceId(null);
      setEditingDeviceName("");
      await loadManagement();
      setNotice("名称 / 备注已更新。");
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setRenamingDeviceId(null);
    }
  };

  const extendDevice = async (device: WebAuthDevice): Promise<void> => {
    const profile = describeDevice(device);
    if (!window.confirm(`将“${profile.name} · ${profile.browser}”（#${profile.shortId}）的授权延期一年？`)) return;
    setNotice(null);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/devices/" + encodeURIComponent(device.sessionId) + "/extend", {
        method: "POST",
        headers: { Accept: "application/json", "X-Bridge-Action-Token": await getActionToken() },
        credentials: "same-origin",
      });
      const body = await response.json() as { expiresAt?: string } & ApiError;
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign("/");
          return;
        }
        throw new Error(body.error || "设备授权延期失败（" + response.status + "）");
      }
      await loadManagement();
      setNotice(body.expiresAt ? `授权已延期至 ${formatDate(body.expiresAt)}。` : "授权已延期一年。");
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async (): Promise<void> => {
    const count = devices.filter((device) => deviceAuthorizationState(device) === "active").length;
    if (!window.confirm(`撤销全部 ${count} 份有效授权？当前设备也会退出，所有设备都需要重新配对。`)) return;
    setNotice(null);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/revoke-all", {
        method: "POST",
        headers: { Accept: "application/json", "X-Bridge-Action-Token": await getActionToken() },
        credentials: "same-origin",
      });
      const body = await response.json() as ApiError;
      if (!response.ok) throw new Error(body.error || "撤销失败（" + response.status + "）");
      await clearLocalDraftsAfterDeviceRevocation();
      window.location.assign("/");
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevices = async (targets: WebAuthDevice[]): Promise<void> => {
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let succeeded = 0;
    const failures: string[] = [];
    try {
      const actionToken = await getActionToken();
      // A single-device self-revocation is explicit; bulk selection excludes it.
      for (const device of [...targets].sort((a, b) => Number(a.current) - Number(b.current))) {
        try {
          const response = await fetch("/api/auth/devices/" + encodeURIComponent(device.sessionId) + "/revoke", {
            method: "POST",
            headers: { Accept: "application/json", "X-Bridge-Action-Token": actionToken },
            credentials: "same-origin",
          });
          if (response.status === 401) { window.location.assign("/"); return; }
          if (!response.ok) throw new Error("revoke failed");
          succeeded++;
          if (device.current) {
            await clearLocalDraftsAfterDeviceRevocation();
            window.location.assign("/");
            return;
          }
        } catch { const profile = describeDevice(device); failures.push(`${profile.name} #${profile.shortId}`); }
      }
      await loadManagement();
      if (succeeded) setNotice(`已撤销 ${succeeded} 份授权，可在历史记录中查看。`);
      if (failures.length) setError(`${failures.length} 份授权未能撤销，请刷新后重试：${failures.slice(0, 4).join("、")}${failures.length > 4 ? "…" : ""}`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "撤销失败，请重试。");
    } finally { setBusy(false); }
  };

  const beginRename = (device: WebAuthDevice): void => {
    setNotice(null);
    setEditingDeviceId(device.sessionId);
    setEditingDeviceName(device.deviceName);
    setError(null);
  };

  const cancelRename = (): void => {
    setEditingDeviceId(null);
    setEditingDeviceName("");
  };

  const editingDevice = editingDeviceId
    ? devices.find((device) => device.sessionId === editingDeviceId) ?? null
    : null;

  return (
    <main className="device-management-page device-management-compact">
      {error ? <div className="pairing-error device-page-alert" role="alert">{error}</div> : null}
      {notice ? <div className="pairing-success device-page-alert" role="status">{notice}</div> : null}

      <div className="device-management-grid">
        <DeviceAuthorizations devices={devices} loading={loading} busy={busy || renamingDeviceId !== null} onRefresh={loadManagement} onRename={beginRename} onExtend={extendDevice} onRevoke={revokeDevices} />

        <section className="device-side-panel">
          <div className="device-info-section">
            <h2>添加新设备</h2>
            <div className="device-pairing-actions">
              <button className="primary" type="button" disabled={pairingBusy} onClick={() => void generatePairingQr()}>
                {pairingBusy ? "正在生成…" : pairing ? "重新生成二维码" : "生成二维码"}
              </button>
              {pairing ? <span className="device-pairing-expiry">有效期至 {formatDate(pairing.expiresAt)}</span> : null}
            </div>
            {pairing ? (
              <div className="device-qr-card">
                <div className="device-qr-frame">
                  {qrDataUrl ? <img src={qrDataUrl} alt="设备配对二维码" /> : <span>二维码生成中…</span>}
                </div>
                <div className="device-qr-copy">
                  <strong>扫码或打开链接配对</strong>
                  <span>二维码和链接 5 分钟有效，配对成功后立即失效。</span>
                  <div className="device-pairing-link">
                    <p>没有扫码功能？在新设备的浏览器中打开此链接：</p>
                    <div className="device-pairing-link-row">
                      <a href={pairing.pairingUrl} target="_blank" rel="noreferrer" onClick={(event) => {
                        if (!isMobileApp()) return;
                        event.preventDefault();
                        void openBridgeExternal(pairing.pairingUrl).catch((failure: unknown) => {
                          setPairingError(failure instanceof Error ? failure.message : "链接打开失败。");
                        });
                      }}>
                        {pairing.pairingUrl}
                      </a>
                      <button
                        className="secondary device-pairing-link-copy"
                        type="button"
                        onClick={() => void copyPairingLink()}
                        aria-label={pairingLinkCopied ? "配对链接已复制" : "复制配对链接"}
                        title={pairingLinkCopied ? "已复制" : "复制配对链接"}
                      >
                        {pairingLinkCopied ? (
                          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>
                        ) : (
                          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                        )}
                      </button>
                    </div>
                    {pairingLinkCopyError ? <p className="device-pairing-link-error" role="status">{pairingLinkCopyError}</p> : null}
                  </div>
                </div>
              </div>
            ) : (
              <div className="device-qr-placeholder">点击“生成二维码”，在这里显示新设备的配对二维码。</div>
            )}
            {pairingError ? <p className="device-command-error" role="status">{pairingError}</p> : null}
            <details className="device-cli-fallback">
              <summary>也可在 Mac 终端生成</summary>
              <p>终端命令会使用正式数据库，并自动检测局域网 IP 和服务端口。</p>
              <div className="device-command-row">
                <code className="device-command">{PAIRING_COMMAND}</code>
                <button
                  className="secondary device-command-copy"
                  type="button"
                  onClick={() => void copyPairingCommand()}
                >
                  {pairingCommandCopied ? "已复制" : "复制命令"}
                </button>
              </div>
              {pairingCommandError ? <p className="device-command-error" role="status">{pairingCommandError}</p> : null}
            </details>
          </div>
          <details className="device-danger-section">
            <summary>危险操作 · 撤销所有访问</summary>
            <div className="device-danger-content">
              <p>撤销所有已配对设备的会话。当前页面也会立即失去访问权限。</p>
              <button className="danger" type="button" disabled={busy || !devices.some((device) => deviceAuthorizationState(device) === "active")} onClick={() => void revokeAll()}>
                撤销所有授权
              </button>
            </div>
          </details>
        </section>
      </div>

      {editingDevice ? (
        <div
          className="device-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancelRename();
          }}
        >
          <section className="device-name-modal" role="dialog" aria-modal="true" aria-labelledby="device-name-modal-title">
            <div className="device-modal-heading">
              <div>
                <h2 id="device-name-modal-title">名称 / 备注</h2>
              </div>
              <button className="secondary device-modal-close" type="button" aria-label="关闭" onClick={cancelRename}>
                ×
              </button>
            </div>
            <p className="device-modal-description">{describeDevice(editingDevice).name} · {describeDevice(editingDevice).browser} · #{describeDevice(editingDevice).shortId}</p>
            <form onSubmit={(event) => {
              event.preventDefault();
              void saveDeviceName(editingDevice.sessionId);
            }}>
              <label className="device-name-field" htmlFor="device-name-modal-input">
                名称 / 备注
                <input
                  id="device-name-modal-input"
                  value={editingDeviceName}
                  maxLength={80}
                  placeholder="例如：主力华为 · App"
                  autoFocus
                  onChange={(event) => setEditingDeviceName(event.target.value)}
                />
              </label>
              <div className="device-modal-actions">
                <button className="secondary" type="button" disabled={renamingDeviceId !== null} onClick={cancelRename}>
                  取消
                </button>
                <button className="primary" type="submit" disabled={renamingDeviceId !== null}>
                  {renamingDeviceId ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function formatDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "未知时间"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function redactPairingSecrets(value: string): string {
  return value.replace(/#pair=[^\s&"'}]+/gi, "#pair=<已隐藏>");
}

function AuthShell({ children }: { children: ReactNode }): ReactElement {
  return <main className="pairing-page">{children}</main>;
}
