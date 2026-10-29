import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nativeOriginRequiresBearer } from "./mobile-auth.js";

const SESSION_COOKIE = "bridge_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const FAILED_PAIRING_WINDOW_MS = 60 * 1000;
const FAILED_PAIRING_LIMIT = 8;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface WebAuthPairingRecord {
  codeHash: string;
  expiresAt: number;
}

export interface WebAuthSessionRecord {
  sessionId: string;
  tokenHash: string;
  deviceName: string;
  userAgent: string | null;
  remoteAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  clientType?: "browser" | "app" | "unknown";
  lastAccessOrigin?: string | null;
  lastAccessOriginAt?: string | null;
}

export interface WebAuthDatabase {
  getOrCreateDraftInstallationId?(): string;
  getWebAuthPairing(): WebAuthPairingRecord | null;
  saveWebAuthPairing(record: WebAuthPairingRecord): void;
  clearWebAuthPairing(): void;
  createWebAuthSession(record: WebAuthSessionRecord): void;
  getWebAuthSession(tokenHash: string): WebAuthSessionRecord | null;
  touchWebAuthSession(
    sessionId: string,
    lastSeenAt: string,
    userAgent: string | null,
    remoteAddress: string | null,
    lastAccessOrigin?: string | null,
    clientType?: "browser" | "app" | "unknown",
  ): void;
  listWebAuthSessions(): WebAuthSessionRecord[];
  updateWebAuthSessionDeviceName(sessionId: string, deviceName: string): void;
  updateWebAuthSessionExpiry(sessionId: string, expiresAt: string): void;
  revokeWebAuthSession(sessionId: string, revokedAt: string): void;
  revokeAllWebAuthSessions(revokedAt: string): void;
}

interface PairingState extends WebAuthPairingRecord {
  failedAttempts: Map<string, FailedAttempt>;
}

interface FailedAttempt {
  count: number;
  resetAt: number;
}

export interface PairingStartResult {
  code: string;
  expiresAt: number;
}

export interface WebAuthDevice {
  sessionId: string;
  current: boolean;
  deviceName: string;
  userAgent: string | null;
  remoteAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  revokedAt: string | null;
  clientType: "browser" | "app" | "unknown";
  lastAccessOrigin: string | null;
  lastAccessOriginAt: string | null;
}

export interface WebAuthDiagnostics {
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

export interface PairingStatus {
  authenticated: boolean;
  local: boolean;
  activeSessionCount: number | null;
  pairingAvailable: boolean;
  pairingExpiresAt: number | null;
  draftScope: string | null;
  diagnostics: WebAuthDiagnostics;
}

export class PairingRateLimitError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("too many pairing attempts");
    this.name = "PairingRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class WebPairingAuth {
  private readonly db?: WebAuthDatabase;
  private readonly now: () => number;
  private readonly allowLocalRequests: boolean;
  private readonly localAddresses = collectLocalAddresses();
  private readonly memorySessions = new Map<string, WebAuthSessionRecord>();
  private readonly revocationListeners = new Set<() => void>();
  private readonly draftInstallationId: string;
  private memoryPairing: PairingState | null = null;

