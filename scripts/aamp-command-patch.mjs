import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCHED = Symbol.for('feishu-codex-bridge.aamp-command-patched');
export const AAMP_COMMAND_ACTION_KIND = 'aamp_command';
export const AAMP_TASK_CANCEL_ACTION_KIND = 'task_cancel';
export const AAMP_TASK_HIDE_ACTION_KIND = 'aamp_task_hide';
export const GLOBAL_TASK_MODES = Object.freeze({ AAMP: 'aamp', DIRECT: 'direct' });
const hiddenTaskIdsByRuntime = new WeakMap();
const BRIDGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RECENT_PROMPT_INLINE_LIMIT = 32;
const RECENT_PROMPT_PREVIEW_LIMIT = 28;
const MAX_THREADS_CARD_ITEMS = 10;
const THREAD_QUERY_TIMEOUT_MS = 20_000;
const AAMP_RECEIVED_REACTION = 'Get';
const AAMP_THINKING_REACTION = 'Think';
const REACTION_MAX_ATTEMPTS = 3;

const COMMAND_ALIASES = new Map([
  ['cancel', 'cancel'],
  ['status', 'status'],
  ['usage', 'usage'],
  ['recent', 'recent'],
  ['threads', 'threads'],
  ['tasks', 'tasks'],
  ['task', 'tasks'],
  ['help', 'help'],
  ['thread', 'thread'],
  ['resume', 'resume'],
  ['retry', 'retry'],
  ['queue', 'queue'],
  ['progress', 'progress'],
  ['events', 'events'],
  ['changes', 'changes'],
  ['commands', 'commands'],
  ['tools', 'tools'],
]);

const STATUS_LABELS = {
  queued: '排队中',
  dispatching: '派发中',
  pending: '等待 Agent',
  notloaded: '未加载',
  idle: '空闲',
  active: '执行中',
  systemerror: '系统错误',
  streaming: '执行中',
  running: '执行中',
  cancel_requested: '取消中',
  help_needed: '等待补充信息',
  completed: '已完成',
  done: '已完成',
  succeeded: '已完成',
  rejected: '已拒绝',
  failed: '失败',
  canceled: '已取消',
  cancelled: '已取消',
};

const STATUS_COLORS = {
  queued: 'orange',
  dispatching: 'blue',
  pending: 'orange',
  notloaded: 'grey',
  idle: 'green',
  active: 'blue',
  systemerror: 'red',
  streaming: 'blue',
  running: 'blue',
  cancel_requested: 'orange',
  help_needed: 'orange',
  completed: 'green',
  done: 'green',
  succeeded: 'green',
  rejected: 'red',
  failed: 'red',
  canceled: 'grey',
  cancelled: 'grey',
};

const CONNECTION_COLORS = {
  connected: 'green',
  connecting: 'orange',
  disconnected: 'red',
};

const MAX_RECENT_TASKS = 10;
const MAX_TASK_TEXT = 6_000;
const MAX_USAGE_FILES = 240;
const MAX_CODEX_RATE_LIMIT_FILES = 80;
const MAX_CODEX_RATE_LIMIT_FILE_BYTES = 512 * 1024;

/**
 * Parse the small command surface handled by the Feishu bridge itself.
 * Unknown slash commands deliberately fall through to the normal Agent path.
 */
export function parseAampCommand(content) {
  let text = String(content ?? '').trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.text === 'string') text = parsed.text.trim();
    } catch {
      // Feishu text messages are normally already plain text.
    }
  }
  text = stripLeadingMention(text);
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  const command = COMMAND_ALIASES.get(match[1].toLowerCase());
  if (!command) return undefined;
  const argumentText = match[2]?.trim() || '';
  const args = command === 'threads'
    ? tokenizeCommandArguments(argumentText)
    : argumentText ? argumentText.split(/\s+/) : [];
  return {
    command,
    args,
    raw: text,
  };
}

function tokenizeCommandArguments(value) {
  if (!value) return [];
  const tokens = [];
  let token = '';
  let quote;
  let escaping = false;
  for (const character of value) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else {
      token += character;
    }
  }
  if (escaping) token += '\\';
  if (quote) return [];
  if (token) tokens.push(token);
  return tokens;
}

/**
 * Read the official AAMP task-runtime state without requiring AAMP itself to
 * be running. Direct mode uses this as the canonical overlay for tasks whose
 * SQLite row was last touched by a replayed (non-terminal) ack.
 */
export function readAampCanonicalTaskStates(options = {}) {
  const stateHome = resolve(options.stateHome || process.env.AAMP_TASK_STATE_HOME || join(homedir(), '.aamp', 'feishu-task-agent'));
  const result = {};
  const files = [];
  walkFiles(stateHome, '.json', files, 12);
  for (const entry of files) {
    if (basename(entry.path) !== 'state.json') continue;
    const parsed = parseJson(safeRead(entry.path));
    const tasks = parsed?.tasks;
    if (!isRecord(tasks)) continue;
    for (const value of Object.values(tasks)) {
      if (!isRecord(value) || !normalizeString(value.taskId)) continue;
      const taskId = normalizeString(value.taskId);
      const candidate = {
        taskId,
        status: normalizeCanonicalTaskStatus(value.status),
        title: normalizeString(value.title),
        userMessageText: normalizeString(value.userMessageText),
        outputText: normalizeString(value.outputText),
        resultError: normalizeString(value.resultError) || null,
        createdAt: normalizeString(value.createdAt),
        updatedAt: normalizeString(value.updatedAt),
      };
      mergeCanonicalTask(result, candidate);
    }
  }

  const logRoot = resolve(options.logDir || process.env.AAMP_LOG_DIR || join(homedir(), '.aamp', 'logs'));
  const logFiles = [];
  walkFiles(join(logRoot, 'runs'), '.jsonl', logFiles, 8);
  for (const entry of logFiles) {
    for (const line of String(safeRead(entry.path) || '').split(/\r?\n/)) {
      const parsed = parseJson(line);
      const taskId = normalizeString(parsed?.taskId);
      const type = normalizeString(parsed?.type);
      if (!taskId || !type || !type.startsWith('task.')) continue;
      const status = normalizeCanonicalTaskStatus(parsed.status || statusForCanonicalEvent(type));
      if (!status) continue;
      mergeCanonicalTask(result, {
        taskId,
        status,
        title: normalizeString(parsed.title),
        createdAt: '',
        updatedAt: normalizeString(parsed.timestamp),
      });
    }
  }
  return result;
}

function mergeCanonicalTask(result, candidate) {
  const existing = result[candidate.taskId];
  if (existing && isTerminalCanonicalStatus(existing.status) && !isTerminalCanonicalStatus(candidate.status)) return;
  result[candidate.taskId] = {
    ...(existing || {}),
    ...Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== '' && value !== null && value !== undefined)),
  };
}

function normalizeCanonicalTaskStatus(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (['done', 'completed', 'succeeded', 'result'].includes(normalized)) return 'completed';
  if (['cancelled', 'canceled', 'cancel'].includes(normalized)) return 'cancelled';
  if (['failed', 'rejected'].includes(normalized)) return 'failed';
  if (['help_needed', 'blocked'].includes(normalized)) return 'help_needed';
  if (['running', 'streaming', 'pending', 'dispatching'].includes(normalized)) return normalized;
  return undefined;
}

function statusForCanonicalEvent(type) {
  return ({
    'task.completed': 'completed',
    'task.result': 'completed',
    'task.failed': 'failed',
    'task.rejected': 'rejected',
    'task.cancel': 'cancelled',
    'task.help_needed': 'help_needed',
    'task.received': 'running',
  })[type];
}

function isTerminalCanonicalStatus(value) {
  return ['completed', 'failed', 'rejected', 'cancelled'].includes(normalizeString(value).toLowerCase());
}

function stripLeadingMention(text) {
  return text
    .replace(/^(?:<at\b[^>]*>[\s\S]*?<\/at>\s*)+/i, '')
    .replace(/^@[^\s]+\s+/, '')
    .trim();
}

