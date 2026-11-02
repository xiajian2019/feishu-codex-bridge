import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import {
  listNativeSshOptions, onNativeSshWorkspaceClosed, openNativeSshWorkspace, openNativeTerminal,
  type SshOptions, type SshProfileOption,
} from "./ssh-connectbot-native.js";
import { getMobileConnection } from "./mobile-runtime.js";
import { BRIDGE_GLOBAL_MAC_HOST } from "./bridge-global-config.js";

const EMPTY_OPTIONS: SshOptions = { profiles: [], keys: [] };

function profileOptionLabel(profile: SshProfileOption): string {
  const address = `${profile.username}@${profile.host}`;
  const label = profile.label.trim();
  return !label || label.toLowerCase() === address.toLowerCase() ? address : `${label} · ${address}`;
}

/** Connection metadata stays in the native store; private keys never enter the WebView. */
export default function MobileSshLogin(): ReactElement {
  const [options, setOptions] = useState<SshOptions>(EMPTY_OPTIONS);
  const [profileId, setProfileId] = useState("");
  const [host, setHost] = useState(BRIDGE_GLOBAL_MAC_HOST);
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [keyId, setKeyId] = useState("");
  const [password, setPassword] = useState("");
  const [startupCommand, setStartupCommand] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formTouched = useRef(false);
  const loadedInitialOptions = useRef(false);

  const refreshOptions = useCallback(async (): Promise<void> => {
    try {
      const next = await listNativeSshOptions();
      setOptions(next);
      if (!loadedInitialOptions.current) {
        loadedInitialOptions.current = true;
        const recent = next.profiles[0];
        if (recent && !formTouched.current) {
          setProfileId(recent.id); setHost(recent.host); setPort(String(recent.port));
          setUsername(recent.username); setKeyId(recent.keyId); setStartupCommand(recent.startupCommand);
          setSettingsOpen(!recent.keyId || !next.keys.some((key) => key.id === recent.keyId));
        }
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取已保存的 SSH 主机。"); }
  }, []);
  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | undefined;
    void refreshOptions();
    void onNativeSshWorkspaceClosed(() => { if (!disposed) void refreshOptions(); })
      .then((listener) => { if (disposed) void listener.remove(); else removeListener = () => { void listener.remove(); }; })
      .catch(() => { /* listOptions reports platforms without SSH support */ });
    return () => { disposed = true; removeListener?.(); };
  }, [refreshOptions]);

  const selectProfile = (profile: SshProfileOption | undefined): void => {
    formTouched.current = true;
    setProfileId(profile?.id ?? "");
    setHost(profile?.host ?? "");
    setPort(String(profile?.port ?? 22));
    setUsername(profile?.username ?? "");
    setKeyId(profile?.keyId ?? "");
    setStartupCommand(profile?.startupCommand ?? "");
    setSettingsOpen(!profile?.keyId || !options.keys.some((key) => key.id === profile.keyId));
    setPassword("");
    setError(null);
  };

  const openWorkspace = async (mode?: "manage"): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await openNativeSshWorkspace({
        defaultHost: BRIDGE_GLOBAL_MAC_HOST,
        ...(getMobileConnection()?.server ? { bridgeServerOrigin: getMobileConnection()!.server } : {}),
        ...(mode ? { mode } : {}),
      });
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开 SSH 工作区。"); }
    finally { setBusy(false); }
  };

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setSettingsOpen(true); setError("端口必须为 1–65535 之间的整数。"); return;
    }
    if (keyId && !options.keys.some((key) => key.id === keyId)) {
      setSettingsOpen(true); setError("关联的密钥不存在，请重新选择或管理密钥。"); return;
    }
    setBusy(true); setError(null);
    try {
      await openNativeTerminal({
        host: host.trim(), port: parsedPort, username: username.trim(),
        ...(getMobileConnection()?.server ? { bridgeServerOrigin: getMobileConnection()!.server } : {}),
        ...(profileId ? { profileId } : {}), ...(keyId ? { keyId } : {}),
        ...(!keyId && password ? { password } : {}),
        ...(startupCommand.trim() ? { startupCommand: startupCommand.trim() } : {}),
      });
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开 SSH 工作区。");
    } finally { setBusy(false); }
  };

  return <section className="mobile-ssh-login" aria-label="SSH 登录">
    <button type="button" className="mobile-connect-secondary mobile-ssh-continue" disabled={busy} onClick={() => void openWorkspace()}>继续已有 SSH 会话</button>
    <form onChange={() => { formTouched.current = true; }} onSubmit={(event) => void connect(event)}>
      {options.profiles.length > 0 && <div className="mobile-ssh-field">
        <label htmlFor="ssh-profile">已保存的主机</label>
        <select id="ssh-profile" value={profileId} disabled={busy} onChange={(event) => selectProfile(options.profiles.find((profile) => profile.id === event.target.value))}>
          <option value="">输入新主机</option>
          {options.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profileOptionLabel(profile)}</option>)}
        </select>
      </div>}
      {profileId && <button type="button" className="mobile-ssh-settings-toggle" aria-expanded={settingsOpen} aria-controls={settingsOpen ? "mobile-ssh-settings" : undefined}
        onClick={() => setSettingsOpen((open) => !open)}>连接设置 <span>{settingsOpen ? "收起" : "展开"}</span></button>}
      {(settingsOpen || !profileId) && <div id="mobile-ssh-settings" className="mobile-ssh-settings">
        <div className="mobile-ssh-row mobile-ssh-host-row">
          <div className="mobile-ssh-field"><label htmlFor="ssh-host">主机</label><input id="ssh-host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="mac.local 或 IP 地址" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={busy} /></div>
          <div className="mobile-ssh-field"><label htmlFor="ssh-port">端口</label><input id="ssh-port" value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required disabled={busy} /></div>
        </div>
        <div className="mobile-ssh-row mobile-ssh-auth-row">
          <div className="mobile-ssh-field"><label htmlFor="ssh-user">用户名</label><input id="ssh-user" value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" required disabled={busy} /></div>
          <div className="mobile-ssh-field">
            <label htmlFor="ssh-key">登录方式</label>
            <select id="ssh-key" value={keyId} onChange={(event) => { setKeyId(event.target.value); setPassword(""); }} disabled={busy}>
              <option value="">密码</option>
              {keyId && !options.keys.some((key) => key.id === keyId) && <option value={keyId}>关联的密钥不可用</option>}
              {options.keys.map((key) => <option key={key.id} value={key.id}>{key.nickname} · {key.algorithm}</option>)}
            </select>
          </div>
        </div>
        {!keyId && <div className="mobile-ssh-field"><label htmlFor="ssh-password">密码</label><input id="ssh-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" disabled={busy} /></div>}
      </div>}
      <details className="mobile-ssh-advanced">
        <summary>高级设置与主机管理</summary>
        <div className="mobile-ssh-field">
          <label htmlFor="ssh-startup">连接后命令（可选）</label>
          <input id="ssh-startup" value={startupCommand} onChange={(event) => setStartupCommand(event.target.value)} disabled={busy} />
        </div>
        <button type="button" className="mobile-connect-secondary" disabled={busy} onClick={() => void openWorkspace("manage")}>管理主机和密钥</button>
      </details>
      {error && <p className="mobile-connect-error" role="alert">{error}</p>}
      <div className="mobile-connect-actions"><button type="submit" className="mobile-connect-primary" disabled={busy || !host.trim() || !username.trim()}>{busy ? "正在打开…" : "登录并打开终端"}</button></div>
    </form>
    <p className="mobile-connect-help">SSH 直连无需 Bridge 配对。私钥保存在设备的原生密钥库中；连接状态和主机指纹在工作区显示。</p>
  </section>;
}
