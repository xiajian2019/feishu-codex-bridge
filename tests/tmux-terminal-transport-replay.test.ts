import { expect, it } from "bun:test";
import { TmuxTerminalReplayGuard } from "../web/src/tmux-terminal-replay.js";
import { TmuxTerminalTransport } from "../web/src/tmux-terminal-runtime.js";

(globalThis as unknown as { self: typeof globalThis }).self = globalThis;
const { Terminal } = await import("@xterm/xterm");

it("replays cached queries without sending their replies and still handles live queries", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const fakeWindow = Object.assign(new EventTarget(), {
    location: { origin: "http://127.0.0.1" },
    setTimeout,
    clearTimeout,
  });
  const fakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let socket!: FixtureWebSocket;
  class FixtureWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FixtureWebSocket.CONNECTING;
    binaryType = "";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) { socket = this; }
    open(): void { this.readyState = FixtureWebSocket.OPEN; this.onopen?.(); }
    receive(data: string): void { this.onmessage?.({ data: new TextEncoder().encode(data).buffer }); }
    send(_data: string): void {}
    close(): void { this.readyState = FixtureWebSocket.CLOSED; this.onclose?.(); }
  }
  const restore = (key: string, descriptor: PropertyDescriptor | undefined): void => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FixtureWebSocket });

  const terminal = new Terminal();
  const forwarded: string[] = [];
  const events: string[] = [];
  const firstEvents: string[] = [];
  const guard = new TmuxTerminalReplayGuard(terminal, () => {});
  const transport = new TmuxTerminalTransport("replay-fixture");
  let firstUnsubscribe: (() => void) | undefined;
  let secondUnsubscribe: (() => void) | undefined;
  terminal.onData((data) => { if (!guard.active) forwarded.push(data); });
  try {
    transport.setPathBuilder(() => "/terminal");
    firstUnsubscribe = transport.subscribe((event) => firstEvents.push(event.type));
    socket.open();
    expect(firstEvents).toEqual(["status", "socket-open"]);
    socket.receive("\u001b[c");
    firstUnsubscribe();
    firstUnsubscribe = undefined;

    secondUnsubscribe = transport.subscribe((event) => {
      events.push(event.type);
      if (event.type === "replay-start") guard.start();
      else if (event.type === "replay-end") guard.finish();
      else if (event.type === "output") terminal.write(event.data);
    });
    // This is live output even though cached writes have not been parsed yet.
    socket.receive("\u001b[>c");
    await new Promise<void>((resolve) => terminal.write("", resolve));
    expect(events).toEqual(["socket-open", "replay-start", "output", "replay-end", "output"]);
    expect(forwarded).toEqual(["\u001b[>0;276;0c"]);
    terminal.input("x");
    expect(forwarded).toEqual(["\u001b[>0;276;0c", "x"]);
  } finally {
    firstUnsubscribe?.();
    secondUnsubscribe?.();
    (transport as unknown as { closeNow(): void }).closeNow();
    terminal.dispose();
    restore("window", originalWindow);
    restore("document", originalDocument);
    restore("WebSocket", originalWebSocket);
  }
});
