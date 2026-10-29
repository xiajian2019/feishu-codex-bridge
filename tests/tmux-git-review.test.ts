import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { StateDatabase } from "../src/db.js";
import { startTerminalHeartbeat, TmuxDashboardApi, type TerminalHeartbeatPeer, type TmuxDashboardApiOptions } from "../src/tmux-dashboard-api.js";
import { selectForegroundCodexProcess, type TmuxReviewPaneSnapshot } from "../src/tmux-dashboard.js";
import {
  parseTmuxReviewDiffLines,
  reviewAnchorMismatch,
  tmuxReviewTargetMismatch,
  type TmuxReviewAnchor,
  type TmuxReviewTarget,
} from "../src/tmux-review.js";
import {
  createGitReviewDraftForward,
  gitReviewLocation,
  gitReviewGutterDigits,
  gitReviewRangeContains,
  gitReviewTextLines,
  makeDiffAnchor,
  makeTextAnchor,
  makeGitReviewRange,
  createGitReviewMarker,
  extractGitReviewMarkerIds,
  formatGitReviewComments,
  loadGitReviewComments,
  mergeGitReviewAnchors,
  newGitReviewComment,
  parseGitReviewLines,
  removePendingGitReviewDelivery,
  saveGitReviewComments,
  savePendingGitReviewDelivery,
  stripGitReviewMarkers,
  type GitReviewAnchor,
} from "../web/src/git-review-drafts.js";
import { failPendingTmuxSubmissionsOnDisconnect } from "../web/src/tmux-terminal-utils.js";
import type { WebSocket } from "ws";

const temporaryRoots: string[] = [];
const databases: StateDatabase[] = [];
const apis: TmuxDashboardApi[] = [];

