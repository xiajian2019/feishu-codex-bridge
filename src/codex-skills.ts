import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type CodexSkillScope = "project" | "codex_home" | "user" | "system" | "plugin";

export interface CodexSkillSource {
  scope: CodexSkillScope;
  scopeKey: string;
  complete: boolean;
}

export interface DiscoveredCodexSkill {
  id: string;
  scope: CodexSkillScope;
  scopeKey: string;
  sourceKey: string;
  skillName: string;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  sourceHash: string;
}

export interface CodexSkillDiscovery {
  sources: CodexSkillSource[];
  skills: DiscoveredCodexSkill[];
}

export function codexSkillScopeKeys(options: {
  codexHomePath: string;
  projectCwd: string;
  homeDirectory?: string;
}): string[] {
  const homeDirectory = options.homeDirectory ?? homedir();
  return [...new Set(buildSourceRoots(options.codexHomePath, options.projectCwd, homeDirectory)
    .map((source) => resolve(source.rootPath)))];
}

interface SkillSourceRoot {
  scope: CodexSkillScope;
  rootPath: string;
}

interface SkillMetadata {
  name?: string;
  name_zh?: string;
  name_en?: string;
  display_name?: string;
  display_name_zh?: string;
  display_name_en?: string;
  description?: string;
  description_zh?: string;
  description_en?: string;
}

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_DISCOVERY_DIRECTORIES = 4_000;
const MAX_DISCOVERY_DEPTH = 12;
const MAX_DISCOVERED_SKILLS = 1_000;
const MAX_DESCRIPTION_LENGTH = 240;
const SKIP_DIRECTORY_NAMES = new Set([".git", "node_modules", ".cache", "__pycache__", "vendor", "dist", "build"]);

export async function discoverCodexSkills(options: {
  codexHomePath: string;
  projectCwd: string;
  homeDirectory?: string;
}): Promise<CodexSkillDiscovery> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const roots = buildSourceRoots(options.codexHomePath, options.projectCwd, homeDirectory);
  const sources: CodexSkillSource[] = [];
  const skills: DiscoveredCodexSkill[] = [];
  const visitedSkillFiles = new Set<string>();
  let visitedDirectoryCount = 0;

  for (const source of roots) {
    const result = await scanSkillRoot(source, visitedSkillFiles, () => {
      visitedDirectoryCount += 1;
      return visitedDirectoryCount <= MAX_DISCOVERY_DIRECTORIES;
    }, skills.length);
    sources.push({ scope: source.scope, scopeKey: resolve(source.rootPath), complete: result.complete });
    skills.push(...result.skills);
    if (skills.length >= MAX_DISCOVERED_SKILLS || visitedDirectoryCount > MAX_DISCOVERY_DIRECTORIES) break;
  }

  return { sources, skills: skills.slice(0, MAX_DISCOVERED_SKILLS) };
}

function buildSourceRoots(codexHomePath: string, projectCwd: string, homeDirectory: string): SkillSourceRoot[] {
  const roots: SkillSourceRoot[] = [];
  const add = (scope: CodexSkillScope, rootPath: string): void => {
    const normalizedPath = resolve(rootPath);
    if (roots.some((root) => root.scope === scope && resolve(root.rootPath) === normalizedPath)) return;
    roots.push({ scope, rootPath: normalizedPath });
  };

  for (const projectSkillsPath of projectSkillRoots(projectCwd)) add("project", projectSkillsPath);

  const configuredHome = resolve(codexHomePath || join(homeDirectory, ".codex"));
  const defaultHome = resolve(homeDirectory, ".codex");
  const accountsRoot = join(defaultHome, "accounts");
  const configuredHomeIsAccount = isPathWithin(accountsRoot, configuredHome) && configuredHome !== accountsRoot;
  const codexHomes = [configuredHome, ...(configuredHomeIsAccount ? [defaultHome] : [])];
  for (const codexHome of codexHomes) {
    add("codex_home", join(codexHome, "skills"));
    add("plugin", join(codexHome, "plugins", "cache"));
  }

  add("user", join(homeDirectory, ".agents", "skills"));
  add("system", "/etc/codex/skills");
  return roots;
}

