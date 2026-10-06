import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";

import { App } from "./App.js";
import { SystemNavigationProvider, WebNavigation } from "./WebNavigation.js";
import { AuthGate, PairingAdmin } from "./auth.js";
import { ThemeProvider } from "./theme.js";
import "./styles.css";

const TmuxDashboard = lazy(() => import("./TmuxDashboard.js").then((module) => ({ default: module.TmuxDashboard })));
const TmuxSessionFiles = lazy(() => import("./TmuxSessionFiles.js").then((module) => ({ default: module.TmuxSessionFiles })));
const TmuxSessionHistory = lazy(() => import("./TmuxSessionHistory.js").then((module) => ({ default: module.TmuxSessionHistory })));
const CodexHistory = lazy(() => import("./CodexHistory.js").then((module) => ({ default: module.CodexHistory })));
const ShortcutManagement = lazy(() => import("./ShortcutManagement.js").then((module) => ({ default: module.ShortcutManagement })));
const CodexUsage = lazy(() => import("./CodexUsage.js").then((module) => ({ default: module.CodexUsage })));
const ProjectManagement = lazy(() => import("./ProjectManagement.js").then((module) => ({ default: module.ProjectManagement })));
const TaskDetailPage = lazy(() => import("./TaskDetailPage.js").then((module) => ({ default: module.TaskDetailPage })));
const SystemHealth = lazy(() => import("./SystemHealth.js").then((module) => ({ default: module.SystemHealth })));
const SystemBackups = lazy(() => import("./SystemBackups.js").then((module) => ({ default: module.SystemBackups })));

function LegacyDirectTasksRedirect() {
  const location = useLocation();
  const oldParams = new URLSearchParams(location.search);
  const params = new URLSearchParams({ source: "direct" });
  if (oldParams.get("q")) params.set("q", oldParams.get("q")!);
  if (oldParams.get("status")) params.set("state", oldParams.get("status")!);
  if (oldParams.get("offset")) params.set("offset", oldParams.get("offset")!);
  const taskId = oldParams.get("task");
  if (taskId) return <Navigate to={`/tasks/direct/${encodeURIComponent(taskId)}`} state={{ returnTo: `/?${params.toString()}` }} replace />;
  return <Navigate to={`/?${params.toString()}`} replace />;
}

function disableBrowserPullToRefresh(): void {
  let startY: number | null = null;
  let startTarget: EventTarget | null = null;

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      startY = null;
      startTarget = null;
      return;
    }
    startY = event.touches[0]?.clientY ?? null;
    startTarget = event.target;
  };

  const hasContentAbove = (target: EventTarget | null): boolean => {
    let element = target instanceof Element ? target : null;
    while (element) {
      const style = window.getComputedStyle(element);
      const scrollable = /auto|scroll|overlay/.test(style.overflowY)
        && element.scrollHeight > element.clientHeight + 1;
      if (scrollable && element.scrollTop > 0) return true;
      element = element.parentElement;
    }
    return window.scrollY > 0
      || document.documentElement.scrollTop > 0
      || document.body.scrollTop > 0;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (startY === null || event.touches.length !== 1 || !event.cancelable) return;
    const currentY = event.touches[0]?.clientY;
    if (currentY === undefined || currentY - startY < 4) return;
    const target = startTarget instanceof Element ? startTarget : null;
    if (target?.closest("input, textarea, select, [contenteditable='true'], .vc-switch")) return;
    if (!hasContentAbove(startTarget)) event.preventDefault();
  };

  const clearTouch = (): void => {
    startY = null;
    startTarget = null;
  };

  document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
  document.addEventListener("touchend", clearTouch, { passive: true, capture: true });
  document.addEventListener("touchcancel", clearTouch, { passive: true, capture: true });
}

type MobileVConsole = {
  showSwitch: () => void;
  hide: () => void;
  setSwitchPosition: (right: number, bottom: number) => void;
};

