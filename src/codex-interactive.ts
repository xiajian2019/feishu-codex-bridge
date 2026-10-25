import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import {
  buildCodexAppServerArgs,
  CodexAppServerRpcError,
  type CodexAppServerClientOptions,
} from "./codex-app-server.js";

export const CODEX_APP_SERVER_INTERACTIVE_ACTION_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

export type CodexAppServerInteractiveActionMethod =
  (typeof CODEX_APP_SERVER_INTERACTIVE_ACTION_METHODS)[number];
export type CodexAppServerInteractiveActionStatus = "pending" | "responded" | "expired";
export type CodexAppServerApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type CodexAppServerInteractiveActionResponse =
  | { decision: CodexAppServerApprovalDecision }
  | { answers: Record<string, string | string[]> }
  | { permissions: Record<string, unknown>; scope: "turn" }
  | { action: "accept"; content: unknown }
  | { action: "decline" | "cancel"; content: null };

export interface CodexAppServerInteractiveAction {
  /** Stable for this run; safe to use as the workbench action identifier. */
  id: string;
  actionId: string;
  type: CodexAppServerInteractiveActionMethod;
  payload: Record<string, unknown>;
  status: CodexAppServerInteractiveActionStatus;
}

export interface CodexAppServerInteractiveEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexAppServerInteractiveTurnInput {
  runId: string;
  threadId: string;
  input: Array<Record<string, unknown>>;
  cwd?: string;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  onApprovalPolicy?(policy: unknown): void;
  onEvent(event: CodexAppServerInteractiveEvent): void;
  onAction(action: CodexAppServerInteractiveAction): void;
  onActionStatus(actionId: string, status: CodexAppServerInteractiveActionStatus): void;
}

export interface CodexAppServerInteractiveTurnResult {
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  error?: string;
  usage?: unknown;
}

export interface CodexAppServerInteractiveClient {
  runTurn(input: CodexAppServerInteractiveTurnInput): Promise<CodexAppServerInteractiveTurnResult>;
  steer(text: string): Promise<string>;
  interrupt(): Promise<void>;
  restoreApprovalPolicy(threadId: string, policy: unknown): Promise<void>;
  respondAction(actionId: string, response: CodexAppServerInteractiveActionResponse): Promise<void>;
  forkThread(threadId: string, lastTurnId?: string): Promise<string>;
  listActions(): CodexAppServerInteractiveAction[];
  close(): Promise<void>;
}

export interface CodexAppServerInteractiveProcessOptions extends CodexAppServerClientOptions {
  /** Bound the wait after interrupt acknowledgement if no turn/completed event follows. */
  interruptCompletionGraceMs?: number;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface MutableAction extends CodexAppServerInteractiveAction {
  requestId: number | string;
  responseSent: boolean;
}

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  runId: string;
  onEvent(event: CodexAppServerInteractiveEvent): void;
  onAction(action: CodexAppServerInteractiveAction): void;
  onActionStatus(actionId: string, status: CodexAppServerInteractiveActionStatus): void;
  resolve(result: CodexAppServerInteractiveTurnResult): void;
  reject(error: Error): void;
  completion: Promise<CodexAppServerInteractiveTurnResult>;
  settled: boolean;
  interruptRequested: boolean;
  interruptPromise?: Promise<void>;
  interruptFallbackTimer?: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  messageTextByItemId: Map<string, string>;
}

/**
 * Bidirectional app-server connection used only by an explicit History run.
 * The read-only CodexAppServerClient remains a separate, default-deny client.
 */
