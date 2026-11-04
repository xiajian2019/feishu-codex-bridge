import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

describe("Android native SSH Bridge API", () => {
  it("accepts chunked Composer attachments and logs routes without sensitive inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-native-api-"));
    const db = new StateDatabase(":memory:");
    const session = { id: "$7", name: "fixture", cwd: root, createdAt: 42, windows: 1, attachedClients: 0 };
    const tmux = new TmuxDashboardApi({ db, attachmentDirectory: join(root, "attachments"), operations: {
      listSessions: async () => [session], findSession: async () => session,
      getCurrentPanePath: async () => root, createSession: async () => session, killSession: async () => {},
    } });
    const logs: Array<Record<string, unknown>> = [];
    const server = new DashboardServer({ db, tmuxDashboard: tmux, host: "127.0.0.1", port: 0, modes: [],
      auth: new WebPairingAuth({ db, allowLocalRequests: true }), cleanupExpiredStagedAttachments: false,
      logger: { info(message, details) { if (message === "android native ssh api") logs.push(details ?? {}); }, warn() {}, error() {} },
    });
    try {
      const url = await server.start();
      const sessionResponse = await fetch(`${url}/api/session`);
      const { actionToken } = await sessionResponse.json() as { actionToken: string };
      const headers = { Origin: url, "X-Bridge-Action-Token": actionToken, "X-Bridge-Client": "android-native-ssh" };
      const identity = await fetch(`${url}/tmux-dashboard/api/sessions/%247/identity?secret=do-not-log`, {
        headers: { ...headers, "X-Bridge-Session-Created-At": "42" },
      });
      expect(identity.status).toBe(200);
      const create = await fetch(`${url}/tmux-dashboard/api/attachments/uploads`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "private-secret.txt", contentType: "text/plain", sizeBytes: 6 }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { id: string; offset: number; chunkBytes: number };
      expect(created.offset).toBe(0);
      for (const [offset, chunk] of [[0, "abc"], [3, "def"]] as const) {
        const part = await fetch(`${url}/tmux-dashboard/api/attachments/uploads/${created.id}?offset=${offset}`, {
          method: "PUT", headers, body: chunk,
        });
        expect(part.status).toBe(200);
        expect((await part.json() as { offset: number }).offset).toBe(offset + chunk.length);
      }
      const complete = await fetch(`${url}/tmux-dashboard/api/attachments/uploads/${created.id}/complete`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
      });
      expect(complete.status).toBe(200);
      const result = await complete.json() as { filePath: string; sizeBytes: number };
      expect(result.sizeBytes).toBe(6);
      expect(await readFile(result.filePath, "utf8")).toBe("abcdef");
      expect(logs).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "/tmux-dashboard/api/sessions/:session/identity", sessionId: "$7", status: 200, completed: true }),
        expect.objectContaining({ route: "/tmux-dashboard/api/attachments/uploads/:upload/complete", status: 200 }),
      ]));
      const serialized = JSON.stringify(logs);
      for (const secret of ["do-not-log", "private-secret.txt", "abcdef", actionToken, created.id]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await server.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
