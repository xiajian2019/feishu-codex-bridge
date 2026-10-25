import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi, type TmuxDashboardApiOptions } from "../src/tmux-dashboard-api.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(options: { allowLocalRequests?: boolean; now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bridge-connection-auth-"));
  const dbPath = join(root, "fixture.db");
  const db = new StateDatabase(dbPath);
  db.createProject({ name: "fixture", path: root });
  const auth = new WebPairingAuth({ db, ...options });
  const sockets: WebSocket[] = [];
  const terminals: Array<{ writes: string[]; signals: string[]; closed: boolean; emit: (output: string) => void }> = [];
  const calls = { creates: 0, kills: 0, captures: 0 };
  const session = { id: "$41", name: "fixture", windows: 1, attachedClients: 0, cwd: root, createdAt: 1 };
  let capture = async () => "fixture snapshot";
  const runtime: NonNullable<TmuxDashboardApiOptions["terminalRuntime"]> = {
    spawn(command, spawnOptions) {
      expect(command).toEqual(["tmux", "attach-session", "-t", session.id]);
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
      const state = { writes: [] as string[], signals: [] as string[], closed: false, emit: (_output: string) => {} };
      const terminal = {
        write(data: string) { state.writes.push(data); }, resize() {}, close() { state.closed = true; },
      };
      state.emit = (output) => spawnOptions.terminal!.data(terminal, output);
      terminals.push(state);
      return {
        terminal, exited, killed: false,
        kill(signal: string) {
          state.signals.push(signal);
          if (signal === "SIGTERM") { this.killed = true; resolveExit(0); }
        },
      };
    },
  };
  const tmux = new TmuxDashboardApi({ db, terminalRuntime: runtime, operations: {
    listSessions: async () => [session], findSession: async () => session,
    createSession: async () => { calls.creates += 1; return session; },
    killSession: async () => { calls.kills += 1; },
    capturePane: async () => { calls.captures += 1; return capture(); },
  } });
  const server = new DashboardServer({ db, auth, tmuxDashboard: tmux, host: "127.0.0.1", port: 0,
    modes: [], cleanupExpiredStagedAttachments: false, taskAttachmentsDirectory: join(root, "attachments") });
  cleanups.push(async () => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.terminate(); await closed; }
    }
    await server.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = await server.start();
  async function pair() {
    const pairing = auth.startPairing();
    const response = await fetch(url + "/api/auth/pairing/claim", {
      method: "POST", headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const sessionResponse = await fetch(url + "/api/session", { headers: { Cookie: cookie } });
    const { actionToken } = await sessionResponse.json() as { actionToken: string };
    const id = auth.currentDeviceId({ headers: { cookie } } as IncomingMessage)!;
    return { cookie, id, headers: { Cookie: cookie, Origin: url, "X-Bridge-Action-Token": actionToken } };
  }
  async function connect(cookie: string, initialFrame = true) {
    const socket = new WebSocket(url.replace("http:", "ws:") + "/tmux-dashboard/terminal?session=%2441", {
      headers: { Cookie: cookie, Origin: url },
    });
    sockets.push(socket);
    const frame = initialFrame ? once(socket, "message") : null;
    await once(socket, "open");
    if (frame) await frame;
    return socket;
  }
  return { root, db, dbPath, auth, calls, terminals, url, pair, connect, setCapture: (callback: typeof capture) => { capture = callback; } };
}

describe("Dashboard write and connection authorization", () => {
  it("delivers the answer, prompt-back and warning keys directly to the attached terminal", async () => {
    const f = await fixture();
    const device = await f.pair();
    const socket = await f.connect(device.cookie);
    const keys = [
      ["codex-answer", "\u001b[1;2D"],
      ["codex-prompt-back", "\u001b[1;2C"],
      ["codex-warnings", "\u001bOQ"],
    ];
    for (const [key, expected] of keys) {
      const reply = once(socket, "message");
      socket.send(JSON.stringify({ type: "key", requestId: key, key }));
      const [message] = await reply;
      expect(JSON.parse(message.toString())).toMatchObject({ type: "submission-result", requestId: key, ok: true });
      expect(f.terminals[0]!.writes.at(-1)).toBe(expected);
    }
    expect(f.terminals[0]!.writes).toHaveLength(3);
    expect(f.calls.kills).toBe(0);
  });

  it("rejects missing tokens and cross-origin writes before any tmux or device mutation", async () => {
    const f = await fixture();
    const device = await f.pair();
    const routes = [
      ["POST", "/tmux-dashboard/api/sessions", { name: "fixture", projectKey: "fixture" }],
      ["DELETE", "/tmux-dashboard/api/sessions/%2441", undefined],
      ["POST", "/tmux-dashboard/api/attachments", "fixture"],
      ["PATCH", `/api/auth/devices/${device.id}`, { deviceName: "must-not-change" }],
      ["POST", `/api/auth/devices/${device.id}/extend`, undefined],
      ["POST", `/api/auth/devices/${device.id}/revoke`, undefined],
      ["POST", "/api/auth/revoke-all", undefined],
      ["POST", "/api/auth/pairing/start", undefined],
      ["POST", "/api/auth/logout", undefined],
    ] as const;
    for (const [method, path, body] of routes) {
      for (const variant of ["anonymous", "missing-token", "wrong-token", "cross-origin"] as const) {
        const headers: Record<string, string> = { ...device.headers, "Content-Type": "application/json" };
        if (variant === "anonymous") delete headers.Cookie;
        if (variant === "missing-token") delete headers["X-Bridge-Action-Token"];
        if (variant === "wrong-token") headers["X-Bridge-Action-Token"] = "invalid";
        if (variant === "cross-origin") headers.Origin = "http://different-origin.invalid";
        const response = await fetch(f.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        expect({ method, path, variant, status: response.status }).toEqual({ method, path, variant, status: variant === "anonymous" ? 401 : 403 });
        await response.text();
      }
    }
    expect(f.calls.creates).toBe(0);
    expect(f.calls.kills).toBe(0);
    const status = await fetch(f.url + "/api/auth/status", { headers: { Cookie: device.cookie } });
    expect((await status.json() as { authenticated: boolean }).authenticated).toBe(true);

    const create = await fetch(f.url + "/tmux-dashboard/api/sessions", {
      method: "POST", headers: { ...device.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "fixture", projectKey: "fixture" }),
    });
    expect(create.status).toBe(201);
    await create.text();
    const deleted = await fetch(f.url + "/tmux-dashboard/api/sessions/%2441", { method: "DELETE", headers: device.headers });
    expect(deleted.status).toBe(204);
    expect(f.calls).toMatchObject({ creates: 1, kills: 1 });
    // Empty, correctly authorized uploads reach validation without touching the shared attachment directory.
    const upload = await fetch(f.url + "/tmux-dashboard/api/attachments", { method: "POST", headers: device.headers, body: "" });
    expect(upload.status).toBe(400);
    await upload.text();
  });

  it("keeps initial pairing and same-origin read-only diagnostic form downloads usable", async () => {
    const f = await fixture();
    const pairing = f.auth.startPairing();
    const rejected = await fetch(f.url + "/api/auth/pairing/claim", { method: "POST",
      headers: { Origin: "http://different-origin.invalid", "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code }) });
    expect(rejected.status).toBe(403);
    await rejected.text();
    const accepted = await fetch(f.url + "/api/auth/pairing/claim", { method: "POST",
      headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code }) });
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
    for (const crossOrigin of [false, true]) {
      const response = await fetch(f.url + "/tmux-dashboard/api/scroll-diagnostics/export", { method: "POST",
        headers: { Cookie: cookie, Origin: crossOrigin ? "http://different-origin.invalid" : f.url,
          "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ payload: JSON.stringify({ entries: [] }) }) });
      expect(response.status).toBe(crossOrigin ? 403 : 200);
      if (!crossOrigin) expect(response.headers.get("content-disposition")).toContain("attachment");
      await response.text();
    }
  });

  it("closes only a revoked device's attach client and leaves other devices and the tmux session alive", async () => {
    const f = await fixture();
    const target = await f.pair();
    const admin = await f.pair();
    const socket = await f.connect(target.cookie);
    const other = await f.connect(admin.cookie);
    socket.send(JSON.stringify({ type: "input", data: "allowed" }));
    await waitFor(() => f.terminals[0]!.writes.includes("allowed"));
    const close = once(socket, "close");
    const response = await fetch(f.url + `/api/auth/devices/${target.id}/revoke`, { method: "POST", headers: admin.headers });
    expect(response.status).toBe(200);
    await response.text();
    expect((await close)[0]).toBe(1008);
    expect(f.terminals[0]!.closed).toBe(true);
    expect(f.terminals[0]!.signals).toEqual(["SIGTERM"]);
    expect(f.calls.kills).toBe(0);
    expect(other.readyState).toBe(WebSocket.OPEN);
    other.send(JSON.stringify({ type: "input", data: "other-device-still-authorized" }));
    await waitFor(() => f.terminals[1]!.writes.includes("other-device-still-authorized"));
    const denied = await fetch(f.url + "/api/session", { headers: { Cookie: target.cookie } });
    expect(denied.status).toBe(401);
    await denied.text();
    const reconnectRejected = await new Promise<boolean>((resolve) => {
      const reconnect = new WebSocket(f.url.replace("http:", "ws:") + "/tmux-dashboard/terminal?session=%2441", {
        headers: { Cookie: target.cookie, Origin: f.url },
      });
      reconnect.on("error", () => {});
      reconnect.once("open", () => { reconnect.terminate(); resolve(false); });
      reconnect.once("close", () => resolve(true));
    });
    expect(reconnectRejected).toBe(true);
    expect(f.terminals).toHaveLength(2);
  });

  for (const route of ["/api/auth/revoke-all", "/api/auth/logout"]) {
    it(`${route} closes an existing terminal and SSE stream`, async () => {
      const f = await fixture();
      const device = await f.pair();
      const socket = await f.connect(device.cookie);
      const stream = await fetch(f.url + "/api/events", { headers: { Cookie: device.cookie } });
      const reader = stream.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      const closed = once(socket, "close");
      const response = await fetch(f.url + route, { method: "POST", headers: device.headers });
      expect(response.status).toBe(200);
      await response.text();
      expect((await closed)[0]).toBe(1008);
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
      expect(f.calls.kills).toBe(0);
    });
  }

  it("blocks input, resize and output immediately after another DB connection revokes the session", async () => {
    const f = await fixture();
    const device = await f.pair();
    const socket = await f.connect(device.cookie);
    const received: string[] = [];
    socket.on("message", (data) => received.push(data.toString()));
    const otherDb = new StateDatabase(f.dbPath);
    const closed = once(socket, "close");
    try { otherDb.revokeWebAuthSession(device.id, new Date().toISOString()); } finally { otherDb.close(); }
    socket.send(JSON.stringify({ type: "input", data: "must-not-reach-terminal" }));
    socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    f.terminals[0]!.emit("must-not-leak-output");
    expect((await closed)[0]).toBe(1008);
    expect(f.terminals[0]!.writes).toEqual([]);
    expect(f.terminals[0]!.signals).toEqual(["SIGTERM"]);
    expect(received).not.toContain("must-not-leak-output");
    expect(f.calls.kills).toBe(0);
  });

  it("detects external revocation on idle WS/SSE connections without waiting for another command", async () => {
    const f = await fixture();
    const device = await f.pair();
    const socket = await f.connect(device.cookie);
    const stream = await fetch(f.url + "/api/events", { headers: { Cookie: device.cookie } });
    const reader = stream.body!.getReader();
    await reader.read();
    const otherDb = new StateDatabase(f.dbPath);
    const closed = once(socket, "close");
    try { otherDb.revokeAllWebAuthSessions(new Date().toISOString()); } finally { otherDb.close(); }
    expect((await closed)[0]).toBe(1008);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(f.terminals[0]!.closed).toBe(true);
  });

  it("does not send the delayed Enter after authorization is revoked mid-paste", async () => {
    const f = await fixture();
    const device = await f.pair();
    const socket = await f.connect(device.cookie);
    socket.send(JSON.stringify({ type: "command", requestId: "fixture-command", text: "fixture command" }));
    await waitFor(() => f.terminals[0]!.writes.length > 0);
    const closed = once(socket, "close");
    f.auth.revokeAll();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(f.terminals[0]!.writes).toEqual(["\u001b[200~fixture command\u001b[201~"]);
    expect(f.db.listTmuxSessionActions().items[0]?.status).toBe("unconfirmed");
  });

  it("does not leak a pending initial snapshot after revocation", async () => {
    const f = await fixture();
    const device = await f.pair();
    let finishCapture!: (output: string) => void;
    f.setCapture(() => new Promise((resolve) => { finishCapture = resolve; }));
    const socket = await f.connect(device.cookie, false);
    const received: string[] = [];
    socket.on("message", (data) => received.push(data.toString()));
    await waitFor(() => f.calls.captures > 0);
    const closed = once(socket, "close");
    f.auth.revokeAll();
    finishCapture("must-not-leak-snapshot");
    await closed;
    expect(received).toEqual([]);
    expect(f.terminals[0]!.closed).toBe(true);
  });

  it("expires cookie-bound local connections instead of falling back to trusted-local access", async () => {
    let now = Date.now();
    const f = await fixture({ allowLocalRequests: true, now: () => now });
    const device = await f.pair();
    const socket = await f.connect(device.cookie);
    const closed = once(socket, "close");
    now += 31 * 24 * 60 * 60 * 1_000;
    socket.send(JSON.stringify({ type: "input", data: "expired-cookie-input" }));
    expect((await closed)[0]).toBe(1008);
    expect(f.terminals[0]!.writes).toEqual([]);
  });
});
