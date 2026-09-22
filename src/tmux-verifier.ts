import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createTmuxAdapter,
  type TmuxAdapter,
  type TmuxAdapterOptions,
} from "./tmux-adapter.js";
import { spawnTmuxAttachPty } from "./tmux-pty.js";
import {
  type TmuxEvent,
  type TmuxMessageRecord,
  type TmuxSessionRecord,
  type TmuxVerifierStore,
} from "./tmux-verifier-store.js";

export interface TmuxSessionStartInput {
  machine: string;
  cwd: string;
  codexPath?: string;
  initialPrompt?: string;
  clientRequestId?: string;
}

export interface TmuxVerifierOptions {
  store: TmuxVerifierStore;
  defaultCodexPath?: string;
  tmuxSocket?: string;
  pollIntervalMs?: number;
  adapterOptions?: TmuxAdapterOptions;
  adapterFactory?: (session: TmuxSessionRecord) => TmuxAdapter;
}

export interface TmuxStartResult {
  session: TmuxSessionRecord;
  created: boolean;
}

export interface TmuxMessageResult {
  accepted: boolean;
  deduplicated: boolean;
  message: TmuxMessageRecord;
}

export interface TmuxTerminalProcess {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type TmuxVerifierEventListener = (event: TmuxEvent) => void;

export class TmuxVerifier {
  private readonly store: TmuxVerifierStore;
  private readonly defaultCodexPath: string;
  private readonly tmuxSocket: string;
  private readonly pollIntervalMs: number;
  private readonly adapterOptions: TmuxAdapterOptions;
  private readonly adapterFactory: (session: TmuxSessionRecord) => TmuxAdapter;
  private readonly adapters = new Map<string, TmuxAdapter>();
  private readonly listeners = new Map<string, Set<TmuxVerifierEventListener>>();
  private readonly polling = new Set<string>();
  private readonly lastPollErrors = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TmuxVerifierOptions) {
    this.store = options.store;
    this.defaultCodexPath = options.defaultCodexPath ?? "codex";
    this.tmuxSocket = options.tmuxSocket ?? "";
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 500);
    this.adapterOptions = options.adapterOptions ?? {};
    this.adapterFactory = options.adapterFactory
      ?? ((session) => createTmuxAdapter(session, this.adapterOptions));
  }

  public start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    void this.pollAll();
  }

  /** Stop observation only. It deliberately does not kill Codex tmux sessions. */
  public stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  public async startSession(input: TmuxSessionStartInput): Promise<TmuxStartResult> {
    const machine = normalizeMachine(input.machine);
    const cwd = normalizeRequired(input.cwd, "cwd");
    const codexPath = normalizeRequired(input.codexPath ?? this.defaultCodexPath, "codexPath");
    const clientRequestId = input.clientRequestId?.trim() || undefined;
    if (clientRequestId) {
      const existing = this.store.getSessionByClientRequestId(clientRequestId);
      if (existing) return { session: existing, created: false };
    }

    const sessionId = randomUUID();
    const tmuxSession = `codex-verify-${sessionId.slice(0, 12)}`;
    const session = this.store.createSession({
      sessionId,
      clientRequestId,
      machine,
      cwd,
      codexPath,
      tmuxSocket: this.tmuxSocket,
      tmuxSession,
    });
    this.publish(this.store.appendEvent(sessionId, "session.requested", {
      machine,
      cwd,
      tmux_session: tmuxSession,
    }));

    try {
      await this.adapterFor(session).startSession(session);
      const started = this.store.updateSession(sessionId, {
        status: "RUNNING",
        startedAt: new Date().toISOString(),
        error: null,
      });
      this.publish(this.store.appendEvent(sessionId, "session.started", {
        attach_command: this.adapterFor(session).attachCommand(session),
      }));
      if (input.initialPrompt?.trim()) {
        await this.waitForCodexInput(session);
        await this.sendMessage(sessionId, {
          clientMessageId: `initial:${clientRequestId ?? sessionId}`,
          text: input.initialPrompt.trim(),
          source: "web",
        });
      }
      await this.pollSession(started ?? session);
      return { session: this.store.getSession(sessionId)!, created: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateSession(sessionId, { status: "FAILED", error: message, endedAt: new Date().toISOString() });
      this.publish(this.store.appendEvent(sessionId, "session.failed", { error: message }));
      throw error;
    }
  }

  public getSession(sessionId: string): TmuxSessionRecord | null {
    return this.store.getSession(sessionId);
  }

  public listSessions(limit = 100): TmuxSessionRecord[] {
    return this.store.listSessions(limit);
  }

  public listEvents(sessionId: string, afterEventId = 0, limit = 500): TmuxEvent[] {
    return this.store.listEvents(sessionId, afterEventId, limit);
  }

  public listMessages(sessionId: string, limit = 200): TmuxMessageRecord[] {
    return this.store.listMessages(sessionId, limit);
  }

  public getTmuxSocket(): string {
    return this.tmuxSocket;
  }

  public subscribe(sessionId: string, listener: TmuxVerifierEventListener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(sessionId);
    };
  }

  public async sendMessage(
    sessionId: string,
    input: {
      clientMessageId: string;
      text: string;
      source?: "web";
    },
  ): Promise<TmuxMessageResult> {
    const session = this.requireRunningSession(sessionId);
    const text = normalizeRequired(input.text, "text").slice(0, 20_000);
    const clientMessageId = normalizeRequired(input.clientMessageId, "clientMessageId").slice(0, 200);
    const prepared = this.store.prepareMessage({
      sessionId,
      clientMessageId,
      text,
      textHash: hashText(text),
      source: input.source ?? "web",
    });

    if (!prepared.created) {
      this.publish(this.store.appendEvent(sessionId, "message.deduplicated", {
        client_message_id: clientMessageId,
        existing_status: prepared.message.status,
        text_hash: prepared.message.text_hash,
      }));
      return {
        accepted: prepared.message.status === "SENT",
        deduplicated: true,
        message: prepared.message,
      };
    }

    this.publish(this.store.appendEvent(sessionId, "message.requested", {
      client_message_id: clientMessageId,
      source: "web",
      text_hash: prepared.message.text_hash,
    }));
    try {
      await this.adapterFor(session).sendText(session, text);
      const message = this.store.markMessageSent(sessionId, clientMessageId)!;
      this.publish(this.store.appendEvent(sessionId, "message.delivered", {
        client_message_id: clientMessageId,
        source: "web",
        delivery: "tmux.send-keys",
        delivery_attempts: message.delivery_attempts,
      }));
      await this.pollSession(session);
      return { accepted: true, deduplicated: false, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.store.markMessageFailed(sessionId, clientMessageId, message)!;
      this.publish(this.store.appendEvent(sessionId, "message.failed", {
        client_message_id: clientMessageId,
        error: message,
      }));
      return { accepted: false, deduplicated: false, message: failed };
    }
  }

  public async sendTerminalInput(sessionId: string, data: string): Promise<void> {
    const session = this.requireRunningSession(sessionId);
    if (!data || data.length > 8_192) throw new Error("terminal input is empty or too large");
    await this.adapterFor(session).sendTerminalData(session, data);
    this.publish(this.store.appendEvent(sessionId, "terminal.input", {
      bytes: data.length,
      contains_submit: data.includes("\r") || data.includes("\n"),
    }));
    await this.pollSession(session);
  }

  public attachTerminal(
    sessionId: string,
    cols = 80,
    rows = 24,
  ): TmuxTerminalProcess {
    const session = this.requireRunningSession(sessionId);
    return spawnTmuxAttachPty(session, {
      ...this.adapterOptions,
      cols,
      rows,
    });
  }

  public async stopSession(sessionId: string): Promise<TmuxSessionRecord> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (session.status === "STOPPED" || session.status === "EXITED") return session;
    await this.adapterFor(session).killSession(session);
    this.store.updateSession(sessionId, {
      status: "STOPPED",
      endedAt: new Date().toISOString(),
    })!;
    this.publish(this.store.appendEvent(sessionId, "session.stopped", {}));
    return this.store.getSession(sessionId)!;
  }

  public attachCommand(sessionId: string): string {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    return this.adapterFor(session).attachCommand(session);
  }

  /** Exposed for deterministic tests and for a future scheduler. */
  public async pollOnce(sessionId?: string): Promise<void> {
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (session) await this.pollSession(session);
      return;
    }
    await this.pollAll();
  }

  private async pollAll(): Promise<void> {
    const sessions = this.store
      .listSessions(500)
      .filter((session) => session.status === "STARTING" || session.status === "RUNNING");
    await Promise.all(sessions.map((session) => this.pollSession(session)));
  }

  private async pollSession(session: TmuxSessionRecord): Promise<void> {
    if (this.polling.has(session.session_id)) return;
    this.polling.add(session.session_id);
    try {
      const adapter = this.adapterFor(session);
      if (!await adapter.hasSession(session)) {
        if (session.status === "RUNNING" || session.status === "STARTING") {
          this.store.updateSession(session.session_id, {
            status: "EXITED",
            endedAt: new Date().toISOString(),
          });
          this.publish(this.store.appendEvent(session.session_id, "session.exited", {}));
        }
        return;
      }
      const screen = await adapter.capturePane(session);
      const snapshot = this.store.recordSnapshot(session.session_id, screen);
      if (snapshot) this.publish(snapshot);
      this.lastPollErrors.delete(session.session_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.lastPollErrors.get(session.session_id) !== message) {
        this.lastPollErrors.set(session.session_id, message);
        this.publish(this.store.appendEvent(session.session_id, "adapter.error", { error: message }));
      }
    } finally {
      this.polling.delete(session.session_id);
    }
  }

  private async waitForCodexInput(session: TmuxSessionRecord): Promise<void> {
    const adapter = this.adapterFor(session);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const screen = await adapter.capturePane(session);
      if (isCodexInputReady(screen)) return;
      await sleep(250);
    }
    throw new Error("Codex TUI 在 30 秒内没有进入可输入状态");
  }

  private adapterFor(session: TmuxSessionRecord): TmuxAdapter {
    const existing = this.adapters.get(session.session_id);
    if (existing) return existing;
    const adapter = this.adapterFactory(session);
    this.adapters.set(session.session_id, adapter);
    return adapter;
  }

  private requireRunningSession(sessionId: string): TmuxSessionRecord {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (session.status !== "RUNNING" && session.status !== "STARTING") {
      throw new Error(`session is not running: ${session.status}`);
    }
    return session;
  }

  private publish(event: TmuxEvent): void {
    for (const listener of this.listeners.get(event.session_id) ?? []) {
      try {
        listener(event);
      } catch {
        // A disconnected terminal must not stop the observer loop.
      }
    }
  }
}

function normalizeMachine(value: string): string {
  const machine = value.trim() || "local";
  if (machine.length > 256 || /[\r\n]/.test(machine)) {
    throw new Error("machine is invalid");
  }
  return machine;
}

function normalizeRequired(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > 20_000 || /[\r\n]/.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isCodexInputReady(screen: string): boolean {
  return screen.includes("›")
    && (screen.includes("OpenAI Codex") || screen.includes("Codex TUI"));
}
