import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";
import { useMatch } from "react-router";
import { BackendFeatureGate } from "./BackendFeatureGate.js";

const RemoteDesktop = lazy(() => import("./RemoteDesktop.js").then((module) => ({ default: module.RemoteDesktop })));

/** Keep a live RFB connection scoped to this authenticated app, across SPA routes. */
export function RemoteDesktopHost(): ReactElement | null {
  const active = useMatch("/remote-desktop") !== null;
  const [visited, setVisited] = useState(active);

  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);

  if (!active && !visited) return null;
  return <div hidden={!active}>
    <BackendFeatureGate feature="remote-desktop">
      <Suspense fallback={<div className="route-loading">页面加载中…</div>}>
        <RemoteDesktop active={active} />
      </Suspense>
    </BackendFeatureGate>
  </div>;
}
