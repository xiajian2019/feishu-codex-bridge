export interface ForegroundCodexIdentity {
  pid: number;
  startedAt: string;
  command: string;
}

export interface TmuxReviewTarget {
  sessionId: string;
  paneId: string;
  gitRoot: string;
  foregroundCodex: ForegroundCodexIdentity;
}

export interface TmuxReviewAnchor {
  path: string;
  oldPath: string | null;
  oldLine: number | null;
  newLine: number | null;
  side: "old" | "new";
  snippet: string;
  noNewline: boolean;
}

export function parseTmuxReviewAnchor(value: unknown): TmuxReviewAnchor | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const isLine = (line: unknown): line is number | null => line === null
    || (Number.isSafeInteger(line) && Number(line) > 0);
  if (typeof record.path !== "string" || !record.path || record.path.includes("\0")
    || !(record.oldPath === null || typeof record.oldPath === "string")
    || !isLine(record.oldLine) || !isLine(record.newLine)
    || (record.side !== "old" && record.side !== "new")
    || (record.side === "old" && record.oldLine === null)
    || (record.side === "new" && record.newLine === null)
    || typeof record.snippet !== "string" || Buffer.byteLength(record.snippet, "utf8") > 2_048
    || typeof record.noNewline !== "boolean") return null;
  return {
    path: record.path,
    oldPath: record.oldPath,
    oldLine: record.oldLine,
    newLine: record.newLine,
    side: record.side,
    snippet: record.snippet,
    noNewline: record.noNewline,
  };
}

export interface TmuxReviewDiffLine {
  kind: "context" | "add" | "delete";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noNewline: boolean;
}

export interface TmuxReviewCurrentContext {
  sessionExists: boolean;
  sessionId: string;
  paneId: string | null;
  gitRoot: string | null;
  foregroundCodex: ForegroundCodexIdentity | null;
}

export function parseTmuxReviewTarget(value: unknown): TmuxReviewTarget | null {
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
    foregroundCodex: {
      pid: Number(process.pid),
      startedAt: process.startedAt,
      command: "codex",
    },
  };
}

export function sameTmuxReviewTarget(left: TmuxReviewTarget, right: TmuxReviewTarget): boolean {
  return left.sessionId === right.sessionId
    && left.paneId === right.paneId
    && left.gitRoot === right.gitRoot
    && left.foregroundCodex.pid === right.foregroundCodex.pid
    && left.foregroundCodex.startedAt === right.foregroundCodex.startedAt
    && left.foregroundCodex.command === right.foregroundCodex.command;
}

export function tmuxReviewTargetMismatch(
  expectedValue: unknown,
  current: TmuxReviewCurrentContext,
): string | null {
  const expected = parseTmuxReviewTarget(expectedValue);
  if (!expected) return "Review target is invalid. Reopen Git changes and try again.";
  if (!current.sessionExists) return "The original tmux session no longer exists.";
  if (current.sessionId !== expected.sessionId) return "The review belongs to a different tmux session.";
  if (!current.paneId) return "The original tmux pane is unavailable.";
  if (current.paneId !== expected.paneId) return "The active tmux pane changed while this review was open.";
  if (!current.gitRoot) return "The original Git repository is unavailable.";
  if (current.gitRoot !== expected.gitRoot) return "The session now points to a different Git repository.";
  if (!current.foregroundCodex) return "Codex is not running in the original pane.";
  if (current.foregroundCodex.pid !== expected.foregroundCodex.pid
    || current.foregroundCodex.startedAt !== expected.foregroundCodex.startedAt
    || current.foregroundCodex.command !== expected.foregroundCodex.command) {
    return "The foreground Codex process changed while this review was open.";
  }
  return null;
}

export function parseTmuxReviewDiffLines(patch: string): TmuxReviewDiffLine[] {
  const result: TmuxReviewDiffLine[] = [];
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

export function reviewAnchorMismatch(
  anchor: TmuxReviewAnchor,
  files: Array<{ path: string; oldPath: string | null; status: string }>,
  patch: string,
  untrackedText?: string,
): string | null {
  const file = files.find((candidate) => candidate.path === anchor.path);
  if (!file) {
    if (files.some((candidate) => candidate.oldPath === anchor.path)) return "The reviewed file was renamed.";
    return "The reviewed file is no longer a Git change.";
  }

  if (file.status === "untracked") {
    if (untrackedText === undefined) return "The untracked file could not be rechecked.";
    if (anchor.side !== "new" || anchor.newLine === null || anchor.oldLine !== null) {
      return "The untracked file anchor is invalid.";
    }
    const lines = untrackedText.split(/\r?\n/);
    if (untrackedText.endsWith("\n")) lines.pop();
    const currentLine = lines[anchor.newLine - 1];
    if (currentLine === undefined || currentLine !== anchor.snippet) return "The reviewed line changed or moved.";
    const noNewline = anchor.newLine === lines.length && !untrackedText.endsWith("\n");
    return noNewline === anchor.noNewline ? null : "The reviewed line's newline state changed.";
  }
  const filePatch = findReviewFilePatch(patch, file.path, file.oldPath);
  if (!filePatch) return "The reviewed file no longer has a text diff.";

  const current = parseTmuxReviewDiffLines(filePatch).find((line) =>
    line.oldLine === anchor.oldLine && line.newLine === anchor.newLine
    && (anchor.side === "old" ? line.kind !== "add" : line.kind !== "delete"));
  if (!current) return "The reviewed line changed or moved.";
  if (current.text !== anchor.snippet) return "The reviewed line changed or moved.";
  if (current.noNewline !== anchor.noNewline) return "The reviewed line's newline state changed.";
  return null;
}

function findReviewFilePatch(patch: string, path: string, oldPath: string | null): string | null {
  const sections = patch.split(/(?=^diff --git )/m).filter((section) => section.trim());
  for (const section of sections) {
    let oldFile: string | null = null;
    let newFile: string | null = null;
    for (const line of section.split(/\r?\n/)) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("--- ")) oldFile = decodeGitPatchPath(line.slice(4));
      else if (line.startsWith("+++ ")) newFile = decodeGitPatchPath(line.slice(4));
    }
    if (oldFile === path || newFile === path || (oldPath !== null && (oldFile === oldPath || newFile === oldPath))) {
      return section;
    }
  }
  return null;
}

function decodeGitPatchPath(value: string): string | null {
  const raw = value.split("\t", 1)[0]!.trim();
  let path = raw;
  if (raw.startsWith('"')) {
    try { path = JSON.parse(raw) as string; } catch { return null; }
  }
  if (path === "/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}
