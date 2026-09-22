import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";

import {
  eventScreen,
  fetchTmuxSessionConfig,
  fetchTmuxSession,
  fetchTmuxSessions,
  openTmuxTerminal,
  parseTmuxWebSocketMessage,
  sendTmuxMessage,
  startTmuxSession,
  stopTmuxSession,
} from "./tmux-api.js";
import type {
  TmuxEvent,
  TmuxProjectOption,
  TmuxSession,
  TmuxSessionDetail,
  TmuxWebSocketEventMessage,
  TmuxWebSocketOutputMessage,
  TmuxWebSocketReadyMessage,
} from "./tmux-types.js";

const CURSOR_PREFIX = "tmux-verifier.cursor.";

export function TmuxApp(): ReactElement {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TmuxSessionDetail | null>(null);
  const [events, setEvents] = useState<TmuxEvent[]>([]);
  const [projects, setProjects] = useState<TmuxProjectOption[]>([]);
  const [bridgeDashboardUrl, setBridgeDashboardUrl] = useState("http://127.0.0.1:7310/");
  const [projectKey, setProjectKey] = useState(() => localStorage.getItem("tmux.verify.project") ?? "");
  const [projectMapError, setProjectMapError] = useState<string | null>(null);
  const [machine, setMachine] = useState("local");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [followup, setFollowup] = useState("");
  const [startBusy, setStartBusy] = useState(false);
  const [followupBusy, setFollowupBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<"closed" | "connecting" | "open">("closed");
  const [reconnectedSessionId, setReconnectedSessionId] = useState<string | null>(null);
  const [lastDelivery, setLastDelivery] = useState<string | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const cursorRef = useRef(0);
  const pendingFollowupIdRef = useRef<string | null>(null);

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const nextSessions = await fetchTmuxSessions();
      setSessions(nextSessions);
      setSelectedId((current) => current
        ?? nextSessions.find((session) => session.status === "RUNNING")?.session_id
        ?? nextSessions[0]?.session_id
        ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void fetchTmuxSessionConfig()
      .then((config) => {
        setProjects(config.projects);
        setProjectMapError(config.projectMapError);
        setBridgeDashboardUrl(config.bridgeDashboardUrl);
        const savedProject = localStorage.getItem("tmux.verify.project");
        const preferred = config.projects.find((project) => project.key === savedProject && project.available)
          ?? config.projects.find((project) => project.available);
        setProjectKey((current) => {
          const currentOption = config.projects.find((project) => project.key === current && project.available);
          return currentOption?.key ?? preferred?.key ?? "";
        });
      })
      .catch((configError: unknown) => {
        setError(configError instanceof Error ? configError.message : String(configError));
      });
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  useEffect(() => {
    if (!selectedId || !terminalHostRef.current) {
      terminalRef.current = null;
      fitRef.current = null;
      return;
    }
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 5_000,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: {
        background: "#101613",
        foreground: "#e8f2ea",
        cursor: "#86efac",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    if (terminalHostRef.current) {
      terminal.open(terminalHostRef.current);
      fit.fit();
    }
    terminalRef.current = terminal;
    fitRef.current = fit;
    const onResize = (): void => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setError(null);
    void fetchTmuxSession(selectedId)
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
        setEvents(value.events);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!selectedId || !terminal) {
      socketRef.current?.close();
      socketRef.current = null;
      setTerminalStatus("closed");
      return;
    }

    const storedCursor = Number(localStorage.getItem(`${CURSOR_PREFIX}${selectedId}`) ?? "0");
    cursorRef.current = Number.isSafeInteger(storedCursor) && storedCursor > 0 ? storedCursor : 0;
    setReconnectedSessionId(cursorRef.current > 0 ? selectedId : null);
    terminal.clear();
    terminal.writeln("正在连接 tmux session…");
    setTerminalStatus("connecting");
    let socket: WebSocket | null = null;
    let disposed = false;
    void openTmuxTerminal(selectedId, cursorRef.current).then((candidate) => {
      if (disposed) {
        candidate.close();
        return;
      }
      socket = candidate;
      socketRef.current = candidate;
      candidate.onopen = () => {
        setTerminalStatus("open");
        if (candidate.readyState === WebSocket.OPEN) {
          candidate.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
        terminal.focus();
      };
      candidate.onmessage = (message) => {
        const parsed = parseTmuxWebSocketMessage(String(message.data));
        if (isOutputMessage(parsed)) {
          terminal.write(parsed.data);
          return;
        }
        if (isReadyMessage(parsed)) {
          cursorRef.current = Math.max(cursorRef.current, parsed.cursor);
          localStorage.setItem(`${CURSOR_PREFIX}${selectedId}`, String(cursorRef.current));
          if (parsed.session.last_screen) {
            terminal.clear();
            terminal.write(parsed.session.last_screen);
          }
          return;
        }
        if (!isEventMessage(parsed)) return;
        const event = parsed.event;
        if (event.event_id <= cursorRef.current) return;
        cursorRef.current = event.event_id;
        localStorage.setItem(`${CURSOR_PREFIX}${selectedId}`, String(event.event_id));
        setEvents((current) => {
          const next = current.filter((item) => item.event_id !== event.event_id);
          return [...next, event].slice(-150);
        });
        const screen = eventScreen(event);
        if (screen !== null) {
          terminal.clear();
          terminal.write(screen);
        } else if (event.kind === "session.started") {
          terminal.writeln("\r\n[tmux session started]");
        } else if (event.kind === "message.delivered") {
          terminal.writeln("\r\n[web message delivered through tmux]");
        } else if (event.kind === "message.deduplicated") {
          terminal.writeln("\r\n[duplicate web message suppressed]");
        }
      };
      candidate.onerror = () => setError("terminal websocket error");
      candidate.onclose = () => {
        setTerminalStatus("closed");
        if (socketRef.current === candidate) socketRef.current = null;
      };
    }).catch((connectError: unknown) => {
      if (!disposed) {
        setTerminalStatus("closed");
        setError(connectError instanceof Error ? connectError.message : String(connectError));
      }
    });

    const inputSubscription = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    return () => {
      disposed = true;
      inputSubscription.dispose();
      resizeSubscription.dispose();
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [selectedId]);

  const handleStart = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (startBusy || !projectKey) return;
    setStartBusy(true);
    setError(null);
    const clientRequestId = makeId();
    try {
      localStorage.setItem("tmux.verify.project", projectKey);
      const result = await startTmuxSession({
        machine: machine.trim() || "local",
        projectKey,
        initialPrompt: initialPrompt.trim() || undefined,
        clientRequestId,
      });
      setSelectedId(result.session.session_id);
      setDetail(null);
      setLastDelivery(initialPrompt.trim() ? "初始消息已写入幂等消息日志" : null);
      await loadSessions();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStartBusy(false);
    }
  }, [initialPrompt, loadSessions, machine, projectKey, startBusy]);

  const handleFollowup = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedId || !followup.trim() || followupBusy) return;
    const messageId = pendingFollowupIdRef.current ?? makeId();
    pendingFollowupIdRef.current = messageId;
    setFollowupBusy(true);
    setError(null);
    try {
      const result = await sendTmuxMessage(selectedId, messageId, followup.trim());
      setLastDelivery(result.deduplicated ? "重复提交已抑制：没有再次 send-keys" : "已通过现有 tmux TUI 发送一次");
      setFollowup("");
      pendingFollowupIdRef.current = null;
      await loadSessions();
    } catch (followupError) {
      setError(followupError instanceof Error ? followupError.message : String(followupError));
      // Keep the id so a network retry is the same logical message.
    } finally {
      setFollowupBusy(false);
    }
  }, [followup, followupBusy, loadSessions, selectedId]);

  const handleStop = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    try {
      const stopped = await stopTmuxSession(selectedId);
      setDetail((current) => current ? { ...current, session: stopped } : current);
      await loadSessions();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    }
  }, [loadSessions, selectedId]);

  const selected = detail?.session ?? sessions.find((session) => session.session_id === selectedId) ?? null;
  const hasStarted = Boolean(selected && ["RUNNING", "EXITED", "STOPPED"].includes(selected.status));
  const hasReconnectEvidence = reconnectedSessionId === selectedId
    && events.length > 0
    && Boolean(selected?.last_event_id);
  const hasDedupEvidence = events.some((event) => event.kind === "message.deduplicated")
    || detail?.messages.some((message) => message.delivery_attempts === 1) === true;

  return (
    <main className="tmux-page">
      <header className="tmux-header">
        <div>
          <p className="eyebrow">CS / SSH + tmux + Codex</p>
          <h1>Codex Session 验证器</h1>
          <p className="subtitle">只验证远程执行适配器的三个最小事实；业务状态仍由后端 SQLite 持有。</p>
        </div>
        <a className="text-link" href={bridgeDashboardUrl}>返回 Bridge 看板</a>
      </header>

      <section className="tmux-layout">
        <div className="tmux-panel">
          <h2>1. 启动一个 Session</h2>
          <form className="tmux-form" onSubmit={handleStart}>
            <label>机器<input value={machine} onChange={(event) => setMachine(event.target.value)} placeholder="local 或 user@host" /></label>
            <ProjectPicker options={projects} value={projectKey} onChange={setProjectKey} />
            {projectMapError ? <div className="tmux-error">project map 读取失败：{projectMapError}</div> : null}
            <label>初始消息（可空）<textarea value={initialPrompt} onChange={(event) => setInitialPrompt(event.target.value)} placeholder="留空则只启动 TUI；消息会记录幂等键" /></label>
            <button className="primary" disabled={startBusy || !projectKey} type="submit">{startBusy ? "启动中…" : "启动 Codex Session"}</button>
          </form>
          <p className="tmux-help">Session 默认复用所选机器的 tmux 默认 server；本机 Session 可直接从现有 tmux 会话列表切换。Codex 路径由 Bridge 环境变量/服务配置决定，工作路径只能从 project map 选择。远程机器只使用 SSH key 和本机 SSH 配置。</p>
        </div>

        <div className="tmux-panel">
          <h2>验证状态</h2>
          <div className="fact-grid">
            <Fact ok={hasStarted} title="事实 1" text="Web 点击后创建指定机器/目录的 tmux + Codex" />
            <Fact ok={hasReconnectEvidence} title="事实 2" text="事件有 durable cursor，可断开后按 after 补齐" />
            <Fact ok={hasDedupEvidence} title="事实 3" text="Web message 使用幂等键，只投递到现有 TUI 一次" />
          </div>
          {error ? <div className="tmux-error">{error}</div> : null}
          {lastDelivery ? <div className="tmux-success">{lastDelivery}</div> : null}
        </div>
      </section>

      <section className="tmux-panel">
        <div className="tmux-section-head"><h2>Sessions</h2><button type="button" onClick={() => void loadSessions()}>刷新</button></div>
        {sessions.length === 0
          ? <p className="muted">还没有验证 session。</p>
          : <div className="session-list">{sessions.map((session) => (
            <button
              className={`session-item ${selectedId === session.session_id ? "selected" : ""}`}
              key={session.session_id}
              type="button"
              onClick={() => setSelectedId(session.session_id)}
            >
              <span><strong>{session.machine}</strong><small>{session.cwd}</small></span>
              <Status status={session.status} />
            </button>
          ))}</div>}
      </section>

      <section className="tmux-panel">
        <div className="tmux-section-head">
          <div><h2>2. 断开 / 重连终端</h2><p className="muted">xterm.js 查看同一个 tmux pane；刷新页面或重新打开 URL 会带上上次 cursor。</p></div>
          {selected ? <button className="danger" type="button" onClick={() => void handleStop()}>停止 Session</button> : null}
        </div>
        {selected ? <>
          <div className="session-meta"><Status status={selected.status} /><code>{selected.session_id}</code><code>{selected.tmux_session}</code><span>WS: {terminalStatus}</span></div>
          <div className="terminal-shell"><div ref={terminalHostRef} /></div>
          <p className="attach-command">终端也可执行：<code>{selected.attach_command}</code></p>
        </> : selectedId
          ? <div className="terminal-shell"><div ref={terminalHostRef} /></div>
          : <div className="empty">启动或选择一个 Session 后，这里会显示 tmux TUI。</div>}
      </section>

      <section className="tmux-layout">
        <div className="tmux-panel">
          <h2>3. Web 追问（幂等）</h2>
          <form className="tmux-form" onSubmit={handleFollowup}>
            <textarea disabled={!selected || selected.status !== "RUNNING"} value={followup} onChange={(event) => setFollowup(event.target.value)} placeholder="同一网络请求重试会复用 clientMessageId，不会再次 send-keys" />
            <button className="primary" disabled={!selected || selected.status !== "RUNNING" || followupBusy || !followup.trim()} type="submit">{followupBusy ? "发送中…" : "发送一次追问"}</button>
          </form>
          <p className="tmux-help">这是对同一个 Codex TUI 的输入，不会创建第二个 Codex 进程。终端键盘输入仍然是原始 TUI 输入，不应和 Web 追问重复发送同一条消息。</p>
        </div>
        <div className="tmux-panel">
          <h2>事件回放</h2>
          <div className="event-log">{events.slice().reverse().slice(0, 30).map((event) => (
            <div className="tmux-event" key={event.event_id}><code>#{event.event_id}</code><span><strong>{event.kind}</strong><small>{formatTime(event.created_at)}</small></span></div>
          ))}</div>
        </div>
      </section>
    </main>
  );
}

