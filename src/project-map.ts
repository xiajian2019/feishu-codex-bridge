import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** The deliberately small project-map.yaml contract shared by AAMP and direct mode. */
export interface ProjectMapEntry {
  key: string;
  root: string;
}

export function readProjectMap(filePath: string): Record<string, string> {
  const source = readFileSync(filePath, "utf8");
  const projects: Record<string, string> = {};
  let projectsIndent: number | undefined;
  let currentProject: string | undefined;
  let currentProjectIndent: number | undefined;

  for (const rawLine of source.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine) || /^\s*$/.test(rawLine)) continue;
    if (/\t/.test(rawLine)) throw new Error(`project map cannot use tabs: ${filePath}`);
    const content = stripYamlComment(rawLine);
    if (!content.trim()) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const projectsMatch = /^projects\s*:\s*(.*)$/.exec(content.trim());
    if (projectsMatch && indent === 0) {
      projectsIndent = indent;
      currentProject = undefined;
      currentProjectIndent = undefined;
      continue;
    }
    if (projectsIndent === undefined) continue;
    if (indent <= projectsIndent) {
      currentProject = undefined;
      currentProjectIndent = undefined;
      continue;
    }
    const entryMatch = /^([^:#][^:]*?):(?:\s*(.*))?$/.exec(content.trim());
    if (indent === projectsIndent + 2 && entryMatch) {
      currentProject = yamlScalar(entryMatch[1]);
      currentProjectIndent = indent;
      const inlineRoot = yamlScalar(entryMatch[2] || "");
      if (inlineRoot) projects[currentProject] = inlineRoot;
      continue;
    }
    if (currentProject && currentProjectIndent !== undefined && indent > currentProjectIndent) {
      const rootMatch = /^root\s*:\s*(.*)$/.exec(content.trim());
      if (rootMatch) projects[currentProject] = yamlScalar(rootMatch[1]);
    }
  }
  return projects;
}

export function resolveMappedProject(filePath: string, projectKey: string): ProjectMapEntry | undefined {
  const projects = readProjectMap(filePath);
  const root = projects[projectKey];
  if (!root) return undefined;
  if (!isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`project "${projectKey}" mapping path is invalid or missing: ${root}`);
  }
  try {
    const isRepository = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (isRepository !== "true") throw new Error("not a Git repository");
  } catch {
    throw new Error(`project "${projectKey}" mapping path is not a Git repository: ${root}`);
  }
  return { key: projectKey, root };
}

function stripYamlComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== "\\") {
      quote = quote === character ? undefined : quote || character;
    }
    if (character === "#" && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trim();
}

function yamlScalar(value: string): string {
  const trimmed = stripYamlComment(value).trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}
