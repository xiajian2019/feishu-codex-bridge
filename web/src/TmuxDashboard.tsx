import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router";

import { bindMobileTerminalViewport } from "./mobile-terminal-viewport.js";
import { isDebugLogCaptureActive, logDebugDiagnostic } from "./debug-log-capture.js";

import { bindMobileTerminalTouch, downloadTerminalScrollDiagnostics, type TerminalSelectionDisplay } from "./terminal-touch.js";
import { TmuxMessageComposer, type SessionFileForwardRequest, type TerminalShortcut } from "./TmuxMessageComposer.js";
import { getActionToken } from "./api.js";
import { useSystemNavigation } from "./WebNavigation.js";

type TmuxSession = {
  id: string;
  name: string;
  windows: number;
  attachedClients: number;
  cwd: string;
  createdAt: number;
  codexHomeId: string | null;
};

type ProjectOption = { name: string; root: string };
type CodexHomeOption = { id: string; label: string; available: boolean };
type Toast = { message: string; isError: boolean };
type SubmissionResult = { ok: boolean; message?: string };

function CodexHomeSelect({
  session,
  homes,
  disabled,
  onChange,
}: {
  session: TmuxSession;
  homes: CodexHomeOption[];
  disabled?: boolean;
  onChange: (session: TmuxSession, homeId: string | null) => void;
}): ReactElement {
  const known = homes.some((home) => home.id === session.codexHomeId);
  return (
    <select
      className="dashboard-codex-home-select"
      aria-label={`${session.name} Codex 账号`}
      title="选择此 Session 的 Codex 账号；新启动的 Codex 进程使用此 Home"
      value={session.codexHomeId ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(session, event.target.value || null)}
    >
      <option value="">未标记</option>
      {session.codexHomeId && !known ? <option value={session.codexHomeId}>已保存账号（不可用）</option> : null}
      {homes.map((home) => (
        <option key={home.id} value={home.id} disabled={!home.available}>
          {home.label}{home.available ? "" : "（不可用）"}
        </option>
      ))}
    </select>
  );
}

const API_ROOT = "/tmux-dashboard/api";
const SESSION_REFRESH_INTERVAL_MS = 5_000;

async function requestApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  if (options.method?.toUpperCase() === "POST" && path.includes("/codex-account")) {
    headers.set("X-Bridge-Action-Token", await getActionToken());
  }
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
  const codexHomeId = record.codexHomeId ?? record.codex_home_id ?? null;

  if (
    id
    && typeof name === "string"
    && Number.isFinite(windows)
    && Number.isFinite(attachedClients)
    && typeof cwd === "string"
    && Number.isFinite(createdAt)
  ) {
    return {
      id,
      name,
      windows,
      attachedClients,
      cwd,
      createdAt,
      codexHomeId: typeof codexHomeId === "string" ? codexHomeId : null,
    };
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
    codexHomeId: null,
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
      && next.createdAt === session.createdAt
      && next.codexHomeId === session.codexHomeId;
  });
}

function createSessionName(): string {
  const stamp = new Date().toISOString();
  return `session-${stamp.slice(5, 10).replace("-", "")}-${stamp.slice(11, 16).replace(":", "")}`;
}

function summarizeUnicodeText(value: string): Record<string, number> {
  let codePoints = 0;
  let nonAsciiCodePoints = 0;
  let cjkCodePoints = 0;
  let replacementCodePoints = 0;
  let hyphenCodePoints = 0;
  let underscoreCodePoints = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    codePoints += 1;
    if (codePoint > 0x7f) nonAsciiCodePoints += 1;
    if (
      (codePoint >= 0x3400 && codePoint <= 0x9fff)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0x20000 && codePoint <= 0x3134f)
    ) cjkCodePoints += 1;
    if (codePoint === 0xfffd) replacementCodePoints += 1;
    if (codePoint === 0x2d) hyphenCodePoints += 1;
    if (codePoint === 0x5f) underscoreCodePoints += 1;
  }

  return {
    codePoints,
    utf8Bytes: new TextEncoder().encode(value).byteLength,
    nonAsciiCodePoints,
    cjkCodePoints,
    replacementCodePoints,
    hyphenCodePoints,
    underscoreCodePoints,
  };
}

