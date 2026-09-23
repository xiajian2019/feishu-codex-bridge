import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

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

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pairingClaimRef = useRef<string | null>(null);

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
  pairingClaimRef?: { current: string | null },
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
  if (pairingClaimRef?.current === code) return statusBody;
  if (pairingClaimRef) pairingClaimRef.current = code;
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
    if (pairingClaimRef?.current === code) pairingClaimRef.current = null;
    throw new Error(claimBody.error || "二维码配对失败（" + claimResponse.status + "）");
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return loadAuthStatus();
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

export function PairingAdmin(): ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [devices, setDevices] = useState<WebAuthDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <main className="device-management-page">
      <header className="device-page-header">
        <div>
          <p className="device-page-eyebrow">SECURITY / DEVICES</p>
          <p className="device-page-subtitle">
            管理可以访问 Bridge 和 tmux 终端的已配对设备。
          </p>
        </div>
      </header>

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
              <span>在 Mac 终端运行 web:pair，再用手机扫描二维码。</span>
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
                  <button
                    className="device-revoke-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void revokeDevice(device.sessionId, device.current)}
                >
                  撤销
                </button>
              </article>
            ))}
          </div>
        </section>

        <aside className="device-side-panel">
          <section className="device-info-section">
            <p className="device-panel-kicker">PAIRING</p>
            <h2>添加新设备</h2>
            <p>配对码不会出现在网页中，只会显示在 Mac 的终端二维码里。</p>
            <code className="device-command">bun run web:pair -- --url http://内网IP:端口/</code>
            <p>二维码 5 分钟有效，使用一次后立即失效。过期后重新运行命令即可刷新。</p>
          </section>
          <details className="device-danger-section">
            <summary>危险操作 · 撤销所有访问</summary>
            <div className="device-danger-content">
              <p>撤销所有已配对设备的会话。当前页面也会立即失去访问权限。</p>
              <button className="danger" type="button" disabled={busy || devices.length === 0} onClick={() => void revokeAll()}>
                撤销所有手机
              </button>
            </div>
          </details>
        </aside>
      </div>
    </main>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "未知时间"
    : date.toLocaleString("zh-CN", { hour12: false });
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