function scheduleAampMessageReaction(runtime, messageId, emojiType) {
  const channel = runtime?.channel;
  if (!channel || typeof channel.addReaction !== 'function' || !normalizeString(messageId)) return;
  setImmediate(() => {
    void (async () => {
      let lastError;
      for (let attempt = 1; attempt <= REACTION_MAX_ATTEMPTS; attempt += 1) {
        try {
          await channel.addReaction(messageId, emojiType);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < REACTION_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
      runtime.logger?.warn?.(`[AAMP compatibility] failed to add message reaction=${emojiType} message=${messageId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    })();
  });
}

export function patchAampCommands(Runtime) {
  const prototype = Runtime?.prototype;
  if (!prototype || prototype[PATCHED]) return;
  for (const method of [
    'handleIncomingMessage',
    'handleCardAction',
    'shouldAcceptMessage',
    'isDuplicateMessage',
    'isBridgeAuthoredMessage',
    'buildCardShell',
  ]) {
    if (typeof prototype[method] !== 'function') {
      throw new Error(`AAMP compatibility: missing ${method}; review upstream update`);
    }
  }

  const originalIncoming = prototype.handleIncomingMessage;
  const originalCardAction = prototype.handleCardAction;

  prototype.handleIncomingMessage = async function handleIncomingMessageWithCommands(message) {
    const command = parseAampCommand(message?.content);
    if (!command) {
      scheduleAampMessageReaction(this, message?.messageId, AAMP_RECEIVED_REACTION);
      const result = originalIncoming.call(this, message);
      scheduleAampMessageReaction(this, message?.messageId, AAMP_THINKING_REACTION);
      return result;
    }

    const botIdentity = this.channel?.botIdentity;
    if (botIdentity && message.senderId === botIdentity.openId) return;
    if (this.isBridgeAuthoredMessage(message.messageId)) return;
    if (!this.shouldAcceptMessage(message, botIdentity)) return;
    if (this.isDuplicateMessage(message.messageId)) return;

    try {
      await executeAampCommand(this, message, command);
    } finally {
      await this.persistState?.();
    }
  };

  prototype.handleCardAction = async function handleCardActionWithCommands(event) {
    const value = readCommandActionValue(event);
    if (value?.kind === AAMP_TASK_HIDE_ACTION_KIND) {
      await hideTaskFromRecent(this, event, value);
      return;
    }
    if (value?.kind === AAMP_TASK_CANCEL_ACTION_KIND) {
      if (taskSourceMode(value) !== GLOBAL_TASK_MODES.AAMP) {
        this.logger?.warn?.(`[global commands] ignored cross-mode cancellation task=${normalizeString(value.taskId) || 'unknown'} source=${taskSourceMode(value)}`);
        return;
      }
      // Some Feishu event consumers leave action.value JSON-serialized while
      // the upstream cancellation patch expects the already-parsed object.
      const cancellationEvent = eventWithActionValue(event, value);
      const result = await originalCardAction.call(this, cancellationEvent);
      if (value.source === 'recent') await refreshRecentCard(this, event);
      return result;
    }
    if (value?.kind !== AAMP_COMMAND_ACTION_KIND) {
      return originalCardAction.call(this, event);
    }
    if (['native_thread', 'native_thread_detail', 'threads_tab', 'thread_detail'].includes(value.source)) {
      scheduleAampCommandAction(this, event, value);
      return;
    }
    await executeAampCommandAction(this, event, value);
  };

  Object.defineProperty(prototype, PATCHED, { value: true });
  console.error('[AAMP compatibility] global Feishu slash commands active: /help /status /usage /recent /tasks /threads');
}

async function executeAampCommand(runtime, message, command) {
  const card = command.command === 'threads'
    ? await buildThreadsCommandCard(runtime, message.chatId, command.args)
    : buildCommandCard(runtime, message.chatId, command);
  await sendCommandCard(runtime, message.chatId, card);
}

async function executeAampCommandAction(runtime, event, value) {
  const chatId = normalizeString(event?.chatId);
  const command = COMMAND_ALIASES.get(normalizeString(value?.command)?.toLowerCase());
  if (!chatId || !command) return;
  const commandValue = {
    command,
    args: value.taskId ? [String(value.taskId)] : [],
    raw: value.commandText || `/${command}`,
  };
  if (command === 'thread' && ['native_thread', 'native_thread_detail'].includes(value.source)) {
    const result = await queryNativeCodexThread(runtime, commandValue.args[0]);
    const card = result.thread
      ? buildCodexThreadDetailCard(runtime, result.thread)
      : buildDirectInfoCard(runtime, '读取 Codex Thread 失败', [
        result.error || '没有返回有效的 thread 详情。',
        `Thread：${commandValue.args[0] || '暂无'}`,
      ]);
    await sendCommandCard(
      runtime,
      chatId,
      card,
      value.source === 'native_thread_detail' ? event.messageId : undefined,
    );
    return;
  }
  const card = command === 'threads'
    ? await buildThreadsCommandCard(runtime, chatId, commandValue.args, value.tab)
    : buildCommandCard(runtime, chatId, commandValue);
  await sendCommandCard(
    runtime,
    chatId,
    card,
    ['threads', 'threads_tab', 'thread_detail'].includes(value.source) ? event.messageId : undefined,
  );
}

function scheduleAampCommandAction(runtime, event, value) {
  setImmediate(() => {
    void executeAampCommandAction(runtime, event, value).catch((error) => {
      runtime.logger?.error?.(`[AAMP compatibility] failed to handle thread card action: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

async function buildThreadsCommandCard(runtime, chatId, args, activeTab) {
  const nativeResult = await queryNativeCodexThreads(runtime, args);
  const aampTasks = listRuntimeTasks(runtime, chatId)
    .filter((task) => taskSourceMode(task) === GLOBAL_TASK_MODES.AAMP)
    .slice(0, MAX_THREADS_CARD_ITEMS);
  const nativeThreads = nativeResult.items.slice(0, MAX_THREADS_CARD_ITEMS);
  return buildThreadsOverviewCard(runtime, chatId, {
    title: `Codex Threads（AAMP ${aampTasks.length} · App/CLI ${nativeThreads.length}）`,
    nativeTitle: `Codex App/CLI threads（${nativeThreads.length}${nativeResult.total === undefined ? (nativeResult.nextCursor ? '+' : '') : `/${nativeResult.total}`}）`,
    nativeCount: nativeThreads.length,
    nativeThreads,
    activeTab,
    nativeLines: nativeResult.error
      ? [`查询 App/CLI threads 失败：${nativeResult.error}`]
      : nativeThreads.length === 0
        ? ['没有找到匹配的 Codex App/CLI thread。']
        : nativeThreads.flatMap(formatNativeThread),
    nativeMoreText: nativeResult.items.length > nativeThreads.length
      ? `仅展示前 ${MAX_THREADS_CARD_ITEMS} 条 App/CLI thread；需要更多结果时可在终端使用 codex:threads。`
      : undefined,
  });
}

async function queryNativeCodexThreads(runtime, args) {
  if (typeof runtime.queryCodexThreads === 'function') {
    try {
      return normalizeNativeThreadResult(await runtime.queryCodexThreads(args));
    } catch (error) {
      return { items: [], error: sanitizeThreadQueryError(error) };
    }
  }

  const entrypoint = join(BRIDGE_ROOT, 'dist', 'codex-cli.js');
  if (!existsSync(entrypoint)) {
    return { items: [], error: 'Bridge 编译产物不存在，请先执行 npm run build。' };
  }
  const configPath = process.env.AAMP_COMMAND_CONFIG_PATH || join(BRIDGE_ROOT, 'config.json');
  const forwardedArgs = (args || []).filter((argument) => argument !== '--json');
  const result = await runThreadQueryProcess(
    process.execPath,
    [entrypoint, 'threads', '--config', configPath, ...forwardedArgs, '--json'],
    buildThreadQueryEnvironment(),
  );
  if (result.timedOut) return { items: [], error: `查询超过 ${THREAD_QUERY_TIMEOUT_MS / 1_000} 秒，已停止本次只读查询。` };
  if (result.exitCode !== 0) return { items: [], error: sanitizeThreadQueryError(result.stderr) || 'Codex thread 查询进程失败。' };
  const parsed = parseJson(result.stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    return { items: [], error: 'Bridge 没有返回有效的 Codex thread 查询结果。' };
  }
  return normalizeNativeThreadResult(parsed);
}

async function queryNativeCodexThread(runtime, threadId) {
  const normalizedThreadId = normalizeString(threadId);
  if (!normalizedThreadId) return { error: '缺少 Codex thread ID。' };
  if (typeof runtime.queryCodexThread === 'function') {
    try {
      const value = await runtime.queryCodexThread(normalizedThreadId);
      const record = isRecord(value) ? value : {};
      const thread = isRecord(record.thread)
        ? record.thread
        : isRecord(value) && normalizeString(value.id) ? value : undefined;
      return thread ? { thread } : { error: '运行时没有返回有效的 thread 详情。' };
    } catch (error) {
      return { error: sanitizeThreadQueryError(error) };
    }
  }

  const entrypoint = join(BRIDGE_ROOT, 'dist', 'codex-cli.js');
  if (!existsSync(entrypoint)) {
    return { error: 'Bridge 编译产物不存在，请先执行 npm run build。' };
  }
  const configPath = process.env.AAMP_COMMAND_CONFIG_PATH || join(BRIDGE_ROOT, 'config.json');
  const result = await runThreadQueryProcess(
    process.execPath,
    [entrypoint, 'thread', normalizedThreadId, '--turns', '--config', configPath, '--json'],
    buildThreadQueryEnvironment(),
  );
  if (result.timedOut) return { error: `读取超过 ${THREAD_QUERY_TIMEOUT_MS / 1_000} 秒，已停止本次只读查询。` };
  if (result.exitCode !== 0) return { error: sanitizeThreadQueryError(result.stderr) || 'Codex thread 读取进程失败。' };
  const parsed = parseJson(result.stdout);
  const thread = isRecord(parsed?.thread) ? parsed.thread : undefined;
  return thread
    ? { thread }
    : { error: 'Bridge 没有返回有效的 Codex thread 详情。' };
}

function normalizeNativeThreadResult(value) {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.items)
    ? record.items.filter((item) => isRecord(item) && normalizeString(item.id))
    : [];
  return {
    items,
    ...(typeof record.total === 'number' ? { total: record.total } : {}),
    ...(typeof record.nextCursor === 'string' && record.nextCursor ? { nextCursor: record.nextCursor } : {}),
    ...(normalizeString(record.error) ? { error: normalizeString(record.error) } : {}),
  };
}

function buildThreadQueryEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (key === 'NODE_OPTIONS' || key.startsWith('LARK_') || key.startsWith('FEISHU_')) continue;
    environment[key] = value;
  }
  return environment;
}

function runThreadQueryProcess(file, args, env) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let child;
    let timer;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    };
    try {
      child = spawn(file, args, {
        cwd: BRIDGE_ROOT,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = String(error);
      finish(127);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once('error', (error) => { stderr = `${stderr}${String(error)}`.slice(-8_000); finish(127); });
    child.once('close', (exitCode) => finish(exitCode ?? 1));
    timer = setTimeout(() => {
      timedOut = true;
      if (!settled) child.kill('SIGTERM');
      setTimeout(() => finish(124), 500);
    }, THREAD_QUERY_TIMEOUT_MS);
  });
}

function formatAampThreadTask(task) {
  const taskId = normalizeString(task?.taskId) || '(unknown)';
  const title = truncate(singleLine(task?.title || task?.userMessageText || '（无标题）'), 180);
  const status = displayTaskStatus(task);
  const updatedAt = formatTimestamp(task?.updatedAt || task?.createdAt);
  const lines = [`- [AAMP] ${status} · \`${taskId}\``, `  标题：${title}`, `  更新时间：${updatedAt}`];
  const prompt = truncate(singleLine(task?.userMessageText), 240);
  if (prompt && prompt !== title) lines.push(`  请求：${prompt}`);
  lines.push('');
  return lines;
}

function formatNativeThread(thread) {
  const status = normalizeString(thread?.status?.type) || 'unknown';
  const source = nativeThreadSource(thread?.source || thread?.threadSource);
  const title = truncate(singleLine(thread?.name || thread?.preview || '（无标题）'), 180);
  const cwd = truncate(singleLine(thread?.cwd), 240) || '—';
  const lines = [`- [${source}] ${status} · \`${normalizeString(thread?.id) || '(unknown)'}\``, `  标题：${title}`, `  目录：${cwd}`, `  更新时间：${formatNativeThreadTimestamp(thread?.updatedAt)}`, ''];
  return lines;
}

function nativeThreadSource(source) {
  if (typeof source === 'string' && source) return source;
  if (isRecord(source) && normalizeString(source.custom)) return `custom:${normalizeString(source.custom)}`;
  if (isRecord(source) && isRecord(source.subAgent)) return 'subAgent';
  return 'unknown';
}

function formatNativeThreadTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(未知)';
  return formatTimestamp(new Date(value * 1_000).toISOString());
}

function sanitizeThreadQueryError(error) {
  return String(error instanceof Error ? error.message : error || 'unknown error')
    .replace(/(access[_-]?token|app[_-]?secret|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .slice(0, 800);
}

export function buildCommandCard(runtime, chatId, command) {
  switch (command.command) {
    case 'cancel':
      return buildCancelCard(runtime, chatId, command.args[0]);
    case 'status':
      return buildStatusCard(runtime, chatId);
    case 'usage':
      return buildUsageCard(runtime, chatId);
    case 'recent':
      return buildRecentCard(runtime, chatId, parseRecentLimit(command.args));
    case 'tasks':
      return buildTaskCommandCard(runtime, chatId, command.args[0]);
    case 'threads':
      return buildCard(runtime, [markdown(runtime, [
        '**Codex Threads**',
        '',
        '请重新发送 `/threads` 获取最新任务和 thread 列表。',
      ].join('\n'))]);
    case 'thread':
    case 'resume':
    case 'retry':
    case 'queue':
    case 'progress':
    case 'events':
    case 'changes':
    case 'commands':
    case 'tools':
      return buildDirectOnlyCommandCard(runtime, command.command);
    case 'help':
    default:
      return buildHelpCard(runtime);
  }
}

export function buildDirectInfoCard(runtime, title, lines) {
  return buildCard(runtime, [
    markdown(runtime, [
      `**${title}**`,
      ...(lines.length > 0 ? ['', truncate(String(lines[0]), 500)] : []),
    ].join('\n'), 'direct_info_title'),
    { tag: 'hr', element_id: 'direct_info_divider' },
    collapsible(
      runtime,
      '详细信息',
      lines.length > 0 ? lines.join('\n') : '暂无可显示的信息。',
      'direct_info_details',
      true,
    ),
    buttonRow('direct_command_actions', [
      button('direct_command_recent', '返回最近任务', actionValue('recent'), 'primary'),
      button('direct_command_help', '查看帮助', actionValue('help'), 'default'),
    ]),
  ]);
}

/**
 * Render the cross-runtime thread list as separate task rows. Both AAMP tasks
 * and native App/CLI threads get an operation button; native threads are read
 * through the Codex app-server/CLI detail path because they have no Feishu
 * task record of their own.
 */
export function buildThreadsOverviewCard(runtime, chatId, options = {}) {
  const aampTasks = listRuntimeTasks(runtime, chatId)
    .filter((task) => taskSourceMode(task) === GLOBAL_TASK_MODES.AAMP)
    .slice(0, MAX_THREADS_CARD_ITEMS);
  const nativeLines = Array.isArray(options.nativeLines)
    ? options.nativeLines.map((line) => truncate(String(line), 1_000)).slice(0, 80)
    : [];
  const nativeCount = typeof options.nativeCount === 'number'
    ? options.nativeCount
    : nativeLines.length;
  const nativeThreads = Array.isArray(options.nativeThreads)
    ? options.nativeThreads
      .filter((thread) => isRecord(thread) && normalizeString(thread.id))
      .slice(0, MAX_THREADS_CARD_ITEMS)
    : [];
  const activeTab = options.activeTab === 'aamp' ? 'aamp' : 'native';
  const elements = [
    markdown(runtime, `**${String(options.title || 'Codex Threads').replace(/（[^）]*）$/, '')}**`, 'threads_title'),
    buttonRow('threads_tabs', [
      button(
        'threads_tab_native',
        `Codex App/CLI（${nativeCount}）`,
        actionValue('threads', undefined, 'threads_tab', { tab: 'native' }),
        activeTab === 'native' ? 'primary' : 'default',
      ),
      button(
        'threads_tab_aamp',
        `AAMP（${aampTasks.length}）`,
        actionValue('threads', undefined, 'threads_tab', { tab: 'aamp' }),
        activeTab === 'aamp' ? 'primary' : 'default',
      ),
    ]),
    { tag: 'hr', element_id: 'threads_header_divider' },
  ];

  if (activeTab === 'aamp') {
    if (aampTasks.length === 0) {
      elements.push(markdown(runtime, '_当前会话没有 AAMP 任务。_', 'threads_aamp_empty'));
    } else {
      for (const [index, task] of aampTasks.entries()) {
        elements.push(buildThreadTaskBlock(runtime, task, index));
        if (index < aampTasks.length - 1) {
          elements.push({ tag: 'hr', element_id: `threads_aamp_divider_${index}` });
        }
      }
    }
  } else {
    if (nativeThreads.length > 0) {
      for (const [index, thread] of nativeThreads.entries()) {
        elements.push(buildNativeThreadBlock(runtime, thread, index));
        if (index < nativeThreads.length - 1) {
          elements.push({ tag: 'hr', element_id: `threads_native_row_divider_${index}` });
        }
      }
    } else {
      elements.push(collapsible(
        runtime,
        'Codex App/CLI threads',
        nativeLines.length > 0 ? nativeLines.join('\n') : '暂无 App/CLI thread 信息。',
        'threads_native_details',
        false,
      ));
    }
  }
  if (options.nativeMoreText) {
    elements.push(markdown(runtime, truncate(String(options.nativeMoreText), 1_000), 'threads_native_more'));
  }
  elements.push(buttonRow('threads_actions', [
    button('threads_recent', '查看最近任务', actionValue('recent'), 'primary'),
    button('threads_help', '查看帮助', actionValue('help'), 'default'),
  ]));
  return compactGlobalCard(buildCard(runtime, elements));
}

function buildNativeThreadBlock(runtime, thread, index) {
  const threadId = normalizeString(thread.id) || '(unknown)';
  const title = truncate(singleLine(thread.name || thread.preview || '（无标题）'), 180);
  const executionStatus = threadExecutionStatus(thread);
  const status = executionStatus.label;
  const cwd = truncate(singleLine(thread.cwd), 240) || '—';
  const updatedAt = formatNativeThreadTimestamp(thread.updatedAt);
  return {
    tag: 'column_set',
    element_id: `threads_native_row_${index}`,
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_spacing: '4px',
      elements: [
        markdown(runtime, `**${coloredText(status, executionStatus.color)} · ${truncate(threadId, 180)}**`, `threads_native_title_${index}`),
        markdown(runtime, `标题：${title}\n目录：${cwd}\n更新时间：${updatedAt}`, `threads_native_meta_${index}`),
        buttonRow(`threads_native_actions_${index}`, [
          button(
            `threads_native_detail_${index}`,
            '查看执行',
            actionValue('thread', threadId, 'native_thread'),
            'primary',
          ),
        ]),
      ],
    }],
  };
}

export function buildCodexThreadDetailCard(runtime, rawThread) {
  const thread = isRecord(rawThread) ? rawThread : {};
  const threadId = normalizeString(thread.id) || '(unknown)';
  const title = truncate(singleLine(thread.name || thread.preview || '（无标题）'), 240);
  const executionStatus = threadExecutionStatus(thread);
  const status = executionStatus.label;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const metadata = [
    `标题：${title}`,
    `目录：${truncate(singleLine(thread.cwd), 240) || '—'}`,
    `更新时间：${formatNativeThreadTimestamp(thread.updatedAt)}`,
  ];
  const conclusion = extractThreadConclusion(thread, turns);
  const elements = [
    markdown(runtime, `**Codex Thread 执行详情**\n\nThread：${truncate(threadId, 240)} · ${coloredText(status, executionStatus.color)}`, 'thread_detail_title'),
    markdown(runtime, metadata.join('\n'), 'thread_detail_metadata'),
    collapsible(runtime, '最后总结', conclusion, 'thread_detail_conclusion', true),
    buttonRow('thread_detail_actions', [
      button('thread_detail_refresh', '刷新详情', actionValue('thread', threadId, 'native_thread_detail'), 'primary'),
    ]),
  ];
  return compactGlobalCard(buildCard(runtime, elements));
}

function threadExecutionStatus(thread) {
  const rawStatus = normalizeString(thread?.status?.type)?.toLowerCase() || '';
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.at(-1);
  const lastTurnStatus = normalizeString(lastTurn?.status || lastTurn?.state)?.toLowerCase() || '';
  if (['systemerror', 'error', 'failed', 'failure'].includes(rawStatus)
    || ['error', 'failed', 'failure'].includes(lastTurnStatus)) {
    return { label: '失败', color: statusColor('failed') };
  }
  if (['active', 'running', 'streaming', 'in_progress', 'processing'].includes(rawStatus)
    || ['active', 'running', 'streaming', 'in_progress', 'processing'].includes(lastTurnStatus)) {
    return { label: '执行中', color: statusColor('active') };
  }
  if (['completed', 'complete', 'done', 'succeeded', 'success'].includes(rawStatus)
    || ['completed', 'complete', 'done', 'succeeded', 'success'].includes(lastTurnStatus)) {
    return { label: '已完成', color: statusColor('completed') };
  }
  if (rawStatus === 'notloaded') {
    return turns.length > 0
      ? { label: '已完成', color: statusColor('completed') }
      : { label: '已结束', color: statusColor('completed') };
  }
  if (rawStatus === 'idle') {
    return turns.length > 0
      ? { label: '已完成', color: statusColor('completed') }
      : { label: '已结束', color: statusColor('completed') };
  }
  return { label: displayStatus(rawStatus || 'unknown'), color: statusColor(rawStatus || 'unknown') };
}

function extractThreadConclusion(thread, turns) {
  for (const turn of [...turns].reverse()) {
    const items = Array.isArray(turn?.items) ? turn.items : [turn];
    for (const item of [...items].reverse()) {
      const value = isRecord(item) ? item : {};
      const type = normalizeString(value.type || value.kind || value.role).toLowerCase();
      const text = normalizeString(value.text || value.message || value.content || value.preview);
      if (text && (type.includes('agentmessage') || type.includes('agent_message') || type === 'assistant' || type === 'message')) {
        return truncate(text, MAX_TASK_TEXT);
      }
    }
  }
  const preview = normalizeString(thread.preview || thread.name);
  return preview ? truncate(preview, MAX_TASK_TEXT) : 'Codex 没有返回最后总结。';
}

function buildThreadTaskBlock(runtime, task, index) {
  const taskId = normalizeString(task?.taskId) || '(unknown)';
  const status = displayTaskStatus(task);
  const title = truncate(singleLine(task?.title || task?.userMessageText || '（无标题）'), 180);
  const updatedAt = formatTimestamp(task?.updatedAt || task?.createdAt);
  const actions = [button(
    `threads_detail_${index}`,
    '查看详情',
    actionValue('tasks', taskId, 'threads'),
    'primary',
  )];
  if (isCancellableTask(runtime, task)) {
    actions.push(button(
      `threads_cancel_${index}`,
      '中断',
      cancelActionValue(task),
      'danger',
    ));
  }
  return {
    tag: 'column_set',
    element_id: `threads_aamp_row_${index}`,
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_spacing: '4px',
      elements: [
        markdown(runtime, `**${coloredText(status, taskStatusColor(task))} · ${truncate(taskId, 180)}**`, `threads_task_title_${index}`),
        markdown(runtime, `标题：${title}\n更新时间：${updatedAt}`, `threads_task_meta_${index}`),
        buttonRow(`threads_task_actions_${index}`, actions),
      ],
    }],
  };
}

/**
 * Build the task card used by the native direct runtime. Keeping the task
 * summary and the long-running output in separate elements makes the card
 * readable on mobile while leaving the task actions visible at all times.
 * The same action payload is understood by the global card-action handler, so
 * a task can be opened from a streaming card without first sending /recent.
 */
export function buildDirectTaskCard(runtime, rawTask, attachmentNames = []) {
  const task = normalizeDirectTask(rawTask);
  const taskId = task.taskId || '(未知任务)';
  const status = displayTaskStatus(task);
  const terminal = isTerminalTask(task);
  const statusColorValue = taskStatusColor(task);
  const elements = [
    markdown(runtime, [
      `**Codex 直连 · ${coloredText(status, statusColorValue)}**`,
      `\`${truncate(taskId, 180)}\``,
    ].join('\n'), 'direct_task_title'),
    directTaskSummary(runtime, task, status, statusColorValue),
    { tag: 'hr', element_id: 'direct_task_divider' },
  ];

  const request = task.userMessageText;
  if (request) {
    elements.push(collapsible(
      runtime,
      '任务请求',
      truncate(request, MAX_TASK_TEXT),
      'direct_task_request',
      false,
    ));
  }

  const progress = task.streamText || task.lastProgressText;
  if (progress || !terminal) {
    elements.push(collapsible(
      runtime,
      terminal ? '最后进度' : '执行进度',
      progress || 'Codex 正在准备执行……',
      'direct_task_progress',
      !terminal,
    ));
  }

  if (task.outputText) {
    elements.push(collapsible(
      runtime,
      '执行结果',
      truncate(task.outputText, MAX_TASK_TEXT),
      'direct_task_result',
      true,
    ));
  }
  if (task.resultError) {
    elements.push(collapsible(
      runtime,
      '错误信息',
      truncate(task.resultError, MAX_TASK_TEXT),
      'direct_task_error',
      true,
    ));
  }
  if (attachmentNames.length > 0) {
    elements.push(collapsible(
      runtime,
      `附件（${attachmentNames.length}）`,
      attachmentNames.map((name) => `- \`${truncate(String(name), 240)}\``).join('\n'),
      'direct_task_attachments',
      false,
    ));
  }
  if (task.recoveryCount > 0) {
    elements.push(markdown(runtime, `恢复次数：${task.recoveryCount}`, 'direct_task_recovery'));
  }

  const actions = [
    button('direct_task_detail', '查看详情', actionValue('tasks', taskId, 'direct_task'), 'primary'),
    button('direct_task_events', '事件', actionValue('events', taskId, 'direct_task'), 'default'),
  ];
  if (!terminal) {
    actions.push(button('direct_task_cancel', '中断', cancelActionValue({
      ...task,
      sourceMode: GLOBAL_TASK_MODES.DIRECT,
    }), 'danger'));
  } else if (task.status === 'FAILED' || task.status === 'CANCELLED') {
    actions.push(button('direct_task_retry', '重试', actionValue('retry', taskId, 'direct_task'), 'default'));
  } else {
    actions.push(button('direct_task_changes', '变更', actionValue('changes', taskId, 'direct_task'), 'default'));
  }
  elements.push(buttonRow('direct_task_actions', actions));
  return compactGlobalCard(buildCard(runtime, elements));
}

function normalizeDirectTask(rawTask) {
  const value = isRecord(rawTask) ? rawTask : {};
  const taskId = normalizeString(value.taskId || value.bridge_task_id);
  const status = normalizeString(value.status).toUpperCase() || 'RUNNING';
  return {
    ...value,
    taskId,
    status,
    sourceMode: GLOBAL_TASK_MODES.DIRECT,
    userMessageText: normalizeString(value.userMessageText || value.text),
    outputText: normalizeString(value.outputText || value.final_response),
    streamText: normalizeString(value.streamText || value.last_progress_text),
    lastProgressText: normalizeString(value.lastProgressText || value.last_progress_text),
    resultError: normalizeString(value.resultError || value.error),
    threadId: normalizeString(value.threadId || value.thread_id),
    createdAt: normalizeString(value.createdAt || value.created_at),
    updatedAt: normalizeString(value.updatedAt || value.updated_at),
    recoveryCount: Number(value.recoveryCount || value.recovery_count || 0) || 0,
  };
}

function directTaskSummary(runtime, task, status, statusColorValue) {
  const fields = [
    ['状态', coloredText(status, statusColorValue)],
    ['任务 ID', `\`${truncate(task.taskId || '未知', 80)}\``],
    ['Thread', task.threadId ? `\`${truncate(task.threadId, 80)}\`` : '暂无'],
  ];
  return {
    tag: 'column_set',
    element_id: 'direct_task_summary',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: fields.map(([label, value], index) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [markdown(runtime, `<font color='grey'>${label}</font>\n${value}`, `direct_task_summary_${index}`)],
    })),
  };
}

