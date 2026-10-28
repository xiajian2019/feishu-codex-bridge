import { getLocalDraftScope, scopedStorageKey } from "./local-draft-scope.js";

export type DraftAttachment = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  lastModified: number;
};

export type TmuxDraft = {
  version: 1;
  text: string;
  attachments: DraftAttachment[];
  updatedAt: number;
};

const DATABASE_NAME = "feishu-codex-bridge-tmux-drafts";
const STORE_NAME = "attachments";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type StoredAttachment = {
  key: string;
  scope: string;
  storedAt: number;
  sessionId: string;
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
};

function metadataKey(sessionId: string): string | null {
  return scopedStorageKey("tmux-draft", sessionId);
}

function attachmentPrefix(sessionId?: string): string | null {
  return scopedStorageKey("tmux-attachment", sessionId === undefined ? "" : JSON.stringify(sessionId))?.concat(sessionId === undefined ? "" : ":") ?? null;
}

function attachmentKey(sessionId: string, id: string): string | null {
  const prefix = attachmentPrefix(sessionId);
  return prefix ? prefix + encodeURIComponent(id) : null;
}

export function loadDraftMetadata(sessionId: string): TmuxDraft | null {
  const key = metadataKey(sessionId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<TmuxDraft>;
    const age = Date.now() - Number(draft.updatedAt);
    if (draft.version !== 1 || typeof draft.text !== "string" || !Array.isArray(draft.attachments)
      || !Number.isFinite(draft.updatedAt) || age < 0 || age > DRAFT_TTL_MS) {
      window.localStorage.removeItem(key);
      void clearDraftAttachments(sessionId);
      return null;
    }
    return {
      version: 1,
      text: draft.text,
      attachments: draft.attachments.filter((attachment): attachment is DraftAttachment => (
        typeof attachment === "object"
        && attachment !== null
        && typeof attachment.id === "string"
        && typeof attachment.name === "string"
        && typeof attachment.contentType === "string"
        && Number.isFinite(attachment.size)
        && Number.isFinite(attachment.lastModified)
      )),
      updatedAt: Number.isFinite(draft.updatedAt) ? Number(draft.updatedAt) : 0,
    };
  } catch {
    return null;
  }
}

export function saveDraftMetadata(sessionId: string, draft: Omit<TmuxDraft, "version" | "updatedAt">, expectedScope = getLocalDraftScope()): void {
  if (expectedScope !== getLocalDraftScope()) return;
  const key = metadataKey(sessionId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({
      version: 1,
      text: draft.text,
      attachments: draft.attachments,
      updatedAt: Date.now(),
    } satisfies TmuxDraft));
  } catch {
    // Private browsing or a full storage quota should not block message entry.
  }
}

export function clearDraftMetadata(sessionId: string, expectedScope = getLocalDraftScope()): void {
  if (expectedScope !== getLocalDraftScope()) return;
  const key = metadataKey(sessionId);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore unavailable local storage.
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function saveDraftAttachment(sessionId: string, id: string, file: File): Promise<void> {
  const key = attachmentKey(sessionId, id);
  const scope = getLocalDraftScope();
  if (!key || !scope) return;
  const database = await openDatabase();
  if (!database) return;
  if (scope !== getLocalDraftScope()) { database.close(); return; }
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key, scope, storedAt: Date.now(),
      sessionId,
      file,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
    } satisfies StoredAttachment);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

export async function loadDraftAttachment(sessionId: string, id: string): Promise<File | null> {
  const key = attachmentKey(sessionId, id);
  const scope = getLocalDraftScope();
  if (!key || !scope) return null;
  const database = await openDatabase();
  if (!database) return null;
  const stored = await new Promise<StoredAttachment | undefined>((resolve) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as StoredAttachment | undefined);
    request.onerror = () => resolve(undefined);
  });
  database.close();
  if (!stored?.file || stored.scope !== scope || getLocalDraftScope() !== scope
    || !Number.isFinite(stored.storedAt) || Date.now() < stored.storedAt || Date.now() - stored.storedAt > DRAFT_TTL_MS) return null;
  try {
    return new File([stored.file], stored.name, { type: stored.type, lastModified: stored.lastModified });
  } catch {
    return null;
  }
}

export async function clearDraftAttachments(sessionId: string): Promise<void> {
  const prefix = attachmentPrefix(sessionId);
  if (!prefix) return;
  await removeStoredAttachments((value) => value.key.startsWith(prefix));
}

/** Called before resetting auth scope; capture it before opening IndexedDB. */
export async function clearAllTmuxDrafts(): Promise<void> {
  const prefix = attachmentPrefix();
  await removeStoredAttachments((value) => Boolean(prefix && value.key.startsWith(prefix)) || !value.scope);
}

async function removeStoredAttachments(matches: (value: StoredAttachment) => boolean): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result as IDBCursorWithValue | null;
      if (!cursor) return;
      const value = cursor.value as StoredAttachment;
      if (matches(value)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}
