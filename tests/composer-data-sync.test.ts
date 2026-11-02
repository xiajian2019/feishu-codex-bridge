import { describe, expect, test } from "bun:test";
import {
  composerSessionKey,
  composerDataSource,
  createComposerDataSynchronizer,
  parseComposerShortcuts,
  type ComposerDataSource,
  type ComposerSnapshot,
} from "../web/src/composer-data-sync-core.js";

const sourceA: ComposerDataSource = { server: "https://a.example", scope: "source-a" };
const sourceB: ComposerDataSource = { server: "https://b.example", scope: "source-b" };

const shortcuts = {
  revision: "remote-revision",
  groups: [{ id: "composer", title: "我的输入框", enabled: true, surface: "composer", sortOrder: 2 }],
  shortcuts: [{
    id: "custom", groupId: "composer", title: "自定义", enabled: true, sortOrder: 7,
    kind: "sequence", value: "Ctrl+L", displayMode: "both", dangerous: false, operationCount: 17,
  }],
};
const skills = { skills: [{ skillName: "custom-skill", nameZh: "技能", scope: "project", pinned: true, sortOrder: 2 }] };

function makeHarness() {
  let current: ComposerDataSource | null = sourceA;
  let active: string | null = null;
  const stored = new Map<string, ComposerSnapshot>();
  let loadShortcuts = async (): Promise<unknown> => shortcuts;
  let loadSkills = async (): Promise<unknown> => skills;
  const key = (scope: string, dataset: string, item = "") => `${scope}/${dataset}/${item}`;
  const sync = createComposerDataSynchronizer({
    isCurrent: (source) => current?.server === source.server && current.scope === source.scope,
    activate: async (scope) => { active = scope; },
    deactivate: async (scope, keepScope) => {
      if (scope !== null ? active === scope : active !== keepScope) active = null;
    },
    save: async (scope, snapshots) => {
      if (active !== scope) throw new Error("inactive scope");
      for (const snapshot of snapshots) {
        stored.set(key(scope, snapshot.dataset, snapshot.key), structuredClone(snapshot));
      }
    },
    clearScope: async (scope) => {
      for (const storedKey of stored.keys()) if (storedKey.startsWith(`${scope}/`)) stored.delete(storedKey);
      if (active === scope) active = null;
    },
    loadShortcuts: () => loadShortcuts(),
    loadSkills: () => loadSkills(),
  });
  return {
    ...sync,
    stored,
    key,
    readActive: (dataset: string) => active ? stored.get(key(active, dataset)) : undefined,
    setCurrent: (source: ComposerDataSource | null) => { current = source; },
    setLoadShortcuts: (load: () => Promise<unknown>) => { loadShortcuts = load; },
    setLoadSkills: (load: () => Promise<unknown>) => { loadSkills = load; },
  };
}

