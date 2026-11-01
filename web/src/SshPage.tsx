import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";

import {
  addListener,
  approveHostKey,
  connect,
  discardPrivateKey,
  disconnect,
  pickPrivateKey,
  resize,
  send,
} from "./ssh-native.js";
import {
  decodeBase64,
  encodeBase64,
  SSH_DEFAULT_HOST,
  normalizeSshConnectRequest,
  normalizeSshDimensions,
  SSH_DEFAULT_COLS,
  SSH_DEFAULT_PORT,
  SSH_DEFAULT_ROWS,
  type BridgeSSHConnectionState,
  type BridgeSSHHostKeyEvent,
  type BridgeSSHPrivateKeyInfo,
} from "./ssh-protocol.js";
import { copyMobileText, isMobileApp } from "./mobile-runtime.js";
import { bindMobileTerminalTouch, type TerminalSelectionDisplay } from "./terminal-touch.js";
import { getTmuxTerminalTheme } from "./tmux-terminal-theme.js";
import { useTheme } from "./theme.js";
import { openNativeSshWorkspace, openNativeTerminal } from "./ssh-connectbot-native.js";

import "./ssh.css";

const ACTIVE_STATES: readonly BridgeSSHConnectionState[] = [
  "connecting",
  "awaiting-host-key",
  "connected",
  "reconnecting",
  "disconnecting",
];

const STATUS_LABELS: Record<BridgeSSHConnectionState, string> = {
  idle: "未连接",
  connecting: "连接中",
  "awaiting-host-key": "等待确认主机指纹",
  connected: "已连接",
  reconnecting: "重新连接中",
  disconnecting: "断开中",
  disconnected: "已断开",
  exited: "会话已退出",
  error: "连接错误",
};

