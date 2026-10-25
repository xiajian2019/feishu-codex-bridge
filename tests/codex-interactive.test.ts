import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  CodexAppServerInteractiveProcess,
  validateActionResponse,
  type CodexAppServerInteractiveAction,
} from "../src/codex-interactive.js";

describe("Codex app-server interactive run", () => {
  it("routes same-id server requests, binds actions, steers, and expires unanswered actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feishu-codex-interactive-test-"));
    const executable = join(directory, "fake-codex");
    const protocolLog = join(directory, "protocol.jsonl");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const output = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (message) => fs.appendFileSync(process.env.FAKE_PROTOCOL_LOG, JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  log({ event: "inbound", request });
  if (request.method === "initialize") {
    output({ id: request.id, result: { userAgent: "fake" } });
  } else if (request.method === "thread/resume") {
    output({ id: request.id, result: { thread: { id: request.params.threadId }, approvalPolicy: "never" } });
  } else if (request.method === "thread/fork") {
    log({ event: "fork", params: request.params });
    output({ id: request.id, result: { thread: { id: "forked-thread" } } });
  } else if (request.method === "turn/start") {
    if (process.env.FAKE_FAIL_TURN_START === "1") {
      output({ id: request.id, error: { code: -32000, message: "fake turn/start failed" } });
      return;
    }
    output({ id: request.id, method: "item/tool/requestUserInput", params: {
      threadId: request.params.threadId,
      turnId: "turn-native",
      itemId: "question-item",
      questions: [{ id: "q1", question: "Continue?" }],
    } });
    output({ id: 77, method: "item/commandExecution/requestApproval", params: {
      threadId: request.params.threadId,
      turnId: "turn-native",
      itemId: "approval-item",
      command: ["echo", "safe"],
    } });
    output({ id: request.id, result: { turn: { id: "turn-native", status: "inProgress", items: [] } } });
    if (process.env.FAKE_EXIT_AFTER_ACTION === "1") {
      setTimeout(() => process.exit(17), 15);
    } else {
      setTimeout(() => {
        output({ id: 78, method: "item/fileChange/requestApproval", params: {
          threadId: "another-thread", turnId: "turn-native", itemId: "wrong-thread",
        } });
        output({ id: 79, method: "item/fileChange/requestApproval", params: {
          threadId: request.params.threadId, turnId: "another-turn", itemId: "wrong-turn",
        } });
        output({ id: 80, method: "unrecognized/serverRequest", params: { threadId: request.params.threadId } });
      }, 15);
    }
  } else if (request.method === "turn/steer") {
    log({ event: "steer", params: request.params });
    output({ id: request.id, result: { turnId: "turn-native" } });
  } else if (request.method === "turn/interrupt") {
    output({ id: request.id, result: {} });
    if (process.env.FAKE_INTERRUPT_NO_COMPLETION !== "1") {
      output({ method: "turn/completed", params: {
        threadId: request.params.threadId,
        turn: { id: request.params.turnId, status: "interrupted", error: null },
      } });
    }
  } else if (request.method === undefined) {
    log({ event: "client-response", message: request });
    if (request.id === 3 && request.result?.answers) {
      output({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 3 } });
    }
  }
});
`);
    await chmod(executable, 0o700);

    try {
      const actions: CodexAppServerInteractiveAction[] = [];
      const actionStatuses = new Map<string, string>();
      const client = new CodexAppServerInteractiveProcess({
        executable,
        cwd: directory,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_PROTOCOL_LOG: protocolLog },
        requestTimeoutMs: 2_000,
      });
      let runFailure: unknown;
      const run = client.runTurn({
        runId: "run-native",
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
        onEvent: () => undefined,
        onAction: (action) => actions.push(action),
        onActionStatus: (actionId, status) => actionStatuses.set(actionId, status),
      }).catch((error: unknown) => {
        runFailure = error;
        return null;
      });
      for (let attempt = 0; attempt < 400 && actions.length < 2; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      if (actions.length < 2) {
        const protocol = await readFile(protocolLog, "utf8").catch(() => "<no protocol log>");
        throw new Error(`Interactive fake did not receive its actions: ${String(runFailure)}\n${protocol}`);
      }

      expect(actions.map((action) => action.type)).toEqual([
        "item/tool/requestUserInput",
        "item/commandExecution/requestApproval",
      ]);
      expect(actions[0]).toMatchObject({
        id: "run-native:1",
        actionId: "run-native:1",
        payload: { threadId: "thread-1", turnId: "turn-native" },
        status: "pending",
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      await expect(client.steer("prioritize the failing test")).resolves.toBe("turn-native");

      await client.respondAction(actions[0]!.id, { answers: { q1: "yes" } });
      expect(actionStatuses.get(actions[0]!.id)).toBe("responded");
      await expect(client.respondAction(actions[0]!.id, { answers: { q1: "yes" } }))
        .rejects.toThrow(/stale|already answered|unknown/i);
      expect(client.listActions().find((action) => action.id === actions[1]!.id)?.status).toBe("pending");

      await client.interrupt();
      await expect(run).resolves.toMatchObject({ turnId: "turn-native", status: "interrupted" });
      expect(client.listActions().find((action) => action.id === actions[1]!.id)?.status).toBe("expired");
      await expect(client.respondAction(actions[1]!.id, { decision: "accept" }))
        .rejects.toThrow(/active native app-server run/i);

      const log = (await readFile(protocolLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(log.find((entry) => entry.event === "inbound" && entry.request.method === "initialize")?.request.params.capabilities)
        .toEqual({ experimentalApi: true });
      const turnStart = log.find((entry) => entry.event === "inbound" && entry.request.method === "turn/start")?.request;
      expect(turnStart.params.approvalPolicy).toBe("on-request");
      expect(turnStart.params.sandboxPolicy).toBeUndefined();
      const questionResponse = log.find((entry) => entry.event === "client-response" && entry.message.id === 3);
      expect(questionResponse.message.result).toEqual({ answers: { q1: { answers: ["yes"] } } });
      expect(log.find((entry) => entry.event === "steer")?.params).toMatchObject({
        threadId: "thread-1",
        expectedTurnId: "turn-native",
        input: [{ type: "text", text: "prioritize the failing test" }],
      });
      const rejected = log
        .filter((entry) => entry.event === "client-response" && entry.message.error)
        .map((entry) => ({ id: entry.message.id, code: entry.message.error.code }));
      expect(rejected).toEqual([
        { id: 78, code: -32001 },
        { id: 79, code: -32001 },
        { id: 80, code: -32601 },
      ]);
      expect(log.some((entry) => entry.event === "client-response" && entry.message.id === 77)).toBe(false);
      await expect(client.forkThread("thread-1", "turn-before")).resolves.toBe("forked-thread");
      const fork = (await readFile(protocolLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .find((entry) => entry.event === "fork");
      expect(fork.params).toEqual({ threadId: "thread-1", excludeTurns: true, lastTurnId: "turn-before" });
      await client.restoreApprovalPolicy("thread-1", "never");
      const policyRestore = (await readFile(protocolLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .find((entry) => entry.event === "inbound"
          && entry.request.method === "thread/resume"
          && entry.request.params.approvalPolicy === "never");
      expect(policyRestore.request.params).toEqual({
        threadId: "thread-1",
        excludeTurns: true,
        approvalPolicy: "never",
      });
      await client.close();

      const failedActions: CodexAppServerInteractiveAction[] = [];
      const failedStatuses = new Map<string, string>();
      const failingClient = new CodexAppServerInteractiveProcess({
        executable,
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          FAKE_PROTOCOL_LOG: protocolLog,
          FAKE_EXIT_AFTER_ACTION: "1",
        },
        requestTimeoutMs: 2_000,
      });
      const failedRun = failingClient.runTurn({
        runId: "run-process-failure",
        threadId: "thread-1",
        input: [{ type: "text", text: "fail process" }],
        onEvent: () => undefined,
        onAction: (action) => failedActions.push(action),
        onActionStatus: (actionId, status) => failedStatuses.set(actionId, status),
      });
      for (let attempt = 0; attempt < 400 && failedActions.length < 2; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      await expect(failedRun).rejects.toThrow(/exited with exit code 17/);
      expect(failedStatuses.get(failedActions[0]!.id)).toBe("expired");
      expect(failedStatuses.get(failedActions[1]!.id)).toBe("expired");
      await failingClient.close();

      const interruptedActions: CodexAppServerInteractiveAction[] = [];
      const interruptedStatuses = new Map<string, string>();
      const interruptWithoutCompletionClient = new CodexAppServerInteractiveProcess({
        executable,
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          FAKE_PROTOCOL_LOG: protocolLog,
          FAKE_INTERRUPT_NO_COMPLETION: "1",
        },
        requestTimeoutMs: 2_000,
        interruptCompletionGraceMs: 20,
      });
      const interruptedRun = interruptWithoutCompletionClient.runTurn({
        runId: "run-interrupt-no-completion",
        threadId: "thread-1",
        input: [{ type: "text", text: "interrupt without completion notification" }],
        onEvent: () => undefined,
        onAction: (action) => interruptedActions.push(action),
        onActionStatus: (actionId, status) => interruptedStatuses.set(actionId, status),
      });
      for (let attempt = 0; attempt < 400 && interruptedActions.length < 2; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      await interruptWithoutCompletionClient.interrupt();
      await expect(interruptedRun).resolves.toMatchObject({ status: "interrupted" });
      expect(interruptedStatuses.get(interruptedActions[0]!.id)).toBe("expired");
      expect(interruptedStatuses.get(interruptedActions[1]!.id)).toBe("expired");
      await interruptWithoutCompletionClient.close();

      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason); };
      process.on("unhandledRejection", onUnhandledRejection);
      try {
        const startFailureClient = new CodexAppServerInteractiveProcess({
          executable,
          cwd: directory,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            FAKE_PROTOCOL_LOG: protocolLog,
            FAKE_FAIL_TURN_START: "1",
          },
          requestTimeoutMs: 2_000,
        });
        await expect(startFailureClient.runTurn({
          runId: "run-start-failure",
          threadId: "thread-1",
          input: [{ type: "text", text: "fail start" }],
          onEvent: () => undefined,
          onAction: () => undefined,
          onActionStatus: () => undefined,
        })).rejects.toThrow(/fake turn\/start failed/);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        expect(unhandledRejections).toEqual([]);
        await startFailureClient.close();
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates approval subsets and explicit elicitation responses", () => {
    expect(validateActionResponse({
      type: "item/permissions/requestApproval",
      payload: { permissions: { network: { enabled: true }, fileSystem: { roots: ["/repo"] } } },
    }, {
      permissions: { network: { enabled: true } },
      scope: "turn",
    })).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(() => validateActionResponse({
      type: "item/permissions/requestApproval",
      payload: { permissions: { network: { enabled: false } } },
    }, { permissions: { network: { enabled: true } }, scope: "turn" })).toThrow(/only permissions requested/i);
    expect(() => validateActionResponse({
      type: "item/tool/requestUserInput",
      payload: { questions: [{ id: "q1" }] },
    }, { answers: { other: "answer" } })).toThrow(/unknown question id/i);
    expect(validateActionResponse({
      type: "mcpServer/elicitation/request",
      payload: { mode: "form" },
    }, { action: "decline", content: null })).toEqual({ action: "decline", content: null, _meta: null });
  });
});
