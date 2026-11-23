import { lazy, Suspense, type ReactElement, type ReactNode } from "react";
import { useLocation } from "react-router";

// Vite removes this import from the regular browser build.
const MobileGate = import.meta.env.VITE_BRIDGE_MOBILE === "true"
  ? lazy(() => import("./MobileConnectionGate.js"))
  : null;

export function MobileConnectionBoundary({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  if (import.meta.env.VITE_BRIDGE_MOBILE === "true" && location.pathname === "/nearby-transfer") return <>{children}</>;
  return MobileGate
    ? <Suspense fallback={<div className="route-loading">正在打开 Bridge…</div>}><MobileGate>{children}</MobileGate></Suspense>
    : <>{children}</>;
}
