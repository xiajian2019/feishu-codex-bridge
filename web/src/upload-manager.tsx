import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { uploadToDownloads, type DownloadUploadPhase, type DownloadUploadResult, type UploadMetric } from "./download-upload.js";
import { logDebugDiagnostic } from "./debug-log-capture.js";
import { copyMobileText, isMobileApp } from "./mobile-runtime.js";
import "./upload-manager.css";
import { isAppForeground } from "./foreground-polling.js";

export type GlobalUploadState = DownloadUploadPhase | "queued" | "done" | "error" | "cancelled";
export type GlobalUploadTask = {
  id: number;
  file: File;
  state: GlobalUploadState;
  sent: number;
  result?: DownloadUploadResult;
  error?: string;
};

type UploadManagerValue = {
  tasks: GlobalUploadTask[];
  addFiles: (files: FileList | File[]) => void;
  startPending: () => Promise<void>;
  cancel: () => void;
  remove: (id: number) => void;
  clearFinished: () => void;
  copyPath: (task: GlobalUploadTask) => Promise<void>;
  copiedTaskId: number | null;
  copyError: string | null;
};

const UploadManagerContext = createContext<UploadManagerValue | null>(null);
let sequence = 0;

export function UploadManagerProvider({ children }: { children: ReactNode }): ReactElement {
  const [tasks, setTasks] = useState<GlobalUploadTask[]>([]);
  const [notice, setNotice] = useState<{ fileName: string; taskId: number } | null>(null);
  const [copiedTaskId, setCopiedTaskId] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const tasksRef = useRef(tasks);
  const runningRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  tasksRef.current = tasks;

  const patchTask = useCallback((id: number, patch: Partial<GlobalUploadTask>): void => {
    setTasks((current) => {
      const next = current.map((task) => task.id === id ? { ...task, ...patch } : task);
      tasksRef.current = next;
      return next;
    });
  }, []);

  const addFiles = useCallback((files: FileList | File[]): void => {
    const additions = Array.from(files, (file): GlobalUploadTask => ({
      id: ++sequence, file, state: "queued", sent: 0,
    }));
    if (!additions.length) return;
    setTasks((current) => {
      const next = [...current, ...additions];
      tasksRef.current = next;
      return next;
    });
  }, []);

  const prepareSystemNotification = useCallback((): void => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    void Notification.requestPermission().catch(() => {});
  }, []);

  const showCompletedNotification = useCallback((task: GlobalUploadTask): void => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification("文件上传完成", { body: `${task.file.name} 已保存到 Mac 的 Downloads。`, tag: `bridge-upload-${task.id}` });
      } catch { /* The in-app notice below remains available. */ }
    }
    window.dispatchEvent(new CustomEvent("bridge:upload-complete", { detail: { fileName: task.file.name, taskId: task.id } }));
    setNotice({ fileName: task.file.name, taskId: task.id });
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 8_000);
  }, []);

  const startPending = useCallback(async (): Promise<void> => {
    if (runningRef.current) return;
    if (isMobileApp() && !isAppForeground()) return;
    const pending = tasksRef.current.filter((task) => ["queued", "error", "cancelled"].includes(task.state));
    if (!pending.length) return;
    prepareSystemNotification();
    runningRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      for (const task of pending) {
        if (controller.signal.aborted) break;
        patchTask(task.id, { state: "preparing", sent: 0, error: undefined });
        try {
          const result = await uploadToDownloads(task.file, {
            parallel: true,
            signal: controller.signal,
            onPhase: (state) => patchTask(task.id, { state }),
            onProgress: (sent, saving) => patchTask(task.id, { sent, state: saving ? "saving" : "uploading" }),
            onMetric: (metric: UploadMetric) => logDebugDiagnostic("file-upload", metric.type, { taskId: task.id, ...metric }),
          });
          const completed = { ...task, state: "done" as const, sent: task.file.size, result };
          patchTask(task.id, completed);
          showCompletedNotification(completed);
        } catch (error) {
          patchTask(task.id, {
            state: controller.signal.aborted ? "cancelled" : "error",
            error: controller.signal.aborted ? controller.signal.reason instanceof Error ? controller.signal.reason.message : "上传已取消。" : error instanceof Error ? error.message : "上传失败，请重试。",
          });
          if (controller.signal.aborted) break;
        }
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      runningRef.current = false;
    }
  }, [patchTask, prepareSystemNotification, showCompletedNotification]);

  const cancel = useCallback((): void => { controllerRef.current?.abort(); }, []);
  useEffect(() => {
    if (!isMobileApp()) return;
    const pause = (): void => {
      if (!isAppForeground()) controllerRef.current?.abort(new Error("App 已进入后台，本次上传结果未确认；请回前台检查 Mac 的 Downloads 后再手动重试。"));
    };
    window.addEventListener("bridge:foreground-change", pause);
    document.addEventListener("visibilitychange", pause);
    return () => { window.removeEventListener("bridge:foreground-change", pause); document.removeEventListener("visibilitychange", pause); };
  }, []);

  const remove = useCallback((id: number): void => {
    if (tasksRef.current.some((task) => task.id === id && ["uploading", "reading", "confirming", "saving", "creating", "preparing"].includes(task.state))) return;
    setTasks((current) => {
      const next = current.filter((task) => task.id !== id);
      tasksRef.current = next;
      return next;
    });
  }, []);

  const clearFinished = useCallback((): void => {
    setTasks((current) => {
      const next = current.filter((task) => task.state !== "done");
      tasksRef.current = next;
      return next;
    });
  }, []);

  const copyPath = useCallback(async (task: GlobalUploadTask): Promise<void> => {
    if (!task.result) return;
    setCopyError(null);
    try {
      await copyUploadPath(task.result.filePath);
      setCopiedTaskId(task.id);
    } catch (error) { setCopyError(error instanceof Error ? error.message : "复制失败。"); }
  }, []);

  useEffect(() => () => { if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current); controllerRef.current?.abort(); }, []);

  const value = useMemo(() => ({ tasks, addFiles, startPending, cancel, remove, clearFinished, copyPath, copiedTaskId, copyError }),
    [tasks, addFiles, startPending, cancel, remove, clearFinished, copyPath, copiedTaskId, copyError]);
  return <UploadManagerContext.Provider value={value}>
    {children}
    <GlobalUploadStatus tasks={tasks} notice={notice} onCancel={cancel} />
  </UploadManagerContext.Provider>;
}

