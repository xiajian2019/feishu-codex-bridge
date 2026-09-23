import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";

import { bindMobileTerminalTouch } from "./terminal-touch.js";

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

const API_ROOT = "/tmux-dashboard/api";

async function requestApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(API_ROOT + path, { ...options, headers });
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function createSessionName(): string {
  const stamp = new Date().toISOString();
  return `session-${stamp.slice(5, 10).replace("-", "")}-${stamp.slice(11, 16).replace(":", "")}`;
}

export function TmuxDashboard(): ReactElement {
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
  const terminalHostRef = useRef<HTMLDivElement | null>(null);

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const result = await requestApi<{ sessions: TmuxSession[] }>("/sessions");
      setSessions(result.sessions);
      setBackendStatus("online");
      setError(null);
      setSelectedId((current) => current && result.sessions.some((session) => session.id === current) ? current : null);
    } catch (loadError) {
      setBackendStatus("offline");
      setError(loadError instanceof Error ? loadError.message : "Could not load tmux sessions.");
    }
  }, []);

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
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  useEffect(() => {
    const shouldLockPage = mobileView === "terminal"
      && window.matchMedia("(max-width: 760px)").matches;
    document.documentElement.classList.toggle("tmux-terminal-scroll-lock", shouldLockPage);
    document.body.classList.toggle("tmux-terminal-scroll-lock", shouldLockPage);
    return () => {
      document.documentElement.classList.remove("tmux-terminal-scroll-lock");
      document.body.classList.remove("tmux-terminal-scroll-lock");
    };
  }, [mobileView]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? sessions.filter((session) => `${session.name} ${session.cwd}`.toLowerCase().includes(query))
      : sessions;
  }, [search, sessions]);
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const selectSession = (sessionId: string): void => {
    setSelectedId(sessionId);
    if (window.matchMedia("(max-width: 760px)").matches) setMobileView("terminal");
  };

  const showSessionsOnMobile = (): void => setMobileView("sessions");

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
      cursorBlink: true,
      convertEol: false,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      scrollback: 50_000,
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const address = `${protocol}//${window.location.host}/tmux-dashboard/terminal?session=${encodeURIComponent(selectedSession.id)}`;
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    const sendInput = (data: string): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    };
    const removeTouchScrolling = bindMobileTerminalTouch(host, terminal, sendInput);
    let disposed = false;
    const sendResize = (): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        fit.fit();
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      } catch {
        return;
      }
    };
    socket.onopen = () => {
      if (disposed) return;
      setTerminalStatus("ATTACHED");
      sendResize();
      terminal.focus();
    };
    socket.onmessage = (event) => {
      if (disposed) return;
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as { type?: string; message?: string };
          if (message.type === "error") {
            setTerminalStatus("ERROR");
            setToast({ message: message.message || "Could not attach to the selected session.", isError: true });
          } else if (message.type === "exit") {
            setTerminalStatus("DETACHED");
          }
        } catch {
          terminal.write(event.data);
        }
      } else if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((output) => terminal.write(new Uint8Array(output)));
      }
    };
    socket.onerror = () => { if (!disposed) setTerminalStatus("ERROR"); };
    socket.onclose = () => { if (!disposed) setTerminalStatus("DETACHED"); };
    terminal.onData(sendInput);
    const resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(host);
    window.addEventListener("resize", sendResize);
    window.requestAnimationFrame(sendResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", sendResize);
      resizeObserver.disconnect();
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      removeTouchScrolling();
      terminal.dispose();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
      if (window.matchMedia("(max-width: 760px)").matches) setMobileView("terminal");
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
      await loadSessions();
      if (window.matchMedia("(max-width: 760px)").matches) setMobileView("sessions");
      setToast({ message: `Session “${selectedSession.name}” ended.`, isError: false });
    } catch (endError) {
      setToast({ message: endError instanceof Error ? endError.message : "Could not end session.", isError: true });
    }
  };

  return (
    <main className={`dashboard-page${mobileView === "terminal" ? " is-mobile-terminal" : ""}`}>
      {error ? <div className="dashboard-error" role="alert">{error}</div> : null}
      <section className={`dashboard-main is-mobile-${mobileView}`}>
        <aside className="dashboard-sidebar">
          <div className="dashboard-sidebar-heading">
            <div><span className="dashboard-eyebrow">WORKSPACES</span><h2>Sessions <span>{sessions.length}</span></h2></div>
            <div className="dashboard-session-tools">
              <span className={`dashboard-backend dashboard-backend-${backendStatus}`}>{backendStatus.toUpperCase()}</span>
              <button className="dashboard-action" type="button" onClick={() => void loadSessions()}>Refresh</button>
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
            <div className="dashboard-terminal-actions"><span className={terminalStatus === "ATTACHED" ? "is-connected" : ""}>{selectedSession ? terminalStatus : "IDLE"}</span><button type="button" onClick={() => void endSession()} disabled={!selectedSession}>End session</button></div>
          </div>
          <div className={`dashboard-terminal-frame${selectedSession ? "" : " is-empty"}`}>
            {selectedSession ? <div className="dashboard-terminal-host" ref={terminalHostRef} /> : (
              <div className="dashboard-empty-state"><div>&gt;_</div><h2>No session selected</h2><p>Choose a session from the list to attach its terminal.</p><button type="button" onClick={openCreateDialog} disabled={projects.length === 0}>+ New session</button></div>
            )}
          </div>
          <footer className="dashboard-workspace-footer"><span>Interactive terminal powered by tmux</span><span>Session changes refresh automatically</span></footer>
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
