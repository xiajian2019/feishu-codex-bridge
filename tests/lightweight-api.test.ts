import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { DatabaseSync } from "../src/sqlite.js";
import { WebPairingAuth } from "../src/web-auth.js";
import { DashboardServer } from "../src/web.js";

it("serves paired lightweight reads and idle maintenance while another connection holds the WAL writer lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-lightweight-api-"));
  const path = join(root, "fixture.db");
  const db = new StateDatabase(path);
  const writer = new DatabaseSync(path);
  let now = Date.now();
  const auth = new WebPairingAuth({ db, now: () => now });
  const remote = { headers: { "user-agent": "fixture" }, socket: { remoteAddress: "203.0.113.1" } } as unknown as IncomingMessage;
  const token = auth.claimPairing(remote, auth.startPairing().code);
  now += 60_001;
  const warnings: string[] = [];
  const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [], cleanupExpiredStagedAttachments: false,
    logger: { info() {}, error() {}, warn(message) { warnings.push(message); } } });
  let locked = false;
  try {
    const url = await server.start();
    const actionInput = { runId: "run", requestId: "question", target: { kind: "history", id: "thread", homeId: "home" } as const,
      type: "question" as const, payload: { question: "fixture?" } };
    const action = db.workbench.recordPendingAction(actionInput);
    writer.exec("BEGIN IMMEDIATE"); locked = true;
    const start = performance.now();
    const responses = await Promise.all(["/api/workbench/inbox", "/api/shortcut-config/revision"].map(async (endpoint) => {
      const response = await fetch(url + endpoint, { headers: { Cookie: `bridge_session=${token}`, "User-Agent": "fixture" } });
      return { status: response.status, body: await response.json() };
    }));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0]!.body).toMatchObject({ actions: [{ id: action.id }], notifications: [] });
    expect(responses[1]!.body).toMatchObject({ revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(performance.now() - start).toBeLessThan(1_500);
    expect(db.workbench.recordPendingAction(actionInput).id).toBe(action.id);
    // Let the one-second maintenance timer execute while the writer remains locked.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(warnings).toEqual([]);
    writer.exec("ROLLBACK"); locked = false;
    // Busy handling must restore the normal timeout and let a later access save its metadata.
    const connection = (db as unknown as { db: InstanceType<typeof DatabaseSync> }).db;
    expect(connection.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
    const request = { ...remote, headers: { ...remote.headers, cookie: `bridge_session=${token}` } } as IncomingMessage;
    expect(auth.isAuthorized(request)).toBe(true);
    expect(db.listWebAuthSessions()[0]!.lastSeenAt).toBe(new Date(now).toISOString());
  } finally {
    if (locked) writer.exec("ROLLBACK");
    await server.stop(); writer.close(); db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
