import { getLocalDraftScope } from "./local-draft-scope.js";

export type CodexHistoryDraftAttachment = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  lastModified: number;
};

export type CodexHistoryDraft = {
  version: 1;
  text: string;
  attachments: CodexHistoryDraftAttachment[];
  updatedAt: number;
};

export type CodexHistoryDraftFile = {
  id: string;
  file: File;
};

const DRAFT_PREFIX = "feishu-codex-bridge:codex-history-draft:v2:";
const LEGACY_DRAFT_PREFIX = "feishu-codex-bridge:codex-history-draft:v1:";
const DATABASE_NAME = "feishu-codex-bridge-codex-history-drafts";
const STORE_NAME = "attachments";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_DRAFT_TEXT_LENGTH = 8_000;

type StoredAttachment = {
  key: string;
  scopeKey: string;
  id: string;
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
  storedAt: number;
};

function metadataKey(scopeKey: string): string {
  return DRAFT_PREFIX + encodeURIComponent(scopeKey);
}

function attachmentKey(scopeKey: string, id: string): string {
  return `${encodeURIComponent(scopeKey)}:${encodeURIComponent(id)}`;
}

function isCurrentScope(scopeKey: string): boolean {
  const scope = getLocalDraftScope();
  return !!scope && scopeKey.startsWith(`${scope}|`);
}

function isDraftAttachment(value: unknown): value is CodexHistoryDraftAttachment {
  if (typeof value !== "object" || value === null) return false;
  const attachment = value as Partial<CodexHistoryDraftAttachment>;
  return typeof attachment.id === "string"
    && typeof attachment.name === "string"
    && typeof attachment.contentType === "string"
    && Number.isFinite(attachment.size)
    && Number(attachment.size) >= 0
    && Number.isFinite(attachment.lastModified);
}

function readMetadata(scopeKey: string): CodexHistoryDraft | null {
  if (!isCurrentScope(scopeKey)) return null;
  try {
    const raw = window.localStorage.getItem(metadataKey(scopeKey));
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<CodexHistoryDraft>;
    const age = Date.now() - Number(draft.updatedAt);
    if (draft.version !== 1 || typeof draft.text !== "string" || !Array.isArray(draft.attachments)
      || !Number.isFinite(draft.updatedAt) || age < 0 || age > DRAFT_TTL_MS) {
      window.localStorage.removeItem(metadataKey(scopeKey));
      return null;
    }
    return {
      version: 1,
      text: draft.text.slice(0, MAX_DRAFT_TEXT_LENGTH),
      attachments: draft.attachments.filter(isDraftAttachment).slice(0, 10),
      updatedAt: Number(draft.updatedAt),
    };
  } catch {
    try { window.localStorage.removeItem(metadataKey(scopeKey)); } catch { /* Browser storage may be unavailable. */ }
    return null;
  }
}

