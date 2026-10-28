import { lazy, Suspense, type ReactElement, type ReactNode } from "react";

// Vite removes this import from the regular browser build.
const MobileGate = import.meta.env.VITE_BRIDGE_MOBILE === "true"
  ? lazy(() => import("./MobileConnectionGate.js"))
  : null;

export function MobileConnectionBoundary({ children }: { children: ReactNode }): ReactElement {
  return MobileGate
    ? <Suspense fallback={<div className="route-loading">正在打开 Bridge…</div>}><MobileGate>{children}</MobileGate></Suspense>
    : <>{children}</>;
}