afterEach(() => {
  for (const api of apis.splice(0)) api.stop();
  for (const db of databases.splice(0)) db.close();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface GitFixture {
  root: string;
  anchor: TmuxReviewAnchor;
}

function createGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "bridge-git-review-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  const filePath = join(root, "src", "review.ts");
  execFileSync("mkdir", ["-p", join(root, "src")]);
  writeFileSync(filePath, "const count = 1;\nremove me\nkeep me\n");
  execFileSync("git", ["add", "src/review.ts"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  writeFileSync(filePath, "const count = 2;\nkeep me\n");
  const patch = execFileSync("git", ["-c", "core.quotepath=false", "diff", "--no-color", "--unified=3", "HEAD", "--"], {
    cwd: root,
    encoding: "utf8",
  });
  const parsed = parseTmuxReviewDiffLines(patch);
  const deleted = parsed.find((line) => line.kind === "delete" && line.text === "remove me");
  if (!deleted) throw new Error("fixture diff has no deleted line");
  return {
    root,
    anchor: {
      path: "src/review.ts",
      oldPath: null,
      oldLine: deleted.oldLine,
      newLine: deleted.newLine,
      side: "old",
      snippet: deleted.text,
      noNewline: deleted.noNewline,
    },
  };
}

const foregroundCodex = { pid: 2034, startedAt: "Sat Oct 24 10:20:30 2026", command: "codex" as const };

function createApi(root: string, options: {
  foregroundCodex?: typeof foregroundCodex | null;
  paneId?: string;
  sessionExists?: boolean;
  sessionName?: string;
  terminalRuntime?: TmuxDashboardApiOptions["terminalRuntime"];
  heartbeatIntervalMs?: number;
} = {}): TmuxDashboardApi {
  const db = new StateDatabase(":memory:");
  databases.push(db);
  const session = { id: "$1", name: options.sessionName ?? "review-fixture", cwd: root, createdAt: 1, windows: 1, attachedClients: 0 };
  const api = new TmuxDashboardApi({
    db,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    terminalRuntime: options.terminalRuntime,
    operations: {
      createSession: async () => session,
      findSession: async () => options.sessionExists === false ? undefined : session,
      killSession: async () => undefined,
      listSessions: async () => options.sessionExists === false ? [] : [session],
      inspectReviewPane: async () => ({
        paneId: options.paneId ?? "%3",
        panePid: 100,
        paneTty: "/dev/ttysfixture",
        currentCommand: options.foregroundCodex === null ? "zsh" : "codex",
        cwd: root,
        foregroundCodex: options.foregroundCodex === undefined ? foregroundCodex : options.foregroundCodex,
      }),
      capturePane: async () => "fixture screen",
    },
  });
  apis.push(api);
  return api;
}

class ResponseFixture {
  statusCode = 0;
  body = "";
  setHeader(): void {}
  end(value?: string | Buffer): void { this.body = value === undefined ? "" : String(value); }
  json(): Record<string, unknown> { return JSON.parse(this.body) as Record<string, unknown>; }
}

function requestFixture(method: string, url: string, body?: unknown): IncomingMessage {
  const serialized = body === undefined ? "" : JSON.stringify(body);
  const request = Readable.from(serialized ? [serialized] : []) as Readable & Record<string, unknown>;
  request.url = url;
  request.method = method;
  request.headers = serialized
    ? { "content-length": String(Buffer.byteLength(serialized)), "content-type": "application/json" }
    : {};
  return request as unknown as IncomingMessage;
}

async function callApi(api: TmuxDashboardApi, method: string, path: string, body?: unknown): Promise<ResponseFixture> {
  const response = new ResponseFixture();
  await api.handleRequest(
    requestFixture(method, "/tmux-dashboard/api" + path, body),
    response as unknown as ServerResponse,
  );
  return response;
}

class FakeReviewWebSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Array<string | Buffer> = [];

  send(data: string | Buffer): void { this.sent.push(data); }
  ping(): void {}
  terminate(): void { this.close(1006, "terminated"); }
  close(code = 1000, reason = "closed"): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
  receive(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }
}

function reviewPane(root: string, options: {
  paneId?: string;
  foregroundCodex?: typeof foregroundCodex | null;
} = {}): TmuxReviewPaneSnapshot {
  return {
    paneId: options.paneId ?? "%3",
    panePid: 100,
    paneTty: "/dev/ttysfixture",
    currentCommand: options.foregroundCodex === null ? "zsh" : "codex",
    cwd: root,
    foregroundCodex: options.foregroundCodex === undefined ? foregroundCodex : options.foregroundCodex,
  };
}

function createReviewWsHarness(root: string, initialPane: TmuxReviewPaneSnapshot) {
  const db = new StateDatabase(":memory:");
  databases.push(db);
  const session = { id: "$1", name: "review-ws-fixture", cwd: root, createdAt: 1, windows: 1, attachedClients: 0 };
  const sessionRecord = db.recordTmuxSession(session);
  const socket = new FakeReviewWebSocket();
  const pasted: Array<{ paneId: string; text: string }> = [];
  const entered: string[] = [];
  const attachWrites: string[] = [];
  let currentPane = initialPane;
  let paneSequence: TmuxReviewPaneSnapshot[] = [];
  const terminal = {
    write(value: string) { attachWrites.push(value); },
    resize() {},
    close() {},
  };
  const api = new TmuxDashboardApi({
    db,
    terminalRuntime: {
      spawn: (() => ({
        terminal,
        exited: new Promise<number>(() => undefined),
        killed: false,
        kill() {},
      })) as never,
    },
    operations: {
      createSession: async () => session,
      findSession: async () => session,
      killSession: async () => undefined,
      listSessions: async () => [session],
      inspectReviewPane: async () => {
        if (paneSequence.length > 0) currentPane = paneSequence.shift()!;
        return currentPane;
      },
      capturePane: async () => "fake pane screen",
      pasteTextToPane: async (paneId, text, beforePaste) => {
        await beforePaste?.();
        pasted.push({ paneId, text });
      },
      sendEnterToPane: async (paneId, beforeEnter) => {
        await beforeEnter?.();
        entered.push(paneId);
      },
    },
  });
  apis.push(api);
  return {
    api,
    socket,
    pasted,
    entered,
    attachWrites,
    setPane(pane: TmuxReviewPaneSnapshot): void { currentPane = pane; paneSequence = []; },
    setPaneSequence(sequence: TmuxReviewPaneSnapshot[]): void { paneSequence = [...sequence]; },
    async open(): Promise<void> {
      const openTerminal = (api as unknown as {
        openTerminal(client: WebSocket, data: {
          sessionId: string;
          sessionRecordId: string;
          deviceId: string | null;
          cols: number;
          rows: number;
          isAuthorized(): boolean;
        }): Promise<void>;
      }).openTerminal.bind(api);
      await openTerminal(socket as unknown as WebSocket, {
        sessionId: session.id,
        sessionRecordId: sessionRecord.record_id,
        deviceId: null,
        cols: 80,
        rows: 24,
        isAuthorized: () => true,
      });
    },
  };
}

async function waitForReviewSubmission(socket: FakeReviewWebSocket, requestId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = socket.sent.filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame.type === "submission-result" && frame.requestId === requestId);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for review submit ${requestId}`);
}

function target(root: string): TmuxReviewTarget {
  return { sessionId: "$1", paneId: "%3", gitRoot: root, foregroundCodex };
}

function anchorBody(anchor: TmuxReviewAnchor): Record<string, unknown> {
  return { ...anchor, headCommit: "fixture-head" };
}

describe("Tmux Git review target and anchors", () => {
  it("sizes old and new gutters independently from visible line-number digits", () => {
    expect(gitReviewGutterDigits([])).toEqual({ oldDigits: 2, newDigits: 2 });
    expect(gitReviewGutterDigits(parseGitReviewLines("@@ -7 +9 @@\n a\n"))).toEqual({ oldDigits: 2, newDigits: 2 });
    expect(gitReviewGutterDigits(parseGitReviewLines("@@ -999,2 +1000,2 @@\n a\n b\n"))).toEqual({ oldDigits: 4, newDigits: 4 });
    expect(gitReviewGutterDigits(parseGitReviewLines("@@ -9999,2 +999,2 @@\n a\n b\n"))).toEqual({ oldDigits: 5, newDigits: 4 });
    expect(gitReviewGutterDigits(gitReviewTextLines("a\nb\n"))).toEqual({ oldDigits: 2, newDigits: 2 });
  });
  it("selects a continuous range on one side and persists all selected text and line numbers", () => {
    const lines = parseGitReviewLines("@@ -1,3 +1,3 @@\n-before\n+after\n keep\n end\n");
    const first = makeDiffAnchor("src/range.ts", null, "head", lines[1]!, "new");
    const last = makeDiffAnchor("src/range.ts", null, "head", lines[3]!, "new");
    const range = makeGitReviewRange(last, first, lines);
    expect(range).toMatchObject({ kind: "range", newLine: 1, newEndLine: 3, oldLine: null, snippet: "after\nkeep\nend" });
    expect(gitReviewLocation(range)).toBe("新行 1–3");
    expect([1, 2, 3, 4].map((line) => gitReviewRangeContains(range, "new", line))).toEqual([true, true, true, false]);
    expect(gitReviewRangeContains(range, "old", 2)).toBe(false);
    expect(gitReviewRangeContains(first, "new", 1)).toBe(true);
    expect(gitReviewRangeContains(first, "new", 2)).toBe(false);
    const old = makeGitReviewRange(makeDiffAnchor("src/range.ts", null, "head", lines[0]!, "old"), { ...last, side: "old" }, lines);
    expect(old).toMatchObject({ oldLine: 1, oldEndLine: 3, snippet: "before\nkeep\nend" });
    const comment = newGitReviewComment(range, "检查整个区块");
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    saveGitReviewComments("$1", "/repo", [comment], storage);
    expect(loadGitReviewComments("$1", "/repo", storage)[0]?.anchor).toEqual(range);
    const forward = createGitReviewDraftForward("$1", [comment]);
    expect(forward.text).toContain("新行 1–3");
    expect(forward.text).toContain("   after\n   keep\n   end");
    expect(forward.text).not.toContain("before");
  });

  it("does not select hidden gaps or mix files/sides, and keeps untracked EOF ranges", () => {
    const lines = parseGitReviewLines("@@ -1 +1 @@\n a\n@@ -8 +8 @@\n b\n");
    const start = makeDiffAnchor("a.ts", null, "head", lines[0]!, "new");
    const end = makeDiffAnchor("a.ts", null, "head", lines[1]!, "new");
    expect(() => makeGitReviewRange(start, end, lines)).toThrow(/未展示/);
    expect(() => makeGitReviewRange(start, { ...start, side: "old" }, lines)).toThrow(/同一侧/);
    expect(() => makeGitReviewRange(start, { ...start, path: "b.ts" }, lines)).toThrow(/同一文件/);
    expect(() => makeGitReviewRange(start, { ...start, newLine: 201 }, lines)).toThrow(/200/);
    const text = "first\nlast";
    const range = makeGitReviewRange(makeTextAnchor("new.txt", "head", 1, "first", false), makeTextAnchor("new.txt", "head", 2, "last", true), gitReviewTextLines(text));
    expect(range).toMatchObject({ newLine: 1, newEndLine: 2, snippet: text, noNewline: true });
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => {} };
    saveGitReviewComments("$1", "/repo", [newGitReviewComment({ ...range, newEndLine: 99 }, "invalid")], storage);
    expect(loadGitReviewComments("$1", "/repo", storage)).toEqual([]);
  });
  it("stages plain editable composer text for the original Session without a Codex/pane binding", () => {
    const comment = newGitReviewComment({ path: "src/a.ts", oldPath: null, kind: "add", oldLine: null, newLine: 7,
      side: "new", snippet: "const value = 1;", noNewline: false, headCommit: "older-head" }, "请检查这一行");
    const forward = createGitReviewDraftForward("$1", [comment]);
    expect(Object.keys(forward).sort()).toEqual(["id", "sessionId", "text"]);
    expect(forward.sessionId).toBe("$1");
    expect(forward.text).toContain("src/a.ts");
    expect(forward.text).toContain("新行 7");
    expect(forward.text).toContain("请检查这一行");
    expect(extractGitReviewMarkerIds(forward.text)).toEqual([]);
    expect(() => createGitReviewDraftForward("$1", [])).toThrow();
  });
  it("settles an in-flight composer submit as uncertain and clears it before reconnect", () => {
    const results: Array<{ ok: boolean; message?: string }> = [];
    const waiters = new Map<string, (result: { ok: boolean; message?: string }) => void>([
      ["in-flight", (result) => results.push(result)],
    ]);
    failPendingTmuxSubmissionsOnDisconnect(waiters);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.message).toContain("消息可能已经送达");
    expect(waiters.size).toBe(0);
    failPendingTmuxSubmissionsOnDisconnect(waiters);
    expect(results).toHaveLength(1);
  });

  it("uses exact old/new line coordinates and preserves deleted lines and EOF newline markers", () => {
    const patch = [
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -4,3 +4,3 @@",
      " same",
      "-removed",
      "+added",
      "\\ No newline at end of file",
    ].join("\n");
    const serverLines = parseTmuxReviewDiffLines(patch);
    const clientLines = parseGitReviewLines(patch);
    expect(serverLines).toEqual(clientLines);
    expect(serverLines).toEqual([
      { kind: "context", oldLine: 4, newLine: 4, text: "same", noNewline: false },
      { kind: "delete", oldLine: 5, newLine: null, text: "removed", noNewline: false },
      { kind: "add", oldLine: null, newLine: 5, text: "added", noNewline: true },
    ]);
  });

  it("rejects a review target whose active pane or repository changed", () => {
    const original = target("/repo/original");
    const paneMismatch = tmuxReviewTargetMismatch(original, {
      sessionExists: true,
      sessionId: "$1",
      paneId: "%9",
      gitRoot: "/repo/original",
      foregroundCodex,
    });
    expect(paneMismatch).toContain("pane changed");
    const rootMismatch = tmuxReviewTargetMismatch(original, {
      sessionExists: true,
      sessionId: "$1",
      paneId: "%3",
      gitRoot: "/repo/other",
      foregroundCodex,
    });
    expect(rootMismatch).toContain("different Git repository");
  });

  it("identifies only Codex in the pane's current foreground process group", () => {
    const processRows = [
      "100 1 100 200 ttys003 Sat Oct 24 10:00:00 2026 /bin/zsh",
      "200 100 200 200 ttys003 Sat Oct 24 10:01:00 2026 /Applications/ChatGPT.app/Contents/Resources/codex",
      "300 100 300 200 ttys003 Sat Oct 24 10:02:00 2026 /usr/local/bin/codex",
    ].join("\n");
    expect(selectForegroundCodexProcess(processRows, 100, "/dev/ttys003", "codex"))
      .toEqual({ pid: 200, startedAt: "Sat Oct 24 10:01:00 2026", command: "codex" });
    expect(selectForegroundCodexProcess(processRows, 100, "/dev/ttys003", "zsh")).toBeNull();
  });

  it("keeps line comments stale when the path is renamed, deleted, or its text moves", () => {
    const anchor: TmuxReviewAnchor = {
      path: "src/old.ts", oldPath: null, oldLine: 4, newLine: 4, side: "new", snippet: "keep", noNewline: false,
    };
    expect(reviewAnchorMismatch(anchor, [{ path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" }], "")).toContain("renamed");
    expect(reviewAnchorMismatch(anchor, [], "")).toContain("no longer a Git change");
    const changedPatch = "diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -4 +4 @@\n-wrong\n+keep\n";
    expect(reviewAnchorMismatch(anchor, [{ path: "src/old.ts", oldPath: null, status: "modified" }], changedPatch)).toContain("changed or moved");
  });

  it("stores drafts separately for each original Session and repository, and keeps multiline text", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const anchor: GitReviewAnchor = {
      path: "src/review.ts", oldPath: null, kind: "delete", oldLine: 2, newLine: null, side: "old", snippet: "removed", noNewline: false, headCommit: "head",
    };
    const comment = newGitReviewComment(anchor, "keep this behavior\nadd a regression case");
    saveGitReviewComments("$1", "/repo/a", [comment], storage);
    expect(loadGitReviewComments("$1", "/repo/a", storage)).toEqual([comment]);
    expect(loadGitReviewComments("$2", "/repo/a", storage)).toEqual([]);
    expect(loadGitReviewComments("$1", "/repo/b", storage)).toEqual([]);
    expect(formatGitReviewComments([comment])).toContain("keep this behavior\n  add a regression case");
  });

  it("merges review deliveries by exact anchor and removes only duplicate anchors", () => {
    const first = newGitReviewComment({
      path: "src/review.ts", oldPath: null, kind: "delete", oldLine: 2, newLine: null,
      side: "old", snippet: "remove me", noNewline: false, headCommit: "head",
    }, "first comment");
    const second = newGitReviewComment({
      path: "src/review.ts", oldPath: null, kind: "add", oldLine: null, newLine: 1,
      side: "new", snippet: "const count = 2;", noNewline: false, headCommit: "head",
    }, "second comment");
    const reviewTarget = {
      sessionId: "$1", paneId: "%3", gitRoot: "/repo",
      foregroundCodex: { ...foregroundCodex, command: "codex" as const },
    };
    const deliveries = [
      { markerId: "one", target: reviewTarget, anchors: [first.anchor], reviewText: "one", createdAt: 1 },
      { markerId: "two", target: reviewTarget, anchors: [first.anchor, second.anchor], reviewText: "two", createdAt: 2 },
    ];
    expect(mergeGitReviewAnchors(deliveries)).toEqual([first.anchor, second.anchor]);
  });

  it("pings the live terminal, accepts pong, and terminates only after a missed heartbeat", () => {
    let listener: (() => void) | null = null;
    let tick: (() => void) | null = null;
    let pingCount = 0;
    let terminated = false;
    let timerCancelled = false;
    const peer: TerminalHeartbeatPeer = {
      readyState: 1,
      ping() { pingCount += 1; },
      terminate() { terminated = true; },
      on(_event, callback) { listener = callback; },
      off() { listener = null; },
    };
    const stop = startTerminalHeartbeat(
      peer,
      30,
      (callback) => {
        tick = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      () => { timerCancelled = true; },
    );
    tick!();
    expect(pingCount).toBe(1);
    listener!();
    tick!();
    expect(pingCount).toBe(2);
    tick!();
    expect(terminated).toBe(true);
    expect(timerCancelled).toBe(true);
    stop();
  });
});

describe("Tmux Git review API", () => {
  it("captures a foreground Codex target and rejects scope mismatch and stopped Codex", async () => {
    const fixture = createGitFixture();
    const api = createApi(fixture.root);
    const canonicalRoot = realpathSync(fixture.root);
    const contextResponse = await callApi(api, "GET", "/sessions/%241/git-review/context?expectedGitRoot=" + encodeURIComponent(canonicalRoot));
    const context = contextResponse.json();
    expect(contextResponse.statusCode).toBe(200);
    expect(context).toMatchObject({ status: "ready", paneId: "%3", gitRoot: canonicalRoot });
    const reviewTarget = context.target as TmuxReviewTarget;

    const wrongPaneTarget = { ...reviewTarget, paneId: "%8" };
    const mismatch = await callApi(api, "POST", "/sessions/%241/git-review/revalidate", {
      target: wrongPaneTarget,
      anchors: [anchorBody(fixture.anchor)],
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toContain("pane changed");

    const replacedApi = createApi(fixture.root, { foregroundCodex: { ...foregroundCodex, pid: foregroundCodex.pid + 1 } });
    const replaced = await callApi(replacedApi, "POST", "/sessions/%241/git-review/revalidate", {
      target: reviewTarget,
      anchors: [anchorBody(fixture.anchor)],
    });
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().error).toContain("foreground Codex process changed");

    const stoppedApi = createApi(fixture.root, { foregroundCodex: null });
    const stoppedContext = await callApi(stoppedApi, "GET", "/sessions/%241/git-review/context");
    expect(stoppedContext.json()).toMatchObject({ status: "codex-not-running", target: null });
    const stopped = await callApi(stoppedApi, "POST", "/sessions/%241/git-review/revalidate", {
      target: reviewTarget,
      anchors: [anchorBody(fixture.anchor)],
    });
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error).toContain("Codex is not running");
  });

  it("revalidates exact anchors and refuses stale lines and missing sessions", async () => {
    const fixture = createGitFixture();
    const api = createApi(fixture.root);
    const canonicalRoot = realpathSync(fixture.root);
    const good = await callApi(api, "POST", "/sessions/%241/git-review/revalidate", {
      target: target(canonicalRoot),
      anchors: [anchorBody(fixture.anchor)],
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().ok).toBe(true);

    const stale = await callApi(api, "POST", "/sessions/%241/git-review/revalidate", {
      target: target(canonicalRoot),
      anchors: [{ ...anchorBody(fixture.anchor), snippet: "old content" }],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("stale");

    const missingApi = createApi(fixture.root, { sessionExists: false });
    const missing = await callApi(missingApi, "GET", "/sessions/%241/git-review/context");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toContain("not found");
  });

  it("keeps a renamed session bound by its stable tmux ID and verifies untracked EOF anchors", async () => {
    const fixture = createGitFixture();
    const canonicalRoot = realpathSync(fixture.root);
    const renamedApi = createApi(fixture.root, { sessionName: "renamed-fixture" });
    const renamed = await callApi(renamedApi, "POST", "/sessions/%241/git-review/revalidate", {
      target: target(canonicalRoot),
      anchors: [anchorBody(fixture.anchor)],
    });
    expect(renamed.statusCode).toBe(200);

    writeFileSync(join(fixture.root, "notes.txt"), "first line\nlast line");
    const untrackedPatch = spawnSync("git", ["-c", "core.quotepath=false", "diff", "--no-color", "--no-index", "--", "/dev/null", "notes.txt"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).stdout;
    const untrackedLines = parseTmuxReviewDiffLines(untrackedPatch);
    const lastLine = untrackedLines.find((line) => line.text === "last line");
    expect(lastLine?.noNewline).toBe(true);
    const eofAnchor: TmuxReviewAnchor = {
      path: "notes.txt", oldPath: null, oldLine: null, newLine: lastLine!.newLine,
      side: "new", snippet: "last line", noNewline: true,
    };
    const currentTarget = target(canonicalRoot);
    const api = createApi(fixture.root);
    const verified = await callApi(api, "POST", "/sessions/%241/git-review/revalidate", {
      target: currentTarget,
      anchors: [anchorBody(eofAnchor)],
    });
    expect(verified.statusCode).toBe(200);
  });

  it("strips the review marker before the composer sends its staged text", () => {
    const markerId = "review-123";
    const marker = createGitReviewMarker(markerId);
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const reviewAnchor: GitReviewAnchor = {
      path: "src/review.ts", oldPath: null, kind: "delete", oldLine: 2, newLine: null, side: "old", snippet: "remove me", noNewline: false, headCommit: "head",
    };
    const comment = newGitReviewComment(reviewAnchor, "please keep this line\n<!--bridge-git-review:v1:comment-text-->");
    const reviewText = formatGitReviewComments([comment]);
    const staged = marker + "\n" + reviewText;
    expect(extractGitReviewMarkerIds(staged)).toEqual([markerId]);
    expect(stripGitReviewMarkers(staged)).toBe(reviewText);
    expect(reviewText).toContain("  <!--bridge-git-review:v1:comment-text-->");
    savePendingGitReviewDelivery({
      markerId, target: { ...target("/repo"), foregroundCodex }, anchors: [reviewAnchor],
      reviewText, createdAt: Date.now(),
    }, storage);
    expect(storage.getItem("bridge:tmux-git-review-pending:v1")).toContain(markerId);
    removePendingGitReviewDelivery(markerId, storage);
    expect(storage.getItem("bridge:tmux-git-review-pending:v1")).toBe("[]");
  });
});

describe("Tmux Git review WebSocket delivery", () => {
  it("rejects pane or Codex changes after HTTP preflight and before any paste", async () => {
    const fixture = createGitFixture();
    const canonicalRoot = realpathSync(fixture.root);
    const original = reviewPane(fixture.root);
    const reviewTarget = target(canonicalRoot);
    const changes = [
      reviewPane(fixture.root, { paneId: "%8" }),
      reviewPane(fixture.root, { foregroundCodex: { ...foregroundCodex, pid: foregroundCodex.pid + 1 } }),
    ];

    for (const [index, changedPane] of changes.entries()) {
      const harness = createReviewWsHarness(fixture.root, original);
      const preflight = await callApi(harness.api, "POST", "/sessions/%241/git-review/revalidate", {
        target: reviewTarget,
        anchors: [anchorBody(fixture.anchor)],
      });
      expect(preflight.statusCode).toBe(200);
      harness.setPane(changedPane);
      await harness.open();
      harness.socket.receive({
        type: "submit",
        requestId: `review-stale-${index}`,
        text: "review comment text",
        review: { target: reviewTarget, anchors: [anchorBody(fixture.anchor)] },
      });

      const result = await waitForReviewSubmission(harness.socket, `review-stale-${index}`);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(index === 0 ? /pane changed/i : /foreground Codex process changed/i);
      expect(harness.pasted).toHaveLength(0);
      expect(harness.entered).toHaveLength(0);
      expect(harness.attachWrites).toHaveLength(0);
      harness.socket.close();
    }
  });

  it("revalidates every merged anchor in the WS request after HTTP preflight", async () => {
    const fixture = createGitFixture();
    const canonicalRoot = realpathSync(fixture.root);
    const reviewTarget = target(canonicalRoot);
    const addedAnchor: TmuxReviewAnchor = {
      path: "src/review.ts", oldPath: null, oldLine: null, newLine: 1,
      side: "new", snippet: "const count = 2;", noNewline: false,
    };
    const anchors = [fixture.anchor, addedAnchor];
    const harness = createReviewWsHarness(fixture.root, reviewPane(fixture.root));
    const preflight = await callApi(harness.api, "POST", "/sessions/%241/git-review/revalidate", {
      target: reviewTarget,
      anchors: anchors.map(anchorBody),
    });
    expect(preflight.statusCode).toBe(200);

    writeFileSync(join(fixture.root, "src", "review.ts"), "const count = 3;\nkeep me\n");
    await harness.open();
    harness.socket.receive({
      type: "submit",
      requestId: "review-anchor-changed-after-preflight",
      text: "review comments from two batches",
      review: { target: reviewTarget, anchors: anchors.map(anchorBody) },
    });
    const result = await waitForReviewSubmission(harness.socket, "review-anchor-changed-after-preflight");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("reviewed line changed or moved");
    expect(harness.pasted).toHaveLength(0);
    expect(harness.entered).toHaveLength(0);
    harness.socket.close();
  });

  it("withholds Enter if the original Codex exits during the pane-targeted paste", async () => {
    const fixture = createGitFixture();
    const canonicalRoot = realpathSync(fixture.root);
    const original = reviewPane(fixture.root);
    const reviewTarget = target(canonicalRoot);
    const harness = createReviewWsHarness(fixture.root, original);
    const preflight = await callApi(harness.api, "POST", "/sessions/%241/git-review/revalidate", {
      target: reviewTarget,
      anchors: [anchorBody(fixture.anchor)],
    });
    expect(preflight.statusCode).toBe(200);
    harness.setPaneSequence([
      original,
      original,
      reviewPane(fixture.root, { foregroundCodex: null }),
    ]);
    await harness.open();
    harness.socket.receive({
      type: "submit",
      requestId: "review-codex-exits-during-paste",
      text: "review comment text",
      review: { target: reviewTarget, anchors: [anchorBody(fixture.anchor)] },
    });

    const result = await waitForReviewSubmission(harness.socket, "review-codex-exits-during-paste");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Codex is not running");
    expect(harness.pasted).toEqual([{ paneId: "%3", text: "review comment text" }]);
    expect(harness.entered).toHaveLength(0);
    expect(harness.attachWrites).toHaveLength(0);
    harness.socket.close();
  });
});
