import { afterEach, describe, expect, it } from "bun:test";

import { DatabaseSync } from "../src/sqlite.js";
import {
  WorkbenchStore,
  parseWorkbenchTarget,
  parseWorkbenchTargetKey,
  workbenchTargetKey,
  type WorkbenchTarget,
} from "../src/workbench-store.js";

const databases: InstanceType<typeof DatabaseSync>[] = [];
let clock = 1_800_000_000_000;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  clock = 1_800_000_000_000;
});

function createStore(): { database: InstanceType<typeof DatabaseSync>; store: WorkbenchStore } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const store = new WorkbenchStore(database, () => clock);
  return { database, store };
}

function registerProject(database: InstanceType<typeof DatabaseSync>, name = "fixture"): void {
  database.exec("CREATE TABLE projects (name TEXT PRIMARY KEY, status TEXT NOT NULL)");
  database.prepare("INSERT INTO projects (name, status) VALUES (?, 'available')").run(name);
}

describe("WorkbenchStore target metadata", () => {
  it("round-trips strict task and history target keys without changing task tables", () => {
    const { database, store } = createStore();
    const taskTarget: WorkbenchTarget = { kind: "task", id: "desk:task/1", source: "desk" };
    const historyTarget: WorkbenchTarget = { kind: "history", id: "thread/1", homeId: "home/1" };
    expect(parseWorkbenchTargetKey(workbenchTargetKey(taskTarget))).toEqual(taskTarget);
    expect(parseWorkbenchTargetKey(workbenchTargetKey(historyTarget))).toEqual(historyTarget);
    expect(() => parseWorkbenchTarget({ kind: "task", id: "task", source: "unknown" })).toThrow();
    expect(() => parseWorkbenchTarget({ kind: "history", id: "thread", source: "desk" })).toThrow();
    expect(() => parseWorkbenchTargetKey('["task",null,"home","id"]')).toThrow();

    expect(store.getPreferences(taskTarget)).toMatchObject({
      pinned: false,
      tags: [],
      unread: false,
      keepAttention: false,
      updatedAt: 0,
    });
    expect(store.updatePreferences(taskTarget, {
      pinned: true,
      tags: ["release", "review"],
      unread: true,
      keepAttention: false,
      title: "Release check",
    })).toMatchObject({ target: taskTarget, pinned: true, tags: ["release", "review"], unread: true, title: "Release check" });
    expect(store.updatePreferences(taskTarget, { title: null, unread: false })).not.toHaveProperty("title");
    expect(store.listPreferences()).toHaveLength(1);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map((row) => String((row as { name: string }).name))).toEqual(expect.arrayContaining([
      "workbench_preferences",
      "workbench_templates",
      "workbench_queue_messages",
      "workbench_notifications",
      "workbench_automations",
      "workbench_schema_migrations",
      "workbench_pending_actions",
    ]));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()).toBeNull();
    expect(() => store.updatePreferences(taskTarget, { tags: ["same", "same"] })).toThrow(/duplicates/);
    expect(() => store.updatePreferences(taskTarget, { unread: "yes" as unknown as boolean })).toThrow(/boolean/);
  });

  it("validates template fields and only accepts registered available projects", () => {
    const { database, store } = createStore();
    registerProject(database);
    const template = store.createTemplate({
      title: "Review",
      text: "Review {{diff}}",
      projectKey: "fixture",
      model: "gpt-example",
      reasoningEffort: "high",
    });
    expect(template).toMatchObject({ title: "Review", projectKey: "fixture", reasoningEffort: "high" });
    expect(store.updateTemplate(template.id, { projectKey: null, model: null })).not.toHaveProperty("projectKey");
    expect(store.listTemplates()).toHaveLength(1);
    expect(store.deleteTemplate(template.id)).toBe(true);
    expect(store.deleteTemplate(template.id)).toBe(false);
    expect(() => store.createTemplate({ title: "bad", text: "x", projectKey: "missing" })).toThrow(/available registered project/);
    expect(() => store.createTemplate({ title: "bad", text: "x", reasoningEffort: "invalid value" })).toThrow(/reasoningEffort/);
  });
});