// Feishu limits the total number of card elements. Keep a safety net for long
// task lists or unusually large upstream task rows by trimming oldest rows.
export function compactGlobalCard(card, maxElements = 190) {
  if (!card?.body || !Array.isArray(card.body.elements)) return card;
  const elements = [...card.body.elements];
  let changed = false;
  while (countCardElements({ body: { elements } }) > maxElements) {
    const reverseIndex = [...elements].reverse().findIndex((element) =>
      element?.element_id?.startsWith('recent_row_'));
    if (reverseIndex < 0) break;
    elements.splice(elements.length - 1 - reverseIndex, 1);
    changed = true;
  }
  if (!changed) return card;
  const visibleRows = elements.filter((element) => element?.element_id?.startsWith('recent_row_')).length;
  const header = elements[0];
  if (header?.tag === 'markdown' && typeof header.content === 'string') {
    header.content = header.content.replace(/(Codex 最近任务（)\d+(）)/, `$1${visibleRows}$2`);
  }
  return { ...card, body: { ...card.body, elements } };
}

function countCardElements(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countCardElements(item), 0);
  return (value.tag ? 1 : 0) + Object.values(value).reduce((total, item) => total + countCardElements(item), 0);
}

async function sendCommandCard(runtime, chatId, card, updateMessageId) {
  if (!runtime.channel || typeof runtime.channel.send !== 'function') {
    throw new Error('AAMP compatibility: Feishu channel.send is unavailable');
  }
  if (updateMessageId && typeof runtime.channel.updateCard === 'function') {
    await runtime.channel.updateCard(updateMessageId, compactGlobalCard(card));
    return;
  }
  // Slash commands are standalone navigation/status messages. Deliberately
  // omit replyTo so Feishu does not render them as a reply to /status, etc.
  await runtime.channel.send(chatId, { card: compactGlobalCard(card) });
}

