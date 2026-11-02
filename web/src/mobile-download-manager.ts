export type MobileDownloadState = "preparing" | "queued" | "downloading" | "paused" | "saving" | "sharing" | "done" | "error" | "cancelled";
export type MobileDownloadTask = {
  id: string;
  fileName: string;
  state: MobileDownloadState;
  downloadedBytes: number;
  totalBytes: number | null;
  savedName?: string;
  message?: string;
  destination: "downloads" | "share" | "browser" | "installer";
  updatedAt: number;
  nativeId?: number;
};
export type NativeDownloadStatus = {
  id: number;
  fileName: string;
  state: "queued" | "downloading" | "paused" | "done" | "error";
  downloadedBytes: number;
  totalBytes: number;
  reason?: string;
};
export type QueryMobileDownloads = (ids: number[]) => Promise<{ downloads: NativeDownloadStatus[] }>;

export function isMobileDownloadActive(task: MobileDownloadTask): boolean {
  return task.state !== "done" && task.state !== "error" && task.state !== "cancelled";
}

/** App-wide state, independent of routes. Never retains URLs or credentials. */
export function createMobileDownloadManager() {
  let tasks: MobileDownloadTask[] = [];
  let sequence = 0;
  let refreshing: Promise<void> | null = null;
  let storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = null;
  let storageKey: string | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const nativeTasks = new Map<number, string>();
  const publish = (next: MobileDownloadTask[]): void => {
    tasks = next;
    if (storage && storageKey) {
      // Only explicitly selected fields cross process restarts. URLs and credentials never do.
      try { storage.setItem(storageKey, JSON.stringify({ version: 1, tasks: next.slice(-200).map((task) => ({
        id: task.id, fileName: task.fileName, state: task.state, destination: task.destination,
        nativeId: task.nativeId, savedName: task.savedName, updatedAt: task.updatedAt,
        downloadedBytes: task.downloadedBytes, totalBytes: task.totalBytes,
      })) })); } catch { /* System downloads continue if local storage is unavailable. */ }
    }
    for (const listener of listeners) listener();
  };
  const update = (id: string, patch: Partial<Omit<MobileDownloadTask, "id">>): void => {
    publish(tasks.map((task) => {
      if (task.id !== id || !isMobileDownloadActive(task)) return task;
      const next = { ...task, ...patch, updatedAt: Date.now() };
      next.downloadedBytes = finiteBytes(next.downloadedBytes);
      next.totalBytes = next.totalBytes !== null && Number.isFinite(next.totalBytes) && next.totalBytes > 0 ? next.totalBytes : null;
      // A final progress event is not confirmation that the file was saved.
      return next;
    }));
  };
  return {
    restore(nextStorage: typeof storage, key: string | null): void {
      if (storageKey === key && storage === nextStorage) return;
      generation += 1; refreshing = null; nativeTasks.clear();
      storage = nextStorage; storageKey = key;
      const restored: MobileDownloadTask[] = [];
      try {
        const raw = key && storage ? storage.getItem(key) : null;
        const saved = raw && raw.length <= 300_000 ? JSON.parse(raw) as { version?: number; tasks?: unknown[] } : null;
        if (saved?.version === 1 && Array.isArray(saved.tasks)) for (const value of saved.tasks.slice(-200)) {
          if (!value || typeof value !== "object") continue;
          const row = value as Partial<MobileDownloadTask>;
          if (typeof row.id !== "string" || row.id.length > 100 || typeof row.fileName !== "string" || row.fileName.length > 200
            || !["downloads", "share", "browser", "installer"].includes(row.destination ?? "")
            || !["preparing", "queued", "downloading", "paused", "saving", "sharing", "done", "error", "cancelled"].includes(row.state ?? "")
            || !Number.isFinite(row.updatedAt) || row.updatedAt! > Date.now() || Date.now() - row.updatedAt! > 7 * 86_400_000) continue;
          const nativeId = Number.isSafeInteger(row.nativeId) && row.nativeId! > 0 ? row.nativeId : undefined;
          const active = isMobileDownloadActive(row as MobileDownloadTask);
          const task: MobileDownloadTask = {
            id: row.id, fileName: row.fileName, destination: row.destination!, nativeId,
            state: active ? nativeId ? "paused" : "error" : row.state!,
            downloadedBytes: finiteBytes(row.downloadedBytes ?? 0), totalBytes: Number.isFinite(row.totalBytes) && row.totalBytes! > 0 ? row.totalBytes! : null,
            savedName: typeof row.savedName === "string" ? row.savedName.slice(0, 200) : undefined, updatedAt: row.updatedAt!,
            message: active ? nativeId ? "正在重新查询系统下载结果。" : "上次前台传输已中断，请回原页面重新下载。" : undefined,
          };
          if (restored.some((existing) => existing.id === task.id || nativeId && existing.nativeId === nativeId)) continue;
          restored.push(task);
          if (nativeId && active) nativeTasks.set(nativeId, task.id);
        }
      } catch { /* Ignore invalid metadata; never infer that a file was saved. */ }
      publish(restored);
    },
    clearScope(): void {
      try { if (storageKey) storage?.removeItem(storageKey); } catch { /* best effort */ }
      storageKey = null; storage = null; generation += 1; refreshing = null; nativeTasks.clear(); publish([]);
    },
    getSnapshot: (): MobileDownloadTask[] => tasks,
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: (fileName: string, destination: MobileDownloadTask["destination"]): string => {
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`;
      // Bound completed history while preserving every active transfer.
      const finished = tasks.filter((task) => !isMobileDownloadActive(task)).slice(-19);
      publish([...tasks.filter(isMobileDownloadActive), ...finished, {
        id, fileName, destination, state: "preparing", downloadedBytes: 0, totalBytes: null, updatedAt: Date.now(),
      }]);
      return id;
    },
    update,
    fail: (id: string, cause: unknown): void => {
      const message = cause instanceof Error ? cause.message : typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message) : "下载失败，请检查网络和存储空间后重试。";
      update(id, { state: "error", message });
    },
    dismiss: (id: string): void => { publish(tasks.filter((task) => task.id !== id || isMobileDownloadActive(task))); },
    clearFinished: (): void => { publish(tasks.filter(isMobileDownloadActive)); },
    trackAndroid: (id: string, nativeId: number, savedName: string): void => {
      if (!tasks.some((task) => task.id === id && isMobileDownloadActive(task))) return;
      nativeTasks.set(nativeId, id);
      update(id, { state: "queued", nativeId, savedName, message: "等待系统开始下载" });
    },
    cancelAndroid(id: string): void {
      const task = tasks.find((item) => item.id === id);
      if (!task?.nativeId || !isMobileDownloadActive(task)) return;
      nativeTasks.delete(task.nativeId);
      update(id, { state: "cancelled", message: "系统下载已取消。重新下载请回原页面操作。" });
    },
    hasAndroidDownloads: (): boolean => nativeTasks.size > 0,
    refreshAndroid: (query: QueryMobileDownloads): Promise<void> => {
      if (refreshing) return refreshing;
      if (!nativeTasks.size) return Promise.resolve();
      const current = new Map(nativeTasks);
      const version = generation;
      refreshing = (async () => {
        try {
          const { downloads } = await query([...current.keys()]);
          if (generation !== version) return;
          for (const [nativeId, id] of current) {
            const result = downloads.find((download) => download.id === nativeId);
            if (!result) {
              update(id, { state: "error", message: "系统中已找不到此下载，可能已被取消或删除，请重新下载。" });
              nativeTasks.delete(nativeId);
              continue;
            }
            update(id, {
              state: result.state,
              downloadedBytes: result.downloadedBytes,
              totalBytes: result.totalBytes,
              ...(result.fileName ? { savedName: result.fileName } : {}),
              message: result.state === "done" ? "已保存到系统 Downloads" : result.reason,
            });
            if (result.state === "done" || result.state === "error") nativeTasks.delete(nativeId);
          }
        } catch {
          // A status-query failure does not mean the OS download has failed.
          if (generation === version) for (const id of current.values()) update(id, { state: "paused", message: "暂时无法读取进度，系统下载仍可能继续；正在重试。" });
        }
      })().finally(() => { if (generation === version) refreshing = null; });
      return refreshing;
    },
  };
}

function finiteBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const manager = createMobileDownloadManager();
export const getMobileDownloads = manager.getSnapshot;
export const subscribeMobileDownloads = manager.subscribe;
export const startMobileDownload = manager.start;
export const updateMobileDownload = manager.update;
export const failMobileDownload = manager.fail;
export const dismissMobileDownload = manager.dismiss;
export const clearFinishedMobileDownloads = manager.clearFinished;
export const trackAndroidMobileDownload = manager.trackAndroid;
export const hasAndroidMobileDownloads = manager.hasAndroidDownloads;
export const refreshAndroidMobileDownloads = manager.refreshAndroid;
export const restoreMobileDownloads = manager.restore;
export const clearMobileDownloadScope = manager.clearScope;
export const cancelAndroidMobileDownload = manager.cancelAndroid;
