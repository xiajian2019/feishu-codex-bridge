import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { getTmuxTerminalRenderTheme } from "./tmux-terminal-theme.js";
import { isolateTmuxTerminalKeyboard } from "./tmux-terminal-keyboard.js";
import { useTheme } from "./theme.js";
import { mobileStreamUrl } from "./mobile-runtime.js";

type ShellTerminalStatus = "connecting" | "connected" | "closed" | "error";

export interface TmuxShellTerminalSheetProps {
  sessionId: string;
  sessionCreatedAt: number;
  visible: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  onExpired: () => void;
}

export function TmuxShellTerminalSheet({
  sessionId,
  sessionCreatedAt,
  visible,
  onMinimize,
  onRestore,
  onClose,
  onExpired,
}: TmuxShellTerminalSheetProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<ShellTerminalStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const workspace = overlay?.parentElement;
    if (!overlay || !workspace) return;
    const updateMinimizedPosition = (): void => {
      const composer = workspace.querySelector<HTMLElement>(".dashboard-composer");
      const workspaceRect = workspace.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      const bottom = composerRect && composerRect.top > workspaceRect.top
        ? Math.max(8, workspaceRect.bottom - composerRect.top + 8)
        : 146;
      overlay.style.setProperty("--dashboard-shell-minimized-bottom", `${Math.round(bottom)}px`);
    };
    const observer = new ResizeObserver(updateMinimizedPosition);
    observer.observe(workspace);
    const composer = workspace.querySelector<HTMLElement>(".dashboard-composer");
    if (composer) observer.observe(composer);
    window.addEventListener("resize", updateMinimizedPosition);
    window.visualViewport?.addEventListener("resize", updateMinimizedPosition);
    updateMinimizedPosition();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateMinimizedPosition);
      window.visualViewport?.removeEventListener("resize", updateMinimizedPosition);
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = getTmuxTerminalRenderTheme(resolvedTheme);
    terminal.options.minimumContrastRatio = resolvedTheme === "light" ? 7 : 1;
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [resolvedTheme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let terminal: Terminal | null = null;
    let socket: WebSocket | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let inputSubscription: { dispose: () => void } | null = null;

    const sendResize = (): void => {
      if (!terminal) return;
      fitAddon?.fit();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    let fitAddon: FitAddon | null = null;

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
        rightClickSelectsWord: true,
        convertEol: false,
        fontSize: 13,
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        scrollback: 2_000,
        theme: getTmuxTerminalRenderTheme(resolvedThemeRef.current),
        minimumContrastRatio: resolvedThemeRef.current === "light" ? 7 : 1,
      });
      isolateTmuxTerminalKeyboard(terminal);
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      try { terminal.loadAddon(new CanvasAddon()); } catch { /* DOM renderer remains available. */ }
      terminal.open(host);
      terminalRef.current = terminal;

      const streamPath = new URL("/tmux-dashboard/terminal", window.location.origin);
      streamPath.searchParams.set("mode", "shell");
      streamPath.searchParams.set("session", sessionId);
      streamPath.searchParams.set("createdAt", String(sessionCreatedAt));
      streamPath.searchParams.set("cols", String(terminal.cols));
      streamPath.searchParams.set("rows", String(terminal.rows));
      const streamUrl = await mobileStreamUrl(streamPath.pathname + streamPath.search);
      if (disposed) return;
      const address = new URL(streamUrl);
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(address.href);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      inputSubscription = terminal.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
      });
      resizeObserver = new ResizeObserver(sendResize);
      resizeObserver.observe(host);
      resizeRef.current = sendResize;
      sendResize();

      socket.onopen = () => {
        if (disposed) return;
        setStatus("connected");
        setError(null);
        sendResize();
        terminal?.focus();
      };
      socket.onmessage = (event) => {
        if (disposed || !terminal) return;
        if (typeof event.data !== "string") {
          if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
          else if (event.data instanceof Blob) void event.data.arrayBuffer().then((value) => terminal?.write(new Uint8Array(value)));
          return;
        }
        let control: { type?: unknown; message?: unknown; workingDirectory?: unknown } | null = null;
        try {
          const parsed = JSON.parse(event.data) as unknown;
          if (typeof parsed === "object" && parsed !== null) {
            const record = parsed as Record<string, unknown>;
            control = {
              type: record.type,
              message: record.message,
              workingDirectory: record.workingDirectory,
            };
          }
        } catch {
          // Normal shell output is not JSON.
        }
        if (control?.type === "ready") {
          // The shell prompt itself is the working-directory indicator.
        } else if (control?.type === "error" || control?.type === "input-error") {
          setStatus("error");
          setError(typeof control.message === "string" ? control.message : "网页命令终端发生错误。");
        } else if (control?.type === "exit") {
          setStatus("closed");
        } else {
          terminal.write(event.data);
        }
      };
      socket.onerror = () => {
        if (!disposed) {
          setStatus("error");
          setError("无法连接网页命令终端，请关闭后重试。");
        }
      };
      socket.onclose = () => {
        if (!disposed) {
          setStatus((current) => current === "error" ? current : "closed");
          if (!visibleRef.current) onExpired();
        }
      };
    };

    void initialize().catch((cause: unknown) => {
      if (disposed) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "网页命令终端初始化失败。");
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      inputSubscription?.dispose();
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.close(1000, "sheet closed");
      if (socketRef.current === socket) socketRef.current = null;
      resizeRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
      terminal?.dispose();
    };
  }, [sessionCreatedAt, sessionId]);

  const minimizeShell = (): void => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "minimize" }));
    onMinimize();
  };
  const restoreShell = (): void => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "restore" }));
    onRestore();
    window.requestAnimationFrame(() => {
      resizeRef.current?.();
      terminalRef.current?.focus();
    });
  };
  const destroyShell = (): void => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "minimize" }));
    onClose();
  };

  return <div ref={overlayRef} className={`dashboard-shell-terminal-overlay${visible ? "" : " is-minimized"}`}>
    <section className="dashboard-shell-terminal-sheet" role="dialog" aria-modal="true" aria-label="网页命令终端" aria-busy={status === "connecting"}>
      <div className="dashboard-shell-terminal-window-actions">
        <button className="dashboard-shell-terminal-minimize" type="button" aria-label="最小化网页命令终端" title="最小化" onClick={minimizeShell}>−</button>
        <button className="dashboard-shell-terminal-close" type="button" aria-label="关闭网页命令终端" title="关闭" onClick={destroyShell}>×</button>
      </div>
      {error ? <div className="dashboard-shell-terminal-error" role="alert">{error}</div> : null}
      <div ref={hostRef} className="dashboard-shell-terminal-host" />
    </section>
    {!visible ? <button className="dashboard-shell-terminal-minimized" type="button" aria-label="恢复命令终端" title="恢复命令终端" onClick={restoreShell}>&gt;_</button> : null}
  </div>;
}
