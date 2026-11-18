import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import type RFB from "@novnc/novnc";
import { copyMobileText, getBridgeOrigin, isMobileApp, MOBILE_CONNECTION_EVENT } from "./mobile-runtime.js";
import { createRemoteDesktopStreamUrl, readRemoteDesktopDisplays } from "./remote-desktop-api.js";
import type { DesktopDisplay } from "./remote-desktop-viewport.js";
import { useRemoteDesktopViewport } from "./use-remote-desktop-viewport.js";
import "./remote-desktop.css";

type DesktopState = "idle" | "connecting" | "credentials" | "connected";
type Modifier = "ctrl" | "alt" | "shift" | "meta";
// A sentinel lets Android keyboards report backspace even after previous text was sent.
const KEYBOARD_SENTINEL = "\u200b";
const MODIFIERS: Record<Modifier, { label: string; keysym: number; code: string }> = {
  ctrl: { label: "Ctrl", keysym: 0xffe3, code: "ControlLeft" },
  alt: { label: "⌥", keysym: 0xffe9, code: "AltLeft" },
  shift: { label: "⇧", keysym: 0xffe1, code: "ShiftLeft" },
  meta: { label: "⌘", keysym: 0xffeb, code: "MetaLeft" },
};
const SPECIAL_KEYS = [
  { label: "Esc", keysym: 0xff1b, code: "Escape" },
  { label: "Tab", keysym: 0xff09, code: "Tab" },
  { label: "←", keysym: 0xff51, code: "ArrowLeft" },
  { label: "↑", keysym: 0xff52, code: "ArrowUp" },
  { label: "↓", keysym: 0xff54, code: "ArrowDown" },
  { label: "→", keysym: 0xff53, code: "ArrowRight" },
  { label: "⌫", keysym: 0xff08, code: "Backspace" },
  { label: "回车", keysym: 0xff0d, code: "Enter" },
] as const;

function isUnencryptedRemoteBridge(): boolean {
  try {
    const target = new URL(getBridgeOrigin());
    const localBrowser = !isMobileApp() && (target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname === "[::1]");
    return target.protocol === "http:" && !localBrowser;
  } catch { return false; }
}

function keysymForCharacter(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return 0x01000000 | code;
}