export function buildHelpCard(runtime) {
  const directCommands = currentRuntimeMode(runtime) === GLOBAL_TASK_MODES.DIRECT
    ? [
        '`/thread` 查看当前 thread、项目、模式和最近任务',
        '`/resume <任务ID或thread ID>` 恢复历史 Codex thread',
        '`/retry <任务ID>` 重新执行失败或已取消任务',
        '`/queue` 查看排队、运行中和待取消任务',
        '`/progress [任务ID]` 查看最新执行进度',
        '`/events <任务ID>` 查看 Codex 事件时间线',
        '`/changes <任务ID>` 查看文件变更',
        '`/commands <任务ID>` 查看 shell 命令及状态',
        '`/tools <任务ID>` 查看 MCP 工具调用记录',
      ]
    : [];
  return buildCard(runtime, [
    markdown(runtime, [
      '**Codex 全局命令**',
      '',
      '`/help` 查看支持的斜杠命令',
      '`/cancel [任务ID]` 取消当前模式中的活动任务',
      '`/status` 查看 Feishu、AAMP 和全局任务状态',
      '`/usage` 查看 Codex 账户限额快照和会话 token 用量',
      '`/recent` 查看当前会话的 AAMP 与直连任务',
      '`/tasks <任务ID>` 查看具体任务详情',
      '`/task <任务ID>` `/tasks` 的别名',
      '`/threads [筛选参数]` 查看当前会话的 AAMP 任务及本机 Codex App/CLI threads',
      ...directCommands,
      '',
      '任务列表中的“查看详情”按钮会直接打开对应任务详情。',
    ].join('\n')),
    buttonRow('help_actions', [
      button('help_status', '/status', actionValue('status'), 'primary'),
      button('help_usage', '/usage', actionValue('usage'), 'default'),
      button('help_recent', '/recent', actionValue('recent'), 'default'),
    ]),
  ]);
}

