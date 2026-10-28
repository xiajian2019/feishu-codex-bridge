export interface AuthDiagnostics {
  reason: "authenticated" | "local_access" | "credential_missing" | "credential_invalid"
    | "session_unknown" | "session_expired" | "session_revoked";
  credential: "cookie" | "bearer" | "none";
  cookiePresent: boolean;
  cookieCount: number;
  serverTime: string;
  installationId: string;
  sessionExpiresAt: string | null;
  sessionRevokedAt: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  local: boolean;
  activeSessionCount: number | null;
  pairingAvailable: boolean;
  pairingExpiresAt: number | null;
  draftScope?: string | null;
  diagnostics?: AuthDiagnostics;
  client?: unknown;
}

export interface AuthObservation {
  at: string;
  origin: string;
  authenticated: boolean;
  reason: AuthDiagnostics["reason"] | "unavailable";
  installationId: string | null;
  expiresAt: string | null;
  credential: AuthDiagnostics["credential"] | null;
  cookieCount: number | null;
}

export interface AuthEvidence {
  lastSuccess: AuthObservation | null;
  lastCheck: AuthObservation | null;
  events: AuthObservation[];
}

export interface PairingScanObservation {
  at?: string;
  mode: "camera" | "image";
  outcome: "decoded" | "not_detected" | "image_unreadable" | "camera_blocked" | "permission_denied" | "camera_error";
  width: number | null;
  height: number | null;
  attempts: number;
}

type EvidenceStorage = Pick<Storage, "getItem" | "setItem">;
const SCAN_KEY = "bridge:pairing-scan-diagnostics:v1";

function scanObservation(value: unknown): PairingScanObservation | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.mode !== "camera" && row.mode !== "image") return null;
  if (!["decoded", "not_detected", "image_unreadable", "camera_blocked", "permission_denied", "camera_error"].includes(String(row.outcome))) return null;
  return { at: typeof row.at === "string" && Number.isFinite(Date.parse(row.at)) ? row.at : undefined,
    mode: row.mode, outcome: row.outcome as PairingScanObservation["outcome"],
    width: Number.isSafeInteger(row.width) && (row.width as number) > 0 ? row.width as number : null,
    height: Number.isSafeInteger(row.height) && (row.height as number) > 0 ? row.height as number : null,
    attempts: Number.isSafeInteger(row.attempts) && (row.attempts as number) >= 0 ? row.attempts as number : 0 };
}
export function recordPairingScan(scan: PairingScanObservation, storage = diagnosticStorage()): void {
  const safe = scanObservation({ ...scan, at: new Date().toISOString() });
  try { if (safe) storage?.setItem(SCAN_KEY, JSON.stringify(safe)); } catch { /* optional diagnostics */ }
}
export function readPairingScan(storage = diagnosticStorage()): PairingScanObservation | null {
  try { return scanObservation(JSON.parse(storage?.getItem(SCAN_KEY) ?? "null")); } catch { return null; }
}
const KEY = "bridge:pairing-diagnostics:v1";
const REASONS = new Set(["authenticated", "local_access", "credential_missing", "credential_invalid", "session_unknown", "session_expired", "session_revoked", "unavailable"]);

export function diagnosticStorage(): EvidenceStorage | null {
  try { return window.localStorage; } catch { return null; }
}

// Whitelist fields on both reads and writes. Never retain a token, pairing code,
// draft scope, URL fragment, query string, or an unfiltered API/error object.
function observation(value: unknown): AuthObservation | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
    || typeof row.origin !== "string" || typeof row.authenticated !== "boolean"
    || typeof row.reason !== "string" || !REASONS.has(row.reason)) return null;
  let origin: string;
  try {
    const url = new URL(row.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    origin = url.origin;
  } catch { return null; }
  return {
    at: row.at, origin, authenticated: row.authenticated,
    reason: row.reason as AuthObservation["reason"],
    installationId: typeof row.installationId === "string" && /^[a-f0-9]{16}$/.test(row.installationId) ? row.installationId : null,
    expiresAt: typeof row.expiresAt === "string" && Number.isFinite(Date.parse(row.expiresAt)) ? row.expiresAt : null,
    credential: row.credential === "cookie" || row.credential === "bearer" || row.credential === "none" ? row.credential : null,
    cookieCount: Number.isSafeInteger(row.cookieCount) && (row.cookieCount as number) >= 0 ? row.cookieCount as number : null,
  };
}

