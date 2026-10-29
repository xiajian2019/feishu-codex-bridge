import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { clearMobileOpenError, consumeMobileOpen, getMobileOpenError, getMobileOpens, queueMobileOpen, safeMobileRoute, subscribeMobileOpens, type MobileOpenRequest } from "./mobile-handoff.js";
import { getLocalDraftScope, scopedStorageKey } from "./local-draft-scope.js";
import { getMobileConnection, initializeMobileRuntime, listMobileShares, MOBILE_RESUME_EVENT, openMobileConnectionSettings, pairMobileConnection, switchMobileConnection } from "./mobile-runtime.js";
import { readMobileNotificationPreferences } from "./mobile-notifications.js";
import { useMobileBack } from "./use-mobile-back.js";
import { MobileShareInbox } from "./MobileShareInbox.js";
import "./mobile-handoff.css";

const PENDING_ROUTE = "bridge.mobile.pending-navigation.v1";

function useHandoffDialog(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const previous = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [active]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    event.stopPropagation(); // A visible confirmation must not send keys to the underlying terminal/editor.
    if (event.key !== "Tab") return;
    const controls = [...ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled)") ?? []];
    const first = controls[0]; const last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
  };
  return { ref, tabIndex: -1, onKeyDown };
}

export function MobileHandoffShell({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const opens = useSyncExternalStore(subscribeMobileOpens, getMobileOpens);
  const openError = useSyncExternalStore(subscribeMobileOpens, getMobileOpenError);
  const pairing = opens.find((item) => item.kind === "pair");
  const [shareCount, setShareCount] = useState(0);
  const [shareNotice, setShareNotice] = useState(false);
  const [copyingShares, setCopyingShares] = useState(new Set<string>());
  const [copyingNoticeHidden, setCopyingNoticeHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useMobileBack(Boolean(pairing), () => { if (pairing && !busy) consumeMobileOpen(pairing.id); }, 3000, { restoreFocus: false });
  const pairDialog = useHandoffDialog(Boolean(pairing));
  useEffect(() => {
    let active = true;
    const refresh = (): void => { void initializeMobileRuntime().then(listMobileShares).then((shares) => {
      if (!active) return;
      setShareCount(shares.length);
      const latest = shares[0]?.id;
      if (latest) try {
        if (window.localStorage.getItem("bridge.mobile.latest-share-notice") !== latest) {
          setShareNotice(true); window.localStorage.setItem("bridge.mobile.latest-share-notice", latest);
        }
      } catch { setShareNotice(true); }
    }).catch(() => {}); };
    const incoming = (event: Event): void => {
      const detail = event instanceof CustomEvent ? event.detail as { id?: string; state?: string } : {};
      if (detail.id) {
        const id = detail.id;
        if (detail.state === "copying") { setCopyingNoticeHidden(false); setCopyingShares((current) => new Set([...current, id])); }
        else setCopyingShares((current) => { const next = new Set(current); next.delete(id); return next; });
      }
      if (detail.state !== "copying") refresh();
    }; // Never navigate away from an unsent editor automatically.
    refresh();
    window.addEventListener("bridge:mobile-share", incoming);
    window.addEventListener(MOBILE_RESUME_EVENT, refresh);
    return () => { active = false; window.removeEventListener("bridge:mobile-share", incoming); window.removeEventListener(MOBILE_RESUME_EVENT, refresh); };
  }, [navigate]);
  useEffect(() => {
    if (!shareNotice) return;
    const timer = window.setTimeout(() => setShareNotice(false), 8000);
    return () => window.clearTimeout(timer);
  }, [shareNotice]);
  return <>
    {location.pathname === "/mobile-shares" ? <MobileShareInbox /> : children}
    {copyingShares.size > 0 && !copyingNoticeHidden ? <aside className="mobile-share-entry" role="status"><span>正在保存 {copyingShares.size} 项本机分享，完成后进入收件箱；请勿强制结束 App。</span><button type="button" onClick={() => setCopyingNoticeHidden(true)}>收起</button></aside>
      : shareNotice && location.pathname !== "/mobile-shares" ? <aside className="mobile-share-entry" role="status"><Link to="/mobile-shares" onClick={() => setShareNotice(false)}>有本机分享 · 打开收件箱核对（{shareCount}）</Link><button type="button" aria-label="关闭分享提示" onClick={() => setShareNotice(false)}>×</button></aside> : null}
    {openError ? <aside className="mobile-handoff-feedback" role="alert">{openError}<button type="button" onClick={clearMobileOpenError}>关闭</button></aside> : null}
    {pairing?.kind === "pair" ? <div className="mobile-handoff-backdrop"><section {...pairDialog} className="mobile-handoff-dialog" role="dialog" aria-modal="true" aria-label="确认链接配对">
      <h2>连接链接中的 Bridge？</h2><p>{pairing.server}</p><p>确认后才会使用一次性配对码并切换连接，不会执行任务。</p>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={busy} onClick={() => {
        setBusy(true); setError("");
        void pairMobileConnection(pairing.server, pairing.code).then(() => { consumeMobileOpen(pairing.id); window.location.replace("/"); })
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "配对失败，请重新取得链接。" )).finally(() => setBusy(false));
      }}>{busy ? "正在配对…" : "确认配对"}</button>
      <button type="button" disabled={busy} onClick={() => { consumeMobileOpen(pairing.id); setError(""); }}>取消</button>
    </section></div> : null}
  </>;
}

