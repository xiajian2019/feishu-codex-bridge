import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { subscribeToTicketedEvents } from "../web/src/mobile-stream.js";

class FakeSource extends EventTarget {
  static instances: FakeSource[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { super(); FakeSource.instances.push(this); }
  close(): void { this.closed = true; }
}

class FakeWindow extends EventTarget {
  timers = new Map<number, () => void>();
  sequence = 0;
  setTimeout(callback: () => void): number {
    const id = ++this.sequence;
    this.timers.set(id, callback);
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  runRetry(): void {
    const entries = [...this.timers.values()];
    this.timers.clear();
    for (const callback of entries) callback();
  }
}

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let browserWindow: FakeWindow;
let browserDocument: EventTarget & { visibilityState: string };
let browserNavigator: { onLine: boolean };
let cleanup: (() => void) | undefined;
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const replaceGlobal = (key: string, value: unknown): void => {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
};

beforeEach(() => {
  FakeSource.instances = [];
  browserWindow = new FakeWindow();
  browserDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
  browserNavigator = { onLine: true };
  replaceGlobal("window", browserWindow);
  replaceGlobal("document", browserDocument);
  replaceGlobal("navigator", browserNavigator);
  replaceGlobal("EventSource", FakeSource);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

describe("native single-use event stream", () => {
  it("closes a failed source and obtains a fresh ticket on reconnect", async () => {
    let tickets = 0;
    const statuses: string[] = [];
    const changes: string[] = [];
    cleanup = subscribeToTicketedEvents({
      url: async () => `https://bridge.test/api/events?bridgeTicket=${++tickets}`,
      onChange: (event) => changes.push(event.data),
      onStatus: (status) => statuses.push(status),
      resumeEvent: "app-resume",
    });
    await settle();
    const first = FakeSource.instances[0]!;
    first.onopen?.();
    first.dispatchEvent(new MessageEvent("task.updated", { data: "first" }));
    first.onerror?.();
    expect(first.closed).toBe(true);
    expect(browserWindow.timers.size).toBe(1);
    browserWindow.runRetry();
    await settle();
    expect(FakeSource.instances.map((source) => source.url)).toEqual([
      "https://bridge.test/api/events?bridgeTicket=1",
      "https://bridge.test/api/events?bridgeTicket=2",
    ]);
    // A queued event from the detached source cannot update the task view.
    first.dispatchEvent(new MessageEvent("task.updated", { data: "stale" }));
    FakeSource.instances[1]!.dispatchEvent(new MessageEvent("task.updated", { data: "second" }));
    expect(changes).toEqual(["first", "second"]);
    expect(statuses).toEqual(["connecting", "connected", "disconnected", "connecting"]);
  });

  it("discards an outstanding ticket after unmount and removes resume listeners", async () => {
    let complete: (url: string) => void = () => undefined;
    let requests = 0;
    cleanup = subscribeToTicketedEvents({
      url: () => { requests += 1; return new Promise((resolve) => { complete = resolve; }); },
      onChange: () => undefined,
      onStatus: () => undefined,
      resumeEvent: "app-resume",
    });
    cleanup();
    complete("https://bridge.test/api/events?bridgeTicket=expired");
    await settle();
    browserWindow.dispatchEvent(new Event("app-resume"));
    expect(FakeSource.instances).toHaveLength(0);
    expect(requests).toBe(1);
    expect(browserWindow.timers.size).toBe(0);
  });

  it("suspends while hidden or offline and renews tickets when the App resumes", async () => {
    let tickets = 0;
    cleanup = subscribeToTicketedEvents({
      url: async () => `https://bridge.test/api/events?bridgeTicket=${++tickets}`,
      onChange: () => undefined,
      onStatus: () => undefined,
      resumeEvent: "app-resume",
    });
    await settle();
    browserDocument.visibilityState = "hidden";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSource.instances[0]!.closed).toBe(true);
    browserWindow.dispatchEvent(new Event("app-resume"));
    expect(tickets).toBe(1);
    browserDocument.visibilityState = "visible";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(tickets).toBe(2);
    browserNavigator.onLine = false;
    browserWindow.dispatchEvent(new Event("offline"));
    expect(FakeSource.instances[1]!.closed).toBe(true);
    expect(browserWindow.timers.size).toBe(0);
    browserNavigator.onLine = true;
    browserWindow.dispatchEvent(new Event("online"));
    await settle();
    expect(tickets).toBe(3);
    browserWindow.dispatchEvent(new Event("app-resume"));
    await settle();
    expect(tickets).toBe(4);
    expect(FakeSource.instances[2]!.closed).toBe(true);
  });

  it("cancels scheduled reconnects when going into the background", async () => {
    let requests = 0;
    cleanup = subscribeToTicketedEvents({
      url: async () => { requests += 1; throw new Error("network failed"); },
      onChange: () => undefined,
      onStatus: () => undefined,
      resumeEvent: "app-resume",
    });
    await settle();
    expect(browserWindow.timers.size).toBe(1);
    browserDocument.visibilityState = "hidden";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(browserWindow.timers.size).toBe(0);
    browserWindow.runRetry();
    expect(requests).toBe(1);
  });

  it("ignores a delayed pre-background ticket after a newer connection is ready", async () => {
    const pending: Array<(url: string) => void> = [];
    cleanup = subscribeToTicketedEvents({
      url: () => new Promise((resolve) => pending.push(resolve)),
      onChange: () => undefined,
      onStatus: () => undefined,
      resumeEvent: "app-resume",
    });
    browserDocument.visibilityState = "hidden";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    browserDocument.visibilityState = "visible";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    pending[1]!("https://bridge.test/api/events?bridgeTicket=new");
    await settle();
    pending[0]!("https://bridge.test/api/events?bridgeTicket=old");
    await settle();
    expect(FakeSource.instances.map((source) => source.url)).toEqual([
      "https://bridge.test/api/events?bridgeTicket=new",
    ]);
  });
});
