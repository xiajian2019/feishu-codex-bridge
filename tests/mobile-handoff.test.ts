import { afterEach, expect, it } from "bun:test";
import { appendMobileShareText, assertMobileShareContext, clearMobileOpenError, consumeMobileOpen, getMobileOpenError, getMobileOpens, parseMobileNotificationTarget, parseMobileOpenUrl, queueMobileOpen, readMobileNotificationLedger, restoreMobileOpens, safeMobileRoute } from "../web/src/mobile-handoff.js";

afterEach(() => { for (const item of getMobileOpens()) consumeMobileOpen(item.id); clearMobileOpenError(); });

it("accepts only read/navigation routes and known parameters", () => {
  for (const route of ["/", "/mobile-inbox", "/tasks/desk/task-1", "/codex-history/home/thread", "/tmux-dashboard?session=%241", "/tmux-dashboard/files/session-1"]) expect(safeMobileRoute(route)).toBe(route);
  for (const route of ["https://evil.fixture/", "//evil.fixture/", "/api/auth/logout", "/system-management/backups?restore=1", "/tasks/desk/a/../b", "/tasks/desk/%2e%2e", "/tasks/desk/a%2fb", "/tmux-dashboard?bridgeTicket=secret", "/codex-history/home/thread#token=secret", "/tmux-dashboard?session=x\n"]) expect(safeMobileRoute(route)).toBeNull();
});

it("parses scoped open links without allowing credentials or duplicate ambiguous parameters", () => {
  const base = "bridgecodex://open?server=https%3A%2F%2Fmac.fixture%3A7310&path=%2Ftasks%2Fdirect%2Ft1";
  expect(parseMobileOpenUrl(base)).toMatchObject({ kind: "route", server: "https://mac.fixture:7310", route: "/tasks/direct/t1" });
  for (const bad of [base + "&token=private", base + "&server=https%3A%2F%2Fevil.fixture", base + "#secret", "bridgecodex://open?server=http%3A%2F%2Fpublic.example&path=%2F"]) expect(() => parseMobileOpenUrl(bad)).toThrow();
});

it("keeps pairing as an explicit separate intent rather than navigating or executing", () => {
  expect(parseMobileOpenUrl("bridgecodex://connect?server=https%3A%2F%2Fmac.fixture&code=ABCD2345EFGH")).toMatchObject({ kind: "pair", server: "https://mac.fixture", code: "ABCD2345EFGH" });
  expect(() => parseMobileOpenUrl("bridgecodex://connect?server=https%3A%2F%2Fmac.fixture&code=ABCD2345EFGH&action=run")).toThrow();
});

it("requires notification environment and device context and never converts it into a write action", () => {
  expect(parseMobileNotificationTarget({ server: "https://mac.fixture", route: "/codex-history/h/t", scope: "device-scope" })).toMatchObject({ kind: "route", scope: "device-scope" });
  expect(() => parseMobileNotificationTarget({ server: "https://mac.fixture", route: "/mobile-inbox" })).toThrow();
  expect(() => parseMobileNotificationTarget({ server: "https://mac.fixture", route: "/api/tasks", scope: "scope" })).toThrow();
});

it("coalesces cold/warm duplicate opens and retains later distinct requests until consumed", () => {
  const first = "bridgecodex://open?server=https%3A%2F%2Fmac.fixture&path=%2Fmobile-inbox";
  queueMobileOpen(first); queueMobileOpen(first);
  queueMobileOpen("bridgecodex://open?server=https%3A%2F%2Fother.fixture&path=%2Fmobile-inbox");
  expect(getMobileOpens()).toHaveLength(2);
  consumeMobileOpen(getMobileOpens()[0]!.id); expect(getMobileOpens()[0]?.server).toBe("https://other.fixture");
  queueMobileOpen("javascript:alert(1)"); expect(getMobileOpenError()).toBeTruthy(); expect(getMobileOpens()).toHaveLength(1);
});

it("appends shared text without replacing the user's existing draft", () => {
  expect(appendMobileShareText("existing draft", "shared text")).toBe("existing draft\n\nshared text");
  expect(appendMobileShareText("existing draft", "  ")).toBe("existing draft");
  expect(appendMobileShareText("", " shared text ")).toBe("shared text");
});

it("binds draft import to the environment and device that supplied the target list", () => {
  const expected = { scope: "device-A", server: "https://mac.fixture:5173" };
  expect(() => assertMobileShareContext(expected, expected)).not.toThrow();
  expect(() => assertMobileShareContext(expected, { ...expected, scope: "device-B" })).toThrow();
  expect(() => assertMobileShareContext(expected, { ...expected, server: "https://mac.fixture:7310" })).toThrow();
  expect(() => assertMobileShareContext(null, expected)).toThrow();
});

it("restores only valid bounded notification ledgers", () => {
  expect(readMobileNotificationLedger('{"version":1,"enabledAt":1,"seen":["a",null,"b"]}')).toEqual({ version: 1, enabledAt: 1, seen: ["a", "b"] });
  expect(readMobileNotificationLedger("invalid")).toBeNull();
  expect(readMobileNotificationLedger('{"version":2,"enabledAt":1,"seen":[]}')).toBeNull();
});

it("persists navigation across process loss but never persists pairing codes or raw links", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const rows = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); },
  } } });
  try {
    queueMobileOpen("bridgecodex://connect?server=https%3A%2F%2Fmac.fixture&code=ABCD2345EFGH");
    queueMobileOpen({ server: "https://mac.fixture", route: "/tasks/desk/t1", scope: "old-device-scope" });
    const raw = rows.get("bridge.mobile.pending-opens.v1")!;
    expect(raw).not.toContain("ABCD2345EFGH"); expect(raw).not.toContain("bridgecodex:");
    for (const item of getMobileOpens()) consumeMobileOpen(item.id);
    rows.set("bridge.mobile.pending-opens.v1", raw);
    restoreMobileOpens();
    expect(getMobileOpens()).toHaveLength(1);
    expect(getMobileOpens()[0]).toMatchObject({ kind: "route", route: "/tasks/desk/t1", scope: "old-device-scope" });
  } finally {
    for (const item of getMobileOpens()) consumeMobileOpen(item.id);
    if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window");
  }
});
