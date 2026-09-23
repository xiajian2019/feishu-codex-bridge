import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const ACPX_PATCHED = Symbol.for('feishu-codex-bridge.acpx-worktree-patched');
const BRIDGE_PATCHED = Symbol.for('feishu-codex-bridge.agent-worktree-patched');
const SESSION_CWDS = Symbol.for('feishu-codex-bridge.acpx-session-cwds');
let worktreeQueue = Promise.resolve();

function isolationConfig(env = process.env) {
  if (env.AAMP_CODEX_WORKTREE_ENABLED !== '1') return undefined;
  const config = {
    projectRegistryPath: env.AAMP_CODEX_PROJECTS_FILE,
    globalAgentsPath: env.AAMP_CODEX_GLOBAL_AGENTS,
    taskDir: env.AAMP_CODEX_TASK_DIR,
    worktreeRoot: env.AAMP_CODEX_WORKTREE_ROOT,
    baseRef: env.AAMP_CODEX_WORKTREE_BASE_REF || 'HEAD',
    branchPrefix: env.AAMP_CODEX_WORKTREE_BRANCH_PREFIX || 'xiajian/agent',
    metadataDir: env.AAMP_CODEX_WORKTREE_METADATA_DIR,
  };
  for (const field of ['projectRegistryPath', 'globalAgentsPath', 'taskDir', 'worktreeRoot', 'metadataDir']) {
    const value = config[field];
    if (!value || !isAbsolute(value)) {
      throw new Error(`AAMP worktree isolation requires an absolute ${field}`);
    }
  }
  return config;
}

export function taskHash(taskId) {
  return createHash('sha256').update(String(taskId)).digest('hex').slice(0, 10);
}

export function slugifyTaskTitle(title) {
  return String(title || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'feishu-task';
}

const FEATURE_WORD_LIMIT = 4;
const OPAQUE_TASK_WORD = /^(?:[0-9a-f]{8,}|[0-9]{6,})$/i;

export function featureSlugFromTaskTitle(title) {
  const words = slugifyTaskTitle(title).split('-').filter(Boolean);
  const meaningfulWords = words.filter((word) => !OPAQUE_TASK_WORD.test(word));
  const selectedWords = (meaningfulWords.length >= 2 ? meaningfulWords : words)
    .slice(0, FEATURE_WORD_LIMIT);
  return selectedWords.join('-') || 'feishu-task';
}

function safeTaskId(taskId) {
  const safe = String(taskId || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `${safe}-${taskHash(taskId)}`;
}

function sessionNameFromArgs(args) {
  for (const flag of ['--name', '-s', '--session']) {
    const index = args.indexOf(flag);
    if (index >= 0 && typeof args[index + 1] === 'string') return args[index + 1];
  }
  if (args[0] === 'sessions' && ['close', 'delete'].includes(args[1])) {
    return args[2];
  }
  return undefined;
}

export function patchAcpxClient(AcpxClient) {
  const prototype = AcpxClient?.prototype;
  if (!prototype || prototype[ACPX_PATCHED]) return;
  const originalBuildArgs = prototype.buildAcpxArgs;
  if (typeof originalBuildArgs !== 'function') {
    throw new Error('AAMP compatibility: AcpxClient.buildAcpxArgs is unavailable');
  }

  prototype.setAampSessionCwd = function setAampSessionCwd(sessionName, cwd) {
    if (!this[SESSION_CWDS]) this[SESSION_CWDS] = new Map();
    this[SESSION_CWDS].set(sessionName, cwd);
  };
  prototype.deleteAampSessionCwd = function deleteAampSessionCwd(sessionName) {
    this[SESSION_CWDS]?.delete(sessionName);
  };
  prototype.buildAcpxArgs = function buildAcpxArgsWithTaskCwd(agent, args, globalArgs = []) {
    const built = originalBuildArgs.call(this, agent, args, globalArgs);
    const sessionName = sessionNameFromArgs(args);
    const cwd = sessionName ? this[SESSION_CWDS]?.get(sessionName) : undefined;
    if (!cwd) return built;
    const cwdIndex = built.indexOf('--cwd');
    if (cwdIndex < 0 || typeof built[cwdIndex + 1] !== 'string') {
      throw new Error('AAMP compatibility: acpx no longer exposes a --cwd argument');
    }
    const next = [...built];
    next[cwdIndex + 1] = cwd;
    return next;
  };
  Object.defineProperty(prototype, ACPX_PATCHED, { value: true });
}

function git(repositoryRoot, args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSucceeds(repositoryRoot, args) {
  return spawnSync('git', ['-C', repositoryRoot, ...args], {
    stdio: 'ignore',
  }).status === 0;
}

function writePrivateFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

function readProjectRegistry(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('project registry must be an object');
    }
    return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === 'string'));
  } catch (error) {
    throw new Error(`cannot read Bridge project registry ${filePath}: ${error.message}`);
  }
}

