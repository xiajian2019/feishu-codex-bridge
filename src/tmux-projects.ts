import { existsSync, statSync } from "node:fs";

import { readProjectMap } from "./project-map.js";

export interface TmuxProjectOption {
  key: string;
  root: string;
  available: boolean;
}

export interface TmuxProjectCatalog {
  items: TmuxProjectOption[];
  error?: string;
}

export function loadTmuxProjectCatalog(projectMapPath: string): TmuxProjectCatalog {
  try {
    const projects = readProjectMap(projectMapPath);
    return {
      items: Object.entries(projects)
        .map(([key, root]) => ({
          key,
          root,
          available: isDirectory(root),
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveTmuxProject(projectMapPath: string, projectKey: string): string {
  const catalog = loadTmuxProjectCatalog(projectMapPath);
  if (catalog.error) throw new Error(`无法读取 project map：${catalog.error}`);
  const project = catalog.items.find((item) => item.key === projectKey);
  if (!project) throw new Error(`project map 中不存在项目：${projectKey}`);
  if (!project.available) {
    throw new Error(`项目路径不可用：${project.key} -> ${project.root}`);
  }
  return project.root;
}

function isDirectory(path: string): boolean {
  try {
    return path.startsWith("/") && existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