export class CodexAppServerInteractiveProcess implements CodexAppServerInteractiveClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly requestTimeoutMs: number;
  private readonly interruptCompletionGraceMs: number;
  private readonly clientInfo: { name: string; title: string; version: string };
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly actions = new Map<string, MutableAction>();
  private readonly pendingActionsByRequestId = new Map<string, string>();
  private nextRequestId = 1;
  private nextActionSequence = 1;
  private stderr = "";
  private processError: Error | null = null;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private closed = false;
  private activeTurn: ActiveTurn | null = null;

  constructor(options: CodexAppServerInteractiveProcessOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.interruptCompletionGraceMs = Math.max(1, options.interruptCompletionGraceMs ?? 5_000);
    this.clientInfo = {
      name: options.clientName ?? "feishu_codex_bridge_history_interactive",
      title: options.clientTitle ?? "Feishu Codex Bridge (interactive history)",
      version: options.clientVersion ?? "0.1.0",
    };
    this.child = spawn(options.executable, buildCodexAppServerArgs(), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.failProcess(error));
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
      this.failProcess(new Error(
        `Codex app-server exited with ${reason}${detail ? `: ${detail}` : ""}`,
      ));
    });
  }

  public async runTurn(input: CodexAppServerInteractiveTurnInput): Promise<CodexAppServerInteractiveTurnResult> {
    if (this.activeTurn) throw new Error("This app-server connection already owns an active turn.");
    const threadId = input.threadId.trim();
    const runId = input.runId.trim();
    if (!threadId || !runId) throw new Error("threadId and runId are required");
    await this.initialize();
    const resumeSettings = asRecord(await this.request("thread/resume", { threadId, excludeTurns: true }));
    if (Object.hasOwn(resumeSettings, "approvalPolicy")) {
      input.onApprovalPolicy?.(structuredClone(resumeSettings.approvalPolicy));
    }

    let resolveTurn!: (result: CodexAppServerInteractiveTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexAppServerInteractiveTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    // The start RPC can fail before runTurn begins awaiting this promise. Keep
    // its rejection observed while preserving the original rejection for a
    // later await when the turn was actually started.
    void completion.catch(() => undefined);
    const activeTurn: ActiveTurn = {
      threadId,
      runId,
      onEvent: input.onEvent,
      onAction: input.onAction,
      onActionStatus: input.onActionStatus,
      resolve: resolveTurn,
      reject: rejectTurn,
      completion,
      settled: false,
      interruptRequested: false,
      abortSignal: input.signal,
      messageTextByItemId: new Map(),
    };
    this.activeTurn = activeTurn;
    if (input.signal) {
      activeTurn.abortListener = () => {
        void this.interrupt().catch((error) => this.failTurn(error));
      };
      input.signal.addEventListener("abort", activeTurn.abortListener, { once: true });
    }

    try {
      const params = {
        threadId,
        input: input.input,
        approvalPolicy: "on-request",
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      };
      const raw = asRecord(await this.request("turn/start", params));
      const turn = asRecord(raw.turn);
      if (typeof turn.id !== "string" || !turn.id) {
        throw new Error("Codex app-server returned an invalid turn/start response");
      }
      if (!activeTurn.turnId) activeTurn.turnId = turn.id;
      this.expireActionsForDifferentTurn(activeTurn);
      const initialStatus = readTurnStatus(turn.status);
      if (initialStatus) this.finishTurn(activeTurn, initialStatus, turn);
      if ((input.signal?.aborted || activeTurn.interruptRequested) && !activeTurn.settled) {
        void this.interrupt().catch((error) => this.failTurn(error));
      }
      return await completion;
    } catch (error) {
      this.expirePendingActions();
      if (!activeTurn.settled) this.failTurn(error);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (activeTurn.abortSignal && activeTurn.abortListener) {
        activeTurn.abortSignal.removeEventListener("abort", activeTurn.abortListener);
      }
      if (this.activeTurn === activeTurn) this.activeTurn = null;
      this.expirePendingActions();
    }
  }

  public async steer(text: string): Promise<string> {
    const normalizedText = text.trim();
    if (!normalizedText) throw new Error("text is required");
    const activeTurn = this.requireActiveTurn();
    if (!activeTurn.turnId) throw new Error("The native run has not received its turn id yet.");
    const result = asRecord(await this.request("turn/steer", {
      threadId: activeTurn.threadId,
      input: [{ type: "text", text: normalizedText }],
      expectedTurnId: activeTurn.turnId,
    }));
    if (result.turnId !== activeTurn.turnId) {
      throw new Error("Codex app-server steered a different turn than the active native run.");
    }
    return activeTurn.turnId;
  }

  public async interrupt(): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.settled) return;
    activeTurn.interruptRequested = true;
    this.expirePendingActions();
    if (!activeTurn.turnId) return;
    if (!activeTurn.interruptPromise) {
      activeTurn.interruptPromise = this.request("turn/interrupt", {
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
      }).then(() => undefined);
    }
    await activeTurn.interruptPromise;
    if (!activeTurn.settled && !activeTurn.interruptFallbackTimer) {
      activeTurn.interruptFallbackTimer = setTimeout(() => {
        this.finishTurn(activeTurn, "interrupted", { status: "interrupted" });
      }, this.interruptCompletionGraceMs);
      activeTurn.interruptFallbackTimer.unref?.();
    }
  }

  public async restoreApprovalPolicy(threadId: string, policy: unknown): Promise<void> {
    if (this.activeTurn && !this.activeTurn.settled) {
      throw new Error("Cannot restore thread approval policy while a native turn is active.");
    }
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || !isJsonValue(policy)) {
      throw new Error("threadId and a JSON approval policy are required");
    }
    await this.initialize();
    await this.request("thread/resume", {
      threadId: normalizedThreadId,
      excludeTurns: true,
      approvalPolicy: policy,
    });
  }

  public async respondAction(
    actionId: string,
    response: CodexAppServerInteractiveActionResponse,
  ): Promise<void> {
    const activeTurn = this.requireActiveTurn();
    const action = this.actions.get(actionId);
    if (!action || action.status !== "pending") {
      throw new Error("The native app-server action is stale, already answered, or unknown.");
    }
    if (requestThreadId(action.payload) !== activeTurn.threadId
      || (typeof action.payload.turnId === "string"
        && activeTurn.turnId !== undefined
        && action.payload.turnId !== activeTurn.turnId)) {
      throw new Error("The native app-server action belongs to a different thread or turn.");
    }
    const rpcResult = validateActionResponse(action, response);
    this.write({ id: action.requestId, result: rpcResult });
    action.responseSent = true;
    this.setActionStatus(action, "responded");
    this.pendingActionsByRequestId.delete(jsonRpcIdKey(action.requestId));
  }

  public async forkThread(threadId: string, lastTurnId?: string): Promise<string> {
    if (this.activeTurn) throw new Error("Cannot fork from a connection that owns an active turn.");
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("threadId is required");
    const normalizedLastTurnId = lastTurnId?.trim();
    if (lastTurnId !== undefined && (!normalizedLastTurnId || normalizedLastTurnId.length > 200)) {
      throw new Error("lastTurnId must contain 1 to 200 characters");
    }
    await this.initialize();
    const result = asRecord(await this.request("thread/fork", {
      threadId: normalizedThreadId,
      excludeTurns: true,
      ...(normalizedLastTurnId ? { lastTurnId: normalizedLastTurnId } : {}),
    }));
    const threadIdResult = asRecord(result.thread).id;
    if (typeof threadIdResult !== "string" || !threadIdResult.trim()) {
      throw new Error("Codex app-server returned an invalid thread/fork response");
    }
    return threadIdResult;
  }

  public listActions(): CodexAppServerInteractiveAction[] {
    return [...this.actions.values()].map(publicAction);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.expirePendingActions();
    this.lines.close();
    this.rejectPending(new Error("Codex app-server interactive client closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      this.child.once("close", finish);
      try {
        this.child.stdin.end();
      } catch {
        finish();
        return;
      }
      forceTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
        setTimeout(finish, 250);
      }, 500);
    });
  }

  private initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initialization) {
      const initialization = this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      }).then(() => {
        this.write({ method: "initialized", params: {} });
        this.initialized = true;
      });
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = null;
      });
    }
    return this.initialization;
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server interactive client is closed"));
    if (this.processError) return Promise.reject(this.processError);
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: object): void {
    if (this.closed) throw new Error("Codex app-server interactive client is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.failProcess(new Error(`Codex app-server returned non-JSON output: ${trimmed.slice(0, 500)}`));
      return;
    }
    const message = asRecord(raw) as JsonRpcMessage;

    // JSON-RPC server requests have both an id and a method. Classify them
    // before looking up client request ids because both peers may use the same id.
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) this.handleServerRequest(message);
      else this.handleNotification(message.method, message.params);
      return;
    }

    if ((typeof message.id === "number" || typeof message.id === "string") && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexAppServerRpcError(
          pending.method,
          typeof message.error.message === "string" ? message.error.message : "unknown error",
          typeof message.error.code === "number" ? message.error.code : undefined,
          message.error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    const id = message.id;
    if ((typeof id !== "number" && typeof id !== "string") || typeof message.method !== "string") return;
    const method = message.method;
    if (!isInteractiveActionMethod(method)) {
      this.write({ id, error: { code: -32601, message: "Unsupported app-server server request." } });
      return;
    }
    const activeTurn = this.activeTurn;
    const params = asRecord(message.params);
    if (!activeTurn || activeTurn.settled || requestThreadId(params) !== activeTurn.threadId) {
      this.write({ id, error: { code: -32001, message: "No matching active native History run." } });
      return;
    }
    if (typeof params.turnId === "string"
      && activeTurn.turnId !== undefined
      && params.turnId !== activeTurn.turnId) {
      this.write({ id, error: { code: -32001, message: "The request belongs to a different Codex turn." } });
      return;
    }
    const requestKey = jsonRpcIdKey(id);
    if (this.pendingActionsByRequestId.has(requestKey)) {
      this.write({ id, error: { code: -32600, message: "Duplicate pending app-server request id." } });
      return;
    }
    const actionId = `${activeTurn.runId}:${this.nextActionSequence++}`;
    const action: MutableAction = {
      id: actionId,
      actionId,
      type: method as CodexAppServerInteractiveActionMethod,
      payload: params,
      status: "pending",
      requestId: id,
      responseSent: false,
    };
    this.actions.set(actionId, action);
    this.pendingActionsByRequestId.set(requestKey, actionId);
    activeTurn.onAction(publicAction(action));
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = asRecord(rawParams);
    if (method === "serverRequest/resolved") {
      if (params.threadId === this.activeTurn?.threadId
        && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
        const requestKey = jsonRpcIdKey(params.requestId);
        const actionId = this.pendingActionsByRequestId.get(requestKey);
        if (actionId) {
          const action = this.actions.get(actionId);
          if (action) this.setActionStatus(action, action.responseSent ? "responded" : "expired");
          this.pendingActionsByRequestId.delete(requestKey);
        }
      }
      return;
    }

    const activeTurn = this.activeTurn;
    if (!activeTurn || !activeTurnTurnMatches(activeTurn, params)) return;
    if (method === "turn/started") {
      const turnId = readTurnId(params);
      if (turnId && !activeTurn.turnId) activeTurn.turnId = turnId;
      activeTurn.onEvent({ type: "turn.started", thread_id: activeTurn.threadId, turn_id: turnId, turn: params.turn });
      return;
    }
    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      const turnId = readTurnId(params) ?? activeTurn.turnId;
      if (turnId && !activeTurn.turnId) activeTurn.turnId = turnId;
      const status = readTurnStatus(turn.status) ?? "completed";
      activeTurn.onEvent({
        type: "turn.completed",
        thread_id: activeTurn.threadId,
        turn_id: turnId,
        turn,
        ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
      });
      this.finishTurn(activeTurn, status, turn);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : "agent-message";
      const delta = typeof params.delta === "string" ? params.delta : "";
      const fullText = `${activeTurn.messageTextByItemId.get(itemId) ?? ""}${delta}`;
      activeTurn.messageTextByItemId.set(itemId, fullText);
      activeTurn.onEvent({
        type: "item.updated",
        item: { id: itemId, type: "agent_message", text: fullText },
      });
      return;
    }
    if (method.startsWith("item/")) {
      activeTurn.onEvent({
        type: method.replaceAll("/", "."),
        ...(params.item !== undefined ? { item: params.item } : {}),
        ...(params.itemId !== undefined ? { item_id: params.itemId } : {}),
      });
      return;
    }
    if (method.startsWith("turn/")) {
      activeTurn.onEvent({ type: method.replaceAll("/", "."), ...params });
    }
  }

  private finishTurn(
    activeTurn: ActiveTurn,
    status: "completed" | "interrupted" | "failed",
    turn: Record<string, unknown>,
  ): void {
    if (activeTurn.settled) return;
    activeTurn.settled = true;
    if (activeTurn.interruptFallbackTimer) clearTimeout(activeTurn.interruptFallbackTimer);
    this.expirePendingActions();
    activeTurn.resolve({
      turnId: activeTurn.turnId ?? "",
      status,
      ...(asRecord(turn.error).message && typeof asRecord(turn.error).message === "string"
        ? { error: asRecord(turn.error).message as string }
        : {}),
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    });
  }

  private failTurn(error: unknown): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.settled) return;
    activeTurn.settled = true;
    if (activeTurn.interruptFallbackTimer) clearTimeout(activeTurn.interruptFallbackTimer);
    this.expirePendingActions();
    activeTurn.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private failProcess(error: Error): void {
    this.processError = error;
    this.expirePendingActions();
    this.rejectPending(error);
    this.failTurn(error);
  }

  private requireActiveTurn(): ActiveTurn {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.settled || this.closed) {
      throw new Error("There is no active native app-server run on this connection.");
    }
    return activeTurn;
  }

  private setActionStatus(action: MutableAction, status: CodexAppServerInteractiveActionStatus): void {
    if (action.status === status) return;
    action.status = status;
    this.activeTurn?.onActionStatus(action.id, status);
  }

  private expirePendingActions(): void {
    for (const action of this.actions.values()) {
      if (action.status === "pending") this.setActionStatus(action, "expired");
    }
    this.pendingActionsByRequestId.clear();
  }

  private expireActionsForDifferentTurn(activeTurn: ActiveTurn): void {
    if (!activeTurn.turnId) return;
    for (const action of this.actions.values()) {
      if (action.status !== "pending"
        || typeof action.payload.turnId !== "string"
        || action.payload.turnId === activeTurn.turnId) continue;
      this.write({
        id: action.requestId,
        error: { code: -32001, message: "The request belongs to a different Codex turn." },
      });
      this.setActionStatus(action, "expired");
      this.pendingActionsByRequestId.delete(jsonRpcIdKey(action.requestId));
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export function validateActionResponse(
  action: Pick<CodexAppServerInteractiveAction, "type" | "payload">,
  value: CodexAppServerInteractiveActionResponse,
): Record<string, unknown> {
  const response = asRecord(value);
  switch (action.type) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      if (!hasOnlyKeys(response, ["decision"]) || !isApprovalDecision(response.decision)) {
        throw new Error("An approval action requires an explicit supported decision.");
      }
      return { decision: response.decision };
    case "item/tool/requestUserInput":
    {
      if (!hasOnlyKeys(response, ["answers"]) || !isRecord(response.answers)) {
        throw new Error("A question action requires an answers object.");
      }
      const questions = Array.isArray(action.payload.questions) ? action.payload.questions : [];
      const questionIds = new Set(questions.map((question) => asRecord(question).id)
        .filter((id): id is string => typeof id === "string"));
      if (Object.keys(response.answers).some((id) => !questionIds.has(id))) {
        throw new Error("The response contains an unknown question id.");
      }
      for (const answer of Object.values(response.answers)) {
        if (typeof answer !== "string"
          && !(Array.isArray(answer) && answer.every((item) => typeof item === "string"))) {
          throw new Error("Question answers must be strings or arrays of strings.");
        }
      }
      return {
        answers: Object.fromEntries(Object.entries(response.answers).map(([questionId, answer]) => [
          questionId,
          { answers: Array.isArray(answer) ? answer : [answer] },
        ])),
      };
    }
    case "item/permissions/requestApproval": {
      if (!hasOnlyKeys(response, ["permissions", "scope"])
        || !isRecord(response.permissions)
        || response.scope !== "turn") {
        throw new Error("A permission action requires an explicit requested subset with turn scope.");
      }
      const requested = action.payload.permissions;
      if (!isRecord(requested) || !isSubsetOfRequested(response.permissions, requested)) {
        throw new Error("The response may grant only permissions requested by Codex.");
      }
      return {
        permissions: response.permissions,
        scope: "turn",
      };
    }
    case "mcpServer/elicitation/request":
      if (response.action === "accept"
        && hasOnlyKeys(response, ["action", "content"])
        && isJsonValue(response.content)) {
        return { action: "accept", content: response.content, _meta: null };
      }
      if ((response.action === "decline" || response.action === "cancel")
        && response.content === null
        && hasOnlyKeys(response, ["action", "content"])) {
        return { action: response.action, content: null, _meta: null };
      }
      throw new Error("An elicitation action requires accept with content, decline, or cancel.");
    case "applyPatchApproval":
    case "execCommandApproval":
      if (!hasOnlyKeys(response, ["decision"]) || !isApprovalDecision(response.decision)) {
        throw new Error("A legacy approval action requires an explicit supported decision.");
      }
      return {
        decision: response.decision === "accept" ? "approved"
          : response.decision === "acceptForSession" ? "approved_for_session"
            : response.decision === "decline" ? { denied: { rejection: "User declined" } }
              : "abort",
      };
  }
}

function activeTurnTurnMatches(activeTurn: ActiveTurn, params: Record<string, unknown>): boolean {
  if (requestThreadId(params) !== activeTurn.threadId) return false;
  const turnId = readTurnId(params);
  return !turnId || !activeTurn.turnId || turnId === activeTurn.turnId;
}

function requestThreadId(params: Record<string, unknown>): string | undefined {
  if (typeof params.threadId === "string") return params.threadId;
  return typeof params.conversationId === "string" ? params.conversationId : undefined;
}

function readTurnId(params: Record<string, unknown>): string | undefined {
  if (typeof params.turnId === "string") return params.turnId;
  const turnId = asRecord(params.turn).id;
  return typeof turnId === "string" ? turnId : undefined;
}

function readTurnStatus(value: unknown): "completed" | "interrupted" | "failed" | undefined {
  return value === "completed" || value === "interrupted" || value === "failed" ? value : undefined;
}

function jsonRpcIdKey(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

function isInteractiveActionMethod(value: string): value is CodexAppServerInteractiveActionMethod {
  return (CODEX_APP_SERVER_INTERACTIVE_ACTION_METHODS as readonly string[]).includes(value);
}

function isApprovalDecision(value: unknown): value is CodexAppServerApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isSubsetOfRequested(granted: unknown, requested: unknown): boolean {
  if (typeof granted === "boolean" || typeof granted === "string" || typeof granted === "number" || granted === null) {
    return granted === requested || (granted === false && requested === true);
  }
  if (Array.isArray(granted)) {
    if (!Array.isArray(requested)) return false;
    return granted.every((entry) => requested.some((requestedEntry) => isDeepEqual(entry, requestedEntry)));
  }
  if (isRecord(granted)) {
    if (!isRecord(requested)) return false;
    return Object.entries(granted).every(([key, entry]) =>
      Object.hasOwn(requested, key) && isSubsetOfRequested(entry, requested[key]));
  }
  return false;
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => isDeepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every((key) => Object.hasOwn(right, key) && isDeepEqual(left[key], right[key]));
  }
  return false;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function publicAction(action: MutableAction): CodexAppServerInteractiveAction {
  return {
    id: action.id,
    actionId: action.actionId,
    type: action.type,
    payload: structuredClone(action.payload),
    status: action.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