describe("Android Composer data synchronization", () => {
  test("copies complete custom shortcuts and skills and preserves them after offline or malformed responses", async () => {
    const state = makeHarness();
    await state.sync(sourceA);
    expect(state.stored.get(state.key(sourceA.scope, "shortcuts"))?.payload).toEqual({
      groups: shortcuts.groups, shortcuts: shortcuts.shortcuts, revision: shortcuts.revision,
    });
    expect(state.stored.get(state.key(sourceA.scope, "skills"))?.payload).toEqual(skills);

    state.setLoadShortcuts(async () => ({ groups: [], shortcuts: "partial response" }));
    state.setLoadSkills(async () => { throw new Error("offline"); });
    await state.sync(sourceA);
    expect(state.stored.get(state.key(sourceA.scope, "shortcuts"))?.payload.shortcuts).toEqual(shortcuts.shortcuts);
    expect(state.stored.get(state.key(sourceA.scope, "skills"))?.payload).toEqual(skills);

    state.setLoadShortcuts(async () => ({ ...shortcuts, shortcuts: [{ ...shortcuts.shortcuts[0], title: "更新" }] }));
    await state.sync(sourceA);
    expect((state.stored.get(state.key(sourceA.scope, "shortcuts"))?.payload.shortcuts as typeof shortcuts.shortcuts)[0]?.title).toBe("更新");
    expect(state.stored.get(state.key(sourceA.scope, "skills"))?.payload).toEqual(skills);
  });

  test("a late response from the previous Bridge cannot replace the active source", async () => {
    const state = makeHarness();
    let releaseOld!: (value: unknown) => void;
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => { oldStarted = resolve; });
    const old = new Promise<unknown>((resolve) => { releaseOld = resolve; });
    let calls = 0;
    state.setLoadShortcuts(() => {
      calls += 1;
      if (calls === 1) { oldStarted(); return old; }
      return Promise.resolve({ ...shortcuts, shortcuts: [{ ...shortcuts.shortcuts[0], title: "环境 B" }] });
    });
    const previous = state.sync(sourceA);
    await started;
    state.setCurrent(sourceB);
    await state.sync(sourceB);
    releaseOld(shortcuts);
    await previous;
    expect(state.stored.has(state.key(sourceA.scope, "shortcuts"))).toBe(false);
    expect((state.stored.get(state.key(sourceB.scope, "shortcuts"))?.payload.shortcuts as typeof shortcuts.shortcuts)[0]?.title).toBe("环境 B");
  });

  test("revocation drops only its source and prevents an in-flight response from restoring it", async () => {
    const state = makeHarness();
    await state.sync(sourceA);
    state.setCurrent(sourceB);
    await state.sync(sourceB);
    state.setCurrent(sourceA);
    let release!: (value: unknown) => void;
    let started!: () => void;
    const startedLoading = new Promise<void>((resolve) => { started = resolve; });
    state.setLoadShortcuts(() => new Promise((resolve) => { release = resolve; started(); }));
    const pending = state.sync(sourceA);
    await startedLoading;
    state.setCurrent(null);
    await state.clearScope(sourceA.scope);
    release(shortcuts);
    await pending;
    expect(state.stored.has(state.key(sourceA.scope, "shortcuts"))).toBe(false);
    expect(state.stored.has(state.key(sourceB.scope, "shortcuts"))).toBe(true);
  });

  test("switching environments deselects the old copy without deleting it", async () => {
    const state = makeHarness();
    await state.sync(sourceA);
    state.setCurrent(sourceB);
    await state.deactivateScope(sourceA.scope);
    expect(state.readActive("shortcuts")).toBeUndefined();
    expect(state.stored.has(state.key(sourceA.scope, "shortcuts"))).toBe(true);
    await state.sync(sourceB);
    await state.deactivateScope(sourceA.scope);
    expect(state.readActive("shortcuts")?.payload).toEqual({
      groups: shortcuts.groups, shortcuts: shortcuts.shortcuts, revision: shortcuts.revision,
    });
    await state.deactivateScope(null, () => sourceB.scope);
    expect(state.readActive("shortcuts")).toBeDefined();
    await state.deactivateScope(null);
    expect(state.readActive("shortcuts")).toBeUndefined();
    expect(state.stored.has(state.key(sourceB.scope, "shortcuts"))).toBe(true);
  });

  test("session skills include session lifetime and stay isolated from other sources", async () => {
    const state = makeHarness();
    await state.sync(sourceA);
    await state.saveSessionSkills(sourceA, "$1", 123, [{ skillName: "one", descriptionZh: "描述" }]);
    await state.saveSessionSkills(sourceA, "$1", 124, [{ skillName: "two", descriptionZh: "描述" }]);
    await state.saveSessionSkills(sourceA, "$1", 0, [{ skillName: "invalid" }]);
    expect(composerSessionKey("$1", 0)).toBeNull();
    expect(state.stored.get(state.key(sourceA.scope, "session-skills", "%241:123"))?.payload.skills).toEqual([{ skillName: "one", descriptionZh: "描述" }]);
    expect(state.stored.get(state.key(sourceA.scope, "session-skills", "%241:124"))?.payload.skills).toEqual([{ skillName: "two", descriptionZh: "描述" }]);
    state.setCurrent(sourceB);
    await state.saveSessionSkills(sourceA, "$1", 125, [{ skillName: "wrong" }]);
    expect(state.stored.has(state.key(sourceA.scope, "session-skills", "%241:125"))).toBe(false);
  });

  test("old server Composer records get the same action compatibility as Web", () => {
    const old = parseComposerShortcuts({
      groups: [{ id: "composer", enabled: true, surface: "palette" }],
      shortcuts: [{ id: "composer-enter", groupId: "composer", enabled: true, sortOrder: 9 }],
    });
    expect(old?.groups[0]?.surface).toBe("composer");
    expect(old?.shortcuts[0]?.actionKey).toBe("terminal-enter");
  });

  test("an old authentication scope cannot be attributed to a newly selected Bridge", () => {
    const device = "a".repeat(32);
    const scope = `${encodeURIComponent(sourceA.server)}:${device}`;
    expect(composerDataSource(sourceA.server, scope)).toEqual({ server: sourceA.server, scope });
    expect(composerDataSource(sourceB.server, scope)).toBeNull();
    expect(composerDataSource(sourceA.server, "invalid")).toBeNull();
  });
});
