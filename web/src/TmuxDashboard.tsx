import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router";

import { bindMobileTerminalViewport } from "./mobile-terminal-viewport.js";
import { requestTmuxSessions } from "./tmux-session-request.js";
import { isDebugLogCaptureActive, logDebugDiagnostic } from "./debug-log-capture.js";

import { bindMobileTerminalTouch, downloadTerminalScrollDiagnostics, type TerminalSelectionDisplay } from "./terminal-touch.js";
import { openTerminalUrl, registerTerminalLinkProvider } from "./terminal-links.js";
import type { SessionFileForwardRequest, TerminalShortcut } from "./TmuxMessageComposer.js";
import { stripGitReviewMarkers } from "./git-review-drafts.js";
import { fetchCodexUsage, getActionToken } from "./api.js";
import { CodexUsageDialog } from "./CodexUsage.js";
import { getCodexUsageRemainingPercentages, preserveCodexUsageAccount } from "./codex-usage-utils.js";
import {
  cacheCodexHomeOptions,
  mergeCodexHomeOption,
  normalizeCodexHomeOptions,
  readCachedCodexHomeOptions,
  resolveCodexHomeLabel,
  UNKNOWN_CODEX_HOME_LABEL,
  type TmuxCodexHomeOption,
} from "./tmux-codex-account.js";
import type { CodexUsageAccount } from "./types.js";
import { useSystemNavigation } from "./WebNavigation.js";
import { copyMobileText, getBridgeOrigin, isMobileApp, MOBILE_RESUME_EVENT } from "./mobile-runtime.js";
import { getTmuxTerminalRenderTheme } from "./tmux-terminal-theme.js";
import { failPendingTmuxSubmissionsOnDisconnect, type TerminalSubmissionResult } from "./tmux-terminal-utils.js";
import { getTmuxTerminalTransport, type TmuxTerminalTransport, type TmuxTerminalTransportEvent } from "./tmux-terminal-runtime.js";
import {
  isSessionListRefreshStale,
  shouldRefreshSessionListOnPageShow,
  shouldRefreshSessionListOnVisibilityChange,
} from "./tmux-session-refresh-policy.js";
import { useTheme } from "./theme.js";
import { useMobileBack } from "./use-mobile-back.js";

const TmuxMessageComposer = lazy(() => import("./TmuxMessageComposer.js").then((module) => ({ default: module.TmuxMessageComposer })));
const TmuxHistoryInspector = lazy(() => import("./TmuxSessionHistory.js").then((module) => ({ default: module.TmuxSessionHistory })));
const TmuxGitChangesInspector = lazy(() => import("./TmuxGitChanges.js").then((module) => ({ default: module.TmuxGitChanges })));

type TmuxSession = {
  id: string;
  name: string;
  windows: number;
  attachedClients: number;
  cwd: string;
  createdAt: number;
  endedAt: string | null;
  suspendedAt: string | null;
  openCount: number;
  lastOpenedAt: string | null;
  codexHomeId: string | null;
  workspaceId?: string | null;
  taskGuid?: string | null;
  workspaceBranch?: string | null;
  workspaceStatus?: string | null;
  snapshot: { savedAt: string } | null;
};

type TmuxResurrectStatus = {
  installed: boolean;
  configured: boolean;
  automaticSave: boolean;
  automaticRestore: boolean;
  perSessionRestore: boolean;
  automaticStart: boolean;
  pluginDirectory: string;
  saveDirectory: string;
  configPath: string | null;
  lastSnapshotAt: string | null;
};

type ProjectOption = { name: string; root: string };
type CodexHomeOption = TmuxCodexHomeOption;
type TaskCreationContext = {
  sessionId: string;
  projectKey: string;
  projectName: string;
  directory: string;
  branch: string | null;
  baseSha: string;
  sourceHeadSha: string;
  baseRef: string;
  targetBaseSha: string;
  dirtyEntryCount: number;
};
type Toast = { message: string; isError: boolean; durationMs?: number };
type SubmissionResult = TerminalSubmissionResult;
type SessionInspector = { kind: "history"; sessionId: string | null } | { kind: "git"; sessionId: string };

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
      {session.codexHomeId && !known ? <option value={session.codexHomeId}>{UNKNOWN_CODEX_HOME_LABEL}</option> : null}
      {homes.map((home) => (
        <option key={home.id} value={home.id} disabled={!home.available}>
          {home.label}{home.available ? "" : "（不可用）"}
        </option>
      ))}
    </select>
  );
}

const API_ROOT = "/tmux-dashboard/api";
const CODEX_HOME_RETRY_INTERVAL_MS = 5_000;
const SESSION_REQUEST_TIMEOUT_MS = 15_000;
const CODEX_USAGE_CACHE_MS = 60_000;

async function requestApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  if (options.method && options.method.toUpperCase() !== "GET" && options.method.toUpperCase() !== "HEAD") {
    headers.set("X-Bridge-Action-Token", await getActionToken());
  }
  const response = await fetch(API_ROOT + path, { ...options, headers });
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function closeSessionActionMenu(event: MouseEvent<HTMLElement>): void {
  const details = event.currentTarget.closest("details");
  if (details instanceof HTMLDetailsElement) details.open = false;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (isMobileApp()) return copyMobileText(value);
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
  const endedAt = record.endedAt ?? record.ended_at ?? null;
  const suspendedAt = record.suspendedAt ?? record.suspended_at ?? null;
  const openCount = Number(record.openCount ?? record.open_count ?? 0);
  const lastOpenedAt = record.lastOpenedAt ?? record.last_opened_at ?? null;
  const codexHomeId = record.codexHomeId ?? record.codex_home_id ?? null;
  const workspaceId = record.workspaceId ?? record.workspace_id ?? null;
  const taskGuid = record.taskGuid ?? record.task_guid ?? null;
  const workspaceBranch = record.workspaceBranch ?? record.workspace_branch ?? null;
  const workspaceStatus = record.workspaceStatus ?? record.workspace_status ?? null;
  const snapshotValue = record.snapshot;
  const snapshot = typeof snapshotValue === "object" && snapshotValue !== null
    && typeof (snapshotValue as { savedAt?: unknown }).savedAt === "string"
    ? { savedAt: (snapshotValue as { savedAt: string }).savedAt }
    : null;

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
      endedAt: typeof endedAt === "string" ? endedAt : null,
      suspendedAt: typeof suspendedAt === "string" ? suspendedAt : null,
      openCount: Number.isFinite(openCount) ? openCount : 0,
      lastOpenedAt: typeof lastOpenedAt === "string" ? lastOpenedAt : null,
      codexHomeId: typeof codexHomeId === "string" ? codexHomeId : null,
      workspaceId: typeof workspaceId === "string" ? workspaceId : null,
      taskGuid: typeof taskGuid === "string" ? taskGuid : null,
      workspaceBranch: typeof workspaceBranch === "string" ? workspaceBranch : null,
      workspaceStatus: typeof workspaceStatus === "string" ? workspaceStatus : null,
      snapshot,
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
    endedAt: null,
    suspendedAt: null,
    openCount: 0,
    lastOpenedAt: null,
    codexHomeId: null,
    workspaceId: null,
    taskGuid: null,
    workspaceBranch: null,
    workspaceStatus: null,
    snapshot: null,
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
      && next.endedAt === session.endedAt
      && next.suspendedAt === session.suspendedAt
      && next.openCount === session.openCount
      && next.lastOpenedAt === session.lastOpenedAt
      && next.codexHomeId === session.codexHomeId
      && next.workspaceId === session.workspaceId
      && next.taskGuid === session.taskGuid
      && next.workspaceBranch === session.workspaceBranch
      && next.workspaceStatus === session.workspaceStatus
      && next.snapshot?.savedAt === session.snapshot?.savedAt;
  });
}

