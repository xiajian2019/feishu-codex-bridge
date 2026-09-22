import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  buildCodexAppServerArgs,
  type CodexThread,
} from "../src/codex-app-server.js";
import {
  filterCodexThreads,
  parseCodexThreadQuery,
  parseCodexThreadSources,
} from "../src/codex-cli.js";

describe("Codex app-server read-only query", () => {
  it("disables completion hooks for read-only app-server clients", () => {
    expect(buildCodexAppServerArgs()).toEqual([
      "app-server",
      "-c",
      "notify=[]",
      "--listen",
      "stdio://",
    ]);
  });

  it("builds source, project, title, status, and time filters", () => {
    const query = parseCodexThreadQuery([
      "--source",
      "cli,appServer",
      "--project",
      "food",
      "--search",
      "Fix",
      "--status",
      "active",
      "--since",
      "2026-09-01T00:00:00+08:00",
      "--until=2026-09-14T00:00:00+08:00",
      "--sort",
      "updated_at",
      "--direction",
      "asc",
      "--limit",
      "10",
    ], {
      food: { repo: "/tmp/food" },
    });

    expect(query).toMatchObject({
      sourceKinds: ["cli", "appServer"],
      cwd: ["/tmp/food"],
      searchTerm: "Fix",
      archived: false,
      statuses: ["active"],
      sortKey: "updated_at",
      sortDirection: "asc",
      limit: 10,
    });
    expect(query.sinceMs).toBe(Date.parse("2026-09-01T00:00:00+08:00"));
    expect(query.untilMs).toBe(Date.parse("2026-09-14T00:00:00+08:00"));
  });

  it("filters runtime status and recency locally", () => {
    const query = parseCodexThreadQuery([
      "--status=active",
      "--since=2026-09-01T00:00:00Z",
      "--until=2026-09-10T00:00:00Z",
    ]);
    const threads: CodexThread[] = [
      { id: "active-in-range", status: { type: "active" }, updatedAt: Math.floor(Date.parse("2026-09-05T00:00:00Z") / 1_000) },
      { id: "idle-in-range", status: { type: "idle" }, updatedAt: Math.floor(Date.parse("2026-09-05T00:00:00Z") / 1_000) },
      { id: "active-out-of-range", status: { type: "active" }, updatedAt: Math.floor(Date.parse("2026-09-12T00:00:00Z") / 1_000) },
    ];

    expect(filterCodexThreads(threads, query).map((thread) => thread.id)).toEqual([
      "active-in-range",
    ]);
  });

  it("rejects unknown source kinds", () => {
    expect(() => parseCodexThreadSources(["cli", "desktopApp"])).toThrow(/未知 Codex thread 来源/);
  });

  it("speaks JSONL with a short-lived read-only app-server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feishu-codex-app-server-test-"));
    const executable = join(directory, "fake-codex");
    await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const output = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    output({ id: request.id, result: { userAgent: "fake" } });
  } else if (request.method === "thread/list" && request.params.useStateDbOnly === true && request.params.sourceKinds.includes("cli")) {
    output({ id: request.id, result: {
      data: [{ id: "thr_fake", preview: "Read-only test", source: "cli", status: { type: "idle" } }],
      nextCursor: null,
      backwardsCursor: null,
    } });
  } else if (request.method === "thread/list") {
    output({ id: request.id, error: { code: -32602, message: "expected read-only query parameters" } });
  } else if (request.method === "thread/read") {
    output({ id: request.id, result: {
      thread: { id: request.params.threadId, preview: "Read-only detail", turns: [] },
    } });
  }
});
`);
    await chmod(executable, 0o700);

    try {
      const client = new CodexAppServerClient({ executable, cwd: directory, requestTimeoutMs: 2_000 });
      await expect(client.listThreads({ sourceKinds: ["cli"], useStateDbOnly: true })).resolves.toMatchObject({
        data: [{ id: "thr_fake", source: "cli" }],
        nextCursor: null,
      });
      await expect(client.readThread("thr_fake")).resolves.toMatchObject({
        thread: { id: "thr_fake", preview: "Read-only detail" },
      });
      await client.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
