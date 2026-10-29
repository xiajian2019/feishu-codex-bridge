import { randomBytes } from "node:crypto";

type Grant = { demoId: string; target: string; expires: number; authorized: () => boolean };
export class DemoBrowserAccess {
  private tickets = new Map<string, Grant>();
  private sessions = new Map<string, Grant>();
  constructor(private now: () => number = Date.now) {}
  private prune(): void {
    for (const entries of [this.tickets, this.sessions]) {
      for (const [key, grant] of entries) if (grant.expires <= this.now() || !grant.authorized()) entries.delete(key);
    }
  }
  issue(demoId: string, target: string, authorized: () => boolean): string {
    this.prune();
    if (!authorized()) throw new Error("Demo 授权已失效，请重新配对。");
    if (this.tickets.size >= 100 || this.sessions.size >= 500) throw new Error("Demo 浏览器连接过多，请稍后重试。");
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { demoId, target, authorized, expires: this.now() + 60_000 });
    return ticket;
  }
  consume(demoId: string, ticket: string): { token: string; target: string } | null {
    this.prune();
    const grant = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!grant || grant.demoId !== demoId || this.sessions.size >= 500) return null;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { ...grant, expires: this.now() + 8 * 60 * 60 * 1_000 });
    return { token, target: grant.target };
  }
  allows(demoId: string, cookie: string | undefined): boolean {
    this.prune();
    const token = cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`bridge_demo_${demoId}=`))?.split("=")[1];
    const grant = token ? this.sessions.get(token) : null;
    return grant?.demoId === demoId;
  }
}
