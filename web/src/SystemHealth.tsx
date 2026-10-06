import { useCallback, useEffect, useState, type ReactElement } from "react";

import { getJson } from "./api.js";

export interface SystemHealthSnapshot {
  generatedAt: string;
  mode: string;
  version: string;
  database: { available: boolean; sizeBytes: number | null };
  dependencies: { configuredCodexCli: "available" | "unavailable" | "unknown"; feishuNetwork: "not_checked" };
  tasks: {
    desk: Record<string, number>;
    direct: Record<string, number>;
    aamp: Record<string, number>;
    oldestDeskQueuedAt: string | null;
    oldestDirectQueuedAt: string | null;
    oldestAampPendingAt: string | null;
  };
  runtimeLease: { state: "active" | "expired" | "absent"; expiresAt: string | null };
  outbox: { pending: number; due: number; delivered: number; deliveryFailedCards: number };
  storage: {
    webStaged: { count: number; bytes: number; expiredCount: number; expiredBytes: number };
    webBound: { count: number; bytes: number };
    directDownloadedCount: number;
    historyRetained: { count: number; declaredBytes: number; truncated: boolean };
    aampReferencedImageCount: number;
    aampReferenceScanTruncated: boolean;
  };
  recentErrors: Array<{ source: "desk" | "direct" | "aamp"; id: string; message: string; updatedAt: string }>;
}

function formatTime(value: string | null): string {
  if (!value) return "无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function countText(counts: Record<string, number>): string {
  return Object.entries(counts).filter(([, value]) => value > 0).map(([state, value]) => `${state} ${value}`).join(" · ") || "无任务";
}

export function SystemHealth(): ReactElement {
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setSnapshot(await getJson<SystemHealthSnapshot>("/api/system/health"));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return <main className="page-main system-health-page">
    <header className="project-management-header">
      <h1>运行状态</h1>
      <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="刷新运行状态">↻</button>
    </header>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {loading && !snapshot ? <p className="muted">正在读取运行状态…</p> : null}
    {snapshot ? <>
      <p className="muted">更新时间：{formatTime(snapshot.generatedAt)}。此页只读取状态；任务执行失败与通知投递积压分别显示。</p>
      <section aria-labelledby="health-runtime-title">
        <h2 id="health-runtime-title">服务与存储</h2>
        <dl>
          <div><dt>运行模式</dt><dd>{snapshot.mode}</dd></div>
          <div><dt>版本</dt><dd>{snapshot.version}</dd></div>
          <div><dt>数据库</dt><dd>{snapshot.database.available ? "可读取" : "不可读取"}{snapshot.database.sizeBytes === null ? "" : ` · ${(snapshot.database.sizeBytes / 1024 / 1024).toFixed(1)} MiB`}</dd></div>
          <div><dt>已配置 Codex CLI</dt><dd>{snapshot.dependencies.configuredCodexCli === "available" ? "可执行" : snapshot.dependencies.configuredCodexCli === "unavailable" ? "不可执行" : "未配置路径"}</dd></div>
          <div><dt>飞书网络</dt><dd>未主动探测；请结合租约和投递积压判断</dd></div>
          <div><dt>Direct 租约</dt><dd>{snapshot.mode === "feishu-sqlite-codex" || snapshot.mode === "feishu-sqlite-acp"
            ? snapshot.runtimeLease.state === "active" ? "活动" : snapshot.runtimeLease.state === "expired" ? "已过期" : "无租约"
            : "当前模式不适用"}{snapshot.runtimeLease.expiresAt ? ` · 至 ${formatTime(snapshot.runtimeLease.expiresAt)}` : ""}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="health-tasks-title">
        <h2 id="health-tasks-title">任务与队列</h2>
        <dl>
          <div><dt>Bridge Task Desk</dt><dd>{countText(snapshot.tasks.desk)}；最早入队更新时间 {formatTime(snapshot.tasks.oldestDeskQueuedAt)}</dd></div>
          <div><dt>飞书 Direct</dt><dd>{countText(snapshot.tasks.direct)}；最早入队更新时间 {formatTime(snapshot.tasks.oldestDirectQueuedAt)}</dd></div>
          <div><dt>AAMP</dt><dd>{countText(snapshot.tasks.aamp)}；最早待派发更新时间 {formatTime(snapshot.tasks.oldestAampPendingAt)}</dd></div>
          <div><dt>飞书投递 outbox</dt><dd>待投递 {snapshot.outbox.pending} · 到期 {snapshot.outbox.due} · 已投递 {snapshot.outbox.delivered} · 卡片投递失败 {snapshot.outbox.deliveryFailedCards}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="health-errors-title">
        <h2 id="health-errors-title">最近执行错误</h2>
        {snapshot.recentErrors.length ? <ul>{snapshot.recentErrors.map((item) => <li key={`${item.source}:${item.id}`}>
          <strong>{item.source} · {item.id}</strong> <time dateTime={item.updatedAt}>{formatTime(item.updatedAt)}</time><p>{item.message}</p>
        </li>)}</ul> : <p className="muted">暂无已记录的执行错误。</p>}
      </section>
      <section aria-labelledby="health-storage-title">
        <h2 id="health-storage-title">附件存储与清理预览</h2>
        <dl>
          <div><dt>Web 暂存</dt><dd>{snapshot.storage.webStaged.count} 个 · {(snapshot.storage.webStaged.bytes / 1024 / 1024).toFixed(1)} MiB</dd></div>
          <div><dt>超过 24 小时</dt><dd>{snapshot.storage.webStaged.expiredCount} 个 · {(snapshot.storage.webStaged.expiredBytes / 1024 / 1024).toFixed(1)} MiB；此处只预览，不执行清理</dd></div>
          <div><dt>Web 已绑定</dt><dd>{snapshot.storage.webBound.count} 个 · {(snapshot.storage.webBound.bytes / 1024 / 1024).toFixed(1)} MiB</dd></div>
          <div><dt>Direct 已下载</dt><dd>{snapshot.storage.directDownloadedCount} 个；当前记录不含文件大小</dd></div>
          <div><dt>历史续聊保留附件</dt><dd>{snapshot.storage.historyRetained.count} 个 · 记录大小 {(snapshot.storage.historyRetained.declaredBytes / 1024 / 1024).toFixed(1)} MiB{snapshot.storage.historyRetained.truncated ? " · 已达到统计上限" : ""}</dd></div>
          <div><dt>AAMP 图片引用</dt><dd>{snapshot.storage.aampReferencedImageCount} 个；当前记录不含文件大小{snapshot.storage.aampReferenceScanTruncated ? " · 已达到统计上限" : ""}</dd></div>
        </dl>
        <p className="muted">引用数量和记录大小不代表磁盘占用；tmux 临时输入附件未纳入此页统计。清理预览仅覆盖 Web 暂存附件。</p>
      </section>
    </> : null}
  </main>;
}
