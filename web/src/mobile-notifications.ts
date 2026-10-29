import { getLocalDraftScope, scopedStorageKey } from "./local-draft-scope.js";
import { getMobileConnection, getMobileNotificationPermission, sendMobileNotification } from "./mobile-runtime.js";
import { readMobileNotificationLedger, safeMobileRoute } from "./mobile-handoff.js";
import type { WorkbenchNotification } from "./workbench-api.js";
import { fetchWorkbenchInbox } from "./workbench-api.js";

export interface MobileNotificationPreferences {
  enabled: boolean;
  enabledAt: number;
  completion: boolean;
  failure: boolean;
  action: boolean;
  restoreLocation: boolean;
}
const defaults: MobileNotificationPreferences = { enabled: false, enabledAt: 0, completion: true, failure: true, action: true, restoreLocation: true };
export function readMobileNotificationPreferences(): MobileNotificationPreferences {
  try {
    const key = scopedStorageKey("mobile-notification-preferences");
    const row = JSON.parse(key ? localStorage.getItem(key) ?? "null" : "null") as Partial<MobileNotificationPreferences> | null;
    if (!row) return { ...defaults };
    return { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter((key) => key !== "enabledAt" && typeof row[key as keyof typeof row] === "boolean").map((key) => [key, row[key as keyof typeof row]])),
      enabledAt: Number.isFinite(row.enabledAt) ? row.enabledAt! : 0 };
  } catch { return { ...defaults }; }
}

export async function updateMobileNotificationPreferences(patch: Partial<Omit<MobileNotificationPreferences, "enabledAt">>): Promise<MobileNotificationPreferences> {
  const scope = getLocalDraftScope();
  const key = scopedStorageKey("mobile-notification-preferences");
  if (!key || !scope) throw new Error("请先连接支持设备作用域的 Bridge。");
  if (patch.enabled && await getMobileNotificationPermission(true) !== "granted") throw new Error("未获得系统通知权限，请在系统设置中允许 Bridge 通知；待处理中心仍可使用。");
  if (getLocalDraftScope() !== scope) throw new Error("当前设备或环境已变化，请重新设置。");
  const current = readMobileNotificationPreferences();
  const next = { ...current, ...patch, enabledAt: patch.enabled === true && !current.enabled ? Date.now() : current.enabledAt };
  if (patch.enabled === true && !current.enabled) {
    // Establish a real server baseline rather than comparing clocks on two devices.
    const inbox = await fetchWorkbenchInbox();
    if (getLocalDraftScope() !== scope) throw new Error("当前设备或环境已变化，请重新设置。");
    const ledgerKey = scopedStorageKey("mobile-notification-ledger");
    if (ledgerKey) localStorage.setItem(ledgerKey, JSON.stringify({ version: 1, enabledAt: next.enabledAt, seen: inbox.notifications.map((item) => item.id).slice(-1000) }));
  }
  localStorage.setItem(key, JSON.stringify(next));
  window.dispatchEvent(new Event("bridge:mobile-notification-preferences"));
  return next;
}

export function mobileNotificationId(identity: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
  return (hash >>> 0) % 2147483646 + 1;
}

let delivery: Promise<void> = Promise.resolve();
export function observeMobileNotifications(notifications: WorkbenchNotification[]): Promise<void> {
  const scope = getLocalDraftScope();
  const server = getMobileConnection()?.server;
  const key = scopedStorageKey("mobile-notification-ledger");
  if (!scope || !server || !key) return Promise.resolve();
  const next = delivery.catch(() => {}).then(async () => {
    if (getLocalDraftScope() !== scope || getMobileConnection()?.server !== server) return;
    const preferences = readMobileNotificationPreferences();
    if (!preferences.enabled) return;
    const saved = readMobileNotificationLedger(localStorage.getItem(key));
    if (!saved) {
      localStorage.setItem(key, JSON.stringify({ version: 1, enabledAt: preferences.enabledAt, seen: notifications.map((item) => item.id).slice(-1000) }));
      return;
    }
    const ledger = saved;
    for (const item of [...notifications].sort((left, right) => left.createdAt - right.createdAt)) {
      if (getLocalDraftScope() !== scope || getMobileConnection()?.server !== server) return;
      if (ledger.seen.includes(item.id)) continue;
      if (!preferences[item.category]) { ledger.seen = [...ledger.seen, item.id].slice(-1000); localStorage.setItem(key, JSON.stringify(ledger)); continue; }
      const shown = await sendMobileNotification({ id: mobileNotificationId(`${scope}:${item.id}`), category: item.category,
        title: item.category === "action" ? "Bridge · 等待你处理" : item.category === "failure" ? "Bridge · 任务失败或中断" : "Bridge · 执行已完成",
        route: safeMobileRoute(item.route) ?? "/mobile-inbox", server, scope });
      if (getLocalDraftScope() !== scope || getMobileConnection()?.server !== server) return;
      if (shown) { ledger.seen = [...ledger.seen, item.id].slice(-1000); localStorage.setItem(key, JSON.stringify(ledger)); }
    }
  });
  delivery = next.catch(() => {});
  return next;
}