function ProjectPicker({
  options,
  value,
  onChange,
}: {
  options: TmuxProjectOption[];
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const selected = options.find((option) => option.key === value);
  const [query, setQuery] = useState(selected?.key ?? value);
  const [open, setOpen] = useState(false);
  const filtered = options.filter((option) => {
    const needle = query.trim().toLowerCase();
    return !needle || option.key.toLowerCase().includes(needle) || option.root.toLowerCase().includes(needle);
  });

  useEffect(() => {
    if (!open) setQuery(selected?.key ?? value);
  }, [open, selected?.key, value]);

  return (
    <label className="project-picker-label">
      工作路径 / 项目
      <div className="project-picker">
        <input
          aria-label="工作路径项目"
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            onChange("");
            setOpen(true);
          }}
          placeholder={options.length > 0 ? "输入项目名或路径筛选" : "project map 没有可用项目"}
          autoComplete="off"
        />
        {open ? <div className="project-options">
          {filtered.length === 0
            ? <span className="project-option-empty">没有匹配项目</span>
            : filtered.map((option) => (
              <button
                className="project-option"
                disabled={!option.available}
                key={option.key}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!option.available) return;
                  setQuery(option.key);
                  onChange(option.key);
                  setOpen(false);
                }}
              >
                <strong>{option.key}</strong>
                <small>{option.root}{option.available ? "" : "（路径不可用）"}</small>
              </button>
            ))}
        </div> : null}
      </div>
      <small className="project-picker-hint">
        {selected?.root ?? "请选择 project map 中的项目"}
      </small>
    </label>
  );
}

function Fact({ ok, title, text }: { ok: boolean; title: string; text: string }): ReactElement {
  return <div className={`fact ${ok ? "ok" : "pending"}`}><span>{ok ? "✓" : "○"}</span><div><strong>{title}</strong><small>{text}</small></div></div>;
}

function Status({ status }: { status: TmuxSession["status"] }): ReactElement {
  return <span className={`tmux-status tmux-status-${status}`}>{status}</span>;
}

function isEventMessage(value: unknown): value is TmuxWebSocketEventMessage {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "event"
    && "event" in value
    && typeof value.event === "object"
    && value.event !== null;
}

function isReadyMessage(value: unknown): value is TmuxWebSocketReadyMessage {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "ready"
    && "session" in value
    && typeof value.session === "object"
    && value.session !== null
    && "cursor" in value
    && typeof value.cursor === "number";
}

function isOutputMessage(value: unknown): value is TmuxWebSocketOutputMessage {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "output"
    && "data" in value
    && typeof value.data === "string";
}

function makeId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString();
}
