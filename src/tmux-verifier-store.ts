import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DatabaseSync, type SqliteDatabase } from "./sqlite.js";

export const TMUX_SESSION_STATUSES = [
  "STARTING",
  "RUNNING",
  "EXITED",
  "FAILED",
  "STOPPED",
] as const;
export type TmuxSessionStatus = (typeof TMUX_SESSION_STATUSES)[number];

export const TMUX_MESSAGE_STATUSES = ["PENDING", "SENT", "FAILED"] as const;
export type TmuxMessageStatus = (typeof TMUX_MESSAGE_STATUSES)[number];

export interface TmuxSessionRecord {
  session_id: string;
  client_request_id: string | null;
  machine: string;
  cwd: string;
  codex_path: string;
  tmux_socket: string;
  tmux_session: string;
  status: TmuxSessionStatus;
  error: string | null;
  last_screen: string;
  last_event_id: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface TmuxEvent {
  event_id: number;
  session_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TmuxMessageRecord {
  session_id: string;
  client_message_id: string;
  text: string;
  text_hash: string;
  source: "web" | "terminal";
  status: TmuxMessageStatus;
  delivery_attempts: number;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface PreparedTmuxMessage {
  created: boolean;
  message: TmuxMessageRecord;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tmux_sessions (
  session_id TEXT PRIMARY KEY,
  client_request_id TEXT UNIQUE,
  machine TEXT NOT NULL,
  cwd TEXT NOT NULL,
  codex_path TEXT NOT NULL,
  tmux_socket TEXT NOT NULL,
  tmux_session TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('STARTING', 'RUNNING', 'EXITED', 'FAILED', 'STOPPED')),
  error TEXT,
  last_screen TEXT NOT NULL DEFAULT '',
  last_event_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS tmux_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES tmux_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tmux_messages (
  session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'terminal')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (session_id, client_message_id),
  FOREIGN KEY (session_id) REFERENCES tmux_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tmux_events_session
  ON tmux_events(session_id, event_id);
CREATE INDEX IF NOT EXISTS idx_tmux_sessions_status
  ON tmux_sessions(status, updated_at);
`;

export class TmuxVerifierStore {
  private readonly db: SqliteDatabase;
  private readonly now: () => Date;

  constructor(
    databasePath: string,
    now: () => Date = () => new Date(),
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.now = now;
    this.db.exec(SCHEMA);
  }

  public close(): void {
    this.db.close();
  }

  public createSession(args: {
    sessionId: string;
    clientRequestId?: string;
    machine: string;
    cwd: string;
    codexPath: string;
    tmuxSocket: string;
    tmuxSession: string;
  }): TmuxSessionRecord {
    const now = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO tmux_sessions (
          session_id, client_request_id, machine, cwd, codex_path,
          tmux_socket, tmux_session, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'STARTING', ?, ?)`,
      )
      .run(
        args.sessionId,
        args.clientRequestId ?? null,
        args.machine,
        args.cwd,
        args.codexPath,
        args.tmuxSocket,
        args.tmuxSession,
        now,
        now,
      );
    return this.getSession(args.sessionId)!;
  }

  public getSession(sessionId: string): TmuxSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM tmux_sessions WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : null;
  }

  public getSessionByClientRequestId(clientRequestId: string): TmuxSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM tmux_sessions WHERE client_request_id = ?")
      .get(clientRequestId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : null;
  }

