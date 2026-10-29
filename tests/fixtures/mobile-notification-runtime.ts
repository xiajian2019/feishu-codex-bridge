import assert from "node:assert/strict";
import { mock } from "bun:test";
const rows = new Map<string, string>();
const events = new EventTarget();
const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
Object.assign(events, { localStorage: storage });
Object.defineProperty(globalThis, "window", { value: events, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
let connection = { server: "https://mac.fixture" };
let permission = "granted";
let pending: (() => void) | undefined;
let block = false;
const sent: Array<Record<string, unknown>> = [];
mock.module("../../web/src/mobile-runtime.js", () => ({
  getMobileConnection: () => connection,
  getMobileNotificationPermission: async () => permission,
  sendMobileNotification: async (options: Record<string, unknown>) => {
    if (permission !== "granted") return false;
    sent.push(options);
    if (block) await new Promise<void>((resolve) => { pending = resolve; });
    return true;
  },
}));
mock.module("../../web/src/workbench-api.js", () => ({ fetchWorkbenchInbox: async () => ({ notifications: [{ id: "old" }] }) }));
const { setLocalDraftScope, scopedStorageKey } = await import("../../web/src/local-draft-scope.js");
setLocalDraftScope("a".repeat(43), connection.server);
const sourceScope = (await import("../../web/src/local-draft-scope.js")).getLocalDraftScope()!;
const sourceKey = scopedStorageKey("mobile-notification-ledger")!;
const { observeMobileNotifications, updateMobileNotificationPreferences, readMobileNotificationPreferences, mobileNotificationId } = await import("../../web/src/mobile-notifications.js");
const notice = (id: string, category: "action" | "failure" | "completion" = "action") => ({ id, category, route: "/tasks/desk/t1", title: "private details should not appear on lock screen", body: "secret-task-body", createdAt: 0, target: { kind: "task" as const, source: "desk" as const, id: "t1" } });
const scenario = process.argv[2];
if (scenario === "permission") {
  permission = "denied";
  await assert.rejects(updateMobileNotificationPreferences({ enabled: true }), /通知权限/);
  assert.equal(readMobileNotificationPreferences().enabled, false); assert.equal(sent.length, 0);
} else {
  await updateMobileNotificationPreferences({ enabled: true });
  assert.deepEqual(JSON.parse(rows.get(sourceKey)!).seen, ["old"]);
  if (scenario === "dedupe") {
    await observeMobileNotifications([notice("old"), notice("new")]);
    await observeMobileNotifications([notice("new")]);
    assert.equal(sent.length, 1); assert.equal(sent[0]?.scope, sourceScope);
    assert.equal(sent[0]?.title, "Bridge · 等待你处理");
    assert.ok(!JSON.stringify([...rows.values()]).includes("secret-task-body"));
    assert.ok(!JSON.stringify(sent).includes("private details"));
    assert.ok(mobileNotificationId("a") > 0 && mobileNotificationId("a") <= 2147483647);
  } else if (scenario === "filter") {
    await updateMobileNotificationPreferences({ action: false });
    await observeMobileNotifications([notice("suppressed")]);
    await updateMobileNotificationPreferences({ action: true });
    await observeMobileNotifications([notice("suppressed"), notice("later")]);
    assert.equal(sent.length, 1);
  } else if (scenario === "scope") {
    block = true;
    const work = observeMobileNotifications([notice("new")]);
    for (let index = 0; index < 30 && !pending; index++) await Promise.resolve();
    assert.ok(pending);
    setLocalDraftScope("b".repeat(43), "https://other.fixture");
    pending!(); await work;
    assert.deepEqual(JSON.parse(rows.get(sourceKey)!).seen, ["old"]);
    assert.equal(rows.has(scopedStorageKey("mobile-notification-ledger")!), false);
  } else if (scenario === "server") {
    const work = observeMobileNotifications([notice("new")]);
    connection = { server: "https://other.fixture" };
    await work; assert.equal(sent.length, 0);
  } else if (scenario === "revoked") {
    permission = "denied"; await observeMobileNotifications([notice("new")]);
    assert.deepEqual(JSON.parse(rows.get(sourceKey)!).seen, ["old"]);
    permission = "granted"; await observeMobileNotifications([notice("new")]); assert.equal(sent.length, 1);
  } else throw new Error("unknown fixture scenario");
}