function createSessionId(): string {
  try {
    return `ssh-${crypto.randomUUID()}`;
  } catch {
    return `ssh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isActiveState(state: BridgeSSHConnectionState): boolean {
  return ACTIVE_STATES.includes(state);
}

function BrowserOnlyMessage(): ReactElement {
  return (
    <main className="ssh-page ssh-page-browser-only">
      <section className="ssh-browser-card" role="status">
        <div className="ssh-browser-mark" aria-hidden="true">⌁</div>
        <p className="ssh-eyebrow">SSH WORKSPACE</p>
        <h1>SSH 仅支持移动 App</h1>
        <p>
          SSH 连接由 Capacitor 原生插件直接建立。请在 Bridge Android／iOS App 中打开此页面；浏览器不会模拟或代理 SSH 连接。
        </p>
      </section>
    </main>
  );
}

export function SshPage(): ReactElement {
  return isMobileApp() ? <MobileSshPage /> : <BrowserOnlyMessage />;
}

function MobileSshPage(): ReactElement {
  const [host, setHost] = useState(SSH_DEFAULT_HOST);
  const [port, setPort] = useState(String(SSH_DEFAULT_PORT));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [startupCommand, setStartupCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openWorkspace = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await openNativeSshWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开 SSH 主机管理。请确认当前运行的是 Android App。");
    } finally {
      setBusy(false);
    }
  };

  const launch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await openNativeTerminal({
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        ...(password ? { password } : {}),
        ...(startupCommand.trim() ? { startupCommand: startupCommand.trim() } : {}),
      });
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开原生 SSH 工作区。请确认当前运行的是 Android App。");
    } finally {
      setBusy(false);
    }
  };

  return <main className="ssh-page ssh-page-native-launcher">
    <section className="ssh-native-launcher-card">
      <p className="ssh-eyebrow">SSH WORKSPACE</p>
      <h1>SSH</h1>
      <p className="ssh-native-launcher-description">登录你的 Mac 后查看 tmux Session，并在手机上与其中的 Codex 对话。SSH、终端输入、滚动、选择、快捷键和私钥认证由 Android 原生 ConnectBot 模块处理。</p>
      <button className="ssh-primary-action ssh-native-workspace-action" type="button" disabled={busy} onClick={() => { void openWorkspace(); }}>管理主机和密钥</button>
      {error ? <p className="ssh-error" role="alert">{error}</p> : null}
      <form className="ssh-native-launcher-form" onSubmit={(event) => { void launch(event); }}>
        <label>主机<input value={host} onChange={(event) => setHost(event.target.value)} placeholder="mac.local 或 IP 地址" autoComplete="url" required /></label>
        <div className="ssh-native-launcher-row">
          <label>端口<input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required /></label>
          <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
        </div>
        <label>密码（可选）<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="优先使用原生私钥认证" /></label>
        <label>连接后命令（高级，可选）<input value={startupCommand} onChange={(event) => setStartupCommand(event.target.value)} placeholder="例如 source ~/.zshrc" /></label>
        <button className="ssh-primary-action" type="submit" disabled={busy || !host.trim() || !username.trim()}>{busy ? "正在打开…" : "打开原生 SSH"}</button>
      </form>
      <p className="ssh-credential-note">SSH 连接是手机到 Mac 的独立登录通道。登录后由同一连接读取 tmux Session、打开终端并按需传输文件；切换 Session 不会重新登录。私钥和私钥口令留在原生页面，不进入 React 或 Bridge。</p>
    </section>
  </main>;
}

const SSH_QUICK_KEYS: ReadonlyArray<{ label: string; value: string; ariaLabel?: string }> = [
  { label: "Esc", value: "\u001b" },
  { label: "Tab", value: "\t" },
  { label: "Ctrl+C", value: "\u0003" },
  { label: "Ctrl+D", value: "\u0004" },
  { label: "Ctrl+L", value: "\u000c" },
  { label: "↑", value: "\u001b[A", ariaLabel: "上方向键" },
  { label: "↓", value: "\u001b[B", ariaLabel: "下方向键" },
  { label: "←", value: "\u001b[D", ariaLabel: "左方向键" },
  { label: "→", value: "\u001b[C", ariaLabel: "右方向键" },
];

const SSH_PRIVATE_KEY_PICKER_ERROR = "私钥选择失败，请重试。";

export function LegacyReactXtermSshPage(): ReactElement {
  const { resolvedTheme } = useTheme();
  const sessionId = useMemo(createSessionId, []);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const pendingOutputRef = useRef<Uint8Array[]>([]);
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);
  const resolvedThemeRef = useRef(resolvedTheme);
  const connectionStateRef = useRef<BridgeSSHConnectionState>("idle");
  const nativeSessionActiveRef = useRef(false);
  const operationPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const hostKeyRef = useRef<BridgeSSHHostKeyEvent | null>(null);
  const privateKeyIdRef = useRef("");

  const [host, setHost] = useState(SSH_DEFAULT_HOST);
  const [port, setPort] = useState(String(SSH_DEFAULT_PORT));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKeyInfo, setPrivateKeyInfo] = useState<BridgeSSHPrivateKeyInfo | null>(null);
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
  const [startupCommand, setStartupCommand] = useState("");
  const [connectionState, setConnectionState] = useState<BridgeSSHConnectionState>("idle");
  const [hostKey, setHostKey] = useState<BridgeSSHHostKeyEvent | null>(null);
  const [terminalSelection, setTerminalSelection] = useState<TerminalSelectionDisplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isApprovingHostKey, setIsApprovingHostKey] = useState(false);

  const updateConnectionState = useCallback((state: BridgeSSHConnectionState): void => {
    connectionStateRef.current = state;
    if (mountedRef.current) setConnectionState(state);
  }, []);

  const setHostKeyPrompt = useCallback((event: BridgeSSHHostKeyEvent | null): void => {
    hostKeyRef.current = event;
    if (mountedRef.current) setHostKey(event);
  }, []);

  const clearPrivateKeyCredentials = useCallback((): void => {
    const keyId = privateKeyIdRef.current;
    privateKeyIdRef.current = "";
    if (keyId) void discardPrivateKey({ keyId }).catch(() => {});
    if (!mountedRef.current) return;
    setPrivateKeyInfo(null);
    setPrivateKeyPassphrase("");
  }, []);

  const choosePrivateKey = useCallback(async (): Promise<void> => {
    if (operationPendingRef.current || isActiveState(connectionStateRef.current)) return;
    clearPrivateKeyCredentials();
    try {
      const nextPrivateKey = await pickPrivateKey();
      if (!mountedRef.current) return;
      privateKeyIdRef.current = nextPrivateKey.keyId;
      setPrivateKeyInfo(nextPrivateKey);
      setPrivateKeyPassphrase("");
      setError(null);
    } catch {
      if (mountedRef.current) setError(SSH_PRIVATE_KEY_PICKER_ERROR);
    }
  }, [clearPrivateKeyCredentials]);

  useEffect(() => {
    resolvedThemeRef.current = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.classList.add("ssh-page-active");
    return () => document.documentElement.classList.remove("ssh-page-active");
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let handles: Array<{ remove: () => Promise<void> }> = [];

    const onState = (event: {
      sessionId: string;
      state: BridgeSSHConnectionState;
      message?: string;
      retryable?: boolean;
    }): void => {
      if (disposed || event.sessionId !== sessionId) return;
      updateConnectionState(event.state);
      if (event.state === "connected") {
        nativeSessionActiveRef.current = true;
        clearPrivateKeyCredentials();
        setPassword("");
        setError(null);
        setHostKeyPrompt(null);
        window.requestAnimationFrame(() => scheduleResizeRef.current?.(true));
      } else if (event.state === "error") {
        nativeSessionActiveRef.current = false;
        clearPrivateKeyCredentials();
        setPassword("");
        setError(event.message || (event.retryable ? "SSH 连接失败，可重试。" : "SSH 连接失败。"));
      } else if (event.state === "disconnected" || event.state === "exited") {
        nativeSessionActiveRef.current = false;
        clearPrivateKeyCredentials();
        setPassword("");
        setHostKeyPrompt(null);
        if (event.message) setError(event.message);
      } else if (event.state === "disconnecting") {
        setHostKeyPrompt(null);
      }
    };

    const onHostKey = (event: BridgeSSHHostKeyEvent): void => {
      if (disposed || event.sessionId !== sessionId) return;
      // The SSH transport exists, but the PTY is not ready yet; do not send
      // resize/input calls while the native verifier is waiting for approval.
      nativeSessionActiveRef.current = false;
      setHostKeyPrompt(event);
      updateConnectionState("awaiting-host-key");
      setError(null);
    };

    const onOutput = (event: { sessionId: string; dataBase64: string }): void => {
      if (disposed || event.sessionId !== sessionId) return;
      try {
        const bytes = decodeBase64(event.dataBase64);
        const terminal = terminalRef.current;
        if (terminal) terminal.write(bytes);
        else pendingOutputRef.current.push(bytes);
      } catch {
        if (mountedRef.current) setError("SSH 输出数据无效，终端未继续写入。 ");
      }
    };

    const onExit = (event: { sessionId: string; code?: number; signal?: string; message?: string }): void => {
      if (disposed || event.sessionId !== sessionId) return;
      nativeSessionActiveRef.current = false;
      clearPrivateKeyCredentials();
      setHostKeyPrompt(null);
      updateConnectionState("exited");
      if (event.message) setError(event.message);
    };

    const installListeners = async (): Promise<void> => {
      try {
        const registrations: Array<() => Promise<{ remove: () => Promise<void> }>> = [
          () => addListener("sshState", onState),
          () => addListener("sshHostKey", onHostKey),
          () => addListener("sshOutput", onOutput),
          () => addListener("sshExit", onExit),
        ];
        for (const register of registrations) handles.push(await register());
        if (disposed) await Promise.allSettled(handles.map((handle) => handle.remove()));
      } catch (cause) {
        await Promise.allSettled(handles.map((handle) => handle.remove()));
        handles = [];
        if (!disposed) {
          updateConnectionState("error");
          setError(errorMessage(cause, "SSH 原生插件不可用，请确认 App 已安装 SSH 支持。"));
        }
      }
    };

    void installListeners();
    return () => {
      disposed = true;
      mountedRef.current = false;
      for (const handle of handles) void handle.remove().catch(() => {});
      handles = [];
      nativeSessionActiveRef.current = false;
      clearPrivateKeyCredentials();
      void disconnect({ sessionId }).catch(() => {});
    };
  }, [clearPrivateKeyCredentials, sessionId, setHostKeyPrompt, updateConnectionState]);

  const sendTerminalInput = useCallback((input: string): void => {
    if (connectionStateRef.current !== "connected") return;
    void send({ sessionId, dataBase64: encodeBase64(new TextEncoder().encode(input)) }).catch((cause) => {
      if (mountedRef.current) setError(errorMessage(cause, "SSH 输入发送失败。"));
    });
  }, [sessionId]);

  useEffect(() => {
    const hostElement = terminalHostRef.current;
    if (!hostElement) return;
    let disposed = false;
    let terminal: Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;
    let forceResize = false;
    let lastSentCols = 0;
    let lastSentRows = 0;
    let removeTerminalTouch: (() => void) | null = null;
    let inputSubscription: { dispose: () => void } | null = null;
    let cleanupTerminal: (() => void) | null = null;

    const initialize = async (): Promise<void> => {
      const [{ Terminal }, { FitAddon }, { CanvasAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-canvas"),
      ]);
      if (disposed) return;

      terminal = new Terminal({
        cursorBlink: true,
        cursorInactiveStyle: "block",
        disableStdin: false,
        convertEol: false,
        fontSize: 13,
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        scrollback: 2_000,
        theme: getTmuxTerminalTheme(resolvedThemeRef.current),
        minimumContrastRatio: resolvedThemeRef.current === "light" ? 7 : 1,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(hostElement);
      try {
        terminal.loadAddon(new CanvasAddon());
      } catch {
        // The DOM renderer remains a valid fallback on devices without canvas support.
      }
      if (terminal.textarea) {
        terminal.textarea.inputMode = "text";
        terminal.textarea.setAttribute("aria-label", "SSH 终端输入");
      }
      terminalRef.current = terminal;
      for (const bytes of pendingOutputRef.current.splice(0)) terminal.write(bytes);
      removeTerminalTouch = bindMobileTerminalTouch(hostElement, terminal, setTerminalSelection);

      const fit = (): void => {
        if (!terminal || disposed) return;
        try {
          fitAddon.fit();
        } catch {
          // A zero-sized or transitioning mobile viewport can make FitAddon fail.
        }
      };
      const scheduleResize = (force = false): void => {
        forceResize ||= force;
        if (resizeFrame || disposed) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = 0;
          if (!terminal || disposed) return;
          const shouldSend = forceResize;
          forceResize = false;
          try {
            fitAddon.fit();
          } catch {
            return;
          }
          const cols = terminal.cols;
          const rows = terminal.rows;
          if (cols < 2 || rows < 1) return;
          if (!shouldSend && cols === lastSentCols && rows === lastSentRows) return;
          if (!nativeSessionActiveRef.current) return;
          lastSentCols = cols;
          lastSentRows = rows;
          void resize({ sessionId, cols, rows }).catch((cause) => {
            if (!disposed && mountedRef.current) setError(errorMessage(cause, "SSH 终端尺寸更新失败。"));
          });
        });
      };
      scheduleResizeRef.current = scheduleResize;

      inputSubscription = terminal.onData((input) => {
        if (disposed) return;
        sendTerminalInput(input);
      });
      resizeObserver = new ResizeObserver(() => scheduleResize());
      resizeObserver.observe(hostElement);
      window.addEventListener("resize", fit);
      window.visualViewport?.addEventListener("resize", fit);
      scheduleResize(true);

      cleanupTerminal = (): void => {
        window.removeEventListener("resize", fit);
        window.visualViewport?.removeEventListener("resize", fit);
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
        inputSubscription?.dispose();
        inputSubscription = null;
        removeTerminalTouch?.();
        removeTerminalTouch = null;
        scheduleResizeRef.current = null;
        if (terminalRef.current === terminal) terminalRef.current = null;
        pendingOutputRef.current = [];
        terminal?.dispose();
        terminal = null;
      };
    };

    void initialize().catch((cause: unknown) => {
      if (!disposed && mountedRef.current) {
        updateConnectionState("error");
        setError(errorMessage(cause, "SSH 终端初始化失败。"));
      }
    });

    return () => {
      disposed = true;
      cleanupTerminal?.();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [sendTerminalInput, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = getTmuxTerminalTheme(resolvedTheme);
    terminal.options.minimumContrastRatio = resolvedTheme === "light" ? 7 : 1;
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [resolvedTheme]);

  const connectToHost = useCallback(async (forceReconnect = false): Promise<void> => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setError(null);
    setHostKeyPrompt(null);
    try {
      if (forceReconnect || isActiveState(connectionStateRef.current)) {
        nativeSessionActiveRef.current = false;
        await disconnect({ sessionId }).catch(() => {});
      }
      const terminal = terminalRef.current;
      const dimensions = terminal
        ? normalizeSshDimensions(terminal.cols, terminal.rows)
        : { cols: SSH_DEFAULT_COLS, rows: SSH_DEFAULT_ROWS };
      if (!password && !privateKeyIdRef.current) {
        setError("请至少填写密码或选择私钥。");
        return;
      }
      const request = normalizeSshConnectRequest({
        sessionId,
        host,
        port,
        username,
        password: password || undefined,
        privateKeyId: privateKeyIdRef.current || undefined,
        privateKeyPassphrase: privateKeyIdRef.current ? privateKeyPassphrase || undefined : undefined,
        startupCommand: startupCommand || undefined,
        ...dimensions,
      });
      nativeSessionActiveRef.current = true;
      updateConnectionState("connecting");
      await connect(request);
    } catch (cause) {
      nativeSessionActiveRef.current = false;
      updateConnectionState("error");
      setError(errorMessage(cause, "SSH 连接失败，请检查连接参数。"));
    } finally {
      // The native plugin has copied the opaque handle/passphrase before its
      // asynchronous SSH work begins; release the WebView-side credentials.
      clearPrivateKeyCredentials();
      setPassword("");
      operationPendingRef.current = false;
    }
  }, [clearPrivateKeyCredentials, host, password, port, privateKeyPassphrase, sessionId, setHostKeyPrompt, startupCommand, updateConnectionState, username]);

  const disconnectFromHost = useCallback(async (): Promise<void> => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    nativeSessionActiveRef.current = false;
    setHostKeyPrompt(null);
    updateConnectionState("disconnecting");
    try {
      await disconnect({ sessionId });
      updateConnectionState("disconnected");
    } catch (cause) {
      updateConnectionState("error");
      setError(errorMessage(cause, "SSH 断开失败。"));
    } finally {
      clearPrivateKeyCredentials();
      setPassword("");
      operationPendingRef.current = false;
    }
  }, [clearPrivateKeyCredentials, sessionId, setHostKeyPrompt, updateConnectionState]);

  const confirmHostKey = useCallback(async (accept: boolean): Promise<void> => {
    if (!hostKeyRef.current || isApprovingHostKey) return;
    setIsApprovingHostKey(true);
    try {
      await approveHostKey({ sessionId, accept });
      if (!accept) setHostKeyPrompt(null);
    } catch (cause) {
      setError(errorMessage(cause, "主机指纹确认失败。"));
    } finally {
      if (mountedRef.current) setIsApprovingHostKey(false);
    }
  }, [isApprovingHostKey, sessionId, setHostKeyPrompt]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void connectToHost(false);
  };

  const active = isActiveState(connectionState);
  const canConnect = !active && !operationPendingRef.current;
  const canDisconnect = active || nativeSessionActiveRef.current;
  const copyTerminalSelection = async (): Promise<void> => {
    if (!terminalSelection?.text) return;
    try {
      await copyMobileText(terminalSelection.text);
      terminalRef.current?.clearSelection();
      setTerminalSelection(null);
    } catch (cause) {
      setError(errorMessage(cause, "终端内容复制失败。"));
    }
  };

  return (
    <main className="ssh-page">
      <div className="ssh-page-inner">
        <section className="ssh-connection-card" aria-label="SSH 连接参数">
          <form className="ssh-form" onSubmit={submit}>
            <label className="ssh-field ssh-field-host">
              <span>主机</span>
              <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.10 或 hostname" autoComplete="off" spellCheck={false} disabled={active} required />
            </label>
            <label className="ssh-field ssh-field-port">
              <span>端口</span>
              <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" autoComplete="off" disabled={active} required />
            </label>
            <label className="ssh-field ssh-field-username">
              <span>用户名</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="mac 用户名" autoComplete="username" spellCheck={false} disabled={active} required />
            </label>
            <label className="ssh-field ssh-field-password">
              <span>密码（可选）</span>
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="密码认证" autoComplete="current-password" disabled={active} />
            </label>
            <label className="ssh-field ssh-field-private-key">
              <span>私钥（可选）</span>
              <div className="ssh-private-key-picker">
                <button className="ssh-button ssh-button-secondary" type="button" onClick={() => void choosePrivateKey()} disabled={active || operationPendingRef.current}>选择私钥</button>
                <div className="ssh-private-key-meta" aria-live="polite">
                  {privateKeyInfo ? (
                    <>
                      <strong>{privateKeyInfo.fileName}</strong>
                      <span>格式：{privateKeyInfo.format} · {privateKeyInfo.encrypted ? "已加密" : "未加密"}</span>
                    </>
                  ) : <span>尚未选择</span>}
                </div>
              </div>
            </label>
            <label className="ssh-field ssh-field-private-key-passphrase">
              <span>私钥 passphrase（可选）</span>
              <input
                value={privateKeyPassphrase}
                onChange={(event) => {
                  setPrivateKeyPassphrase(event.target.value);
                }}
                type="password"
                placeholder="加密私钥的口令"
                autoComplete="off"
                disabled={active}
              />
            </label>
            <label className="ssh-field ssh-field-startup-command">
              <span>连接后命令（可选）</span>
              <input value={startupCommand} onChange={(event) => setStartupCommand(event.target.value)} placeholder="例如 tmux attach -t main" autoComplete="off" spellCheck={false} disabled={active} />
            </label>
            <div className="ssh-form-actions">
              <button className="ssh-button ssh-button-primary" type="submit" disabled={!canConnect}>{connectionState === "error" || connectionState === "disconnected" || connectionState === "exited" ? "重新连接" : "连接"}</button>
              <button className="ssh-button ssh-button-secondary" type="button" onClick={() => void disconnectFromHost()} disabled={!canDisconnect}>断开</button>
            </div>
          </form>
          <p className="ssh-auth-summary" role="status">
            当前认证方式：{privateKeyInfo ? `私钥优先（${privateKeyInfo.fileName}）` : password ? "密码" : "未选择"}
          </p>
          <p className="ssh-credential-note">私钥由 Android 原生选择器保管，React 只持有 opaque keyId、文件名和元数据，不读取或保存私钥文本。passphrase 仅用于当前连接请求，不写入 Bridge、浏览器存储或日志。断开或离开页面时会清理 keyId 和 passphrase。Android 原生仅支持 OpenSSH／PKCS#8 私钥格式，不支持 PuTTY（.ppk）；私钥优先于密码。连接后命令可用于执行 tmux attach。</p>
          {error ? <p className="ssh-error" role="alert">{error}</p> : null}
        </section>

        {hostKey ? (
          <section className="ssh-host-key-card" role="alert" aria-live="assertive">
            <div className="ssh-host-key-heading"><span className="ssh-host-key-icon" aria-hidden="true">!</span><div><strong>确认 SSH 主机密钥</strong><p>首次连接或主机密钥变化时，请确认指纹是否来自你的主机。</p></div></div>
            <dl className="ssh-host-key-details">
              <dt>主机</dt><dd>{hostKey.host || host}:{hostKey.port || port}</dd>
              {hostKey.keyType || hostKey.algorithm ? <><dt>类型</dt><dd>{hostKey.keyType || hostKey.algorithm}</dd></> : null}
              <dt>指纹</dt><dd><code>{hostKey.fingerprint}</code></dd>
            </dl>
            <div className="ssh-host-key-actions">
              <button className="ssh-button ssh-button-secondary" type="button" onClick={() => void confirmHostKey(false)} disabled={isApprovingHostKey}>拒绝</button>
              <button className="ssh-button ssh-button-primary" type="button" onClick={() => void confirmHostKey(true)} disabled={isApprovingHostKey}>信任并继续</button>
            </div>
          </section>
        ) : null}

        <section className="ssh-terminal-card" aria-label="SSH 终端">
          <div className="ssh-terminal-toolbar">
            <span>SSH 终端</span>
            <span className={`ssh-terminal-status ssh-terminal-status-${connectionState}`}>{STATUS_LABELS[connectionState]}</span>
            <span className="ssh-terminal-hint">触摸滚动 · 点击终端输入</span>
          </div>
          <div className="ssh-quick-keys" aria-label="终端快捷键">
            {SSH_QUICK_KEYS.map((shortcut) => (
              <button
                key={shortcut.label}
                className="ssh-quick-key"
                type="button"
                aria-label={shortcut.ariaLabel ?? shortcut.label}
                onClick={() => sendTerminalInput(shortcut.value)}
                disabled={connectionState !== "connected"}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
          {terminalSelection?.text ? (
            <button
              className="ssh-terminal-copy-selection"
              type="button"
              style={{ left: terminalSelection.left, top: terminalSelection.top }}
              onClick={() => void copyTerminalSelection()}
            >
              复制选中内容
            </button>
          ) : null}
          <div className="ssh-terminal-host" ref={terminalHostRef} />
        </section>
      </div>
    </main>
  );
}
