import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocalDraftScope } from "../web/src/local-draft-scope.js";

import {
  CODEX_SKILL_CACHE_TTL_MS,
  clearCodexSkillCache,
  readCodexSkillCache,
  writeCodexSkillCache,
} from "../web/src/skill-cache.js";

const cacheKey = "test-skill-cache";
beforeEach(() => setLocalDraftScope("a".repeat(43), "https://skills.fixture"));

afterEach(() => {
  clearCodexSkillCache(cacheKey);
  setLocalDraftScope(null);
});
describe("Codex skill cache", () => {
  it("keeps valid skill metadata in the local cache for one day", () => {
    expect(CODEX_SKILL_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1_000);
    const value = [{ skillName: "review", descriptionZh: "代码审查" }];
    writeCodexSkillCache(cacheKey, value);

    const cached = readCodexSkillCache(cacheKey, (candidate): candidate is typeof value =>
      Array.isArray(candidate)
      && candidate.every((item) => (
        typeof item === "object"
        && item !== null
        && typeof (item as { skillName?: unknown }).skillName === "string"
        && typeof (item as { descriptionZh?: unknown }).descriptionZh === "string"
      )),
    );
    expect(cached).toEqual(value);
  });
});
