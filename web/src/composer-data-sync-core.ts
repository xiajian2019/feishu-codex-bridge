import { normalizeShortcutStore, type ShortcutStore } from "./tmux-shortcuts.js";

export type ComposerDataSource = { server: string; scope: string };
export type ComposerSnapshot = {
  dataset: "shortcuts" | "skills" | "session-skills";
  key: string;
  payload: Record<string, unknown>;
};

export type ComposerDataSyncDependencies = {
  isCurrent: (source: ComposerDataSource) => boolean;
  activate: (scope: string) => Promise<void>;
  deactivate: (scope: string | null, keepScope: string | null) => Promise<void>;
  save: (scope: string, snapshots: ComposerSnapshot[]) => Promise<void>;
  clearScope: (scope: string) => Promise<void>;
  loadShortcuts: () => Promise<unknown>;
  loadSkills: () => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject partial responses rather than replacing the last usable local copy. */
export function parseComposerShortcuts(value: unknown): (ShortcutStore & { revision?: string }) | null {
  if (!isRecord(value) || !Array.isArray(value.groups) || !Array.isArray(value.shortcuts)) return null;
  const validGroups = value.groups.every((group: unknown) => isRecord(group)
    && typeof group.id === "string" && group.id.length > 0
    && typeof group.enabled === "boolean" && (group.surface === "composer" || group.surface === "palette"));
  const validShortcuts = value.shortcuts.every((shortcut: unknown) => isRecord(shortcut)
    && typeof shortcut.id === "string" && shortcut.id.length > 0
    && typeof shortcut.groupId === "string" && shortcut.groupId.length > 0
    && typeof shortcut.enabled === "boolean" && typeof shortcut.sortOrder === "number"
    && Number.isFinite(shortcut.sortOrder));
  if (!validGroups || !validShortcuts) return null;
  const normalized = normalizeShortcutStore(value as Partial<ShortcutStore>);
  return typeof value.revision === "string" ? { ...normalized, revision: value.revision } : normalized;
}

export function parseComposerSkills(value: unknown): Record<string, unknown>[] | null {
  if (!isRecord(value) || !Array.isArray(value.skills)) return null;
  return value.skills.every((skill: unknown) => isRecord(skill)
    && typeof skill.skillName === "string" && skill.skillName.trim().length > 0)
    ? value.skills as Record<string, unknown>[]
    : null;
}

/** tmux IDs can be reused after a Session is destroyed and recreated. */
export function composerSessionKey(sessionId: string, createdAt: number): string | null {
  if (!sessionId || !Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  return `${encodeURIComponent(sessionId)}:${createdAt}`;
}

/** Auth intentionally retains the old scope briefly while switching servers. */
export function composerDataSource(server: string, scope: string | null): ComposerDataSource | null {
  if (!scope) return null;
  try {
    const origin = new URL(server).origin;
    const prefix = `${encodeURIComponent(origin)}:`;
    const device = scope.startsWith(prefix) ? scope.slice(prefix.length) : "";
    return /^[A-Za-z0-9_-]{32,128}$/.test(device) ? { server, scope } : null;
  } catch {
    return null;
  }
}

/**
 * Serialize native writes and discard stale requests after switches/logout.
 * A failed dataset is omitted so it cannot clear the previous SQLite copy.
 */
export function createComposerDataSynchronizer(deps: ComposerDataSyncDependencies) {
  let generation = 0;
  let latestSource: ComposerDataSource | null = null;
  let pendingWrite: Promise<void> = Promise.resolve();

  const enqueue = (action: () => Promise<void>): Promise<void> => {
    const result = pendingWrite.then(action);
    pendingWrite = result.catch(() => {});
    return result;
  };

  const valid = (source: ComposerDataSource, ticket: number): boolean => (
    ticket === generation && deps.isCurrent(source)
  );

  async function sync(source: ComposerDataSource): Promise<void> {
    const ticket = ++generation;
    latestSource = source;
    if (!valid(source, ticket)) return;
    await enqueue(async () => {
      if (valid(source, ticket)) await deps.activate(source.scope);
    });
    if (!valid(source, ticket)) return;
    const [shortcutResult, skillResult] = await Promise.allSettled([deps.loadShortcuts(), deps.loadSkills()]);
    if (!valid(source, ticket)) return;
    const snapshots: ComposerSnapshot[] = [];
    if (shortcutResult.status === "fulfilled") {
      const config = parseComposerShortcuts(shortcutResult.value);
      if (config) snapshots.push({ dataset: "shortcuts", key: "", payload: {
        groups: config.groups, shortcuts: config.shortcuts,
        ...(config.revision === undefined ? {} : { revision: config.revision }),
      } });
    }
    if (skillResult.status === "fulfilled") {
      const skills = parseComposerSkills(skillResult.value);
      if (skills) snapshots.push({ dataset: "skills", key: "", payload: { skills } });
    }
    if (snapshots.length === 0) return;
    await enqueue(async () => {
      if (valid(source, ticket)) await deps.save(source.scope, snapshots);
    });
  }

  async function saveSessionSkills(
    source: ComposerDataSource,
    sessionId: string,
    createdAt: number,
    skills: unknown,
  ): Promise<void> {
    const key = composerSessionKey(sessionId, createdAt);
    const parsed = parseComposerSkills({ skills });
    if (!key || !parsed || !deps.isCurrent(source)) return;
    await enqueue(async () => {
      if (deps.isCurrent(source)) {
        await deps.activate(source.scope);
        if (!deps.isCurrent(source)) return;
        await deps.save(source.scope, [{ dataset: "session-skills", key, payload: { skills: parsed } }]);
      }
    });
  }

  async function clearScope(scope: string): Promise<void> {
    if (latestSource?.scope === scope) {
      generation += 1;
      latestSource = null;
    }
    await enqueue(() => deps.clearScope(scope));
  }

  async function deactivateScope(scope: string | null, keepScope: () => string | null = () => null): Promise<void> {
    if (latestSource && (scope === null ? latestSource.scope !== keepScope() : latestSource.scope === scope)) {
      generation += 1;
      latestSource = null;
    }
    await enqueue(() => deps.deactivate(scope, keepScope()));
  }

  return { sync, saveSessionSkills, clearScope, deactivateScope };
}