function cleanProjectName(value) {
  return String(value || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[，,。；;）)]+$/g, '')
    .trim();
}

export function extractTaskProjectName(task) {
  const context = task?.dispatchContext;
  for (const value of [
    task?.project,
    task?.projectName,
    task?.projectKey,
    context?.project,
    context?.projectName,
    context?.projectKey,
  ]) {
    const name = cleanProjectName(value);
    if (name) return name;
  }
  const text = [task?.bodyText, task?.title].filter(Boolean).join('\n');
  const match = /(?:^|[\n/|])\s*项目\s*[:：=]\s*([^\s/|]+)/m.exec(text);
  return cleanProjectName(match?.[1]);
}

function readGlobalAgents(filePath) {
  if (!existsSync(filePath)) throw new Error(`global Codex instructions not found: ${filePath}`);
  const content = readFileSync(filePath, 'utf8');
  if (!content.trim()) throw new Error(`global Codex instructions are empty: ${filePath}`);
  return content;
}

function mappedProject(task, config) {
  const projectName = extractTaskProjectName(task);
  if (!projectName) return undefined;
  let projects;
  try {
    projects = readProjectRegistry(config.projectRegistryPath);
  } catch (error) {
    throw new Error(`cannot load Bridge project registry: ${error.message}`);
  }
  const mappedRoot = projects[projectName];
  if (!mappedRoot) {
    throw new Error(`project "${projectName}" is not enabled in the Bridge project registry`);
  }
  if (!isAbsolute(mappedRoot) || !existsSync(mappedRoot)) {
    throw new Error(`project "${projectName}" registry path is invalid or missing: ${mappedRoot}`);
  }
  let repositoryRoot;
  try {
    if (!statSync(mappedRoot).isDirectory()) throw new Error('not a directory');
    repositoryRoot = git(mappedRoot, ['rev-parse', '--show-toplevel']);
    if (realpathSync(repositoryRoot) !== realpathSync(mappedRoot)) {
      throw new Error(`mapped path is not the Git top level: ${mappedRoot}`);
    }
  } catch (error) {
    throw new Error(`project "${projectName}" is not a usable Git repository: ${error.message}`);
  }
  return {
    projectName,
    repositoryRoot: realpathSync(repositoryRoot),
    globalAgents: readGlobalAgents(config.globalAgentsPath),
  };
}

