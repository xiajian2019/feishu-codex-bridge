import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";

function responseFixture() {
  return {
    statusCode: 0,
    body: "",
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) { this.headers.set(name, value); },
    end(value?: string) { this.body = value ?? ""; },
  };
}

function composerRequest(idempotencyKey: string, text: string): IncomingMessage {
  const request = Readable.from([JSON.stringify({ idempotencyKey, text })]) as IncomingMessage;
  request.method = "POST";
  request.url = "/tmux-dashboard/api/sessions/%2411/composer";
  request.headers = {
    "content-type": "application/json",
    "x-bridge-client": "ios-native-ssh",
    "x-bridge-session-created-at": "11",
    "x-bridge-ssh-host": "mac.local",
    "x-bridge-ssh-port": "22",
    "x-bridge-ssh-username": "tester",
  };
  return request;
}

describe("native Composer HTTP API", () => {
  it("binds createdAt and SSH context, sends once, replays by key, and rejects conflicts", async () => {
    const db = new StateDatabase(":memory:");
    const session = { id: "$11", name: "composer", cwd: "/tmp", createdAt: 11, windows: 1, attachedClients: 0 };
    db.recordTmuxSession(session);
    let pasteCount = 0;
    let enterCount = 0;
    let pasted = "";
    const api = new TmuxDashboardApi({
      db,
      operations: {
        listSessions: async () => [session],
        findSession: async () => session,
        createSession: async () => session,
        killSession: async () => {},
        inspectReviewPane: async () => ({
          paneId: "%11", panePid: 11, paneTty: "/dev/ttys011", currentCommand: "zsh", cwd: "/tmp", foregroundCodex: null,
        }),
        pasteTextToPane: async (_paneId, text, beforePaste) => { await beforePaste?.(); pasteCount += 1; pasted = text; },
        sendEnterToPane: async (_paneId, beforeEnter) => { await beforeEnter?.(); enterCount += 1; },
      },
    });
    try {
      const first = responseFixture();
      await api.handleRequest(composerRequest("key-1", "hello"), first as unknown as ServerResponse);
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body)).toMatchObject({ ok: true, status: "sent", resultUnknown: false });
      expect(pasted).toBe("hello");
      expect(pasteCount).toBe(1);
      expect(enterCount).toBe(1);

      const replay = responseFixture();
      await api.handleRequest(composerRequest("key-1", "hello"), replay as unknown as ServerResponse);
      expect(replay.statusCode).toBe(200);
      expect(JSON.parse(replay.body)).toMatchObject({ ok: true, duplicate: true, status: "sent" });
      expect(pasteCount).toBe(1);

      const conflict = responseFixture();
      await api.handleRequest(composerRequest("key-1", "changed"), conflict as unknown as ServerResponse);
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body).error).toContain("幂等键");

      const stale = composerRequest("key-2", "stale");
      stale.headers["x-bridge-session-created-at"] = "12";
      const staleResponse = responseFixture();
      await api.handleRequest(stale, staleResponse as unknown as ServerResponse);
      expect(staleResponse.statusCode).toBe(409);
      expect(pasteCount).toBe(1);
    } finally {
      await api.stop();
      db.close();
    }
  });

  it("binds iOS Composer uploads to Session and SSH context", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-composer-scope-"));
    const db = new StateDatabase(":memory:");
    const session = { id: "$12", name: "composer-scope", cwd: "/tmp", createdAt: 12, windows: 1, attachedClients: 0 };
    db.recordTmuxSession(session);
    const context = {
      "x-bridge-client": "ios-native-ssh",
      "x-bridge-ssh-session-id": "$12",
      "x-bridge-session-created-at": "12",
      "x-bridge-ssh-host": "mac.local",
      "x-bridge-ssh-port": "22",
      "x-bridge-ssh-username": "tester",
    };
    const api = new TmuxDashboardApi({
      db,
      attachmentDirectory: root,
      operations: {
        listSessions: async () => [session],
        findSession: async () => session,
        createSession: async () => session,
        killSession: async () => {},
        inspectReviewPane: async () => ({
          paneId: "%12", panePid: 12, paneTty: "/dev/ttys012", currentCommand: "zsh", cwd: "/tmp", foregroundCodex: null,
        }),
        pasteTextToPane: async (_paneId, _text, beforePaste) => { await beforePaste?.(); },
        sendEnterToPane: async (_paneId, beforeEnter) => { await beforeEnter?.(); },
      },
    });
    const request = (method: string, url: string, body?: string): IncomingMessage => {
      const value = Readable.from(body === undefined ? [] : [body]) as IncomingMessage;
      value.method = method;
      value.url = url;
      value.headers = { ...context, "content-type": "application/json" };
      return value;
    };
    try {
      const created = responseFixture();
      await api.handleRequest(request("POST", "/tmux-dashboard/api/attachments/uploads", JSON.stringify({ fileName: "note.txt", contentType: "text/plain", sizeBytes: 3 })), created as unknown as ServerResponse);
      expect(created.statusCode).toBe(201);
      const uploadId = (JSON.parse(created.body) as { id: string }).id;
      const part = responseFixture();
      const partRequest = request("PUT", `/tmux-dashboard/api/attachments/uploads/${uploadId}?offset=0`, "abc");
      partRequest.headers = { ...context, "content-type": "application/octet-stream" };
      await api.handleRequest(partRequest, part as unknown as ServerResponse);
      expect(part.statusCode).toBe(200);
      const complete = responseFixture();
      await api.handleRequest(request("POST", `/tmux-dashboard/api/attachments/uploads/${uploadId}/complete`, "{}"), complete as unknown as ServerResponse);
      expect(complete.statusCode).toBe(200);

      const send = responseFixture();
      const sendRequest = request("POST", "/tmux-dashboard/api/sessions/%2412/composer", JSON.stringify({
        idempotencyKey: "attachment-key",
        text: "读取文件",
        attachments: [{ uploadId, name: "note.txt", contentType: "text/plain" }],
      }));
      await api.handleRequest(sendRequest, send as unknown as ServerResponse);
      expect(send.statusCode).toBe(200);

      const stale = responseFixture();
      const staleRequest = request("POST", "/tmux-dashboard/api/sessions/%2412/composer", JSON.stringify({
        idempotencyKey: "attachment-key-2",
        text: "读取文件",
        attachments: [{ uploadId, name: "note.txt", contentType: "text/plain" }],
      }));
      staleRequest.headers = { ...staleRequest.headers, "x-bridge-ssh-session-id": "$13" };
      await api.handleRequest(staleRequest, stale as unknown as ServerResponse);
      expect(stale.statusCode).toBe(409);
    } finally {
      await api.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