function pruneExpiredDraftMetadata(): void {
  const scope = getLocalDraftScope();
  if (!scope) return;
  const scopedPrefix = DRAFT_PREFIX + encodeURIComponent(`${scope}|`);
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(LEGACY_DRAFT_PREFIX)) {
        window.localStorage.removeItem(key);
        index -= 1;
        continue;
      }
      if (!key?.startsWith(scopedPrefix)) continue;
      try {
        const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<CodexHistoryDraft> | null;
        const age = Date.now() - Number(value?.updatedAt);
        if (!value || value.version !== 1 || typeof value.text !== "string" || !Array.isArray(value.attachments)
          || !Number.isFinite(value.updatedAt) || age < 0 || age > DRAFT_TTL_MS) {
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

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function pruneExpiredAttachments(database: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const stored = cursor.value as StoredAttachment;
      if (!isCurrentScope(stored.scopeKey)) {
        if (!/^[A-Za-z0-9_-]{32,128}\|/.test(stored.scopeKey)) cursor.delete();
        cursor.continue();
        return;
      }
      const referencedByLiveDraft = Number.isFinite(stored.storedAt)
        && readMetadata(stored.scopeKey)?.attachments.some((attachment) => attachment.id === stored.id) === true;
      if (!referencedByLiveDraft && (!Number.isFinite(stored.storedAt) || Date.now() - stored.storedAt > DRAFT_TTL_MS)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function loadCodexHistoryDraft(scopeKey: string): Promise<{ draft: CodexHistoryDraft | null; files: CodexHistoryDraftFile[] }> {
  if (!isCurrentScope(scopeKey)) return { draft: null, files: [] };
  pruneExpiredDraftMetadata();
  const draft = readMetadata(scopeKey);
  const database = await openDatabase();
  if (!database) return { draft, files: [] };
  await pruneExpiredAttachments(database);
  const files: CodexHistoryDraftFile[] = [];
  if (draft) {
    for (const attachment of draft.attachments) {
      const stored = await new Promise<StoredAttachment | undefined>((resolve) => {
        const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(attachmentKey(scopeKey, attachment.id));
        request.onsuccess = () => resolve(request.result as StoredAttachment | undefined);
        request.onerror = () => resolve(undefined);
      });
      if (!stored?.file) continue;
      try {
        files.push({ id: attachment.id, file: new File([stored.file], stored.name, { type: stored.type, lastModified: stored.lastModified }) });
      } catch {
        // Missing browser File support only drops the attachment, not the text draft.
      }
    }
  }
  database.close();
  return { draft, files };
}

async function saveAttachment(scopeKey: string, attachment: CodexHistoryDraftFile): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  const key = attachmentKey(scopeKey, attachment.id);
  const existing = await new Promise<StoredAttachment | undefined>((resolve) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as StoredAttachment | undefined);
    request.onerror = () => resolve(undefined);
  });
  if (existing?.name === attachment.file.name && existing.type === attachment.file.type
    && existing.file.size === attachment.file.size && existing.lastModified === attachment.file.lastModified) {
    database.close();
    return;
  }
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key,
      scopeKey,
      id: attachment.id,
      file: attachment.file,
      name: attachment.file.name,
      type: attachment.file.type,
      lastModified: attachment.file.lastModified,
      storedAt: Date.now(),
    } satisfies StoredAttachment);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

async function removeAttachments(scopeKey: string, ids?: Set<string>): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const stored = cursor.value as StoredAttachment;
      if (stored.scopeKey === scopeKey && (!ids || ids.has(stored.id))) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

export async function saveCodexHistoryDraft(scopeKey: string, text: string, files: CodexHistoryDraftFile[]): Promise<void> {
  if (!isCurrentScope(scopeKey)) return;
  const previous = readMetadata(scopeKey);
  const normalizedText = text.slice(0, MAX_DRAFT_TEXT_LENGTH);
  if (!normalizedText && files.length === 0) {
    clearCodexHistoryDraft(scopeKey);
    return;
  }
  const attachments = files.map(({ id, file }) => ({
    id,
    name: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified,
  }));
  const draft: CodexHistoryDraft = { version: 1, text: normalizedText, attachments, updatedAt: Date.now() };
  try {
    window.localStorage.setItem(metadataKey(scopeKey), JSON.stringify(draft));
  } catch {
    // Text drafts are best effort when browser storage is unavailable or full.
  }
  await Promise.all(files.map((attachment) => saveAttachment(scopeKey, attachment)));
  const liveIds = new Set(attachments.map(({ id }) => id));
  const staleIds = new Set((previous?.attachments ?? []).map(({ id }) => id).filter((id) => !liveIds.has(id)));
  if (staleIds.size > 0) await removeAttachments(scopeKey, staleIds);
}

export function clearCodexHistoryDraft(scopeKey: string): void {
  if (!isCurrentScope(scopeKey)) return;
  try { window.localStorage.removeItem(metadataKey(scopeKey)); } catch { /* Browser storage may be unavailable. */ }
  void removeAttachments(scopeKey);
}

export async function clearAllCodexHistoryDrafts(): Promise<void> {
  const scope = getLocalDraftScope();
  if (!scope) return;
  const scopedPrefix = DRAFT_PREFIX + encodeURIComponent(`${scope}|`);
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(scopedPrefix) && !key?.startsWith(LEGACY_DRAFT_PREFIX)) continue;
      window.localStorage.removeItem(key);
      index -= 1;
    }
  } catch {
    // Draft cleanup is best effort when browser storage is unavailable.
  }

  const database = await openDatabase().catch(() => null);
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const request = transaction.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const stored = cursor.value as StoredAttachment;
        if (stored.scopeKey.startsWith(`${scope}|`)
          || !/^[A-Za-z0-9_-]{32,128}\|/.test(stored.scopeKey)) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  database.close();
}