function buildDirectOnlyCommandCard(runtime, command) {
  return buildCard(runtime, [
    markdown(runtime, [
      `**/${command}**`,
      '',
      currentRuntimeMode(runtime) === GLOBAL_TASK_MODES.DIRECT
        ? '该命令由直连运行时处理。'
        : '该命令仅在 Codex 直连模式可用，AAMP 任务不会展示此操作。',
    ].join('\n')),
  ]);
}

function buildCancelCard(runtime, chatId, selector) {
  const tasks = listRuntimeTasks(runtime, chatId, { includeHidden: true })
    .filter((task) => taskSourceMode(task) === GLOBAL_TASK_MODES.AAMP && !isTerminalTask(task));
  const normalized = normalizeString(selector);
  const target = normalized
    ? tasks.find((task) => task.taskId === normalized || task.taskId.startsWith(normalized))
    : tasks[0];
  if (!target) {
    return buildCard(runtime, [markdown(runtime, [
      '**取消任务**',
      '',
      normalized ? `没有找到可取消的 AAMP 任务：\`${normalized}\`` : '当前没有可取消的 AAMP 任务。',
    ].join('\n'))]);
  }
  return buildCard(runtime, [
    markdown(runtime, [
      '**取消任务**',
      '',
      `任务：\`${target.taskId}\``,
      `接入模式：${sourceModeLabel(taskSourceMode(target))}`,
      `状态：${displayTaskStatus(target)}`,
    ].join('\n')),
    buttonRow('cancel_actions', [
      button('cancel_confirm', '确认中断', cancelActionValue(target), 'danger'),
      button('cancel_recent', '返回最近任务', actionValue('recent'), 'default'),
    ]),
  ]);
}

export function buildStatusCard(runtime, chatId) {
  const tasks = listRuntimeTasks(runtime, chatId);
  const connectivity = runtime.state?.connectivity || {};
  const feishu = normalizeString(connectivity.feishu) || 'unknown';
  const aamp = normalizeString(connectivity.aamp) || 'unknown';
  const runtimeMode = currentRuntimeMode(runtime);
  const healthy = feishu === 'connected'
    && (runtimeMode === GLOBAL_TASK_MODES.DIRECT || aamp === 'connected');
  const counts = countTaskStatuses(tasks);
  const liveCount = tasks.filter((task) => !isTerminalTask(task)).length;
  const aampTasks = tasks.filter((task) => taskSourceMode(task) === GLOBAL_TASK_MODES.AAMP);
  const directTasks = tasks.filter((task) => taskSourceMode(task) === GLOBAL_TASK_MODES.DIRECT);
  const sessions = selectAcpSessionRecords(tasks.map((task) => task.taskId), {
    fallbackToRecent: runtimeMode === GLOBAL_TASK_MODES.AAMP,
  });
  const models = uniqueStrings(sessions.map((record) => record.model));
  const lines = [
    `**Codex 全局状态：${coloredText(healthy ? '正常' : '需要检查', healthy ? 'green' : 'red')}**`,
    '',
    `当前接入模式：${coloredText(sourceModeLabel(runtimeMode), 'blue')}`,
    `Feishu：${coloredText(formatConnection(feishu), CONNECTION_COLORS[feishu] || 'grey')}`,
    `AAMP：${coloredText(runtimeMode === GLOBAL_TASK_MODES.AAMP ? formatConnection(aamp) : '未由当前模式管理', runtimeMode === GLOBAL_TASK_MODES.AAMP ? (CONNECTION_COLORS[aamp] || 'grey') : 'grey')}`,
    `进程 PID：${process.pid}`,
    `当前会话任务：${tasks.length} 个（AAMP ${aampTasks.length} · 直连 ${directTasks.length}），活动任务 ${coloredText(liveCount, liveCount > 0 ? 'blue' : 'grey')} 个`,
    `任务计数：${formatStatusCounts(counts)}`,
    `模型：${models.length > 0 ? models.join('、') : '(暂无会话记录)'}`,
  ];
  if (runtime.state?.lastStartedAt) lines.push(`启动时间：${formatTimestamp(runtime.state.lastStartedAt)}`);
  if (runtime.state?.lastError) lines.push(`最近错误：${truncate(runtime.state.lastError, 500)}`);

  return buildCard(runtime, [
    markdown(runtime, lines.join('\n')),
    buttonRow('status_actions', [
      button('status_recent', '查看最近任务', actionValue('recent'), 'primary'),
      button('status_usage', '查看用量', actionValue('usage'), 'default'),
    ]),
  ]);
}

export function buildRecentCard(runtime, chatId, limit = MAX_RECENT_TASKS) {
  const tasks = listRuntimeTasks(runtime, chatId).slice(0, limit);
  const metadata = loadWorktreeMetadata();
  const elements = [
    markdown(runtime, [
      `**Codex 最近任务（${tasks.length}）**`,
      '',
      '点击“详情”查看完整请求、结果和执行记录。',
    ].join('\n'), 'recent_title'),
    { tag: 'hr', element_id: 'recent_header_divider' },
  ];

  if (tasks.length === 0) {
    elements.push(markdown(runtime, '_当前会话还没有已记录的 Codex 任务。_'));
  } else {
    for (const [index, rawTask] of tasks.entries()) {
      const task = enrichTask(rawTask, metadata.get(rawTask.taskId));
      const actions = [button(
        `recent_detail_${index}`,
        '详情',
        actionValue('tasks', task.taskId, 'recent'),
        'primary',
      )];
      if (isCancellableTask(runtime, task)) {
        actions.push(button(
          `recent_cancel_${index}`,
          task.bridgeCancelState === 'failed' ? '重试中断' : '中断',
          cancelActionValue(task),
          'danger',
        ));
      }
      actions.push(button(
        `recent_hide_${index}`,
        '屏蔽',
        hideActionValue(task),
        'default',
      ));
      elements.push(buildRecentTaskBlock(
        runtime,
        `recent_row_${index}`,
        task,
        index,
        actions,
      ));
      if (index < tasks.length - 1) {
        elements.push({ tag: 'hr', element_id: `recent_divider_${index}` });
      }
    }
  }
  elements.push(
    buttonRow('recent_actions', [
      button('recent_status', '查看状态', actionValue('status'), 'default'),
      button('recent_usage', '查看用量', actionValue('usage'), 'default'),
    ]),
  );
  return compactGlobalCard(buildCard(runtime, elements));
}

function buildRecentTaskBlock(runtime, elementId, task, index, actions) {
  const elements = [markdown(runtime, recentTaskText(task), `recent_task_${index}`)];
  const request = task.userMessageText?.trim();
  appendPromptElement(runtime, elements, request, `recent_prompt_${index}`);
  elements.push(markdown(runtime, recentTaskMetadata(task), `recent_meta_${index}`));
  elements.push(taskActionRow(runtime, `recent_actions_${index}`, actions));
  return {
    tag: 'column_set',
    element_id: elementId,
    flex_mode: 'none',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_spacing: '4px',
      elements,
    }],
  };
}

function recentTaskText(task) {
  const title = task.taskId || '(未知任务)';
  const status = displayTaskStatus(task);
  return `**${coloredText(status, taskStatusColor(task))} · ${title}**`;
}

function recentTaskMetadata(task) {
  const lines = [`接入模式：${sourceModeLabel(taskSourceMode(task))}`];
  if (task.branch) lines.push(`分支名：${truncate(singleLine(task.branch), 160)}`);
  lines.push(`更新时间：${formatTimestamp(task.updatedAt || task.createdAt)}`);
  return lines.join('\n');
}

