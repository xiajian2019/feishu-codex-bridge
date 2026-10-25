export interface GitReviewTarget {
  sessionId: string;
  paneId: string;
  gitRoot: string;
  foregroundCodex: {
    pid: number;
    startedAt: string;
    command: "codex";
  };
}

export interface GitReviewAnchor {
  path: string;
  oldPath: string | null;
  kind: "context" | "add" | "delete" | "text" | "range";
  oldLine: number | null;
  newLine: number | null;
  oldEndLine?: number;
  newEndLine?: number;
  side: "old" | "new";
  snippet: string;
  noNewline: boolean;
  headCommit: string;
}

export interface GitReviewDiffLine {
  kind: "context" | "add" | "delete";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noNewline: boolean;
}

/** Each side reserves only enough digits for the visible file, not a fixed touch-button width. */
export function gitReviewGutterDigits(lines: GitReviewDiffLine[]): { oldDigits: number; newDigits: number } {
  let oldMax = 0; let newMax = 0;
  for (const line of lines) {
    oldMax = Math.max(oldMax, line.oldLine ?? 0);
    newMax = Math.max(newMax, line.newLine ?? 0);
  }
  return { oldDigits: Math.max(2, String(oldMax).length), newDigits: Math.max(2, String(newMax).length) };
}

export interface GitReviewComment {
  id: string;
  anchor: GitReviewAnchor;
  text: string;
  selected: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PendingGitReviewDelivery {
  markerId: string;
  target: GitReviewTarget;
  anchors: GitReviewAnchor[];
  reviewText: string;
  createdAt: number;
}

export function mergeGitReviewAnchors(deliveries: PendingGitReviewDelivery[]): GitReviewAnchor[] {
  const merged = new Map<string, GitReviewAnchor>();
  for (const delivery of deliveries) {
    for (const anchor of delivery.anchors) {
      const key = JSON.stringify([
        anchor.path,
        anchor.oldPath,
        anchor.kind,
        anchor.oldLine,
        anchor.newLine,
        anchor.oldEndLine,
        anchor.newEndLine,
        anchor.side,
        anchor.snippet,
        anchor.noNewline,
        anchor.headCommit,
      ]);
      if (!merged.has(key)) merged.set(key, anchor);
    }
  }
  return [...merged.values()];
}

type ReviewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const COMMENT_LIMIT = 500;
const COMMENT_TEXT_LIMIT = 20_000;
const PENDING_DELIVERY_LIMIT = 100;
const COMMENT_STORAGE_PREFIX = "bridge:tmux-git-review:v1:";
const PENDING_STORAGE_KEY = "bridge:tmux-git-review-pending:v1";
export const MAX_REVIEW_RANGE_LINES = 200;
const MAX_REVIEW_RANGE_BYTES = 16 * 1024;

/** Select a continuous, visible range on one side of a diff (or untracked text). */
export function makeGitReviewRange(
  start: GitReviewAnchor,
  end: GitReviewAnchor,
  lines: GitReviewDiffLine[],
): GitReviewAnchor {
  if (start.path !== end.path || start.oldPath !== end.oldPath || start.headCommit !== end.headCommit || start.side !== end.side) {
    throw new Error("请选择同一文件、同一侧的起止行。");
  }
  const field = start.side === "old" ? "oldLine" : "newLine";
  const startNumber = start[field]; const endNumber = end[field];
  if (startNumber === null || endNumber === null) throw new Error("所选行在这一侧不存在。");
  const first = Math.min(startNumber, endNumber); const last = Math.max(startNumber, endNumber);
  if (last - first + 1 > MAX_REVIEW_RANGE_LINES) throw new Error(`每条意见最多选择 ${MAX_REVIEW_RANGE_LINES} 行。`);
  const selected = lines.filter((line) => line[field] !== null && line[field]! >= first && line[field]! <= last);
  if (selected.length !== last - first + 1 || selected.some((line, index) => line[field] !== first + index)) {
    throw new Error("所选范围包含未展示的行，请在同一 diff 片段内选择。");
  }
  const snippet = selected.map((line) => line.text).join("\n");
  if (new TextEncoder().encode(snippet).byteLength > MAX_REVIEW_RANGE_BYTES) throw new Error("所选片段过长，请缩小行范围。");
  return {
    path: start.path, oldPath: start.oldPath, headCommit: start.headCommit, kind: "range", side: start.side,
    oldLine: start.side === "old" ? first : null, newLine: start.side === "new" ? first : null,
    ...(start.side === "old" ? { oldEndLine: last } : { newEndLine: last }),
    snippet, noNewline: selected.at(-1)?.noNewline ?? false,
  };
}

export function gitReviewLocation(anchor: GitReviewAnchor): string {
  const old = anchor.oldLine === null ? null : `旧行 ${anchor.oldLine}${anchor.oldEndLine && anchor.oldEndLine !== anchor.oldLine ? `–${anchor.oldEndLine}` : ""}`;
  const current = anchor.newLine === null ? null : `新行 ${anchor.newLine}${anchor.newEndLine && anchor.newEndLine !== anchor.newLine ? `–${anchor.newEndLine}` : ""}`;
  return [old, current].filter(Boolean).join(" / ");
}

export function gitReviewSnippet(anchor: GitReviewAnchor): string {
  return anchor.kind === "range" ? anchor.snippet
    : (anchor.kind === "delete" ? "-" : anchor.kind === "add" ? "+" : " ") + anchor.snippet;
}

export function gitReviewRangeContains(anchor: GitReviewAnchor | null, side: "old" | "new", line: number | null): boolean {
  if (!anchor || anchor.side !== side || line === null) return false;
  const start = side === "old" ? anchor.oldLine : anchor.newLine;
  const end = (side === "old" ? anchor.oldEndLine : anchor.newEndLine) ?? start;
  return start !== null && end !== null && line >= start && line <= end;
}

export function gitReviewTextLines(text: string): GitReviewDiffLine[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return lines.map((line, index) => ({ kind: "context", oldLine: null, newLine: index + 1, text: line,
    noNewline: index === lines.length - 1 && !text.endsWith("\n") }));
}

export function parseGitReviewLines(patch: string): GitReviewDiffLine[] {
  const result: GitReviewDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) {
        inHunk = false;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") {
      const previous = result.at(-1);
      if (previous) previous.noNewline = true;
      continue;
    }
    const marker = line[0];
    if (marker === " ") {
      result.push({ kind: "context", oldLine, newLine, text: line.slice(1), noNewline: false });
      oldLine += 1;
      newLine += 1;
    } else if (marker === "+") {
      result.push({ kind: "add", oldLine: null, newLine, text: line.slice(1), noNewline: false });
      newLine += 1;
    } else if (marker === "-") {
      result.push({ kind: "delete", oldLine, newLine: null, text: line.slice(1), noNewline: false });
      oldLine += 1;
    } else {
      inHunk = false;
    }
  }
  return result;
}

