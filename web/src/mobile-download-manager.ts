export type MobileDownloadState = "preparing" | "queued" | "downloading" | "paused" | "saving" | "sharing" | "done" | "error";
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
  return task.state !== "done" && task.state !== "error";
}

/** App-wide state, independent of routes. Never retains URLs or credentials. */
export function createMobileDownloadManager() {
  let tasks: MobileDownloadTask[] = [];
  let sequence = 0;
  let refreshing: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const nativeTasks = new Map<number, string>();
  const publish = (next: MobileDownloadTask[]): void => {
    tasks = next;
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
    getSnapshot: (): MobileDownloadTask[] => tasks,
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: (fileName: string, destination: MobileDownloadTask["destination"]): string => {
      const id = String(++sequence);
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
      nativeTasks.set(nativeId, id);
      update(id, { state: "queued", savedName, message: "等待系统开始下载" });
    },
    hasAndroidDownloads: (): boolean => nativeTasks.size > 0,
    refreshAndroid: (query: QueryMobileDownloads): Promise<void> => {
      if (refreshing) return refreshing;
      if (!nativeTasks.size) return Promise.resolve();
      const current = new Map(nativeTasks);
      refreshing = (async () => {
        try {
          const { downloads } = await query([...current.keys()]);
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
          for (const id of current.values()) update(id, { state: "paused", message: "暂时无法读取进度，系统下载仍可能继续；正在重试。" });
        }
      })().finally(() => { refreshing = null; });
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
