import { normalizeBridgeServer, parseMobilePairingInput } from "./mobile-connection.js";

export type MobileOpenRequest =
  | { id: string; kind: "route"; server: string; route: string; scope?: string }
  | { id: string; kind: "pair"; server: string; code: string };

/** Navigation only: never accepts API endpoints, external URLs, credentials, or executable actions. */
export function safeMobileRoute(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, "https://bridge.invalid");
    if (url.hash || url.origin !== "https://bridge.invalid") return null;
    for (const segment of value.split("?")[0]!.split("/")) {
      const decoded = decodeURIComponent(segment);
      if (decoded === ".." || decoded === "." || /[\\/\u0000-\u001f]/.test(decoded)) return null;
    }
  } catch { return null; }
  const path = url.pathname;
  const allowed = ["/", "/mobile-inbox", "/mobile-shares", "/codex-history", "/tmux-dashboard", "/tmux-dashboard/history"];
  if (!allowed.includes(path) && !/^\/tasks\/(desk|direct|aamp)\/[^/]+$/.test(path)
    && !/^\/codex-history\/[^/]+\/[^/]+$/.test(path)
    && !/^\/tmux-dashboard\/(files|git-changes)\/[^/]+$/.test(path)) return null;
  const keys = path.startsWith("/tmux-dashboard") ? ["session"]
    : path.startsWith("/codex-history") ? ["home", "q", "archived", "status"]
    : path === "/" ? ["source", "q", "state", "project", "offset"] : [];
  for (const key of url.searchParams.keys()) if (!keys.includes(key)) return null;
  return path + url.search;
}

export function parseMobileOpenUrl(raw: string): MobileOpenRequest {
  const url = new URL(raw);
  if (url.protocol !== "bridgecodex:" || url.username || url.password || url.hash) throw new Error("此链接不是有效的 Bridge 打开链接。");
  const id = crypto.randomUUID();
  if (url.hostname === "connect") {
    for (const key of url.searchParams.keys()) if (!["server", "code"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error("配对链接参数无效。");
    return { id, kind: "pair", ...parseMobilePairingInput(raw) };
  }
  if (url.hostname !== "open" || url.pathname && url.pathname !== "/") throw new Error("不支持此 Bridge 链接。");
  for (const key of url.searchParams.keys()) if (!["server", "path"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error("打开链接包含不支持的参数。");
  const server = normalizeBridgeServer(url.searchParams.get("server") ?? "");
  const route = safeMobileRoute(url.searchParams.get("path"));
  if (!route) throw new Error("打开链接的目标页面无效。");
  return { id, kind: "route", server, route };
}

export function parseMobileNotificationTarget(value: unknown): MobileOpenRequest {
  if (!value || typeof value !== "object") throw new Error("通知目标无效，请从待处理中心打开。");
  const target = value as Record<string, unknown>;
  const route = safeMobileRoute(target.route);
  if (!route || typeof target.server !== "string" || typeof target.scope !== "string" || !target.scope) throw new Error("通知缺少环境或设备上下文。");
  return { id: crypto.randomUUID(), kind: "route", route, server: normalizeBridgeServer(target.server), scope: target.scope };
}

export function appendMobileShareText(current: string, incoming: string): string {
  if (!incoming.trim()) return current;
  return current.trim() ? `${current.replace(/\s+$/, "")}\n\n${incoming.trim()}` : incoming.trim();
}

export function assertMobileShareContext(expected: { scope: string; server: string } | null, current: { scope: string | null; server: string | undefined }): void {
  if (!expected || !current.scope || expected.scope !== current.scope || expected.server !== current.server) throw new Error("环境或设备已变化，请重新读取目标；原分享仍在本机。");
}

export interface MobileShareFile { id: string; name: string; type: string; size: number }
export interface MobileShare {
  id: string;
  text: string;
  title?: string;
  createdAt: number;
  files: MobileShareFile[];
  error?: string;
}

let opens: MobileOpenRequest[] = [];
let handoffError: string | null = null;
const PENDING_OPENS_KEY = "bridge.mobile.pending-opens.v1";
const listeners = new Set<() => void>();
function publish(): void { for (const listener of listeners) listener(); }
function persistRoutes(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(PENDING_OPENS_KEY, JSON.stringify(opens.filter((item) => item.kind === "route"))); }
  catch { handoffError = "打开目标暂时只能保留在本次运行中，请检查本机存储；不会自动执行操作。"; }
}
export function restoreMobileOpens(): void {
  if (typeof window === "undefined") return;
  try {
    const rows = JSON.parse(window.localStorage.getItem(PENDING_OPENS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== "object" || row.kind !== "route" || typeof row.server !== "string") continue;
      const route = safeMobileRoute(row.route);
      if (!route || row.scope !== undefined && (typeof row.scope !== "string" || !row.scope)) continue;
      try {
        const server = normalizeBridgeServer(row.server);
        if (!opens.some((item) => item.kind === "route" && item.server === server && item.route === route && item.scope === row.scope)) opens.push({ id: crypto.randomUUID(), kind: "route", server, route, ...(row.scope ? { scope: row.scope } : {}) });
      } catch { /* Ignore one invalid origin without discarding other pending navigation. */ }
    }
    opens = [...opens]; publish();
  } catch { /* Never restore pairing codes, invalid routes, or executable URLs. */ }
}
export function subscribeMobileOpens(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getMobileOpens(): MobileOpenRequest[] { return opens; }
export function getMobileOpenError(): string | null { return handoffError; }
export function clearMobileOpenError(): void { handoffError = null; publish(); }
export function reportMobileOpenError(message: string): void { handoffError = message; publish(); }
export function queueMobileOpen(input: string | unknown): void {
  try {
    const next = typeof input === "string" ? parseMobileOpenUrl(input) : parseMobileNotificationTarget(input);
    if (opens.some((item) => item.kind === next.kind && item.server === next.server
      && (item.kind === "route" && next.kind === "route" ? item.route === next.route && item.scope === next.scope
        : item.kind === "pair" && next.kind === "pair" && item.code === next.code))) return;
    opens = [...opens, next]; handoffError = null; persistRoutes(); publish();
  } catch (cause) { handoffError = cause instanceof Error ? cause.message : "无法打开此链接。"; publish(); }
}
export function consumeMobileOpen(id: string): void { opens = opens.filter((item) => item.id !== id); persistRoutes(); publish(); }

export type MobileNotificationLedger = { version: 1; enabledAt: number; seen: string[] };
export function readMobileNotificationLedger(raw: string | null): MobileNotificationLedger | null {
  try {
    const row = JSON.parse(raw ?? "null") as MobileNotificationLedger | null;
    return row?.version === 1 && Number.isFinite(row.enabledAt) && Array.isArray(row.seen)
      ? { version: 1, enabledAt: row.enabledAt, seen: row.seen.filter((id) => typeof id === "string").slice(-1000) } : null;
  } catch { return null; }
}
