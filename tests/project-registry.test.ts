import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { StateDatabase } from "../src/db.js";
import { initializeProjectRegistry, writeProjectRegistrySnapshot } from "../src/project-registry.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Bridge project registry bootstrap", () => {
  it("imports a legacy project map once and preserves later database edits", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-project-registry-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "food");
    mkdirSync(root);
    const mapPath = join(directory, "project_map.yaml");
    writeFileSync(mapPath, `projects:\n  food:\n    root: ${root}\n`, "utf8");
    const db = new StateDatabase(":memory:");

    initializeProjectRegistry(db, {}, mapPath);
    expect(db.listAvailableProjects().map((project) => project.name)).toEqual(["food"]);
    db.updateProject("food", { status: "disabled" });
    initializeProjectRegistry(db, {}, mapPath);
    expect(db.getProject("food")?.status).toBe("disabled");
    db.close();
  });

  it("prefers Bridge config paths when importing matching legacy names", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-project-config-"));
    temporaryDirectories.push(directory);
    const configuredRoot = join(directory, "configured");
    const legacyRoot = join(directory, "legacy");
    mkdirSync(configuredRoot);
    mkdirSync(legacyRoot);
    const mapPath = join(directory, "project-map.yaml");
    writeFileSync(mapPath, `projects:\n  food:\n    root: ${legacyRoot}\n`, "utf8");
    const db = new StateDatabase(":memory:");

    initializeProjectRegistry(db, { food: { optionGuid: "food-option", repo: configuredRoot } }, mapPath);
    expect(db.getProject("food")?.path).toBe(configuredRoot);
    db.close();
  });

  it("writes the active registry snapshot for the AAMP adapter", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-project-snapshot-"));
    temporaryDirectories.push(directory);
    const db = new StateDatabase(":memory:");
    const projectRoot = join(directory, "repo");
    mkdirSync(projectRoot);
    db.createProject({ name: "food", path: projectRoot });
    db.createProject({ name: "paused", path: projectRoot, status: "disabled" });
    const snapshotPath = join(directory, "runtime", "projects.json");

    writeProjectRegistrySnapshot(db, snapshotPath);

    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual({ food: projectRoot });
    db.close();
  });
});