export function RemoteDesktop({ active = true }: { active?: boolean }): ReactElement {
  const activeRef = useRef(active);
  const stageRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<RFB | null>(null);
  const attemptRef = useRef(0);
  const modifierRef = useRef(new Set<Modifier>());
  const composingRef = useRef(false);
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
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const connected = state === "connected";
  const viewport = useRemoteDesktopViewport(stageRef, targetRef, displays, active, connected);

  const releaseModifiers = useCallback((): void => {
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
    keyboardRef.current?.blur();
  }, [releaseModifiers]);

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
    }
    const client = clientRef.current;
    if (!client) return;
    if (viewOnly) releaseModifiers();
    client.viewOnly = viewOnly || !active;
    client.scaleViewport = true;
    client.clipViewport = false;
    client.dragViewport = false;
  }, [active, releaseModifiers, viewOnly]);

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
  const sendShortcut = (modifier: Modifier, keysym: number, code: string): void => {
    const client = clientRef.current;
    if (!client || viewOnly || !active) return;
    releaseModifiers();
    const key = MODIFIERS[modifier];
    client.sendKey(key.keysym, key.code, true);
    try { client.sendKey(keysym, code); }
    finally { client.sendKey(key.keysym, key.code, false); }
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
  const sendText = (value: string): void => {
    const client = clientRef.current;
    if (!client || viewOnly) return;
    for (const character of value) {
      if (character === "\n" || character === "\r") client.sendKey(0xff0d, "Enter");
      else if (character === "\t") client.sendKey(0xff09, "Tab");
      else client.sendKey(keysymForCharacter(character));
      releaseModifiers();
    }
  };
  const flushKeyboard = (deleted = false): void => {
    const input = keyboardRef.current;
    if (!input || composingRef.current) return;
    const value = input.value;
    if (!value && deleted) sendKey(0xff08, "Backspace");
    else sendText(value.replaceAll(KEYBOARD_SENTINEL, ""));
    input.value = KEYBOARD_SENTINEL;
    input.setSelectionRange(input.value.length, input.value.length);
  };
  const keyboardKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    const special = SPECIAL_KEYS.find((key) => key.code === event.key || key.code === event.code);
    if (!special) return;
    event.preventDefault(); sendKey(special.keysym, special.code);
  };
  const copyClipboard = async (): Promise<void> => {
    try {
      if (isMobileApp()) await copyMobileText(clipboard);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(clipboard);
      else throw new Error("当前浏览器无法复制，请手动选择文字。");
      setClipboardMessage("已复制到本机剪贴板。");
    } catch (failure) { setClipboardMessage(failure instanceof Error ? failure.message : "复制失败。"); }
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
    <div className="remote-desktop-controls" aria-label="远程桌面控制">
      <div className="remote-desktop-control-row">
        <button type="button" disabled={!connected} aria-pressed={viewOnly} onClick={() => setViewOnly((value) => !value)}>{viewOnly ? "只读中" : "可控制"}</button>
        {viewport.regions && viewport.regions.length > 1 && <label className="remote-desktop-display">屏幕
          <select aria-label="选择屏幕" value={viewport.selectedValue} disabled={!connected} onChange={(event) => viewport.selectDisplay(event.target.value)}>
            <option value="all">全部屏幕</option>
            {viewport.regions.map((display) => <option key={display.id} value={String(display.id)}>{display.builtIn ? "电脑内建屏" : display.name}{display.main ? "（主屏）" : ""}</option>)}
          </select>
        </label>}
        <button type="button" disabled={!connected} onClick={refreshDisplays}>刷新屏幕</button>
        <button type="button" disabled={!connected} aria-pressed={viewport.actualSize} onClick={viewport.toggleActualSize}>{viewport.actualSize ? "原始尺寸" : "适应屏幕"}</button>
        <button type="button" disabled={!connected} aria-pressed={viewport.pan} onClick={() => viewport.setPan((value) => !value)}>{viewport.pan ? "移动画面中" : "移动画面"}</button>
        <button type="button" disabled={!connected} aria-pressed={clipboardOpen} onClick={() => setClipboardOpen((value) => !value)}>剪贴板</button>
      </div>
      <div className="remote-desktop-control-row remote-desktop-zoom" aria-label="画面缩放">
        <button type="button" disabled={!connected} aria-label="缩小画面" onClick={() => viewport.adjustZoom(1 / 1.35)}>−</button>
        <span aria-live="polite">{Math.round(viewport.zoom * 100)}%</span>
        <button type="button" disabled={!connected} aria-label="放大画面" onClick={() => viewport.adjustZoom(1.35)}>＋</button>
        <button type="button" disabled={!connected} onClick={viewport.reset}>重置画面</button>
        <button type="button" disabled={!connected || viewOnly} onClick={() => sendShortcut("meta", 0xff09, "Tab")}>切换 App</button>
        <button type="button" disabled={!connected || viewOnly} onClick={() => sendShortcut("meta", 0x60, "Backquote")}>切换窗口</button>
        <button type="button" disabled={!connected || viewOnly} title="Control + ↑；需要 Mac 启用调度中心快捷键" onClick={() => sendShortcut("ctrl", 0xff52, "ArrowUp")}>调度中心</button>
      </div>
      <div className="remote-desktop-control-row remote-desktop-keys">
        {Object.entries(MODIFIERS).map(([name, item]) => <button key={name} type="button" disabled={!connected || viewOnly} aria-pressed={modifiers.includes(name as Modifier)} onPointerDown={(event) => event.preventDefault()} onClick={() => toggleModifier(name as Modifier)}>{item.label}</button>)}
        {SPECIAL_KEYS.map((item) => <button key={item.code} type="button" disabled={!connected || viewOnly} onPointerDown={(event) => event.preventDefault()} onClick={() => sendKey(item.keysym, item.code)}>{item.label}</button>)}
      </div>
      <label className="remote-desktop-keyboard"><span>键盘</span><textarea ref={keyboardRef} rows={1} disabled={!connected || viewOnly} aria-label="远程键盘输入" placeholder="点击输入文字" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onFocus={(event) => {
          if (clientRef.current) clientRef.current.focusOnClick = false;
          event.currentTarget.value = KEYBOARD_SENTINEL;
          event.currentTarget.setSelectionRange(1, 1);
        }}
        onBlur={(event) => { if (clientRef.current) clientRef.current.focusOnClick = true; event.currentTarget.value = ""; }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; queueMicrotask(() => flushKeyboard()); }}
        onInput={(event) => {
          const input = event.nativeEvent as InputEvent;
          if (!input.isComposing) flushKeyboard(input.inputType?.startsWith("delete") ?? false);
        }}
        onKeyDown={keyboardKeyDown} /></label>
      {viewport.layoutUnavailable && <p className="remote-desktop-warning" role="status">显示器布局与远程画面不一致，请刷新屏幕；仍可缩放和移动完整画面。</p>}
      <p className="remote-desktop-hint">单指点击或拖动操作；双指拖动滚动、捏合缩放。放大后可切换「移动画面」来拖动画面。</p>
      {clipboardOpen && <section className="remote-desktop-clipboard" aria-label="剪贴板">
        <label>剪贴板文字<textarea value={clipboard} onChange={(event) => setClipboard(event.target.value)} placeholder="粘贴文字，或在 Mac 上复制后查看" /></label>
        <div className="remote-desktop-control-row"><button type="button" disabled={!connected || viewOnly} onClick={() => { clientRef.current?.clipboardPasteFrom(clipboard); setClipboardMessage("已发送到远程剪贴板，可在 Mac 上粘贴。"); }}>发送到 Mac</button><button type="button" disabled={!clipboard} onClick={() => void copyClipboard()}>复制到本机</button></div>
        {clipboardMessage && <p role="status">{clipboardMessage}</p>}
      </section>}
    </div>
    <p className="remote-desktop-license">远程桌面使用 <a href="https://github.com/novnc/noVNC" target="_blank" rel="noreferrer">noVNC</a> · <a href="/open-source-licenses/novnc-notice.txt" target="_blank" rel="noreferrer">开源许可</a></p>
  </main>;
}
