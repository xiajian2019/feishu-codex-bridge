import { useEffect, useState, type ReactElement } from "react";
import type { MobileCrashReportStatus } from "./mobile-crash-diagnostics.js";
import {
  captureMobileThreadSnapshot, getMobileCrashReportStatus, isMobileCrashDiagnosticsAvailable,
  readMobileCrashReport, shareMobileCrashReport,
} from "./mobile-runtime.js";
import "./crash-diagnostics.css";

export function CrashDiagnosticsPanel(): ReactElement | null {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<MobileCrashReportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);

  const load = async (): Promise<void> => { setStatus(await getMobileCrashReportStatus()); };
  useEffect(() => {
    let active = true;
    void isMobileCrashDiagnosticsAvailable().then(async (supported) => {
      if (!active || !supported) return;
      setAvailable(true);
      const next = await getMobileCrashReportStatus();
      if (active) setStatus(next);
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "无法读取诊断报告。"); });
    return () => { active = false; };
  }, []);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "诊断操作失败。"); }
    finally { setBusy(false); }
  };

  if (!available) return null;
  return <section className="crash-diagnostics-panel" aria-label="本机崩溃报告">
    <header><h2>本机崩溃报告</h2><button type="button" disabled={busy} onClick={() => void run(load)}>刷新</button></header>
    <p>系统崩溃报告会在可用时保存到本机；生成快照可记录当前线程状态。报告只在你主动分享时离开手机。</p>
    <div className="crash-diagnostics-actions"><button type="button" disabled={busy} onClick={() => void run(async () => {
      const id = await captureMobileThreadSnapshot();
      await load();
      setPreview({ id, text: await readMobileCrashReport(id) });
    })}>{busy ? "处理中…" : "生成线程快照"}</button></div>
    {status?.error ? <p role="alert">{status.error}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!status ? <p>正在读取报告…</p> : status.reports.length === 0 ? <p>暂无报告。崩溃诊断由系统交付，可能不会立即出现。</p> :
      <ul>{status.reports.map((report) => <li key={report.id}>
        <div><strong>{report.kind === "crash" ? "系统崩溃诊断" : "手动线程快照"}</strong>
          <span>{report.kind === "crash" ? "诊断区间截止 " : "快照时间 "}{new Date(report.capturedAt).toLocaleString()} · 构建 {report.appBuild}{report.signal != null ? ` · 信号 ${report.signal}` : ""}</span>
          {report.appBinaryUUID ? <code title="用于匹配原始构建 dSYM 的 App 二进制 UUID">App UUID：{report.appBinaryUUID}</code> : null}</div>
        <div className="crash-diagnostics-actions">
          <button type="button" disabled={busy} onClick={() => void run(async () => setPreview({ id: report.id, text: await readMobileCrashReport(report.id) }))}>查看</button>
          <button type="button" disabled={busy} onClick={() => void run(() => shareMobileCrashReport(report.id))}>分享</button>
        </div>
      </li>)}</ul>}
    {preview ? <details open><summary>报告内容</summary><pre>{preview.text}</pre></details> : null}
    <small>保存位置：{status?.storage ?? "App 私有目录"}。诊断包含堆栈与设备版本，请确认分享对象。</small>
  </section>;
}