export function makeDiffAnchor(
  path: string,
  oldPath: string | null,
  headCommit: string,
  line: GitReviewDiffLine,
  side: "old" | "new",
): GitReviewAnchor {
  return {
    path,
    oldPath,
    kind: line.kind,
    oldLine: line.oldLine,
    newLine: line.newLine,
    side,
    snippet: line.text,
    noNewline: line.noNewline,
    headCommit,
  };
}

export function makeTextAnchor(
  path: string,
  headCommit: string,
  lineNumber: number,
  snippet: string,
  noNewline: boolean,
): GitReviewAnchor {
  return {
    path,
    oldPath: null,
    kind: "text",
    oldLine: null,
    newLine: lineNumber,
    side: "new",
    snippet,
    noNewline,
    headCommit,
  };
}

export function gitReviewDraftKey(sessionId: string, gitRoot: string): string {
  return COMMENT_STORAGE_PREFIX + encodeURIComponent(sessionId) + ":" + encodeURIComponent(gitRoot);
}

export function loadGitReviewComments(sessionId: string, gitRoot: string, storage = browserStorage()): GitReviewComment[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(gitReviewDraftKey(sessionId, gitRoot)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      const comment = parseComment(candidate);
      return comment ? [comment] : [];
    }).slice(-COMMENT_LIMIT);
  } catch {
    return [];
  }
}

export function saveGitReviewComments(
  sessionId: string,
  gitRoot: string,
  comments: GitReviewComment[],
  storage = browserStorage(),
): void {
  if (!storage) throw new Error("Review draft storage is unavailable in this browser.");
  storage.setItem(gitReviewDraftKey(sessionId, gitRoot), JSON.stringify(comments.slice(-COMMENT_LIMIT)));
}

