import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { App } from "./App.js";
import { WebNavigation } from "./WebNavigation.js";
import { AuthGate, PairingAdmin } from "./auth.js";
import { ThemeProvider } from "./theme.js";
import "./styles.css";

const TmuxDashboard = lazy(() => import("./TmuxDashboard.js").then((module) => ({ default: module.TmuxDashboard })));

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
