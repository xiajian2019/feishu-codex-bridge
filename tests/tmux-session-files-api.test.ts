import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";

describe("Session file API identity", () => {
  it("rejects a replaced Session or changed root before reading or writing files", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "bridge-session-files-"));
    const root = realpathSync(temporary);
    const db = new StateDatabase(":memory:");
    const session = { id: "$7", name: "fixture", cwd: root, createdAt: 42, windows: 1, attachedClients: 0 };
    writeFileSync(join(root, "existing.txt"), "existing");
    const api = new TmuxDashboardApi({ db, operations: {
      listSessions: async () => [session], findSession: async () => session, getCurrentPanePath: async () => root,
      createSession: async () => session, killSession: async () => {},
    } });
    async function request(method: string, path: string, createdAt?: number, body = "") {
      const incoming = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
      incoming.method = method;
      incoming.url = `/tmux-dashboard/api/sessions/%247/${path}`;
      incoming.headers = {
        ...(createdAt === undefined ? {} : { "x-bridge-session-created-at": String(createdAt) }),
        "x-file-name": "new.txt", "content-type": "application/octet-stream",
      };
      const response = { statusCode: 0, body: "", setHeader() {}, end(value: string) { this.body = value; } };
      await api.handleRequest(incoming, response as unknown as ServerResponse);
      return { status: response.statusCode, data: JSON.parse(response.body) };
    }
    try {
      const listing = await request("GET", `files?expectedRoot=${encodeURIComponent(root)}`, 42);
      expect(listing.status).toBe(200);
      expect(listing.data).toMatchObject({ root, truncated: false, entries: [{ name: "existing.txt" }] });
      expect((await request("GET", "files", 43)).status).toBe(409);
      expect((await request("GET", "skills?all=1", 43)).status).toBe(409);
      expect((await request("GET", "files/download?path=existing.txt", 43)).status).toBe(409);
      expect((await request("POST", "files/upload", 43, "new")).status).toBe(409);
      expect((await request("POST", "files/upload?expectedRoot=%2Fwrong", 42, "new")).status).toBe(409);
      expect(existsSync(join(root, "new.txt"))).toBe(false);
      expect((await request("GET", "files")).status).toBe(200);

      for (let index = 0; index < 2_000; index += 1) writeFileSync(join(root, `entry-${index}`), "");
      const largeListing = await request("GET", "files", 42);
      expect(largeListing.status).toBe(200);
      expect(largeListing.data.truncated).toBe(true);
      expect(largeListing.data.entries).toHaveLength(2_000);
    } finally {
      await api.stop();
      db.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