export function readAuthEvidence(storage = diagnosticStorage()): AuthEvidence {
  try {
    const data = JSON.parse(storage?.getItem(KEY) ?? "null");
    return {
      lastSuccess: observation(data?.lastSuccess),
      lastCheck: observation(data?.lastCheck),
      events: Array.isArray(data?.events) ? data.events.map(observation).filter((item: AuthObservation | null): item is AuthObservation => item !== null).slice(-20) : [],
    };
  } catch { return { lastSuccess: null, lastCheck: null, events: [] }; }
}

export function recordAuthStatus(status: AuthStatus, storage = diagnosticStorage(), origin = window.location.origin, at = new Date().toISOString()): void {
  const next = observation({
    at, origin, authenticated: status.authenticated,
    reason: status.diagnostics?.reason ?? (status.authenticated ? "authenticated" : "unavailable"),
    installationId: status.diagnostics?.installationId,
    expiresAt: status.diagnostics?.sessionExpiresAt,
    credential: status.diagnostics?.credential,
    cookieCount: status.diagnostics?.cookieCount,
  });
  if (!next) return;
  const evidence = readAuthEvidence(storage);
  const previous = evidence.lastCheck;
  if (!previous || previous.reason !== next.reason || previous.installationId !== next.installationId
    || previous.expiresAt !== next.expiresAt || previous.credential !== next.credential || previous.cookieCount !== next.cookieCount) {
    evidence.events = [...evidence.events, next].slice(-20);
  }
  evidence.lastCheck = next;
  if (status.authenticated) evidence.lastSuccess = next;
  try { storage?.setItem(KEY, JSON.stringify(evidence)); } catch { /* Browser storage may be disabled or full. */ }
}

export function diagnosePairing(status: AuthStatus | null, evidence: AuthEvidence): { title: string; detail: string } {
  const current = status?.diagnostics;
  const previous = evidence.lastSuccess;
  if (!current) return { title: "等待诊断结果", detail: "请重新检查连接；旧版服务未提供诊断信息时，需要更新 Bridge 服务。" };
  if (previous?.installationId && previous.installationId !== current.installationId) {
    return { title: "连接的服务标识已变化", detail: "与上次成功访问的服务或数据库不同。请核对访问地址及服务使用的数据。" };
  }
  switch (current.reason) {
    case "credential_missing":
      return { title: "浏览器未发送登录 Cookie", detail: previous?.expiresAt && Date.parse(previous.expiresAt) > Date.parse(current.serverTime)
        ? "上次服务器授权仍未到期，但本次请求没有 Cookie。可能是本地 Cookie 到期、被清理或拦截，或访问地址/协议发生变化。浏览器未发送的具体原因需要结合本机记录判断。"
        : "服务端未收到登录凭据。可能是首次访问、本地 Cookie 到期或被清理，也可能换了浏览器、IP、域名或协议；这不等于服务器授权已到期。" };
    case "credential_invalid": return { title: "登录凭据格式无效", detail: "请求携带了无法识别的登录凭据，请重新配对。" };
    case "session_unknown": return { title: "当前服务找不到这份登录记录", detail: "浏览器发送了凭据，但数据库中没有对应会话。请核对是否切换过服务、数据库或恢复过备份。" };
    case "session_expired": return { title: "服务器授权已到期", detail: "本次请求对应的会话已超过服务器保存的到期时间，需要重新配对。" };
    case "session_revoked": return { title: "设备授权已被撤销", detail: "服务器已撤销本次请求对应的会话，需要重新配对。" };
    default: return { title: "登录有效", detail: "服务器已确认当前登录，正在进入 Bridge。" };
  }
}
