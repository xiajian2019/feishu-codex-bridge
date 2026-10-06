import { getLocalDraftScope } from "./local-draft-scope.js";

export type TaskCreateDraft = {
  version: 1;
  projectKey: string;
  description: string;
  hadStagedAttachments: boolean;
  updatedAt: number;
};

const DRAFT_PREFIX = "feishu-codex-bridge:task-create-draft:v2:";
const LEGACY_DRAFT_PREFIX = "feishu-codex-bridge:task-create-draft:v1:";
const LEGACY_LAST_PROJECT_KEY = "feishu-codex-bridge:task-create-draft:last-project:v1";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_DESCRIPTION_LENGTH = 20_000;

function scopedPrefix(): string | null {
  const scope = getLocalDraftScope();
  return scope ? `${DRAFT_PREFIX}${scope}:` : null;
}

function draftKey(projectKey: string): string | null {
  const prefix = scopedPrefix();
  return prefix ? prefix + encodeURIComponent(projectKey) : null;
}

function lastProjectKey(): string | null {
  const prefix = scopedPrefix();
  return prefix ? `${prefix}@last-project` : null;
}

function isLiveDraft(value: unknown, projectKey: string): value is TaskCreateDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Partial<TaskCreateDraft>;
  const age = Date.now() - Number(draft.updatedAt);
  return draft.version === 1
    && draft.projectKey === projectKey
    && typeof draft.description === "string"
    && typeof draft.hadStagedAttachments === "boolean"
    && Number.isFinite(draft.updatedAt)
    && age >= 0
    && age <= DRAFT_TTL_MS;
}

function pruneExpiredDrafts(): void {
  const prefix = scopedPrefix();
  if (!prefix) return;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === LEGACY_LAST_PROJECT_KEY || key?.startsWith(LEGACY_DRAFT_PREFIX)) {
        window.localStorage.removeItem(key);
        index -= 1;
        continue;
      }
      if (!key?.startsWith(prefix) || key === lastProjectKey()) continue;
      try {
        const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<TaskCreateDraft> | null;
        const age = Date.now() - Number(value?.updatedAt);
        if (!value || value.version !== 1 || typeof value.description !== "string"
          || typeof value.hadStagedAttachments !== "boolean" || !Number.isFinite(value.updatedAt)
          || age < 0 || age > DRAFT_TTL_MS) {
          window.localStorage.removeItem(key);
          index -= 1;
        }
      } catch {
        window.localStorage.removeItem(key);
        index -= 1;
      }
    }
  } catch {
    // Expiry cleanup is best effort when browser storage is unavailable.
  }
}

export function loadTaskCreateDraft(projectKey: string): TaskCreateDraft | null {
  const key = draftKey(projectKey);
  if (!key) return null;
  pruneExpiredDrafts();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isLiveDraft(value, projectKey)) {
      window.localStorage.removeItem(key);
      return null;
    }
    return { ...value, description: value.description.slice(0, MAX_DESCRIPTION_LENGTH) };
  } catch {
    try { window.localStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
    return null;
  }
}

export function saveTaskCreateDraft(projectKey: string, description: string, hadStagedAttachments: boolean): void {
  const key = draftKey(projectKey);
  const lastKey = lastProjectKey();
  if (!key || !lastKey) return;
  const normalizedDescription = description.slice(0, MAX_DESCRIPTION_LENGTH);
  if (!normalizedDescription && !hadStagedAttachments) {
    clearTaskCreateDraft(projectKey);
    return;
  }
  const draft: TaskCreateDraft = {
    version: 1,
    projectKey,
    description: normalizedDescription,
    hadStagedAttachments,
    updatedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
    window.localStorage.setItem(lastKey, projectKey);
  } catch {
    // Draft persistence is optional and must not block task creation.
  }
}

export function clearTaskCreateDraft(projectKey: string): void {
  const key = draftKey(projectKey);
  if (!key) return;
  try { window.localStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
}

export function clearAllTaskCreateDrafts(): void {
  const prefix = scopedPrefix();
  if (!prefix) return;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix) || key?.startsWith(LEGACY_DRAFT_PREFIX) || key === LEGACY_LAST_PROJECT_KEY) {
        window.localStorage.removeItem(key);
        index -= 1;
      }
    }
  } catch {
    // Draft cleanup is best effort when browser storage is unavailable.
  }
}

export function loadLastTaskCreateProjectKey(): string {
  const key = lastProjectKey();
  if (!key) return "";
  try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; }
}

export function rememberLastTaskCreateProjectKey(projectKey: string): void {
  const key = lastProjectKey();
  if (!projectKey || !key) return;
  try { window.localStorage.setItem(key, projectKey); } catch { /* Browser storage may be unavailable. */ }
}
