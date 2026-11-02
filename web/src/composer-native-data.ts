import { Capacitor, registerPlugin } from "@capacitor/core";
import { readBridgeJson } from "./bridge-json.js";
import { composerDataSource, createComposerDataSynchronizer, type ComposerDataSource, type ComposerSnapshot } from "./composer-data-sync-core.js";
import { getBridgeConnectionSnapshot, subscribeBridgeConnection } from "./connection-state.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import { getMobileConnection, MOBILE_RESUME_EVENT } from "./mobile-runtime.js";
import { readShortcutConfigCache, subscribeShortcutConfigInvalidation } from "./shortcut-config-cache.js";

const COMPOSER_DATA_INVALIDATED = "bridge:composer-data-invalidated";

interface ComposerDataPlugin {
  activate(options: { scope: string }): Promise<void>;
  deactivate(options: { scope?: string; keepScope?: string }): Promise<void>;
  save(options: { scope: string; snapshots: ComposerSnapshot[] }): Promise<void>;
  read(options: { dataset: ComposerSnapshot["dataset"]; key?: string }): Promise<{ found: boolean; payload?: Record<string, unknown>; updatedAt?: number }>;
  clearScope(options: { scope: string }): Promise<void>;
}

const NativeComposerData = registerPlugin<ComposerDataPlugin>("BridgeComposerData");

function androidAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("BridgeComposerData");
}

function currentSource(): ComposerDataSource | null {
  const connection = getMobileConnection();
  const scope = getLocalDraftScope();
  return connection?.token ? composerDataSource(connection.server, scope) : null;
}

async function fetchFreshJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Composer configuration is unavailable");
  return readBridgeJson<unknown>(response);
}

const synchronizer = createComposerDataSynchronizer({
  isCurrent: (source) => {
    const current = currentSource();
    return current?.scope === source.scope && current.server === source.server;
  },
  activate: (scope) => NativeComposerData.activate({ scope }),
  deactivate: (scope, keepScope) => NativeComposerData.deactivate({
    ...(scope ? { scope } : {}), ...(keepScope ? { keepScope } : {}),
  }),
  save: (scope, snapshots) => NativeComposerData.save({ scope, snapshots }),
  clearScope: (scope) => NativeComposerData.clearScope({ scope }),
  loadShortcuts: () => fetchFreshJson("/api/shortcut-config"),
  loadSkills: () => fetchFreshJson("/api/skills"),
});

let listenersInstalled = false;
function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  subscribeShortcutConfigInvalidation(() => {
    // Writes also notify Web consumers. Only invalidation needs a fresh fetch.
    if (!readShortcutConfigCache()) syncNativeComposerData();
  });
  let wasUnavailable = false;
  subscribeBridgeConnection(() => {
    const state = getBridgeConnectionSnapshot();
    if (!state.browserOnline || state.api === "unreachable" || state.api === "stale") wasUnavailable = true;
    if (state.browserOnline && state.api === "connected" && wasUnavailable) {
      wasUnavailable = false;
      syncNativeComposerData();
    }
  });
  window.addEventListener(COMPOSER_DATA_INVALIDATED, syncNativeComposerData);
  window.addEventListener(MOBILE_RESUME_EVENT, syncNativeComposerData);
  window.addEventListener("online", syncNativeComposerData);
}

/** Best effort: a failed sync leaves both Web and the previous SQLite copy intact. */
export function syncNativeComposerData(): void {
  if (!androidAvailable()) return;
  installListeners();
  const source = currentSource();
  if (source) void synchronizer.sync(source).catch(() => {});
}

export function saveNativeComposerSessionSkills(
  expectedScope: string | null,
  sessionId: string,
  createdAt: number,
  skills: unknown,
): void {
  if (!androidAvailable()) return;
  const source = currentSource();
  if (!source || source.scope !== expectedScope) return;
  void synchronizer.saveSessionSkills(source, sessionId, createdAt, skills).catch(() => {});
}

export async function clearNativeComposerScope(scope: string | null): Promise<void> {
  if (!scope || !androidAvailable()) return;
  await synchronizer.clearScope(scope);
}

export async function deactivateNativeComposerScope(scope: string | null, nextServer: string): Promise<void> {
  if (!androidAvailable()) return;
  await synchronizer.deactivateScope(scope, () => {
    const current = currentSource();
    return current?.server === nextServer ? current.scope : null;
  });
}
