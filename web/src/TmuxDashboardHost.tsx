import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";
import { useMatch } from "react-router";
import { BackendFeatureGate } from "./BackendFeatureGate.js";

const TmuxDashboard = lazy(() => import("./TmuxDashboard.js").then((module) => ({ default: module.TmuxDashboard })));

/** Keep the tmux dashboard mounted while another top-level page is active. */
export function TmuxDashboardHost(): ReactElement | null {
  const active = useMatch("/tmux-dashboard") !== null;
  const [visited, setVisited] = useState(active);

  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);

  if (!active && !visited) return null;
  return <div hidden={!active} data-route-cache="tmux-dashboard">
    <BackendFeatureGate feature="tmux">
      <Suspense fallback={<div className="route-loading">页面加载中…</div>}>
        <TmuxDashboard active={active} />
      </Suspense>
    </BackendFeatureGate>
  </div>;
}
