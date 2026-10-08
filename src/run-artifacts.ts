import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STATUS_OUTPUT_BYTES = 64 * 1024;
const MAX_STATUS_OUTPUT_BYTES = 256 * 1024;
const MAX_GIT_METADATA_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_PATHS = 100;
const MAX_PATHS = 500;
const MAX_PATH_LENGTH = 1_024;
const MAX_PATH_SEGMENTS = 32;
const DEFAULT_MAX_FINGERPRINT_FILES = 40;
const MAX_FINGERPRINT_FILES = 100;
const DEFAULT_MAX_FINGERPRINT_FILE_BYTES = 1_048_576;
const MAX_FINGERPRINT_FILE_BYTES = 4_194_304;
const DEFAULT_MAX_FINGERPRINT_TOTAL_BYTES = 8_388_608;
const MAX_FINGERPRINT_TOTAL_BYTES = 16_777_216;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const ATTRIBUTION_NOTE = "This is a shared-workspace snapshot; changed paths cannot be attributed to one task.";

export type WorkspaceFileFingerprintReason =
  | "unsafe-path"
  | "symlink"
  | "outside-repository"
  | "non-directory-parent"
  | "not-regular-file"
  | "safe-open-unavailable"
  | "file-too-large"
  | "byte-budget-exceeded"
  | "file-limit-reached"
  | "not-found"
  | "unreadable"
  | "changed-during-read";

export interface WorkspaceFileFingerprint {
  path: string;
  status: "hashed" | "omitted" | "unsafe";
  sizeBytes: number | null;
  sha256?: string;
  reason?: WorkspaceFileFingerprintReason;
}

export interface GitWorkspaceSnapshot {
  capturedAt: string;
  isGitRepository: boolean;
  headCommit: string | null;
  dirtyPaths: string[];
  untrackedPaths: string[];
  /** Legacy snapshots may not include bounded file fingerprints. */
  fileFingerprints?: WorkspaceFileFingerprint[];
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
  /** Maximum changed files to read and hash. Values are clamped to 1–100. */
  maxFingerprintFiles?: number;
  /** Maximum bytes read from any one changed file. Values are clamped to 1 byte–4 MiB. */
  maxFingerprintFileBytes?: number;
  /** Maximum total bytes read for fingerprints in one snapshot. Values are clamped to 1 byte–16 MiB. */
  maxFingerprintTotalBytes?: number;
}

interface GitCommandResult {
  stdout: Buffer;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitReached: boolean;
}

