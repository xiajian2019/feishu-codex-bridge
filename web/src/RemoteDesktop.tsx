import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import type RFB from "@novnc/novnc";
import { closeNativeRemoteDesktop, copyMobileText, getBridgeOrigin, getNativeRemoteDesktopPlatform, isMobileApp, isNativeRemoteDesktopAvailable, MOBILE_CONNECTION_EVENT, onNativeRemoteDesktopClosed, onNativeRemoteDesktopReconnect, openNativeRemoteDesktop } from "./mobile-runtime.js";
import { createRemoteDesktopStreamUrl, readRemoteDesktopDisplays } from "./remote-desktop-api.js";
import { remoteDesktopTextKeyEvents } from "./remote-desktop-keyboard.js";
import type { DesktopDisplay } from "./remote-desktop-viewport.js";
import { useRemoteDesktopViewport } from "./use-remote-desktop-viewport.js";
import { COMMAND_KEY, REMOTE_DESKTOP_SHORTCUTS, sendRemoteDesktopShortcut, type RemoteDesktopShortcut } from "./remote-desktop-shortcuts.js";
import "./remote-desktop.css";

type DesktopState = "idle" | "connecting" | "credentials" | "connected";
type Modifier = "ctrl" | "alt" | "shift" | "meta";
type RemoteDesktopIconName = "apps" | "chevron-down" | "chevron-up" | "clipboard" | "control" | "eye" | "exit-fullscreen" | "fit" | "fullscreen" | "mission-control" | "monitor" | "pan" | "refresh" | "reset" | "spotlight" | "windows" | "zoom-in" | "zoom-out";
type ScreenOrientationWithLock = ScreenOrientation & { lock?: (orientation: "landscape") => Promise<void> };

