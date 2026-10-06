import { spawn } from "node:child_process";
import { resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STATUS_OUTPUT_BYTES = 64 * 1024;
const MAX_STATUS_OUTPUT_BYTES = 256 * 1024;
const MAX_GIT_METADATA_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_PATHS = 100;
const MAX_PATHS = 500;
const MAX_PATH_LENGTH = 1_024;
const ATTRIBUTION_NOTE = "This is a shared-workspace snapshot; changed paths cannot be attributed to one task.";

export interface GitWorkspaceSnapshot {
  capturedAt: string;
  isGitRepository: boolean;
  headCommit: string | null;
  dirtyPaths: string[];
  untrackedPaths: string[];
  truncated: boolean;
  taskAttribution: "unattributed-shared-workspace";
  attributionNote: string;
}

export interface GitWorkspaceSnapshotOptions {
  /** Per-command timeout. Values are clamped to 25 ms–5 seconds. */
  timeoutMs?: number;
  /** Maximum bytes read from `git status`. Values are clamped to 1 KiB–256 KiB. */
  maxStatusOutputBytes?: number;
  /** Maximum number of returned paths across both path lists. Values are clamped to 1–500. */
  maxPaths?: number;
}

interface GitCommandResult {
  stdout: Buffer;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitReached: boolean;
}

/**
 * Collect bounded Git metadata only. This never opens or returns file contents.
 * Paths are repository-relative and rejected if they could escape the repository.
 */
export async function captureGitWorkspaceSnapshot(
  directory: string,
  options: GitWorkspaceSnapshotOptions = {},
): Promise<GitWorkspaceSnapshot> {
  const capturedAt = new Date().toISOString();
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 25, MAX_TIMEOUT_MS);
  const maxStatusOutputBytes = boundedInteger(
    options.maxStatusOutputBytes,
    DEFAULT_MAX_STATUS_OUTPUT_BYTES,
    1_024,
    MAX_STATUS_OUTPUT_BYTES,
  );
  const maxPaths = boundedInteger(options.maxPaths, DEFAULT_MAX_PATHS, 1, MAX_PATHS);
  const base = {
    capturedAt,
    headCommit: null,
    dirtyPaths: [] as string[],
    untrackedPaths: [] as string[],
    truncated: false,
    taskAttribution: "unattributed-shared-workspace" as const,
    attributionNote: ATTRIBUTION_NOTE,
  };

  const rootResult = await runGit(directory, ["rev-parse", "--show-toplevel"], {
    timeoutMs,
    maxOutputBytes: MAX_GIT_METADATA_OUTPUT_BYTES,
  });
  const repositoryRoot = rootResult.exitCode === 0 && !rootResult.outputLimitReached
    ? decodeSingleLine(rootResult.stdout)
    : null;
  if (!repositoryRoot) {
    return {
      ...base,
      isGitRepository: false,
      truncated: rootResult.timedOut || rootResult.outputLimitReached,
    };
  }

  const [headResult, statusResult] = await Promise.all([
    runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], {
      timeoutMs,
      maxOutputBytes: MAX_GIT_METADATA_OUTPUT_BYTES,
    }),
    runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"], {
      timeoutMs,
      maxOutputBytes: maxStatusOutputBytes,
    }),
  ]);

  const headCommit = headResult.exitCode === 0 && !headResult.outputLimitReached
    ? decodeSingleLine(headResult.stdout)
    : null;
  const validHead = headCommit && /^[0-9a-f]{40,64}$/i.test(headCommit) ? headCommit : null;
  const paths = parseStatusPaths(statusResult.stdout, maxPaths);

  return {
    ...base,
    isGitRepository: true,
    headCommit: validHead,
    dirtyPaths: paths.dirtyPaths,
    untrackedPaths: paths.untrackedPaths,
    truncated: paths.truncated
      || headResult.timedOut
      || headResult.outputLimitReached
      || statusResult.timedOut
      || statusResult.outputLimitReached
      || statusResult.exitCode !== 0,
  };
}

function runGit(
  cwd: string,
  args: string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let outputLimitReached = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
      cwd: resolve(cwd),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        exitCode,
        timedOut,
        outputLimitReached,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || outputLimitReached) return;
      const remaining = limits.maxOutputBytes - stdoutBytes;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        stdoutChunks.push(accepted);
        stdoutBytes += accepted.length;
      }
      if (chunk.length > remaining) {
        outputLimitReached = true;
        stopChild();
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (exitCode) => finish(exitCode));

    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, limits.timeoutMs);
    timer.unref?.();

    function stopChild(): void {
      if (!child.kill("SIGTERM")) return;
      killTimer = setTimeout(() => child.kill("SIGKILL"), 100);
      killTimer.unref?.();
    }
  });
}

function parseStatusPaths(stdout: Buffer, maxPaths: number): {
  dirtyPaths: string[];
  untrackedPaths: string[];
  truncated: boolean;
} {
  const dirtyPaths: string[] = [];
  const untrackedPaths: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let truncated = false;
  let offset = 0;

  while (offset < stdout.length) {
    const terminator = stdout.indexOf(0, offset);
    if (terminator < 0) {
      truncated = true;
      break;
    }
    const record = stdout.subarray(offset, terminator);
    offset = terminator + 1;
    if (record.length < 4 || record[2] !== 0x20) {
      truncated = true;
      continue;
    }

    let path: string;
    try {
      path = decoder.decode(record.subarray(3));
    } catch {
      truncated = true;
      continue;
    }
    if (!isSafeRepositoryPath(path)) {
      truncated = true;
      continue;
    }
    if (dirtyPaths.length + untrackedPaths.length >= maxPaths) {
      truncated = true;
      break;
    }
    const status = `${String.fromCharCode(record[0]!)}${String.fromCharCode(record[1]!)}`;
    (status === "??" ? untrackedPaths : dirtyPaths).push(path);
  }

  dirtyPaths.sort();
  untrackedPaths.sort();
  return { dirtyPaths, untrackedPaths, truncated };
}

function isSafeRepositoryPath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH || path.startsWith("/") || path.includes("\\")) return false;
  if (/^[a-z]:/i.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function decodeSingleLine(value: Buffer): string | null {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    const line = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
    return line && !/[\u0000-\u001f\u007f]/u.test(line) ? line : null;
  } catch {
    return null;
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}