  constructor(options: {
    db?: WebAuthDatabase;
    now?: () => number;
    allowLocalRequests?: boolean;
  } = {}) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.allowLocalRequests = options.allowLocalRequests ?? false;
    this.draftInstallationId = this.db?.getOrCreateDraftInstallationId?.() ?? randomUUID();
  }

  public isLocalRequest(request: IncomingMessage): boolean {
    const address = this.clientAddress(request);
    return address !== null && this.localAddresses.has(address);
  }

  public isAuthorized(request: IncomingMessage): boolean {
    if (request.headers.authorization === undefined && !nativeOriginRequiresBearer(request)
      && this.allowLocalRequests && this.isLocalRequest(request)) {
      // Loopback may bypass pairing, but a valid saved session still needs its
      // latest client metadata, including after an App/browser upgrade.
      const token = this.requestToken(request);
      const session = token ? this.getSession(hashToken(token)) : null;
      if (session && session.revokedAt === null && Date.parse(session.expiresAt) > this.now()) {
        this.touchSession(session, request);
      }
      return true;
    }
    const token = this.requestToken(request);
    if (!token) return false;
    const session = this.getSession(hashToken(token));
    if (!session || session.revokedAt !== null) return false;
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.revokeSession(session.sessionId);
      return false;
    }
    this.touchSession(session, request);
    return true;
  }

  public currentDeviceId(request: IncomingMessage): string | null {
    const token = this.requestToken(request);
    if (!token) return null;
    const session = this.getSession(hashToken(token));
    if (!session || session.revokedAt !== null) return null;
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.revokeSession(session.sessionId);
      return null;
    }
    return session.sessionId;
  }

  public isBearerAuthorized(request: IncomingMessage): boolean {
    return request.headers.authorization !== undefined && this.isAuthorized(request);
  }

  /** Bind a long-lived connection to its original credential, without touching last_seen_at. */
  public connectionAuthorization(request: IncomingMessage): () => boolean {
    const token = this.requestToken(request);
    if (token) {
      const tokenHash = hashToken(token);
      return () => {
        try {
          const session = this.getSession(tokenHash);
          return Boolean(session && session.revokedAt === null && Date.parse(session.expiresAt) > this.now());
        } catch {
          return false;
        }
      };
    }
    const trustedLocal = request.headers.authorization === undefined && !nativeOriginRequiresBearer(request)
      && this.allowLocalRequests && this.isLocalRequest(request);
    return () => trustedLocal;
  }

  public subscribeToRevocations(listener: () => void): () => void {
    this.revocationListeners.add(listener);
    return () => { this.revocationListeners.delete(listener); };
  }

  public status(request: IncomingMessage): PairingStatus {
    const pairing = this.getPairing();
    const authenticated = this.isAuthorized(request);
    const deviceId = authenticated
      ? this.currentDeviceId(request) ?? (this.allowLocalRequests && this.isLocalRequest(request) ? "local" : null)
      : null;
    return {
      authenticated,
      local: this.isLocalRequest(request),
      activeSessionCount: authenticated ? this.listActiveSessions().length : null,
      pairingAvailable: pairing !== null && pairing.expiresAt > this.now(),
      pairingExpiresAt: pairing && pairing.expiresAt > this.now() ? pairing.expiresAt : null,
      diagnostics: this.diagnostics(request, authenticated),
      draftScope: deviceId
        ? createHash("sha256").update(JSON.stringify([this.draftInstallationId, deviceId])).digest("base64url")
        : null,
    };
  }

  private diagnostics(request: IncomingMessage, authenticated: boolean): WebAuthDiagnostics {
    const cookieCount = (request.headers.cookie ?? "").split(";")
      .filter((part) => part.trim().split("=", 1)[0] === SESSION_COOKIE).length;
    const cookiePresent = cookieCount > 0;
    const credential = request.headers.authorization !== undefined ? "bearer" : cookiePresent ? "cookie" : "none";
    const token = this.requestToken(request);
    const session = token ? this.getSession(hashToken(token)) : null;
    let reason: WebAuthDiagnostics["reason"];
    if (authenticated) reason = session ? "authenticated" : "local_access";
    else if (credential === "none") reason = "credential_missing";
    else if (!token) reason = "credential_invalid";
    else if (!session) reason = "session_unknown";
    // isAuthorized may already have marked an expired session revoked.
    else if (Date.parse(session.expiresAt) <= this.now()) reason = "session_expired";
    else reason = "session_revoked";
    return {
      reason, credential, cookiePresent, cookieCount,
      serverTime: new Date(this.now()).toISOString(),
      installationId: createHash("sha256").update("web-auth-diagnostics:" + this.draftInstallationId).digest("hex").slice(0, 16),
      sessionExpiresAt: session?.expiresAt ?? null,
      sessionRevokedAt: session?.revokedAt ?? null,
    };
  }

  public listDevices(request: IncomingMessage, includeInactive = false): WebAuthDevice[] | null {
    if (!this.isAuthorized(request)) return null;
    const currentSessionId = this.currentDeviceId(request);
    const sessions = this.db?.listWebAuthSessions() ?? [...this.memorySessions.values()];
    return sessions.filter((session) => includeInactive || webAuthSessionState(session, this.now()) === "active").map((session) => ({
      sessionId: session.sessionId,
      current: session.sessionId === currentSessionId,
      status: webAuthSessionState(session, this.now()),
      revokedAt: session.revokedAt,
      clientType: session.clientType ?? "unknown",
      lastAccessOrigin: session.lastAccessOrigin ?? null,
      lastAccessOriginAt: session.lastAccessOriginAt ?? null,
      deviceName: deviceDisplayName(session),
      userAgent: session.userAgent,
      remoteAddress: session.remoteAddress,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
    }));
  }

  public startPairing(): PairingStartResult {
    const code = formatPairingCode(generatePairingCode());
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.savePairing({
      codeHash: hashToken(code.replaceAll("-", "")),
      expiresAt,
    });
    return { code, expiresAt };
  }

  public claimPairing(request: IncomingMessage, rawCode: string, clientType: "browser" | "app" = "browser"): string {
    const pairing = this.getPairing();
    if (!pairing || pairing.expiresAt <= this.now()) {
      this.clearPairing();
      throw new Error("pairing code expired or unavailable");
    }

    const state = this.pairingState(pairing);
    this.checkPairingRateLimit(request, state);
    const normalizedCode = normalizePairingCode(rawCode);
    const providedHash = hashToken(normalizedCode);
    if (!constantTimeStringMatches(providedHash, pairing.codeHash)) {
      this.recordFailedPairingAttempt(request, state);
      throw new Error("invalid pairing code");
    }

    this.clearPairing();
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const accessOrigin = webAuthRequestOrigin(request);
    const session: WebAuthSessionRecord = {
      sessionId: randomUUID(),
      tokenHash: hashToken(token),
      deviceName: deviceNameFromRequest(request),
      userAgent: headerValue(request, "user-agent"),
      remoteAddress: this.clientAddress(request),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      revokedAt: null,
      clientType,
      lastAccessOrigin: accessOrigin,
      lastAccessOriginAt: accessOrigin ? new Date(now).toISOString() : null,
    };
    this.createSession(session);
    return token;
  }

  public claimMobilePairing(request: IncomingMessage, code: string): { token: string; expiresAt: string } {
    const token = this.claimPairing(request, code, "app");
    return { token, expiresAt: this.getSession(hashToken(token))!.expiresAt };
  }

  public setSessionCookie(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
    expiresAt?: string,
  ): void {
    const expiresAtMs = expiresAt === undefined ? this.now() + SESSION_TTL_MS : Date.parse(expiresAt);
    const maxAgeSeconds = Number.isFinite(expiresAtMs)
      ? Math.max(1, Math.ceil((expiresAtMs - this.now()) / 1000))
      : Math.floor(SESSION_TTL_MS / 1000);
    const attributes = [
      SESSION_COOKIE + "=" + token,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=" + maxAgeSeconds,
    ];
    if (isSecureRequest(request)) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  public refreshSessionCookie(request: IncomingMessage, response: ServerResponse): void {
    if (request.headers.authorization !== undefined) return;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) return;
    const session = this.getSession(hashToken(token));
    if (!session || session.revokedAt !== null || Date.parse(session.expiresAt) <= this.now()) return;
    this.setSessionCookie(request, response, token, session.expiresAt);
  }

  public clearSession(request: IncomingMessage, response: ServerResponse): void {
    const token = this.requestToken(request);
    if (token) {
      const session = this.getSession(hashToken(token));
      if (session) this.revokeSession(session.sessionId);
    }
    if (request.headers.authorization === undefined) response.setHeader(
      "Set-Cookie",
      SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
  }

  public revokeAll(): void {
    if (this.db) {
      this.db.revokeAllWebAuthSessions(new Date(this.now()).toISOString());
    } else {
      for (const session of this.memorySessions.values()) {
        session.revokedAt = new Date(this.now()).toISOString();
      }
    }
    for (const listener of this.revocationListeners) listener();
  }

  public revokeDevice(request: IncomingMessage, sessionId: string): boolean {
    if (!this.isAuthorized(request)) return false;
    const session = this.listActiveSessions().find((item) => item.sessionId === sessionId);
    if (!session) return false;
    this.revokeSession(sessionId);
    return true;
  }

  public renameDevice(request: IncomingMessage, sessionId: string, deviceName: string): boolean {
    if (!this.isAuthorized(request)) return false;
    const normalizedName = deviceName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!normalizedName || normalizedName.length > 80) return false;
    const session = this.listActiveSessions().find((item) => item.sessionId === sessionId);
    if (!session) return false;
    session.deviceName = normalizedName;
    this.updateSessionDeviceName(sessionId, normalizedName);
    return true;
  }

  public extendDevice(request: IncomingMessage, sessionId: string): string | null {
    if (!this.isAuthorized(request)) return null;
    const session = this.listActiveSessions().find((item) => item.sessionId === sessionId);
    if (!session) return null;
    const expiresAt = addCalendarYear(session.expiresAt);
    if (!expiresAt) return null;
    session.expiresAt = expiresAt;
    this.updateSessionExpiry(sessionId, expiresAt);
    return expiresAt;
  }

  private getPairing(): PairingState | null {
    const stored = this.db ? this.db.getWebAuthPairing() : this.memoryPairing;
    if (!stored) return null;
    if (stored.expiresAt <= this.now()) {
      this.clearPairing();
      return null;
    }
    return this.pairingState(stored);
  }

  private pairingState(record: WebAuthPairingRecord): PairingState {
    if (this.memoryPairing?.codeHash === record.codeHash) {
      this.memoryPairing.expiresAt = record.expiresAt;
      return this.memoryPairing;
    }
    this.memoryPairing = {
      ...record,
      failedAttempts: new Map(),
    };
    return this.memoryPairing;
  }

  private savePairing(record: WebAuthPairingRecord): void {
    this.memoryPairing = { ...record, failedAttempts: new Map() };
    if (this.db) this.db.saveWebAuthPairing(record);
  }

  private clearPairing(): void {
    this.memoryPairing = null;
    this.db?.clearWebAuthPairing();
  }

  private getSession(tokenHash: string): WebAuthSessionRecord | null {
    return this.db?.getWebAuthSession(tokenHash)
      ?? this.memorySessions.get(tokenHash)
      ?? null;
  }

  private requestToken(request: IncomingMessage): string | null {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
      return match?.[1] ?? null;
    }
    // A native cross-origin page must explicitly present its token, even on loopback.
    if (nativeOriginRequiresBearer(request)) return null;
    return readCookie(request.headers.cookie, SESSION_COOKIE);
  }

  private createSession(session: WebAuthSessionRecord): void {
    if (this.db) this.db.createWebAuthSession(session);
    else this.memorySessions.set(session.tokenHash, session);
  }

  private touchSession(session: WebAuthSessionRecord, request: IncomingMessage): void {
    const now = this.now();
    const lastSeen = Date.parse(session.lastSeenAt);
    // Authorization still reads revocation/expiry on every request; only display metadata is throttled.
    const userAgent = headerValue(request, "user-agent") ?? session.userAgent;
    const remoteAddress = this.clientAddress(request) ?? session.remoteAddress;
    const observedOrigin = webAuthRequestOrigin(request);
    const lastAccessOrigin = observedOrigin ?? session.lastAccessOrigin ?? null;
    const clientType = session.clientType && session.clientType !== "unknown" ? session.clientType
      : request.headers.authorization !== undefined ? "app" : "browser";
    if (now >= lastSeen && now - lastSeen < SESSION_TOUCH_INTERVAL_MS
      && userAgent === session.userAgent && remoteAddress === session.remoteAddress
      && lastAccessOrigin === (session.lastAccessOrigin ?? null) && clientType === session.clientType
      && (!observedOrigin || session.lastAccessOriginAt === session.lastSeenAt)) return;
    const lastSeenAt = new Date(now).toISOString();
    if (this.db) {
      this.db.touchWebAuthSession(session.sessionId, lastSeenAt, userAgent, remoteAddress, observedOrigin, clientType);
    } else {
      session.lastSeenAt = lastSeenAt;
      session.userAgent = userAgent;
      session.remoteAddress = remoteAddress;
      session.clientType = clientType;
      if (observedOrigin) {
        session.lastAccessOrigin = observedOrigin;
        session.lastAccessOriginAt = lastSeenAt;
      }
    }
  }

  private updateSessionDeviceName(sessionId: string, deviceName: string): void {
    if (this.db) this.db.updateWebAuthSessionDeviceName(sessionId, deviceName);
    for (const session of this.memorySessions.values()) {
      if (session.sessionId === sessionId) session.deviceName = deviceName;
    }
  }

  private updateSessionExpiry(sessionId: string, expiresAt: string): void {
    if (this.db) this.db.updateWebAuthSessionExpiry(sessionId, expiresAt);
    for (const session of this.memorySessions.values()) {
      if (session.sessionId === sessionId) session.expiresAt = expiresAt;
    }
  }

  private revokeSession(sessionId: string): void {
    const revokedAt = new Date(this.now()).toISOString();
    if (this.db) this.db.revokeWebAuthSession(sessionId, revokedAt);
    for (const session of this.memorySessions.values()) {
      if (session.sessionId === sessionId) session.revokedAt = revokedAt;
    }
    for (const listener of this.revocationListeners) listener();
  }

  private listActiveSessions(): WebAuthSessionRecord[] {
    const now = this.now();
    const rows = this.db?.listWebAuthSessions() ?? [...this.memorySessions.values()];
    return rows.filter((session) =>
      session.revokedAt === null && Date.parse(session.expiresAt) > now
    );
  }

  private clientAddress(request: IncomingMessage): string | null {
    const socketAddress = normalizeAddress(request.socket.remoteAddress);
    if (socketAddress && this.localAddresses.has(socketAddress)) {
      // A local reverse proxy can hide a remote browser behind its loopback socket.
      // Vite overwrites this header from its socket peer; ignore forwarded headers from remote peers.
      const forwardedAddress = firstForwardedAddress(request.headers["x-forwarded-for"]);
      if (forwardedAddress) return normalizeAddress(forwardedAddress);
    }
    return socketAddress;
  }

  private checkPairingRateLimit(request: IncomingMessage, pairing: PairingState): void {
    const key = this.clientAddress(request) ?? "unknown";
    const attempt = pairing.failedAttempts.get(key);
    if (!attempt) return;
    const now = this.now();
    if (attempt.resetAt <= now) {
      pairing.failedAttempts.delete(key);
      return;
    }
    if (attempt.count >= FAILED_PAIRING_LIMIT) {
      throw new PairingRateLimitError(Math.max(1, Math.ceil((attempt.resetAt - now) / 1000)));
    }
  }

  private recordFailedPairingAttempt(request: IncomingMessage, pairing: PairingState): void {
    const key = this.clientAddress(request) ?? "unknown";
    const now = this.now();
    const current = pairing.failedAttempts.get(key);
    if (!current || current.resetAt <= now) {
      pairing.failedAttempts.set(key, {
        count: 1,
        resetAt: now + FAILED_PAIRING_WINDOW_MS,
      });
      return;
    }
    current.count += 1;
  }
}

