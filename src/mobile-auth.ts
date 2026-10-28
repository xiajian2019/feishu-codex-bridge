import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Exact WebView origins shipped in the native apps; never allow arbitrary localhost ports. */
export function isNativeAppOrigin(origin: string | undefined): boolean {
  return origin === "capacitor://localhost" || origin === "https://localhost" || origin === "http://localhost";
}

/** A browser served at localhost itself retains the existing cookie behavior. */
export function nativeOriginRequiresBearer(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!isNativeAppOrigin(origin)) return false;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  const host = first(request.headers["x-forwarded-host"]) || request.headers.host;
  const secure = first(request.headers["x-forwarded-proto"]) === "https" || Boolean((request.socket as { encrypted?: boolean }).encrypted);
  try { return origin !== new URL(`${secure ? "https" : "http"}://${host}`).origin; }
  catch { return true; }
}

export interface MobileStreamAuthorization {
  deviceId: string;
  isAuthorized: () => boolean;
}

interface StreamTicket extends MobileStreamAuthorization {
  path: string;
  expiresAt: number;
}

/** Tickets are intentionally ephemeral, single-use, and never persisted or logged. */
export class MobileStreamTickets {
  private readonly tickets = new Map<string, StreamTicket>();

  constructor(private readonly now: () => number = Date.now, private readonly capacity = 1_000) {}

  public issue(path: string, authorization: MobileStreamAuthorization): { ticket: string; expiresAt: number } {
    const target = streamTarget(path);
    if (!target) throw new Error("invalid stream path");
    this.prune();
    if (this.tickets.size >= this.capacity) throw new Error("too many pending stream tickets");
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + 30_000;
    this.tickets.set(ticket, { ...authorization, path: target, expiresAt });
    return { ticket, expiresAt };
  }

  public consume(path: string): MobileStreamAuthorization | null {
    const url = new URL(path, "http://bridge.invalid");
    const values = url.searchParams.getAll("bridgeTicket");
    if (values.length !== 1) return null;
    const key = values[0]!;
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    this.prune();
    url.searchParams.delete("bridgeTicket");
    if (!ticket || ticket.expiresAt <= this.now() || !ticket.isAuthorized()) return null;
    // URLSearchParams normalizes escaping, so normalize both target and request identically.
    if (ticket.path !== streamTarget(url.pathname + url.search)) return null;
    return { deviceId: ticket.deviceId, isAuthorized: ticket.isAuthorized };
  }

  public clear(): void { this.tickets.clear(); }

  private prune(): void {
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= this.now() || !ticket.isAuthorized()) this.tickets.delete(key);
    }
  }
}

function streamTarget(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")) return null;
  const url = new URL(path, "http://bridge.invalid");
  if (url.origin !== "http://bridge.invalid" || url.searchParams.has("bridgeTicket")) return null;
  if (url.pathname !== "/api/events" && url.pathname !== "/tmux-dashboard/terminal") return null;
  const query = url.searchParams.toString();
  return url.pathname + (query ? `?${query}` : "");
}
