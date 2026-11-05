import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { inspectGitChanges, previewGitChangeFile } from "./git-workspaces.js";
import type { CodexHistoryService } from "./codex-history.js";
import type { BridgeSshBackend } from "./ssh-session-cli.js";
import { SshFallbackSnapshots } from "./ssh-session-fallback-snapshots.js";
import * as tmux from "./tmux-dashboard.js";

function canonicalHome(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Local SSH fallback. It reads tmux and Git directly, without opening Bridge's database. */
export class DirectBridgeSshBackend implements BridgeSshBackend {
  private history: Promise<CodexHistoryService> | null = null;
  private snapshots: SshFallbackSnapshots | null = null;

  constructor(private readonly selected: { action: string; cwd?: string }, private readonly configPath = "") {}

  private getSnapshots(): SshFallbackSnapshots { return this.snapshots ??= new SshFallbackSnapshots(); }

  private getHistory(): Promise<CodexHistoryService> {
    return this.history ??= (async () => {
      const [{ CodexHistoryService }, { buildCodexAppServerEnvironment }, { isExecutableCodexPath, resolveCodexCliPath },
        { loadConfig }, { resolveBridgeProjectRoot }] = await Promise.all([
        import("./codex-history.js"), import("./codex-app-server.js"), import("./codex-path.js"),
        import("./config.js"), import("./portable-runtime.js"),
      ]);
      let executable = resolveCodexCliPath()?.path || "codex";
      let environment: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      if (this.configPath && existsSync(this.configPath)) {
        const config = loadConfig(this.configPath);
        if (isExecutableCodexPath(config.codex.cliPath)) executable = config.codex.cliPath;
        environment = buildCodexAppServerEnvironment(config);
      }
      return new CodexHistoryService({ executable, environment, cwd: resolveBridgeProjectRoot(import.meta.url) });
    })();
  }

  async request(
    method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>, createdAt?: number,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, "http://localhost");
    if (method === "GET" && path === "/tmux-dashboard/api/codex-homes") {
      return { codexHomes: (await this.getHistory()).listHomes().map(({ id, label, available }) => ({ id, label, available })) };
    }
    if (method === "GET" && path === "/api/codex/homes") return { homes: (await this.getHistory()).listHomes() };
    if (method === "GET" && url.pathname === "/api/codex/usage") {
      return { ...await (await this.getHistory()).readUsage(url.searchParams.get("home") || undefined) };
    }
    if (method === "GET" && path === "/tmux-dashboard/api/sessions/suspended") {
      return { sessions: await this.getSnapshots().list() };
    }
    const match = /^\/tmux-dashboard\/api\/sessions\/([^/]+)(?:\/(identity|git-changes(?:\/content)?|codex-account(?:\/check)?|resurrect\/save|suspend|resume))?$/.exec(url.pathname);
    if (!match) throw new Error("本地 SSH fallback 不支持该操作。");
    let id: string;
    try { id = decodeURIComponent(match[1]!); } catch { throw new Error("Session 标识无效。"); }
    if (!tmux.isSessionId(id) || !Number.isSafeInteger(createdAt) || createdAt! < 0) throw new Error("Session 标识无效。");
    if (method === "POST" && match[2] === "resume") {
      const restored = await this.getSnapshots().restore(id, createdAt!);
      return { session: restored, source: "ssh-fallback" };
    }
    const session = await tmux.findSession(id);
    if (!session || session.createdAt !== createdAt) throw new Error("Session 已结束或重建，请刷新后重试。");
    if (match[2] === "identity" && method === "GET") {
      if (!["accounts", "usage"].includes(this.selected.action)) return { session };
      const marker = await tmux.getCodexHomeForSession(id, session);
      const home = marker ? (await this.getHistory()).listHomes().find((candidate) => canonicalHome(candidate.path) === canonicalHome(marker)) : undefined;
      return { session: { ...session, codexHomeId: home?.id ?? null } };
    }
    if (match[2] === "codex-account" && method === "POST") {
      const home = (await this.getHistory()).listHomes().find((candidate) => candidate.id === body?.homeId && candidate.available);
      if (!home) throw new Error("所选 Codex 账号不可用。");
      await tmux.setCodexHomeForSession(id, home.path);
      return { session: { id, codexHomeId: home.id }, source: "ssh-fallback" };
    }
    if (match[2] === "codex-account/check" && method === "POST") {
      const inspection = await tmux.inspectCodexHome(id, session);
      if (inspection.status !== "running" || !inspection.path) return { status: inspection.status, home: null };
      const home = (await this.getHistory()).listHomes().find((candidate) => candidate.available && canonicalHome(candidate.path) === canonicalHome(inspection.path!));
      if (!home) return { status: "unmatched", home: null };
      await tmux.setCodexHomeForSession(id, home.path);
      return { status: "matched", home: { id: home.id, label: home.label }, session: { id, codexHomeId: home.id }, source: "ssh-fallback" };
    }
    if (method === "POST" && (match[2] === "resurrect/save" || match[2] === "suspend")) {
      const selectedCwd = this.selected.cwd;
      if (selectedCwd && (!isAbsolute(selectedCwd) || /[\u0000-\u001f\u007f]/.test(selectedCwd))) {
        throw new Error("Session 工作目录无效。");
      }
      await this.getSnapshots().save(selectedCwd ? { ...session, cwd: selectedCwd } : session, match[2] === "suspend");
      return { ok: true, source: "ssh-fallback" };
    }
    if (method === "DELETE" && !match[2]) {
      await this.getSnapshots().end(session);
      return { ok: true, source: "ssh-fallback" };
    }
    if (method !== "GET" || !match[2]?.startsWith("git-changes")) throw new Error("本地 SSH fallback 不支持该操作。");

    const cwd = this.selected.cwd;
    if (cwd && (!isAbsolute(cwd) || /[\u0000-\u001f\u007f]/.test(cwd))) throw new Error("Session 工作目录无效。");
    // The App's selected Session may carry the Web's logical worktree. Older
    // clients omit it; in that case use the current live pane directory.
    const directory = cwd ? await tmux.resolveWorkingDirectory(cwd) : await tmux.getCurrentPanePath(id, session);
    if (match[2] === "git-changes") return { ...await inspectGitChanges(directory) };
    const filePath = url.searchParams.get("path") ?? "";
    const expectedRoot = url.searchParams.get("expectedGitRoot") ?? undefined;
    return { ...await previewGitChangeFile(directory, filePath, expectedRoot) };
  }
}
