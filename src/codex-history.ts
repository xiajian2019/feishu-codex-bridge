import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, relative, resolve } from "node:path";

import {
  CODEX_THREAD_SOURCE_KINDS,
  CODEX_THREAD_STATUS_TYPES,
  CodexAppServerClient,
  codexThreadSourceLabel,
  codexThreadStatusType,
  codexThreadTimestampMs,
  type CodexAppServerQueryClient,
  type CodexThread,
  type CodexThreadListParams,
  type CodexThreadSortDirection,
  type CodexThreadSortKey,
  type CodexThreadSourceKind,
} from "./codex-app-server.js";
import type { Logger } from "./types.js";

export const CODEX_HISTORY_DEFAULT_SOURCE_KINDS: CodexThreadSourceKind[] = ["cli", "appServer"];
export const CODEX_HISTORY_PAGE_SIZE = 200;
export const CODEX_HISTORY_MAX_SCAN = 10_000;

export type CodexHistoryArchivedFilter = "active" | "archived" | "all";

export interface CodexHistoryHome {
  id: string;
  label: string;
  path: string;
  available: boolean;
  error?: string;
}

interface ResolvedCodexHistoryHome extends CodexHistoryHome {
  sqliteHome?: string;
}

export interface CodexHistoryQuery {
  homeId?: string;
  searchTerm?: string;
  statuses?: string[];
  sourceKinds: CodexThreadSourceKind[];
  modelProviders?: string[];
  cwd?: string[];
  archived: CodexHistoryArchivedFilter;
  sortKey: CodexThreadSortKey;
  sortDirection: CodexThreadSortDirection;
  limit: number;
  offset: number;
}

export interface CodexHistoryItem {
  home: CodexHistoryHome;
  thread: CodexThread;
}

export interface CodexHistoryListResponse {
  items: CodexHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  homes: CodexHistoryHome[];
}

export interface CodexHistoryDetailResponse {
  home: CodexHistoryHome;
  thread: CodexThread;
}

export interface CodexHistoryServiceOptions {
  executable: string;
  cwd?: string;
  environment?: Record<string, string>;
  /** Explicit homes are useful for tests and for installations outside ~/.codex/accounts. */
  homePaths?: string[];
  requestTimeoutMs?: number;
  logger?: Logger;
  createClient?: (home: ResolvedCodexHistoryHome) => CodexAppServerQueryClient;
}

/**
 * Read local Codex history through the read-only app-server protocol.
 *
 * A Codex home owns both credentials and local history. Every query therefore
 * gets a separate short-lived app-server process with that home selected in
 * its environment; no auth.json or SQLite file is parsed by the bridge.
 */
export class CodexHistoryService {
  private readonly options: CodexHistoryServiceOptions;

  constructor(options: CodexHistoryServiceOptions) {
    this.options = options;
  }

  public listHomes(): CodexHistoryHome[] {
    return this.resolveHomes().map(toPublicHome);
  }

  public async listThreads(query: CodexHistoryQuery): Promise<CodexHistoryListResponse> {
    const resolvedHomes = this.resolveHomes();
    const homes = query.homeId
      ? resolvedHomes.filter((home) => home.id === query.homeId)
      : resolvedHomes;
    if (homes.length === 0) {
      throw new Error(`找不到 Codex home：${query.homeId || "(none)"}`);
    }

    const results = await Promise.all(homes.map(async (home) => {
      try {
        const threads = await this.queryHome(home, query);
        return { home, threads };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn("failed to read local Codex history", {
          home: home.path,
          error: message,
        });
        return { home: { ...home, error: message }, threads: [] as CodexThread[] };
      }
    }));

    const items = results.flatMap(({ home, threads }) => threads.map((thread) => ({
      home: toPublicHome(home),
      thread,
    })));
    items.sort((left, right) => compareThreads(left.thread, right.thread, query.sortKey, query.sortDirection));
    const resultHomes = new Map(results.map(({ home }) => [home.id, home]));

    return {
      items: items.slice(query.offset, query.offset + query.limit),
      total: items.length,
      limit: query.limit,
      offset: query.offset,
      // Keep the selector populated with every discovered home even when the
      // current query is scoped to one account.
      homes: resolvedHomes.map((home) => toPublicHome(resultHomes.get(home.id) ?? home)),
    };
  }