async function copyUploadPath(value: string): Promise<void> {
  if (isMobileApp()) return copyMobileText(value);
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Use the DOM fallback below. */ }
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;font-size:16px";
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    if (!document.execCommand("copy")) throw new Error("此浏览器无法访问剪贴板。");
  } finally { field.remove(); }
}

export function useUploadManager(): UploadManagerValue {
  const value = useContext(UploadManagerContext);
  if (!value) throw new Error("useUploadManager must be used inside UploadManagerProvider.");
  return value;
}

function GlobalUploadStatus({ tasks, notice, onCancel }: { tasks: GlobalUploadTask[]; notice: { fileName: string; taskId: number } | null; onCancel: () => void }): ReactElement | null {
  const active = tasks.find((task) => !["queued", "done", "error", "cancelled"].includes(task.state));
  const queued = tasks.filter((task) => task.state === "queued").length;
  const current = active;
  if (!current && !notice) return null;
  if (!current && notice) return <div className="upload-manager-notice" role="status" aria-live="polite">
    <strong>上传完成</strong><span>{notice.fileName} 已保存到 Mac。</span>
  </div>;
  if (!current) return null;
  const percent = current.file.size > 0 ? Math.floor(current.sent / current.file.size * 100) : 0;
  return <div className="upload-manager-status" role="status" aria-live="polite">
    <strong>正在上传</strong><span title={current.file.name}>{current.file.name}</span>
    {isMobileApp() ? <small>上传期间请保持 App 在前台；中断后需手动确认并重试。</small> : null}
    <progress max={current.file.size || 1} value={Math.min(current.sent, current.file.size || 1)} aria-label={`${current.file.name} 上传进度`} />
    <small>{percent}% · {uploadManagerPhaseText(current.state)}{queued ? ` · 还有 ${queued} 个` : ""}</small>
    <button type="button" onClick={onCancel} disabled={current.state === "saving"}>取消</button>
  </div>;
}

function uploadManagerPhaseText(state: GlobalUploadState): string {
  switch (state) {
    case "preparing": return "准备中";
    case "creating": return "创建任务";
    case "reading": return "读取文件";
    case "uploading": return "上传中";
    case "confirming": return "Mac 正在写入";
    case "saving": return "保存中";
    default: return "处理中";
  }
}
