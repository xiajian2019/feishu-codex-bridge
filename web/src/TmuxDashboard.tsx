import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";

import { bindMobileTerminalViewport } from "./mobile-terminal-viewport.js";

import { bindMobileTerminalTouch, downloadTerminalScrollDiagnostics, type TerminalSelectionDisplay } from "./terminal-touch.js";
import { TmuxMessageComposer, type TerminalShortcut } from "./TmuxMessageComposer.js";
import { useSystemNavigation } from "./WebNavigation.js";

type TmuxSession = {
  id: string;
  name: string;
  windows: number;
  attachedClients: number;
  cwd: string;
  createdAt: number;
};

type ProjectOption = { name: string; root: string };
type Toast = { message: string; isError: boolean };
type SubmissionResult = { ok: boolean; message?: string };

const API_ROOT = "/tmux-dashboard/api";
const SESSION_REFRESH_INTERVAL_MS = 5_000;

async function requestApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(API_ROOT + path, { ...options, headers });
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Mobile browsers may block Clipboard API on HTTP LAN pages.
    }
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.top = "0";
  field.style.fontSize = "16px";
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, field.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    field.remove();
  }
  if (!copied) throw new Error("Clipboard access is unavailable in this browser.");
}

function normalizeTmuxSession(value: unknown): TmuxSession | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawId = record.id ?? record.sessionId ?? record.session_id;
  const id = typeof rawId === "string" ? rawId : "";
  const name = record.name ?? record.sessionName ?? record.session_name;
  const windows = Number(record.windows ?? record.sessionWindows ?? record.session_windows);
  const attachedClients = Number(record.attachedClients ?? record.attached_clients ?? record.session_attached);
  const cwd = record.cwd ?? record.sessionPath ?? record.session_path;
  const createdAt = Number(record.createdAt ?? record.created_at ?? record.session_created);

  if (
    id
    && typeof name === "string"
    && Number.isFinite(windows)
    && Number.isFinite(attachedClients)
    && typeof cwd === "string"
    && Number.isFinite(createdAt)
  ) {
    return { id, name, windows, attachedClients, cwd, createdAt };
  }

  const composite = /^(\$\d+)[_\t](.+?)[_\t](\d+)[_\t](\d+)[_\t](.+)[_\t](\d+)$/.exec(id);
  if (!composite) return null;
  return {
    id: composite[1],
    name: composite[2],
    windows: Number(composite[3]),
    attachedClients: Number(composite[4]),
    cwd: composite[5],
    createdAt: Number(composite[6]),
  };
}

function tmuxSessionsEqual(left: TmuxSession[], right: TmuxSession[]): boolean {
  return left.length === right.length && left.every((session, index) => {
    const next = right[index];
    return next?.id === session.id
      && next.name === session.name
      && next.windows === session.windows
      && next.attachedClients === session.attachedClients
      && next.cwd === session.cwd
      && next.createdAt === session.createdAt;
  });
}

function createSessionName(): string {
  const stamp = new Date().toISOString();
  return `session-${stamp.slice(5, 10).replace("-", "")}-${stamp.slice(11, 16).replace(":", "")}`;
}

