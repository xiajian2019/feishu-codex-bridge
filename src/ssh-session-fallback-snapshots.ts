import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTmuxResurrectController, getTmuxResurrectStatus, type TmuxResurrectController } from "./tmux-resurrect.js";
import * as tmux from "./tmux-dashboard.js";

interface SnapshotRecord {
  version: 1;
  id: string;
  createdAt: number;
  name: string;
  cwd: string;
  state: "saved" | "suspending" | "suspended" | "restoring" | "ended";
  savedAt: string;
}

/** Per-Session snapshot metadata for the database-free SSH fallback. */
export class SshFallbackSnapshots {
  private readonly root: string;
  private readonly controller: TmuxResurrectController;

  constructor(root = join(getTmuxResurrectStatus().saveDirectory, "bridge-ssh-fallback"), controller?: TmuxResurrectController) {
    this.root = root;
    this.controller = controller ?? createTmuxResurrectController(root);
  }

  async save(session: tmux.TmuxSession, suspend: boolean): Promise<void> {
    await this.withLock(session.name, async () => {
      const previous = this.read(session.name);
      if (previous?.state === "suspended" || previous?.state === "restoring") {
        throw new Error("已有同名 SSH 降级快照待恢复，请先处理该快照。");
      }
      if (previous?.state === "suspending") {
        const live = await tmux.findSession(previous.id);
        if (!live || live.createdAt !== previous.createdAt) throw new Error("同名 SSH 快照的挂起结果未知，请先核对。");
      }
      const snapshot = await this.controller.saveSession(session.name);
      const record: SnapshotRecord = { version: 1, id: session.id, createdAt: session.createdAt,
        name: session.name, cwd: session.cwd, state: suspend ? "suspending" : "saved", savedAt: snapshot.snapshot.savedAt };
      this.write(record);
      if (!suspend) return;
      const current = await tmux.findSession(session.id);
      if (!current || current.createdAt !== session.createdAt || current.name !== session.name) {
        throw new Error("Session 已结束、重建或改名；快照已保留，请先核对。");
      }
      await tmux.killSession(session.id);
      this.write({ ...record, state: "suspended" });
    });
  }