function readMetadata(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function frontmatterValue(value) {
  return JSON.stringify(String(value ?? ''));
}

function renderTaskFile(task, identity, project, config, createdAt) {
  return [
    '---',
    `task_name: ${frontmatterValue(identity.featureName)}`,
    'source: feishu-aamp',
    `aamp_task_id: ${frontmatterValue(task.taskId)}`,
    `created_at: ${frontmatterValue(createdAt)}`,
    `project: ${frontmatterValue(project.projectName)}`,
    `project_root: ${frontmatterValue(project.repositoryRoot)}`,
    '---',
    '',
    `# ${String(task.title || 'Feishu task').replace(/[\r\n]+/g, ' ').trim()}`,
    '',
    '## Execution context',
    `Mapped project: ${project.projectName}`,
    `Mapped repository: ${project.repositoryRoot}`,
    `Global Codex instructions: ${config.globalAgentsPath}`,
    '',
    '## Global AGENTS.md',
    project.globalAgents.trim(),
    '',
    '## Task request',
    String(task.bodyText || '').trim(),
    '',
  ].join('\n');
}

function validateExistingWorktree(config, project, metadata) {
  if (!metadata?.worktreePath || !metadata?.branch || !existsSync(metadata.worktreePath)) {
    return false;
  }
  if (!statSync(metadata.worktreePath).isDirectory()) return false;
  try {
    const topLevel = git(metadata.worktreePath, ['rev-parse', '--show-toplevel']);
    const branch = git(metadata.worktreePath, ['branch', '--show-current']);
    return realpathSync(topLevel) === realpathSync(metadata.worktreePath)
      && branch === metadata.branch
      && metadata.projectName === project.projectName
      && realpathSync(metadata.repositoryRoot) === realpathSync(project.repositoryRoot);
  } catch {
    return false;
  }
}

function taskIdentity(task, config, project) {
  const hash = taskHash(task.taskId);
  const featureSlug = featureSlugFromTaskTitle(task.title);
  const projectSlug = slugifyTaskTitle(project.projectName);
  const featureName = `${featureSlug}-${hash}`;
  const shortName = featureSlug.split('-').slice(0, 2).join('-') || 'feishu-task';
  const branchPrefix = config.branchPrefix.replace(/\/+$/g, '');
  return {
    hash,
    featureName,
    projectSlug,
    branch: `${branchPrefix}/${projectSlug}/${featureName}`,
    worktreePath: join(config.worktreeRoot, projectSlug, `wt-${shortName}-${hash}`),
    taskFile: join(config.taskDir, `aamp-${projectSlug}-${safeTaskId(task.taskId)}.md`),
    metadataFile: join(config.metadataDir, `${projectSlug}-${safeTaskId(task.taskId)}.json`),
  };
}

function createOrReuseWorktree(task, config, project) {
  const identity = taskIdentity(task, config, project);
  const existing = readMetadata(identity.metadataFile);
  if (validateExistingWorktree(config, project, existing)) {
    const createdAt = existing.createdAt || new Date().toISOString();
    writePrivateFile(identity.taskFile, renderTaskFile(task, identity, project, config, createdAt));
    return { ...existing, taskFile: identity.taskFile, reused: true };
  }

  git(project.repositoryRoot, ['check-ref-format', '--branch', identity.branch]);
  const baseSha = git(project.repositoryRoot, ['rev-parse', '--verify', `${config.baseRef}^{commit}`]);
  const dirtyBase = git(project.repositoryRoot, ['status', '--porcelain']).length > 0;
  const createdAt = new Date().toISOString();
  writePrivateFile(identity.taskFile, renderTaskFile(task, identity, project, config, createdAt));
  mkdirSync(config.worktreeRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(identity.worktreePath), { recursive: true, mode: 0o700 });

  if (existsSync(identity.worktreePath)) {
    throw new Error(`worktree path exists but is not valid for this task: ${identity.worktreePath}`);
  }
  if (gitSucceeds(project.repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${identity.branch}`])) {
    git(project.repositoryRoot, ['worktree', 'add', identity.worktreePath, identity.branch]);
  } else {
    git(project.repositoryRoot, ['worktree', 'add', '-b', identity.branch, identity.worktreePath, baseSha]);
  }

  const metadata = {
    version: 1,
    taskId: String(task.taskId),
    title: String(task.title || ''),
    projectName: project.projectName,
    projectRegistrySource: 'Bridge SQLite',
    globalAgentsPath: config.globalAgentsPath,
    globalAgents: project.globalAgents,
    repositoryRoot: project.repositoryRoot,
    taskFile: identity.taskFile,
    worktreePath: identity.worktreePath,
    branch: identity.branch,
    baseRef: config.baseRef,
    baseSha,
    dirtyBase,
    createdAt,
    reused: false,
  };
  writePrivateFile(identity.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

function serializeWorktreeOperation(operation) {
  const result = worktreeQueue.then(operation, operation);
  worktreeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function prepareTaskIsolation(task, env = process.env) {
  const config = isolationConfig(env);
  if (!config) return undefined;
  const project = mappedProject(task, config);
  if (!project) return undefined;
  return serializeWorktreeOperation(() => createOrReuseWorktree(task, config, project));
}

function taskSessionName(bridge, task) {
  const suffix = `task-${taskHash(task.taskId)}`;
  return `${bridge.sessionName}-${suffix}`;
}

function isolationPromptContext(metadata) {
  const lines = [
    '## Local task isolation',
    'This task has a dedicated Git branch and worktree. Treat this worktree as the only writable repository checkout for this task.',
    `Mapped project: ${metadata.projectName}`,
    `Mapped repository: ${metadata.repositoryRoot}`,
    `Project registry: ${metadata.projectRegistrySource}`,
    `Global Codex instructions: ${metadata.globalAgentsPath}`,
    `Task request file: ${metadata.taskFile}`,
    `Worktree: ${metadata.worktreePath}`,
    `Branch: ${metadata.branch}`,
    `Base: ${metadata.baseRef} (${metadata.baseSha})`,
    'Do not create another worktree or invoke codex-worktree from this already-running Codex turn.',
    'Do not commit, push, merge, deploy, or delete the worktree unless the user explicitly asks.',
  ];
  lines.push('', 'Follow the following global AGENTS.md instructions for this task:', '', metadata.globalAgents.trim());
  if (metadata.dirtyBase) {
    lines.push('Warning: the source checkout had uncommitted changes; this worktree starts from the committed base and does not include them.');
  }
  return lines.join('\n');
}

async function reportIsolationFailure(bridge, task, options, error) {
  if (options?.historical || !bridge.client) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await bridge.client.sendResult({
      to: task.from,
      taskId: task.taskId,
      status: 'rejected',
      output: '',
      errorMsg: `Codex worktree isolation setup failed: ${message}`,
      inReplyTo: task.messageId,
    });
    bridge.settledTaskLifecycles?.set(task.taskId, task.messageId);
  } catch (deliveryError) {
    console.warn(`[${bridge.name}] Failed to report worktree setup error for ${task.taskId}: ${deliveryError.message}`);
  }
}

async function historicalTaskNeedsExecution(bridge, task) {
  try {
    const hydrated = await bridge.client.hydrateTaskDispatch(task);
    return !(hydrated.threadHistory ?? []).some((event) => [
      'task.result',
      'task.cancel',
      'task.help_needed',
    ].includes(event?.intent));
  } catch {
    // The official bridge also skips historical tasks when hydration fails.
    return false;
  }
}

export function patchAgentBridge(AgentBridge) {
  const prototype = AgentBridge?.prototype;
  if (!prototype || prototype[BRIDGE_PATCHED]) return;
  const originalResolveSession = prototype.resolveTaskSessionName;
  const originalHandleTask = prototype.handleTask;
  const originalEnsureSession = prototype.ensureAcpSession;
  if ([originalResolveSession, originalHandleTask, originalEnsureSession].some((value) => typeof value !== 'function')) {
    throw new Error('AAMP compatibility: AgentBridge task/session methods are unavailable');
  }

  prototype.resolveTaskSessionName = function resolveIsolatedTaskSession(task) {
    return isolationConfig() ? taskSessionName(this, task) : originalResolveSession.call(this, task);
  };
  prototype.ensureAcpSession = async function ensureSessionInConfiguredCwd(sessionName) {
    return originalEnsureSession.call(this, sessionName);
  };
  prototype.handleTask = async function handleTaskInWorktree(task, options = {}) {
    const config = isolationConfig();
    if (!config
      || !this.client
      || this.stopping
      || this.activeTaskSessions?.has(task.taskId)
      || this.settledTaskLifecycles?.get(task.taskId) !== undefined) {
      return originalHandleTask.call(this, task, options);
    }
    let project;
    try {
      project = mappedProject(task, config);
    } catch (error) {
      await reportIsolationFailure(this, task, options, error);
      throw error;
    }
    if (!project) return originalHandleTask.call(this, task, options);
    if (options.historical && !(await historicalTaskNeedsExecution(this, task))) {
      return originalHandleTask.call(this, task, options);
    }

    let metadata;
    try {
      metadata = await serializeWorktreeOperation(() => createOrReuseWorktree(task, config, project));
    } catch (error) {
      await reportIsolationFailure(this, task, options, error);
      throw error;
    }
    if (!metadata) return originalHandleTask.call(this, task, options);

    const sessionName = taskSessionName(this, task);
    this.acpx.setAampSessionCwd?.(sessionName, metadata.worktreePath);
    const isolatedTask = {
      ...task,
      bodyText: [isolationPromptContext(metadata), '', String(task.bodyText || '')]
        .filter(Boolean)
        .join('\n'),
    };
    console.log(`[${this.name}] AAMP task worktree ready: task=${task.taskId} branch=${metadata.branch} cwd=${metadata.worktreePath}`);
    try {
      return await originalHandleTask.call(this, isolatedTask, options);
    } finally {
      if (this.sessionNames?.has(sessionName)) {
        await this.closeAcpSession(sessionName);
        this.sessionNames.delete(sessionName);
      }
      this.acpx.deleteAampSessionCwd?.(sessionName);
    }
  };
  Object.defineProperty(prototype, BRIDGE_PATCHED, { value: true });
  console.error('[AAMP compatibility] per-task ACP worktree isolation active');
}