function projectSkillRoots(projectCwd: string): string[] {
  const cwd = resolve(projectCwd);
  const ancestors: string[] = [];
  let current = cwd;
  let foundGitRoot = false;

  while (true) {
    ancestors.push(current);
    if (existsSync(join(current, ".git"))) {
      foundGitRoot = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const searchedAncestors = foundGitRoot ? ancestors : [cwd];
  return searchedAncestors.map((directory) => join(directory, ".agents", "skills"));
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(".." + sep) && !isAbsolute(relativePath));
}

async function scanSkillRoot(
  source: SkillSourceRoot,
  visitedSkillFiles: Set<string>,
  countDirectory: () => boolean,
  alreadyDiscovered: number,
): Promise<{ complete: boolean; skills: DiscoveredCodexSkill[] }> {
  const rootPath = resolve(source.rootPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(rootPath);
    if (!(await stat(canonicalRoot)).isDirectory()) return { complete: true, skills: [] };
  } catch (error) {
    return isMissingPath(error) ? { complete: true, skills: [] } : { complete: false, skills: [] };
  }

  const pending = [{ path: canonicalRoot, depth: 0 }];
  const visitedDirectories = new Set<string>();
  const discovered: DiscoveredCodexSkill[] = [];
  let complete = true;

  while (pending.length > 0 && alreadyDiscovered + discovered.length < MAX_DISCOVERED_SKILLS) {
    const current = pending.pop()!;
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(current.path);
      if (visitedDirectories.has(canonicalDirectory)) continue;
      visitedDirectories.add(canonicalDirectory);
      if (!countDirectory()) {
        complete = false;
        break;
      }
      const entries = await readdir(canonicalDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "SKILL.md") {
          const skillPath = join(canonicalDirectory, entry.name);
          try {
            const canonicalSkillPath = await realpath(skillPath);
            if (visitedSkillFiles.has(canonicalSkillPath)) continue;
            visitedSkillFiles.add(canonicalSkillPath);
            const metadata = await readSkillMetadata(canonicalSkillPath);
            if (!metadata) continue;
            const relativeSkillPath = relative(canonicalRoot, canonicalSkillPath).split(sep).join("/");
            const scope = inferredScope(source.scope, relativeSkillPath);
            discovered.push(toDiscoveredSkill(scope, rootPath, relativeSkillPath, metadata));
          } catch (error) {
            if (!isMissingPath(error)) complete = false;
          }
          continue;
        }

        if (current.depth >= MAX_DISCOVERY_DEPTH || SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const childPath = join(canonicalDirectory, entry.name);
        try {
          if ((await stat(childPath)).isDirectory()) pending.push({ path: childPath, depth: current.depth + 1 });
        } catch (error) {
          if (!isMissingPath(error)) complete = false;
        }
      }
    } catch (error) {
      if (!isMissingPath(error)) complete = false;
    }
  }

  if (pending.length > 0 || alreadyDiscovered + discovered.length >= MAX_DISCOVERED_SKILLS) complete = false;
  return { complete, skills: discovered };
}

function inferredScope(defaultScope: CodexSkillScope, relativeSkillPath: string): CodexSkillScope {
  if (defaultScope !== "codex_home") return defaultScope;
  const pathParts = relativeSkillPath.toLowerCase().split("/");
  return pathParts.some((part) => part === ".system" || part === ".curated" || part === "system")
    ? "system"
    : "codex_home";
}

async function readSkillMetadata(skillPath: string): Promise<SkillMetadata | null> {
  const fileStat = await stat(skillPath);
  if (!fileStat.isFile() || fileStat.size > MAX_SKILL_FILE_BYTES) return null;
  const contents = await readFile(skillPath, "utf8");
  const frontmatter = parseSkillFrontmatter(contents);
  if (!frontmatter) return null;
  const name = cleanText(frontmatter.name);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return null;
  return frontmatter;
}

function parseSkillFrontmatter(markdown: string): SkillMetadata | null {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) return null;

  const values = new Map<string, string>();
  let index = 1;
  while (index < endIndex) {
    const line = lines[index]!;
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1]!.toLowerCase();
    const value = match[2] ?? "";
    if (/^[|>][+-]?$/.test(value.trim())) {
      const blockLines: string[] = [];
      index += 1;
      while (index < endIndex && (/^\s/.test(lines[index]!) || lines[index]!.trim() === "")) {
        blockLines.push(lines[index]!.trim());
        index += 1;
      }
      values.set(key, cleanText(blockLines.join(" ")));
      continue;
    }
    values.set(key, parseYamlScalar(value));
    index += 1;
  }

  return Object.fromEntries(values) as SkillMetadata;
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function toDiscoveredSkill(
  scope: CodexSkillScope,
  scopeKey: string,
  sourceKey: string,
  metadata: SkillMetadata,
): DiscoveredCodexSkill {
  const skillName = cleanText(metadata.name)!;
  const descriptionEn = shortDescription(metadata.description_en || metadata.description || "");
  const nameEn = shortDescription(metadata.name_en || metadata.display_name_en || metadata.display_name || skillName);
  const nameZh = shortDescription(metadata.name_zh || metadata.display_name_zh || metadata.display_name || skillName);
  const descriptionZh = shortDescription(metadata.description_zh || descriptionEn);
  const id = createHash("sha256").update(scope + "\0" + scopeKey + "\0" + sourceKey).digest("hex");
  const sourceHash = createHash("sha256")
    .update([skillName, nameZh, nameEn, descriptionZh, descriptionEn].join("\0"))
    .digest("hex");
  return { id, scope, scopeKey, sourceKey, skillName, nameZh, nameEn, descriptionZh, descriptionEn, sourceHash };
}

function shortDescription(value: string): string {
  return cleanText(value).slice(0, MAX_DESCRIPTION_LENGTH);
}

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
