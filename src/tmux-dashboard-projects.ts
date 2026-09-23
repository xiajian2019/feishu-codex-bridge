import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ProjectOption {
  name: string;
  root: string;
}

function parseScalar(value: string): string {
  const scalar = value.trim();
  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    return scalar.slice(1, -1).replace(/\\"/g, '"');
  }
  if (scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replace(/''/g, "'");
  }
  return scalar.replace(/\s+#.*$/, "").trim();
}

export function parseProjectMap(source: string): ProjectOption[] {
  const projects: ProjectOption[] = [];
  let inProjects = false;
  let projectName: string | null = null;
  let projectRoot: string | null = null;

  const saveProject = () => {
    if (projectName && projectRoot) projects.push({ name: projectName, root: projectRoot });
  };

  for (const line of source.split(/\r?\n/)) {
    if (!inProjects) {
      if (/^projects:\s*(?:#.*)?$/.test(line)) inProjects = true;
      continue;
    }
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;

    const entry = line.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (entry) {
      saveProject();
      projectName = entry[1];
      projectRoot = null;
      continue;
    }
    const root = line.match(/^    root:\s*(.*?)\s*$/);
    if (root && projectName) projectRoot = parseScalar(root[1]);
  }
  saveProject();
  return projects;
}

export function isWithinProject(sessionPath: string, projectRoot: string): boolean {
  if (!isAbsolute(sessionPath) || !isAbsolute(projectRoot)) return false;
  const pathFromRoot = relative(resolve(projectRoot), resolve(sessionPath));
  return pathFromRoot === ""
    || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

export function getProjectMapPath(homeDirectory: string, override?: string): string {
  return override || resolve(homeDirectory, ".codex", "project-map.yaml");
}
