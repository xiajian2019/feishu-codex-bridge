import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { App } from "./App.js";
import { WebNavigation } from "./WebNavigation.js";
import { AuthGate, PairingAdmin } from "./auth.js";
import { ThemeProvider } from "./theme.js";
import "./styles.css";

const TmuxDashboard = lazy(() => import("./TmuxDashboard.js").then((module) => ({ default: module.TmuxDashboard })));

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
            <WebNavigation />
            <Suspense fallback={<div className="route-loading">页面加载中…</div>}>
              <Routes>
                <Route path="/" element={<App />} />
                <Route path="/tmux-dashboard/*" element={<TmuxDashboard />} />
                <Route path="/pair-admin" element={<PairingAdmin />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </AuthGate>
        </BrowserRouter>
      </ThemeProvider>
    </StrictMode>,
  );
}

void mountApp();
