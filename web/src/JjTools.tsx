import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";

import { getActionToken, getJson } from "./api.js";
import { openTerminalUrl, registerTerminalLinkProvider } from "./terminal-links.js";
import { bindMobileTerminalTouch, type TerminalSelectionDisplay } from "./terminal-touch.js";
import { copyMobileText, isMobileApp } from "./mobile-runtime.js";
import { scopedStorageKey } from "./local-draft-scope.js";
import "./jj-tools.css";

interface JjRun {
  id: string;
  command: string;
  state: "running" | "exited" | "stopped";
  exitCode: number | null;
  startedAt: string;
}
interface JjSnapshot extends JjRun { output: string; offset: number; truncated: boolean }
interface JjStatus { executable: string | null; runs: JjRun[] }

function stateLabel(run: JjRun): string {
  return run.state === "running" ? "运行中" : run.state === "stopped" ? "已停止本机命令" : `已退出 · ${run.exitCode ?? "—"}`;
}
function terminalLogLines(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

function savedRunId(): string {
  const key = scopedStorageKey("jj-selected");
  try { return key ? sessionStorage.getItem(key) ?? "" : ""; } catch { return ""; }
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (isMobileApp()) return copyMobileText(value);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.cssText = "position:fixed;opacity:0;font-size:16px";
  document.body.append(input);
  input.select();
  try {
    if (!document.execCommand("copy")) throw new Error("复制失败，请重试。");
  } finally {
    input.remove();
  }
}

export function JjTools(): ReactElement {
  const [tab, setTab] = useState<"release" | "pods">("pods");
  const [job, setJob] = useState("");
  const [buildNumber, setBuildNumber] = useState("");
  const [app, setApp] = useState("");
  const [watch, setWatch] = useState(false);
  const [logs, setLogs] = useState(false);
  const [logFilter, setLogFilter] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const filteredOutput = useRef<HTMLPreElement | null>(null);
  const followFilteredOutput = useRef(true);
  const [status, setStatus] = useState<JjStatus | null>(null);
  const [selectedId, setSelectedId] = useState(savedRunId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<TerminalSelectionDisplay | null>(null);
  const [copiedFilteredLog, setCopiedFilteredLog] = useState(false);
  const [reload, setReload] = useState(0);
  const terminalHost = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const currentRun = useRef<JjRun | null>(null);
  const starting = useRef(false);
  const inputChain = useRef(Promise.resolve());
  const tokenRef = useRef<Promise<string> | null>(null);

  const post = useCallback(async <T,>(path: string, body: unknown): Promise<T> => {
    const token = await (tokenRef.current ??= getActionToken());
    return getJson<T>(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": token }, body: JSON.stringify(body) });
  }, []);

  const reportError = (failure: unknown): void => setError(failure instanceof Error ? failure.message : String(failure));

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        const next = await getJson<JjStatus>("/api/jj", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(next);
        setSelectedId((previous) => next.runs.some((run) => run.id === previous) ? previous : next.runs[0]?.id ?? "");
      } catch (failure) {
        if (!controller.signal.aborted) reportError(failure);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  const sendInput = useCallback((data: string): void => {
    const run = currentRun.current;
    if (!run || run.state !== "running") return;
    inputChain.current = inputChain.current.then(async () => {
      if (currentRun.current?.id !== run.id) return;
      await post(`/api/jj/runs/${run.id}/input`, { data });
    }).catch(reportError);
  }, [post]);

  useEffect(() => {
    const host = terminalHost.current;
    if (!host || !selectedId) return;
    const controller = new AbortController();
    const key = scopedStorageKey("jj-selected");
    try { if (key) sessionStorage.setItem(key, selectedId); } catch { /* Storage is optional. */ }
    setSelection(null);
    setLogLines([]);
    const terminal = new Terminal({
      cols: 100, rows: 24, scrollback: 2_000, fontSize: 13,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
      disableStdin: true, cursorBlink: true, convertEol: false,
      theme: { background: "#10141a", foreground: "#d8dee9", cursor: "#8de0bd", selectionBackground: "#41536b" },
      linkHandler: { activate: (_event, text) => openTerminalUrl(text) },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    try { terminal.loadAddon(new CanvasAddon()); } catch { /* Keep the DOM fallback on devices without Canvas. */ }
    terminalRef.current = terminal;
    const links = registerTerminalLinkProvider(terminal);
    const unbindTouch = bindMobileTerminalTouch(host, terminal, setSelection, { enableDesktopSelection: true });
    const input = terminal.onData(sendInput);
    const resize = (): void => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      fit.fit();
      if (currentRun.current?.id === selectedId && currentRun.current.state === "running") {
        void post(`/api/jj/runs/${selectedId}/resize`, { cols: terminal.cols, rows: terminal.rows }).catch(reportError);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    let offset = 0;
    let sized = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      let keepPolling = true;
      try {
        const snapshot = await getJson<JjSnapshot>(`/api/jj/runs/${selectedId}?offset=${offset}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (snapshot.truncated) terminal.write("\r\n[较早输出已截断]\r\n");
        if (snapshot.output) terminal.write(snapshot.output, () => {
          if (!controller.signal.aborted) setLogLines(terminalLogLines(terminal));
        });
        offset = snapshot.offset;
        currentRun.current = snapshot;
        if (!sized) { sized = true; resize(); }
        terminal.options.disableStdin = snapshot.state !== "running";
        setStatus((previous) => previous ? { ...previous, runs: previous.runs.map((run) => run.id === snapshot.id ? snapshot : run) } : previous);
        keepPolling = snapshot.state === "running";
      } catch (failure) {
        if (!controller.signal.aborted) reportError(failure);
      } finally {
        if (keepPolling && !controller.signal.aborted) timer = setTimeout(() => void poll(), 350);
      }
    };
    void poll();
    return () => {
      controller.abort(); clearTimeout(timer); observer.disconnect(); input.dispose(); links.dispose(); unbindTouch();
      terminal.dispose(); terminalRef.current = null; currentRun.current = null;
    };
  }, [selectedId, reload, post, sendInput]);

  const start = async (action: "run" | "names" | "jobs" | "builds" | "pods"): Promise<void> => {
    if (starting.current) return;
    starting.current = true; setBusy(true); setError(null);
    try {
      const run = await post<JjRun>("/api/jj/runs", {
        action, requestId: globalThis.crypto?.randomUUID?.() ?? `jj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        job, interactive: action === "run", buildNumber, app, namespace: "default", watch, logs,
        cols: terminalRef.current?.cols ?? 100, rows: terminalRef.current?.rows ?? 24,
      });
      setStatus((previous) => ({ executable: previous?.executable ?? null, runs: [run, ...(previous?.runs ?? []).filter((item) => item.id !== run.id)].slice(0, 16) }));
      setSelectedId(run.id);
    } catch (failure) { reportError(failure); }
    finally { starting.current = false; setBusy(false); }
  };

  const stop = async (): Promise<void> => {
    if (!selectedId) return;
    try {
      await post(`/api/jj/runs/${selectedId}/stop`, {});
      setReload((value) => value + 1);
    } catch (failure) { reportError(failure); }
  };

  const copySelection = async (): Promise<void> => {
    if (!selection) return;
    try {
      await copyTextToClipboard(selection.text);
      terminalRef.current?.clearSelection(); setSelection(null);
    } catch (failure) { reportError(failure); }
  };

  const copyFilteredLogs = async (): Promise<void> => {
    const text = matchingLines.join("\n");
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      setCopiedFilteredLog(true);
      window.setTimeout(() => setCopiedFilteredLog(false), 1_500);
    } catch (failure) {
      reportError(failure);
    }
  };

  const selected = status?.runs.find((run) => run.id === selectedId);
  const disabled = busy || !status?.executable;
  const logQuery = logFilter.trim().toLocaleLowerCase();
  const matchingLines = useMemo(() => logQuery
    ? logLines.filter((line) => line.toLocaleLowerCase().includes(logQuery))
    : logLines, [logLines, logQuery]);

  useEffect(() => { setLogFilter(""); }, [selectedId]);
  useEffect(() => { followFilteredOutput.current = true; }, [logQuery]);
  useEffect(() => {
    const output = filteredOutput.current;
    if (output && followFilteredOutput.current) output.scrollTop = output.scrollHeight;
  }, [matchingLines, logQuery]);

  return <main className="jj-page">
    <section className="jj-card">
      <div className="jj-tabs" role="tablist" aria-label="JJ 操作">
        <button role="tab" aria-selected={tab === "pods"} aria-controls="jj-pods" id="jj-pods-tab" onClick={() => setTab("pods")}>Pod 状态</button>
        <button role="tab" aria-selected={tab === "release"} aria-controls="jj-release" id="jj-release-tab" onClick={() => setTab("release")}>发布项目</button>
      </div>
      {tab === "release" ? <form id="jj-release" role="tabpanel" aria-labelledby="jj-release-tab" onSubmit={(event) => { event.preventDefault(); void start("run"); }}>
        <label>Jenkins Job<input value={job} onChange={(event) => setJob(event.target.value)} placeholder="例如 app-build" autoComplete="off" required /></label>
        <div className="jj-actions">
          <button type="submit" className="primary" disabled={disabled || !job.trim()}>发起发布</button>
          <button type="button" disabled={disabled} onClick={() => void start("jobs")}>查看项目</button>
        </div>
        <div className="jj-builds">
          <label>构建号<input value={buildNumber} onChange={(event) => setBuildNumber(event.target.value)} inputMode="numeric" placeholder="留空查看最近构建" /></label>
          <button type="button" disabled={disabled || !job.trim()} onClick={() => void start("builds")}>查看构建</button>
        </div>
      </form> : <form id="jj-pods" role="tabpanel" aria-labelledby="jj-pods-tab" onSubmit={(event) => { event.preventDefault(); void start("pods"); }}>
        <div className="jj-fields jj-pod-fields">
          <label>应用名称<input value={app} onChange={(event) => setApp(event.target.value)} placeholder="留空查看全部 Pod" autoComplete="off" /></label>
          <div className="jj-namespace"><span id="jj-namespace-label">命名空间</span><output aria-labelledby="jj-namespace-label">default</output></div>
        </div>
        <div className="jj-actions">
          <button className="primary" type="submit" disabled={disabled}>查询 Pod</button>
          <label className="jj-check"><input type="checkbox" checked={watch} disabled={logs} onChange={(event) => setWatch(event.target.checked)} />实时监控</label>
          <label className="jj-check"><input type="checkbox" checked={logs} onChange={(event) => setLogs(event.target.checked)} />最近日志</label>
        </div>
      </form>}
    </section>
    {error ? <div className="jj-error" role="alert">{error}</div> : null}
    {status && !status.executable ? <p className="jj-error">未找到本机 JJ，可通过 FEISHU_CODEX_JJ_PATH 指定工具路径。</p> : null}
    <section className="jj-card jj-console">
      {selected ? <div className="jj-run-meta"><code>{selected.command}</code><span>{stateLabel(selected)}</span></div> : null}
      <div className="jj-log-filter">
        <input type="search" aria-label="日志关键词" placeholder="输入关键词过滤日志" value={logFilter} disabled={!selectedId} onChange={(event) => setLogFilter(event.target.value)} />
        {logQuery ? <span role="status">{matchingLines.length} 行</span> : null}
      </div>
      <div className="jj-terminal-frame">
        <div ref={terminalHost} className="jj-terminal" aria-label="JJ 交互终端" />
        {!selectedId ? <div className="jj-terminal-placeholder">执行结果与交互提示显示在这里</div> : null}
        {logQuery ? <div className="jj-filtered-output-wrap" aria-label="过滤后的日志">
          <pre ref={filteredOutput} className="jj-filtered-output" onScroll={(event) => {
            const output = event.currentTarget;
            followFilteredOutput.current = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
          }}>{matchingLines.length ? matchingLines.join("\n") : "暂无匹配日志"}</pre>
          <button
            type="button"
            className="jj-copy-filtered-log"
            aria-label={copiedFilteredLog ? "已复制过滤日志" : "复制过滤日志"}
            title={copiedFilteredLog ? "已复制" : "复制过滤日志"}
            disabled={!matchingLines.length}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void copyFilteredLogs()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              {copiedFilteredLog
                ? <path d="m4 10 4 4 8-8" />
                : <><rect x="7" y="3" width="9" height="11" rx="1" /><path d="M5 7v9a1 1 0 0 0 1 1h7" /></>}
            </svg>
          </button>
        </div> : null}
        {!logQuery && selection ? <button type="button" className="dashboard-terminal-copy-selection" style={{ left: selection.left, top: selection.top }} onPointerDown={(event) => event.preventDefault()} onClick={() => void copySelection()}>Copy</button> : null}
      </div>
      <div className="jj-console-footer" role="group" aria-label="终端操作">
        {[["↑", "向上", "\x1b[A"], ["↓", "向下", "\x1b[B"], ["⇥", "Tab", "\t"], ["↵", "Enter", "\r"], ["^C", "Ctrl+C", "\x03"]].map(([icon, label, data]) =>
          <button type="button" key={label} aria-label={label} title={label} disabled={selected?.state !== "running"} onClick={() => sendInput(data!)}>{icon}</button>)}
        <button type="button" aria-label="输入" title="输入" disabled={selected?.state !== "running"} onClick={() => {
          setLogFilter(""); terminalRef.current?.focus();
        }}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2" /><path d="m5 7 3 3-3 3m5 0h5" /></svg></button>
        <button type="button" aria-label="重连输出" title="重连输出" disabled={!selectedId} onClick={() => setReload((value) => value + 1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .5 5M16 3v4h-4" /></svg></button>
        <button type="button" aria-label="停止本机命令" title="停止本机命令（不会取消已提交的 Jenkins 构建）" disabled={selected?.state !== "running"} onClick={() => void stop()}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor" /></svg></button>
      </div>
      <div className="jj-console-toolbar">
        <label title="记录随服务重启清空">最近命令<select aria-label="最近 JJ 命令" value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setError(null); }}>
          {!status?.runs.length ? <option value="">尚未执行命令</option> : null}
          {status?.runs.map((run) => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleTimeString()} · {stateLabel(run)} · {run.command}</option>)}
        </select></label>
      </div>
    </section>
  </main>;
}
