import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTmuxProjectCatalog, resolveTmuxProject } from "../src/tmux-projects.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("tmux project catalog", () => {
  it("loads searchable project options and resolves only an available mapped root", () => {
    const directory = mkdtempSync(join(tmpdir(), "tmux-project-map-"));
    temporaryDirectories.push(directory);
    const foodRoot = join(directory, "food");
    mkdirSync(foodRoot);
    const mapPath = join(directory, "project-map.yaml");
    writeFileSync(mapPath, [
      "projects:",
      "  food:",
      `    root: ${foodRoot}`,
      "  missing:",
      `    root: ${join(directory, "missing")}`,
      "  relative:",
      "    root: ./not-allowed",
      "",
    ].join("\n"));

    expect(loadTmuxProjectCatalog(mapPath).items).toEqual([
      { key: "food", root: foodRoot, available: true },
      { key: "missing", root: join(directory, "missing"), available: false },
      { key: "relative", root: "./not-allowed", available: false },
    ]);
    expect(resolveTmuxProject(mapPath, "food")).toBe(foodRoot);
    expect(() => resolveTmuxProject(mapPath, "missing")).toThrow("项目路径不可用");
  });
});
