import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { StateDatabase } from "./db.js";
import { readProjectMap } from "./project-map.js";
import type { ProjectConfig } from "./types.js";

export function initializeProjectRegistry(
  db: StateDatabase,
  configuredProjects: Record<string, ProjectConfig> = {},
  legacyMapPath?: string,
): void {
  const shouldImportLegacyMap = db.listProjects().length === 0;
  const projects = new Map<string, string>();
  for (const [name, project] of Object.entries(configuredProjects)) {
    projects.set(name, project.repo);
  }
  if (shouldImportLegacyMap) {
    const legacyPaths = legacyMapPath
      ? [legacyMapPath]
      : [
          resolve(homedir(), ".codex", "project_map.yaml"),
          resolve(homedir(), ".codex", "project-map.yaml"),
        ].filter((path): path is string => Boolean(path));
    for (const path of legacyPaths) {
      try {
        const legacyProjects = Object.entries(readProjectMap(path));
        if (legacyProjects.length === 0) continue;
        for (const [name, projectPath] of legacyProjects) {
          if (!projects.has(name)) projects.set(name, projectPath);
        }
        break;
      } catch {
        continue;
      }
    }
  }

  for (const [name, path] of projects) {
    if (!isAbsolute(path)) continue;
    db.ensureProject({
      name,
      path,
      status: isProjectDirectory(path) ? "available" : "disabled",
    });
  }
}

export function writeProjectRegistrySnapshot(db: StateDatabase, filePath: string): void {
  const destination = resolve(filePath);
  const temporaryPath = `${destination}.${process.pid}.tmp`;
  const routes = Object.fromEntries(db.listAvailableProjects().map((project) => [project.name, project.path]));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(temporaryPath, `${JSON.stringify(routes)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, destination);
}

function isProjectDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