  public async readThread(
    homeId: string,
    threadId: string,
    includeTurns = true,
  ): Promise<CodexHistoryDetailResponse> {
    const home = this.resolveHomes().find((candidate) => candidate.id === homeId);
    if (!home) throw new Error(`找不到 Codex home：${homeId}`);
    if (!home.available) throw new Error(`Codex home 不可用：${home.path}`);

    const client = this.createClient(home);
    try {
      if (!client.readThread) throw new Error("当前 Codex 只读客户端不支持 thread/read");
      const result = await client.readThread(threadId, includeTurns);
      return { home: toPublicHome(home), thread: result.thread };
    } finally {
      await client.close();
    }
  }

  private resolveHomes(): ResolvedCodexHistoryHome[] {
    const homeDirectory = homedir();
    const primaryHome = normalizePath(
      this.options.environment?.CODEX_HOME || join(homeDirectory, ".codex"),
      homeDirectory,
    );
    const configuredHomes = this.options.homePaths?.length
      ? this.options.homePaths
      : discoverCodexHomePaths(this.options.environment, homeDirectory);
    const paths = uniquePaths([
      primaryHome,
      ...configuredHomes.map((path) => normalizePath(path, homeDirectory)),
    ]);
    return paths.map((path) => buildHome(path, primaryHome));
  }

