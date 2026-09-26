import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import * as QRCode from "qrcode";

const PAIRING_COMMAND = "feishu-codex-bridge web:pair";

interface AuthStatus {
  authenticated: boolean;
  local: boolean;
  activeSessionCount: number | null;
  pairingAvailable: boolean;
  pairingExpiresAt: number | null;
}

interface ApiError {
  error?: string;
}

interface WebAuthDevice {
  sessionId: string;
  current: boolean;
  deviceName: string;
  userAgent: string | null;
  remoteAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface PairingInfo {
  pairingUrl: string;
  expiresAt: number;
}

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pairingClaimRef = useRef<Promise<AuthStatus> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadAuthStatus(pairingClaimRef)
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : String(requestError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <AuthShell><div className="pairing-error">{error}</div></AuthShell>;
  if (!status) return <AuthShell><div className="route-loading">正在检查访问权限…</div></AuthShell>;
  if (status.authenticated) return <>{children}</>;
  return <PairingClaim status={status} />;
}

async function loadAuthStatus(
  pairingClaimRef?: { current: Promise<AuthStatus> | null },
): Promise<AuthStatus> {
  const statusResponse = await fetch("/api/auth/status", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  const statusBody = await statusResponse.json() as AuthStatus & ApiError;
  if (!statusResponse.ok) {
    throw new Error("鉴权状态读取失败（" + statusResponse.status + "）");
  }
  if (statusBody.authenticated) return statusBody;

  const code = readPairingCodeFromHash();
  if (!code) return statusBody;
  if (pairingClaimRef?.current) return pairingClaimRef.current;

  const claimPromise = (async (): Promise<AuthStatus> => {
    const claimResponse = await fetch("/api/auth/pairing/claim", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify({ code }),
    });
    const claimBody = await claimResponse.json() as ApiError;
    if (!claimResponse.ok) {
      throw new Error(claimBody.error || "二维码配对失败（" + claimResponse.status + "）");
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return loadAuthStatus();
  })();

  if (pairingClaimRef) {
    pairingClaimRef.current = claimPromise;
    try {
      return await claimPromise;
    } finally {
      if (pairingClaimRef.current === claimPromise) pairingClaimRef.current = null;
    }
  }
  return claimPromise;
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
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [devices, setDevices] = useState<WebAuthDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingLogs, setPairingLogs] = useState<string[]>([]);
  const [pairingCommandError, setPairingCommandError] = useState<string | null>(null);
  const [pairingCommandCopied, setPairingCommandCopied] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingDeviceName, setEditingDeviceName] = useState("");
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);
  const qrLoggedPairingUrlRef = useRef<string | null>(null);

  const appendPairingLog = (message: string): void => {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setPairingLogs((previous) => [...previous, `[${time}] ${redactPairingSecrets(message)}`].slice(-80));
  };

  const loadManagement = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, devicesResponse] = await Promise.all([
        loadAuthStatus(),
        fetch("/api/auth/devices", {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        }),
      ]);
      const body = await devicesResponse.json() as { devices?: WebAuthDevice[] } & ApiError;
      if (!devicesResponse.ok) {
        throw new Error(body.error || "设备列表读取失败（" + devicesResponse.status + "）");
      }
      setStatus(nextStatus);
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
    if (!pairing) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    setQrDataUrl(null);
    if (qrLoggedPairingUrlRef.current !== pairing.pairingUrl) {
      qrLoggedPairingUrlRef.current = pairing.pairingUrl;
      appendPairingLog("开始在浏览器生成二维码：" + describePairingUrl(pairing.pairingUrl));
    }
    void QRCode.toDataURL(pairing.pairingUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
          appendPairingLog("浏览器二维码渲染完成。");
        }
      })
      .catch((qrError: unknown) => {
        if (!cancelled) {
          const message = qrError instanceof Error ? qrError.message : String(qrError);
          appendPairingLog("浏览器二维码渲染失败：" + message);
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

  const copyPairingLogs = async (): Promise<void> => {
    try {
      await copyTextToClipboard(pairingLogs.join("\n"));
      appendPairingLog("诊断日志已复制到剪贴板。");
    } catch (copyError: unknown) {
      const message = copyError instanceof Error ? copyError.message : String(copyError);
      appendPairingLog("诊断日志复制失败：" + message);
      setPairingError(redactPairingSecrets(message));
    }
  };

  const generatePairingQr = async (): Promise<void> => {
    setPairingBusy(true);
    setPairingError(null);
    setPairing(null);
    appendPairingLog("开始请求生成配对二维码。");
    appendPairingLog("当前页面 origin：" + window.location.origin);
    appendPairingLog("请求 POST /api/auth/pairing/start。");
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/auth/pairing/start", {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") || "未知";
      appendPairingLog(`收到 HTTP ${response.status} ${response.statusText || ""}，Content-Type: ${contentType}`);
      const responseText = await response.text();
      let body: { pairingUrl?: string; expiresAt?: number } & ApiError;
      try {
        body = JSON.parse(responseText) as { pairingUrl?: string; expiresAt?: number } & ApiError;
      } catch {
        appendPairingLog("响应不是有效 JSON：" + responseText.slice(0, 300));
        throw new Error("服务端没有返回有效的 JSON 响应。");
      }
      if (!response.ok) {
        appendPairingLog("服务端返回错误：" + (body.error || "未提供错误信息"));
        if (response.status === 404) {
          appendPairingLog("服务端未加载 /api/auth/pairing/start 路由；请确认 Vite 代理目标已重启并使用当前版本。");
        }
        if (response.status === 401) {
          appendPairingLog("当前管理会话未被服务端接受，即将返回首页重新检查鉴权。");
          window.location.assign("/");
          return;
        }
        throw new Error(body.error || "二维码生成失败（" + response.status + "）");
      }
      if (typeof body.pairingUrl !== "string" || typeof body.expiresAt !== "number") {
        throw new Error("二维码响应不完整。");
      }
      const serverPairingUrl = new URL(body.pairingUrl);
      appendPairingLog("服务端配对地址：" + describePairingUrl(serverPairingUrl.toString()));
      const currentPairingUrl = new URL("/", window.location.origin);
      currentPairingUrl.hash = serverPairingUrl.hash;
      appendPairingLog("实际二维码地址：" + describePairingUrl(currentPairingUrl.toString()));
      setPairing({ pairingUrl: currentPairingUrl.toString(), expiresAt: body.expiresAt });
    } catch (requestError: unknown) {
      const message = requestError instanceof DOMException && requestError.name === "AbortError"
        ? "请求超过 10 秒没有返回。"
        : requestError instanceof Error ? requestError.message : String(requestError);
      appendPairingLog("二维码生成请求失败：" + message);
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
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setRenamingDeviceId(null);
    }
  };

  const revokeAll = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/revoke-all", {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const body = await response.json() as ApiError;
      if (!response.ok) throw new Error(body.error || "撤销失败（" + response.status + "）");
      window.location.assign("/");
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (sessionId: string, current: boolean): Promise<void> => {
    if (!window.confirm("确认撤销这台设备的访问权限？")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/devices/" + encodeURIComponent(sessionId) + "/revoke", {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const body = await response.json() as ApiError;
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign("/");
          return;
        }
        throw new Error(body.error || "设备撤销失败（" + response.status + "）");
      }
      if (current) {
        window.location.assign("/");
        return;
      }
      await loadManagement();
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const beginRename = (device: WebAuthDevice): void => {
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
    <main className="device-management-page">
      {error ? <div className="pairing-error device-page-alert" role="alert">{error}</div> : null}

      <div className="device-management-grid">
        <section className="device-list-panel">
          <div className="device-panel-heading">
            <div>
              <p className="device-panel-kicker">PAIRED DEVICES</p>
              <h2>已配对设备</h2>
            </div>
            <div className="device-panel-heading-actions">
              <span>{status?.activeSessionCount ?? devices.length}</span>
              <button className="secondary" type="button" disabled={loading} onClick={() => void loadManagement()}>
                刷新
              </button>
            </div>
          </div>
          {loading ? <div className="device-empty-state">正在读取设备状态…</div> : null}
          {!loading && devices.length === 0 ? (
            <div className="device-empty-state">
              <strong>还没有配对设备</strong>
              <span>在下方生成二维码，再用新设备扫描完成配对。</span>
            </div>
          ) : null}
          <div className="device-list">
            {devices.map((device) => (
              <article className="device-row" key={device.sessionId}>
                <div className="device-row-main">
                  <div className="device-row-title">
                    <strong>{device.deviceName}</strong>
                    <span className="device-live-dot">已授权</span>
                    {device.current ? <span className="device-current-badge">当前设备</span> : null}
                  </div>
                  <p>{device.userAgent || "浏览器设备"} · {device.remoteAddress || "未知地址"}</p>
                  <small>
                    首次配对 {formatDate(device.createdAt)} · 最近访问 {formatDate(device.lastSeenAt)} · 到期 {formatDate(device.expiresAt)}
                  </small>
                </div>
                <div className="device-row-actions">
                  {editingDeviceId !== device.sessionId ? (
                    <button className="secondary device-row-action-button device-rename-button" type="button" disabled={busy} onClick={() => beginRename(device)}>
                      设置名称
                    </button>
                  ) : null}
                  <button
                    className="device-row-action-button device-revoke-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void revokeDevice(device.sessionId, device.current)}
                  >
                    撤销
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="device-side-panel">
          <div className="device-info-section">
            <p className="device-panel-kicker">PAIRING</p>
            <h2>添加新设备</h2>
            <p>在管理端生成一次性二维码，让新设备扫码即可完成配对。二维码只对当前已授权的管理页面开放。</p>
            <div className="device-pairing-actions">
              <button className="primary" type="button" disabled={pairingBusy} onClick={() => void generatePairingQr()}>
                {pairingBusy ? "正在生成…" : pairing ? "重新生成二维码" : "生成二维码"}
              </button>
              {pairing ? <span className="device-pairing-expiry">有效期至 {formatDate(pairing.expiresAt)}</span> : null}
            </div>
            {pairing ? (
              <div className="device-qr-card">
                <div className="device-qr-frame">
                  {qrDataUrl ? <img src={qrDataUrl} alt="添加新设备二维码" /> : <span>二维码生成中…</span>}
                </div>
                <div className="device-qr-copy">
                  <strong>请使用新设备扫码</strong>
                  <span>5 分钟有效，扫码成功后立即失效。</span>
                </div>
              </div>
            ) : (
              <div className="device-qr-placeholder">点击“生成二维码”，在这里显示新设备的配对二维码。</div>
            )}
            {pairingError ? <p className="device-command-error" role="status">{pairingError}</p> : null}
            {pairingLogs.length > 0 ? (
              <details className="device-diagnostic-log" open>
                <summary>二维码诊断日志（{pairingLogs.length}）</summary>
                <div className="device-diagnostic-toolbar">
                  <span>配对码已脱敏，不会出现在日志中。</span>
                  <div>
                    <button className="secondary" type="button" onClick={() => void copyPairingLogs()}>
                      复制日志
                    </button>
                    <button className="secondary" type="button" onClick={() => setPairingLogs([])}>
                      清空
                    </button>
                  </div>
                </div>
                <pre>{pairingLogs.join("\n")}</pre>
              </details>
            ) : null}
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
              <button className="danger" type="button" disabled={busy || devices.length === 0} onClick={() => void revokeAll()}>
                撤销所有手机
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
                <p className="device-panel-kicker">DEVICE NAME</p>
                <h2 id="device-name-modal-title">设置设备名称</h2>
              </div>
              <button className="secondary device-modal-close" type="button" aria-label="关闭" onClick={cancelRename}>
                ×
              </button>
            </div>
            <p className="device-modal-description">为“{editingDevice.deviceName}”设置一个方便识别的名称或备注。</p>
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
                  autoFocus
                  onChange={(event) => setEditingDeviceName(event.target.value)}
                />
              </label>
              <div className="device-modal-actions">
                <button className="secondary" type="button" disabled={renamingDeviceId !== null} onClick={cancelRename}>
                  取消
                </button>
                <button className="primary" type="submit" disabled={renamingDeviceId !== null}>
                  {renamingDeviceId ? "保存中…" : "保存名称"}
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

function describePairingUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.origin + url.pathname + "#pair=<已隐藏>";
  } catch {
    return redactPairingSecrets(value);
  }
}

function PairingClaim({
  status,
}: {
  status: AuthStatus;
}): ReactElement {
  return (
    <AuthShell>
      <section className="pairing-card">
        <p className="pairing-eyebrow">DEVICE PAIRING</p>
        <h1>需要配对</h1>
        <p className="pairing-description">
          这是一个受保护的本地终端页面。请在运行 Bridge 的 Mac 命令行执行 web:pair，然后用手机扫描终端中的二维码。
        </p>
        <div className="pairing-code-panel">
          <span>当前状态</span>
          <strong>{status.pairingAvailable ? "等待扫码" : "等待 CLI 配对"}</strong>
          <div className="pairing-code-meta">
            <span>二维码 5 分钟有效</span>
            <span>只能使用一次</span>
          </div>
        </div>
        <p className="pairing-hint">二维码扫描成功后，页面会自动进入 Bridge。</p>
      </section>
    </AuthShell>
  );
}

function AuthShell({ children }: { children: ReactNode }): ReactElement {
  return <main className="pairing-page">{children}</main>;
}
