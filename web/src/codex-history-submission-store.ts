import { getLocalDraftScope } from "./local-draft-scope.js";

export interface PendingCodexHistorySubmission {
  version: 1;
  signature: string;
  idempotencyKey: string;
  attachmentIds: string[];
  turnIndex: number;
  updatedAt: number;
}

const PREFIX = "feishu-codex-bridge:codex-history-submission:v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function key(scopeKey: string): string {
  return PREFIX + encodeURIComponent(scopeKey);
}

function isCurrentScope(scopeKey: string): boolean {
  const scope = getLocalDraftScope();
  return !!scope && scopeKey.startsWith(`${scope}|`);
}

export function loadPendingCodexHistorySubmission(scopeKey: string): PendingCodexHistorySubmission | null {
  if (!isCurrentScope(scopeKey)) return null;
  try {
    const raw = window.localStorage.getItem(key(scopeKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingCodexHistorySubmission>;
    const age = Date.now() - Number(value.updatedAt);
    if (value.version === 1 && typeof value.signature === "string"
      && typeof value.idempotencyKey === "string" && value.idempotencyKey.length > 0
      && value.idempotencyKey.length <= 200
      && Array.isArray(value.attachmentIds) && value.attachmentIds.every((id) => typeof id === "string")
      && Number.isSafeInteger(value.turnIndex) && Number(value.turnIndex) >= 0
      && Number.isFinite(value.updatedAt) && age >= 0 && age <= MAX_AGE_MS) {
      return value as PendingCodexHistorySubmission;
    }
    window.localStorage.removeItem(key(scopeKey));
  } catch {
    // Submission recovery is best effort when storage is unavailable.
  }
  return null;
}

export function savePendingCodexHistorySubmission(scopeKey: string, pending: PendingCodexHistorySubmission): void {
  if (!isCurrentScope(scopeKey)) return;
  try { window.localStorage.setItem(key(scopeKey), JSON.stringify(pending)); } catch { /* Best effort. */ }
}

export function clearPendingCodexHistorySubmission(scopeKey: string): void {
  if (!isCurrentScope(scopeKey)) return;
  try { window.localStorage.removeItem(key(scopeKey)); } catch { /* Best effort. */ }
}

export function clearAllPendingCodexHistorySubmissions(): void {
  const scope = getLocalDraftScope();
  if (!scope) return;
  const prefix = PREFIX + encodeURIComponent(`${scope}|`);
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const entry = window.localStorage.key(index);
      if (!entry?.startsWith(prefix)) continue;
      window.localStorage.removeItem(entry);
      index -= 1;
    }
  } catch {
    // Best effort.
  }
}
