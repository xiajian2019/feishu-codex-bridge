import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexSkillScopeKeys, discoverCodexSkills } from "../src/codex-skills.js";
import { StateDatabase } from "../src/db.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex skill discovery for shared account directories", () => {
  it("promotes a shared skill to the user scope across accounts and rescans", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-skill-alias-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    const defaultHome = join(home, ".codex");
    const accountHome = join(defaultHome, "accounts", "second");
    const defaultSkills = join(defaultHome, "skills");
    const accountSkills = join(accountHome, "skills");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(defaultSkills, "bridge-android-apk"), { recursive: true });
    await mkdir(accountHome, { recursive: true });
    await symlink(defaultSkills, accountSkills, "dir");
    const skillFile = join(defaultSkills, "bridge-android-apk", "SKILL.md");
    await writeFile(skillFile, "---\nname: bridge-android-apk\ndescription: Build the Android debug APK.\n---\n");

    const database = new StateDatabase(":memory:");
    try {
      const scan = () => discoverCodexSkills({ codexHomePath: accountHome, projectCwd: project, homeDirectory: home });
      const first = await scan();
      const rows = first.skills.filter((skill) => skill.skillName === "bridge-android-apk");
      expect(rows.map((skill) => skill.scopeKey).sort()).toEqual([accountSkills, defaultSkills].sort());
      expect(new Set(rows.map((skill) => skill.id)).size).toBe(2);
      database.syncCodexSkills(first.sources, first.skills);
      const defaultScopes = codexSkillScopeKeys({ codexHomePath: defaultHome, projectCwd: project, homeDirectory: home });
      const accountScopes = codexSkillScopeKeys({ codexHomePath: accountHome, projectCwd: project, homeDirectory: home });
      expect(database.listCodexSkills(defaultScopes).map((skill) => skill.skillName)).toContain("bridge-android-apk");
      expect(database.listCodexSkills(accountScopes).filter((skill) => skill.skillName === "bridge-android-apk")).toHaveLength(2);
      database.saveCodexSkillPreferences([{ skillName: "bridge-android-apk", pinned: true, sortOrder: 3 }]);

      const repeated = await scan();
      database.syncCodexSkills(repeated.sources, repeated.skills);
      expect(database.listCodexSkills(defaultScopes).find((skill) => skill.skillName === "bridge-android-apk"))
        .toMatchObject({ pinned: true, sortOrder: 3 });
      expect(database.listCodexSkills(accountScopes).filter((skill) => skill.skillName === "bridge-android-apk")).toHaveLength(2);

      // Expose the same skill in the account-independent user directory.
      // A complete rescan must remove the old account records and retain one
      // global record, including for a CODEX_HOME outside ~/.codex/accounts.
      const userSkills = join(home, ".agents", "skills");
      await mkdir(userSkills, { recursive: true });
      await symlink(join(defaultSkills, "bridge-android-apk"), join(userSkills, "bridge-android-apk"), "dir");
      const global = await scan();
      expect(global.skills.filter((skill) => skill.skillName === "bridge-android-apk"))
        .toMatchObject([{ scope: "user", scopeKey: userSkills, sourceKey: "bridge-android-apk/SKILL.md" }]);
      database.syncCodexSkills(global.sources, global.skills);
      const independentScopes = codexSkillScopeKeys({ codexHomePath: join(root, "another-codex-home"), projectCwd: project, homeDirectory: home });
      for (const scopes of [defaultScopes, accountScopes, independentScopes]) {
        expect(database.listCodexSkills(scopes).filter((skill) => skill.skillName === "bridge-android-apk"))
          .toMatchObject([{ scope: "user", pinned: true, sortOrder: 3 }]);
      }
      const again = await scan();
      database.syncCodexSkills(again.sources, again.skills);
      expect(database.listCodexSkills().filter((skill) => skill.skillName === "bridge-android-apk"))
        .toMatchObject([{ scope: "user" }]);

      // A distinct project skill with the same name must not be deduplicated
      // against the global file; the caller still applies scope precedence.
      const projectOverride = join(project, ".agents", "skills", "override", "SKILL.md");
      await mkdir(join(project, ".agents", "skills", "override"), { recursive: true });
      await writeFile(projectOverride, "---\nname: bridge-android-apk\ndescription: Project override.\n---\n");
      const distinct = await scan();
      expect(distinct.skills.filter((skill) => skill.skillName === "bridge-android-apk").map((skill) => skill.scope).sort())
        .toEqual(["project", "user"]);
      await rm(projectOverride);

      await rm(skillFile);
      const removed = await scan();
      database.syncCodexSkills(removed.sources, removed.skills);
      expect(database.listCodexSkills(accountScopes).filter((skill) => skill.skillName === "bridge-android-apk")).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("limits unique skills without letting directory aliases exhaust the other account scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-skill-limit-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    const defaultHome = join(home, ".codex");
    const accountHome = join(defaultHome, "accounts", "second");
    const defaultSkills = join(defaultHome, "skills");
    const accountSkills = join(accountHome, "skills");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(defaultSkills, { recursive: true });
    await mkdir(accountHome, { recursive: true });
    await symlink(defaultSkills, accountSkills, "dir");
    await Promise.all(Array.from({ length: 1001 }, async (_, index) => {
      const directory = join(defaultSkills, `skill-${index}`);
      await mkdir(directory);
      await writeFile(join(directory, "SKILL.md"), `---\nname: skill-${index}\ndescription: fixture\n---\n`);
    }));
    const discovered = await discoverCodexSkills({ codexHomePath: accountHome, projectCwd: project, homeDirectory: home });
    const namesFor = (scopeKey: string) => discovered.skills.filter((skill) => skill.scopeKey === scopeKey)
      .map((skill) => skill.skillName).sort();
    expect(namesFor(accountSkills)).toHaveLength(1000);
    expect(namesFor(defaultSkills)).toEqual(namesFor(accountSkills));
    expect(discovered.sources.filter((source) => [accountSkills, defaultSkills].includes(source.scopeKey)))
      .toMatchObject([{ complete: false }, { complete: false }]);
  });
});