  async list(knownLive?: tmux.TmuxSession[]): Promise<Array<{ id: string; createdAt: number; name: string; cwd: string; savedAt: string; source: "ssh-fallback"; uncertain?: boolean }>> {
    const directory = this.recordsDirectory();
    if (!existsSync(directory)) return [];
    const records = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => this.readFile(join(directory, name))).filter((record): record is SnapshotRecord => record !== null);
    const live = knownLive ?? await tmux.listSessions();
    return records.flatMap((record) => {
      if (!this.controller.snapshotForSession(record.name)) return [];
      if (record.state === "suspending" && live.some((session) => session.id === record.id && session.createdAt === record.createdAt)) return [];
      if (!["suspended", "suspending", "restoring"].includes(record.state)) return [];
      return [{ id: record.id, createdAt: record.createdAt, name: record.name, cwd: record.cwd, savedAt: record.savedAt,
        source: "ssh-fallback" as const, ...(record.state === "restoring" ? { uncertain: true } : {}) }];
    });
  }

  async endSuspended(id: string, createdAt: number): Promise<void> {
    const record = (await this.list()).find((candidate) => candidate.id === id && candidate.createdAt === createdAt);
    if (!record) throw new Error("SSH 降级快照不存在或已变化，请刷新后重试。");
    await this.withLock(record.name, async () => {
      const current = this.read(record.name);
      if (!current || current.id !== id || current.createdAt !== createdAt ||
        (current.state !== "suspended" && current.state !== "suspending")) {
        throw new Error("SSH 降级快照已变化或恢复结果未知，请先核对。");
      }
      if ((await tmux.listSessions()).some((session) => session.name === current.name)) {
        throw new Error("同名 Session 正在运行，请先核对后再终结快照。");
      }
      this.controller.disableSession(current.name);
      this.write({ ...current, state: "ended" });
    });
  }

  async restore(id: string, createdAt: number): Promise<tmux.TmuxSession> {
    const record = (await this.list()).find((candidate) => candidate.id === id && candidate.createdAt === createdAt);
    if (!record) throw new Error("SSH 降级快照不存在或已变化，请刷新后重试。");
    return this.withLock(record.name, async () => {
      const current = this.read(record.name);
      if (!current || current.id !== id || current.createdAt !== createdAt) throw new Error("SSH 降级快照已变化，请刷新后重试。");
      if (current.state === "restoring") throw new Error("恢复结果未知，请检查 tmux 后再决定是否重试。");
      if (current.state !== "suspended" && current.state !== "suspending") throw new Error("SSH 降级快照不可恢复。");
      if ((await tmux.listSessions()).some((session) => session.name === current.name)) {
        throw new Error("同名 Session 已在运行，请先检查后再恢复。");
      }
      this.write({ ...current, state: "restoring" });
      await this.controller.restoreSession(current.name);
      const restored = (await tmux.listSessions()).find((session) => session.name === current.name);
      if (!restored) throw new Error("恢复结果未知，请检查 tmux 后再决定是否重试。");
      this.write({ ...current, id: restored.id, createdAt: restored.createdAt, cwd: restored.cwd, state: "saved" });
      return restored;
    });
  }

  async end(session: tmux.TmuxSession): Promise<void> {
    await this.withLock(session.name, async () => {
      const record = this.read(session.name);
      if (record && (record.state === "suspended" || record.state === "restoring") &&
        (record.id !== session.id || record.createdAt !== session.createdAt)) {
        throw new Error("已有同名 SSH 降级快照待恢复，请先处理该快照。");
      }
      const current = await tmux.findSession(session.id);
      if (!current || current.createdAt !== session.createdAt || current.name !== session.name) {
        throw new Error("Session 已结束、重建或改名，请刷新后重试。");
      }
      await tmux.killSession(session.id);
      if (record && record.id === session.id && record.createdAt === session.createdAt) {
        this.controller.disableSession(session.name);
        this.write({ ...record, state: "ended" });
      }
    });
  }

  private key(name: string): string { return createHash("sha256").update(name, "utf8").digest("hex"); }
  private recordsDirectory(): string { return join(this.root, "records"); }
  private recordPath(name: string): string { return join(this.recordsDirectory(), `${this.key(name)}.json`); }
  private read(name: string): SnapshotRecord | null { return this.readFile(this.recordPath(name)); }

  private readFile(path: string): SnapshotRecord | null {
    if (!existsSync(path)) return null;
    let value: Partial<SnapshotRecord>;
    try { value = JSON.parse(readFileSync(path, "utf8")) as Partial<SnapshotRecord>; }
    catch { throw new Error("SSH 降级快照元数据损坏，请检查后再操作。"); }
    if (value.version !== 1 || typeof value.id !== "string" || !/^\$\d+$/.test(value.id) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt! < 0 || typeof value.name !== "string" || !value.name ||
      value.name.length > 255 || /[\u0000-\u001f\u007f]/.test(value.name) || typeof value.cwd !== "string" ||
      !value.cwd.startsWith("/") || /[\u0000-\u001f\u007f]/.test(value.cwd) || typeof value.savedAt !== "string" ||
      !Number.isFinite(Date.parse(value.savedAt)) || !["saved", "suspending", "suspended", "restoring", "ended"].includes(value.state ?? "")) {
      throw new Error("SSH 降级快照元数据无效，请检查后再操作。");
    }
    if (path !== this.recordPath(value.name)) throw new Error("SSH 降级快照身份不匹配。");
    return value as SnapshotRecord;
  }

  private write(record: SnapshotRecord): void {
    mkdirSync(this.recordsDirectory(), { recursive: true, mode: 0o700 });
    const path = this.recordPath(record.name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch { /* Already renamed or absent. */ } }
  }

  private async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const directory = join(this.root, "locks");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${this.key(name)}.lock`);
    let descriptor: number;
    try { descriptor = openSync(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid = 0;
      try { pid = Number(readFileSync(path, "utf8")); } catch { /* Treat an incomplete lock as busy. */ }
      let gone = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probe) { gone = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (gone) throw new Error(`上次 SSH 降级操作异常中断；请确认没有其他操作后检查锁文件：${path}`);
      throw new Error("同一 Session 的 SSH 降级操作正在进行，请稍后重试。");
    }
    try {
      try { writeFileSync(descriptor, String(process.pid)); }
      finally { closeSync(descriptor); }
      return await action();
    } finally { try { unlinkSync(path); } catch { /* Preserve the operation result. */ } }
  }
}
