import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { TmuxVerifier } from "../src/tmux-verifier.js";
import { TmuxVerifierStore } from "../src/tmux-verifier-store.js";
import { TmuxVerifierWebServer } from "../src/tmux-verifier-web.js";
import { DashboardServer } from "../src/web.js";
import type { RoutedTask } from "../src/types.js";

const openServers: DashboardServer[] = [];
const openDatabases: StateDatabase[] = [];
const openVerifierStores: TmuxVerifierStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.stop()));
  openDatabases.splice(0).forEach((db) => db.close());
  openVerifierStores.splice(0).forEach((store) => store.close());
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DashboardServer", () => {
  it("filters tasks and returns run details from the shared database", async () => {
    const db = new StateDatabase(":memory:");
    openDatabases.push(db);
    const task: RoutedTask = {
      taskGuid: "task-dashboard-1",
      summary: "修复导出时区",
      description: "CSV 时间少八小时",
      projectKey: "food",
      mode: "implement",
      repo: "/tmp/food",
      sandboxMode: "workspace-write",
      inputHash: "dashboard-hash",
      input: {
        projectKey: "food",
        mode: "implement",
        summary: "修复导出时区",
        description: "CSV 时间少八小时",
      },
      completed: false,
    };
    const claim = db.claimRun({
      task,
      inputText: JSON.stringify(task.input),
      promptText: "prompt",
      startedComment: "started",
    });
    expect(claim).not.toBeNull();
    db.recordRunProgress(claim!.runId, {
      eventType: "item.started",
      itemType: "command_execution",
      itemId: "item-1",
      message: "正在检查仓库结构",
      at: "2026-09-01T00:00:01.000Z",
    });

    const server = new DashboardServer({
      db,
      host: "127.0.0.1",
      port: 0,
      projects: ["food"],
      modes: ["implement"],
      actions: {
        interruptTask: async (taskGuid, reason) => ({
          ok: taskGuid === "task-dashboard-1" && reason === "测试中断",
        }),
        appendFeedback: async (taskGuid, details) => ({
          ok: taskGuid === "task-dashboard-1" && details === "补充",
          state: "RUNNING",
        }),
      },
    });
    openServers.push(server);
    const url = await server.start();

    const listResponse = await fetch(
      `${url}/api/tasks?state=QUEUED&project=food&q=${encodeURIComponent("时区")}`,
    );
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as {
      total: number;
      items: Array<{ task_guid: string; input: { summary: string }; progress_text: string }>;
    };
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      task_guid: "task-dashboard-1",
      input: { summary: "修复导出时区" },
      progress_text: "正在检查仓库结构",
    });

    const detailResponse = await fetch(`${url}/api/tasks/task-dashboard-1`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as { runs: Array<{ events: unknown[] }>; outbox: unknown[] };
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].events).toHaveLength(1);
    expect(detail.outbox).toHaveLength(1);

    const pageResponse = await fetch(url);
    expect(pageResponse.headers.get("content-security-policy")).toContain("frame-ancestors");
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("id=\"root\"");
    expect(page).toContain("bridge-action-token");
    expect(page).toMatch(/<script[^>]+type="module"/);
    const scriptPath = /<script[^>]+src="([^"]+)"/.exec(page)?.[1];
    expect(scriptPath).toBeTruthy();
    const assetResponse = await fetch(`${url}${scriptPath}`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("x-content-type-options")).toBe("nosniff");
    const actionToken = /name="bridge-action-token" content="([^"]+)"/.exec(page)?.[1];
    expect(actionToken).toBeTruthy();

    for (const route of ["/tmux", "/tmux-dashboard"]) {
      const routedPage = await fetch(url + route);
      expect(routedPage.status).toBe(200);
      expect(await routedPage.text()).toContain('id="root"');
    }

    const sessionResponse = await fetch(`${url}/api/session`);
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ actionToken });

    const eventResponse = await fetch(`${url}/api/events`);
    expect(eventResponse.status).toBe(200);
    expect(eventResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = eventResponse.body?.getReader();
    expect(reader).toBeTruthy();
    const firstEvent = await reader!.read();
    expect(new TextDecoder().decode(firstEvent.value)).toContain("event: ready");
    db.recordRunProgress(claim!.runId, {
      eventType: "item.completed",
      itemType: "command_execution",
      itemId: "item-1",
      message: "仓库结构读取完成",
      at: "2026-09-01T00:00:02.000Z",
    });
    const changeEvent = await reader!.read();
    expect(new TextDecoder().decode(changeEvent.value)).toContain("event: task.updated");
    await reader!.cancel();

    const invalidAction = await fetch(`${url}/api/tasks/task-dashboard-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Action-Token": "bad" },
      body: JSON.stringify({ action: "interrupt" }),
    });
    expect(invalidAction.status).toBe(403);

    const interruptResponse = await fetch(`${url}/api/tasks/task-dashboard-1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Action-Token": actionToken as string,
      },
      body: JSON.stringify({ action: "interrupt", reason: "测试中断" }),
    });
    expect(interruptResponse.status).toBe(200);

    const feedbackResponse = await fetch(`${url}/api/tasks/task-dashboard-1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Action-Token": actionToken as string,
      },
      body: JSON.stringify({ action: "feedback", details: "补充" }),
    });
    expect(feedbackResponse.status).toBe(200);
  });

  it("serves Bridge, verifier, and dashboard APIs from one backend listener", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-unified-tmux-"));
    temporaryDirectories.push(directory);
    const projectMapPath = join(directory, "project-map.yaml");
    await writeFile(projectMapPath, "projects:\n  food:\n    root: /tmp/food\n", "utf8");
    const sessions = [{
      id: "$42",
      name: "dev",
      windows: 1,
      attachedClients: 0,
      cwd: "/tmp/food",
      createdAt: 1,
    }];
    const dashboardApi = new TmuxDashboardApi({
      projectMapPath,
      operations: {
        createSession: async () => sessions[0]!,
        findSession: async () => undefined,
        killSession: async () => undefined,
        listSessions: async () => sessions,
      },
    });
    const verifierStore = new TmuxVerifierStore(":memory:");
    openVerifierStores.push(verifierStore);
    const verifier = new TmuxVerifier({ store: verifierStore });
    const verifierWeb = new TmuxVerifierWebServer({
      verifier,
      host: "127.0.0.1",
      port: 0,
      projectMapPath,
    });
    const db = new StateDatabase(":memory:");
    openDatabases.push(db);
    const bridge = new DashboardServer({
      db,
      host: "127.0.0.1",
      port: 0,
      projects: [],
      modes: [],
      tmuxVerifier: verifierWeb,
      tmuxDashboard: dashboardApi,
    });
    openServers.push(bridge);

    const bridgeUrl = await bridge.start();
    const dashboardResponse = await fetch(bridgeUrl + "/tmux-dashboard/api/projects");
    expect(dashboardResponse.status).toBe(200);
    expect(await dashboardResponse.json()).toEqual({
      projects: [{ name: "food", root: "/tmp/food" }],
    });

    const sessionsResponse = await fetch(bridgeUrl + "/tmux-dashboard/api/sessions");
    expect(sessionsResponse.status).toBe(200);
    expect(await sessionsResponse.json()).toEqual({ sessions });

    const verifierResponse = await fetch(bridgeUrl + "/api/tmux/sessions");
    expect(verifierResponse.status).toBe(200);
    expect(await verifierResponse.json()).toEqual({ items: [] });

    const terminalStatus = await new Promise<number>((resolve, reject) => {
      const terminalSocket = new WebSocket(
        bridgeUrl.replace(/^http/, "ws") + "/tmux-dashboard/terminal?session=%2442",
        { headers: { Origin: bridgeUrl } },
      );
      terminalSocket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        terminalSocket.terminate();
      });
      terminalSocket.once("error", reject);
    });
    expect(terminalStatus).toBe(404);

    const bridgeResponse = await fetch(bridgeUrl + "/api/session");
    expect(bridgeResponse.status).toBe(200);
  });

});