function RemoteDesktopIcon({ name }: { name: RemoteDesktopIconName }): ReactElement {
  const props = { className: "remote-desktop-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: false };
  switch (name) {
    case "apps": return <svg {...props}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
    case "chevron-down": return <svg {...props}><path d="m6 9 6 6 6-6" /></svg>;
    case "chevron-up": return <svg {...props}><path d="m6 15 6-6 6 6" /></svg>;
    case "clipboard": return <svg {...props}><rect x="6" y="5" width="13" height="16" rx="2" /><path d="M9 5.5V4h7v1.5M9 10h7M9 14h5" /></svg>;
    case "control": return <svg {...props}><path d="m5 3 13 10-6 1.5 3 6-2.5 1.2-3-6L5 21z" /></svg>;
    case "eye": return <svg {...props}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
    case "exit-fullscreen": return <svg {...props}><path d="M9 3v6H3M15 3v6h6M21 15h-6v6M9 21v-6H3" /></svg>;
    case "fit": return <svg {...props}><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg>;
    case "fullscreen": return <svg {...props}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></svg>;
    case "mission-control": return <svg {...props}><path d="m4 7 8-4 8 4-8 4-8-4ZM4 12l8 4 8-4M4 17l8 4 8-4" /></svg>;
    case "monitor": return <svg {...props}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M9 21h6M12 17v4" /></svg>;
    case "pan": return <svg {...props}><path d="M12 4v16M4 12h16M8.5 8.5 12 4l3.5 4.5M8.5 15.5 12 20l3.5-4.5M8.5 8.5 4 12l4.5 3.5M15.5 8.5 20 12l-4.5 3.5" /></svg>;
    case "refresh": return <svg {...props}><path d="M20 11a8 8 0 1 0 1 4" /><path d="M20 4v7h-7" /></svg>;
    case "reset": return <svg {...props}><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4v5h5" /></svg>;
    case "spotlight": return <svg {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>;
    case "windows": return <svg {...props}><rect x="4" y="6" width="13" height="13" rx="2" /><path d="M8 6V4h11a1 1 0 0 1 1 1v11h-3" /></svg>;
    case "zoom-in": return <svg {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6M10.5 7.5v6" /></svg>;
    case "zoom-out": return <svg {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6" /></svg>;
  }
}

type RemoteDesktopIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "title"> & {
  label: string;
  icon?: RemoteDesktopIconName;
  glyph?: string;
  shortcut?: string;
};

function RemoteDesktopIconButton({ label, icon, glyph, shortcut, className = "", type = "button", ...props }: RemoteDesktopIconButtonProps): ReactElement {
  return <button {...props} type={type} className={`remote-desktop-icon-button${className ? ` ${className}` : ""}`} aria-label={label} title={shortcut ? `${label}（${shortcut}）` : label}>
    {icon ? <RemoteDesktopIcon name={icon} /> : <span className="remote-desktop-icon-glyph" aria-hidden="true">{glyph}</span>}
    <span className="sr-only">{label}</span>
  </button>;
}

const MODIFIERS: Record<Modifier, { label: string; glyph: string; keysym: number; code: string }> = {
  ctrl: { label: "Control", glyph: "⌃", keysym: 0xffe3, code: "ControlLeft" },
  alt: { label: "Option", glyph: "⌥", keysym: 0xffe9, code: "AltLeft" },
  shift: { label: "Shift", glyph: "⇧", keysym: 0xffe1, code: "ShiftLeft" },
  meta: { label: "Command", glyph: "⌘", ...COMMAND_KEY },
};
const SPECIAL_KEYS = [
  { label: "Escape", glyph: "⎋", keysym: 0xff1b, code: "Escape" },
  { label: "Tab", glyph: "⇥", keysym: 0xff09, code: "Tab" },
  { label: "向左", glyph: "←", keysym: 0xff51, code: "ArrowLeft" },
  { label: "向上", glyph: "↑", keysym: 0xff52, code: "ArrowUp" },
  { label: "向下", glyph: "↓", keysym: 0xff54, code: "ArrowDown" },
  { label: "向右", glyph: "→", keysym: 0xff53, code: "ArrowRight" },
  { label: "删除", glyph: "⌫", keysym: 0xff08, code: "Backspace" },
  { label: "回车", glyph: "↵", keysym: 0xff0d, code: "Enter" },
] as const;

function isUnencryptedRemoteBridge(): boolean {
  try {
    const target = new URL(getBridgeOrigin());
    const localBrowser = !isMobileApp() && (target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname === "[::1]");
    return target.protocol === "http:" && !localBrowser;
  } catch { return false; }
}

export function RemoteDesktop({ active = true }: { active?: boolean }): ReactElement {
  const activeRef = useRef(active);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<RFB | null>(null);
  const attemptRef = useRef(0);
  const modifierRef = useRef(new Set<Modifier>());
  const composingRef = useRef(false);
  const orientationLockedRef = useRef(false);
  const fallbackPendingRef = useRef(false);
  const [state, setState] = useState<DesktopState>("idle");
  const [error, setError] = useState("");
  const [desktopName, setDesktopName] = useState("");
  const [credentialTypes, setCredentialTypes] = useState<string[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [viewOnly, setViewOnly] = useState(false);
  const [displays, setDisplays] = useState<DesktopDisplay[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [clipboard, setClipboard] = useState("");
  const [clipboardMessage, setClipboardMessage] = useState("");
  const [shortcutMessage, setShortcutMessage] = useState("");
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [keyboardText, setKeyboardText] = useState("");
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const [landscapeFallback, setLandscapeFallback] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [nativeDesktopAvailable, setNativeDesktopAvailable] = useState(false);
  const connected = state === "connected";
  const fullscreenActive = nativeFullscreen || fallbackFullscreen;
  const viewport = useRemoteDesktopViewport(stageRef, targetRef, displays, active, connected);

  const releaseModifiers = useCallback((): void => {
    if (!modifierRef.current.size) return;
    const client = clientRef.current;
    for (const key of modifierRef.current) {
      const { keysym, code } = MODIFIERS[key];
      client?.sendKey(keysym, code, false);
    }
    modifierRef.current.clear();
    setModifiers([]);
  }, []);

  const disconnect = useCallback((): void => {
    attemptRef.current += 1;
    releaseModifiers();
    const client = clientRef.current;
    clientRef.current = null;
    client?.disconnect();
    setState("idle");
    setPassword("");
    setCredentialTypes([]);
    setDesktopName("");
    setDisplays([]);
    setClipboard("");
    setClipboardMessage("");
    setKeyboardText("");
    keyboardRef.current?.blur();
    void closeNativeRemoteDesktop().catch(() => {});
  }, [releaseModifiers]);

  useEffect(() => {
    let disposed = false;
    void isNativeRemoteDesktopAvailable().then((available) => {
      if (!disposed) setNativeDesktopAvailable(available);
    }).catch(() => { if (!disposed) setNativeDesktopAvailable(false); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!nativeDesktopAvailable) return;
    let disposed = false;
    let closedHandle: { remove(): Promise<void> } | null = null;
    let reconnectHandle: { remove(): Promise<void> } | null = null;
    void Promise.all([
      onNativeRemoteDesktopClosed(() => {
        if (disposed) return;
        attemptRef.current += 1;
        setState("idle");
        setPassword("");
        setCredentialTypes([]);
        setDesktopName("");
        setError("");
      }),
      onNativeRemoteDesktopReconnect(() => {
        if (disposed) return;
        setState("connecting");
        setError("");
        void getNativeRemoteDesktopPlatform().then((platform) => platform === "android" ? "" : createRemoteDesktopStreamUrl()).then((url) => {
          if (!disposed) return openNativeRemoteDesktop(url, desktopName || "远程桌面");
          return undefined;
        }).catch((failure: unknown) => {
          if (!disposed) {
            setState("idle");
            setError(failure instanceof Error ? failure.message : "原生远程桌面重连失败。");
          }
        });
      }),
    ]).then(([closed, reconnect]) => {
      if (disposed) {
        void closed.remove();
        void reconnect.remove();
        return;
      }
      closedHandle = closed;
      reconnectHandle = reconnect;
    }).catch(() => {});
    return () => {
      disposed = true;
      void closedHandle?.remove();
      void reconnectHandle?.remove();
    };
  }, [desktopName, nativeDesktopAvailable]);

  useEffect(() => {
    const onConnectionChange = (): void => { disconnect(); setError("Bridge 连接已切换，请重新连接远程桌面。"); };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") { releaseModifiers(); clientRef.current?.blur(); }
    };
    window.addEventListener(MOBILE_CONNECTION_EVENT, onConnectionChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener(MOBILE_CONNECTION_EVENT, onConnectionChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      disconnect();
    };
  }, [disconnect, releaseModifiers]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      setPassword("");
      releaseModifiers();
      keyboardRef.current?.blur();
      clientRef.current?.blur();
      if (document.fullscreenElement === playerRef.current) void document.exitFullscreen();
      setFallbackFullscreen(false);
      setLandscapeFallback(false);
      setControlsExpanded(false);
      void closeNativeRemoteDesktop().catch(() => {});
    }
    const client = clientRef.current;
    if (!client) return;
    if (viewOnly) releaseModifiers();
    client.viewOnly = viewOnly || !active;
    client.scaleViewport = true;
    client.clipViewport = false;
    client.dragViewport = false;
  }, [active, nativeDesktopAvailable, releaseModifiers, viewOnly]);

  useEffect(() => {
    const syncFullscreen = (): void => {
      const native = document.fullscreenElement === playerRef.current;
      setNativeFullscreen(native);
      if (native) setControlsExpanded(false);
      else {
        if (fallbackPendingRef.current) {
          fallbackPendingRef.current = false;
          return;
        }
        setFallbackFullscreen(false);
        setLandscapeFallback(false);
        setControlsExpanded(false);
        if (orientationLockedRef.current && typeof screen.orientation?.unlock === "function") screen.orientation.unlock();
        orientationLockedRef.current = false;
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    const syncLandscapeFallback = (): void => {
      if (!fullscreenActive || orientationLockedRef.current) return;
      setLandscapeFallback(window.innerHeight > window.innerWidth);
    };
    window.addEventListener("resize", syncLandscapeFallback);
    syncLandscapeFallback();
    return () => window.removeEventListener("resize", syncLandscapeFallback);
  }, [fullscreenActive]);

  const refreshDisplays = (): void => {
    const attempt = attemptRef.current;
    void readRemoteDesktopDisplays().then((next) => {
      if (attempt === attemptRef.current) setDisplays(next);
    }).catch(() => { if (attempt === attemptRef.current) setDisplays([]); });
  };

  const connect = async (): Promise<void> => {
    if (state !== "idle" || !targetRef.current) return;
    const attempt = ++attemptRef.current;
    setError(""); setState("connecting"); setCredentialTypes([]); setPassword("");
    const nativePlatform = await getNativeRemoteDesktopPlatform().catch(() => null);
    if (nativePlatform) {
      if (!nativeDesktopAvailable) setNativeDesktopAvailable(true);
      try {
        const url = nativePlatform === "android" ? "" : await createRemoteDesktopStreamUrl();
        if (attempt !== attemptRef.current) return;
        await openNativeRemoteDesktop(url, desktopName || "远程桌面");
        if (attempt === attemptRef.current) setState("connected");
      } catch (failure) {
        if (attempt !== attemptRef.current) return;
        setState("idle");
        setError(failure instanceof Error ? failure.message : "无法打开 iOS 原生远程桌面。");
      }
      return;
    }
    refreshDisplays();
    try {
      const [url, module] = await Promise.all([createRemoteDesktopStreamUrl(), import("@novnc/novnc")]);
      await module.bridgeNoVNCCodecReady;
      if (attempt !== attemptRef.current || !targetRef.current) return;
      const client = new module.default(targetRef.current, url, { shared: true });
      clientRef.current = client;
      client.viewOnly = viewOnly || !activeRef.current;
      client.scaleViewport = true;
      client.clipViewport = false;
      client.dragViewport = false;
      let failure = "";
      const current = (): boolean => attempt === attemptRef.current && clientRef.current === client;
      client.addEventListener("connect", () => {
        if (!current()) return;
        setPassword(""); setCredentialTypes([]); setState("connected"); setError("");
      });
      client.addEventListener("credentialsrequired", (event) => {
        if (!current()) return;
        const types = (event as CustomEvent<{ types?: string[] }>).detail?.types ?? [];
        if (types.some((type) => type !== "username" && type !== "password")) {
          failure = "当前屏幕共享要求不支持的认证方式。"; client.disconnect(); return;
        }
        setCredentialTypes(types); setState("credentials");
      });
      client.addEventListener("desktopname", (event) => {
        if (current()) setDesktopName((event as CustomEvent<{ name?: string }>).detail?.name ?? "");
      });
      client.addEventListener("clipboard", (event) => {
        if (current()) { setClipboard((event as CustomEvent<{ text?: string }>).detail?.text ?? ""); setClipboardMessage("已收到远程剪贴板文字。"); }
      });
      client.addEventListener("securityfailure", (event) => {
        if (!current()) return;
        const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
        failure = reason ? `屏幕共享认证失败：${reason}` : "屏幕共享认证失败，请检查账号和密码。";
      });
      client.addEventListener("serververification", () => {
        if (!current()) return;
        failure = "该服务器要求验证身份，当前版本暂不支持此认证方式。"; client.disconnect();
      });
      client.addEventListener("disconnect", () => {
        if (!current()) return;
        clientRef.current = null; modifierRef.current.clear(); setModifiers([]); setPassword(""); setState("idle");
        setError(failure || "远程桌面已断开。请检查 Mac 的屏幕共享设置和 Bridge 连接。");
      });
    } catch (failure) {
      if (attempt !== attemptRef.current) return;
      setState("idle"); setError(failure instanceof Error ? failure.message : "无法连接远程桌面。");
    }
  };

  const submitCredentials = (event: FormEvent): void => {
    event.preventDefault();
    const client = clientRef.current;
    if (!client) return;
    const credentials: { username?: string; password?: string } = {};
    if (credentialTypes.includes("username")) credentials.username = username;
    if (credentialTypes.includes("password")) credentials.password = password;
    client.sendCredentials(credentials);
    setPassword(""); setState("connecting");
  };

  const sendKey = (keysym: number, code?: string): void => {
    clientRef.current?.sendKey(keysym, code);
    releaseModifiers();
  };
  const sendShortcut = (shortcut: RemoteDesktopShortcut, message: string): void => {
    const client = clientRef.current;
    if (!client || viewOnly || !active) return;
    releaseModifiers();
    sendRemoteDesktopShortcut(client, shortcut);
    setShortcutMessage(message);
  };
  const toggleModifier = (key: Modifier): void => {
    const client = clientRef.current;
    if (!client || viewOnly) return;
    const held = modifierRef.current.has(key);
    const { keysym, code } = MODIFIERS[key];
    client.sendKey(keysym, code, !held);
    if (held) modifierRef.current.delete(key); else modifierRef.current.add(key);
    setModifiers([...modifierRef.current]);
  };
  const sendText = (value: string, appendEnter = false): void => {
    const client = clientRef.current;
    if (!client || viewOnly) return;
    // Text submitted from the local editor is a plain-text operation. Do not
    // let a previously latched toolbar modifier affect only its first glyph.
    releaseModifiers();
    for (const event of remoteDesktopTextKeyEvents(value, appendEnter)) {
      client.sendKey(event.keysym, event.code);
    }
  };
  const submitKeyboardText = (appendEnter = false): void => {
    if (!connected || viewOnly) return;
    sendText(keyboardText, appendEnter);
    setKeyboardText("");
  };
  const keyboardKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitKeyboardText(true);
  };
  const copyClipboard = async (): Promise<void> => {
    try {
      if (isMobileApp()) await copyMobileText(clipboard);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(clipboard);
      else throw new Error("当前浏览器无法复制，请手动选择文字。");
      setClipboardMessage("已复制到本机剪贴板。");
    } catch (failure) { setClipboardMessage(failure instanceof Error ? failure.message : "复制失败。"); }
  };

  const toggleFullscreen = async (): Promise<void> => {
    const player = playerRef.current;
    if (!player) return;
    if (fullscreenActive) {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else {
        setFallbackFullscreen(false);
        setLandscapeFallback(false);
        setControlsExpanded(false);
        if (orientationLockedRef.current && typeof screen.orientation?.unlock === "function") screen.orientation.unlock();
        orientationLockedRef.current = false;
      }
      return;
    }
    const enterLandscape = async (): Promise<boolean> => {
      const orientation = screen.orientation as ScreenOrientationWithLock | undefined;
      if (typeof orientation?.lock === "function") {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const locked = await Promise.race([
            orientation.lock("landscape").then(() => true).catch(() => false),
            new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 600); }),
          ]);
          if (locked) {
            orientationLockedRef.current = true;
            setLandscapeFallback(false);
            return true;
          }
        } catch {
          // Some iOS browsers only allow a CSS fallback inside the fullscreen surface.
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      setLandscapeFallback(window.innerHeight > window.innerWidth);
      return false;
    };
    setControlsExpanded(false);
    if (window.innerHeight > window.innerWidth) {
      setFallbackFullscreen(true);
      setLandscapeFallback(true);
      return;
    }
    if (typeof player.requestFullscreen === "function") {
      try {
        await player.requestFullscreen({ navigationUI: "hide" });
        const locked = await enterLandscape();
        if (!locked && window.innerHeight > window.innerWidth) {
          fallbackPendingRef.current = true;
          await document.exitFullscreen();
          setFallbackFullscreen(true);
          setLandscapeFallback(true);
          setControlsExpanded(false);
        }
        return;
      } catch {
        // iOS WebViews and some embedded browsers do not expose element fullscreen.
      }
    }
    setFallbackFullscreen(true);
    await enterLandscape();
  };

  return <main className="remote-desktop-page">
    <header className="remote-desktop-header">
      <div><h1>远程桌面</h1><p>{desktopName || "连接当前 Bridge 主机的屏幕共享"}</p></div>
      {state === "idle"
        ? <button type="button" className="primary" onClick={() => void connect()}>连接桌面</button>
        : <button type="button" onClick={disconnect}>断开连接</button>}
    </header>
    {!window.isSecureContext && <p className="remote-desktop-warning" role="status">当前页面不是安全连接，Mac 账号认证可能不可用；请使用 HTTPS 或本机地址。</p>}
    {isUnencryptedRemoteBridge() && <p className="remote-desktop-warning" role="status">当前 Bridge 使用 HTTP，画面和输入未由 HTTPS 加密；请使用 HTTPS 或受信任的 VPN。</p>}
    {error && <p className="remote-desktop-error" role="alert">{error}</p>}
    <div ref={playerRef} className={`remote-desktop-player${fullscreenActive ? " is-fullscreen-active" : ""}${fallbackFullscreen ? " is-fallback-fullscreen" : ""}${landscapeFallback ? " is-landscape-fallback" : ""}`}>
      <div ref={stageRef} className={`remote-desktop-stage${state === "credentials" ? " is-auth" : ""}`}>
      <div className="remote-desktop-screen" ref={targetRef} style={viewport.style} aria-label="远程桌面画面"
        onPointerDownCapture={viewport.pointerDown} onPointerMoveCapture={viewport.pointerMove}
        onPointerUpCapture={viewport.pointerEnd} onPointerCancelCapture={viewport.pointerEnd} />
      {state === "idle" && <div className="remote-desktop-placeholder"><strong>查看并操作 Mac 屏幕</strong><span>请先在 Mac 的系统设置中启用「屏幕共享」。</span></div>}
      {state === "connecting" && <div className="remote-desktop-placeholder" role="status">正在连接屏幕共享…</div>}
      {state === "credentials" && <form className="remote-desktop-credentials" onSubmit={submitCredentials}>
        <h2>登录屏幕共享</h2>
        {credentialTypes.includes("username") && <label>Mac 用户名<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>}
        {credentialTypes.includes("password") && <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>}
        <p>凭据仅用于本次连接，不保存在 Bridge 中。</p><button type="submit" className="primary">登录</button>
      </form>}
      </div>
      <div className="remote-desktop-player-actions" aria-label="远程桌面画面操作">
        <RemoteDesktopIconButton icon={fullscreenActive ? "exit-fullscreen" : "fullscreen"} label={fullscreenActive ? "退出最大化" : "最大化画面"} onClick={() => void toggleFullscreen()} />
        {fullscreenActive && <RemoteDesktopIconButton icon={controlsExpanded ? "chevron-down" : "chevron-up"} label={controlsExpanded ? "收起操作菜单" : "展开操作菜单"} aria-expanded={controlsExpanded} onClick={() => setControlsExpanded((value) => !value)} />}
      </div>
      <div className={`remote-desktop-player-controls${fullscreenActive ? " is-fullscreen" : ""}`}>
      <div className={`remote-desktop-controls${fullscreenActive && !controlsExpanded ? " is-collapsed" : ""}`} aria-label="远程桌面控制">
      <div className="remote-desktop-control-groups">
        <section className="remote-desktop-control-group" aria-label="画面与窗口控制">
          <div className="remote-desktop-group-heading"><span>画面与窗口</span><small>缩放与快捷键</small></div>
          <div className="remote-desktop-control-row">
            <RemoteDesktopIconButton icon={viewOnly ? "eye" : "control"} label={viewOnly ? "当前只读，切换为可控制" : "当前可控制，切换为只读"} shortcut={viewOnly ? "只读" : "可控制"} disabled={!connected} aria-pressed={viewOnly} onClick={() => setViewOnly((value) => !value)} />
            {viewport.regions && viewport.regions.length > 1 && <label className="remote-desktop-display" title="选择屏幕">
              <RemoteDesktopIcon name="monitor" />
              <span className="sr-only">选择屏幕</span>
              <select aria-label="选择屏幕" value={viewport.selectedValue} disabled={!connected} onChange={(event) => viewport.selectDisplay(event.target.value)}>
                <option value="all">全部屏幕</option>
                {viewport.regions.map((display) => <option key={display.id} value={String(display.id)}>{display.builtIn ? "电脑内建屏" : display.name}{display.main ? "（主屏）" : ""}</option>)}
              </select>
            </label>}
            <RemoteDesktopIconButton icon="refresh" label="刷新屏幕" disabled={!connected} onClick={refreshDisplays} />
            <RemoteDesktopIconButton icon="fit" label={viewport.actualSize ? "适应屏幕" : "原始尺寸"} shortcut={viewport.actualSize ? "原始尺寸" : "适应屏幕"} disabled={!connected} aria-pressed={viewport.actualSize} onClick={viewport.toggleActualSize} />
            <RemoteDesktopIconButton icon="pan" label={viewport.pan ? "停止移动画面" : "移动画面"} disabled={!connected} aria-pressed={viewport.pan} onClick={() => viewport.setPan((value) => !value)} />
            <RemoteDesktopIconButton icon="clipboard" label={clipboardOpen ? "关闭剪贴板" : "打开剪贴板"} disabled={!connected} aria-pressed={clipboardOpen} onClick={() => setClipboardOpen((value) => !value)} />
          </div>
          <div className="remote-desktop-control-row remote-desktop-zoom" aria-label="画面缩放与窗口快捷键">
            <RemoteDesktopIconButton icon="zoom-out" label="缩小画面" disabled={!connected} onClick={() => viewport.adjustZoom(1 / 1.35)} />
            <span aria-live="polite">{Math.round(viewport.zoom * 100)}%</span>
            <RemoteDesktopIconButton icon="zoom-in" label="放大画面" disabled={!connected} onClick={() => viewport.adjustZoom(1.35)} />
            <RemoteDesktopIconButton icon="reset" label="重置画面" disabled={!connected} onClick={viewport.reset} />
            <span className="remote-desktop-control-divider" aria-hidden="true" />
            <RemoteDesktopIconButton className="remote-desktop-window-shortcut" icon="apps" label="切换 App" shortcut="⌘Tab" disabled={!connected || viewOnly} onClick={() => sendShortcut(REMOTE_DESKTOP_SHORTCUTS.switchApp, "已发送 ⌘Tab；未切到 Xcode 时请使用 Spotlight 搜索。")}/>
            <RemoteDesktopIconButton className="remote-desktop-window-shortcut" icon="spotlight" label="打开 Spotlight" shortcut="⌘Space" disabled={!connected || viewOnly} onClick={() => sendShortcut(REMOTE_DESKTOP_SHORTCUTS.spotlight, "已发送 ⌘Space；请在远程键盘输入 Xcode，再按回车。")}/>
            <RemoteDesktopIconButton className="remote-desktop-window-shortcut" icon="windows" label="切换窗口" shortcut="⌘`" disabled={!connected || viewOnly} onClick={() => sendShortcut(REMOTE_DESKTOP_SHORTCUTS.switchWindow, "已发送 ⌘`，切换当前 App 的窗口。")}/>
            <RemoteDesktopIconButton className="remote-desktop-window-shortcut" icon="mission-control" label="调度中心" shortcut="Control + ↑" disabled={!connected || viewOnly} onClick={() => sendShortcut(REMOTE_DESKTOP_SHORTCUTS.missionControl, "已发送 Control + ↑，打开调度中心。")}/>
          </div>
          {shortcutMessage && <p className="remote-desktop-shortcut-status" role="status">{shortcutMessage}</p>}
        </section>

        <section className="remote-desktop-control-group" aria-label="键盘按键">
          <div className="remote-desktop-group-heading"><span>按键</span><small>修饰键与导航</small></div>
          <div className="remote-desktop-control-row remote-desktop-keys">
            {Object.entries(MODIFIERS).map(([name, item]) => <RemoteDesktopIconButton key={name} glyph={item.glyph} label={item.label} shortcut={item.glyph} disabled={!connected || viewOnly} aria-pressed={modifiers.includes(name as Modifier)} onPointerDown={(event) => event.preventDefault()} onClick={() => toggleModifier(name as Modifier)} />)}
            {SPECIAL_KEYS.map((item) => <RemoteDesktopIconButton key={item.code} glyph={item.glyph} label={item.label} disabled={!connected || viewOnly} onPointerDown={(event) => event.preventDefault()} onClick={() => sendKey(item.keysym, item.code)} />)}
          </div>
          <div className="remote-desktop-keyboard"><span className="remote-desktop-keyboard-symbol" aria-hidden="true">⌨</span><span className="sr-only">远程键盘输入</span><textarea ref={keyboardRef} rows={1} value={keyboardText} disabled={!connected || viewOnly} aria-label="远程键盘输入" placeholder="点击输入文字" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="text" enterKeyHint="send"
            onFocus={() => {
              if (clientRef.current) {
                clientRef.current.blur();
                clientRef.current.focusOnClick = false;
              }
            }}
            onBlur={() => { if (clientRef.current) clientRef.current.focusOnClick = true; }}
            onChange={(event) => setKeyboardText(event.currentTarget.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={keyboardKeyDown} /><button type="button" className="remote-desktop-keyboard-send" disabled={!connected || viewOnly || !keyboardText} onMouseDown={(event) => event.preventDefault()} onClick={() => submitKeyboardText()}>发送</button></div>
        </section>
      </div>
      {viewport.layoutUnavailable && <p className="remote-desktop-warning" role="status">显示器布局与远程画面不一致，请刷新屏幕；仍可缩放和移动完整画面。</p>}
      <p className="remote-desktop-hint">单指点击或拖动操作；双指拖动滚动、捏合缩放。放大后可切换「移动画面」来拖动画面。</p>
      {clipboardOpen && <section className="remote-desktop-clipboard" aria-label="剪贴板">
        <label>剪贴板文字<textarea value={clipboard} onChange={(event) => setClipboard(event.target.value)} placeholder="粘贴文字，或在 Mac 上复制后查看" /></label>
        <div className="remote-desktop-control-row"><button type="button" disabled={!connected || viewOnly} onClick={() => { clientRef.current?.clipboardPasteFrom(clipboard); setClipboardMessage("已发送到远程剪贴板，可在 Mac 上粘贴。"); }}>发送到 Mac</button><button type="button" disabled={!clipboard} onClick={() => void copyClipboard()}>复制到本机</button></div>
        {clipboardMessage && <p role="status">{clipboardMessage}</p>}
      </section>}
      </div>
      </div>
    </div>
    <p className="remote-desktop-license">远程桌面使用 <a href="https://github.com/novnc/noVNC" target="_blank" rel="noreferrer">noVNC</a> · <a href="/open-source-licenses/novnc-notice.txt" target="_blank" rel="noreferrer">开源许可</a></p>
  </main>;
}