function appendPromptElement(runtime, elements, request, elementId) {
  const text = String(request ?? '').trim();
  if (!text) {
    elements.push(markdown(runtime, '(未记录提示词)', elementId));
    return;
  }
  if (promptNeedsCollapse(text)) {
    elements.push(collapsible(
      runtime,
      truncate(singleLine(text), RECENT_PROMPT_PREVIEW_LIMIT),
      truncate(text, MAX_TASK_TEXT),
      elementId,
    ));
    return;
  }
  elements.push(markdown(runtime, truncate(singleLine(text), RECENT_PROMPT_INLINE_LIMIT), elementId));
}

export function buildTaskCommandCard(runtime, chatId, selector) {
  const normalized = normalizeString(selector);
  if (!normalized) {
    return buildCard(runtime, [
      markdown(runtime, [
        '**查看任务详情**',
        '',
        '请使用：`/tasks <具体任务ID>`',
        '也可以发送 `/recent`，再点击任务列表里的“查看详情”。',
      ].join('\n')),
      button('tasks_recent', '打开最近任务', actionValue('recent'), 'primary'),
    ]);
  }

  const candidates = listRuntimeTasks(runtime, chatId, {
    includeHidden: true,
    includeAuxiliary: true,
  });
  const exact = candidates.find((task) => task.taskId === normalized);
  const matches = exact ? [exact] : candidates.filter((task) => task.taskId.startsWith(normalized));
  if (matches.length === 0) {
    return buildCard(runtime, [
      markdown(runtime, [
        `没有找到当前会话中的任务：\`${truncate(normalized, 120)}\``,
        '',
        '请先发送 `/recent` 获取可用任务 ID。',
      ].join('\n')),
      button('tasks_missing_recent', '打开最近任务', actionValue('recent'), 'primary'),
    ]);
  }
  if (matches.length > 1) {
    return buildCard(runtime, [
      markdown(runtime, [
        `任务 ID 前缀不唯一：\`${truncate(normalized, 120)}\``,
        '',
        ...matches.slice(0, 10).map((task) => `- \`${task.taskId}\` · ${truncate(singleLine(task.title), 100)}`),
        '',
        '请复制完整任务 ID 后重试。',
      ].join('\n')),
    ]);
  }

  return buildTaskDetailCard(runtime, enrichTask(matches[0], loadWorktreeMetadata().get(matches[0].taskId)));
}

export function buildTaskDetailCard(runtime, rawTask) {
  const task = enrichTask(rawTask, loadWorktreeMetadata().get(rawTask.taskId));
  const request = task.userMessageText?.trim();
  const elements = [markdown(runtime, [
    '**Codex 任务详情**',
    '',
    `ID：\`${task.taskId}\``,
  ].join('\n'))];
  elements.push({ tag: 'hr', element_id: 'task_header_divider' });
  appendPromptElement(runtime, elements, request, 'task_request');
  elements.push({ tag: 'hr', element_id: 'task_request_divider' });

  const detailLines = [
    `接入模式：${sourceModeLabel(taskSourceMode(task))}`,
    `状态：${coloredText(displayTaskStatus(task), taskStatusColor(task))}${task.statusLabel && !task.bridgeCancelledAt ? `（${truncate(singleLine(task.statusLabel), 120)}）` : ''}`,
    `标题：${truncate(singleLine(task.title || '(无标题)'), 180)}`,
  ];
  if (task.branch) detailLines.push(`分支：${truncate(singleLine(task.branch), 220)}`);
  if (task.worktreePath) detailLines.push(`worktree：${truncate(singleLine(task.worktreePath), 240)}`);
  if (task.taskFile) detailLines.push(`任务文件：${truncate(singleLine(task.taskFile), 240)}`);
  if (task.helpQuestion) detailLines.push(`等待信息：${truncate(singleLine(task.helpQuestion), 300)}`);
  if (task.resultError) detailLines.push(`错误：${truncate(singleLine(task.resultError), 500)}`);
  detailLines.push(
    `创建时间：${formatTimestamp(task.createdAt)}`,
    `更新时间：${formatTimestamp(task.updatedAt)}`,
  );
  const usage = findTaskUsage(task.taskId);
  if (usage) detailLines.push(formatTaskUsage(usage));
  elements.push(markdown(runtime, detailLines.join('\n'), 'task_metadata'));
  elements.push({ tag: 'hr', element_id: 'task_metadata_divider' });

  if (!usage && taskSourceMode(task) === GLOBAL_TASK_MODES.AAMP) {
    elements.push(markdown(runtime, '_该任务暂未发现 ACP token 用量记录。_'));
  }

  const output = task.outputText?.trim() || task.streamText?.trim();
  if (output) elements.push(collapsible(runtime, '最近输出', truncate(output, MAX_TASK_TEXT), 'task_output'));

  const taskActions = [
    button('task_back_recent', '返回最近任务', actionValue('recent'), 'primary'),
    button('task_refresh', '刷新详情', actionValue('tasks', task.taskId, 'detail'), 'default'),
  ];
  if (taskSourceMode(task) === GLOBAL_TASK_MODES.DIRECT) {
    if (!isTerminalTask(task)) {
      taskActions.push(button(
        'task_cancel',
        '中断',
        cancelActionValue({ ...task, sourceMode: GLOBAL_TASK_MODES.DIRECT }, 'detail'),
        'danger',
      ));
    }
    for (const [command, label] of [
      ['progress', '进度'],
      ['events', '事件'],
      ['changes', '变更'],
      ['commands', '命令'],
      ['tools', '工具'],
    ]) {
      taskActions.push(button(`task_${command}`, label, actionValue(command, task.taskId, 'detail'), 'default'));
    }
  }
  elements.push(buttonRow('task_actions', taskActions));
  return buildCard(runtime, elements);
}

export function buildUsageCard(runtime, chatId) {
  const tasks = listRuntimeTasks(runtime, chatId);
  const taskIds = tasks.map((task) => task.taskId);
  const rateLimits = readLatestCodexRateLimits();
  const sessionUsage = collectAcpSessionUsage(taskIds);
  const elements = [markdown(runtime, '**Codex 用量**')];

  const accountLines = rateLimits
    ? [
        `账户限额快照：${formatTimestamp(rateLimits.timestamp)}`,
        ...formatRateLimits(rateLimits.rateLimits),
      ]
    : [
        '暂未找到本机 Codex 的 rate-limit 快照；AAMP 不会猜测账户额度。',
        '如需刷新，可先在同一账号的 Codex CLI 中执行一次 `/status`，再发送 `/usage`。',
      ];
  elements.push(collapsible(runtime, '账户限额（Codex）', accountLines.join('\n'), 'usage_account', true));

  if (sessionUsage.records.length > 0 && sessionUsage.total) {
    elements.push(collapsible(
      runtime,
      `AAMP ACP 会话累计用量（${sessionUsage.records.length} 个会话）`,
      formatSessionUsage(sessionUsage),
      'usage_sessions',
    ));
  } else {
    elements.push(markdown(runtime, '_当前飞书会话还没有可读取的 AAMP ACP token 用量。_'));
  }

  elements.push(
    buttonRow('usage_actions', [
      button('usage_refresh', '刷新用量', actionValue('usage'), 'primary'),
      button('usage_status', '查看状态', actionValue('status'), 'default'),
    ]),
  );
  return buildCard(runtime, elements);
}

function buildCard(runtime, elements) {
  if (typeof runtime.buildCardShell === 'function') return runtime.buildCardShell(elements);
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { direction: 'vertical', vertical_spacing: '12px', elements },
  };
}

function markdown(runtime, content, elementId) {
  const value = typeof runtime.sanitizeCardText === 'function'
    ? runtime.sanitizeCardText(String(content))
    : String(content);
  return {
    tag: 'markdown',
    ...(elementId ? { element_id: elementId } : {}),
    content: value,
  };
}

function button(elementId, text, value, type) {
  return {
    tag: 'button',
    element_id: elementId,
    text: { tag: 'plain_text', content: text },
    size: 'tiny',
    type,
    value,
  };
}

function buttonRow(elementId, buttons) {
  return {
    tag: 'column_set',
    element_id: elementId,
    // Let action rows wrap on narrow mobile cards instead of clipping the
    // last buttons off-screen. A two-column row still renders as one line.
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: buttons.map((item) => ({
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [item],
    })),
  };
}

function taskActionRow(runtime, elementId, buttons) {
  return {
    tag: 'column_set',
    element_id: elementId,
    flex_mode: 'flow',
    horizontal_spacing: '4px',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [markdown(runtime, "<font color='grey'>操作</font>")],
      },
      ...buttons.map((item) => ({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [item],
      })),
    ],
  };
}

