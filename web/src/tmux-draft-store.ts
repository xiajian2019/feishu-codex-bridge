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

const DRAFT_PREFIX = "feishu-codex-bridge:tmux-draft:";
const DATABASE_NAME = "feishu-codex-bridge-tmux-drafts";
const STORE_NAME = "attachments";

type StoredAttachment = {
  key: string;
  sessionId: string;
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
};

function metadataKey(sessionId: string): string {
  return DRAFT_PREFIX + encodeURIComponent(sessionId);
}

function attachmentKey(sessionId: string, id: string): string {
  return encodeURIComponent(sessionId) + ":" + encodeURIComponent(id);
}

export function loadDraftMetadata(sessionId: string): TmuxDraft | null {
  try {
    const raw = localStorage.getItem(metadataKey(sessionId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<TmuxDraft>;
    if (draft.version !== 1 || typeof draft.text !== "string" || !Array.isArray(draft.attachments)) return null;
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

export function saveDraftMetadata(sessionId: string, draft: Omit<TmuxDraft, "version" | "updatedAt">): void {
  try {
    localStorage.setItem(metadataKey(sessionId), JSON.stringify({
      version: 1,
      text: draft.text,
      attachments: draft.attachments,
      updatedAt: Date.now(),
    } satisfies TmuxDraft));
  } catch {
    // Private browsing or a full storage quota should not block message entry.
  }
}

export function clearDraftMetadata(sessionId: string): void {
  try {
    localStorage.removeItem(metadataKey(sessionId));
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
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key: attachmentKey(sessionId, id),
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
  const database = await openDatabase();
  if (!database) return null;
  const stored = await new Promise<StoredAttachment | undefined>((resolve) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(attachmentKey(sessionId, id));
    request.onsuccess = () => resolve(request.result as StoredAttachment | undefined);
    request.onerror = () => resolve(undefined);
  });
  database.close();
  if (!stored?.file) return null;
  try {
    return new File([stored.file], stored.name, { type: stored.type, lastModified: stored.lastModified });
  } catch {
    return null;
  }
}

export async function clearDraftAttachments(sessionId: string): Promise<void> {
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
      if (value.sessionId === sessionId) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}