export function newGitReviewComment(anchor: GitReviewAnchor, text = ""): GitReviewComment {
  const now = Date.now();
  return { id: createId(), anchor, text, selected: true, createdAt: now, updatedAt: now };
}

/** Draft handoff only: no terminal, pane, Codex-process or delivery receipt dependency. */
export function createGitReviewDraftForward(sessionId: string, comments: GitReviewComment[]): { id: string; sessionId: string; text: string } {
  if (!sessionId.trim() || comments.length === 0 || comments.some((comment) => !comment.text.trim())) {
    throw new Error("请选择需要加入原 Session 草稿的意见。");
  }
  return { id: createId(), sessionId, text: formatGitReviewComments(comments) };
}

export function formatGitReviewComments(comments: GitReviewComment[]): string {
  const blocks = comments.map((comment, index) => {
    const { anchor } = comment;
    const location = gitReviewLocation(anchor);
    const previousPath = anchor.oldPath && anchor.oldPath !== anchor.path ? `（原路径 ${anchor.oldPath}）` : "";
    const newlineNote = anchor.noNewline ? "（文件末尾没有换行符）" : "";
    const fence = "~".repeat(Math.max(3, longestRun(anchor.snippet, "~") + 1));
    const markedSnippet = gitReviewSnippet(anchor);
    const indentedComment = comment.text.split("\n").map((line) => "  " + line).join("\n");
    return [
      `${index + 1}. \`${anchor.path}\`，${location}${previousPath}${newlineNote}`,
      "   锚定片段：",
      `   ${fence}${anchor.kind === "range" ? "text" : "diff"}`,
      markedSnippet.split("\n").map((line) => "   " + line).join("\n"),
      `   ${fence}`,
      "   意见：",
      indentedComment,
    ].join("\n");
  });
  return [
    "请检查当前工作区，并按以下 Git 行级意见处理代码。它们来自原 tmux Session 的 Git 变更审阅：",
    "",
    ...blocks,
    "",
  ].join("\n");
}

export function createGitReviewMarker(markerId: string): string {
  return `<!--bridge-git-review:v1:${markerId}-->`;
}

export function extractGitReviewMarkerIds(text: string): string[] {
  return [...text.matchAll(/(?:^|\n)<!--bridge-git-review:v1:([A-Za-z0-9_-]{1,100})-->(?=\r?\n|$)/g)]
    .map((match) => match[1]!);
}

export function stripGitReviewMarkers(text: string): string {
  return text.replace(/(^|\n)<!--bridge-git-review:v1:[A-Za-z0-9_-]{1,100}-->\r?\n?/g, "$1");
}

export function newGitReviewMarkerId(): string {
  return createId();
}

export function loadPendingGitReviewDeliveries(storage = browserStorage()): PendingGitReviewDelivery[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      const delivery = parseDelivery(candidate);
      return delivery ? [delivery] : [];
    }).slice(-PENDING_DELIVERY_LIMIT);
  } catch {
    return [];
  }
}

export function getPendingGitReviewDelivery(markerId: string, storage = browserStorage()): PendingGitReviewDelivery | null {
  return loadPendingGitReviewDeliveries(storage).find((delivery) => delivery.markerId === markerId) ?? null;
}

export function savePendingGitReviewDelivery(
  delivery: PendingGitReviewDelivery,
  storage = browserStorage(),
): void {
  if (!storage) throw new Error("Review target storage is unavailable in this browser.");
  const deliveries = loadPendingGitReviewDeliveries(storage).filter((item) => item.markerId !== delivery.markerId);
  deliveries.push(delivery);
  storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(deliveries.slice(-PENDING_DELIVERY_LIMIT)));
}

export function removePendingGitReviewDelivery(markerId: string, storage = browserStorage()): void {
  if (!storage) return;
  const deliveries = loadPendingGitReviewDeliveries(storage).filter((item) => item.markerId !== markerId);
  storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(deliveries));
}

