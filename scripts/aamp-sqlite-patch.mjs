import { dirname, extname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireNode = createRequire(import.meta.url);
const { DatabaseSync } = requireNode('node:' + 'sqlite');

const PATCHED = Symbol.for('feishu-codex-bridge.aamp-sqlite-patched');
const stores = new Map();
const AAMP_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'cancelled']);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS aamp_tasks (
  aamp_task_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_text TEXT,
  image_local_paths TEXT NOT NULL DEFAULT '[]',
  card_id TEXT,
  card_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_msg TEXT,
  last_delta_text TEXT NOT NULL DEFAULT '',
  approval_state TEXT,
  session_snapshot TEXT,
  relay_status_json TEXT,
  last_event_type TEXT,
  last_event_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_aamp_tasks_status ON aamp_tasks(status, updated_at);
CREATE TABLE IF NOT EXISTS aamp_hidden_tasks (
  chat_id TEXT NOT NULL,
  aamp_task_id TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, aamp_task_id)
);
`;

/**
 * Persist Feishu bridge business state at the same lifecycle boundaries used
 * by the official runtime. AAMP/Relay remains the execution transport; this
 * patch does not create a queue or poll SQLite for work.
 */
export function patchAampSqlite(Runtime) {
  const prototype = Runtime?.prototype;
  if (!prototype || prototype[PATCHED]) return;
  const required = [
    'dispatchTask',
    'handleTaskAck',
    'handleTaskStreamOpened',
    'handleStreamEvent',
    'handleTaskResult',
    'handleTaskHelp',
    'handleCardAction',
    'startStreamCardSession',
    'sendOrUpdateTerminalCard',
    'sendHelpCard',
    'registerAampHandlers',
    'stop',
  ];
  for (const method of required) {
    if (typeof prototype[method] !== 'function') {
      throw new Error(`AAMP SQLite persistence: missing ${method}; review upstream update`);
    }
  }

  const originalDispatch = prototype.dispatchTask;
  const originalAck = prototype.handleTaskAck;
  const originalStreamOpened = prototype.handleTaskStreamOpened;
  const originalStreamEvent = prototype.handleStreamEvent;
  const originalResult = prototype.handleTaskResult;
  const originalHelp = prototype.handleTaskHelp;
  const originalCardAction = prototype.handleCardAction;
  const originalStreamCard = prototype.startStreamCardSession;
  const originalTerminalCard = prototype.sendOrUpdateTerminalCard;
  const originalHelpCard = prototype.sendHelpCard;
  const originalRegister = prototype.registerAampHandlers;
  const originalStop = prototype.stop;

  Object.defineProperty(prototype, 'globalTaskMode', {
    configurable: true,
    get() { return 'aamp'; },
  });

  // Command cards use the same SQLite connection as task business state, but
  // hiding is deliberately separate from task status and task deletion.
  prototype.getAampHiddenTaskIds = function (chatId) {
    const store = getStore();
    return store ? store.hiddenTaskIds(chatId) : [];
  };
  prototype.hideAampTask = function (taskId, chatId) {
    const store = getStore();
    return store ? store.hideTask(taskId, chatId) : false;
  };
  prototype.listGlobalTasks = function (chatId) {
    const store = getStore();
    return store ? store.listGlobalTasks(chatId) : [];
  };
  prototype.getGlobalHiddenTaskIds = function (chatId) {
    const store = getStore();
    return store ? store.hiddenTaskIds(chatId) : [];
  };
  prototype.hideGlobalTask = function (taskId, chatId) {
    const store = getStore();
    return store ? store.hideTask(taskId, chatId) : false;
  };

  prototype.dispatchTask = async function (task, options = {}) {
    const store = getStore();
    const imagePaths = store ? materializeImageAttachments(task.taskId, options.attachments) : [];
    if (store) {
      store.initialize(task, options, imagePaths);
    }
    try {
      return await originalDispatch.call(this, task, options);
    } catch (error) {
      persist(this, task.taskId, {
        status: 'failed',
        errorMsg: errorMessage(error),
        eventType: 'task.dispatch.failed',
        event: { error: errorMessage(error) },
      });
      throw error;
    }
  };

  prototype.handleTaskAck = async function (task) {
    try {
      return await originalAck.call(this, task);
    } finally {
      persist(this, task?.taskId, {
        status: 'running',
        eventType: 'task.ack',
        event: task,
      });
    }
  };

  prototype.handleTaskStreamOpened = async function (task) {
    try {
      return await originalStreamOpened.call(this, task);
    } finally {
      persist(this, task?.taskId, {
        status: 'running',
        eventType: 'task.stream.opened',
        event: task,
      });
    }
  };

  prototype.handleStreamEvent = async function (taskId, event) {
    try {
      return await originalStreamEvent.call(this, taskId, event);
    } finally {
      const state = runtimeTask(this, taskId);
      persist(this, taskId, {
        status: 'running',
        lastDeltaText: state?.streamText || state?.outputText || undefined,
        eventType: event?.type || 'task.update',
        event,
      });
    }
  };

  prototype.handleTaskResult = async function (task) {
    try {
      return await originalResult.call(this, task);
    } finally {
      const state = runtimeTask(this, task?.taskId);
      persist(this, task?.taskId, {
        status: task?.status === 'completed' ? 'done' : 'failed',
        errorMsg: task?.errorMsg || state?.resultError || null,
        lastDeltaText: task?.output || state?.outputText || undefined,
        eventType: task?.status === 'completed' ? 'task.result' : 'task.failed',
        event: task,
      });
    }
  };

  prototype.handleTaskHelp = async function (task) {
    try {
      return await originalHelp.call(this, task);
    } finally {
      persist(this, task?.taskId, {
        status: 'running',
        approvalState: 'waiting',
        eventType: 'task.help_needed',
        event: task,
      });
    }
  };

  prototype.handleCardAction = async function (event) {
    const value = event?.action?.value;
    const taskId = typeof value?.taskId === 'string' ? value.taskId : '';
    if (taskId) {
      persist(this, taskId, {
        approvalState: value?.kind === 'task_cancel' ? 'cancelled' : 'submitted',
        status: value?.kind === 'task_cancel' ? 'cancelled' : undefined,
        eventType: 'card.action',
        event,
      });
    }
    return originalCardAction.call(this, event);
  };

  prototype.startStreamCardSession = async function (task, replyTarget) {
    const result = await originalStreamCard.call(this, task, replyTarget);
    persist(this, task?.taskId, {
      cardId: this.cardSessions?.get?.(task.taskId)?.cardId || null,
      cardMessageId: this.cardSessions?.get?.(task.taskId)?.messageId || task?.bridgeMessageId || null,
      eventType: 'card.created',
      event: { taskId: task?.taskId },
    });
    return result;
  };

  prototype.sendOrUpdateTerminalCard = async function (task, options = {}) {
    try {
      return await originalTerminalCard.call(this, task, options);
    } finally {
      persist(this, task?.taskId, {
        cardId: this.cardSessions?.get?.(task?.taskId)?.cardId || undefined,
        cardMessageId: task?.bridgeMessageId || null,
        lastDeltaText: task?.outputText || task?.streamText || undefined,
        eventType: 'card.terminal',
        event: { taskId: task?.taskId },
      });
    }
  };

  prototype.sendHelpCard = async function (task) {
    try {
      return await originalHelpCard.call(this, task);
    } finally {
      persist(this, task?.taskId, {
        approvalState: 'waiting',
        cardMessageId: task?.helpCardMessageId || task?.bridgeMessageId || null,
        eventType: 'card.help',
        event: { taskId: task?.taskId },
      });
    }
  };

  prototype.registerAampHandlers = function (...args) {
    const result = originalRegister.apply(this, args);
    const client = this.aamp;
    if (client && typeof client.on === 'function') {
      client.on('task.failed', (task) => {
        void this.handleTaskResult({ ...task, status: 'failed' }).catch((error) => {
          console.error(`[AAMP SQLite persistence] failed task.failed handling: ${errorMessage(error)}`);
        });
      });
    }
    return result;
  };

  prototype.stop = async function (...args) {
    try {
      return await originalStop.apply(this, args);
    } finally {
      closeStores();
    }
  };

  Object.defineProperty(prototype, PATCHED, { value: true });
  console.error('[AAMP compatibility] SQLite business-state persistence active');
}

function getStore() {
  const configuredPath = process.env.AAMP_BRIDGE_SQLITE_PATH;
  if (!configuredPath) return undefined;
  const filePath = resolve(configuredPath);
  const existing = stores.get(filePath);
  if (existing) return existing;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new AampSqliteDatabase(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  const store = new SqliteStore(db);
  stores.set(filePath, store);
  return store;
}

class AampSqliteDatabase {
  constructor(filePath) {
    this.raw = new DatabaseSync(filePath);
    this.open = true;
    this.transactionDepth = 0;
  }

  prepare(sql) {
    return this.raw.prepare(sql);
  }

  exec(sql) {
    return this.raw.exec(sql);
  }

  transaction(callback) {
    const outer = this.transactionDepth === 0;
    const savepoint = `aamp_tx_${this.transactionDepth}`;
    if (outer) this.raw.exec('BEGIN');
    else this.raw.exec(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = callback();
      this.transactionDepth -= 1;
      if (outer) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (outer) {
        try {
          this.raw.exec('ROLLBACK');
        } finally {
          throw error;
        }
      }
      this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  close() {
    if (!this.open) return;
    try {
      this.raw.close();
    } finally {
      this.open = false;
    }
  }
}

class SqliteStore {
  constructor(db) {
    this.db = db;
  }

  initialize(task, options, imagePaths) {
    const taskId = required(task?.taskId, 'taskId');
    const chatId = required(task?.chatId || task?.dispatchContext?.chat_id || 'unknown', 'chatId');
    const now = new Date().toISOString();
    const userText = options?.bodyText || task?.userMessageText || null;
    const snapshot = jsonSnapshot(task);
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT aamp_task_id FROM aamp_tasks WHERE aamp_task_id = ?').get(taskId);
      if (existing) {
        this.db.prepare(`UPDATE aamp_tasks SET chat_id = ?, user_text = COALESCE(?, user_text),
          image_local_paths = CASE WHEN ? = '[]' THEN image_local_paths ELSE ? END,
          session_snapshot = COALESCE(?, session_snapshot), updated_at = ? WHERE aamp_task_id = ?`)
          .run(chatId, userText, JSON.stringify(imagePaths), JSON.stringify(imagePaths), snapshot, now, taskId);
        return;
      }
      this.db.prepare(`INSERT INTO aamp_tasks
        (aamp_task_id, chat_id, user_text, image_local_paths, card_id, card_message_id, status,
         created_at, updated_at, error_msg, last_delta_text, approval_state, session_snapshot,
         relay_status_json, last_event_type, last_event_json)
        VALUES (?, ?, ?, ?, NULL, NULL, 'pending', ?, ?, NULL, '', 'pending', ?, NULL, 'task.dispatch', ?)`)
        .run(taskId, chatId, userText, JSON.stringify(imagePaths), now, now, snapshot, jsonSnapshot({ task, options }));
    });
  }

  update(taskId, patch, runtime) {
    const normalizedId = typeof taskId === 'string' ? taskId.trim() : '';
    if (!normalizedId) return;
    const state = runtimeTask(runtime, normalizedId);
    const row = this.db.prepare('SELECT * FROM aamp_tasks WHERE aamp_task_id = ?').get(normalizedId);
    // A replayed mailbox ack/stream event can arrive after a task has already
    // reached a terminal state. Never downgrade done/failed/cancelled history
    // back to running; this is especially important when direct mode reads the
    // shared database while AAMP is stopped.
    if (row && isTerminalAampStatus(row.status)
      && patch.status && !isTerminalAampStatus(patch.status)) {
      return;
    }
    const now = new Date().toISOString();
    if (!row) {
      const chatId = required(state?.chatId || state?.dispatchContext?.chat_id || 'unknown', 'chatId');
      this.db.prepare(`INSERT INTO aamp_tasks
        (aamp_task_id, chat_id, user_text, image_local_paths, card_id, card_message_id, status,
         created_at, updated_at, error_msg, last_delta_text, approval_state, session_snapshot,
         relay_status_json, last_event_type, last_event_json)
        VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
        .run(
          normalizedId,
          chatId,
          state?.userMessageText || null,
          cardId(runtime, normalizedId, state),
          cardMessageId(runtime, normalizedId, state),
          patch.status || 'pending',
          now,
          now,
          patch.errorMsg || null,
          patch.lastDeltaText || state?.streamText || state?.outputText || '',
          patch.approvalState || null,
          patch.eventType || 'task.update',
          jsonSnapshot(patch.event),
        );
      return;
    }
    const nextStatus = AAMP_STATUSES.has(patch.status) ? patch.status : row.status;
    const nextDelta = patch.lastDeltaText === undefined
      ? (state?.streamText || state?.outputText || row.last_delta_text || '')
      : patch.lastDeltaText;
    this.db.prepare(`UPDATE aamp_tasks SET
      chat_id = ?, user_text = ?, image_local_paths = ?, card_id = ?, card_message_id = ?,
      status = ?, updated_at = ?, error_msg = ?, last_delta_text = ?, approval_state = ?,
      session_snapshot = ?, relay_status_json = ?, last_event_type = ?, last_event_json = ?
      WHERE aamp_task_id = ?`).run(
      state?.chatId || row.chat_id,
      state?.userMessageText || row.user_text,
      row.image_local_paths,
      patch.cardId === undefined ? (cardId(runtime, normalizedId, state) || row.card_id) : patch.cardId,
      patch.cardMessageId === undefined ? (cardMessageId(runtime, normalizedId, state) || row.card_message_id) : patch.cardMessageId,
      nextStatus,
      now,
      patch.errorMsg === undefined ? row.error_msg : patch.errorMsg,
      nextDelta,
      patch.approvalState === undefined ? row.approval_state : patch.approvalState,
      jsonSnapshot(state) || row.session_snapshot,
      patch.relayStatus === undefined ? row.relay_status_json : jsonSnapshot(patch.relayStatus),
      patch.eventType || row.last_event_type,
      patch.event === undefined ? row.last_event_json : jsonSnapshot(patch.event),
      normalizedId,
    );
  }

  hiddenTaskIds(chatId) {
    const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
    if (!normalizedChatId) return [];
    return this.db
      .prepare('SELECT aamp_task_id FROM aamp_hidden_tasks WHERE chat_id = ? ORDER BY hidden_at DESC')
      .all(normalizedChatId)
      .map((row) => row.aamp_task_id);
  }

  hideTask(taskId, chatId) {
    const normalizedTaskId = required(taskId, 'taskId');
    const normalizedChatId = required(chatId, 'chatId');
    this.db.prepare(`
      INSERT INTO aamp_hidden_tasks (chat_id, aamp_task_id, hidden_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, aamp_task_id) DO UPDATE SET hidden_at = excluded.hidden_at
    `).run(normalizedChatId, normalizedTaskId, new Date().toISOString());
    return true;
  }

  listGlobalTasks(chatId) {
    const normalizedChatId = required(chatId, 'chatId');
    const tasks = this.db.prepare(`SELECT * FROM aamp_tasks
      WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 200`).all(normalizedChatId)
      .map(globalAampTask);
    if (this.hasTable('bridge_tasks')) {
      tasks.push(...this.db.prepare(`SELECT * FROM bridge_tasks
        WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 200`).all(normalizedChatId)
        .map(globalDirectTask));
    }
    return tasks.sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
  }

  hasTable(tableName) {
    return Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = ? LIMIT 1`).get(tableName));
  }
}

function globalAampTask(row) {
  const snapshot = parseJson(row.session_snapshot) || {};
  return {
    ...snapshot,
    taskId: String(row.aamp_task_id),
    chatId: String(row.chat_id),
    sourceMode: 'aamp',
    status: normalizeAampStatus(row.status),
    userMessageText: row.user_text || snapshot.userMessageText || '',
    title: snapshot.title || 'AAMP 任务',
    outputText: row.last_delta_text || snapshot.outputText || '',
    resultError: row.error_msg || snapshot.resultError || null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function globalDirectTask(row) {
  const status = String(row.status || '').toLowerCase();
  return {
    taskId: String(row.bridge_task_id),
    chatId: String(row.chat_id),
    senderId: String(row.sender_id),
    sourceMode: 'direct',
    status,
    title: 'Codex 直连任务',
    userMessageText: row.text || '',
    outputText: row.final_response || '',
    resultError: row.error || null,
    threadId: row.thread_id || null,
    progressText: row.last_progress_text || '',
    bridgeCancelledAt: status === 'cancelled' ? row.updated_at : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeAampStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'done') return 'completed';
  return normalized;
}

function isTerminalAampStatus(status) {
  return ['done', 'failed', 'cancelled'].includes(String(status || '').toLowerCase());
}

function parseJson(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function timestampValue(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function persist(runtime, taskId, patch) {
  const store = getStore();
  if (!store) return;
  store.update(taskId, patch, runtime);
}

function runtimeTask(runtime, taskId) {
  return taskId && runtime?.state?.tasks?.[taskId];
}

function cardId(runtime, taskId, task) {
  return runtime?.cardSessions?.get?.(taskId)?.cardId || task?.cardId || null;
}

function cardMessageId(runtime, taskId, task) {
  return runtime?.cardSessions?.get?.(taskId)?.messageId
    || task?.bridgeMessageId
    || task?.helpCardMessageId
    || null;
}

function materializeImageAttachments(taskId, attachments) {
  const directory = process.env.AAMP_BRIDGE_ATTACHMENTS_DIR;
  if (!directory || !Array.isArray(attachments) || !taskId) return [];
  const taskDirectory = join(resolve(directory), safePathSegment(taskId));
  mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const [index, attachment] of attachments.entries()) {
    const contentType = typeof attachment?.contentType === 'string' ? attachment.contentType : '';
    const filename = typeof attachment?.filename === 'string' ? attachment.filename : '';
    if (!contentType.startsWith('image/') && !isImageFilename(filename)) continue;
    if (!Buffer.isBuffer(attachment?.content)) continue;
    const safeName = safePathSegment(filename || `image-${index + 1}${extensionFor(contentType)}`);
    const filePath = join(taskDirectory, `${String(index + 1).padStart(3, '0')}-${safeName}`);
    writeFileSync(filePath, attachment.content, { mode: 0o600 });
    paths.push(filePath);
  }
  return paths;
}

function isImageFilename(filename) {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff']
    .includes(extname(filename).toLowerCase());
}

function extensionFor(contentType) {
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  })[contentType] || '.bin';
}

function safePathSegment(value) {
  const normalized = String(value || 'item').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160) || 'item';
  return normalized === '.' || normalized === '..' ? 'item' : normalized;
}

function jsonSnapshot(value) {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value, (_key, nested) => {
      if (Buffer.isBuffer(nested) || isBufferJson(nested)) return '[binary]';
      return nested;
    });
    if (!text) return null;
    if (text.length <= 512 * 1024) return text;
    return JSON.stringify({
      truncated: true,
      snapshot: text.slice(0, 512 * 1024 - 64),
    });
  } catch {
    return null;
  }
}

function isBufferJson(value) {
  return value
    && typeof value === 'object'
    && value.type === 'Buffer'
    && Array.isArray(value.data);
}

function required(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${field} is required for AAMP SQLite persistence`);
  return normalized;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function closeStores() {
  for (const store of stores.values()) {
    try {
      if (store.db.open) store.db.close();
    } catch {
      // The service is already stopping; do not mask the original shutdown result.
    }
  }
  stores.clear();
}