function makeVConsoleSwitchMovable(vConsole: MobileVConsole): void {
  const attach = (): boolean => {
    const switchElement = document.querySelector<HTMLElement>(".vc-switch");
    if (!switchElement || switchElement.dataset.dashboardMovable === "true") return Boolean(switchElement);
    switchElement.dataset.dashboardMovable = "true";
    switchElement.style.touchAction = "none";
    vConsole.showSwitch();
    vConsole.hide();
    vConsole.setSwitchPosition(16, Math.max(90, window.innerHeight - 110));

    let dragging = false;
    let moved = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    const onPointerDown = (event: PointerEvent): void => {
      dragging = true;
      moved = false;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      switchElement.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || event.pointerId !== pointerId) return;
      const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (distance < 5) return;
      moved = true;
      event.preventDefault();
      const rect = switchElement.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - event.clientX - rect.width / 2);
      const bottom = Math.max(8, window.innerHeight - event.clientY - rect.height / 2);
      vConsole.setSwitchPosition(right, bottom);
    };
    const finishPointer = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = -1;
    };
    const ignoreClickAfterDrag = (event: MouseEvent): void => {
      if (!moved) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      moved = false;
    };
    switchElement.addEventListener("pointerdown", onPointerDown);
    switchElement.addEventListener("pointermove", onPointerMove, { passive: false });
    switchElement.addEventListener("pointerup", finishPointer);
    switchElement.addEventListener("pointercancel", finishPointer);
    switchElement.addEventListener("click", ignoreClickAfterDrag, true);
    return true;
  };

  if (!attach()) window.setTimeout(attach, 100);
}

async function mountApp(): Promise<void> {
  disableBrowserPullToRefresh();
  if (import.meta.env.DEV) {
    try {
      const { default: VConsole } = await import("vconsole");
      const vConsole = VConsole.instance ?? new VConsole({ theme: "dark", network: { maxNetworkNumber: 200 } });
      const { installKeyboardLogExport } = await import("./vconsole-keyboard-export.js");
      await installKeyboardLogExport(vConsole, VConsole);
      if (window.matchMedia("(max-width: 760px)").matches) {
        if (window.location.pathname.startsWith("/tmux-dashboard")) {
          makeVConsoleSwitchMovable(vConsole);
        } else {
          vConsole.setSwitchPosition(16, 190);
        }
      }
    } catch (error) {
      console.warn("Could not load vConsole.", error);
    }
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ThemeProvider>
        <BrowserRouter>
          <AuthGate>
            <SystemNavigationProvider>
              <WebNavigation />
              <Suspense fallback={<div className="route-loading">页面加载中…</div>}>
                <Routes>
                  <Route path="/" element={<App />} />
                  <Route path="/tasks/:source/:taskId" element={<TaskDetailPage />} />
                  <Route path="/direct-tasks" element={<LegacyDirectTasksRedirect />} />
                  <Route path="/codex-history" element={<CodexHistory />} />
                  <Route path="/codex-history/:homeId/:threadId" element={<CodexHistory />} />
                  <Route path="/tmux-dashboard/history" element={<TmuxSessionHistory />} />
                  <Route path="/tmux-dashboard/files/:sessionId" element={<TmuxSessionFiles />} />
                  <Route path="/tmux-dashboard/*" element={<TmuxDashboard />} />
                  <Route path="/system-management" element={<Navigate to="/system-management/devices" replace />} />
                  <Route path="/system-management/devices" element={<PairingAdmin />} />
                  <Route path="/system-management/projects" element={<ProjectManagement />} />
                  <Route path="/system-management/shortcuts" element={<ShortcutManagement />} />
                  <Route path="/system-management/usage" element={<CodexUsage />} />
                  <Route path="/system-management/health" element={<SystemHealth />} />
                  <Route path="/system-management/backups" element={<SystemBackups />} />
                  <Route path="/pair-admin" element={<Navigate to="/system-management/devices" replace />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </SystemNavigationProvider>
          </AuthGate>
        </BrowserRouter>
      </ThemeProvider>
    </StrictMode>,
  );
}

void mountApp();
