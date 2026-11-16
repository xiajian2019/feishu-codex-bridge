import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";

import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi, type TmuxDashboardApiOptions } from "../src/tmux-dashboard-api.js";
import { terminalHistorySnapshot } from "../web/src/tmux-terminal-history.js";

class TerminalPeer extends EventEmitter {
  readyState = 1;
  sent: Array<string | Buffer> = [];
  send(data: string | Buffer): void { this.sent.push(data); }
  ping(): void {}
  terminate(): void { this.close(); }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("terminal fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function terminalFixture(capturePane: NonNullable<TmuxDashboardApiOptions["operations"]>["capturePane"]) {
  const db = new StateDatabase(":memory:");
  const peer = new TerminalPeer();
  let emit = (_output: string): void => {};
  let authorized = true;
  const session = { id: "$1", name: "fixture", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
  const api = new TmuxDashboardApi({
    db,
    operations: {
      listSessions: async () => [session], findSession: async () => session,
      createSession: async () => session, killSession: async () => {}, capturePane,
    },
    terminalRuntime: {
      spawn: ((_command, options) => {
        const terminal = { write() {}, resize() {}, close() {} };
        emit = (output) => options.terminal!.data(terminal, output);
        return { terminal, killed: false, kill() {}, exited: new Promise<number>(() => {}) };
      }) as NonNullable<TmuxDashboardApiOptions["terminalRuntime"]>["spawn"],
    },
  });
  cleanups.push(() => { peer.close(); void api.stop(); db.close(); });
  const open = (api as unknown as {
    openTerminal(peer: WebSocket, data: {
      sessionId: string; sessionRecordId: string; deviceId: null; cols: number; rows: number; historyCache: boolean; isAuthorized: () => boolean;
    }): Promise<void>;
  }).openTerminal.bind(api);
  return {
    peer,
    emit: (output: string) => emit(output),
    revoke: () => { authorized = false; },
    open: (historyCache = true) => open(peer as unknown as WebSocket, {
      sessionId: session.id, sessionRecordId: "fixture", deviceId: null, cols: 40, rows: 5, historyCache,
      isAuthorized: () => authorized,
    }),
  };
}

describe("tmux live output and local history", () => {
  it("keeps the original snapshot protocol for clients that do not opt in", async () => {
    const fixture = terminalFixture(async () => "LEGACY_SCREEN");
    await fixture.open(false);
    expect(Buffer.isBuffer(fixture.peer.sent[0])).toBe(true);
    expect(String(fixture.peer.sent[0])).toContain("LEGACY_SCREEN");
    fixture.emit("LEGACY_UPDATE");
    await waitFor(() => fixture.peer.sent.some((frame) => String(frame).includes("LEGACY_UPDATE")));
    expect(fixture.peer.sent.some((frame) => typeof frame === "string" && frame.includes("terminal-history"))).toBe(false);
  });

  it("forwards PTY output while the independent history capture is still pending", async () => {
    let finishCapture!: (value: string) => void;
    let captureOptions: Parameters<NonNullable<typeof capturePane>>[2];
    const capturePane: NonNullable<TmuxDashboardApiOptions["operations"]>["capturePane"] = async (_id, _rows, options) => {
      captureOptions = options;
      return new Promise((resolve) => { finishCapture = resolve; });
    };
    const fixture = terminalFixture(capturePane);
    await fixture.open();
    fixture.emit("\u001b[?1049hCURRENT_SCREEN");
    await waitFor(() => typeof finishCapture === "function");
    fixture.emit("SUMMARY_DURING_CAPTURE");
    await waitFor(() => fixture.peer.sent.some((frame) => Buffer.isBuffer(frame) && frame.includes("SUMMARY_DURING_CAPTURE")));
    expect(Buffer.concat(fixture.peer.sent.filter(Buffer.isBuffer)).toString()).toContain("CURRENT_SCREEN");
    expect(captureOptions).toMatchObject({ includeEscapeSequences: true, preserveTrailingWhitespace: true });
    expect(captureOptions?.alternateScreen).not.toBe(true);
    finishCapture("CURRENT_SCREEN\n\n");
    await waitFor(() => fixture.peer.sent.some((frame) => typeof frame === "string" && frame.includes("terminal-history")));
  });

  it("does not send an in-flight history capture after authorization is revoked", async () => {
    let finishCapture!: (value: string) => void;
    const fixture = terminalFixture(async () => new Promise((resolve) => { finishCapture = resolve; }));
    await fixture.open();
    await waitFor(() => typeof finishCapture === "function");
    fixture.revoke();
    finishCapture("PRIVATE_HISTORY");
    await waitFor(() => fixture.peer.readyState === 3);
    expect(fixture.peer.sent.some((frame) => String(frame).includes("PRIVATE_HISTORY"))).toBe(false);
  });

  it("coalesces frequent live output instead of repeatedly rebuilding history", async () => {
    let captures = 0;
    const fixture = terminalFixture(async () => { captures += 1; return `capture ${captures}\n`; });
    await fixture.open();
    await waitFor(() => captures === 1);
    const burst = setInterval(() => fixture.emit("update"), 100);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(captures).toBe(1);
    } finally {
      clearInterval(burst);
    }
    await waitFor(() => captures === 2);
    expect(Buffer.concat(fixture.peer.sent.filter(Buffer.isBuffer)).toString()).toContain("update");
  });

  it("keeps live output and history isolated across different Sessions", async () => {
    const db = new StateDatabase(":memory:");
    const first = new TerminalPeer();
    const second = new TerminalPeer();
    const emitters = new Map<string, (output: string) => void>();
    const session = { id: "$1", name: "fixture", cwd: "/tmp", createdAt: 1, windows: 1, attachedClients: 0 };
    const api = new TmuxDashboardApi({
      db,
      operations: {
        listSessions: async () => [session], findSession: async () => session,
        createSession: async () => session, killSession: async () => {},
        capturePane: async (id) => `${id} HISTORY\n`,
      },
      terminalRuntime: {
        spawn: ((command, options) => {
          const terminal = { write() {}, resize() {}, close() {} };
          emitters.set(String(command.at(-1)), (output) => options.terminal!.data(terminal, output));
          return { terminal, killed: false, kill() {}, exited: new Promise<number>(() => {}) };
        }) as NonNullable<TmuxDashboardApiOptions["terminalRuntime"]>["spawn"],
      },
    });
    cleanups.push(() => { first.close(); second.close(); void api.stop(); db.close(); });
    const open = (api as unknown as {
      openTerminal(peer: WebSocket, data: {
        sessionId: string; sessionRecordId: string; deviceId: null; cols: number; rows: number; historyCache: boolean; isAuthorized: () => boolean;
      }): Promise<void>;
    }).openTerminal.bind(api);
    await Promise.all([first, second].map((peer, index) => open(peer as unknown as WebSocket, {
      sessionId: `$${index + 1}`, sessionRecordId: `fixture-${index}`, deviceId: null,
      cols: 40, rows: 5, historyCache: true, isAuthorized: () => true,
    })));
    emitters.get("$1")!("FIRST_ONLY");
    emitters.get("$2")!("SECOND_ONLY");
    await waitFor(() => first.sent.length >= 2 && second.sent.length >= 2);
    expect(first.sent.map(String).join("")).toContain("FIRST_ONLY");
    expect(first.sent.map(String).join("")).not.toContain("SECOND_ONLY");
    expect(second.sent.map(String).join("")).toContain("SECOND_ONLY");
    expect(second.sent.map(String).join("")).not.toContain("FIRST_ONLY");
    first.close();
    emitters.get("$2")!("SECOND_STILL_LIVE");
    await waitFor(() => second.sent.some((frame) => String(frame).includes("SECOND_STILL_LIVE")));
    expect(second.readyState).toBe(1);
  });

  it("keeps the tmux viewport aligned while retaining its preceding rows for local scrolling", async () => {
    (globalThis as unknown as { self: typeof globalThis }).self = globalThis;
    const { Terminal } = await import("@xterm/xterm");
    const terminal = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
    try {
      const snapshot = "HISTORY_ONE\nHISTORY_TWO\nSUMMARY_TOP\nDETAIL\nFOOTER\n\n\n";
      await new Promise<void>((resolve) => terminal.write(terminalHistorySnapshot(snapshot), resolve));
      const visible = (): string[] => Array.from({ length: terminal.rows }, (_, row) =>
        terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "");
      expect(visible()).toEqual(["SUMMARY_TOP", "DETAIL", "FOOTER", "", ""]);
      expect(terminal.buffer.active.baseY).toBe(2);
      expect([0, 1].map((row) => terminal.buffer.active.getLine(row)?.translateToString(true)))
        .toEqual(["HISTORY_ONE", "HISTORY_TWO"]);
      await new Promise<void>((resolve) => terminal.write(terminalHistorySnapshot("NEW_HISTORY\nNEW_SCREEN\n\n\n\n\n"), resolve));
      expect(terminal.buffer.active.baseY).toBe(1);
      expect(visible()).toEqual(["NEW_SCREEN", "", "", "", ""]);
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("NEW_HISTORY");
    } finally {
      terminal.dispose();
    }
  });
});