export function TmuxDashboard(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { collapsed: navigationCollapsed, setCollapsed: setNavigationCollapsed } = useSystemNavigation();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [codexHomes, setCodexHomes] = useState<CodexHomeOption[]>([]);
  const [savingCodexHomeId, setSavingCodexHomeId] = useState<string | null>(null);
  const [checkingCodexHomeId, setCheckingCodexHomeId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"sessions" | "terminal">("sessions");
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("session"));
  const [sessionFileForward, setSessionFileForward] = useState<SessionFileForwardRequest | null>(() => {
    const state = location.state as { sessionFileForward?: unknown } | null;
    const request = state?.sessionFileForward;
    if (typeof request !== "object" || request === null) return null;
    const candidate = request as Record<string, unknown>;
    return typeof candidate.id === "string"
      && typeof candidate.sessionId === "string"
      && typeof candidate.text === "string"
      ? { id: candidate.id, sessionId: candidate.sessionId, text: candidate.text }
      : null;
  });
  const [search, setSearch] = useState("");
  const [backendStatus, setBackendStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [terminalStatus, setTerminalStatus] = useState("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectActiveIndex, setProjectActiveIndex] = useState(0);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [terminalSelection, setTerminalSelection] = useState<TerminalSelectionDisplay | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const terminalReconnectRef = useRef<(() => void) | null>(null);
  const submissionWaitersRef = useRef(new Map<string, (result: SubmissionResult) => void>());
  const sessionApiResponseRef = useRef("");
  const sessionApiStatusRef = useRef<number | null>(null);
  const restoreSessionDetailRef = useRef(new URLSearchParams(window.location.search).has("session"));

  useEffect(() => {
    const state = location.state as { sessionFileForward?: unknown } | null;
    if (!state?.sessionFileForward) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  useLayoutEffect(() => {
    if (mobileView === "terminal") return bindMobileTerminalViewport(window);
  }, [mobileView]);

  useLayoutEffect(() => {
    const detailClass = "tmux-terminal-detail";
    const mobileDetailRequested = restoreSessionDetailRef.current && window.matchMedia("(max-width: 760px)").matches;
    document.documentElement.classList.toggle(detailClass, mobileView === "terminal" || mobileDetailRequested);
    return () => document.documentElement.classList.remove(detailClass);
  }, [mobileView]);

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(API_ROOT + "/sessions", { headers: { Accept: "application/json" } });
      const rawResponse = await response.text();
      sessionApiResponseRef.current = rawResponse;
      sessionApiStatusRef.current = response.status;
      let result: { sessions?: unknown[]; codexHomes?: unknown[]; error?: string };
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
      const homeOptions = Array.isArray(result.codexHomes)
        ? result.codexHomes.flatMap((value): CodexHomeOption[] => {
          if (typeof value !== "object" || value === null) return [];
          const home = value as Record<string, unknown>;
          return typeof home.id === "string" && typeof home.label === "string"
            ? [{ id: home.id, label: home.label, available: home.available === true }]
            : [];
        })
        : [];
      setCodexHomes((current) => current.length === homeOptions.length
        && current.every((home, index) => home.id === homeOptions[index]?.id
          && home.label === homeOptions[index]?.label
          && home.available === homeOptions[index]?.available)
        ? current
        : homeOptions);
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
    if (!projectPickerOpen) return;
    const closeProjectPicker = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || projectPickerRef.current?.contains(event.target)) return;
      setProjectPickerOpen(false);
      setProjectQuery("");
      setProjectActiveIndex(-1);
    };
    document.addEventListener("pointerdown", closeProjectPicker);
    return () => document.removeEventListener("pointerdown", closeProjectPicker);
  }, [projectPickerOpen]);

  useEffect(() => {
    if (!projectPickerOpen || projectActiveIndex < 0) return;
    document.getElementById(`dashboard-project-option-${projectActiveIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [projectActiveIndex, projectPickerOpen]);

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
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    return query
      ? projects.filter((project) => `${project.name} ${project.root}`.toLowerCase().includes(query))
      : projects;
  }, [projectQuery, projects]);
  const selectedProject = projects.find((project) => project.name === newProjectName) ?? null;
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const selectedCodexHomeLabel = selectedSession
    ? codexHomes.find((home) => home.id === selectedSession.codexHomeId)?.label
      ?? (selectedSession.codexHomeId ? "账号不可用" : "未标记")
    : "";
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
    if (backendStatus !== "online" || !selectedId || sessions.some((session) => session.id === selectedId)) return;
    setSelectedId(null);
    setMobileView("sessions");
    setNavigationCollapsed(false);
  }, [backendStatus, sessions, selectedId, setNavigationCollapsed]);

  useEffect(() => {
    if (!restoreSessionDetailRef.current || backendStatus !== "online") return;
    restoreSessionDetailRef.current = false;
    if (selectedId && sessions.some((session) => session.id === selectedId) && window.matchMedia("(max-width: 760px)").matches) {
      setMobileView("terminal");
      setNavigationCollapsed(true);
    }
  }, [backendStatus, sessions, selectedId, setNavigationCollapsed]);

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

    const diagnosticOutputDecoder = new TextDecoder("utf-8");
    let lastTerminalRenderDiagnosticAt = 0;
    const writeTerminalOutput = (data: string | Uint8Array): void => {
      const decodedOutput = typeof data === "string" ? data : diagnosticOutputDecoder.decode(data, { stream: true });
      const outputMetrics = summarizeUnicodeText(decodedOutput);
      const rawBytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      let highBitBytes = 0;
      for (const byte of rawBytes) if (byte >= 0x80) highBitBytes += 1;

      terminal.write(data, () => {
        if (!isDebugLogCaptureActive()) return;
        const now = Date.now();
        if (now - lastTerminalRenderDiagnosticAt < 750) return;
        lastTerminalRenderDiagnosticAt = now;

        const buffer = terminal.buffer.active;
        let visibleText = "";
        for (let row = 0; row < terminal.rows; row += 1) {
          const line = buffer.getLine(buffer.viewportY + row);
          if (line) visibleText += line.translateToString(true) + "\n";
        }
        const fontFamily = terminal.element ? getComputedStyle(terminal.element).fontFamily : "unknown";
        logDebugDiagnostic("tmux-terminal", "render-sample", {
          transportType: typeof data === "string" ? "websocket-text" : "websocket-binary",
          payloadBytes: rawBytes.byteLength,
          highBitBytes,
          output: outputMetrics,
          buffer: { ...summarizeUnicodeText(visibleText), type: buffer.type, viewportY: buffer.viewportY, baseY: buffer.baseY },
          renderer: host.querySelector(".xterm-canvas") ? "canvas" : "dom",
          fontFamily,
          devicePixelRatio: window.devicePixelRatio,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      });
    };

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
        resolve({ ok: false, message: "终端连接已断开，消息可能已经送达；请先检查 Session，再决定是否重发。" });
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
      logDebugDiagnostic("tmux-submit", "client-send", summarizeUnicodeText(messageText));
      const result = await new Promise<SubmissionResult>((resolve) => {
        const timeout = window.setTimeout(() => {
          if (!submissionWaitersRef.current.has(requestId)) return;
          submissionWaitersRef.current.delete(requestId);
          resolve({ ok: false, message: "等待确认超时，消息可能已经送达；请先检查 Session，避免重复发送。" });
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
      logDebugDiagnostic("tmux-submit", "client-result", { ok: result.ok, message: result.message ?? null, ...summarizeUnicodeText(messageText) });
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

  const sendTerminalCommand = async (command: string): Promise<SubmissionResult> => {
    const socket = terminalSocketRef.current;
    if (!selectedSession || !socket || socket.readyState !== WebSocket.OPEN) {
      const result = { ok: false, message: "The terminal connection is closed." };
      setToast({ message: result.message, isError: true });
      return result;
    }

    const requestId = ["command", Date.now(), Math.random()].join("-");
    const result = await new Promise<SubmissionResult>((resolve) => {
      const timeout = window.setTimeout(() => {
        if (!submissionWaitersRef.current.has(requestId)) return;
        submissionWaitersRef.current.delete(requestId);
        resolve({ ok: false, message: "The terminal did not accept the command." });
      }, 5_000);
      submissionWaitersRef.current.set(requestId, (response) => {
        window.clearTimeout(timeout);
        resolve(response);
      });
      try {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("The terminal connection is closed.");
        socket.send(JSON.stringify({ type: "command", requestId, text: command.trim() }));
      } catch (error) {
        submissionWaitersRef.current.delete(requestId);
        window.clearTimeout(timeout);
        resolve({ ok: false, message: error instanceof Error ? error.message : "Could not send the command." });
      }
    });
    if (!result.ok) {
      setToast({
        message: result.message || "Could not send the command to the session.",
        isError: true,
      });
    }
    return result;
  };

  const sendTerminalShortcut = async (shortcut: TerminalShortcut): Promise<SubmissionResult> => {
    const socket = terminalSocketRef.current;
    if (!selectedSession || !socket || socket.readyState !== WebSocket.OPEN) {
      setToast({ message: "The terminal connection is closed.", isError: true });
      return { ok: false, message: "The terminal connection is closed." };
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
    return result;
  };

  const sendTerminalSequence = async (sequence: string): Promise<SubmissionResult> => {
    const socket = terminalSocketRef.current;
    if (!selectedSession || !socket || socket.readyState !== WebSocket.OPEN) {
      setToast({ message: "The terminal connection is closed.", isError: true });
      return { ok: false, message: "The terminal connection is closed." };
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
    return result;
  };

  const openCreateDialog = (): void => {
    setNewName(createSessionName());
    setNewProjectName(projects[0]?.name || "");
    setProjectQuery("");
    setProjectPickerOpen(false);
    setProjectActiveIndex(0);
    setCreateOpen(true);
  };

  const openProjectPicker = (): void => {
    setProjectQuery("");
    setProjectActiveIndex(Math.max(0, projects.findIndex((project) => project.name === newProjectName)));
    setProjectPickerOpen(true);
  };

  const selectProject = (project: ProjectOption): void => {
    setNewProjectName(project.name);
    setProjectQuery("");
    setProjectPickerOpen(false);
    setProjectActiveIndex(-1);
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

  const endSession = async (session: TmuxSession | null = selectedSession): Promise<void> => {
    if (!session || !window.confirm(`确认终结 Session「${session.name}」？这会关闭所有已连接的客户端。`)) return;
    try {
      await requestApi<void>(`/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      const wasSelected = selectedId === session.id;
      if (wasSelected) setSelectedId(null);
      if (wasSelected && window.matchMedia("(max-width: 760px)").matches) {
        setMobileView("sessions");
        setNavigationCollapsed(false);
      }
      await loadSessions();
      setToast({ message: `Session「${session.name}」已终结。`, isError: false });
    } catch (endError) {
      setToast({ message: endError instanceof Error ? endError.message : "无法终结 Session。", isError: true });
    }
  };

  const updateCodexHome = async (session: TmuxSession, homeId: string | null): Promise<void> => {
    setSavingCodexHomeId(session.id);
    try {
      await requestApi(`/sessions/${encodeURIComponent(session.id)}/codex-account`, {
        method: "POST",
        body: JSON.stringify({ homeId }),
      });
      await loadSessions();
      setToast({
        message: homeId
          ? `已将「${session.name}」设为该 Codex 账号；只影响此 Session 后续启动的 Codex。`
          : `已清除「${session.name}」的 Codex 账号标记。`,
        isError: false,
      });
    } catch (saveError) {
      setToast({ message: saveError instanceof Error ? saveError.message : "无法更新 Codex 账号。", isError: true });
    } finally {
      setSavingCodexHomeId(null);
    }
  };

  const checkCodexHome = async (session: TmuxSession): Promise<void> => {
    setCheckingCodexHomeId(session.id);
    try {
      const result = await requestApi<{
        status: "matched" | "unmatched" | "running" | "not-running" | "unavailable";
        home: { id: string; label: string } | null;
      }>(`/sessions/${encodeURIComponent(session.id)}/codex-account/check`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (result.status === "matched" && result.home) {
        await loadSessions();
        setToast({ message: `检测到当前 pane 使用「${result.home.label}」，账号标记已同步。`, isError: false });
      } else if (result.status === "not-running") {
        setToast({ message: `「${session.name}」当前 pane 没有运行中的 Codex。`, isError: true });
      } else if (result.status === "unmatched") {
        setToast({ message: "检测到 Codex，但当前 Home 不在已发现的账号列表中；请手动选择账号。", isError: true });
      } else {
        setToast({ message: "无法读取当前 pane 的 Codex Home；请手动选择账号标记。", isError: true });
      }
    } catch (checkError) {
      setToast({ message: checkError instanceof Error ? checkError.message : "检查 Codex 账号失败。", isError: true });
    } finally {
      setCheckingCodexHomeId(null);
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
              <button
                className="dashboard-action dashboard-history-top"
                type="button"
                onClick={() => navigate("/tmux-dashboard/history")}
                aria-label="查看 Session 操作历史"
                title="查看 Session 操作历史"
              >历史</button>
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
            <span className="dashboard-filter-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <circle cx="10.75" cy="10.75" r="6.25" />
                <path d="m15.5 15.5 4.25 4.25" />
              </svg>
            </span>
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
              <div key={session.id} className={`dashboard-session-entry${selectedId === session.id ? " is-selected" : ""}`}>
                <button className="dashboard-session-card" type="button" onClick={() => selectSession(session.id)} aria-current={selectedId === session.id ? "true" : undefined}>
                  <span className="dashboard-session-top"><strong>{session.name}</strong><span className={session.attachedClients > 0 ? "is-active" : ""} title={session.attachedClients > 0 ? "Attached" : "Detached"} /></span>
                  <span className="dashboard-session-path" title={session.cwd}>{session.cwd}</span>
                  <span className="dashboard-session-meta">{session.windows} {session.windows === 1 ? "window" : "windows"}<span>{session.attachedClients > 0 ? `${session.attachedClients} attached` : "detached"}</span></span>
                </button>
                <div className="dashboard-session-actions" aria-label={`${session.name} 操作`}>
                  <CodexHomeSelect
                    session={session}
                    homes={codexHomes}
                    disabled={savingCodexHomeId === session.id}
                    onChange={(target, homeId) => { void updateCodexHome(target, homeId); }}
                  />
                  <button type="button" onClick={() => selectSession(session.id)}>详情</button>
                  <button type="button" onClick={() => navigate(`/tmux-dashboard/history?session=${encodeURIComponent(session.id)}`)}>历史</button>
                  <button className="dashboard-session-end" type="button" onClick={() => void endSession(session)}>终结</button>
                </div>
              </div>
            ))}
          </div>
          <div className="dashboard-sidebar-footer"><span />Connected to your local tmux</div>
        </aside>
        <section className="dashboard-workspace" aria-label="Session terminal">
          <div className="dashboard-workspace-toolbar">
            <button className="dashboard-mobile-back" type="button" onClick={showSessionsOnMobile} aria-label="Back to sessions">‹</button>
            <div className="dashboard-active-session"><span className="dashboard-terminal-glyph">⌘</span><div><strong>{selectedSession?.name ?? "No session selected"}</strong><span title={selectedSession?.cwd}>{selectedSession?.cwd ?? "Choose a session to open its terminal"}</span></div></div>
            {selectedSession ? (
              <div className="dashboard-codex-inline" aria-label="Session 账号与操作">
                <span className="dashboard-codex-home-label" title={selectedCodexHomeLabel}>{selectedCodexHomeLabel}</span>
                <details className="dashboard-codex-actions">
                  <summary aria-label="Session 操作" title="Session 操作">⌄</summary>
                  <div className="dashboard-codex-actions-panel">
                    <button type="button" onClick={() => navigate(`/tmux-dashboard/history?session=${encodeURIComponent(selectedSession.id)}`)}>
                      查看历史（当前 Session）
                    </button>
                    <CodexHomeSelect
                      session={selectedSession}
                      homes={codexHomes}
                      disabled={savingCodexHomeId === selectedSession.id}
                      onChange={(target, homeId) => { void updateCodexHome(target, homeId); }}
                    />
                    <button type="button" disabled={checkingCodexHomeId === selectedSession.id} onClick={() => void checkCodexHome(selectedSession)}>
                      {checkingCodexHomeId === selectedSession.id ? "检查中…" : "刷新账号"}
                    </button>
                    <button type="button" onClick={() => void refreshSelectedSession()}>刷新 Session</button>
                    <button className="dashboard-session-end" type="button" onClick={() => void endSession(selectedSession)}>终结 Session</button>
                  </div>
                </details>
              </div>
            ) : null}
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
            sessionFileForward={selectedSession?.id === sessionFileForward?.sessionId ? sessionFileForward : null}
            onSessionFileForwardConsumed={(requestId) => {
              setSessionFileForward((current) => current?.id === requestId ? null : current);
            }}
            diagnosticSessionActive={Boolean(selectedSession) && mobileView === "terminal" && terminalStatus === "ATTACHED"}
            disabled={!selectedSession || terminalStatus !== "ATTACHED"}
            sending={sendingMessage}
            placeholder={selectedSession ? "Message the Codex session…" : "Select a session to start messaging"}
            onSubmit={sendMessage}
            onAttachmentError={showAttachmentError}
            onOpenFiles={() => {
              if (selectedSession) navigate(`/tmux-dashboard/files/${encodeURIComponent(selectedSession.id)}`);
            }}
            onSubmitCommand={sendTerminalCommand}
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
            <div className="dashboard-modal-field">
              <label htmlFor="dashboard-project-search">Working directory</label>
              <div className="dashboard-project-picker" ref={projectPickerRef}>
                <input
                  id="dashboard-project-search"
                  type="text"
                  role="combobox"
                  aria-label="Working directory"
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  aria-required="true"
                  aria-expanded={projectPickerOpen}
                  aria-controls="dashboard-project-options"
                  aria-activedescendant={projectPickerOpen && filteredProjects[projectActiveIndex] ? `dashboard-project-option-${projectActiveIndex}` : undefined}
                  autoComplete="off"
                  placeholder="Type to filter projects…"
                  value={projectPickerOpen ? projectQuery : selectedProject?.name ?? ""}
                  onFocus={openProjectPicker}
                  onChange={(event) => {
                    setProjectQuery(event.currentTarget.value);
                    setProjectActiveIndex(0);
                    if (event.currentTarget.value) setNewProjectName("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      if (!projectPickerOpen) {
                        openProjectPicker();
                        return;
                      }
                      if (filteredProjects.length === 0) return;
                      setProjectActiveIndex((current) => Math.max(0, Math.min(filteredProjects.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
                    } else if (event.key === "Enter" && projectPickerOpen) {
                      event.preventDefault();
                      const activeProject = filteredProjects[projectActiveIndex];
                      if (activeProject) selectProject(activeProject);
                    } else if (event.key === "Escape" && projectPickerOpen) {
                      event.preventDefault();
                      setProjectPickerOpen(false);
                      setProjectQuery("");
                      setProjectActiveIndex(-1);
                    }
                  }}
                />
                <button
                  className="dashboard-project-picker-toggle"
                  type="button"
                  aria-label={projectPickerOpen ? "Close project options" : "Show project options"}
                  aria-expanded={projectPickerOpen}
                  onClick={() => {
                    if (projectPickerOpen) {
                      setProjectPickerOpen(false);
                      setProjectQuery("");
                      setProjectActiveIndex(-1);
                    } else {
                      openProjectPicker();
                    }
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
                {projectPickerOpen ? (
                  <div className="dashboard-project-option-list" id="dashboard-project-options" role="listbox" aria-label="Working directory options">
                    {filteredProjects.length === 0 ? (
                      <div className="dashboard-project-option-empty" role="option" aria-selected="false" aria-disabled="true">No matching projects.</div>
                    ) : filteredProjects.map((project, index) => (
                      <button
                        className={`dashboard-project-option${newProjectName === project.name ? " is-selected" : ""}${projectActiveIndex === index ? " is-active" : ""}`}
                        id={`dashboard-project-option-${index}`}
                        key={project.name}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={newProjectName === project.name}
                        onClick={() => selectProject(project)}
                      >
                        <span className="dashboard-project-option-copy"><strong>{project.name}</strong><small>{project.root}</small></span>
                        <span className="dashboard-project-option-check" aria-hidden="true">{newProjectName === project.name ? "✓" : ""}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="dashboard-modal-actions"><button className="dashboard-action" type="button" onClick={() => setCreateOpen(false)}>Cancel</button><button className="dashboard-submit" type="submit" disabled={createBusy || !newProjectName}>{createBusy ? "Creating…" : "Create session"}</button></div>
          </form>
        </div>
      ) : null}
      {toast ? <div className={`dashboard-toast${toast.isError ? " is-error" : ""}`} role="status">{toast.message}</div> : null}
    </main>
  );
}