function compareTmuxSessions(left: TmuxSession, right: TmuxSession): number {
  const sessionStatus = (session: TmuxSession): number => session.endedAt ? 2 : session.suspendedAt ? 1 : 0;
  const activeDifference = sessionStatus(left) - sessionStatus(right);
  if (activeDifference !== 0) return activeDifference;
  if (right.openCount !== left.openCount) return right.openCount - left.openCount;
  const rightOpened = right.lastOpenedAt ?? "";
  const leftOpened = left.lastOpenedAt ?? "";
  if (rightOpened !== leftOpened) return rightOpened.localeCompare(leftOpened);
  return right.createdAt - left.createdAt;
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
  const { resolvedTheme } = useTheme();
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
  const { collapsed: navigationCollapsed, setCollapsed: setNavigationCollapsed } = useSystemNavigation();
  const initialRouteParams = new URLSearchParams(window.location.search);
  const initialSelectedId = initialRouteParams.get("session");
  const shouldRestoreSessionDetail = Boolean(initialSelectedId) && initialRouteParams.get("view") !== "sessions";
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [resurrectStatus, setResurrectStatus] = useState<TmuxResurrectStatus | null>(null);
  const [resurrectBusy, setResurrectBusy] = useState<string | null>(null);
  const [codexHomes, setCodexHomes] = useState<CodexHomeOption[]>(() => readCachedCodexHomeOptions());
  const [savingCodexHomeId, setSavingCodexHomeId] = useState<string | null>(null);
  const [checkingCodexHomeId, setCheckingCodexHomeId] = useState<string | null>(null);
  const [codexUsageAccount, setCodexUsageAccount] = useState<CodexUsageAccount | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexUsageError, setCodexUsageError] = useState<string | null>(null);
  const [codexUsageDialogOpen, setCodexUsageDialogOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"sessions" | "terminal">("sessions");
  const [selectedId, setSelectedId] = useState<string | null>(() => initialSelectedId);
  const [sessionsRefreshing, setSessionsRefreshing] = useState(false);
  const [sessionFileForward, setSessionFileForward] = useState<SessionFileForwardRequest | null>(() => {
    const state = location.state as { sessionFileForward?: unknown } | null;
    const request = state?.sessionFileForward;
    if (typeof request !== "object" || request === null) return null;
    const candidate = request as Record<string, unknown>;
    return typeof candidate.id === "string"
      && typeof candidate.sessionId === "string"
      && typeof candidate.text === "string"
      ? {
        id: candidate.id,
        sessionId: candidate.sessionId,
        text: candidate.text,
      }
      : null;
  });
  const [search, setSearch] = useState("");
  const [backendStatus, setBackendStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [terminalStatus, setTerminalStatus] = useState("IDLE");
  const [terminalEverAttached, setTerminalEverAttached] = useState(false);
  const [terminalInputEnabled, setTerminalInputEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newWorkingDirectory, setNewWorkingDirectory] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [sessionEditTargetId, setSessionEditTargetId] = useState<string | null>(null);
  const [sessionEditName, setSessionEditName] = useState("");
  const [sessionEditWorkingDirectory, setSessionEditWorkingDirectory] = useState("");
  const [sessionEditBusy, setSessionEditBusy] = useState(false);
  const [sessionEditError, setSessionEditError] = useState("");
  const [trackedTaskOpen, setTrackedTaskOpen] = useState(false);
  const [trackedTaskDescription, setTrackedTaskDescription] = useState("");
  const [trackedTaskBusy, setTrackedTaskBusy] = useState(false);
  const [trackedTaskContextLoading, setTrackedTaskContextLoading] = useState(false);
  const [trackedTaskContext, setTrackedTaskContext] = useState<TaskCreationContext | null>(null);
  const [trackedTaskError, setTrackedTaskError] = useState<string | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectActiveIndex, setProjectActiveIndex] = useState(0);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [terminalSelection, setTerminalSelection] = useState<TerminalSelectionDisplay | null>(null);
  const [sessionInspector, setSessionInspector] = useState<SessionInspector | null>(null);
  useMobileBack(createOpen, () => { if (!createBusy) setCreateOpen(false); }, 100);
  useMobileBack(Boolean(sessionEditTargetId), () => { if (!sessionEditBusy) setSessionEditTargetId(null); }, 100);
  useMobileBack(trackedTaskOpen, () => { if (!trackedTaskBusy) setTrackedTaskOpen(false); }, 100);
  useMobileBack(Boolean(sessionInspector), () => setSessionInspector(null), 900);
  useMobileBack(projectPickerOpen, () => setProjectPickerOpen(false), 110);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const terminalTransportRef = useRef<TmuxTerminalTransport | null>(null);
  const terminalReconnectRef = useRef<(() => void) | null>(null);
  const submissionWaitersRef = useRef(new Map<string, (result: SubmissionResult) => void>());
  const trackedTaskSubmissionRef = useRef<{ sessionId: string; description: string; key: string } | null>(null);
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const createdSessionToRevealRef = useRef<string | null>(null);
  const sessionsLoadSequenceRef = useRef(0);
  const sessionsRequestRef = useRef<{ controller: AbortController; promise: Promise<boolean> } | null>(null);
  const sessionsLastLoadedAtRef = useRef(0);
  const sessionsVisibilityRef = useRef(document.visibilityState);
  const sessionApiResponseRef = useRef("");
  const sessionApiStatusRef = useRef<number | null>(null);
  const restoreSessionDetailRef = useRef(shouldRestoreSessionDetail);
  const codexUsageRequestSequenceRef = useRef(0);
  const codexUsageAbortRef = useRef<AbortController | null>(null);
  const codexUsageCacheRef = useRef(new Map<string, { at: number; account: CodexUsageAccount }>());
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = (): void => setIsMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!sessionInspector) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSessionInspector(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sessionInspector]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (selectedId) {
      params.set("session", selectedId);
      if (window.matchMedia("(max-width: 760px)").matches) params.set("view", mobileView);
      else params.delete("view");
    } else {
      params.delete("session");
      params.delete("view");
    }
    const query = params.toString();
    const search = query ? `?${query}` : "";
    if (search === location.search) return;
    navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true, state: location.state });
  }, [location.hash, location.pathname, location.search, location.state, mobileView, navigate, selectedId]);

  useEffect(() => {
    const state = location.state as { sessionFileForward?: unknown } | null;
    const incoming = state?.sessionFileForward;
    if (!incoming || typeof incoming !== "object") return;
    const forward = incoming as Record<string, unknown>;
    if (typeof forward.id !== "string" || typeof forward.sessionId !== "string" || typeof forward.text !== "string") return;
    setSessionFileForward({ id: forward.id, sessionId: forward.sessionId, text: forward.text });
    setSessionInspector(null);
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

  const cancelSessionsRequest = useCallback((): void => {
    sessionsLoadSequenceRef.current += 1;
    sessionsRequestRef.current?.controller.abort();
    sessionsRequestRef.current = null;
  }, []);

  const loadSessions = useCallback((force = false): Promise<boolean> => {
    if (force) cancelSessionsRequest();
    if (sessionsRequestRef.current) return sessionsRequestRef.current.promise;
    const controller = new AbortController();
    const requestSequence = ++sessionsLoadSequenceRef.current;
    const promise = (async (): Promise<boolean> => {
      try {
        // Account discovery is loaded separately and cannot hold up the session list.
        const { status, rawResponse } = await requestTmuxSessions(API_ROOT + "/sessions?includeHomes=0", {
          signal: controller.signal,
          onRetry: (details) => console.warn("[tmux-sessions] retrying transient list failure", {
            ...details, visibility: document.visibilityState, online: navigator.onLine,
          }),
        });
        if (controller.signal.aborted || requestSequence !== sessionsLoadSequenceRef.current) return false;
        sessionApiResponseRef.current = rawResponse;
        sessionApiStatusRef.current = status;
        let result: { sessions?: unknown[]; error?: string };
        try { result = JSON.parse(rawResponse) as typeof result; }
        catch { throw new Error("The sessions API returned invalid JSON."); }
        if (!Array.isArray(result.sessions)) throw new Error("The sessions API response has no session list.");
        const normalizedSessions = result.sessions.map(normalizeTmuxSession);
        if (normalizedSessions.some((session) => session === null)) {
          throw new Error("The sessions API returned an unrecognized session record.");
        }
        const sessionList = normalizedSessions as TmuxSession[];
        sessionsLastLoadedAtRef.current = Date.now();
        setSessions((current) => tmuxSessionsEqual(current, sessionList) ? current : sessionList);
        setBackendStatus("online");
        setError(null);
        setSelectedId((current) => current && sessionList.some((session) => session.id === current && !session.endedAt && !session.suspendedAt) ? current : null);
        return true;
      } catch (loadError) {
        if (requestSequence !== sessionsLoadSequenceRef.current || controller.signal.aborted) return false;
        setBackendStatus("offline");
        setError(loadError instanceof Error ? loadError.message : "Could not load tmux sessions.");
        return false;
      } finally {
        if (sessionsRequestRef.current?.controller === controller) sessionsRequestRef.current = null;
      }
    })();
    sessionsRequestRef.current = { controller, promise };
    return promise;
  }, [cancelSessionsRequest]);

  const loadResurrectStatus = useCallback(async (): Promise<void> => {
    try {
      const result = await requestApi<TmuxResurrectStatus>("/resurrect/status");
      setResurrectStatus(result);
    } catch {
      // The session list remains usable when the optional snapshot integration is unavailable.
    }
  }, []);

  useEffect(() => {
    if (codexHomes.length > 0) cacheCodexHomeOptions(codexHomes);
  }, [codexHomes]);

  useEffect(() => {
    if (backendStatus !== "online") return;
    void loadResurrectStatus();
  }, [backendStatus, loadResurrectStatus]);

  useEffect(() => {
    if (backendStatus !== "online") return;
    let stopped = false;
    let inFlight = false;
    let retryTimer: number | undefined;
    let requestController: AbortController | null = null;

    const scheduleRetry = (): void => {
      if (stopped || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void loadHomes();
      }, CODEX_HOME_RETRY_INTERVAL_MS);
    };
    const loadHomes = async (): Promise<void> => {
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      const controller = new AbortController();
      requestController = controller;
      const timeout = window.setTimeout(() => controller.abort(), SESSION_REQUEST_TIMEOUT_MS);
      try {
        const result = await requestApi<{ codexHomes?: unknown }>("/codex-homes", { signal: controller.signal });
        const homes = normalizeCodexHomeOptions(result.codexHomes);
        if (!stopped && !controller.signal.aborted && homes.length > 0) setCodexHomes(homes);
        if (homes.length === 0) scheduleRetry();
      } catch {
        // Keep the last successful/default labels and retry without blocking the terminal.
        scheduleRetry();
      } finally {
        window.clearTimeout(timeout);
        if (requestController === controller) requestController = null;
        inFlight = false;
      }
    };
    const refreshWhenVisible = (): void => {
      if (document.visibilityState !== "hidden") {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
        void loadHomes();
      }
    };
    const refreshWhenOnline = (): void => {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      void loadHomes();
    };

    void loadHomes();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("online", refreshWhenOnline);
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      requestController?.abort();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenOnline);
    };
  }, [backendStatus]);

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
      request: { method: "GET", url: getBridgeOrigin() + API_ROOT + "/sessions?includeHomes=0" },
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
    const complete = (count: number): void => {
      setToast({
        message: count > 0
          ? `Requested download of ${count} scroll diagnostic entries.`
          : "No scroll logs yet. Scroll the terminal first, then export.",
        isError: false,
      });
    };
    const failed = (exportError: unknown): void => {
      setToast({
        message: exportError instanceof Error ? exportError.message : "Could not export scroll diagnostics.",
        isError: true,
      });
    };
    try {
      const result = downloadTerminalScrollDiagnostics();
      if (typeof result === "number") complete(result);
      else void result.then(complete).catch(failed);
    } catch (exportError) {
      failed(exportError);
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
    if (isMobile && mobileView === "terminal") return;
    sessionsVisibilityRef.current = document.visibilityState;
    const refreshSessionsIfStale = (): void => {
      if (document.visibilityState === "hidden" || !isSessionListRefreshStale(sessionsLastLoadedAtRef.current)) return;
      void loadSessions();
    };
    const onVisibilityChange = (): void => {
      const previous = sessionsVisibilityRef.current;
      const current = document.visibilityState;
      sessionsVisibilityRef.current = current;
      if (current === "hidden") {
        cancelSessionsRequest();
        return;
      }
      if (shouldRefreshSessionListOnVisibilityChange(previous, current, sessionsLastLoadedAtRef.current)) {
        void loadSessions();
      }
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (shouldRefreshSessionListOnPageShow(event.persisted, document.visibilityState, sessionsLastLoadedAtRef.current)) {
        void loadSessions();
      }
    };
    const onMobileResume = (): void => refreshSessionsIfStale();
    refreshSessionsIfStale();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener(MOBILE_RESUME_EVENT, onMobileResume);
    return () => {
      cancelSessionsRequest();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener(MOBILE_RESUME_EVENT, onMobileResume);
    };
  }, [cancelSessionsRequest, isMobile, loadSessions, mobileView]);

  const recordSessionOpen = useCallback(async (session: TmuxSession): Promise<void> => {
    try {
      const result = await requestApi<{ session: { openCount: number; lastOpenedAt: string | null } }>(
        `/sessions/${encodeURIComponent(session.id)}/open`, { method: "POST" },
      );
      setSessions((current) => current.map((item) => item.id === session.id && item.createdAt === session.createdAt
        ? { ...item, openCount: result.session.openCount, lastOpenedAt: result.session.lastOpenedAt }
        : item));
    } catch (openError) {
      setToast({ message: openError instanceof Error ? openError.message : "无法记录 Session 使用次数。", isError: true });
    }
  }, []);

  const openSessionInspector = (kind: "history" | "git", sessionId?: string): void => {
    const desktop = window.matchMedia("(min-width: 761px)").matches;
    if (desktop) {
      if (kind === "git" && sessionId) setSessionInspector({ kind, sessionId });
      else setSessionInspector({ kind: "history", sessionId: sessionId ?? null });
      return;
    }
    if (kind === "git" && sessionId) {
      navigate("/tmux-dashboard/git-changes/" + encodeURIComponent(sessionId));
    } else {
      navigate(sessionId ? `/tmux-dashboard/history?session=${encodeURIComponent(sessionId)}` : "/tmux-dashboard/history");
    }
  };

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    const ordered = [...sessions].sort(compareTmuxSessions);
    return query
      ? ordered.filter((session) => `${session.name} ${session.cwd}`.toLowerCase().includes(query))
      : ordered;
  }, [search, sessions]);
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    return query
      ? projects.filter((project) => `${project.name} ${project.root}`.toLowerCase().includes(query))
      : projects;
  }, [projectQuery, projects]);
  const selectedProject = projects.find((project) => project.name === newProjectName) ?? null;
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const sessionEditTarget = sessions.find((session) => session.id === sessionEditTargetId) ?? null;
  const terminalVisible = Boolean(selectedSession) && (!isMobile || mobileView === "terminal");
  const selectedCodexHomeLabel = selectedSession
    ? resolveCodexHomeLabel(selectedSession.codexHomeId, codexHomes, codexUsageAccount)
    : "";
  const selectedCodexHomeId = selectedSession?.codexHomeId ?? null;
  useLayoutEffect(() => {
    const createdId = createdSessionToRevealRef.current;
    if (!createdId) return;
    if (selectedId !== createdId) { createdSessionToRevealRef.current = null; return; }
    const entry = [...sessionListRef.current?.querySelectorAll<HTMLElement>("[data-session-id]") ?? []]
      .find((element) => element.dataset.sessionId === createdId);
    if (!entry || entry.getClientRects().length === 0) return;
    entry.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Opening updates usage-based ordering; reveal again after that update before clearing.
    if ((selectedSession?.openCount ?? 0) > 0) createdSessionToRevealRef.current = null;
  }, [filteredSessions, mobileView, selectedId, selectedSession]);

  const currentCodexRemainingPercentages = getCodexUsageRemainingPercentages(codexUsageAccount);
  const loadCurrentCodexUsage = useCallback(async (homeId: string, force = false): Promise<void> => {
    codexUsageAbortRef.current?.abort();
    const requestSequence = ++codexUsageRequestSequenceRef.current;
    const cached = codexUsageCacheRef.current.get(homeId);
    if (cached && Date.now() - cached.at < CODEX_USAGE_CACHE_MS && !force) {
      setCodexUsageAccount(cached.account);
      setCodexHomes((current) => mergeCodexHomeOption(current, cached.account));
      setCodexUsageLoading(false);
      setCodexUsageError(null);
      return;
    }
    const controller = new AbortController();
    codexUsageAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    setCodexUsageLoading(true);
    setCodexUsageError(null);
    try {
      const result = await fetchCodexUsage({ homeId, signal: controller.signal });
      const account = result.accounts.find((candidate) => candidate.homeId === homeId);
      if (!account) throw new Error("当前 Codex 账号没有返回用量数据。");
      if (codexUsageRequestSequenceRef.current !== requestSequence || controller.signal.aborted) return;
      if (!account.errors?.quota) {
        codexUsageCacheRef.current.set(homeId, { at: Date.now(), account });
      }
      setCodexHomes((current) => mergeCodexHomeOption(current, account));
      setCodexUsageAccount((previous) => preserveCodexUsageAccount(previous, account));
    } catch (requestError: unknown) {
      if (codexUsageRequestSequenceRef.current !== requestSequence) return;
      setCodexUsageError(controller.signal.aborted ? "Codex 用量请求超时，请重试。" : requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      window.clearTimeout(timeout);
      if (codexUsageRequestSequenceRef.current === requestSequence) setCodexUsageLoading(false);
      if (codexUsageAbortRef.current === controller) codexUsageAbortRef.current = null;
    }
  }, []);
  useEffect(() => {
    setCodexUsageAccount(null);
    setCodexUsageLoading(false);
    setCodexUsageError(null);
    setCodexUsageDialogOpen(false);
    // ATTACHED is set after xterm has parsed its first frame, not at WebSocket open.
    const timer = terminalVisible && terminalEverAttached && terminalStatus === "ATTACHED" && selectedCodexHomeId
      ? window.setTimeout(() => void loadCurrentCodexUsage(selectedCodexHomeId), 1_000)
      : undefined;
    return () => {
      window.clearTimeout(timer);
      codexUsageRequestSequenceRef.current += 1;
      codexUsageAbortRef.current?.abort();
      codexUsageAbortRef.current = null;
    };
  }, [loadCurrentCodexUsage, selectedCodexHomeId, selectedSession?.id, terminalEverAttached, terminalStatus, terminalVisible]);

  const selectSession = (sessionId: string): void => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.endedAt || session.suspendedAt) return;
    cancelSessionsRequest();
    restoreSessionDetailRef.current = false;
    if (sessionId !== selectedId) {
      setTerminalInputEnabled(false);
      setTerminalEverAttached(false);
      setTerminalStatus("CONNECTING");
    }
    setSelectedId(sessionId);
    if (window.matchMedia("(max-width: 760px)").matches) {
      setNavigationCollapsed(true);
      setMobileView("terminal");
    }
    void recordSessionOpen(session);
  };

  const showSessionsOnMobile = (): void => {
    restoreSessionDetailRef.current = false;
    setNavigationCollapsed(false);
    setMobileView("sessions");
  };
  useMobileBack(isMobile && mobileView === "terminal", showSessionsOnMobile, 0, { escape: false, restoreFocus: false });

  const refreshSessionsList = useCallback(async (): Promise<void> => {
    if (sessionsRefreshing) return;
    setSessionsRefreshing(true);
    setError(null);
    setToast({ message: "正在刷新 Session 列表…", isError: false });
    try {
      if (navigator.onLine === false) {
        setBackendStatus("offline");
        setToast({ message: "当前设备已离线，无法刷新 Session 列表；恢复网络后请重试。", isError: true });
        return;
      }
      const loaded = await loadSessions(true);
      setToast({
        message: loaded ? "Session 列表已刷新。" : "Session 列表刷新失败，请检查 Bridge 或网络连接后重试。",
        isError: !loaded,
      });
    } finally {
      setSessionsRefreshing(false);
    }
  }, [loadSessions, sessionsRefreshing]);

  const refreshSelectedSession = async (): Promise<void> => {
    setToast({ message: "正在重新获取 WebSocket 连接…", isError: false });
    terminalReconnectRef.current?.();
    await loadSessions(true);
  };

  const runSessionResurrectAction = async (session: TmuxSession, action: "save" | "restore"): Promise<void> => {
    if (!resurrectStatus?.installed) {
      setToast({ message: "tmux 快照插件尚未安装，请在 Bridge checkout 执行 bun run tmux:setup。", isError: true });
      return;
    }
    if (action === "restore" && !window.confirm(`恢复 Session「${session.name}」会重建它的窗口和 Pane，并按白名单重新启动进程。确定继续吗？`)) return;
    const busyKey = `${action}:${session.id}`;
    setResurrectBusy(busyKey);
    try {
      await requestApi<{ ok: true }>(`/sessions/${encodeURIComponent(session.id)}/resurrect/${action}`, { method: "POST" });
      if (action === "restore") await loadSessions(true);
      await loadResurrectStatus();
      setToast({
        message: action === "save"
          ? `Session「${session.name}」快照已保存。`
          : `Session「${session.name}」快照恢复已完成，正在刷新列表。`,
        isError: false,
      });
    } catch (resurrectError) {
      setToast({ message: resurrectError instanceof Error ? resurrectError.message : "Session 快照操作失败。", isError: true });
    } finally {
      setResurrectBusy((current) => current === busyKey ? null : current);
    }
  };

  useEffect(() => {
    if (backendStatus !== "online" || !selectedId || sessions.some((session) => session.id === selectedId && !session.endedAt && !session.suspendedAt)) return;
    setSelectedId(null);
    setTerminalInputEnabled(false);
    setMobileView("sessions");
    setNavigationCollapsed(false);
  }, [backendStatus, sessions, selectedId, setNavigationCollapsed]);

  useEffect(() => {
    if (!restoreSessionDetailRef.current || backendStatus !== "online") return;
    restoreSessionDetailRef.current = false;
    if (selectedId && sessions.some((session) => session.id === selectedId) && window.matchMedia("(max-width: 760px)").matches) {
      sessionsLoadSequenceRef.current += 1;
      setMobileView("terminal");
      setNavigationCollapsed(true);
    }
  }, [backendStatus, sessions, selectedId, setNavigationCollapsed]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!selectedSession || !host || !terminalVisible) {
      setTerminalStatus("IDLE");
      setTerminalEverAttached(false);
      return;
    }
    const activeSessionId = selectedSession.id;

    let cancelled = false;
    let disposeTerminal: (() => void) | undefined;
    setTerminalStatus("CONNECTING");
    setTerminalEverAttached(false);
    const initialize = async (): Promise<void> => {
      const [{ Terminal }, { FitAddon }, { CanvasAddon }] = await Promise.all([
        import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-canvas"),
      ]);
      if (cancelled) return;
      let everAttached = false;
      const terminal = new Terminal({
        cursorBlink: terminalInputEnabled,
        cursorInactiveStyle: terminalInputEnabled ? "block" : "none",
        // Keep xterm mouse/link handling alive in read-only view; onData below drops input until interactive mode is enabled.
        disableStdin: false,
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        linkHandler: {
          activate: (_event, text) => openTerminalUrl(text),
        },
        convertEol: false,
        fontSize: 13,
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        // The tmux PTY is the source of truth. Keep a bounded local buffer so
        // reconnects and redraws do not retain an unbounded TUI history.
        scrollback: 2_000,
        theme: getTmuxTerminalRenderTheme(resolvedThemeRef.current),
        minimumContrastRatio: resolvedThemeRef.current === "light" ? 7 : 1,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      const terminalLinks = registerTerminalLinkProvider(terminal);
      try {
        terminal.loadAddon(new CanvasAddon());
      } catch (error) {
        console.warn("xterm canvas renderer unavailable; keeping the DOM renderer.", error);
      }
      if (terminal.textarea) {
        terminal.textarea.readOnly = !terminalInputEnabled;
        terminal.textarea.inputMode = terminalInputEnabled ? "text" : "none";
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

      let disposed = false;
      let lastSentCols = 0;
      let lastSentRows = 0;
      let lastHostWidth = host.clientWidth;
      let lastHostHeight = host.clientHeight;
      let resizeFrame = 0;
      let forceResize = false;
      let keyboardResizePending = false;
      let keyboardCloseTimer = 0;
      const initialViewportHeight = window.visualViewport?.height ?? window.innerHeight;

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

      const transport = getTmuxTerminalTransport(activeSessionId);
      terminalTransportRef.current = transport;
      transport.setPathBuilder(() => "/tmux-dashboard/terminal?session=" + encodeURIComponent(activeSessionId)
        + "&cols=" + terminal.cols + "&rows=" + terminal.rows);

      const inputSubscription = terminal.onData((input) => {
        if (!terminalInputEnabled || disposed || !transport.isOpen()) return;
        transport.send({ type: "input", data: input });
      });
      const removeTouchScrolling = bindMobileTerminalTouch(host, terminal, setTerminalSelection, {
        enableDesktopSelection: !terminalInputEnabled,
      });

      let lastTerminalRenderDiagnosticAt = 0;
      let paintedConnectionId: number | null = null;
      const writeTerminalOutput = (data: string | Uint8Array, connectionId: number): void => {
        const needsReady = paintedConnectionId !== connectionId;
        if (!needsReady && !isDebugLogCaptureActive()) {
          terminal.write(data);
          return;
        }
        terminal.write(data, () => {
          if (disposed || terminalInstanceRef.current !== terminal) return;
          if (paintedConnectionId !== connectionId) {
            paintedConnectionId = connectionId;
            everAttached = true;
            setTerminalEverAttached(true);
            setTerminalStatus("ATTACHED");
          }
          if (!isDebugLogCaptureActive()) return;
          const now = Date.now();
          if (now - lastTerminalRenderDiagnosticAt < 750) return;
          lastTerminalRenderDiagnosticAt = now;
          // Diagnostics are sampled only when recording, after the frame has been parsed.
          const decodedOutput = typeof data === "string" ? data : new TextDecoder().decode(data);
          const rawBytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
          let highBitBytes = 0;
          for (const byte of rawBytes) if (byte >= 0x80) highBitBytes += 1;
          const buffer = terminal.buffer.active;
          let visibleText = "";
          for (let row = 0; row < terminal.rows; row += 1) {
            const line = buffer.getLine(buffer.viewportY + row);
            if (line) visibleText += line.translateToString(true) + "\n";
          }
          logDebugDiagnostic("tmux-terminal", "render-sample", {
            transportType: typeof data === "string" ? "websocket-text" : "websocket-binary",
            payloadBytes: rawBytes.byteLength,
            highBitBytes,
            output: summarizeUnicodeText(decodedOutput),
            buffer: { ...summarizeUnicodeText(visibleText), type: buffer.type, viewportY: buffer.viewportY, baseY: buffer.baseY },
            renderer: host.querySelector(".xterm-canvas") ? "canvas" : "dom",
            fontFamily: terminal.element ? getComputedStyle(terminal.element).fontFamily : "unknown",
            devicePixelRatio: window.devicePixelRatio,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        });
      };

      const resolvePendingSubmissions = (): void => {
        failPendingTmuxSubmissionsOnDisconnect(submissionWaitersRef.current);
      };
      const onTransportEvent = (event: TmuxTerminalTransportEvent): void => {
        if (disposed) return;
        if (event.type === "output") {
          writeTerminalOutput(event.data, event.connectionId);
          return;
        }
        if (event.type === "status") {
          setTerminalStatus(event.status);
          return;
        }
        if (event.type === "closed") {
          resolvePendingSubmissions();
          return;
        }
        const message = event.message;
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
          if (event.everAttached || everAttached) {
            setTerminalStatus("ERROR");
            setToast({ message: message.message || "Could not attach to the selected session.", isError: true });
          } else {
            setTerminalStatus("CONNECTING");
          }
        } else if (message.type === "input-error") {
          setToast({ message: message.message || "终端输入失败。", isError: true });
        } else if (message.type === "exit") {
          setTerminalStatus("DETACHED");
        }
      };

      const sendResize = (force = false): void => {
        if (!transport.isOpen()) return;
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
          if (!transport.send({ type: "resize", cols: terminal.cols, rows: terminal.rows })) return;
          lastSentCols = terminal.cols;
          lastSentRows = terminal.rows;
        } catch {
          return;
        }
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
      const onWindowResize = (): void => {
        if (
          window.matchMedia("(max-width: 760px)").matches
          && host.clientWidth === lastHostWidth
          && host.clientHeight === lastHostHeight
        ) return;
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
      const copyTerminalSelectionOnKeyDown = (event: KeyboardEvent): void => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c") return;
        const text = terminal.getSelection();
        if (!text) return;
        event.preventDefault();
        void copyTextToClipboard(text).then(() => {
          if (disposed || terminalInstanceRef.current !== terminal) return;
          terminal.clearSelection();
          setTerminalSelection(null);
          setToast({ message: "Copied terminal selection.", isError: false });
        }).catch((copyError: unknown) => {
          if (disposed) return;
          setToast({
            message: copyError instanceof Error ? copyError.message : "Could not copy terminal selection.",
            isError: true,
          });
        });
      };
      const resizeObserver = new ResizeObserver(() => {
        if (isKeyboardOpen()) {
          keyboardResizePending = true;
          return;
        }
        if (host.clientWidth === lastHostWidth && host.clientHeight === lastHostHeight) return;
        scheduleResize();
      });
      resizeObserver.observe(host);
      host.addEventListener("keydown", copyTerminalSelectionOnKeyDown);
      window.addEventListener("resize", onWindowResize);
      window.addEventListener("focusout", onComposerFocusOut, true);
      window.visualViewport?.addEventListener("resize", onViewportResize);
      const unsubscribe = transport.subscribe(onTransportEvent);
      terminalReconnectRef.current = transport.forceReconnect;
      scheduleResize(true);

      disposeTerminal = () => {
        disposed = true;
        window.clearTimeout(keyboardCloseTimer);
        window.cancelAnimationFrame(resizeFrame);
        inputSubscription.dispose();
        host.removeEventListener("keydown", copyTerminalSelectionOnKeyDown);
        window.removeEventListener("resize", onWindowResize);
        window.removeEventListener("focusout", onComposerFocusOut, true);
        window.visualViewport?.removeEventListener("resize", onViewportResize);
        if (terminalReconnectRef.current === transport.forceReconnect) terminalReconnectRef.current = null;
        resizeObserver.disconnect();
        unsubscribe();
        transport.release();
        selectionChange.dispose();
        removeTouchScrolling();
        if (terminalTransportRef.current === transport) terminalTransportRef.current = null;
        if (terminalInstanceRef.current === terminal) terminalInstanceRef.current = null;
        terminalLinks.dispose();
        terminal.dispose();
      };
    };
    void initialize().catch((failure: unknown) => {
      disposeTerminal?.();
      if (cancelled) return;
      setTerminalStatus("ERROR");
      setToast({ message: failure instanceof Error ? failure.message : "终端初始化失败。", isError: true });
    });
    return () => { cancelled = true; disposeTerminal?.(); };
  }, [selectedSession?.id, terminalInputEnabled, terminalVisible]);

  useEffect(() => {
    const terminal = terminalInstanceRef.current;
    if (!terminal) return;
    // xterm's renderer owns the canvas background, so changing only the page
    // CSS is not enough. Assign a fresh theme object to trigger the renderer
    // update without tearing down the PTY/WebSocket connection.
    terminal.options.theme = getTmuxTerminalRenderTheme(resolvedTheme);
    terminal.options.minimumContrastRatio = resolvedTheme === "light" ? 7 : 1;
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [resolvedTheme]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.durationMs ?? (toast.isError ? 8_000 : 3_200));
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sendMessage = async (messageText: string): Promise<SubmissionResult> => {
    const transport = terminalTransportRef.current;
    if (!selectedSession) return { ok: false, message: "Select a tmux session first." };
    if (!transport?.isOpen()) {
      const message = "The terminal connection is closed.";
      setToast({ message, isError: true });
      return { ok: false, message };
    }
    if (sendingMessage) return { ok: false, message: "A message is already being sent." };
    if (!messageText.trim()) return { ok: false, message: "Enter a message or attach an image." };

    // Git comments are editable composer text, not a separate delivery workflow.
    // Strip legacy hidden markers without requiring their old process receipts.
    const outboundText = stripGitReviewMarkers(messageText).trim();
    if (!outboundText) return { ok: false, message: "Enter a message or attach an image." };
    if (terminalInputEnabled) {
      const result = await sendTerminalCommand(outboundText);
      if (result.ok) setToast({ message: "命令已发送到终端。", isError: false });
      return result;
    }

    const requestId = ["submit", Date.now(), Math.random()].join("-");
    const submitPayload = JSON.stringify({
      type: "submit",
      requestId,
      text: outboundText,
    });
    if (new TextEncoder().encode(submitPayload).byteLength > 60 * 1024) {
      const message = "评论锚点和 composer 内容超过 WebSocket 安全上限；请减少本批意见后重试。";
      setToast({ message, isError: true });
      return { ok: false, message };
    }

    setSendingMessage(true);
    try {
      logDebugDiagnostic("tmux-submit", "client-send", summarizeUnicodeText(outboundText));
      const result = await new Promise<SubmissionResult>((resolve) => {
        const timeout = window.setTimeout(() => {
          if (!submissionWaitersRef.current.has(requestId)) return;
          submissionWaitersRef.current.delete(requestId);
          resolve({ ok: false, message: "发送确认超时，送达结果未知；消息可能已写入 Session。请先检查 Session，避免重复提交。" });
        }, 10_000);
        submissionWaitersRef.current.set(requestId, (response) => {
          window.clearTimeout(timeout);
          resolve(response);
        });
        try {
          if (!transport.send(submitPayload)) throw new Error("The terminal connection is closed.");
        } catch (sendError) {
          submissionWaitersRef.current.delete(requestId);
          window.clearTimeout(timeout);
          resolve({
            ok: false,
            message: sendError instanceof Error ? sendError.message : "Could not send the message.",
          });
        }
      });
      logDebugDiagnostic("tmux-submit", "client-result", { ok: result.ok, message: result.message ?? null, ...summarizeUnicodeText(outboundText) });
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
    const transport = terminalTransportRef.current;
    if (!selectedSession || !transport?.isOpen()) {
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
        if (!transport.send({ type: "command", requestId, text: command.trim() })) throw new Error("The terminal connection is closed.");
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
    const transport = terminalTransportRef.current;
    if (!selectedSession || !transport?.isOpen()) {
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
        if (!transport.send({ type: "key", requestId, key: shortcut })) throw new Error("The terminal connection is closed.");
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
    const transport = terminalTransportRef.current;
    if (!selectedSession || !transport?.isOpen()) {
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
        if (!transport.send({ type: "sequence", requestId, data: sequence })) throw new Error("The terminal connection is closed.");
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
    setNewWorkingDirectory(projects[0]?.root || "");
    setNewTaskDescription("");
    setProjectQuery("");
    setProjectPickerOpen(false);
    setProjectActiveIndex(0);
    setCreateOpen(true);
  };

  const openSessionEditDialog = (): void => {
    if (!selectedSession || selectedSession.endedAt || selectedSession.suspendedAt) return;
    setSessionEditTargetId(selectedSession.id);
    setSessionEditName(selectedSession.name);
    setSessionEditWorkingDirectory(selectedSession.cwd);
    setSessionEditError("");
  };

  const closeSessionEditDialog = (): void => {
    if (sessionEditBusy) return;
    setSessionEditTargetId(null);
    setSessionEditError("");
  };

  const saveSessionEdit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!sessionEditTarget) {
      setSessionEditError("Session 已不存在，请刷新列表。");
      return;
    }
    setSessionEditBusy(true);
    setSessionEditError("");
    try {
      const result = await requestApi<{ session: TmuxSession }>(`/sessions/${encodeURIComponent(sessionEditTarget.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: sessionEditName.trim(),
          workingDirectory: sessionEditWorkingDirectory.trim(),
        }),
      });
      const updated = normalizeTmuxSession(result.session);
      if (!updated) throw new Error("更新接口返回了无法识别的 Session，请刷新列表。");
      setSessions((current) => current.map((session) => session.id === sessionEditTarget.id && session.createdAt === sessionEditTarget.createdAt
        ? { ...session, ...updated }
        : session));
      setSessionEditTargetId(null);
      setToast({ message: `Session「${updated.name}」已更新。`, isError: false });
      void loadSessions(true);
    } catch (editError) {
      setSessionEditError(editError instanceof Error ? editError.message : "无法更新 Session。");
    } finally {
      setSessionEditBusy(false);
    }
  };

  const openProjectPicker = (): void => {
    setProjectQuery(selectedProject ? "" : newWorkingDirectory);
    setProjectActiveIndex(Math.max(0, projects.findIndex((project) => project.name === newProjectName)));
    setProjectPickerOpen(true);
  };

  const selectProject = (project: ProjectOption): void => {
    setNewProjectName(project.name);
    setNewWorkingDirectory(project.root);
    setProjectQuery("");
    setProjectPickerOpen(false);
    setProjectActiveIndex(-1);
  };

  const createSession = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const targetProject = projects.find((item) => item.name === newProjectName);
    const workingDirectory = newWorkingDirectory.trim();
    if (!workingDirectory) {
      setToast({ message: "请输入工作目录，或从项目列表中选择。", isError: true });
      return;
    }
    setCreateBusy(true);
    try {
      const taskDescription = newTaskDescription.trim();
      const result = await requestApi<{
        session: TmuxSession;
        initialTask?: { status: "submitted" | "failed"; error?: string };
      }>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          workingDirectory,
          ...(targetProject ? { projectKey: targetProject.name } : {}),
          ...(taskDescription ? { taskDescription } : {}),
        }),
      });
      const createdSession = normalizeTmuxSession(result.session);
      if (!createdSession) throw new Error("创建接口返回了无法识别的 Session，请刷新列表。");
      setCreateOpen(false);
      if (window.matchMedia("(max-width: 760px)").matches) {
        setNavigationCollapsed(true);
        setMobileView("terminal");
      }
      cancelSessionsRequest();
      restoreSessionDetailRef.current = false;
      createdSessionToRevealRef.current = createdSession.id;
      setSessions((current) => [createdSession, ...current.filter((session) => session.id !== createdSession.id)]);
      setSearch("");
      setBackendStatus("online");
      setError(null);
      setTerminalInputEnabled(false);
      setSelectedId(createdSession.id);
      setTerminalEverAttached(false);
      setTerminalStatus("CONNECTING");
      void recordSessionOpen(createdSession);
      setToast({
        message: result.initialTask?.status === "failed"
          ? `Session “${createdSession.name}” created, but the initial Codex-worktree task was not submitted: ${result.initialTask.error ?? "try again from the session"}`
          : result.initialTask?.status === "submitted"
            ? `Session “${createdSession.name}” created; Codex-worktree task submitted.`
            : `Session “${createdSession.name}” created.`,
        isError: result.initialTask?.status === "failed",
      });
      void loadSessions(true);
    } catch (createError) {
      setToast({ message: createError instanceof Error ? createError.message : "Could not create session.", isError: true });
    } finally {
      setCreateBusy(false);
    }
  };

  const openTrackedTaskDialog = async (): Promise<void> => {
    if (!selectedSession) return;
    setTrackedTaskError(null);
    setTrackedTaskDescription("");
    setTrackedTaskContext(null);
    trackedTaskSubmissionRef.current = null;
    setTrackedTaskOpen(true);
    setTrackedTaskContextLoading(true);
    try {
      const context = await requestApi<TaskCreationContext>(`/sessions/${encodeURIComponent(selectedSession.id)}/task-context`);
      setTrackedTaskContext(context);
    } catch (failure) {
      setTrackedTaskError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setTrackedTaskContextLoading(false);
    }
  };

  const createTrackedTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const session = selectedSession;
    const description = trackedTaskDescription.trim();
    if (!session || !description || trackedTaskBusy || !trackedTaskContext || trackedTaskContext.sessionId !== session.id || trackedTaskContext.dirtyEntryCount > 0) return;
    const previous = trackedTaskSubmissionRef.current;
    if (!previous || previous.sessionId !== session.id || previous.description !== description) {
      trackedTaskSubmissionRef.current = { sessionId: session.id, description, key: crypto.randomUUID() };
    }
    const submission = trackedTaskSubmissionRef.current;
    if (!submission) return;
    setTrackedTaskBusy(true);
    setTrackedTaskError(null);
    try {
      const result = await requestApi<{ task: { task_guid: string } }>(`/sessions/${encodeURIComponent(session.id)}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          description,
          idempotencyKey: submission.key,
          sourceDirectory: trackedTaskContext.directory,
          expectedBaseSha: trackedTaskContext.sourceHeadSha,
        }),
      });
      trackedTaskSubmissionRef.current = null;
      setTrackedTaskOpen(false);
      navigate(`/tasks/desk/${encodeURIComponent(result.task.task_guid)}`, {
        state: { returnTo: `${location.pathname}${location.search}` },
      });
    } catch (failure) {
      setTrackedTaskError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setTrackedTaskBusy(false);
    }
  };

  const suspendSession = async (session: TmuxSession): Promise<void> => {
    if (session.endedAt || session.suspendedAt || !window.confirm(`挂起 Session「${session.name}」？这会保存独立快照并停止其中的进程，之后可以恢复。`)) return;
    const busyKey = `suspend:${session.id}`;
    setResurrectBusy(busyKey);
    try {
      await requestApi(`/sessions/${encodeURIComponent(session.id)}/suspend`, { method: "POST" });
      if (selectedId === session.id) {
        setSelectedId(null);
        setTerminalInputEnabled(false);
        if (window.matchMedia("(max-width: 760px)").matches) {
          setMobileView("sessions");
          setNavigationCollapsed(false);
        }
      }
      await loadSessions(true);
      setToast({ message: `Session「${session.name}」已挂起，可从列表恢复。`, isError: false });
    } catch (suspendError) {
      setToast({ message: suspendError instanceof Error ? suspendError.message : "无法挂起 Session。", isError: true });
    } finally {
      setResurrectBusy((current) => current === busyKey ? null : current);
    }
  };

  const resumeSession = async (session: TmuxSession): Promise<void> => {
    if (!session.suspendedAt) return;
    const busyKey = `resume:${session.id}`;
    setResurrectBusy(busyKey);
    try {
      const result = await requestApi<{ session: { id: string; name: string } }>(`/sessions/${encodeURIComponent(session.id)}/resume`, { method: "POST" });
      await loadSessions(true);
      setSelectedId(result.session.id);
      setTerminalInputEnabled(false);
      setTerminalEverAttached(false);
      setTerminalStatus("CONNECTING");
      if (window.matchMedia("(max-width: 760px)").matches) {
        setNavigationCollapsed(true);
        setMobileView("terminal");
      }
      setToast({ message: `Session「${result.session.name}」已恢复。`, isError: false });
    } catch (resumeError) {
      setToast({ message: resumeError instanceof Error ? resumeError.message : "无法恢复 Session。", isError: true });
    } finally {
      setResurrectBusy((current) => current === busyKey ? null : current);
    }
  };

  const endSession = async (session: TmuxSession | null = selectedSession): Promise<void> => {
    if (!session || !window.confirm(`确认终结 Session「${session.name}」？这会永久结束它的可恢复状态；历史记录仍可查看。`)) return;
    try {
      await requestApi<void>(`/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      const wasSelected = selectedId === session.id;
      if (wasSelected) {
        sessionsLoadSequenceRef.current += 1;
        restoreSessionDetailRef.current = false;
        setSelectedId(null);
        setTerminalInputEnabled(false);
      }
      if (wasSelected && window.matchMedia("(max-width: 760px)").matches) {
        setMobileView("sessions");
        setNavigationCollapsed(false);
      }
      await loadSessions(true);
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
      await loadSessions(true);
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
        await loadSessions(true);
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
    : terminalStatus === "CONNECTING"
      ? "正在连接 Session WebSocket；如果 VPN 或 Bridge 不可用，请稍后重试。"
    : terminalStatus === "RECONNECTING"
      ? "Session 连接中断，正在自动重连；请等待连接恢复。"
      : terminalStatus === "ERROR"
        ? "Session 连接发生错误，可以手动刷新连接。"
        : "Session 已断开，可以手动刷新连接。";
  const showConnectionBanner = Boolean(selectedSession)
    && terminalStatus !== "ATTACHED" && terminalStatus !== "IDLE";

  return (
    <main className={`dashboard-page${mobileView === "terminal" ? " is-mobile-terminal" : ""}${navigationCollapsed ? " is-navigation-collapsed" : ""}`}>
      {error ? <div className="dashboard-error" role="alert">{error}</div> : null}
      <section className={`dashboard-main is-mobile-${mobileView}`}>
        <aside className="dashboard-sidebar">
          <div className="dashboard-sidebar-heading">
            <div><h2>Sessions <span>{sessions.length}</span></h2></div>
            <div className="dashboard-session-tools">
              <span
                className={`dashboard-backend-indicator dashboard-backend-${backendStatus}`}
                role="img"
                aria-label={`Backend ${backendStatus}`}
                title={`Backend ${backendStatus}`}
              />
              <button
                className={`dashboard-action dashboard-icon-button dashboard-refresh-button${sessionsRefreshing ? " is-refreshing" : ""}`}
                type="button"
                onClick={() => void refreshSessionsList()}
                disabled={sessionsRefreshing}
                aria-busy={sessionsRefreshing}
                aria-label={sessionsRefreshing ? "正在刷新 Session 列表" : "刷新 Session 列表"}
                title={sessionsRefreshing ? "正在刷新 Session 列表" : "刷新 Session 列表"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M20 7v5h-5" />
                  <path d="M4 17v-5h5" />
                  <path d="M5.6 9A7 7 0 0 1 18 6.3L20 8M4 16l2 1.7A7 7 0 0 0 18.4 15" />
                </svg>
              </button>
              <button
                className="dashboard-action dashboard-icon-button dashboard-history-top"
                type="button"
                onClick={() => openSessionInspector("history")}
                aria-label="查看 Session 操作历史"
                title="查看 Session 操作历史"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </button>
              {import.meta.env.DEV ? (
                <button
                  className="dashboard-action dashboard-copy-api"
                  type="button"
                  onClick={() => void copySessionsApiResponse()}
                  aria-label="Copy the latest sessions API request and response"
                  title="Copy the latest sessions API request and response"
                >⧉</button>
              ) : null}
              <button
                className="dashboard-add dashboard-icon-button"
                type="button"
                onClick={openCreateDialog}
                disabled={projects.length === 0}
                aria-label="新建 Session"
                title="新建 Session"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
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
              onChange={(event) => { setSearch(event.target.value); setSelectedId(null); setTerminalInputEnabled(false); }}
            />
          </label>
          <div ref={sessionListRef} className="dashboard-session-list" aria-live="polite">
            {sessions.length === 0 && backendStatus === "online" ? <p className="dashboard-empty-list">No local tmux sessions.</p> : null}
            {sessions.length > 0 && filteredSessions.length === 0 ? <p className="dashboard-empty-list">No matching sessions.</p> : null}
            {filteredSessions.map((session) => (
              <div key={`${session.id}:${session.createdAt}`} data-session-id={session.id} className={`dashboard-session-entry${selectedId === session.id ? " is-selected" : ""}${session.endedAt ? " is-archived" : ""}${session.suspendedAt ? " is-suspended" : ""}`}>
                <button className="dashboard-session-card" type="button" disabled={Boolean(session.endedAt || session.suspendedAt)} onClick={() => selectSession(session.id)} aria-current={selectedId === session.id ? "true" : undefined} title={session.endedAt ? "Session 已终结；历史记录仍可查看" : session.suspendedAt ? "Session 已挂起；点击恢复" : "打开 Session 详情"}>
                  <span className="dashboard-session-top"><strong>{session.name}</strong><span className={session.attachedClients > 0 ? "is-active" : ""} title={session.attachedClients > 0 ? "Attached" : "Detached"} /></span>
                  <span className="dashboard-session-path" title={session.cwd}>{session.cwd}</span>
                  <span className="dashboard-session-meta">{session.endedAt ? "已终结" : session.suspendedAt ? "已挂起" : `${session.windows} ${session.windows === 1 ? "window" : "windows"}`}<span>{session.openCount} 次使用 · {session.endedAt || session.suspendedAt ? "可恢复/查看历史" : session.attachedClients > 0 ? `${session.attachedClients} attached` : "detached"}</span></span>
                  {session.workspaceBranch ? <span className="dashboard-session-worktree">任务分支 · {session.workspaceBranch} · {session.workspaceStatus ?? "工作区"}</span> : null}
                </button>
                <div className="dashboard-session-actions" aria-label={`${session.name} 操作`}>
                  <CodexHomeSelect
                    session={session}
                    homes={codexHomes}
                    disabled={Boolean(session.endedAt || session.suspendedAt) || savingCodexHomeId === session.id}
                    onChange={(target, homeId) => { void updateCodexHome(target, homeId); }}
                  />
                  {session.endedAt
                    ? <span className="dashboard-session-archived-label">已归档</span>
                    : session.suspendedAt
                      ? <span className="dashboard-session-archived-label">已挂起</span>
                      : <button type="button" onClick={() => selectSession(session.id)}>详情</button>}
                  <button type="button" onClick={() => openSessionInspector("history", session.id)}>历史</button>
                  {!session.endedAt ? (
                    <details className="dashboard-session-action-menu">
                      <summary aria-label={`${session.name} 更多操作`} title="更多操作">•••</summary>
                      <button className="dashboard-session-action-backdrop" type="button" aria-label="关闭操作菜单" onClick={closeSessionActionMenu} />
                      <div className="dashboard-session-action-panel">
                        <div className="dashboard-session-action-buttons">
                          {session.suspendedAt ? (
                            <button type="button" disabled={!resurrectStatus?.installed || resurrectBusy !== null} aria-busy={resurrectBusy === `resume:${session.id}`} onClick={() => void resumeSession(session)}>恢复</button>
                          ) : (
                            <>
                              <button type="button" disabled={!resurrectStatus?.installed || resurrectBusy !== null} aria-busy={resurrectBusy === `save:${session.id}`} onClick={() => void runSessionResurrectAction(session, "save")}>{session.snapshot ? "更新快照" : "保存快照"}</button>
                              <button type="button" disabled={resurrectBusy !== null} aria-busy={resurrectBusy === `suspend:${session.id}`} onClick={() => void suspendSession(session)}>挂起</button>
                            </>
                          )}
                          <button className="dashboard-session-end" type="button" onClick={() => void endSession(session)}>终结</button>
                        </div>
                        <button className="dashboard-session-action-cancel" type="button" aria-label="取消操作菜单" title="取消" onClick={closeSessionActionMenu}>× 取消</button>
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="dashboard-sidebar-footer">
            <span />
            <span>
              Connected to your local tmux
              {resurrectStatus?.perSessionRestore ? " · 按 Session 自动恢复" : resurrectStatus?.installed ? " · 快照插件已安装" : " · 快照插件未配置"}
            </span>
          </div>
        </aside>
        <section className="dashboard-workspace" aria-label="Session terminal">
          <div className="dashboard-workspace-toolbar">
            <button className="dashboard-mobile-back" type="button" onClick={showSessionsOnMobile} aria-label="Back to sessions">‹</button>
            <div className="dashboard-active-session"><div><div className="dashboard-active-session-title"><strong>{selectedSession?.name ?? "No session selected"}</strong>{selectedSession ? <button className="dashboard-active-session-edit" type="button" onClick={openSessionEditDialog} disabled={Boolean(selectedSession.endedAt || selectedSession.suspendedAt)} aria-label="编辑 Session 名称和工作目录" title="编辑 Session 名称和工作目录"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5z" /><path d="m13.8 6.7 3.5 3.5" /></svg></button> : null}</div><span title={selectedSession?.cwd}>{selectedSession?.workspaceBranch ? `任务分支 ${selectedSession.workspaceBranch} · ${selectedSession.workspaceStatus ?? "工作区"} · ` : ""}{selectedSession?.cwd ?? "Choose a session to open its terminal"}</span></div></div>
            {selectedSession ? (
              <div className="dashboard-codex-inline" aria-label="Session 账号与操作">
                <button
                  className={`dashboard-terminal-mode-toggle${terminalInputEnabled ? " is-active" : ""}`}
                  type="button"
                  disabled={terminalStatus !== "ATTACHED"}
                  aria-pressed={terminalInputEnabled}
                  aria-label={terminalInputEnabled ? "关闭终端输入，返回只读输出" : "开启终端输入"}
                  title={terminalInputEnabled ? "关闭终端输入；返回只读输出" : "开启终端输入；按键会直接发送到当前 tmux Session"}
                  onClick={() => setTerminalInputEnabled((current) => !current)}
                >
                  {terminalInputEnabled ? (
                    <svg className="dashboard-terminal-mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <rect x="3" y="4" width="18" height="15" rx="2" />
                      <path d="m7 9 3 3-3 3" />
                      <path d="M13 15h3M17 8v6" />
                    </svg>
                  ) : (
                    <svg className="dashboard-terminal-mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <rect x="3" y="4" width="18" height="15" rx="2" />
                      <path d="m7 9 3 3-3 3" />
                      <path d="M13 15h2" />
                      <rect x="15" y="13" width="6" height="6" rx="1.2" />
                      <path d="M17 13v-1a2 2 0 0 1 4 0v1" />
                    </svg>
                  )}
                </button>
                <button
                  className="dashboard-codex-usage-trigger"
                  type="button"
                  disabled={!selectedSession.codexHomeId || terminalStatus !== "ATTACHED"}
                  onClick={() => setCodexUsageDialogOpen(true)}
                  title={!selectedSession.codexHomeId
                    ? "当前 Session 未关联 Codex 账号"
                    : terminalStatus !== "ATTACHED" ? "终端连接完成后查看 Codex 用量" : "查看当前 Codex 用量"}
                  aria-label={selectedSession.codexHomeId
                    ? terminalStatus === "ATTACHED"
                      ? `${selectedCodexHomeLabel} Codex 剩余额度：${currentCodexRemainingPercentages[0]}，${currentCodexRemainingPercentages[1]}，点击查看详情`
                      : "终端连接完成后查看 Codex 用量"
                    : "当前 Session 未关联 Codex 账号"}
                >
                  <span className="dashboard-codex-home-label" title={selectedCodexHomeLabel}>{selectedCodexHomeLabel}</span>
                  <span className="dashboard-codex-usage-summary">
                    {currentCodexRemainingPercentages[0]}·{currentCodexRemainingPercentages[1]}
                  </span>
                </button>
                <details className="dashboard-codex-actions">
                  <summary aria-label="Session 操作" title="Session 操作"><span className="menu-chevron" aria-hidden="true" /></summary>
                  <div className="dashboard-codex-actions-panel">
                    <button type="button" onClick={() => openSessionInspector("history", selectedSession.id)}>
                      查看历史（当前 Session）
                    </button>
                    <button type="button" onClick={() => openSessionInspector("git", selectedSession.id)}>
                      查看 Git 变更
                    </button>
                    {selectedSession.taskGuid ? <button type="button" onClick={() => navigate(`/tasks/desk/${encodeURIComponent(selectedSession.taskGuid!)}`, { state: { returnTo: `${location.pathname}${location.search}` } })}>打开关联任务</button> : null}
                    <button type="button" onClick={() => void openTrackedTaskDialog()}>从当前目录创建 Bridge 任务</button>
                    <CodexHomeSelect
                      session={selectedSession}
                      homes={codexHomes}
                      disabled={savingCodexHomeId === selectedSession.id}
                      onChange={(target, homeId) => { void updateCodexHome(target, homeId); }}
                    />
                    <button type="button" disabled={terminalStatus !== "ATTACHED" || checkingCodexHomeId === selectedSession.id} onClick={() => void checkCodexHome(selectedSession)}>
                      {checkingCodexHomeId === selectedSession.id ? "检查中…" : terminalStatus === "ATTACHED" ? "刷新账号" : "终端连接后检查账号"}
                    </button>
                    <button type="button" onClick={() => void refreshSelectedSession()}>刷新 Session</button>
                    {!selectedSession.suspendedAt && !selectedSession.endedAt ? (
                      <>
                        <button type="button" disabled={!resurrectStatus?.installed || resurrectBusy !== null} aria-busy={resurrectBusy === `save:${selectedSession.id}`} onClick={() => void runSessionResurrectAction(selectedSession, "save")}>
                          {selectedSession.snapshot ? "更新快照" : "保存快照"}
                        </button>
                        <button type="button" disabled={resurrectBusy !== null} aria-busy={resurrectBusy === `suspend:${selectedSession.id}`} onClick={() => void suspendSession(selectedSession)}>挂起 Session</button>
                      </>
                    ) : null}
                    <button className="dashboard-session-end" type="button" onClick={() => void endSession(selectedSession)}>终结 Session</button>
                  </div>
                </details>
              </div>
            ) : null}
          </div>
          {showConnectionBanner ? (
            <div className={`dashboard-connection-banner is-${terminalStatus.toLowerCase()}`} role="alert">
              <span>{connectionMessage}</span>
              <button
                className="dashboard-fetch-button"
                type="button"
                onClick={() => void refreshSelectedSession()}
                disabled={!selectedSession}
                aria-label="重新获取 WebSocket 连接"
                title="重新获取 WebSocket 连接"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M20 7v5h-5" />
                  <path d="M4 17v-5h5" />
                  <path d="M5.6 9A7 7 0 0 1 18 6.3L20 8M4 16l2 1.7A7 7 0 0 0 18.4 15" />
                </svg>
              </button>
            </div>
          ) : null}
          <div className={`dashboard-terminal-frame${selectedSession ? "" : " is-empty"}${selectedSession && terminalInputEnabled ? " is-terminal-interactive" : ""}`}>
            {selectedSession && terminalSelection?.text ? (
              <button
                className="dashboard-terminal-copy-selection"
                type="button"
                onClick={() => void copyTerminalSelection()}
                style={{ left: terminalSelection.left, top: terminalSelection.top }}
                aria-label="Copy selected terminal text"
              >Copy</button>
            ) : null}
            {selectedSession ? <div className="dashboard-terminal-host" ref={terminalHostRef} style={{ "--tmux-terminal-render-background": getTmuxTerminalRenderTheme(resolvedTheme).background } as CSSProperties} /> : (
              <div className="dashboard-empty-state"><div>&gt;_</div><h2>No session selected</h2><p>Choose a session from the list to attach its terminal.</p><button type="button" onClick={openCreateDialog} disabled={projects.length === 0}>+ New session</button></div>
            )}
          </div>
          {terminalVisible ? <Suspense fallback={null}><TmuxMessageComposer
            key={selectedSession?.id ?? "no-session"}
            sessionId={selectedSession?.id ?? null}
            sessionFileForward={selectedSession?.id === sessionFileForward?.sessionId ? sessionFileForward : null}
            onSessionFileForwardConsumed={(requestId) => {
              setSessionFileForward((current) => current?.id === requestId ? null : current);
            }}
            diagnosticSessionActive={Boolean(selectedSession) && mobileView === "terminal" && terminalStatus === "ATTACHED"}
            disabled={!selectedSession}
            sendDisabled={!selectedSession || terminalStatus !== "ATTACHED"}
            sending={sendingMessage}
            placeholder={selectedSession ? (terminalInputEnabled ? "输入终端命令…" : "Message the Codex session…") : "Select a session to start messaging"}
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
          /></Suspense> : null}
        </section>
      </section>
      {sessionEditTarget ? (
        <div className="dashboard-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSessionEditDialog(); }}>
          <form className="dashboard-modal dashboard-session-edit-modal" onSubmit={(event) => void saveSessionEdit(event)}>
            <div className="dashboard-modal-heading"><div><p className="dashboard-eyebrow">SESSION SETTINGS</p><h2>编辑 Session</h2></div><button type="button" onClick={closeSessionEditDialog} aria-label="Close" disabled={sessionEditBusy}>×</button></div>
            <label className="dashboard-modal-field">Session 名称<input value={sessionEditName} onChange={(event) => setSessionEditName(event.target.value)} required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" autoComplete="off" autoFocus disabled={sessionEditBusy} /></label>
            <label className="dashboard-modal-field">Working directory<input value={sessionEditWorkingDirectory} onChange={(event) => setSessionEditWorkingDirectory(event.target.value)} required maxLength={4096} autoComplete="off" disabled={sessionEditBusy} /></label>
            <p className="muted">该目录仅用于 Git 变更和文件浏览，不会修改当前 pane 的目录；正在运行的 Codex 会继续使用原工作目录。</p>
            {sessionEditError ? <div className="error" role="alert">{sessionEditError}</div> : null}
            <div className="dashboard-modal-actions"><button className="dashboard-action" type="button" onClick={closeSessionEditDialog} disabled={sessionEditBusy}>取消</button><button className="dashboard-submit" type="submit" disabled={sessionEditBusy || !sessionEditName.trim() || !sessionEditWorkingDirectory.trim()}>{sessionEditBusy ? "保存中…" : "保存"}</button></div>
          </form>
        </div>
      ) : null}
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
                  maxLength={4096}
                  placeholder="输入目录，或选择项目…"
                  value={projectPickerOpen ? projectQuery : selectedProject?.name ?? newWorkingDirectory}
                  onFocus={openProjectPicker}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setProjectQuery(value);
                    setNewWorkingDirectory(value);
                    setProjectActiveIndex(0);
                    setNewProjectName("");
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
                      <div className="dashboard-project-option-empty" role="option" aria-selected="false" aria-disabled="true">No matching projects; the typed directory can still be used.</div>
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
            <label className="dashboard-modal-field">Initial Codex-worktree task (optional)<textarea value={newTaskDescription} onChange={(event) => setNewTaskDescription(event.target.value)} maxLength={20_000} rows={5} disabled={createBusy} placeholder="Describe the work to start in this Session…" /></label>
            <div className="dashboard-modal-actions"><button className="dashboard-action" type="button" onClick={() => setCreateOpen(false)}>Cancel</button><button className="dashboard-submit" type="submit" disabled={createBusy || !newWorkingDirectory.trim()}>{createBusy ? "Creating…" : "Create session"}</button></div>
          </form>
        </div>
      ) : null}
      {trackedTaskOpen && selectedSession ? (
        <div className="dashboard-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !trackedTaskBusy) setTrackedTaskOpen(false); }}>
          <form className="dashboard-modal dashboard-task-create-modal" onSubmit={(event) => void createTrackedTask(event)}>
            <div className="dashboard-modal-heading"><div><p className="dashboard-eyebrow">NEW BRIDGE TASK</p><h2>从当前 Session 创建任务</h2></div><button type="button" onClick={() => setTrackedTaskOpen(false)} aria-label="Close" disabled={trackedTaskBusy}>×</button></div>
            <p className="muted">{trackedTaskContextLoading ? "正在读取当前 pane 目录和 master 基准…" : trackedTaskContext ? `项目：${trackedTaskContext.projectName} · 来源目录：${trackedTaskContext.directory}` : `Session：${selectedSession.name}`}</p>
            {trackedTaskContext ? <p className="muted">来源：{trackedTaskContext.branch ?? "detached"} · HEAD {trackedTaskContext.sourceHeadSha.slice(0, 12)} · 创建基准：{trackedTaskContext.baseRef} {trackedTaskContext.targetBaseSha.slice(0, 12)}{trackedTaskContext.dirtyEntryCount ? ` · ${trackedTaskContext.dirtyEntryCount} 项未提交改动` : " · 工作区 clean"}</p> : null}
            <p className="muted">任务会从本地 master 创建独立 worktree；当前 pane 只用于确定项目和校验来源 HEAD，源目录未提交的改动不会复制。</p>
            <label className="dashboard-modal-field">任务描述<textarea value={trackedTaskDescription} onChange={(event) => setTrackedTaskDescription(event.target.value)} maxLength={20_000} rows={7} required autoFocus disabled={trackedTaskBusy} placeholder="描述需要完成的工作" /></label>
            {trackedTaskError ? <div className="error" role="alert">{trackedTaskError}</div> : null}
            <div className="dashboard-modal-actions"><button className="dashboard-action" type="button" onClick={() => setTrackedTaskOpen(false)} disabled={trackedTaskBusy}>取消</button><button className="dashboard-submit" type="submit" disabled={trackedTaskBusy || trackedTaskContextLoading || !trackedTaskContext || trackedTaskContext.dirtyEntryCount > 0 || !trackedTaskDescription.trim()}>{trackedTaskBusy ? "提交中…" : trackedTaskContext?.dirtyEntryCount ? "先处理未提交改动" : "创建任务和 worktree"}</button></div>
          </form>
        </div>
      ) : null}
      {codexUsageDialogOpen && selectedCodexHomeId ? (
        <CodexUsageDialog
          accountLabel={selectedCodexHomeLabel}
          account={codexUsageAccount}
          loading={codexUsageLoading}
          error={codexUsageError}
          onRefresh={() => loadCurrentCodexUsage(selectedCodexHomeId, true)}
          onClose={() => setCodexUsageDialogOpen(false)}
        />
      ) : null}
      {sessionInspector ? (
        <div
          className="dashboard-inspector-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setSessionInspector(null); }}
        >
          <section className="dashboard-inspector-modal" role="dialog" aria-modal="true" aria-label={sessionInspector.kind === "history" ? "Session 操作历史" : "Git 变更"}>
            <button className="dashboard-inspector-close" type="button" onClick={() => setSessionInspector(null)} aria-label="关闭">×</button>
            <Suspense fallback={<div className="dashboard-inspector-loading">正在加载…</div>}>
              {sessionInspector.kind === "history" ? (
                <TmuxHistoryInspector embedded sessionIdOverride={sessionInspector.sessionId} />
              ) : (
                <TmuxGitChangesInspector embedded sessionId={sessionInspector.sessionId} />
              )}
            </Suspense>
          </section>
        </div>
      ) : null}
      {toast ? <div className={`dashboard-toast${toast.isError ? " is-error" : ""}`} role="status">{toast.message}</div> : null}
    </main>
  );
}