/** Mounted only after authentication, so no pending intent can bypass connection or device validation. */
export function MobileNavigationBridge(): ReactElement | null {
  const location = useLocation();
  const navigate = useNavigate();
  const opens = useSyncExternalStore(subscribeMobileOpens, getMobileOpens);
  const request = opens.find((item) => item.kind === "route");
  const started = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const server = getMobileConnection()?.server;
  const scope = getLocalDraftScope();
  useMobileBack(Boolean(request), () => { if (request && !busy) consumeMobileOpen(request.id); }, 2900, { restoreFocus: false });
  const routeDialog = useHandoffDialog(Boolean(request));

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    try {
      const pending = sessionStorage.getItem(PENDING_ROUTE);
      if (pending) {
        sessionStorage.removeItem(PENDING_ROUTE);
        const row = JSON.parse(pending) as Partial<MobileOpenRequest>;
        if (row.kind === "route" && typeof row.server === "string" && safeMobileRoute(row.route)) {
          if (row.scope) queueMobileOpen(row);
          else queueMobileOpen(`bridgecodex://open?server=${encodeURIComponent(row.server)}&path=${encodeURIComponent(row.route!)}`);
          return;
        }
      }
      if (getMobileOpens().length || location.pathname !== "/" || location.state || !readMobileNotificationPreferences().restoreLocation) return;
      const key = scopedStorageKey("mobile-last-location");
      const saved = key ? safeMobileRoute(localStorage.getItem(key)) : null;
      if (saved && saved !== "/") navigate(saved, { replace: true });
    } catch { /* Invalid local navigation never becomes an executable action. */ }
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    if (request?.kind !== "route" || request.server !== server) return;
    if (request.scope && request.scope !== scope) { setError("此通知属于旧设备授权或另一安装实例，请从当前待处理中心重新打开。"); return; }
    consumeMobileOpen(request.id);
    if (request.route !== location.pathname + location.search) navigate(request.route);
  }, [location.pathname, location.search, navigate, request, scope, server]);

  useEffect(() => {
    if (getMobileOpens().length) return;
    const route = safeMobileRoute(location.pathname + location.search);
    const key = scopedStorageKey("mobile-last-location");
    if (!key || !route || ["/", "/mobile-shares", "/mobile-inbox"].includes(location.pathname)) return;
    try { localStorage.setItem(key, route); } catch { /* Explicit navigation remains available. */ }
  }, [location.pathname, location.search, opens, scope]);

  if (request?.kind !== "route") return null;
  const sameServer = request.server === server;
  return <div className="mobile-handoff-backdrop"><section {...routeDialog} className="mobile-handoff-dialog" role="dialog" aria-modal="true" aria-label="确认打开目标环境">
    <h2>{sameServer ? "打开请求需要重新确认" : "打开另一个 Bridge 环境？"}</h2>
    <p>{request.server}</p><p>{request.route}</p>
    <p>不同环境不会自动切换或提交操作；现有草稿保留在原环境。</p>
    {error ? <p role="alert">{error}</p> : null}
    {!sameServer ? <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError("");
      try { sessionStorage.setItem(PENDING_ROUTE, JSON.stringify(request)); }
      catch { setError("无法保留打开目标，本次未切换环境；请检查本机存储后重试。"); setBusy(false); return; }
      void switchMobileConnection(request.server).then((switched) => {
        if (!switched) { sessionStorage.removeItem(PENDING_ROUTE); openMobileConnectionSettings(request.server); setError("此环境尚未配对，请先连接，打开请求会保留。"); return; }
        consumeMobileOpen(request.id); window.location.replace("/");
      }).catch((cause: unknown) => { sessionStorage.removeItem(PENDING_ROUTE); setError(cause instanceof Error ? cause.message : "环境不可达，当前环境未切换。"); }).finally(() => setBusy(false));
    }}>{busy ? "正在验证…" : "验证并切换后打开"}</button> : <Link to="/mobile-inbox" onClick={() => consumeMobileOpen(request.id)}>打开当前待处理中心</Link>}
    <button type="button" disabled={busy} onClick={() => { consumeMobileOpen(request.id); setError(""); }}>取消</button>
  </section></div>;
}
