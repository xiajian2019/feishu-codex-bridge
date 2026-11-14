import { useCallback, useEffect, useState, type ReactElement } from "react";
import { getActionToken } from "./api.js";
import { readBridgeJson } from "./bridge-json.js";
import { getBridgeOrigin, getMobileAppBuild, getMobileAppVersion, isMobileApp, openIosOtaPage } from "./mobile-runtime.js";
import "./ios-ota.css";

type Release = { revision: string; version: string; build: string; size: number; expiresAt: string; publishedAt: string };
type OtaStatus = { available: boolean; serviceRunning: boolean; release: Release | null; publish: { state: "idle" | "running" | "succeeded" | "failed"; message?: string } };

function numericBuild(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const build = Number(value);
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

/** The iOS distribution flow is intentionally absent from Android and desktop Web. */
export function isIphoneOtaSurface(): boolean {
  return typeof navigator !== "undefined" && /iPhone/i.test(navigator.userAgent);
}

async function otaRequest<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const server = getBridgeOrigin();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method === "POST") headers["X-Bridge-Action-Token"] = await getActionToken();
  if (server !== getBridgeOrigin()) throw new Error("Bridge 环境已切换，请重新操作。");
  const response = await fetch(path, { method, headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const body = await readBridgeJson<T & { error?: string }>(response);
  if (server !== getBridgeOrigin()) throw new Error("Bridge 环境已切换，请重新操作。");
  if (!response.ok) throw new Error(body.error || `iOS 安装请求失败（${response.status}）。`);
  return body;
}

export function IOSOtaPanel({ compact = false }: { compact?: boolean }): ReactElement | null {
  const [status, setStatus] = useState<OtaStatus | null>(null);
  const [currentApp, setCurrentApp] = useState<{ version: string; build: number | null } | null>(null);
  const [currentAppLoading, setCurrentAppLoading] = useState(() => isMobileApp());
  const [busy, setBusy] = useState<"load" | "open" | "publish" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setBusy("load");
    try { setStatus(await otaRequest<OtaStatus>("/api/mobile/ios-ota")); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取 iOS 安装状态失败。"); }
    finally { if (!quiet) setBusy(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!isMobileApp()) { setCurrentAppLoading(false); return; }
    let active = true;
    void Promise.all([getMobileAppVersion(), getMobileAppBuild()]).then(([version, build]) => {
      if (active) setCurrentApp({ version, build: Number.isSafeInteger(build) && build > 0 ? build : null });
    }).catch(() => {
      if (active) setCurrentApp({ version: "暂不可读", build: null });
    }).finally(() => { if (active) setCurrentAppLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (status?.publish.state !== "running") return;
    const timer = window.setInterval(() => void load(true), 3_000);
    return () => window.clearInterval(timer);
  }, [load, status?.publish.state]);
  const open = async (): Promise<void> => {
    const popup = !isMobileApp() ? window.open("about:blank", "_blank") : null;
    if (!isMobileApp() && !popup) { setError("浏览器阻止了新页面，请允许弹出窗口后重试。"); return; }
    setBusy("open"); setError(""); setMessage("");
    try {
      const { url } = await otaRequest<{ url: string }>("/api/mobile/ios-ota/link", "POST");
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash || !/\/[A-Za-z0-9_-]{43}\/$/.test(target.pathname)) throw new Error("iOS 安装地址无效。");
      if (popup) popup.location.href = target.href;
      else await openIosOtaPage(target.href);
      setMessage("已打开安装页，请在 iPhone 上确认系统安装。");
    } catch (cause) { popup?.close(); setError(cause instanceof Error ? cause.message : "无法打开安装页。"); }
    finally { setBusy(null); }
  };
  const publish = async (): Promise<void> => {
    setBusy("publish"); setError(""); setMessage("");
    try { await otaRequest("/api/mobile/ios-ota/publish", "POST"); await load(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法开始构建。"); }
    finally { setBusy(null); }
  };
  if (!isIphoneOtaSurface()) return null;
  const building = status?.publish.state === "running";
  const targetBuild = numericBuild(status?.release?.build);
  const targetIsNotNewer = isMobileApp() && !currentAppLoading && currentApp?.build !== null && currentApp?.build !== undefined
    && targetBuild !== null && targetBuild <= currentApp.build;
  const installReady = Boolean(status?.available && status?.serviceRunning && !currentAppLoading && !targetIsNotNewer);
  return <section className={`ios-ota-panel${compact ? " ios-ota-compact" : ""}`} aria-label="iOS 安装与更新">
    <div className="ios-ota-heading"><h2>iPhone 安装与更新</h2>
      <button className={`ios-ota-refresh${busy === "load" ? " is-loading" : ""}`} type="button" onClick={() => void load()} disabled={busy !== null}
        aria-label={busy === "load" ? "正在刷新 iOS 安装状态" : "刷新 iOS 安装状态"}
        title={busy === "load" ? "正在刷新 iOS 安装状态" : "刷新 iOS 安装状态"}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.93-4M4 4v4h4M4 13a8 8 0 0 0 14.93 4M20 20v-4h-4" /></svg>
      </button>
    </div>
    {isMobileApp() ? <p className="ios-ota-detail">当前 App {currentAppLoading ? "正在读取…" : `${currentApp?.version ?? "未知版本"}${currentApp?.build ? ` · 构建 ${currentApp.build}` : ""}`}</p> : null}
    {status?.release ? <p className="ios-ota-detail">最新安装包 {status.release.version}（构建 {status.release.build}） · 生成于 {new Date(status.release.publishedAt).toLocaleString()} · 签名至 {new Date(status.release.expiresAt).toLocaleString()}</p>
      : <p className="ios-ota-detail">暂无可用的 iOS 安装包。</p>}
    {status && !status.serviceRunning ? <p className="ios-ota-detail">安装服务未启动，请在 Mac 上启动 OTA 服务。</p> : null}
    {targetIsNotNewer ? <p className="ios-ota-detail" role="status">当前 App 已是构建 {currentApp?.build}，请先构建并发布新的 OTA 构建。</p> : null}
    <div className="ios-ota-actions">
      <button type="button" onClick={() => void open()} disabled={busy !== null || !installReady}>{busy === "open" ? "正在打开…" : "打开安装页"}</button>
      <button type="button" onClick={() => void publish()} disabled={busy !== null || building}>{building ? "正在构建…" : "构建并发布"}</button>
    </div>
    {status?.publish.message ? <p className="ios-ota-detail" role="status">{status.publish.message}</p> : null}
    {message ? <p className="ios-ota-detail" role="status">{message}</p> : null}
    {error ? <p className="ios-ota-error" role="alert">{error}</p> : null}
  </section>;
}