export function parseGitReviewTarget(value: unknown): GitReviewTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const codex = record.foregroundCodex;
  if (typeof codex !== "object" || codex === null) return null;
  const process = codex as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !record.sessionId
    || typeof record.paneId !== "string" || !/^%\d+$/.test(record.paneId)
    || typeof record.gitRoot !== "string" || !record.gitRoot
    || !Number.isSafeInteger(process.pid) || Number(process.pid) < 1
    || typeof process.startedAt !== "string" || !process.startedAt
    || typeof process.command !== "string" || process.command.toLowerCase() !== "codex") return null;
  return {
    sessionId: record.sessionId,
    paneId: record.paneId,
    gitRoot: record.gitRoot,
    foregroundCodex: { pid: Number(process.pid), startedAt: process.startedAt, command: "codex" },
  };
}

export function sameGitReviewTarget(left: GitReviewTarget, right: GitReviewTarget): boolean {
  return left.sessionId === right.sessionId
    && left.paneId === right.paneId
    && left.gitRoot === right.gitRoot
    && left.foregroundCodex.pid === right.foregroundCodex.pid
    && left.foregroundCodex.startedAt === right.foregroundCodex.startedAt
    && left.foregroundCodex.command === right.foregroundCodex.command;
}

function parseComment(value: unknown): GitReviewComment | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const anchor = parseAnchor(record.anchor);
  if (!anchor || typeof record.id !== "string" || !record.id
    || typeof record.text !== "string" || record.text.length > COMMENT_TEXT_LIMIT
    || typeof record.selected !== "boolean"
    || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) return null;
  return {
    id: record.id,
    anchor,
    text: record.text,
    selected: record.selected,
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
  };
}

function parseAnchor(value: unknown): GitReviewAnchor | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const validLine = (line: unknown): line is number | null => line === null
    || (Number.isSafeInteger(line) && Number(line) > 0);
  if (typeof record.path !== "string" || !record.path
    || (record.kind !== "context" && record.kind !== "add" && record.kind !== "delete" && record.kind !== "text" && record.kind !== "range")
    || !(record.oldPath === null || typeof record.oldPath === "string")
    || !validLine(record.oldLine) || !validLine(record.newLine)
    || (record.side !== "old" && record.side !== "new")
    || (record.side === "old" && record.oldLine === null)
    || (record.side === "new" && record.newLine === null)
    || typeof record.snippet !== "string" || new TextEncoder().encode(record.snippet).byteLength > (record.kind === "range" ? MAX_REVIEW_RANGE_BYTES : 2_048)
    || typeof record.noNewline !== "boolean"
    || typeof record.headCommit !== "string") return null;
  const oldEnd = record.oldEndLine; const newEnd = record.newEndLine;
  if ((oldEnd !== undefined && (!validLine(oldEnd) || oldEnd === null || record.oldLine === null || oldEnd < record.oldLine))
    || (newEnd !== undefined && (!validLine(newEnd) || newEnd === null || record.newLine === null || newEnd < record.newLine))) return null;
  if (record.kind === "range") {
    const first = record.side === "old" ? record.oldLine : record.newLine;
    const last = record.side === "old" ? oldEnd : newEnd;
    if (typeof first !== "number" || typeof last !== "number" || last - first + 1 > MAX_REVIEW_RANGE_LINES
      || record.snippet.split("\n").length !== last - first + 1) return null;
  }
  return {
    path: record.path,
    oldPath: record.oldPath,
    kind: record.kind,
    oldLine: record.oldLine,
    newLine: record.newLine,
    ...(typeof oldEnd === "number" ? { oldEndLine: oldEnd } : {}),
    ...(typeof newEnd === "number" ? { newEndLine: newEnd } : {}),
    side: record.side,
    snippet: record.snippet,
    noNewline: record.noNewline,
    headCommit: record.headCommit,
  };
}

function parseDelivery(value: unknown): PendingGitReviewDelivery | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const target = parseGitReviewTarget(record.target);
  if (typeof record.markerId !== "string" || !record.markerId || !target
    || !Array.isArray(record.anchors) || record.anchors.length < 1
    || typeof record.reviewText !== "string" || !Number.isFinite(record.createdAt)) return null;
  const anchors = record.anchors.map(parseAnchor);
  if (anchors.some((anchor) => anchor === null)) return null;
  return {
    markerId: record.markerId,
    target,
    anchors: anchors as GitReviewAnchor[],
    reviewText: record.reviewText,
    createdAt: Number(record.createdAt),
  };
}

function browserStorage(): ReviewStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function longestRun(value: string, character: string): number {
  return Math.max(0, ...[...value.matchAll(new RegExp(`${character}+`, "g"))].map((match) => match[0].length));
}