  public listSessions(limit = 100): TmuxSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tmux_sessions ORDER BY updated_at DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, limit))) as Record<string, unknown>[];
    return rows.map(mapSession);
  }

  public updateSession(
    sessionId: string,
    update: {
      status?: TmuxSessionStatus;
      error?: string | null;
      startedAt?: string | null;
      endedAt?: string | null;
    },
  ): TmuxSessionRecord | null {
    const current = this.getSession(sessionId);
    if (!current) return null;
    const now = this.timestamp();
    this.db
      .prepare(
        `UPDATE tmux_sessions SET
          status = ?, error = ?, started_at = ?, ended_at = ?, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(
        update.status ?? current.status,
        update.error === undefined ? current.error : update.error,
        update.startedAt === undefined ? current.started_at : update.startedAt,
        update.endedAt === undefined ? current.ended_at : update.endedAt,
        now,
        sessionId,
      );
    return this.getSession(sessionId);
  }

  public recordSnapshot(sessionId: string, screen: string): TmuxEvent | null {
    const current = this.getSession(sessionId);
    if (!current || current.last_screen === screen) return null;
    return this.transaction(() => {
      const event = this.insertEvent(sessionId, "terminal.snapshot", { screen });
      this.db
        .prepare(
          "UPDATE tmux_sessions SET last_screen = ?, last_event_id = ?, updated_at = ? WHERE session_id = ?",
        )
        .run(screen, event.event_id, this.timestamp(), sessionId);
      return event;
    });
  }

  public appendEvent(
    sessionId: string,
    kind: string,
    payload: Record<string, unknown> = {},
  ): TmuxEvent {
    return this.transaction(() => {
      const event = this.insertEvent(sessionId, kind, payload);
      this.db
        .prepare(
          "UPDATE tmux_sessions SET last_event_id = ?, updated_at = ? WHERE session_id = ?",
        )
        .run(event.event_id, this.timestamp(), sessionId);
      return event;
    });
  }

  public getEvent(eventId: number): TmuxEvent | null {
    const row = this.db
      .prepare("SELECT * FROM tmux_events WHERE event_id = ?")
      .get(eventId) as Record<string, unknown> | undefined;
    return row ? mapEvent(row) : null;
  }

  public listEvents(sessionId: string, afterEventId = 0, limit = 500): TmuxEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tmux_events
         WHERE session_id = ? AND event_id > ?
         ORDER BY event_id ASC LIMIT ?`,
      )
      .all(sessionId, Math.max(0, afterEventId), Math.min(2_000, Math.max(1, limit))) as Record<string, unknown>[];
    return rows.map(mapEvent);
  }

  public prepareMessage(args: {
    sessionId: string;
    clientMessageId: string;
    text: string;
    textHash: string;
    source: "web" | "terminal";
  }): PreparedTmuxMessage {
    const existing = this.getMessage(args.sessionId, args.clientMessageId);
    if (existing) return { created: false, message: existing };
    const now = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO tmux_messages (
          session_id, client_message_id, text, text_hash, source, status,
          delivery_attempts, error, created_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', 1, NULL, ?, NULL)`,
      )
      .run(
        args.sessionId,
        args.clientMessageId,
        args.text,
        args.textHash,
        args.source,
        now,
      );
    return { created: true, message: this.getMessage(args.sessionId, args.clientMessageId)! };
  }

  public getMessage(sessionId: string, clientMessageId: string): TmuxMessageRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tmux_messages WHERE session_id = ? AND client_message_id = ?",
      )
      .get(sessionId, clientMessageId) as Record<string, unknown> | undefined;
    return row ? mapMessage(row) : null;
  }

  public listMessages(sessionId: string, limit = 200): TmuxMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tmux_messages
         WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, Math.min(1_000, Math.max(1, limit))) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  public markMessageSent(sessionId: string, clientMessageId: string): TmuxMessageRecord | null {
    this.db
      .prepare(
        `UPDATE tmux_messages SET status = 'SENT', error = NULL, delivered_at = ?
         WHERE session_id = ? AND client_message_id = ?`,
      )
      .run(this.timestamp(), sessionId, clientMessageId);
    return this.getMessage(sessionId, clientMessageId);
  }

  public markMessageFailed(
    sessionId: string,
    clientMessageId: string,
    error: string,
  ): TmuxMessageRecord | null {
    this.db
      .prepare(
        `UPDATE tmux_messages SET status = 'FAILED', error = ?
         WHERE session_id = ? AND client_message_id = ?`,
      )
      .run(error.slice(0, 2_000), sessionId, clientMessageId);
    return this.getMessage(sessionId, clientMessageId);
  }

  private insertEvent(
    sessionId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): TmuxEvent {
    const createdAt = this.timestamp();
    const result = this.db
      .prepare(
        `INSERT INTO tmux_events (session_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, kind, JSON.stringify(payload), createdAt);
    return {
      event_id: Number(result.lastInsertRowid),
      session_id: sessionId,
      kind,
      payload,
      created_at: createdAt,
    };
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function mapSession(row: Record<string, unknown>): TmuxSessionRecord {
  return {
    session_id: String(row.session_id),
    client_request_id: nullableString(row.client_request_id),
    machine: String(row.machine),
    cwd: String(row.cwd),
    codex_path: String(row.codex_path),
    tmux_socket: String(row.tmux_socket),
    tmux_session: String(row.tmux_session),
    status: String(row.status) as TmuxSessionStatus,
    error: nullableString(row.error),
    last_screen: String(row.last_screen ?? ""),
    last_event_id: Number(row.last_event_id ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    started_at: nullableString(row.started_at),
    ended_at: nullableString(row.ended_at),
  };
}

function mapEvent(row: Record<string, unknown>): TmuxEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.payload_json)) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = { raw: String(row.payload_json) };
  }
  return {
    event_id: Number(row.event_id),
    session_id: String(row.session_id),
    kind: String(row.kind),
    payload,
    created_at: String(row.created_at),
  };
}

function mapMessage(row: Record<string, unknown>): TmuxMessageRecord {
  const source = String(row.source);
  return {
    session_id: String(row.session_id),
    client_message_id: String(row.client_message_id),
    text: String(row.text),
    text_hash: String(row.text_hash),
    source: source === "terminal" ? "terminal" : "web",
    status: String(row.status) as TmuxMessageStatus,
    delivery_attempts: Number(row.delivery_attempts ?? 0),
    error: nullableString(row.error),
    created_at: String(row.created_at),
    delivered_at: nullableString(row.delivered_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
