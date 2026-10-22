import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { StoredTaskWorkspace } from "./types.js";
import { fallbackTaskFeatureName } from "./task-feature-name.js";

const GIT_COMMAND_TIMEOUT_MS = 20_000;
const GIT_OUTPUT_LIMIT_BYTES = 1_048_576;
const GIT_CHANGE_PATCH_LIMIT_BYTES = 512 * 1024;
const MAX_UNTRACKED_FILE_PATCH_BYTES = 256 * 1024;
const LOCK_TIMEOUT_MS = 15_000;

export const TASK_BASE_REF = "master";

export class GitWorkspaceError extends Error {
  constructor(message: string, public readonly statusCode = 422) {
    super(message);
    this.name = "GitWorkspaceError";
  }
}

export interface PreparedTaskWorkspace {
  workspaceId: string;
  taskGuid: string;
  projectKey: string;
  projectRoot: string;
  projectGitRoot: string;
  gitCommonDirectory: string;
  workingDirectory: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  sourceSha: string;
  sourceTmuxSessionId: string | null;
}

export interface GitWorktreeEntry {
  path: string;
  branch: string | null;
  commit: string | null;
  detached: boolean;
  prunable: boolean;
}

export interface TaskWorkspaceInspection {
  exists: boolean;
  currentBranch: string | null;
  headCommit: string | null;
  dirtyEntryCount: number;
  remoteBranches: string[];
  commitsAheadOfBase: number | null;
  mergedIntoBase: boolean | null;
  error: string | null;
}

export interface TaskSourceInspection {
  directory: string;
  gitRoot: string;
  branch: string | null;
  baseSha: string;
  targetBaseRef: string;
  targetBaseSha: string;
  dirtyEntryCount: number;
}

export interface UnmanagedWorktreeInspection {
  exists: boolean;
  currentBranch: string | null;
  headCommit: string | null;
  dirtyEntryCount: number;
  remoteBranches: string[];
  baseRef: string | null;
  commitsAheadOfBase: number | null;
  mergedIntoBase: boolean | null;
  error: string | null;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function prepareTaskWorkspace(input: {
  workspaceRoot: string;
  workspaceId: string;
  taskGuid: string;
  projectKey: string;
  projectRoot: string;
  summary: string;
  featureName?: string;
  sourceDirectory?: string;
  sourceTmuxSessionId?: string;
}): Promise<PreparedTaskWorkspace> {
  const projectRoot = await canonicalDirectory(input.projectRoot, "registered project");
  const projectGitRoot = await gitRoot(projectRoot);
  const sourceDirectory = await canonicalDirectory(input.sourceDirectory ?? projectRoot, "task source");
  const sourceGitRoot = await gitRoot(sourceDirectory);
  const projectCommonDir = await gitCommonDirectory(projectGitRoot);
  const sourceCommonDir = await gitCommonDirectory(sourceGitRoot);
  if (projectCommonDir !== sourceCommonDir) {
    throw new GitWorkspaceError("当前 Session 目录不属于所选登记项目的 Git 仓库。");
  }

  const status = await git(sourceDirectory, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all",
  ]);
  if (status.exitCode !== 0) throw gitFailure("无法读取任务源目录的 Git 状态", status);
  const dirtyEntries = status.stdout.split("\0").filter(Boolean);
  if (dirtyEntries.length > 0) {
    throw new GitWorkspaceError(`任务源目录有 ${dirtyEntries.length} 项未提交改动；新 worktree 只会从 HEAD 创建，不会复制这些改动。`);
  }

