import { describe, expect, it } from "vitest";

import type { TmuxAdapter } from "../src/tmux-adapter.js";
import { TmuxVerifier } from "../src/tmux-verifier.js";
import { TmuxVerifierStore, type TmuxSessionRecord } from "../src/tmux-verifier-store.js";

class FakeTmuxAdapter implements TmuxAdapter {
  public alive = false;
  public screen = "";
  public readonly sentText: string[] = [];
  public readonly sentTerminalData: string[] = [];

  public async startSession(_session: TmuxSessionRecord): Promise<void> {
    this.alive = true;
    this.screen = "Codex TUI ready\r\n› Ask Codex\r\n";
  }

  public async hasSession(_session: TmuxSessionRecord): Promise<boolean> {
    return this.alive;
  }

  public async capturePane(_session: TmuxSessionRecord): Promise<string> {
    return this.screen;
  }

  public async sendText(_session: TmuxSessionRecord, text: string): Promise<void> {
    this.sentText.push(text);
    this.screen = `${this.screen}${text}\r\n`;
  }

  public async sendTerminalData(_session: TmuxSessionRecord, data: string): Promise<void> {
    this.sentTerminalData.push(data);
  }

  public async killSession(_session: TmuxSessionRecord): Promise<void> {
    this.alive = false;
  }

  public attachCommand(session: TmuxSessionRecord): string {
    return `tmux -L ${session.tmux_socket} attach -t ${session.tmux_session}`;
  }
}

describe("TmuxVerifier", () => {
  it("keeps the tmux session alive while observers disconnect and replays durable events", async () => {
    const store = new TmuxVerifierStore(":memory:");
    const adapter = new FakeTmuxAdapter();
    const verifier = new TmuxVerifier({
      store,
      pollIntervalMs: 100,
      adapterFactory: () => adapter,
    });
    const started = await verifier.startSession({
      machine: "local",
      cwd: "/tmp/project",
      codexPath: "codex",
      clientRequestId: "start-1",
      initialPrompt: "initial prompt",
    });
    const firstCursor = started.session.last_event_id;
    verifier.stop();

    adapter.screen = "event produced while browser is disconnected\r\n";
    await verifier.pollOnce(started.session.session_id);

    expect(adapter.alive).toBe(true);
    const replay = verifier.listEvents(started.session.session_id, firstCursor);
    expect(replay.some((event) => event.kind === "terminal.snapshot")).toBe(true);
    expect(replay.at(-1)?.payload).toMatchObject({
      screen: "event produced while browser is disconnected\r\n",
    });
    store.close();
  });

  it("delivers one web follow-up to the existing TUI for one idempotency key", async () => {
    const store = new TmuxVerifierStore(":memory:");
    const adapter = new FakeTmuxAdapter();
    const verifier = new TmuxVerifier({
      store,
      adapterFactory: () => adapter,
    });
    const started = await verifier.startSession({
      machine: "local",
      cwd: "/tmp/project",
      clientRequestId: "start-2",
    });

    const first = await verifier.sendMessage(started.session.session_id, {
      clientMessageId: "followup-1",
      text: "same follow-up",
    });
    const retry = await verifier.sendMessage(started.session.session_id, {
      clientMessageId: "followup-1",
      text: "same follow-up",
    });

    expect(first).toMatchObject({ accepted: true, deduplicated: false });
    expect(retry).toMatchObject({ accepted: true, deduplicated: true });
    expect(adapter.sentText).toEqual(["same follow-up"]);
    expect(verifier.listEvents(started.session.session_id).filter((event) => event.kind === "message.delivered")).toHaveLength(1);
    expect(verifier.listEvents(started.session.session_id).some((event) => event.kind === "message.deduplicated")).toBe(true);
    store.close();
  });

  it("keeps terminal keystrokes on the same adapter instead of creating a second session", async () => {
    const store = new TmuxVerifierStore(":memory:");
    const adapter = new FakeTmuxAdapter();
    const verifier = new TmuxVerifier({ store, adapterFactory: () => adapter });
    const started = await verifier.startSession({ machine: "local", cwd: "/tmp/project" });
    await verifier.sendTerminalInput(started.session.session_id, "typed in TUI\r");

    expect(adapter.sentTerminalData).toEqual(["typed in TUI\r"]);
    expect(verifier.listSessions()).toHaveLength(1);
    expect(verifier.listEvents(started.session.session_id).some((event) => event.kind === "terminal.input")).toBe(true);
    store.close();
  });
});
