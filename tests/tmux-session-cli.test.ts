import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { restorePendingTmuxSessions } from "../src/tmux-session-cli.js";
import type { TmuxResurrectController } from "../src/tmux-resurrect.js";

describe("tmux restore CLI", () => {
  it("restores pending names and performs the explicit SQLite sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-tmux-restore-cli-"));
    const databasePath = join(root, "bridge.db");
    const database = new StateDatabase(databasePath);
    database.recordTmuxSession({ id: "$1", name: "alpha", cwd: "/tmp", createdAt: 1 });
    database.close();

    const restored = { id: "$2", name: "alpha", cwd: "/tmp", createdAt: 2 };
    let listCalls = 0;
    let requested: { active: string[]; live: string[] } | undefined;
    const resurrect = {
      status: () => ({ installed: true, configured: true, automaticSave: false, automaticRestore: false,
        perSessionRestore: true, automaticStart: false, pluginDirectory: "/tmp", saveDirectory: "/tmp",
        sessionSnapshotDirectory: "/tmp", configPath: null, lastSnapshotAt: null }),
      saveSession: async () => { throw new Error("unused"); },
      restoreSession: async () => { throw new Error("unused"); },
      restorePendingSessions: async (active: string[], live: string[]) => {
        requested = { active, live };
        return { restored: ["alpha"], failures: [] };
      },
      snapshotForSession: () => null,
      disableSession: () => {},
    } satisfies TmuxResurrectController;
    try {
      const result = await restorePendingTmuxSessions({
        databasePath,
        resurrect,
        listSessions: async () => {
          listCalls += 1;
          return listCalls === 1 ? [] : [restored];
        },
      });
      expect(requested).toEqual({ active: ["alpha"], live: [] });
      expect(result.restored).toEqual(["alpha"]);
      expect(result.after).toEqual([{ id: "$2", name: "alpha", createdAt: 2 }]);

      const check = new StateDatabase(databasePath);
      expect(check.getLatestTmuxSession("$1")?.ended_at).not.toBeNull();
      expect(check.getLatestTmuxSession("$2")).toMatchObject({ session_name: "alpha", ended_at: null });
      check.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