function collapsible(runtime, title, content, elementId, expanded = false) {
  return {
    tag: 'collapsible_panel',
    expanded,
    element_id: elementId,
    header: {
      title: {
        tag: 'markdown',
        content: safeCardText(runtime, `<font color='grey'>${title}</font>`),
      },
      vertical_align: 'center',
      padding: '0px 0px 0px 0px',
      icon: {
        tag: 'standard_icon',
        token: 'right-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: 90,
    },
    elements: [markdown(runtime, content, `${elementId}_content`)],
  };
}

function safeCardText(runtime, content) {
  return typeof runtime.sanitizeCardText === 'function'
    ? runtime.sanitizeCardText(String(content))
    : String(content);
}

function actionValue(command, taskId, source, extra) {
  return {
    kind: AAMP_COMMAND_ACTION_KIND,
    command,
    ...(taskId ? { taskId, commandText: `/${command} ${taskId}` } : {}),
    ...(source ? { source } : {}),
    ...(isRecord(extra) ? extra : {}),
  };
}

function cancelActionValue(task, source = 'recent') {
  return {
    kind: AAMP_TASK_CANCEL_ACTION_KIND,
    taskId: task.taskId,
    sourceMode: taskSourceMode(task),
    source,
  };
}

function hideActionValue(task) {
  return {
    kind: AAMP_TASK_HIDE_ACTION_KIND,
    taskId: task.taskId,
    sourceMode: taskSourceMode(task),
    source: 'recent',
  };
}

function eventWithActionValue(event, value) {
  if (!event?.action || typeof event.action !== 'object') return event;
  if (event.action.value === value) return event;
  return {
    ...event,
    action: {
      ...event.action,
      value,
    },
  };
}

async function hideTaskFromRecent(runtime, event, value) {
  if (value.source !== 'recent') return;
  const chatId = normalizeString(event?.chatId);
  const taskId = normalizeString(value.taskId);
  const task = taskId
    ? listRuntimeTasks(runtime, chatId, { includeHidden: true, includeAuxiliary: true })
      .find((candidate) => candidate.taskId === taskId && taskSourceMode(candidate) === taskSourceMode(value))
    : undefined;
  if (!chatId || !taskId || !task) return;

  try {
    if (typeof runtime.hideGlobalTask === 'function') {
      runtime.hideGlobalTask(taskId, chatId);
    } else if (typeof runtime.hideAampTask === 'function') {
      runtime.hideAampTask(taskId, chatId);
    }
  } catch (error) {
    runtime.logger?.error?.(`[AAMP compatibility] failed to persist hidden task=${taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  rememberHiddenTask(runtime, chatId, taskId);
  await refreshRecentCard(runtime, event);
}

function rememberHiddenTask(runtime, chatId, taskId) {
  let hiddenByChat = hiddenTaskIdsByRuntime.get(runtime);
  if (!hiddenByChat) {
    hiddenByChat = new Map();
    hiddenTaskIdsByRuntime.set(runtime, hiddenByChat);
  }
  let hiddenTaskIds = hiddenByChat.get(chatId);
  if (!hiddenTaskIds) {
    hiddenTaskIds = new Set();
    hiddenByChat.set(chatId, hiddenTaskIds);
  }
  hiddenTaskIds.add(taskId);
}

async function refreshRecentCard(runtime, event) {
  const chatId = normalizeString(event?.chatId);
  const messageId = normalizeString(event?.messageId);
  if (!chatId || !messageId || typeof runtime.channel?.updateCard !== 'function') return;
  try {
    await runtime.channel.updateCard(messageId, buildRecentCard(runtime, chatId));
  } catch (error) {
    runtime.logger?.error?.(`[AAMP compatibility] failed to refresh recent card: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readCommandActionValue(event) {
  const raw = event?.action?.value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function listRuntimeTasks(runtime, chatId, options = {}) {
  const normalizedChatId = normalizeString(chatId);
  const hiddenTaskIds = options.includeHidden === true
    ? new Set()
    : readHiddenTaskIds(runtime, normalizedChatId);
  const canonicalAampTasks = readAampCanonicalTaskStates();
  const persistedTasks = typeof runtime.listGlobalTasks === 'function'
    ? runtime.listGlobalTasks(normalizedChatId) || []
    : [];
  const liveAampTasks = Object.values(runtime.state?.tasks || {})
    .filter((task) => isRecord(task) && normalizeString(task.chatId) === normalizedChatId)
    .map((task) => ({ ...task, sourceMode: GLOBAL_TASK_MODES.AAMP }));
  const merged = new Map();
  for (const task of persistedTasks) {
    if (!isRecord(task) || normalizeString(task.chatId) !== normalizedChatId) continue;
    const canonical = taskSourceMode(task) === GLOBAL_TASK_MODES.AAMP
      ? canonicalAampTasks[normalizeString(task.taskId)]
      : undefined;
    merged.set(`${taskSourceMode(task)}:${normalizeString(task.taskId)}`, canonical
      ? { ...task, ...canonical, sourceMode: GLOBAL_TASK_MODES.AAMP }
      : task);
  }
  for (const task of liveAampTasks) {
    const key = `${GLOBAL_TASK_MODES.AAMP}:${normalizeString(task.taskId)}`;
    merged.set(key, {
      ...(merged.get(key) || {}),
      ...task,
      ...(canonicalAampTasks[normalizeString(task.taskId)] || {}),
      sourceMode: GLOBAL_TASK_MODES.AAMP,
    });
  }
  return [...merged.values()]
    .filter((task) => options.includeAuxiliary === true || !isAuxiliaryTask(task))
    .filter((task) => !hiddenTaskIds.has(normalizeString(task.taskId)))
    .sort((left, right) => timestampValue(right.updatedAt || right.createdAt) - timestampValue(left.updatedAt || left.createdAt));
}

function readHiddenTaskIds(runtime, chatId) {
  const hidden = new Set();
  if (!chatId) return hidden;

  const hiddenByChat = hiddenTaskIdsByRuntime.get(runtime);
  for (const taskId of hiddenByChat?.get(chatId) || []) hidden.add(taskId);

  if (typeof runtime.getAampHiddenTaskIds === 'function') {
    try {
      const persisted = runtime.getAampHiddenTaskIds(chatId);
      if (Array.isArray(persisted)) {
        for (const taskId of persisted) {
          const normalizedTaskId = normalizeString(taskId);
          if (normalizedTaskId) hidden.add(normalizedTaskId);
        }
      }
    } catch (error) {
      runtime.logger?.error?.(`[AAMP compatibility] failed to read hidden task list: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (typeof runtime.getGlobalHiddenTaskIds === 'function') {
    try {
      for (const taskId of runtime.getGlobalHiddenTaskIds(chatId) || []) {
        const normalizedTaskId = normalizeString(taskId);
        if (normalizedTaskId) hidden.add(normalizedTaskId);
      }
    } catch (error) {
      runtime.logger?.error?.(`[global commands] failed to read hidden task list: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return hidden;
}

function isAuxiliaryTask(task) {
  return stripLeadingMention(singleLine(task?.userMessageText)).startsWith('/');
}

function promptNeedsCollapse(request) {
  const text = String(request ?? '').trim();
  return text.includes('\n') || text.includes('\r') || singleLine(text).length > RECENT_PROMPT_INLINE_LIMIT;
}

function enrichTask(task, metadata) {
  if (!metadata) return task;
  return {
    ...task,
    projectName: task.projectName || metadata.projectName,
    repositoryRoot: task.repositoryRoot || metadata.repositoryRoot,
    branch: task.branch || metadata.branch,
    worktreePath: task.worktreePath || metadata.worktreePath,
    taskFile: task.taskFile || metadata.taskFile,
  };
}

function countTaskStatuses(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  return counts;
}

function formatStatusCounts(counts) {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => coloredText(`${displayStatus(status)} ${count}`, statusColor(status)))
    .join('、') || '暂无';
}

function displayStatus(status) {
  const normalized = normalizeString(status)?.toLowerCase();
  return STATUS_LABELS[normalized] || normalizeString(status) || '未知';
}

function displayTaskStatus(task) {
  if (task?.bridgeCancelledAt || ['canceled', 'cancelled'].includes(normalizeString(task?.status)?.toLowerCase())) {
    return '已中断';
  }
  return displayStatus(task?.status);
}

function statusColor(status) {
  return STATUS_COLORS[normalizeString(status)?.toLowerCase()] || 'grey';
}

function taskStatusColor(task) {
  if (task?.bridgeCancelledAt || ['canceled', 'cancelled'].includes(normalizeString(task?.status)?.toLowerCase())) {
    return 'grey';
  }
  return statusColor(task?.status);
}

function isCancellableTask(runtime, task) {
  return Boolean(task?.taskId)
    && currentRuntimeMode(runtime) === taskSourceMode(task)
    && !isTerminalTask(task);
}

function currentRuntimeMode(runtime) {
  return runtime?.globalTaskMode === GLOBAL_TASK_MODES.DIRECT
    ? GLOBAL_TASK_MODES.DIRECT
    : GLOBAL_TASK_MODES.AAMP;
}

function taskSourceMode(task) {
  return task?.sourceMode === GLOBAL_TASK_MODES.DIRECT
    ? GLOBAL_TASK_MODES.DIRECT
    : GLOBAL_TASK_MODES.AAMP;
}

function sourceModeLabel(mode) {
  return mode === GLOBAL_TASK_MODES.DIRECT ? 'Codex 直连' : 'AAMP';
}

function coloredText(value, color) {
  return `<font color='${color}'>${String(value)}</font>`;
}

function formatConnection(value) {
  return ({ connected: '已连接', connecting: '连接中', disconnected: '已断开' })[value] || value;
}

function isTerminalTask(task) {
  return Boolean(task?.bridgeCancelledAt)
    || ['completed', 'done', 'succeeded', 'rejected', 'failed', 'canceled', 'cancelled']
      .includes(normalizeString(task?.status)?.toLowerCase());
}

function parseRecentLimit(args) {
  const raw = args?.[0] === '--limit' ? args?.[1] : args?.[0];
  if (!raw) return MAX_RECENT_TASKS;
  const parsed = Number(raw.startsWith('--limit=') ? raw.slice(8) : raw);
  if (!Number.isInteger(parsed) || parsed < 1) return MAX_RECENT_TASKS;
  return Math.min(MAX_RECENT_TASKS, parsed);
}

function findTaskUsage(taskId) {
  const records = selectAcpSessionRecords([taskId]);
  const record = records[0];
  if (!record) return undefined;
  const usage = record.usage;
  if (!usage) return undefined;
  return {
    ...usage,
    model: record.model,
    session: record.name,
    updatedAt: record.lastUsedAt,
  };
}

function formatTaskUsage(usage) {
  const parts = [];
  if (usage.totalTokens != null) parts.push(`total=${formatNumber(usage.totalTokens)}`);
  if (usage.inputTokens != null) parts.push(`input=${formatNumber(usage.inputTokens)}`);
  const cachedTokens = sumNumbers(usage.cachedReadTokens, usage.cachedWriteTokens);
  if (cachedTokens != null) parts.push(`(+ ${formatNumber(cachedTokens)} cached)`);
  if (usage.outputTokens != null) parts.push(`output=${formatNumber(usage.outputTokens)}`);
  if (usage.thoughtTokens != null) parts.push(`(reasoning ${formatNumber(usage.thoughtTokens)})`);
  return `Token usage: ${parts.join(' ') || '暂无 token 字段。'}`;
}

function sumNumbers(...values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return numbers.length > 0 ? numbers.reduce((total, value) => total + value, 0) : undefined;
}

function formatSessionUsage(sessionUsage) {
  const lines = [
    ...(sessionUsage.total.inputTokens != null ? [`输入 tokens：${formatNumber(sessionUsage.total.inputTokens)}`] : []),
    ...(sessionUsage.total.outputTokens != null ? [`输出 tokens：${formatNumber(sessionUsage.total.outputTokens)}`] : []),
    ...(sessionUsage.total.cachedReadTokens != null ? [`缓存读取 tokens：${formatNumber(sessionUsage.total.cachedReadTokens)}`] : []),
    ...(sessionUsage.total.cachedWriteTokens != null ? [`缓存写入 tokens：${formatNumber(sessionUsage.total.cachedWriteTokens)}`] : []),
    ...(sessionUsage.total.thoughtTokens != null ? [`推理 tokens：${formatNumber(sessionUsage.total.thoughtTokens)}`] : []),
    ...(sessionUsage.total.totalTokens != null ? [`总 tokens：${formatNumber(sessionUsage.total.totalTokens)}`] : []),
  ];
  const recent = sessionUsage.records.slice(0, 5).map((record) => (
    `- ${record.name || '(unnamed)'}${record.model ? ` · ${record.model}` : ''}${record.usage?.totalTokens != null ? ` · ${formatNumber(record.usage.totalTokens)} tokens` : ''}`
  ));
  if (recent.length > 0) lines.push('', '会话明细：', ...recent);
  return lines.join('\n') || '没有可用 token 字段。';
}

function collectAcpSessionUsage(taskIds) {
  if (!taskIds || taskIds.length === 0) return { records: [], total: undefined };
  const records = selectAcpSessionRecords(taskIds);
  const total = sumUsage(records.map((record) => record.usage).filter(Boolean));
  return { records, total };
}

function selectAcpSessionRecords(taskIds, options = {}) {
  const records = readAcpSessionRecords();
  const normalizedTaskIds = Array.isArray(taskIds)
    ? taskIds.map(normalizeString).filter(Boolean)
    : [];
  if (normalizedTaskIds.length === 0) return records.slice(0, 20);
  const matched = records.filter((record) => normalizedTaskIds.some((taskId) => record.raw.includes(taskId)));
  if (matched.length > 0 || options.fallbackToRecent !== true) return matched.slice(0, 20);
  return records.slice(0, 5);
}

function readAcpSessionRecords() {
  const directory = resolve(process.env.AAMP_COMMAND_ACPX_SESSIONS_DIR || join(homedir(), '.acpx', 'sessions'));
  const files = recentFiles(directory, '.json', MAX_USAGE_FILES);
  const records = [];
  for (const filePath of files) {
    const raw = safeRead(filePath);
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const name = normalizeString(parsed.name);
    if (!name?.startsWith('aamp-') && !normalizeString(parsed.agent_command)?.includes('codex')) continue;
    records.push({
      raw,
      name,
      model: normalizeString(parsed.acpx?.current_model_id),
      lastUsedAt: normalizeString(parsed.last_used_at) || normalizeString(parsed.updated_at),
      usage: normalizeTokenUsage(parsed.cumulative_token_usage),
    });
  }
  return records.sort((left, right) => timestampValue(right.lastUsedAt) - timestampValue(left.lastUsedAt));
}

function normalizeTokenUsage(value) {
  if (!isRecord(value)) return undefined;
  const usage = {
    inputTokens: numberValue(value.input_tokens ?? value.inputTokens),
    outputTokens: numberValue(value.output_tokens ?? value.outputTokens),
    cachedReadTokens: numberValue(value.cache_read_input_tokens ?? value.cachedReadTokens),
    cachedWriteTokens: numberValue(value.cache_creation_input_tokens ?? value.cachedWriteTokens),
    thoughtTokens: numberValue(value.thought_tokens ?? value.thoughtTokens),
    totalTokens: numberValue(value.total_tokens ?? value.totalTokens),
  };
  const present = Object.values(usage).some((value) => value != null);
  return present ? Object.fromEntries(Object.entries(usage).filter(([, value]) => value != null)) : undefined;
}

function sumUsage(usages) {
  const total = {};
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage || {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      total[key] = (total[key] || 0) + value;
    }
  }
  return Object.keys(total).length > 0 ? total : undefined;
}

function readLatestCodexRateLimits() {
  const directory = resolve(process.env.AAMP_COMMAND_CODEX_SESSIONS_DIR || join(homedir(), '.codex', 'sessions'));
  const files = recentFiles(directory, '.jsonl', MAX_CODEX_RATE_LIMIT_FILES);
  let latest;
  for (const filePath of files) {
    const raw = readTail(filePath, MAX_CODEX_RATE_LIMIT_FILE_BYTES);
    if (!raw) continue;
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseJson(lines[index]);
      const rateLimits = extractRateLimits(entry);
      if (!rateLimits) continue;
      const timestamp = normalizeString(entry?.timestamp) || normalizeString(entry?.payload?.timestamp);
      const candidate = {
        rateLimits,
        timestamp: timestamp || fileTimestamp(filePath),
        source: filePath,
      };
      if (!latest || timestampValue(candidate.timestamp) >= timestampValue(latest.timestamp)) latest = candidate;
      break;
    }
  }
  return latest;
}

function extractRateLimits(entry) {
  if (!isRecord(entry)) return undefined;
  for (const value of [
    entry.rate_limits,
    entry.rateLimits,
    entry.payload?.rate_limits,
    entry.payload?.rateLimits,
    entry.payload?.info?.rate_limits,
    entry.payload?.info?.rateLimits,
  ]) {
    if (isRecord(value)) return value;
  }
  return undefined;
}

function formatRateLimits(rateLimits) {
  const lines = [];
  for (const [label, key] of [['5 小时窗口', 'primary'], ['周窗口', 'secondary']]) {
    const window = rateLimits?.[key];
    if (!isRecord(window)) continue;
    const used = numberValue(window.used_percent ?? window.usedPercent);
    const reset = numberValue(window.resets_at ?? window.resetsAt);
    lines.push([
      `${label}：${used == null ? '未知' : `已用 ${formatPercent(used)}，剩余 ${formatPercent(Math.max(0, 100 - used))}`}`,
      reset == null ? '' : `重置 ${formatTimestamp(new Date(reset * 1000).toISOString())}`,
    ].filter(Boolean).join('，'));
  }
  const credits = rateLimits?.credits;
  if (isRecord(credits)) {
    if (credits.unlimited === true) lines.push('Credits：无限');
    else if (credits.balance != null) lines.push(`Credits：余额 ${String(credits.balance)}`);
    else if (credits.has_credits === true || credits.hasCredits === true) lines.push('Credits：可用');
  }
  return lines.length > 0 ? lines : ['账户限额字段暂不可用。'];
}

function loadWorktreeMetadata() {
  const result = new Map();
  const configuredDirectory = normalizeString(process.env.AAMP_CODEX_WORKTREE_METADATA_DIR);
  if (!configuredDirectory) return result;
  const directory = resolve(configuredDirectory);
  for (const filePath of recentFiles(directory, '.json', 400)) {
    const parsed = parseJson(safeRead(filePath));
    const taskId = normalizeString(parsed?.taskId);
    if (taskId) result.set(taskId, parsed);
  }
  return result;
}

function recentFiles(directory, extension, limit) {
  if (!directory || !existsSync(directory)) return [];
  const files = [];
  walkFiles(directory, extension, files, 5);
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.path);
}

function walkFiles(directory, extension, output, depth) {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(filePath, extension, output, depth - 1);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    try {
      output.push({ path: filePath, mtimeMs: statSync(filePath).mtimeMs });
    } catch {
      // The session may be rotated while the command is reading it.
    }
  }
}

function safeRead(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function readTail(filePath, maxBytes) {
  let fd;
  try {
    const size = statSync(filePath).size;
    fd = openSync(filePath, 'r');
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const offset = Math.max(0, size - length);
    const bytesRead = requireRead(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function requireRead(fd, buffer, offset, length, position) {
  // Kept in a helper so a partial read is handled without pulling in a stream.
  let total = 0;
  while (total < length) {
    const count = readSyncCompat(fd, buffer, offset + total, length - total, position + total);
    if (!count) break;
    total += count;
  }
  return total;
}

function readSyncCompat(fd, buffer, offset, length, position) {
  // Node's readSync is available in every supported runtime.
  return readSync(fd, buffer, offset, length, position);
}

function fileTimestamp(filePath) {
  try {
    return new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

function parseJson(value) {
  if (!value || typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function formatTimestamp(value) {
  if (!value) return '(未知)';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return truncate(String(value), 80);
  return date.toLocaleString('zh-CN');
}

function timestampValue(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

function formatPercent(value) {
  return `${Number(value).toFixed(Number.isInteger(value) ? 0 : 1)}%`;
}

function uniqueStrings(values) {
  return [...new Set(values.map(normalizeString).filter(Boolean))];
}

function normalizeString(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function safeText(value) {
  return normalizeString(value) || '';
}

function singleLine(value) {
  return safeText(value).replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