describe("WorkbenchStore schema migration", () => {
  it("upgrades early automation run and claim tables before indexes, preserving rows and reserving unknown slots", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`CREATE TABLE workbench_automations (
      automation_id TEXT PRIMARY KEY,
      target_key TEXT,
      target_json TEXT,
      project_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      time_zone TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    database.exec(`CREATE TABLE workbench_automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unconfirmed')),
      scheduled_for INTEGER,
      task_target_key TEXT,
      task_target_json TEXT,
      execution_error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (automation_id, idempotency_key)
    )`);
    database.exec(`CREATE TABLE workbench_automation_claims (
      claim_token TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL UNIQUE REFERENCES workbench_automations(automation_id) ON DELETE CASCADE,
      claimed_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL
    )`);
    database.exec("CREATE TABLE tasks (task_guid TEXT PRIMARY KEY, input_text TEXT NOT NULL)");
    database.prepare("INSERT INTO tasks (task_guid, input_text) VALUES ('kept-task', 'preserve me')").run();
    const insertAutomation = database.prepare(`INSERT INTO workbench_automations
      (automation_id, project_key, prompt, interval_minutes, time_zone, enabled, next_run_at, created_at, updated_at)
      VALUES (?, 'fixture', ?, ?, 'UTC', 1, ?, ?, ?)`);
    const firstDue = clock - 1_000;
    const secondDue = clock - 2_000;
    const duplicateDue = clock - 3_000;
    insertAutomation.run("legacy-claim-automation", "claim prompt", 30, firstDue, clock - 10_000, clock - 10_000);
    insertAutomation.run("legacy-run-automation", "run prompt", 1, secondDue, clock - 10_000, clock - 10_000);
    insertAutomation.run("legacy-duplicate-automation", "duplicate prompt", 2, duplicateDue, clock - 10_000, clock - 10_000);
    database.prepare(`INSERT INTO workbench_automation_claims
      (claim_token, automation_id, claimed_at, lease_until) VALUES ('legacy-claim', ?, ?, ?)`)
      .run("legacy-claim-automation", clock - 800, clock + 60_000);
    const previousTarget: WorkbenchTarget = { kind: "task", id: "legacy-task", source: "desk" };
    database.prepare(`INSERT INTO workbench_automation_runs
      (run_id, automation_id, idempotency_key, trigger, status, scheduled_for, task_target_key,
       task_target_json, execution_error, started_at, finished_at)
      VALUES ('legacy-run', ?, ?, 'scheduled', 'running', ?, ?, ?, 'old error', ?, NULL)`)
      .run("legacy-run-automation", `scheduled:${secondDue}`, secondDue, workbenchTargetKey(previousTarget),
        JSON.stringify(previousTarget), clock - 3_000);
    const insertDuplicateRun = database.prepare(`INSERT INTO workbench_automation_runs
      (run_id, automation_id, idempotency_key, trigger, status, scheduled_for, execution_error, started_at)
      VALUES (?, 'legacy-duplicate-automation', ?, 'scheduled', 'running', ?, ?, ?)`);
    insertDuplicateRun.run("legacy-duplicate-1", "legacy-key-1", duplicateDue, "first ambiguous run", clock - 5_000);
    insertDuplicateRun.run("legacy-duplicate-2", "legacy-key-2", duplicateDue, "second ambiguous run", clock - 4_000);

    const store = new WorkbenchStore(database, () => clock);
    const claimRun = store.listAutomationRuns("legacy-claim-automation")[0]!;
    expect(claimRun).toMatchObject({
      submissionStatus: "unconfirmed",
      executionStatus: "unconfirmed",
      scheduledFor: firstDue,
      idempotencyKey: `scheduled:${firstDue}`,
    });
    const migratedClaim = database.prepare("SELECT run_id, idempotency_key, trigger FROM workbench_automation_claims WHERE claim_token='legacy-claim'")
      .get() as { run_id: string; idempotency_key: string; trigger: string };
    expect(migratedClaim).toEqual({ run_id: claimRun.id, idempotency_key: `scheduled:${firstDue}`, trigger: "scheduled" });
    expect(store.listAutomationRuns("legacy-run-automation")[0]).toMatchObject({
      id: "legacy-run",
      submissionStatus: "unconfirmed",
      executionStatus: "unconfirmed",
      scheduledFor: secondDue,
      taskTarget: previousTarget,
      executionError: "old error",
    });
    const duplicateRuns = store.listAutomationRuns("legacy-duplicate-automation");
    expect(duplicateRuns).toHaveLength(2);
    expect(duplicateRuns.every((run) => run.submissionStatus === "unconfirmed")).toBe(true);
    expect(duplicateRuns.filter((run) => run.scheduledFor === duplicateDue)).toHaveLength(1);
    expect(duplicateRuns.filter((run) => run.scheduledFor === null)).toHaveLength(1);
    expect(store.listAutomations().map((automation) => automation.nextRunAt).sort((left, right) => Number(left) - Number(right)))
      .toEqual([clock + 30 * 60_000, clock + 60_000, clock + 2 * 60_000].sort((left, right) => left - right));
    expect(store.claimDueAutomations()).toEqual([]);
    expect(database.prepare("SELECT input_text FROM tasks WHERE task_guid='kept-task'").get())
      .toEqual({ input_text: "preserve me" });
    const migratedColumns = database.prepare("PRAGMA table_info(workbench_automation_runs)").all()
      .map((row) => String((row as { name: string }).name));
    expect(migratedColumns).toEqual(expect.arrayContaining([
      "submission_status", "execution_status", "submission_error", "execution_target_key", "execution_id",
      "queue_message_id", "submission_finished_at", "execution_finished_at",
    ]));
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_workbench_automation_runs_execution'").get()).toBeTruthy();
    expect(database.prepare("SELECT version FROM workbench_schema_migrations").get()).toEqual({ version: 1 });

    new WorkbenchStore(database, () => clock);
    expect(store.listAutomationRuns("legacy-claim-automation")).toHaveLength(1);
    expect(database.prepare("SELECT next_run_at FROM workbench_automations WHERE automation_id='legacy-claim-automation'").get())
      .toEqual({ next_run_at: clock + 30 * 60_000 });
  });
});

describe("WorkbenchStore queue", () => {
  it("deduplicates exact submissions, rejects conflicting keys, edits only queued rows, and never replays sending", () => {
    const { database, store } = createStore();
    const target: WorkbenchTarget = { kind: "history", id: "thread-1", homeId: "home-1" };
    const first = store.enqueueQueueMessage(target, { idempotencyKey: "key-1", text: "first" });
    const second = store.enqueueQueueMessage(target, { idempotencyKey: "key-2", text: "second" });
    const third = store.enqueueQueueMessage(target, { idempotencyKey: "key-3", text: "third" });
    expect(store.enqueueQueueMessage(target, { idempotencyKey: "key-1", text: "first" }).id).toBe(first.id);
    expect(() => store.enqueueQueueMessage(target, { idempotencyKey: "key-1", text: "different" })).toThrow(/different queue message content/);
    expect(store.updateQueueMessage(target, second.id, { text: "edited" }).text).toBe("edited");
    expect(store.moveQueueMessage(target, third.id, 0).map((item) => item.id)).toEqual([third.id, first.id, second.id]);

    const claimed = store.claimNextQueueMessage(target);
    expect(claimed).toMatchObject({ id: third.id, status: "sending" });
    expect(store.finishQueueMessage(target, third.id, { status: "failed", error: "send failed" })).toMatchObject({ status: "failed", error: "send failed" });
    expect(() => store.updateQueueMessage(target, third.id, { text: "cannot edit" })).toThrow(/Only queued/);
    expect(() => store.removeQueueMessage(target, third.id)).toThrow(/Only queued/);

    const inFlight = store.claimNextQueueMessage(target);
    expect(inFlight?.id).toBe(first.id);
    expect(store.claimNextQueueMessage(target)).toBeNull();
    expect(store.getQueueMessage(first.id)).toMatchObject({ status: "sending" });
    expect(store.listQueueTargets()).toMatchObject([{ target, queuedCount: 1, sendingCount: 1 }]);
    const restartedStore = new WorkbenchStore(database, () => clock);
    expect(restartedStore.getQueueMessage(first.id)?.status).toBe("sending");
    expect(restartedStore.markStaleQueueMessagesUnconfirmed(clock + 1)).toBe(1);
    expect(restartedStore.listQueueMessages(target).find((item) => item.id === first.id)).toMatchObject({
      status: "unconfirmed",
      error: expect.stringContaining("status is unknown"),
    });
    expect(restartedStore.claimNextQueueMessage(target)?.id).toBe(second.id);
    expect(restartedStore.finishQueueMessage(target, second.id, { status: "sent" })).toMatchObject({ status: "sent" });
    expect(restartedStore.claimNextQueueMessage(target)).toBeNull();
    expect(store.removeQueueMessage({ kind: "history", id: "other", homeId: "home-1" }, second.id)).toBe(false);
  });

  it("keeps idempotency scoped to a target and validates queue bounds", () => {
    const { store } = createStore();
    const target = { kind: "task", id: "task-1", source: "desk" } as const;
    const other = { kind: "task", id: "task-2", source: "desk" } as const;
    store.enqueueQueueMessage(target, { idempotencyKey: "same", text: "one" });
    expect(store.enqueueQueueMessage(other, { idempotencyKey: "same", text: "two" }).text).toBe("two");
    expect(() => store.enqueueQueueMessage(target, { idempotencyKey: "too-long", text: "x".repeat(8_001) })).toThrow(/cannot exceed/);
  });
});

describe("WorkbenchStore notifications and automation", () => {
  it("deduplicates notifications, derives only internal routes, and persists preferences", () => {
    const { store } = createStore();
    const target = { kind: "history", id: "thread/unsafe", homeId: "home/one" } as const;
    const input = { eventKey: "run-1:complete", target, category: "completion" as const, title: "Finished" };
    const first = store.recordNotification(input);
    const duplicate = store.recordNotification(input);
    expect(duplicate.id).toBe(first.id);
    expect(store.hasNotification(input.eventKey)).toBe(true);
    expect(store.hasNotification("missing:event")).toBe(false);
    expect(first.route).toBe("/codex-history/home%2Fone/thread%2Funsafe");
    expect(() => store.recordNotification({ ...input, target: { kind: "task", id: "x", source: "desk" } })).toThrow(/different notification content/);
    expect(store.dismissNotification(first.id)?.dismissedAt).toBe(clock);
    expect(store.hasNotification(input.eventKey)).toBe(true);
    expect(store.listNotifications()).toEqual([]);
    expect(store.listNotifications({ includeDismissed: true })).toHaveLength(1);
    expect(store.getNotificationSettings()).toMatchObject({ completion: true, failure: true, action: true, system: false });
    expect(store.updateNotificationSettings({ completion: false, system: true })).toMatchObject({ completion: false, system: true });
    expect(store.dismissNotification("missing")).toBeNull();
  });

  it("claims due automations once, records submission separately from execution, and requires an available project", () => {
    const { database, store } = createStore();
    registerProject(database);
    const automation = store.createAutomation({
      projectKey: "fixture",
      prompt: "Check the project",
      intervalMinutes: 30,
      timeZone: "Asia/Shanghai",
      enabled: true,
      nextRunAt: clock,
    });
    const [claim] = store.claimDueAutomations(5, 5_000);
    expect(claim?.automation.id).toBe(automation.id);
    expect(claim).toMatchObject({
      trigger: "scheduled",
      run: {
        automationId: automation.id,
        idempotencyKey: `scheduled:${clock}`,
        submissionStatus: "pending",
        executionStatus: "not_started",
        scheduledFor: clock,
      },
    });
    expect(store.claimDueAutomations()).toEqual([]);
    const finished = store.finishAutomationClaim(claim!.claimToken, { status: "failed", error: "scheduler unavailable" });
    expect(finished).toMatchObject({ lastRunAt: clock, nextRunAt: clock + 30 * 60_000, lastError: "scheduler unavailable" });
    expect(store.listAutomationRuns(automation.id)).toMatchObject([{
      submissionStatus: "failed",
      executionStatus: "not_started",
      submissionError: "scheduler unavailable",
    }]);
    expect(() => store.finishAutomationClaim(claim!.claimToken)).toThrow(/not found/);
    expect(store.claimDueAutomations()).toEqual([]);
    expect(store.deleteAutomation(automation.id)).toBe(true);
    expect(() => store.createAutomation({
      projectKey: "missing",
      prompt: "invalid project",
      intervalMinutes: 10,
      timeZone: "UTC",
      enabled: true,
    })).toThrow(/available registered project/);
  });

  it("marks expired scheduled slots unconfirmed without replay and validates target/project references", () => {
    const { database, store } = createStore();
    registerProject(database);
    const automation = store.createAutomation({
      target: { kind: "task", id: "task-1", source: "direct" },
      prompt: "Check status",
      intervalMinutes: 5,
      timeZone: "UTC",
      enabled: true,
      nextRunAt: clock,
    });
    const [claim] = store.claimDueAutomations(1, 1_000);
    expect(store.claimDueAutomations()).toEqual([]);
    clock += 1_000;
    expect(store.claimDueAutomations()).toEqual([]);
    expect(store.listAutomationRuns(automation.id)).toMatchObject([{
      id: claim?.runId,
      submissionStatus: "unconfirmed",
      executionStatus: "unconfirmed",
      scheduledFor: clock - 1_000,
    }]);
    expect(store.listAutomations().find((item) => item.id === automation.id)?.nextRunAt).toBe(clock + 5 * 60_000);
    clock += 5 * 60_000;
    const [nextTick] = store.claimDueAutomations();
    expect(nextTick?.automation.id).toBe(automation.id);
    expect(nextTick?.idempotencyKey).not.toBe(claim?.idempotencyKey);
    expect(store.updateAutomation(automation.id, { projectKey: "fixture" })).toMatchObject({ projectKey: "fixture" });
    expect(store.updateAutomation(automation.id, { target: { kind: "history", id: "thread", homeId: "home" } })).toMatchObject({
      target: { kind: "history", id: "thread", homeId: "home" },
    });
    expect(() => store.updateAutomation(automation.id, { timeZone: "Mars/Olympus" })).toThrow(/IANA time zone/);
    expect(() => store.createAutomation({
      target: { kind: "task", id: "task" },
      projectKey: "fixture",
      prompt: "invalid reference",
      intervalMinutes: 5,
      timeZone: "UTC",
      enabled: true,
    } as never)).toThrow(/exactly one/);
  });

  it("supports idempotent manual claims and records accepted task targets before Codex completion", () => {
    const { store } = createStore();
    const automation = store.createAutomation({
      target: { kind: "history", id: "thread-1", homeId: "home-1" },
      prompt: "Run now",
      intervalMinutes: 60,
      timeZone: "UTC",
      enabled: false,
      nextRunAt: null,
    });
    const claim = store.claimAutomation(automation.id, "manual-request-1");
    expect(store.claimAutomation(automation.id, "manual-request-1").runId).toBe(claim.runId);
    const taskTarget = { kind: "task", id: "desk-task-1", source: "desk" } as const;
    store.finishAutomationClaim(claim.claimToken, { status: "accepted", taskTarget });
    expect(store.listAutomationRuns(automation.id)).toMatchObject([{
      submissionStatus: "accepted",
      executionStatus: "running",
      taskTarget,
    }]);
    expect(store.completeAutomationRun(claim.runId, { status: "failed", taskTarget, error: "Codex exited" })).toMatchObject({
      submissionStatus: "accepted",
      executionStatus: "failed",
      taskTarget,
      executionError: "Codex exited",
    });
    expect(() => store.completeAutomationRun(claim.runId, { status: "completed" })).toThrow(/already been completed differently/);
    expect(() => store.claimAutomation(automation.id, "manual-request-1")).toThrow(/already been used/);
  });

  it("links a queued automation submission to its later execution and completion", () => {
    const { store } = createStore();
    const target = { kind: "history", id: "thread-queue", homeId: "home-queue" } as const;
    const automation = store.createAutomation({
      target,
      prompt: "Continue this thread",
      intervalMinutes: 60,
      timeZone: "UTC",
      enabled: false,
      nextRunAt: null,
    });
    const claim = store.claimAutomation(automation.id, "automation-run-key");
    const message = store.enqueueQueueMessage(target, { idempotencyKey: `automation:${claim.runId}`, text: automation.prompt });
    store.finishAutomationClaim(claim.claimToken, { status: "accepted" });
    expect(store.listAutomationRuns(automation.id)).toMatchObject([{
      submissionStatus: "accepted",
      executionStatus: "not_started",
      executionTarget: target,
      queueMessageId: message.id,
    }]);

    const sending = store.claimNextQueueMessage(target);
    expect(sending?.id).toBe(message.id);
    store.finishQueueMessage(target, message.id, { status: "sent" });
    const linked = store.linkAutomationRun(claim.runId, target, "codex-execution-1");
    expect(linked).toMatchObject({
      submissionStatus: "accepted",
      executionStatus: "running",
      executionTarget: target,
      executionId: "codex-execution-1",
      queueMessageId: message.id,
    });
    expect(store.findAutomationRunByExecution(target, "codex-execution-1")?.id).toBe(claim.runId);
    expect(store.completeAutomationRun(claim.runId, { status: "completed" })).toMatchObject({
      submissionStatus: "accepted",
      executionStatus: "completed",
      executionTarget: target,
      executionId: "codex-execution-1",
      queueMessageId: message.id,
    });
    expect(store.findAutomationRunByExecution(target, "codex-execution-1")?.executionStatus).toBe("completed");
  });

  it("keeps execution evidence when it arrives before scheduler submission finishes", () => {
    const { store } = createStore();
    const automation = store.createAutomation({
      target: { kind: "history", id: "race-thread", homeId: "race-home" },
      prompt: "Submit promptly",
      intervalMinutes: 20,
      timeZone: "UTC",
      enabled: false,
      nextRunAt: null,
    });
    const claim = store.claimAutomation(automation.id, "race-key");
    const taskTarget = { kind: "task", id: "created-task", source: "desk" } as const;
    store.linkAutomationRun(claim.runId, taskTarget, "execution-race");
    store.finishAutomationClaim(claim.claimToken, { status: "failed", error: "late scheduler error" });
    expect(store.listAutomationRuns(automation.id)).toMatchObject([{
      submissionStatus: "accepted",
      executionStatus: "running",
      taskTarget,
      executionId: "execution-race",
    }]);
    expect(store.listAutomations()[0]?.lastError).toBeUndefined();
  });
});

describe("WorkbenchStore machines and pending actions", () => {
  it("keeps the local machine distinct from remote metadata-only profiles and rejects unsafe URLs", () => {
    const { store } = createStore();
    expect(store.listMachineProfiles()).toMatchObject([{ id: "local", kind: "local", execution: "local" }]);
    const remote = store.createMachineProfile({ name: "Dev host", url: "https://bridge.example.test:7443" });
    expect(remote).toMatchObject({ kind: "remote", execution: "metadata-only", url: "https://bridge.example.test:7443/" });
    expect(store.updateMachineProfile(remote.id, { name: "Staging", url: "http://127.0.0.1:7443" })).toMatchObject({
      name: "Staging", execution: "metadata-only", url: "http://127.0.0.1:7443/",
    });
    expect(() => store.createMachineProfile({ name: "Unsafe", url: "http://bridge.example.test" })).toThrow(/loopback/);
    expect(() => store.createMachineProfile({ name: "Credentials", url: "https://user:secret@example.test" })).toThrow(/credentials/);
    expect(store.deleteMachineProfile("local")).toBe(false);
    expect(store.deleteMachineProfile(remote.id)).toBe(true);
  });

  it("records actions idempotently, resolves once, and persists expiration", () => {
    const { store } = createStore();
    const input = {
      runId: "run-1",
      requestId: "request-1",
      target: { kind: "task", id: "task-1", source: "desk" } as const,
      type: "question" as const,
      payload: { question: "Continue?", choices: ["yes", "no"] },
      expiresAt: clock + 5_000,
    };
    const action = store.recordPendingAction(input);
    expect(store.recordPendingAction(input).id).toBe(action.id);
    expect(store.listPendingActions({ target: input.target, statuses: ["pending"] })).toHaveLength(1);
    expect(store.resolvePendingAction(action.id, { answer: "yes" })).toMatchObject({ status: "resolved", response: { answer: "yes" } });
    expect(() => store.resolvePendingAction(action.id, { answer: "no" })).toThrow(/already been resolved/);

    const expired = store.recordPendingAction({ ...input, requestId: "request-2", expiresAt: clock + 1_000 });
    clock += 1_000;
    expect(() => store.resolvePendingAction(expired.id, { answer: "late" })).toThrow(/expired/);
    expect(store.listPendingActions({ statuses: ["expired"] })).toHaveLength(1);
    const third = store.recordPendingAction({ ...input, requestId: "request-3", expiresAt: clock + 2_000 });
    expect(store.expirePendingActions(clock + 2_000)).toBe(1);
    expect(store.listPendingActions({ statuses: ["expired"] }).map((item) => item.id)).toContain(third.id);
    expect(() => store.recordPendingAction({ ...input, requestId: "request-1", payload: { question: "different" } })).toThrow(/different pending action/);
  });

  it("keeps the original expiry when an idempotent pending action retry omits expiresAt", () => {
    const { store } = createStore();
    const input = {
      runId: "run-idempotent",
      requestId: "request-idempotent",
      target: { kind: "history", id: "thread", homeId: "home" } as const,
      type: "approval" as const,
      payload: { action: "apply" },
    };
    const original = store.recordPendingAction(input);
    clock += 60_000;
    const replay = store.recordPendingAction(input);
    expect(replay).toMatchObject({ id: original.id, expiresAt: original.expiresAt });
  });

  it("expires one pending action immediately without changing a resolved action", () => {
    const { store } = createStore();
    const base = {
      runId: "run-expire-one",
      target: { kind: "task", id: "task-expire", source: "desk" } as const,
      type: "approval" as const,
      payload: { action: "approve" },
      expiresAt: clock + 60_000,
    };
    const pending = store.recordPendingAction({ ...base, requestId: "pending" });
    const resolved = store.recordPendingAction({ ...base, requestId: "resolved" });
    store.resolvePendingAction(resolved.id, { approved: true });
    expect(store.expirePendingAction(pending.id)).toMatchObject({ status: "expired", resolvedAt: clock });
    expect(store.expirePendingAction(pending.id)).toMatchObject({ status: "expired" });
    expect(store.expirePendingAction(resolved.id)).toMatchObject({ status: "resolved" });
    expect(store.expirePendingAction("missing")).toBeNull();
    expect(() => store.resolvePendingAction(pending.id, { approved: true })).toThrow(/already been resolved/);
  });

  it("fails loudly if persisted JSON is malformed", () => {
    const { database, store } = createStore();
    const target = { kind: "task", id: "task-1" } as const;
    store.updatePreferences(target, { pinned: true });
    database.prepare("UPDATE workbench_preferences SET tags_json='{' WHERE target_key=?").run(workbenchTargetKey(target));
    expect(() => store.listPreferences()).toThrow(/malformed JSON/);
  });
});
