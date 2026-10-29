import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import {
  clearFinishedMobileDownloads, dismissMobileDownload, getMobileDownloads, isMobileDownloadActive,
  subscribeMobileDownloads, type MobileDownloadTask,
} from "./mobile-download-manager.js";
import { openMobileDownloads } from "./mobile-native.js";
import "./mobile-download-status.css";

const stateLabels: Record<MobileDownloadTask["state"], string> = {
  preparing: "正在准备", queued: "等待下载", downloading: "正在下载", paused: "下载已暂停",
  saving: "正在保存", sharing: "正在打开分享", done: "下载完成", error: "下载失败",
};

function stateLabel(task: MobileDownloadTask): string {
  if (task.state === "done" && task.destination === "share") return "文件已下载";
  if (task.state === "done" && task.destination === "downloads") return "已保存到系统下载";
  if (task.state === "done" && task.destination === "browser") return "已交给浏览器下载";
  if (task.state === "done" && task.destination === "installer") return "安装包已下载";
  return stateLabels[task.state];
}

function formatBytes(value: number): string {
  const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
}

function progressPercent(task: MobileDownloadTask): number | null {
  if (task.totalBytes === null || !Number.isFinite(task.totalBytes) || task.totalBytes < 0) return null;
  if (task.totalBytes === 0) return task.state === "done" ? 100 : 0;
  return Math.min(100, Math.max(0, Math.floor(task.downloadedBytes / task.totalBytes * 100)));
}

function DownloadIcon(): ReactElement {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></svg>;
}

function Chevron({ collapsed }: { collapsed: boolean }): ReactElement {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={collapsed ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6"} /></svg>;
}

export default function MobileDownloadStatus(): ReactElement {
  const tasks = useSyncExternalStore(subscribeMobileDownloads, getMobileDownloads, getMobileDownloads);
  const [collapsed, setCollapsed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingDownloads, setOpeningDownloads] = useState(false);
  const previousTasks = useRef(new Map<string, MobileDownloadTask["state"]>());

  useEffect(() => {
    const previous = previousTasks.current;
    const transitions = tasks.filter((task) => previous.get(task.id) !== task.state);
    if (tasks.some((task) => !previous.has(task.id))) setCollapsed(false);
    if (transitions.length) setAnnouncement(transitions.map((task) => `${task.fileName}：${stateLabel(task)}${task.message ? `，${task.message}` : ""}`).join("；"));
    previousTasks.current = new Map(tasks.map((task) => [task.id, task.state]));
  }, [tasks]);

  const activeCount = tasks.filter(isMobileDownloadActive).length;
  const errorCount = tasks.filter((task) => task.state === "error").length;
  const finishedCount = tasks.length - activeCount;
  const summary = activeCount ? `下载 · ${activeCount} 项待完成` : errorCount ? `下载 · ${errorCount} 项失败` : `下载完成 · ${tasks.length} 项`;
  const hasSystemDownload = tasks.some((task) => task.destination === "downloads");

  async function showSystemDownloads(): Promise<void> {
    if (openingDownloads) return;
    setOpeningDownloads(true);
    setOpenError(null);
    try { await openMobileDownloads(); }
    catch (cause) { setOpenError(cause instanceof Error ? cause.message : "无法打开系统下载，请从系统文件管理器查看。"); }
    finally { setOpeningDownloads(false); }
  }

  return <>
    <span className="mobile-download-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {tasks.length > 0 && <section className={`mobile-download-status${collapsed ? " is-collapsed" : ""}`} aria-label="下载任务">
      <div className="mobile-download-header">
        <button type="button" className="mobile-download-heading" aria-expanded={!collapsed} aria-controls={collapsed ? undefined : "mobile-download-list"} onClick={() => setCollapsed((value) => !value)}>
          <DownloadIcon /><span>{collapsed ? summary : "下载任务"}</span>
          {!collapsed && <small>{activeCount ? `${activeCount} 项待完成` : `${tasks.length} 项`}</small>}
          <Chevron collapsed={collapsed} />
        </button>
        {!collapsed && finishedCount > 0 && <button type="button" className="mobile-download-clear" onClick={clearFinishedMobileDownloads}>清除已结束</button>}
      </div>
      {!collapsed && <>
        <ul className="mobile-download-list" id="mobile-download-list">
          {tasks.map((task) => {
            const active = isMobileDownloadActive(task);
            const percent = progressPercent(task);
            const bytes = `${formatBytes(task.downloadedBytes)}${task.totalBytes !== null && Number.isFinite(task.totalBytes) && task.totalBytes >= 0 ? ` / ${formatBytes(task.totalBytes)}` : ""}`;
            return <li key={task.id} className={`mobile-download-item is-${task.state}`}>
              <div className="mobile-download-item-heading">
                <span className="mobile-download-name" title={task.fileName}>{task.fileName}</span>
                {!active && <button type="button" className="mobile-download-dismiss" aria-label={`移除 ${task.fileName} 的下载记录`} onClick={() => dismissMobileDownload(task.id)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>}
              </div>
              <div className="mobile-download-metrics"><strong>{stateLabel(task)}</strong><span>{percent !== null ? `${percent}% · ` : ""}{bytes}</span></div>
              {active && <progress className="mobile-download-progress" max={100} value={percent ?? undefined} aria-label={`${task.fileName} 下载进度`} aria-valuetext={percent === null ? `${stateLabel(task)}，已下载 ${formatBytes(task.downloadedBytes)}，总大小未知` : `${percent}%，${bytes}`} />}
              {task.savedName && task.savedName !== task.fileName && <p className="mobile-download-saved-name">保存为：{task.savedName}</p>}
              {task.message && <p className="mobile-download-message">{task.message}</p>}
            </li>;
          })}
        </ul>
        {hasSystemDownload && <div className="mobile-download-footer"><button type="button" onClick={() => { void showSystemDownloads(); }} disabled={openingDownloads}>{openingDownloads ? "正在打开…" : "打开系统下载"}</button>{openError && <p role="alert">{openError}</p>}</div>}
      </>}
    </section>}
  </>;
}