  private async queryHome(home: ResolvedCodexHistoryHome, query: CodexHistoryQuery): Promise<CodexThread[]> {
    if (!home.available) throw new Error(`Codex home 不可用：${home.path}`);

    const client = this.createClient(home);
    try {
      const archivedValues: boolean[] = query.archived === "all"
        ? [false, true]
        : [query.archived === "archived"];
      const threads: CodexThread[] = [];
      const seenThreadIds = new Set<string>();
      let scanned = 0;

      for (const archived of archivedValues) {
        if (scanned >= CODEX_HISTORY_MAX_SCAN) {
          throw new Error(`本地历史最多扫描 ${CODEX_HISTORY_MAX_SCAN} 个线程，请先缩小搜索范围`);
        }
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        while (true) {
          const page = await client.listThreads(buildListParams(query, archived, cursor));
          scanned += page.data.length;
          if (scanned > CODEX_HISTORY_MAX_SCAN) {
            throw new Error(`本地历史最多扫描 ${CODEX_HISTORY_MAX_SCAN} 个线程，请先缩小搜索范围`);
          }
          for (const thread of page.data) {
            if (seenThreadIds.has(thread.id) || !matchesLocalFilters(thread, query)) continue;
            seenThreadIds.add(thread.id);
            threads.push(thread);
          }
          if (!page.nextCursor) break;
          if (seenCursors.has(page.nextCursor)) {
            throw new Error("Codex app-server 返回了重复的分页 cursor");
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
          if (scanned >= CODEX_HISTORY_MAX_SCAN) {
            throw new Error(`本地历史最多扫描 ${CODEX_HISTORY_MAX_SCAN} 个线程，请先缩小搜索范围`);
          }
        }
      }
      return threads;
    } finally {
      await client.close();
    }
  }

  private createClient(home: ResolvedCodexHistoryHome): CodexAppServerQueryClient {
    if (this.options.createClient) return this.options.createClient(home);
    const environment = { ...(this.options.environment ?? {}) };
    environment.CODEX_HOME = home.path;
    if (home.sqliteHome) environment.CODEX_SQLITE_HOME = home.sqliteHome;
    else delete environment.CODEX_SQLITE_HOME;
    return new CodexAppServerClient({
      executable: this.options.executable,
      cwd: this.options.cwd,
      env: environment,
      requestTimeoutMs: this.options.requestTimeoutMs,
      clientName: "feishu_codex_bridge_history",
      clientTitle: "Feishu Codex Bridge (history)",
    });
  }
}

export function discoverCodexHomePaths(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): string[] {
  const primaryHome = normalizePath(
    environment.CODEX_HOME || join(homeDirectory, ".codex"),
    homeDirectory,
  );
  const explicitHomes = [
    environment.FEISHU_CODEX_HISTORY_HOMES,
    environment.CODEX_HISTORY_HOMES,
  ].flatMap((value) => value ? value.split(delimiter) : [])
    .map((value) => normalizePath(value, homeDirectory));
  const accountHomes = readAccountHomes(primaryHome);
  return uniquePaths([primaryHome, ...accountHomes, ...explicitHomes]);
}

function buildListParams(
  query: CodexHistoryQuery,
  archived: boolean,
  cursor: string | null,
): CodexThreadListParams {
  return {
    cursor,
    limit: CODEX_HISTORY_PAGE_SIZE,
    sortKey: query.sortKey,
    sortDirection: query.sortDirection,
    sourceKinds: query.sourceKinds,
    modelProviders: query.modelProviders,
    archived,
    cwd: query.cwd?.length === 1 ? query.cwd[0] : query.cwd,
    searchTerm: query.searchTerm,
    // Listing must remain read-only. In particular, do not make app-server
    // scan JSONL and repair its state database just because the page refreshed.
    useStateDbOnly: true,
  };
}

function matchesLocalFilters(thread: CodexThread, query: CodexHistoryQuery): boolean {
  if (query.statuses?.length && !query.statuses.includes(codexThreadStatusType(thread.status))) {
    return false;
  }
  if (query.cwd?.length && (!thread.cwd || !query.cwd.includes(resolve(thread.cwd)))) {
    return false;
  }
  return true;
}

function compareThreads(
  left: CodexThread,
  right: CodexThread,
  sortKey: CodexThreadSortKey,
  direction: CodexThreadSortDirection,
): number {
  const leftValue = threadSortTimestamp(left, sortKey);
  const rightValue = threadSortTimestamp(right, sortKey);
  if (leftValue === rightValue) {
    const leftTitle = left.name?.trim() || left.preview?.trim() || "";
    const rightTitle = right.name?.trim() || right.preview?.trim() || "";
    return leftTitle.localeCompare(rightTitle);
  }
  const result = leftValue - rightValue;
  return direction === "asc" ? result : -result;
}

function threadSortTimestamp(thread: CodexThread, sortKey: CodexThreadSortKey): number {
  const value = sortKey === "created_at"
    ? thread.createdAt
    : sortKey === "updated_at"
      ? thread.updatedAt
      : thread.recencyAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const fallback = codexThreadTimestampMs(thread);
  return fallback === null ? 0 : fallback / 1_000;
}

function buildHome(path: string, primaryHome: string): ResolvedCodexHistoryHome {
  const available = existsSync(path) && isDirectory(path);
  const sqliteHome = available ? findSqliteHome(path) : undefined;
  const relativeToAccounts = relative(join(primaryHome, "accounts"), path);
  const accountName = relativeToAccounts && !relativeToAccounts.startsWith("..")
    ? relativeToAccounts.split("/")[0]
    : undefined;
  const label = path === primaryHome
    ? "默认"
    : accountName || basename(path) || path;
  return {
    id: `codex-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
    label,
    path,
    available,
    ...(sqliteHome ? { sqliteHome } : {}),
    ...(available ? {} : { error: "目录不存在或不可读取" }),
  };
}

function findSqliteHome(homePath: string): string | undefined {
  const nested = join(homePath, "sqlite");
  if (hasStateDatabase(nested)) return nested;
  if (hasStateDatabase(homePath)) return homePath;
  return undefined;
}

function hasStateDatabase(directory: string): boolean {
  if (!existsSync(directory) || !isDirectory(directory)) return false;
  try {
    return readdirSync(directory).some((entry) => /^state_\d+\.sqlite(?:-(?:shm|wal))?$/.test(entry));
  } catch {
    return false;
  }
}

function readAccountHomes(primaryHome: string): string[] {
  const accountsDirectory = join(primaryHome, "accounts");
  if (!existsSync(accountsDirectory) || !isDirectory(accountsDirectory)) return [];
  try {
    return readdirSync(accountsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(accountsDirectory, entry.name));
  } catch {
    return [];
  }
}

function normalizePath(path: string, homeDirectory: string): string {
  const expanded = path.trim().replace(/^~(?=\/|$)/, homeDirectory);
  const resolved = resolve(expanded);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toPublicHome(home: ResolvedCodexHistoryHome | CodexHistoryHome): CodexHistoryHome {
  const { id, label, path, available, error } = home;
  return { id, label, path, available, ...(error ? { error } : {}) };
}

// Keep this import-time assertion close to the service contract. It catches a
// future Codex source/status expansion before the web query parser silently
// rejects it, while avoiding a second handwritten list in the page layer.
export const CODEX_HISTORY_SOURCE_KINDS = [...CODEX_THREAD_SOURCE_KINDS];
export const CODEX_HISTORY_STATUS_TYPES = [...CODEX_THREAD_STATUS_TYPES];

export function codexHistorySourceLabel(source: unknown): string {
  return codexThreadSourceLabel(source);
}