/**
 * Collect bounded Git metadata and file fingerprints only. File bytes are streamed into
 * SHA-256 and never stored or returned. Paths that could escape the repository are rejected.
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
  const maxFingerprintFiles = boundedInteger(options.maxFingerprintFiles, DEFAULT_MAX_FINGERPRINT_FILES, 1, MAX_FINGERPRINT_FILES);
  const maxFingerprintFileBytes = boundedInteger(
    options.maxFingerprintFileBytes,
    DEFAULT_MAX_FINGERPRINT_FILE_BYTES,
    1,
    MAX_FINGERPRINT_FILE_BYTES,
  );
  const maxFingerprintTotalBytes = boundedInteger(
    options.maxFingerprintTotalBytes,
    DEFAULT_MAX_FINGERPRINT_TOTAL_BYTES,
    1,
    MAX_FINGERPRINT_TOTAL_BYTES,
  );
  const base = {
    capturedAt,
    headCommit: null,
    dirtyPaths: [] as string[],
    untrackedPaths: [] as string[],
    fileFingerprints: [] as WorkspaceFileFingerprint[],
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
  const changedPaths = [...paths.dirtyPaths, ...paths.untrackedPaths];
  const fileFingerprints = await captureFileFingerprints(repositoryRoot, changedPaths, {
    maxFiles: maxFingerprintFiles,
    maxFileBytes: maxFingerprintFileBytes,
    maxTotalBytes: maxFingerprintTotalBytes,
  });

  return {
    ...base,
    isGitRepository: true,
    headCommit: validHead,
    dirtyPaths: paths.dirtyPaths,
    untrackedPaths: paths.untrackedPaths,
    fileFingerprints,
    truncated: paths.truncated
      || headResult.timedOut
      || headResult.outputLimitReached
      || statusResult.timedOut
      || statusResult.outputLimitReached
      || statusResult.exitCode !== 0,
  };
}

async function captureFileFingerprints(
  repositoryRoot: string,
  paths: string[],
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
): Promise<WorkspaceFileFingerprint[]> {
  const fingerprints: WorkspaceFileFingerprint[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(repositoryRoot);
  } catch {
    return paths.map((path) => ({ path, status: "omitted", sizeBytes: null, reason: "unreadable" }));
  }

  let bytesRead = 0;
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]!;
    if (index >= limits.maxFiles) {
      fingerprints.push({ path, status: "omitted", sizeBytes: null, reason: "file-limit-reached" });
      continue;
    }
    const fingerprint = await fingerprintWorkspaceFile(canonicalRoot, path, {
      maxFileBytes: limits.maxFileBytes,
      remainingBytes: limits.maxTotalBytes - bytesRead,
    });
    bytesRead += fingerprint.bytesRead;
    fingerprints.push(fingerprint.entry);
  }
  return fingerprints;
}

async function fingerprintWorkspaceFile(
  canonicalRoot: string,
  path: string,
  limits: { maxFileBytes: number; remainingBytes: number },
): Promise<{ entry: WorkspaceFileFingerprint; bytesRead: number }> {
  if (!isSafeRepositoryPath(path)) {
    return { entry: { path, status: "unsafe", sizeBytes: null, reason: "unsafe-path" }, bytesRead: 0 };
  }

  const parts = path.split("/");
  if (parts.length > MAX_PATH_SEGMENTS) {
    return { entry: { path, status: "unsafe", sizeBytes: null, reason: "unsafe-path" }, bytesRead: 0 };
  }
  let current = canonicalRoot;
  let finalStat: Awaited<ReturnType<typeof lstat>> | null = null;
  let bytesConsumed = 0;
  try {
    for (const [index, segment] of parts.entries()) {
      const candidate = resolve(current, segment);
      if (!isWithinRoot(canonicalRoot, candidate)) {
        return { entry: { path, status: "unsafe", sizeBytes: null, reason: "outside-repository" }, bytesRead: 0 };
      }
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        return { entry: { path, status: "unsafe", sizeBytes: null, reason: "symlink" }, bytesRead: 0 };
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        return { entry: { path, status: "unsafe", sizeBytes: null, reason: "non-directory-parent" }, bytesRead: 0 };
      }
      if (index === parts.length - 1 && !stat.isFile()) {
        return { entry: { path, status: "unsafe", sizeBytes: null, reason: "not-regular-file" }, bytesRead: 0 };
      }
      const canonicalCandidate = await realpath(candidate);
      if (!isWithinRoot(canonicalRoot, canonicalCandidate)) {
        return { entry: { path, status: "unsafe", sizeBytes: null, reason: "outside-repository" }, bytesRead: 0 };
      }
      current = canonicalCandidate;
      if (index === parts.length - 1) finalStat = stat;
    }
  } catch (error) {
    const code = getFileErrorCode(error);
    return {
      entry: { path, status: "omitted", sizeBytes: null, reason: code === "ENOENT" ? "not-found" : "unreadable" },
      bytesRead: 0,
    };
  }

  const sizeBytes = finalStat ? toSafeSize(finalStat.size) : null;
  if (finalStat && finalStat.size > limits.maxFileBytes) {
    return { entry: { path, status: "omitted", sizeBytes, reason: "file-too-large" }, bytesRead: 0 };
  }
  if (finalStat && finalStat.size > limits.remainingBytes) {
    return { entry: { path, status: "omitted", sizeBytes, reason: "byte-budget-exceeded" }, bytesRead: 0 };
  }
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    return { entry: { path, status: "unsafe", sizeBytes, reason: "safe-open-unavailable" }, bytesRead: 0 };
  }

  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    // O_NONBLOCK prevents a regular-file-to-FIFO swap between lstat and open from
    // stalling the dispatcher. It has no effect on regular-file reads.
    file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const openedStat = await file.stat();
    const openedPath = await realpath(current);
    const openedPathStat = await lstat(current);
    if (!isWithinRoot(canonicalRoot, openedPath)) {
      return { entry: { path, status: "unsafe", sizeBytes: null, reason: "outside-repository" }, bytesRead: 0 };
    }
    if (openedPathStat.isSymbolicLink()) {
      return { entry: { path, status: "unsafe", sizeBytes: null, reason: "symlink" }, bytesRead: 0 };
    }
    if (!openedStat.isFile()) {
      return { entry: { path, status: "unsafe", sizeBytes: null, reason: "not-regular-file" }, bytesRead: 0 };
    }
    if (openedPathStat.dev !== openedStat.dev || openedPathStat.ino !== openedStat.ino) {
      return { entry: { path, status: "unsafe", sizeBytes: null, reason: "symlink" }, bytesRead: 0 };
    }
    if (!finalStat || openedStat.dev !== finalStat.dev || openedStat.ino !== finalStat.ino) {
      return { entry: { path, status: "omitted", sizeBytes: toSafeSize(openedStat.size), reason: "changed-during-read" }, bytesRead: 0 };
    }
    const openedSize = openedStat.size;
    if (openedSize > limits.maxFileBytes) {
      return { entry: { path, status: "omitted", sizeBytes: toSafeSize(openedSize), reason: "file-too-large" }, bytesRead: 0 };
    }
    if (openedSize > limits.remainingBytes) {
      return { entry: { path, status: "omitted", sizeBytes: toSafeSize(openedSize), reason: "byte-budget-exceeded" }, bytesRead: 0 };
    }

    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.max(1, Math.min(FILE_READ_CHUNK_BYTES, openedSize)));
    let offset = 0;
    while (offset < openedSize) {
      const requested = Math.min(buffer.length, openedSize - offset);
      const { bytesRead } = await file.read(buffer, 0, requested, offset);
      if (bytesRead === 0) {
        return { entry: { path, status: "omitted", sizeBytes: toSafeSize(openedSize), reason: "changed-during-read" }, bytesRead: offset };
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      bytesConsumed = offset;
    }

    const afterStat = await file.stat();
    const pathStat = await lstat(current);
    const canonicalPath = await realpath(current);
    const changed = openedStat.size !== afterStat.size
      || openedStat.mtimeMs !== afterStat.mtimeMs
      || openedStat.ctimeMs !== afterStat.ctimeMs
      || openedStat.dev !== afterStat.dev
      || openedStat.ino !== afterStat.ino
      || pathStat.isSymbolicLink()
      || pathStat.dev !== openedStat.dev
      || pathStat.ino !== openedStat.ino
      || !isWithinRoot(canonicalRoot, canonicalPath);
    if (changed) {
      return { entry: { path, status: "omitted", sizeBytes: toSafeSize(openedSize), reason: "changed-during-read" }, bytesRead: offset };
    }

    return {
      entry: { path, status: "hashed", sizeBytes: toSafeSize(openedSize), sha256: hash.digest("hex") },
      bytesRead: offset,
    };
  } catch (error) {
    const code = getFileErrorCode(error);
    const unsafe = code === "ELOOP";
    return {
      entry: { path, status: unsafe ? "unsafe" : "omitted", sizeBytes, reason: unsafe ? "symlink" : code === "ENOENT" ? "not-found" : "unreadable" },
      bytesRead: bytesConsumed,
    };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function toSafeSize(size: number): number | null {
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function getFileErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
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