export function TmuxDashboard(): ReactElement {
  const { collapsed: navigationCollapsed, setCollapsed: setNavigationCollapsed } = useSystemNavigation();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [mobileView, setMobileView] = useState<"sessions" | "terminal">("sessions");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [backendStatus, setBackendStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [terminalStatus, setTerminalStatus] = useState("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [terminalSelection, setTerminalSelection] = useState<TerminalSelectionDisplay | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const terminalReconnectRef = useRef<(() => void) | null>(null);
  const submissionWaitersRef = useRef(new Map<string, (result: SubmissionResult) => void>());
  const sessionApiResponseRef = useRef("");
  const sessionApiStatusRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (mobileView === "terminal") return bindMobileTerminalViewport(window);
  }, [mobileView]);

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(API_ROOT + "/sessions", { headers: { Accept: "application/json" } });
      const rawResponse = await response.text();
      sessionApiResponseRef.current = rawResponse;
      sessionApiStatusRef.current = response.status;
      let result: { sessions?: unknown[]; error?: string };
      try {
        result = JSON.parse(rawResponse) as typeof result;
      } catch {
        throw new Error("The sessions API returned invalid JSON.");
      }
      if (!response.ok) throw new Error(result.error || "Request failed (" + response.status + ").");
      if (!Array.isArray(result.sessions)) throw new Error("The sessions API response has no session list.");
      const normalizedSessions = result.sessions.map(normalizeTmuxSession);
      if (normalizedSessions.some((session) => session === null)) {
        throw new Error("The sessions API returned an unrecognized session record.");
      }
      const sessionList = normalizedSessions as TmuxSession[];
      setSessions((current) => tmuxSessionsEqual(current, sessionList) ? current : sessionList);
      setBackendStatus("online");
      setError(null);
      setSelectedId((current) => current && sessionList.some((session) => session.id === current) ? current : null);
    } catch (loadError) {
      setBackendStatus("offline");
      setError(loadError instanceof Error ? loadError.message : "Could not load tmux sessions.");
    }
  }, []);

  const copySessionsApiResponse = async (): Promise<void> => {
    const rawResponse = sessionApiResponseRef.current;
    if (!rawResponse) {
      setToast({ message: "No sessions API response has been received yet.", isError: true });
      return;
    }
    let body: unknown = rawResponse;
    try {
      body = JSON.parse(rawResponse) as unknown;
    } catch {
      // Keep the original response text for non-JSON errors.
    }
    const payload = JSON.stringify({
      request: { method: "GET", url: window.location.origin + API_ROOT + "/sessions" },
      response: { status: sessionApiStatusRef.current, body },
    }, null, 2);
    try {
      await copyTextToClipboard(payload);
      setToast({ message: "Copied GET /tmux-dashboard/api/sessions request and response.", isError: false });
    } catch (copyError) {
      setToast({
        message: copyError instanceof Error ? copyError.message : "Could not copy the sessions API response.",
        isError: true,
      });
    }
  };

  const copyTerminalSelection = async (): Promise<void> => {
    if (!terminalSelection?.text) return;
    const selectedTerminal = terminalInstanceRef.current;
    try {
      await copyTextToClipboard(terminalSelection.text);
      if (selectedTerminal && terminalInstanceRef.current === selectedTerminal) {
        selectedTerminal.clearSelection();
        setTerminalSelection(null);
      }
      setToast({ message: "Copied terminal selection.", isError: false });
    } catch (copyError) {
      setToast({
        message: copyError instanceof Error ? copyError.message : "Could not copy terminal selection.",
        isError: true,
      });
    }
  };

  const exportScrollDiagnostics = (): void => {
    try {
      const count = downloadTerminalScrollDiagnostics();
      setToast({
        message: count > 0
          ? `Requested download of ${count} scroll diagnostic entries.`
          : "No scroll logs yet. Scroll the terminal first, then export.",
        isError: false,
      });
    } catch (exportError) {
      setToast({
        message: exportError instanceof Error ? exportError.message : "Could not export scroll diagnostics.",
        isError: true,
      });
    }
  };

  useEffect(() => {
    let cancelled = false;
    void requestApi<{ projects: ProjectOption[] }>("/projects")
      .then((result) => {
        if (cancelled) return;
        setProjects(result.projects);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load configured projects.");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (mobileView === "terminal") return;
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), SESSION_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadSessions, mobileView]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? sessions.filter((session) => `${session.name} ${session.cwd}`.toLowerCase().includes(query))
      : sessions;
  }, [search, sessions]);
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const selectSession = (sessionId: string): void => {
    setSelectedId(sessionId);
    if (window.matchMedia("(max-width: 760px)").matches) {
      setNavigationCollapsed(true);
      setMobileView("terminal");
    }
  };

  const showSessionsOnMobile = (): void => {
    setNavigationCollapsed(false);
    setMobileView("sessions");
  };

  const refreshSelectedSession = async (): Promise<void> => {
    setToast({ message: "正在刷新 session 连接…", isError: false });
    await loadSessions();
    terminalReconnectRef.current?.();
  };

  useEffect(() => {
    if (selectedId && !sessions.some((session) => session.id === selectedId)) setSelectedId(null);
  }, [sessions, selectedId]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!selectedSession || !host) {
      setTerminalStatus("IDLE");
      return;
    }

    const terminal = new Terminal({
      cursorBlink: false,
      cursorInactiveStyle: "none",
      disableStdin: true,
      convertEol: false,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      // The tmux PTY is the source of truth. Keep a bounded local buffer so
      // reconnects and redraws do not retain an unbounded TUI history.
      scrollback: 2_000,
      theme: {
        background: "#10141a",
        foreground: "#d8dee9",
        cursor: "#8de0bd",
        selectionBackground: "#41536b",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    try {
      terminal.loadAddon(new CanvasAddon());
    } catch (error) {
      console.warn("xterm canvas renderer unavailable; keeping the DOM renderer.", error);
    }
    if (terminal.textarea) {
      // This terminal is a read-only screen snapshot. Typing belongs in the composer.
      terminal.textarea.readOnly = true;
      terminal.textarea.inputMode = "none";
    }
    terminalInstanceRef.current = terminal;
    setTerminalSelection(null);
    const selectionChange = terminal.onSelectionChange(() => {
      if (!terminal.hasSelection()) setTerminalSelection(null);
    });

    const fitTerminal = (): void => {
      fit.fit();
      if (window.matchMedia("(max-width: 760px)").matches && terminal.element) {
        // FitAddon reserves 15px even for overlay scrollbars. Use the actual
        // mobile scrollbar width, keeping the terminal's scrollback enabled.
        const screen = host.querySelector<HTMLElement>(".xterm-screen");
        const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
        const cellWidth = (screen?.getBoundingClientRect().width ?? 0) / terminal.cols;
        if (viewport && Number.isFinite(cellWidth) && cellWidth > 0) {
          const style = getComputedStyle(terminal.element);
          const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
          const scrollbar = Math.max(0, viewport.offsetWidth - viewport.clientWidth);
          // Leave one pixel for canvas/device-pixel rounding.
          const cols = Math.max(2, Math.floor((host.clientWidth - padding - scrollbar - 1) / cellWidth));
          if (cols !== terminal.cols) terminal.resize(cols, terminal.rows);
        }
      }
    };
    fitTerminal();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const terminalAddress = (): string => `${protocol}//${window.location.host}/tmux-dashboard/terminal?session=${encodeURIComponent(selectedSession.id)}&cols=${terminal.cols}&rows=${terminal.rows}`;
    let socket: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer = 0;
    let reconnectAttempt = 0;
    let resizeFrame = 0;
    let forceResize = false;
    let keyboardResizePending = false;
    let keyboardCloseTimer = 0;
    let lastSentCols = 0;
    let lastSentRows = 0;
    let lastHostWidth = 0;
    let lastHostHeight = 0;
    const initialViewportHeight = window.visualViewport?.height ?? window.innerHeight;
    lastHostWidth = host.clientWidth;
    lastHostHeight = host.clientHeight;

    const isComposerFocused = (): boolean => {
      const activeElement = document.activeElement;
      return activeElement instanceof HTMLTextAreaElement
        && Boolean(activeElement.closest(".dashboard-composer"));
    };
    const isKeyboardOpen = (): boolean => {
      if (!isComposerFocused()) return false;
      const visualHeight = window.visualViewport?.height ?? window.innerHeight;
      return window.innerHeight < initialViewportHeight * 0.82
        || visualHeight < initialViewportHeight * 0.82;
    };

    const removeTouchScrolling = bindMobileTerminalTouch(host, terminal, setTerminalSelection);

    const writeTerminalOutput = (data: string | Uint8Array): void => terminal.write(data);

    const sendResize = (force = false): void => {
      const activeSocket = socket;
      if (activeSocket?.readyState !== WebSocket.OPEN) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (isKeyboardOpen()) {
        keyboardResizePending = true;
        return;
      }
      if (!force && width === lastHostWidth && height !== lastHostHeight && isComposerFocused()) return;
      try {
        const preserveViewport = terminal.buffer.active.viewportY < terminal.buffer.active.baseY;
        const previousViewportY = terminal.buffer.active.viewportY;
        fitTerminal();
        lastHostWidth = width;
        lastHostHeight = height;
        if (terminal.cols === lastSentCols && terminal.rows === lastSentRows) return;
        if (preserveViewport) terminal.scrollToLine(previousViewportY);
        activeSocket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        lastSentCols = terminal.cols;
        lastSentRows = terminal.rows;
      } catch {
        return;
      }
    };

    const resolvePendingSubmissions = (): void => {
      for (const resolve of submissionWaitersRef.current.values()) {
        resolve({ ok: false, message: "The terminal connection closed before delivery was confirmed." });
      }
      submissionWaitersRef.current.clear();
    };

    const scheduleResize = (force = false): void => {
      forceResize ||= force;
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        const shouldForce = forceResize;
        forceResize = false;
        sendResize(shouldForce);
      });
    };

    const scheduleReconnect = (): void => {
      if (disposed || reconnectTimer) return;
      if (navigator.onLine === false) {
        setTerminalStatus("OFFLINE");
        return;
      }
      const delay = Math.min(1_000 * 2 ** Math.min(reconnectAttempt, 4), 15_000);
      reconnectAttempt += 1;
      setTerminalStatus("RECONNECTING");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = 0;
        connect();
      }, delay);
    };

    function connect(): void {
      if (disposed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      if (navigator.onLine === false) {
        setTerminalStatus("OFFLINE");
        return;
      }
      setTerminalStatus("RECONNECTING");
      if (!isKeyboardOpen()) {
        fitTerminal();
        lastHostWidth = host!.clientWidth;
        lastHostHeight = host!.clientHeight;
      }
      const nextSocket = new WebSocket(terminalAddress());
      socket = nextSocket;
      terminalSocketRef.current = nextSocket;
      nextSocket.binaryType = "arraybuffer";
      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket) {
          nextSocket.close();
          return;
        }
        reconnectAttempt = 0;
        setTerminalStatus("ATTACHED");
        if (host!.clientWidth !== lastHostWidth || host!.clientHeight !== lastHostHeight) scheduleResize(true);
      };
      nextSocket.onmessage = (event) => {
        if (disposed || socket !== nextSocket) return;
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as {
              type?: string;
              message?: string;
              requestId?: string;
              ok?: boolean;
            };
            if (message.type === "submission-result" && typeof message.requestId === "string") {
              const resolve = submissionWaitersRef.current.get(message.requestId);
              if (resolve) {
                submissionWaitersRef.current.delete(message.requestId);
                resolve({
                  ok: message.ok === true,
                  ...(typeof message.message === "string" ? { message: message.message } : {}),
                });
              }
              return;
            }
            if (message.type === "error") {
              setTerminalStatus("ERROR");
              setToast({ message: message.message || "Could not attach to the selected session.", isError: true });
            } else if (message.type === "exit") {
              setTerminalStatus("DETACHED");
            }
          } catch {
            writeTerminalOutput(event.data);
          }
        } else if (event.data instanceof ArrayBuffer) {
          writeTerminalOutput(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((output) => {
            if (!disposed && socket === nextSocket) writeTerminalOutput(new Uint8Array(output));
          });
        }
      };
      nextSocket.onerror = () => {
        if (!disposed && socket === nextSocket) setTerminalStatus("RECONNECTING");
      };
      nextSocket.onclose = () => {
        if (socket === nextSocket) {
          socket = null;
          if (terminalSocketRef.current === nextSocket) terminalSocketRef.current = null;
        }
        resolvePendingSubmissions();
        if (!disposed) scheduleReconnect();
      };
    }

    const onWindowResize = (): void => {
      if (window.matchMedia("(max-width: 760px)").matches && host.clientWidth === lastHostWidth) return;
      scheduleResize(true);
    };
    const onViewportResize = (): void => {
      if (isKeyboardOpen()) {
        keyboardResizePending = true;
        return;
      }
      if (!keyboardResizePending) return;
      window.clearTimeout(keyboardCloseTimer);
      keyboardCloseTimer = window.setTimeout(() => {
        if (isKeyboardOpen()) return;
        keyboardResizePending = false;
        scheduleResize();
      }, 240);
    };
    const onComposerFocusOut = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.closest(".dashboard-composer")) return;
      window.clearTimeout(keyboardCloseTimer);
      keyboardCloseTimer = window.setTimeout(() => {
        const shouldResize = keyboardResizePending && !isComposerFocused();
        keyboardResizePending = false;
        if (shouldResize) scheduleResize(true);
      }, 240);
    };
    const reconnectNow = (): void => {
      if (disposed || document.visibilityState === "hidden") return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = 0;
      connect();
    };
    const forceReconnect = (): void => {
      if (disposed) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = 0;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, "manual refresh");
      } else {
        connect();
      }
    };
    const markOffline = (): void => {
      if (disposed) return;
      setTerminalStatus("OFFLINE");
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
    const resizeObserver = new ResizeObserver(() => {
      if (isKeyboardOpen()) {
        keyboardResizePending = true;
        return;
      }
      if (host.clientWidth === lastHostWidth) return;
      scheduleResize();
    });
    resizeObserver.observe(host);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("focusout", onComposerFocusOut, true);
    window.addEventListener("online", reconnectNow);
    window.addEventListener("offline", markOffline);
    document.addEventListener("visibilitychange", reconnectNow);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    terminalReconnectRef.current = forceReconnect;
    connect();
    scheduleResize(true);

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(keyboardCloseTimer);
      window.cancelAnimationFrame(resizeFrame);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("focusout", onComposerFocusOut, true);
      window.removeEventListener("online", reconnectNow);
      window.removeEventListener("offline", markOffline);
      document.removeEventListener("visibilitychange", reconnectNow);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      if (terminalReconnectRef.current === forceReconnect) terminalReconnectRef.current = null;
      resizeObserver.disconnect();
      resolvePendingSubmissions();
      selectionChange.dispose();
      if (terminalSocketRef.current === socket) terminalSocketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      socket = null;
      removeTouchScrolling();
      if (terminalInstanceRef.current === terminal) terminalInstanceRef.current = null;
      terminal.dispose();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.isError ? 8_000 : 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sendMessage = async (messageText: string): Promise<SubmissionResult> => {
    const socket = terminalSocketRef.current;
    if (!selectedSession) return { ok: false, message: "Select a tmux session first." };
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const message = "The terminal connection is closed.";
      setToast({ message, isError: true });
      return { ok: false, message };
    }
    if (sendingMessage) return { ok: false, message: "A message is already being sent." };
    if (!messageText.trim()) return { ok: false, message: "Enter a message or attach an image." };

    setSendingMessage(true);
    try {
      const requestId = ["submit", Date.now(), Math.random()].join("-");
      const result = await new Promise<SubmissionResult>((resolve) => {
        const timeout = window.setTimeout(() => {
          if (!submissionWaitersRef.current.has(requestId)) return;
          submissionWaitersRef.current.delete(requestId);
          resolve({ ok: false, message: "The session did not confirm message delivery." });
        }, 10_000);
        submissionWaitersRef.current.set(requestId, (response) => {
          window.clearTimeout(timeout);
          resolve(response);
        });
        try {
          if (socket.readyState !== WebSocket.OPEN) throw new Error("The terminal connection is closed.");
          socket.send(JSON.stringify({ type: "submit", requestId, text: messageText.trim() }));
        } catch (sendError) {
          submissionWaitersRef.current.delete(requestId);
          window.clearTimeout(timeout);
          resolve({
            ok: false,
            message: sendError instanceof Error ? sendError.message : "Could not send the message.",
          });
        }
      });
      if (!result.ok) {
        setToast({ message: result.message || "Could not send the message to the session.", isError: true });
        return result;
      }

      setToast({ message: "Message sent to “" + selectedSession.name + "”.", isError: false });
      return result;
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Could not send the message.";
      setToast({
        message,
        isError: true,
      });
      return { ok: false, message };
    } finally {
      setSendingMessage(false);
    }
  };

  const showAttachmentError = useCallback((message: string): void => {
    setToast({ message, isError: true });
  }, []);

  const sendTerminalShortcut = async (shortcut: TerminalShortcut): Promise<void> => {
    const socket = terminalSocketRef.current;
    if (!selectedSession || !socket || socket.readyState !== WebSocket.OPEN) {
      setToast({ message: "The terminal connection is closed.", isError: true });
      return;
    }

    const requestId = ["shortcut", Date.now(), Math.random()].join("-");
    const result = await new Promise<SubmissionResult>((resolve) => {
      const timeout = window.setTimeout(() => {
        if (!submissionWaitersRef.current.has(requestId)) return;
        submissionWaitersRef.current.delete(requestId);
        resolve({ ok: false, message: "The session did not confirm the shortcut." });
      }, 5_000);
      submissionWaitersRef.current.set(requestId, (response) => {
        window.clearTimeout(timeout);
        resolve(response);
      });
      try {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("The terminal connection is closed.");
        socket.send(JSON.stringify({ type: "key", requestId, key: shortcut }));
      } catch (error) {
        submissionWaitersRef.current.delete(requestId);
        window.clearTimeout(timeout);
        resolve({ ok: false, message: error instanceof Error ? error.message : "Could not send the shortcut." });
      }
    });
    if (!result.ok) {
      setToast({
        message: result.message || "Could not send the shortcut.",
        isError: true,
      });
    }
  };

  const sendTerminalSequence = async (sequence: string): Promise<void> => {
    const socket = terminalSocketRef.current;
    if (!selectedSession || !socket || socket.readyState !== WebSocket.OPEN) {
      setToast({ message: "The terminal connection is closed.", isError: true });
      return;
    }
    const requestId = ["sequence", Date.now(), Math.random()].join("-");
    const result = await new Promise<SubmissionResult>((resolve) => {
      const timeout = window.setTimeout(() => {
        if (!submissionWaitersRef.current.has(requestId)) return;
        submissionWaitersRef.current.delete(requestId);
        resolve({ ok: false, message: "The session did not confirm the control-key sequence." });
      }, 5_000);
      submissionWaitersRef.current.set(requestId, (response) => {
        window.clearTimeout(timeout);
        resolve(response);
      });
      try {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("The terminal connection is closed.");
        socket.send(JSON.stringify({ type: "sequence", requestId, data: sequence }));
      } catch (error) {
        submissionWaitersRef.current.delete(requestId);
        window.clearTimeout(timeout);
        resolve({ ok: false, message: error instanceof Error ? error.message : "Could not send the control-key sequence." });
      }
    });
    if (!result.ok) {
      setToast({ message: result.message || "Could not send the control-key sequence.", isError: true });
    }
  };

  const openCreateDialog = (): void => {
    setNewName(createSessionName());
    setNewProjectName(projects[0]?.name || "");
    setCreateOpen(true);
  };

  const createSession = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const targetProject = projects.find((item) => item.name === newProjectName);
    if (!targetProject) return;
    setCreateBusy(true);
    try {
      const result = await requestApi<{ session: TmuxSession }>("/sessions", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), projectKey: targetProject.name }),
      });
      setCreateOpen(false);
      if (window.matchMedia("(max-width: 760px)").matches) {
        setNavigationCollapsed(true);
        setMobileView("terminal");
      }
      setSessions((current) => [result.session, ...current.filter((session) => session.id !== result.session.id)]);
      setSelectedId(result.session.id);
      setToast({ message: `Session “${result.session.name}” created.`, isError: false });
      void loadSessions();
    } catch (createError) {
      setToast({ message: createError instanceof Error ? createError.message : "Could not create session.", isError: true });
    } finally {
      setCreateBusy(false);
    }
  };

  const endSession = async (): Promise<void> => {
    if (!selectedSession || !window.confirm(`End “${selectedSession.name}” and close all attached clients?`)) return;
    try {
      await requestApi<void>(`/sessions/${encodeURIComponent(selectedSession.id)}`, { method: "DELETE" });
      setSelectedId(null);
      if (window.matchMedia("(max-width: 760px)").matches) {
        setMobileView("sessions");
      } else {
        await loadSessions();
      }
      setToast({ message: `Session “${selectedSession.name}” ended.`, isError: false });
    } catch (endError) {
      setToast({ message: endError instanceof Error ? endError.message : "Could not end session.", isError: true });
    }
  };

  const connectionMessage = terminalStatus === "OFFLINE"
    ? "当前网络不可用，消息不会发送，输入内容会保留。"
    : terminalStatus === "RECONNECTING"
      ? "Session 连接中断，正在自动重连；请等待连接恢复。"
      : terminalStatus === "ERROR"
        ? "Session 连接发生错误，可以手动刷新连接。"
        : "Session 已断开，可以手动刷新连接。";
  const showConnectionBanner = Boolean(selectedSession) && terminalStatus !== "ATTACHED" && terminalStatus !== "IDLE";

  return (
    <main className={`dashboard-page${mobileView === "terminal" ? " is-mobile-terminal" : ""}${navigationCollapsed ? " is-navigation-collapsed" : ""}`}>
      {error ? <div className="dashboard-error" role="alert">{error}</div> : null}
      <section className={`dashboard-main is-mobile-${mobileView}`}>
        <aside className="dashboard-sidebar">
          <div className="dashboard-sidebar-heading">
            <div><span className="dashboard-eyebrow">WORKSPACES</span><h2>Sessions <span>{sessions.length}</span></h2></div>
            <div className="dashboard-session-tools">
              <span className={`dashboard-backend dashboard-backend-${backendStatus}`}>{backendStatus.toUpperCase()}</span>
              <button className="dashboard-action" type="button" onClick={() => void loadSessions()}>Refresh</button>
              {import.meta.env.DEV ? (
                <button
                  className="dashboard-action dashboard-copy-api"
                  type="button"
                  onClick={() => void copySessionsApiResponse()}
                  aria-label="Copy the latest sessions API request and response"
                  title="Copy the latest sessions API request and response"
                >⧉</button>
              ) : null}
              <button className="dashboard-add" type="button" onClick={openCreateDialog} disabled={projects.length === 0} aria-label="Create session">+</button>
            </div>
          </div>
          <label className="dashboard-filter">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              aria-label="筛选 session"
              placeholder="Filter sessions"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setSelectedId(null); }}
            />
          </label>
          <div className="dashboard-session-list" aria-live="polite">
            {sessions.length === 0 && backendStatus === "online" ? <p className="dashboard-empty-list">No local tmux sessions.</p> : null}
            {sessions.length > 0 && filteredSessions.length === 0 ? <p className="dashboard-empty-list">No matching sessions.</p> : null}
            {filteredSessions.map((session) => (
              <button key={session.id} className={`dashboard-session-card${selectedId === session.id ? " is-selected" : ""}`} type="button" onClick={() => selectSession(session.id)} aria-current={selectedId === session.id ? "true" : undefined}>
                <span className="dashboard-session-top"><strong>{session.name}</strong><span className={session.attachedClients > 0 ? "is-active" : ""} title={session.attachedClients > 0 ? "Attached" : "Detached"} /></span>
                <span className="dashboard-session-path" title={session.cwd}>{session.cwd}</span>
                <span className="dashboard-session-meta">{session.windows} {session.windows === 1 ? "window" : "windows"}<span>{session.attachedClients > 0 ? `${session.attachedClients} attached` : "detached"}</span></span>
              </button>
            ))}
          </div>
          <div className="dashboard-sidebar-footer"><span />Connected to your local tmux</div>
        </aside>
        <section className="dashboard-workspace" aria-label="Session terminal">
          <div className="dashboard-workspace-toolbar">
            <button className="dashboard-mobile-back" type="button" onClick={showSessionsOnMobile} aria-label="Back to sessions">‹</button>
            <div className="dashboard-active-session"><span className="dashboard-terminal-glyph">⌘</span><div><strong>{selectedSession?.name ?? "No session selected"}</strong><span title={selectedSession?.cwd}>{selectedSession?.cwd ?? "Choose a session to open its terminal"}</span></div></div>
            <div className="dashboard-terminal-actions"><span className={terminalStatus === "ATTACHED" ? "is-connected" : ""}>{selectedSession ? terminalStatus : "IDLE"}</span><button type="button" onClick={() => void refreshSelectedSession()} disabled={!selectedSession}>Refresh session</button><button type="button" onClick={() => void endSession()} disabled={!selectedSession}>End session</button></div>
          </div>
          {showConnectionBanner ? (
            <div className={`dashboard-connection-banner is-${terminalStatus.toLowerCase()}`} role="alert">
              <span>{connectionMessage}</span>
              <button type="button" onClick={() => void refreshSelectedSession()} disabled={!selectedSession}>立即刷新</button>
            </div>
          ) : null}
          <div className={`dashboard-terminal-frame${selectedSession ? "" : " is-empty"}`}>
            {selectedSession && terminalSelection?.text ? (
              <button
                className="dashboard-terminal-copy-selection"
                type="button"
                onClick={() => void copyTerminalSelection()}
                style={{ left: terminalSelection.left, top: terminalSelection.top }}
                aria-label="Copy selected terminal text"
              >Copy</button>
            ) : null}
            {selectedSession ? <div className="dashboard-terminal-host" ref={terminalHostRef} /> : (
              <div className="dashboard-empty-state"><div>&gt;_</div><h2>No session selected</h2><p>Choose a session from the list to attach its terminal.</p><button type="button" onClick={openCreateDialog} disabled={projects.length === 0}>+ New session</button></div>
            )}
          </div>
          <TmuxMessageComposer
            key={selectedSession?.id ?? "no-session"}
            sessionId={selectedSession?.id ?? null}
            diagnosticSessionActive={Boolean(selectedSession) && mobileView === "terminal" && terminalStatus === "ATTACHED"}
            disabled={!selectedSession || terminalStatus !== "ATTACHED"}
            sending={sendingMessage}
            placeholder={selectedSession ? "Message the Codex session…" : "Select a session to start messaging"}
            onSubmit={sendMessage}
            onAttachmentError={showAttachmentError}
            onTerminalShortcut={sendTerminalShortcut}
            onTerminalSequence={sendTerminalSequence}
            onScrollToTop={() => terminalInstanceRef.current?.scrollToTop()}
            onScrollToBottom={() => terminalInstanceRef.current?.scrollToBottom()}
            onExportScrollDiagnostics={exportScrollDiagnostics}
          />
          <footer className="dashboard-workspace-footer"><span>Read-only tmux view</span><span>Messages and images go to the selected Codex session</span></footer>
        </section>
      </section>
      {createOpen ? (
        <div className="dashboard-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
          <form className="dashboard-modal" onSubmit={(event) => void createSession(event)}>
            <div className="dashboard-modal-heading"><div><p className="dashboard-eyebrow">NEW WORKSPACE</p><h2>Create a tmux session</h2></div><button type="button" onClick={() => setCreateOpen(false)} aria-label="Close">×</button></div>
            <label className="dashboard-modal-field">Session name<input value={newName} onChange={(event) => setNewName(event.target.value)} required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" autoComplete="off" /></label>
            <label className="dashboard-modal-field">Working directory<select value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} required>{projects.map((item) => <option key={item.name} value={item.name}>{item.name} — {item.root}</option>)}</select></label>
            <div className="dashboard-modal-actions"><button className="dashboard-action" type="button" onClick={() => setCreateOpen(false)}>Cancel</button><button className="dashboard-submit" type="submit" disabled={createBusy || !newProjectName}>{createBusy ? "Creating…" : "Create session"}</button></div>
          </form>
        </div>
      ) : null}
      {toast ? <div className={`dashboard-toast${toast.isError ? " is-error" : ""}`} role="status">{toast.message}</div> : null}
    </main>
  );
}
