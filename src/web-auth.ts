import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const SESSION_COOKIE = "bridge_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
}

export interface WebAuthDatabase {
  getWebAuthPairing(): WebAuthPairingRecord | null;
  saveWebAuthPairing(record: WebAuthPairingRecord): void;
  clearWebAuthPairing(): void;
  createWebAuthSession(record: WebAuthSessionRecord): void;
  getWebAuthSession(tokenHash: string): WebAuthSessionRecord | null;
  touchWebAuthSession(sessionId: string, lastSeenAt: string): void;
  listWebAuthSessions(): WebAuthSessionRecord[];
  updateWebAuthSessionDeviceName(sessionId: string, deviceName: string): void;
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
}

export interface PairingStatus {
  authenticated: boolean;
  local: boolean;
  activeSessionCount: number | null;
  pairingAvailable: boolean;
  pairingExpiresAt: number | null;
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
  private memoryPairing: PairingState | null = null;

  constructor(options: {
    db?: WebAuthDatabase;
    now?: () => number;
    allowLocalRequests?: boolean;
  } = {}) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.allowLocalRequests = options.allowLocalRequests ?? false;
  }

  public isLocalRequest(request: IncomingMessage): boolean {
    const address = normalizeAddress(request.socket.remoteAddress);
    return address !== null && this.localAddresses.has(address);
  }

  public isAuthorized(request: IncomingMessage): boolean {
    if (this.allowLocalRequests && this.isLocalRequest(request)) return true;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) return false;
    const session = this.getSession(hashToken(token));
    if (!session || session.revokedAt !== null) return false;
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.revokeSession(session.sessionId);
      return false;
    }
    this.touchSession(session);
    return true;
  }

  public status(request: IncomingMessage): PairingStatus {
    const pairing = this.getPairing();
    const authenticated = this.isAuthorized(request);
    return {
      authenticated,
      local: this.isLocalRequest(request),
      activeSessionCount: authenticated ? this.listActiveSessions().length : null,
      pairingAvailable: pairing !== null && pairing.expiresAt > this.now(),
      pairingExpiresAt: pairing && pairing.expiresAt > this.now() ? pairing.expiresAt : null,
    };
  }

  public listDevices(request: IncomingMessage): WebAuthDevice[] | null {
    if (!this.isAuthorized(request)) return null;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const currentSessionId = token
      ? this.getSession(hashToken(token))?.sessionId ?? null
      : null;
    return this.listActiveSessions().map((session) => ({
      sessionId: session.sessionId,
      current: session.sessionId === currentSessionId,
      deviceName: session.deviceName,
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

  public claimPairing(request: IncomingMessage, rawCode: string): string {
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
    const session: WebAuthSessionRecord = {
      sessionId: randomUUID(),
      tokenHash: hashToken(token),
      deviceName: deviceNameFromRequest(request),
      userAgent: headerValue(request, "user-agent"),
      remoteAddress: normalizeAddress(request.socket.remoteAddress),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      revokedAt: null,
    };
    this.createSession(session);
    return token;
  }

  public setSessionCookie(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): void {
    const attributes = [
      SESSION_COOKIE + "=" + token,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=" + Math.floor(SESSION_TTL_MS / 1000),
    ];
    if (isSecureRequest(request)) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  public clearSession(request: IncomingMessage, response: ServerResponse): void {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) {
      const session = this.getSession(hashToken(token));
      if (session) this.revokeSession(session.sessionId);
    }
    response.setHeader(
      "Set-Cookie",
      SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
  }

  public revokeAll(): void {
    if (this.db) {
      this.db.revokeAllWebAuthSessions(new Date(this.now()).toISOString());
      return;
    }
    for (const session of this.memorySessions.values()) {
      session.revokedAt = new Date(this.now()).toISOString();
    }
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

  private createSession(session: WebAuthSessionRecord): void {
    if (this.db) this.db.createWebAuthSession(session);
    else this.memorySessions.set(session.tokenHash, session);
  }

  private touchSession(session: WebAuthSessionRecord): void {
    const lastSeenAt = new Date(this.now()).toISOString();
    if (this.db) this.db.touchWebAuthSession(session.sessionId, lastSeenAt);
    else session.lastSeenAt = lastSeenAt;
  }

  private updateSessionDeviceName(sessionId: string, deviceName: string): void {
    if (this.db) this.db.updateWebAuthSessionDeviceName(sessionId, deviceName);
    for (const session of this.memorySessions.values()) {
      if (session.sessionId === sessionId) session.deviceName = deviceName;
    }
  }

  private revokeSession(sessionId: string): void {
    const revokedAt = new Date(this.now()).toISOString();
    if (this.db) this.db.revokeWebAuthSession(sessionId, revokedAt);
    for (const session of this.memorySessions.values()) {
      if (session.sessionId === sessionId) session.revokedAt = revokedAt;
    }
  }

  private listActiveSessions(): WebAuthSessionRecord[] {
    const now = this.now();
    const rows = this.db?.listWebAuthSessions() ?? [...this.memorySessions.values()];
    return rows.filter((session) =>
      session.revokedAt === null && Date.parse(session.expiresAt) > now
    );
  }

  private checkPairingRateLimit(request: IncomingMessage, pairing: PairingState): void {
    const key = normalizeAddress(request.socket.remoteAddress) ?? "unknown";
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
    const key = normalizeAddress(request.socket.remoteAddress) ?? "unknown";
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
  return typeof value === "string" ? value.slice(0, 500) : null;
}

function deviceNameFromRequest(request: IncomingMessage): string {
  const userAgent = headerValue(request, "user-agent")?.toLowerCase() ?? "";
  if (userAgent.includes("iphone") || userAgent.includes("ipad")) return "iPhone / iPad";
  if (userAgent.includes("android")) return "Android";
  if (userAgent.includes("macintosh")) return "Mac";
  if (userAgent.includes("windows")) return "Windows";
  return "Browser device";
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