  const sourceResult = await git(sourceDirectory, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (sourceResult.exitCode !== 0) throw gitFailure("任务源目录没有可用的 Git 提交", sourceResult);
  const sourceSha = singleLine(sourceResult.stdout);
  if (!/^[a-f\d]{40,64}$/i.test(sourceSha)) throw new GitWorkspaceError("无法确认任务源目录的当前提交。");

  const { baseRef, baseSha } = await resolveTaskBase(projectGitRoot);
  const rootDirectory = await ensureWorkspaceRoot(input.workspaceRoot, projectGitRoot);
  const projectSlug = slug(input.projectKey, 36) || "project";
  const featureName = fallbackTaskFeatureName(input.featureName ?? input.summary) || "task";
  const shortFeatureName = featureName.split("-").slice(0, 2).join("-") || "task";
  const worktreeParent = resolve(rootDirectory, projectSlug);
  await mkdir(worktreeParent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(worktreeParent);
  if (!isPathInside(rootDirectory, canonicalParent)) {
    throw new GitWorkspaceError("worktree 根目录中的符号链接越过了配置目录。");
  }
  const branchBase = `xiajian/agent/${featureName}`;
  let branch = branchBase;
  let worktreePath = resolve(canonicalParent, `wt-${shortFeatureName}`);
  let suffix = 2;
  while (await branchExists(projectGitRoot, branch) || await pathExists(worktreePath)) {
    branch = `${branchBase}-${suffix}`;
    worktreePath = resolve(canonicalParent, `wt-${shortFeatureName}-${suffix}`);
    suffix += 1;
  }
  if (!isPathInside(canonicalParent, worktreePath)) throw new GitWorkspaceError("计算出的 worktree 路径无效。");
  const format = await git(projectGitRoot, ["check-ref-format", "--branch", branch]);
  if (format.exitCode !== 0) throw new GitWorkspaceError("任务描述无法生成有效的 Git 分支名。");

  const relativeWorkingDirectory = relative(sourceGitRoot, sourceDirectory);
  if (relativeWorkingDirectory.startsWith(`..${sep}`) || relativeWorkingDirectory === ".." || isAbsolute(relativeWorkingDirectory)) {
    throw new GitWorkspaceError("任务目录不在 Git 仓库内部。");
  }
  const workingDirectory = relativeWorkingDirectory ? resolve(worktreePath, relativeWorkingDirectory) : worktreePath;

  return {
    workspaceId: input.workspaceId,
    taskGuid: input.taskGuid,
    projectKey: input.projectKey,
    projectRoot,
    projectGitRoot,
    gitCommonDirectory: projectCommonDir,
    workingDirectory,
    worktreePath,
    branch,
    baseRef,
    baseSha,
    sourceSha,
    sourceTmuxSessionId: input.sourceTmuxSessionId ?? null,
  };
}

export async function inspectTaskSourceDirectory(directory: string): Promise<TaskSourceInspection> {
  const canonicalDirectoryPath = await canonicalDirectory(directory, "task source");
  const repositoryRoot = await gitRoot(canonicalDirectoryPath);
  const [head, branch, status] = await Promise.all([
    git(canonicalDirectoryPath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(canonicalDirectoryPath, ["branch", "--show-current"]),
    git(canonicalDirectoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
  ]);
  if (head.exitCode !== 0 || status.exitCode !== 0) throw new GitWorkspaceError("无法读取当前 Session 的 Git 状态。");
  const sourceSha = singleLine(head.stdout);
  if (!/^[a-f\d]{40,64}$/i.test(sourceSha)) throw new GitWorkspaceError("当前 Session 没有可用的 Git 提交。");
  const targetBase = await resolveTaskBase(repositoryRoot);
  return {
    directory: canonicalDirectoryPath,
    gitRoot: repositoryRoot,
    branch: branch.exitCode === 0 ? singleLine(branch.stdout) || null : null,
    // Keep baseSha as the source HEAD used by the existing Tmux submit API.
    // The actual worktree base is exposed separately so the UI cannot confuse
    // the optimistic source snapshot with the branch used for creation.
    baseSha: sourceSha,
    targetBaseRef: targetBase.baseRef,
    targetBaseSha: targetBase.baseSha,
    dirtyEntryCount: status.stdout.split("\0").filter(Boolean).length,
  };
}

export function defaultTaskWorktreeRoot(): string {
  return resolve(homedir(), ".codex", "worktrees");
}

export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";

export interface GitChangeFile {
  path: string;
  oldPath: string | null;
  status: GitChangeStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface GitChangesInspection {
  directory: string;
  gitRoot: string;
  branch: string | null;
  headCommit: string;
  files: GitChangeFile[];
  patch: string;
  patchTruncated: boolean;
}

export async function inspectGitChanges(directory: string): Promise<GitChangesInspection> {
  const canonicalDirectoryPath = await canonicalDirectory(directory, "当前 Session 目录");
  const repositoryRoot = await gitRoot(canonicalDirectoryPath);
  const [head, branch, status] = await Promise.all([
    git(canonicalDirectoryPath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(canonicalDirectoryPath, ["branch", "--show-current"]),
    git(canonicalDirectoryPath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]),
  ]);
  if (head.exitCode !== 0 || status.exitCode !== 0) throw new GitWorkspaceError("无法读取当前 Session 的 Git 状态。");
  const headCommit = singleLine(head.stdout);
  if (!/^[a-f\d]{40,64}$/i.test(headCommit)) throw new GitWorkspaceError("当前 Session 没有可用的 Git 提交。");
  const files = parseGitStatusPorcelain(status.stdout);
  let patch = "";
  let patchTruncated = false;
  try {
    const diff = await git(canonicalDirectoryPath, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--"]);
    if (diff.exitCode !== 0) throw gitFailure("无法读取 Git 变更", diff);
    patch = diff.stdout;
  } catch (error) {
    if (!(error instanceof GitWorkspaceError) || !error.message.includes("输出超过安全上限")) throw error;
    patchTruncated = true;
  }
  if (Buffer.byteLength(patch, "utf8") > GIT_CHANGE_PATCH_LIMIT_BYTES) {
    patch = truncateUtf8(patch, GIT_CHANGE_PATCH_LIMIT_BYTES);
    patchTruncated = true;
  }
  for (const file of files.filter((candidate) => candidate.status === "untracked")) {
    if (patchTruncated) break;
    const extra = await untrackedFilePatch(repositoryRoot, file.path);
    if (!extra) continue;
    const next = patch ? patch + "\n" + extra : extra;
    if (Buffer.byteLength(next, "utf8") > GIT_CHANGE_PATCH_LIMIT_BYTES) {
      patchTruncated = true;
      break;
    }
    patch = next;
  }
  return {
    directory: canonicalDirectoryPath,
    gitRoot: repositoryRoot,
    branch: branch.exitCode === 0 ? singleLine(branch.stdout) || null : null,
    headCommit,
    files,
    patch,
    patchTruncated,
  };
}

async function untrackedFilePatch(repositoryRoot: string, path: string): Promise<string | null> {
  const absolutePath = resolve(repositoryRoot, path);
  if (!isPathInside(repositoryRoot, absolutePath)) return null;
  const info = await lstat(absolutePath).catch(() => null);
  if (!info?.isFile() || info.size > MAX_UNTRACKED_FILE_PATCH_BYTES) return null;
  const content = await readFile(absolutePath);
  if (content.includes(0)) return null;
  const lines = content.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const displayPath = path.replaceAll("\\", "/").replaceAll("\n", "\\n");
  const header = [
    "diff --git a/" + displayPath + " b/" + displayPath,
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/" + displayPath,
    "@@ -0,0 +1," + lines.length + " @@",
  ].join("\n");
  return header + "\n" + lines.map((line) => "+" + line).join("\n") + "\n";
}

function parseGitStatusPorcelain(output: string): GitChangeFile[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const indexCode = line[0] ?? " ";
    const worktreeCode = line[1] ?? " ";
    const rawPath = line.slice(3);
    const renameSeparator = rawPath.indexOf(" -> ");
    const hasRename = indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C";
    const oldPath = hasRename && renameSeparator >= 0 ? decodeGitStatusPath(rawPath.slice(0, renameSeparator)) : null;
    const path = decodeGitStatusPath(hasRename && renameSeparator >= 0 ? rawPath.slice(renameSeparator + 4) : rawPath);
    const status: GitChangeStatus = indexCode === "?" || worktreeCode === "?"
      ? "untracked"
      : indexCode === "D" || worktreeCode === "D"
        ? "deleted"
        : indexCode === "R" || worktreeCode === "R"
          ? "renamed"
          : indexCode === "C" || worktreeCode === "C"
            ? "copied"
            : indexCode === "A" || worktreeCode === "A"
              ? "added"
              : "modified";
    return {
      path,
      oldPath,
      status,
      staged: indexCode !== " " && indexCode !== "?" && indexCode !== "!",
      unstaged: indexCode === "?" || worktreeCode === "?"
        ? true
        : worktreeCode !== " " && worktreeCode !== "!",
    };
  });
}

function decodeGitStatusPath(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  try { return JSON.parse(value) as string; }
  catch { return value; }
}

function truncateUtf8(value: string, maxBytes: number): string {
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

export async function provisionTaskWorkspace(workspace: StoredTaskWorkspace): Promise<void> {
  if (workspace.status === "removed" || workspace.followups_closed_at) {
    throw new GitWorkspaceError("此任务工作区已归档或移除，不能重新创建。");
  }
  const projectGitRoot = await canonicalDirectory(workspace.project_git_root, "registered Git root");
  const commonDirectory = await gitCommonDirectory(projectGitRoot);
  await withGitMetadataLock(commonDirectory, async () => {
    const entries = await listGitWorktrees(projectGitRoot);
    const registered = entries.find((entry) => normalizePath(entry.path) === normalizePath(workspace.worktree_path));
    if (registered) {
      if (registered.branch !== workspace.branch) {
        throw new GitWorkspaceError("已存在同路径的 worktree，但分支与任务记录不符；为保护现场，未修改它。", 409);
      }
  await verifyWorkspaceRoot(workspace, commonDirectory);
      return;
    }
    if (await pathExists(workspace.worktree_path)) {
      throw new GitWorkspaceError("任务 worktree 路径被其他目录占用；为保护数据，未覆盖它。", 409);
    }
    await mkdir(resolve(workspace.worktree_path, ".."), { recursive: true, mode: 0o700 });

    if (await branchExists(projectGitRoot, workspace.branch)) {
      const branchHead = await git(projectGitRoot, ["rev-parse", "--verify", `refs/heads/${workspace.branch}^{commit}`]);
      if (branchHead.exitCode !== 0 || singleLine(branchHead.stdout) !== workspace.base_sha) {
        throw new GitWorkspaceError("任务分支已存在且不再指向原始基准提交；为保护分支，未复用它。", 409);
      }
      const result = await git(projectGitRoot, ["worktree", "add", workspace.worktree_path, workspace.branch], GIT_COMMAND_TIMEOUT_MS);
      if (result.exitCode !== 0) throw gitFailure("恢复已预留的任务 worktree 失败", result);
    } else {
      const result = await git(projectGitRoot, ["worktree", "add", "-b", workspace.branch, workspace.worktree_path, workspace.base_sha], GIT_COMMAND_TIMEOUT_MS);
      if (result.exitCode !== 0) throw gitFailure("创建任务 worktree 失败", result);
    }
    await verifyWorkspaceRoot(workspace, commonDirectory);
  });
}

export async function verifyTaskWorkspace(workspace: StoredTaskWorkspace): Promise<string> {
  if (workspace.status === "removed") throw new GitWorkspaceError("任务 worktree 已移除。", 410);
  const projectRoot = await canonicalDirectory(workspace.project_root, "registered project");
  const projectGitRoot = await gitRoot(projectRoot);
  const expectedGitRoot = await canonicalDirectory(workspace.project_git_root, "registered Git root");
  if (projectGitRoot !== expectedGitRoot) {
    throw new GitWorkspaceError("登记项目的 Git 仓库已变化；为避免在其他仓库继续任务，已阻止运行。", 409);
  }
  await verifyWorkspaceRoot(workspace, workspace.git_common_directory);
  const workingDirectory = await canonicalDirectory(workspace.working_directory, "task working directory");
  if (!isPathInside(await realpath(workspace.worktree_path), workingDirectory)) {
    throw new GitWorkspaceError("任务工作目录不在其 worktree 内。");
  }
  return workingDirectory;
}

export async function inspectTaskWorkspace(workspace: StoredTaskWorkspace): Promise<TaskWorkspaceInspection> {
  try {
    const projectGitRoot = await canonicalDirectory(workspace.project_git_root, "registered Git root");
    const entryList = await listGitWorktrees(projectGitRoot);
    const entry = entryList.find((item) => normalizePath(item.path) === normalizePath(workspace.worktree_path));
    if (!entry) {
      return {
        exists: false,
        currentBranch: null,
        headCommit: null,
        dirtyEntryCount: 0,
        remoteBranches: [],
        commitsAheadOfBase: null,
        mergedIntoBase: null,
        error: "Git worktree list 中不存在此目录。",
      };
    }
    const [head, status, remoteRefs, ahead, baseCommit] = await Promise.all([
      git(entry.path, ["rev-parse", "--verify", "HEAD^{commit}"]),
      git(entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
      git(projectGitRoot, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
      git(projectGitRoot, ["rev-list", "--count", `${workspace.base_sha}..${workspace.branch}`]),
      git(projectGitRoot, ["rev-parse", "--verify", `${workspace.base_ref}^{commit}`]),
    ]);
    if (head.exitCode !== 0 || status.exitCode !== 0 || remoteRefs.exitCode !== 0) {
      throw new GitWorkspaceError("无法读取 worktree 的 Git 状态。");
    }
    const remoteBranches = remoteRefs.stdout.split(/\r?\n/).map((ref) => ref.trim()).filter((ref) => {
      const slash = ref.indexOf("/");
      return slash > 0 && ref.slice(slash + 1) === workspace.branch;
    });
    let mergedIntoBase: boolean | null = null;
    if (baseCommit.exitCode === 0) {
      const merged = await git(projectGitRoot, ["merge-base", "--is-ancestor", workspace.branch, workspace.base_ref]);
      if (merged.exitCode === 0) mergedIntoBase = true;
      else if (merged.exitCode === 1) mergedIntoBase = false;
    }
    const dirtyEntries = status.stdout.split("\0").filter(Boolean);
    return {
      exists: true,
      currentBranch: entry.branch,
      headCommit: singleLine(head.stdout),
      dirtyEntryCount: dirtyEntries.length,
      remoteBranches,
      commitsAheadOfBase: ahead.exitCode === 0 ? Number.parseInt(singleLine(ahead.stdout), 10) || 0 : null,
      mergedIntoBase,
      error: null,
    };
  } catch (error) {
    return {
      exists: false,
      currentBranch: null,
      headCommit: null,
      dirtyEntryCount: 0,
      remoteBranches: [],
      commitsAheadOfBase: null,
      mergedIntoBase: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listGitWorktrees(projectDirectory: string): Promise<GitWorktreeEntry[]> {
  const root = await gitRoot(projectDirectory);
  const result = await git(root, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) throw gitFailure("无法读取 Git worktree 列表", result);
  return parseWorktreeList(result.stdout);
}

export async function inspectUnmanagedWorktree(
  projectDirectory: string,
  entry: GitWorktreeEntry,
): Promise<UnmanagedWorktreeInspection> {
  try {
    if (entry.prunable) throw new GitWorkspaceError("Git marks this worktree as prunable.");
    const projectGitRoot = await gitRoot(projectDirectory);
    const projectCommonDirectory = await gitCommonDirectory(projectGitRoot);
    const worktreePath = await canonicalDirectory(entry.path, "unmanaged worktree");
    if (await gitRoot(worktreePath) !== worktreePath || await gitCommonDirectory(worktreePath) !== projectCommonDirectory) {
      throw new GitWorkspaceError("worktree is not attached to the registered project repository.");
    }
    const [head, status, remoteRefs, originHead] = await Promise.all([
      git(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
      git(projectGitRoot, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
      git(projectGitRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    ]);
    if (head.exitCode !== 0 || status.exitCode !== 0 || remoteRefs.exitCode !== 0) {
      throw new GitWorkspaceError("无法读取该 worktree 的 Git 状态。");
    }
    const headCommit = singleLine(head.stdout);
    const remoteBranches = remoteRefs.stdout.split(/\r?\n/).map((ref) => ref.trim()).filter((ref) => {
      const slash = ref.indexOf("/");
      return entry.branch !== null && slash > 0 && ref.slice(slash + 1) === entry.branch;
    });
    let baseRef = originHead.exitCode === 0 ? singleLine(originHead.stdout) : "";
    if (!baseRef) {
      for (const candidate of ["main", "master", "rc", "develop"]) {
        if ((await git(projectGitRoot, ["rev-parse", "--verify", `${candidate}^{commit}`])).exitCode === 0) {
          baseRef = candidate;
          break;
        }
      }
    }
    let commitsAheadOfBase: number | null = null;
    let mergedIntoBase: boolean | null = null;
    if (baseRef) {
      const [ahead, merged] = await Promise.all([
        git(projectGitRoot, ["rev-list", "--count", `${baseRef}..${headCommit}`]),
        git(projectGitRoot, ["merge-base", "--is-ancestor", headCommit, baseRef]),
      ]);
      if (ahead.exitCode === 0) commitsAheadOfBase = Number.parseInt(singleLine(ahead.stdout), 10) || 0;
      if (merged.exitCode === 0) mergedIntoBase = true;
      else if (merged.exitCode === 1) mergedIntoBase = false;
    }
    return {
      exists: true,
      currentBranch: entry.branch,
      headCommit,
      dirtyEntryCount: status.stdout.split("\0").filter(Boolean).length,
      remoteBranches,
      baseRef: baseRef || null,
      commitsAheadOfBase,
      mergedIntoBase,
      error: null,
    };
  } catch (error) {
    return {
      exists: false,
      currentBranch: entry.branch,
      headCommit: entry.commit,
      dirtyEntryCount: 0,
      remoteBranches: [],
      baseRef: null,
      commitsAheadOfBase: null,
      mergedIntoBase: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function removeTaskWorkspaceDirectory(
  workspace: StoredTaskWorkspace,
  options: { deleteBranch?: boolean } = {},
): Promise<{ branchDeleted: boolean; branchError?: string }> {
  if (workspace.status === "removed") return { branchDeleted: false };
  if (!workspace.followups_closed_at) {
    throw new GitWorkspaceError("请先归档任务并关闭后续续问，再清理工作区。", 409);
  }
  const inspection = await inspectTaskWorkspace(workspace);
  if (inspection.error === "Git worktree list 中不存在此目录。" && !options.deleteBranch) {
    return { branchDeleted: false };
  }
  if (inspection.error) throw new GitWorkspaceError(inspection.error, 409);
  if (inspection.dirtyEntryCount > 0) throw new GitWorkspaceError(`工作区有 ${inspection.dirtyEntryCount} 项未提交改动；请先 review 或保留工作区。`, 409);
  if (options.deleteBranch && inspection.remoteBranches.length > 0) {
    throw new GitWorkspaceError("此分支已存在远程跟踪分支；清理时会保留本地分支。", 409);
  }
  if (options.deleteBranch && inspection.mergedIntoBase !== true && inspection.commitsAheadOfBase !== 0) {
    throw new GitWorkspaceError("分支尚未确认合并到基准分支；清理时会保留本地分支。", 409);
  }

  const commonDirectory = await gitCommonDirectory(workspace.project_git_root);
  return withGitMetadataLock(commonDirectory, async () => {
    const latestInspection = await inspectTaskWorkspace(workspace);
    const latestMissing = latestInspection.error === "Git worktree list 中不存在此目录。";
    if (latestInspection.error && !(latestMissing && !options.deleteBranch)) {
      throw new GitWorkspaceError(latestInspection.error, 409);
    }
    if (latestInspection.dirtyEntryCount > 0) {
      throw new GitWorkspaceError(`工作区现在有 ${latestInspection.dirtyEntryCount} 项未提交改动；请先 review 或保留工作区。`, 409);
    }
    if (options.deleteBranch && latestInspection.remoteBranches.length > 0) {
      throw new GitWorkspaceError("此分支已出现远程跟踪分支；清理时会保留本地分支。", 409);
    }
    if (options.deleteBranch && latestInspection.mergedIntoBase !== true && latestInspection.commitsAheadOfBase !== 0) {
      throw new GitWorkspaceError("分支尚未确认合并到基准分支；清理时会保留本地分支。", 409);
    }
    const entries = await listGitWorktrees(workspace.project_git_root);
    const entry = entries.find((item) => normalizePath(item.path) === normalizePath(workspace.worktree_path));
    if (entry) {
      if (entry.branch !== workspace.branch) throw new GitWorkspaceError("worktree 分支与任务记录不符，已取消清理。", 409);
      const removed = await git(workspace.project_git_root, ["worktree", "remove", workspace.worktree_path]);
      if (removed.exitCode !== 0) throw gitFailure("移除 Git worktree 失败", removed);
    }
    if (!options.deleteBranch) return { branchDeleted: false };
    const branch = await git(workspace.project_git_root, ["branch", "-d", "--", workspace.branch]);
    if (branch.exitCode !== 0) {
      return { branchDeleted: false, branchError: gitFailure("worktree 已移除，但 Git 未允许删除本地分支", branch).message };
    }
    return { branchDeleted: true };
  });
}

export async function resolveGitRoot(directory: string): Promise<string> {
  return gitRoot(directory);
}

export async function resolveGitCommonDirectory(repositoryRoot: string): Promise<string> {
  return gitCommonDirectory(repositoryRoot);
}

function parseWorktreeList(output: string): GitWorktreeEntry[] {
  return output.split(/\n{2,}/).map((block) => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) return null;
    const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
    const commitLine = lines.find((line) => line.startsWith("HEAD "));
    return {
      path: resolve(pathLine.slice("worktree ".length)),
      branch: branchLine ? branchLine.slice("branch refs/heads/".length) : null,
      commit: commitLine ? commitLine.slice("HEAD ".length) : null,
      detached: lines.includes("detached"),
      prunable: lines.some((line) => line.startsWith("prunable ")),
    };
  }).filter((entry): entry is GitWorktreeEntry => entry !== null);
}

async function verifyWorkspaceRoot(workspace: StoredTaskWorkspace, expectedGitRoot: string): Promise<void> {
  const canonicalWorktreePath = await canonicalDirectory(workspace.worktree_path, "task worktree");
  const actualGitRoot = await gitRoot(canonicalWorktreePath);
  if (actualGitRoot !== canonicalWorktreePath) throw new GitWorkspaceError("任务 worktree 路径不是仓库根目录。");
  if (await gitCommonDirectory(actualGitRoot) !== expectedGitRoot) {
    throw new GitWorkspaceError("任务 worktree 不属于对应登记项目的 Git 仓库。");
  }
  const branch = await git(actualGitRoot, ["branch", "--show-current"]);
  if (branch.exitCode !== 0 || singleLine(branch.stdout) !== workspace.branch) {
    throw new GitWorkspaceError("任务 worktree 当前分支与任务记录不符。");
  }
}

async function gitRoot(directory: string): Promise<string> {
  const result = await git(directory, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) throw new GitWorkspaceError("所选目录不在可用的 Git 仓库中。");
  return canonicalDirectory(singleLine(result.stdout), "Git repository root");
}

async function gitCommonDirectory(repositoryRoot: string): Promise<string> {
  const result = await git(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  if (result.exitCode !== 0) throw gitFailure("无法读取 Git common directory", result);
  return canonicalDirectory(resolve(repositoryRoot, singleLine(result.stdout)), "Git common directory");
}

async function ensureWorkspaceRoot(configuredRoot: string, repositoryRoot: string): Promise<string> {
  let resolvedRoot = resolve(configuredRoot);
  if (isPathInside(repositoryRoot, await realpathWithMissingPath(resolvedRoot))) {
    resolvedRoot = fallbackWorkspaceRoot(repositoryRoot);
  }
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  let canonicalRoot = await realpath(resolvedRoot);
  if (isPathInside(repositoryRoot, canonicalRoot)) {
    resolvedRoot = fallbackWorkspaceRoot(repositoryRoot);
    await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
    canonicalRoot = await realpath(resolvedRoot);
  }
  if (isPathInside(repositoryRoot, canonicalRoot)) throw new GitWorkspaceError("无法在源仓库之外确定 worktree 根目录。");
  const info = await stat(canonicalRoot);
  if (!info.isDirectory()) throw new GitWorkspaceError("worktree 根目录不是文件夹。");
  return canonicalRoot;
}

async function realpathWithMissingPath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(current);
      return resolve(canonical, ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function fallbackWorkspaceRoot(repositoryRoot: string): string {
  return resolve(dirname(repositoryRoot), ".bridge-worktrees", slug(basename(repositoryRoot), 48) || "repository");
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new GitWorkspaceError(`${label} 路径必须是绝对路径。`);
  let canonical: string;
  try { canonical = await realpath(path); }
  catch { throw new GitWorkspaceError(`${label} 目录不可用。`); }
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new GitWorkspaceError(`${label} 路径不是文件夹。`);
  return canonical;
}

async function branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  const result = await git(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw gitFailure("无法检查任务分支是否已存在", result);
}

async function resolveTaskBase(repositoryRoot: string): Promise<{ baseRef: string; baseSha: string }> {
  const result = await git(repositoryRoot, ["rev-parse", "--verify", `refs/heads/${TASK_BASE_REF}^{commit}`]);
  if (result.exitCode !== 0) {
    throw new GitWorkspaceError(
      `登记项目没有本地 ${TASK_BASE_REF} 分支；任务 worktree 不会从当前分支或其他分支兜底创建。`,
      409,
    );
  }
  const baseSha = singleLine(result.stdout);
  if (!/^[a-f\d]{40,64}$/i.test(baseSha)) {
    throw new GitWorkspaceError(`无法确认 ${TASK_BASE_REF} 分支的基准提交。`, 409);
  }
  return { baseRef: TASK_BASE_REF, baseSha };
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

function isPathInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "");
}

function slug(value: string, maxLength: number): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength).replace(/-+$/g, "");
}

function singleLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function gitFailure(action: string, result: GitCommandResult): GitWorkspaceError {
  const detail = (result.stderr || result.stdout).trim().replace(/\s+/g, " ").slice(0, 300);
  return new GitWorkspaceError(detail ? `${action}：${detail}` : `${action}。`, 409);
}

async function git(cwd: string, args: string[], timeoutMs = GIT_COMMAND_TIMEOUT_MS): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > GIT_OUTPUT_LIMIT_BYTES) {
        finishError(new GitWorkspaceError("Git 命令输出超过安全上限。", 422));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finishError(new GitWorkspaceError(`无法启动 Git：${error.message}`, 503)));
    const timer = setTimeout(() => finishError(new GitWorkspaceError("Git 命令执行超时。", 504)), timeoutMs);
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      });
    });
  });
}

async function withGitMetadataLock<T>(commonDirectory: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = resolve(commonDirectory, "bridge-task-worktree.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(resolve(lockPath, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw new GitWorkspaceError(`无法创建 Git worktree 锁：${error instanceof Error ? error.message : String(error)}`, 503);
      }
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) throw new GitWorkspaceError("等待 Git worktree 操作锁超时。", 503);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  try { return await operation(); }
  finally { await rm(lockPath, { recursive: true, force: true }).catch(() => undefined); }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
  const content = await readFile(resolve(lockPath, "pid"), "utf8");
    const pid = Number.parseInt(content, 10);
    if (!Number.isSafeInteger(pid) || pid < 1) return;
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(lockPath, { recursive: true, force: true });
    }
  } catch {
    // A concurrently-created lock may not have its owner file yet.
  }
}