function webAuthSessionState(session: WebAuthSessionRecord, now: number): WebAuthDevice["status"] {
  const expiry = Date.parse(session.expiresAt);
  // Natural expiry can also mark a row revoked; distinguish that from an early revocation.
  if (session.revokedAt && Date.parse(session.revokedAt) < expiry) return "revoked";
  return session.revokedAt === null && Number.isFinite(expiry) && expiry > now ? "active" : "expired";
}

/** Public access origin for display only. Never use it as an authentication signal. */
export function webAuthRequestOrigin(request: IncomingMessage): string | null {
  const parse = (value: string | undefined): string | null => {
    if (!value || value.length > 500) return null;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
        && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
    } catch { return null; }
  };
  const peer = normalizeAddress(request.socket.remoteAddress);
  const localProxy = peer === "127.0.0.1" || peer === "::1";
  if (localProxy) {
    const explicit = parse(headerValue(request, "x-bridge-public-origin") ?? undefined);
    if (explicit) return explicit;
    const forwardedHost = headerValue(request, "x-forwarded-host")?.split(",", 1)[0]?.trim();
    const forwardedProto = headerValue(request, "x-forwarded-proto")?.split(",", 1)[0]?.trim();
    const forwarded = forwardedHost ? parse(`${forwardedProto === "https" ? "https" : "http"}://${forwardedHost}`) : null;
    if (forwarded) return forwarded;
  }
  const protocol = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted ? "https" : "http";
  const host = headerValue(request, "host");
  return host ? parse(`${protocol}://${host}`) : null;
}

function addCalendarYear(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

function generatePairingCode(): string {
  const bytes = randomBytes(12);
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join("");
}

function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

function normalizePairingCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeStringMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  // App markers are appended to the system UA, which can already exceed 500
  // characters on some devices. Keep the suffix within a bounded stored value.
  return typeof value === "string" ? value.slice(0, name === "user-agent" ? 2_048 : 500) : null;
}

function deviceNameFromRequest(request: IncomingMessage): string {
  const userAgent = headerValue(request, "user-agent")?.toLowerCase() ?? "";
  if (userAgent.includes("harmonyos") || userAgent.includes("huawei")) return "华为手机";
  if (userAgent.includes("iphone") || userAgent.includes("ipad")) return "iPhone / iPad";
  if (userAgent.includes("android")) return "Android";
  if (userAgent.includes("macintosh")) return "Mac";
  if (userAgent.includes("windows")) return "Windows";
  return "Browser device";
}

function deviceDisplayName(session: WebAuthSessionRecord): string {
  const userAgent = session.userAgent?.toLowerCase() ?? "";
  if (session.deviceName === "Android" && (userAgent.includes("harmonyos") || userAgent.includes("huawei"))) {
    return "华为手机";
  }
  return session.deviceName;
}

function isSecureRequest(request: IncomingMessage): boolean {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  if (typeof forwardedProtocol === "string" && forwardedProtocol.split(",")[0]?.trim() === "https") {
    return true;
  }
  return Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
}

function collectLocalAddresses(): Set<string> {
  return new Set<string>(["127.0.0.1", "::1"]);
}

function normalizeAddress(value: string | undefined): string | null {
  if (!value) return null;
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function firstForwardedAddress(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  const address = header?.split(",", 1)[0]?.trim();
  return address || null;
}
