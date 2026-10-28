import { useCallback, useEffect, useState, type ReactElement } from "react";

import { getActionToken, getJson } from "./api.js";

interface BackupMetadata {
  source?: "manual" | "scheduled";
  formatVersion?: number;
  programVersion: string;
  createdAt: string;
  databaseBytes: number;
  schemaFingerprint: string;
  contentHashesVerified: boolean;
}

interface BackupEntry {
  backupId: string;
  status: "metadata" | "invalid";
  metadata?: BackupMetadata;
  error?: string;
}

interface BackupListResponse {
  backups: BackupEntry[];
  restoreDirectory: string;
  schedule?: {
    timeZone: string;
    nextRunAt: string;
    retentionDays: number;
    minimumBackups: number;
  };
}

interface BackupVerification {
  formatVersion?: number;
  programVersion: string;
  createdAt: string;
  databaseBytes: number;
  schemaFingerprint: string;
  contentHashesVerified: boolean;
}

interface UpgradeCompatibility {
  sourceProgramVersion: string;
  targetProgramVersion: string;
  sourceSchemaFingerprint: string;
  migratedSchemaFingerprint: string;
  compatible: boolean;
}

interface RestoreResult {
  restoreId: string;
  location: string;
  schemaFingerprint: string;
}

interface BackupOperationResult {
  verification?: BackupVerification;
  compatibility?: UpgradeCompatibility;
  restore?: RestoreResult;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

async function postBackupAction<T>(url: string): Promise<T> {
  const actionToken = await getActionToken();
  return getJson<T>(url, {
    method: "POST",
    headers: { "X-Bridge-Action-Token": actionToken },
  });
}

export function SystemBackups(): ReactElement {
  const [snapshot, setSnapshot] = useState<BackupListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, BackupOperationResult>>({});

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setLoading(true);
    setError(null);
    if (!quiet) setResults({});
    try {
      setSnapshot(await getJson<BackupListResponse>("/api/system/backups"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法读取备份列表。");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createBackup = async (): Promise<void> => {
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const actionToken = await getActionToken();
      const result = await getJson<{ backup: BackupEntry }>("/api/system/backups/create", {
        method: "POST",
        headers: { "X-Bridge-Action-Token": actionToken },
      });
      setNotice(`备份 ${result.backup.backupId} 已创建。请先执行“校验”再依赖此备份。`);
      await refresh(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "创建备份失败。");
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (backupId: string, action: "verify" | "check-upgrade" | "restore"): Promise<void> => {
    if (action === "restore") {
      if (!window.confirm(
        `将 ${backupId} 的 SQLite 数据库恢复到 backups/restores 下的全新目录，不恢复附件。不会覆盖当前数据库，也不会切换或重启服务。继续？`,
      )) return;
    }
    const key = `${backupId}:${action}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await postBackupAction<BackupOperationResult>(
        `/api/system/backups/${encodeURIComponent(backupId)}/${action}`,
      );
      setResults((current) => ({ ...current, [backupId]: { ...current[backupId], ...result } }));
      if (result.restore) {
        setNotice(`恢复完成，结果位于 ${result.restore.location}；运行服务仍使用原数据库。`);
      } else if (result.verification) {
        setNotice(`${backupId} 的 SQLite 数据库校验通过。`);
      } else if (result.compatibility) {
        setNotice(result.compatibility.compatible
          ? `${backupId} 可由当前程序版本迁移。`
          : `${backupId} 与当前程序版本不兼容。`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "备份操作失败。");
    } finally {
      setBusy(null);
    }
  };

  return <main className="page-main system-backups-page">
    <header className="project-management-header">
      <h1>数据备份</h1>
      <div className="system-backups-header-actions">
        <button type="button" onClick={() => void refresh()} disabled={loading || busy !== null}>刷新</button>
        <button className="primary" type="button" onClick={() => void createBackup()} disabled={busy !== null}>
          {busy === "create" ? "正在备份…" : "立即创建备份"}
        </button>
      </div>
    </header>
    <p className="muted">仅备份 Bridge 的 SQLite 数据库，保存在数据目录的 backups/。</p>
    <p className="muted">每天凌晨 01:00（{snapshot?.schedule?.timeZone ?? "主机时区"}）自动备份，完成后按日期清理 3 天前的系统定时备份，始终保留最近 3 个。手动备份保留。</p>
    <p className="muted">校验备份会检查数据库完整性；检查升级使用临时副本。新旧备份均只恢复数据库，库内原有附件路径保持不变，不恢复附件，也不覆盖当前数据库或切换服务。</p>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {notice ? <p className="system-backups-notice" role="status">{notice}</p> : null}
    {loading && !snapshot ? <p className="muted">正在读取备份清单…</p> : null}
    {snapshot && snapshot.backups.length === 0 ? <p className="empty">还没有备份。创建后可在这里校验、检查升级兼容性或恢复到新目录。</p> : null}
    {snapshot?.backups.length ? <div className="system-backup-list">
      {snapshot.backups.map((backup) => {
        const item = results[backup.backupId];
        const rowBusy = busy && busy.startsWith(`${backup.backupId}:`) ? busy.slice(backup.backupId.length + 1) : null;
        const hashVerified = Boolean(item?.verification) || Boolean(backup.metadata?.contentHashesVerified);
        const formatVersion = backup.metadata?.formatVersion ?? 1;
        return <article className="system-backup-card" key={backup.backupId}>
          <header>
            <div>
              <h2>{backup.backupId}</h2>
              {backup.metadata ? <p className="muted">{formatTime(backup.metadata.createdAt)} · {backup.metadata.source === "scheduled" ? "系统定时" : "手动"} · 程序 {backup.metadata.programVersion}</p> : null}
            </div>
            {backup.status === "invalid" ? <span className="system-backup-invalid">清单无效</span> : null}
          </header>
          {backup.metadata ? <dl>
            <div><dt>数据库</dt><dd>{formatBytes(backup.metadata.databaseBytes)}</dd></div>
            <div><dt>备份范围</dt><dd>SQLite 数据库</dd></div>
            <div><dt>清单版本</dt><dd>v{formatVersion}</dd></div>
            <div><dt>数据库校验</dt><dd>{hashVerified ? "本页已校验" : "本页尚未校验"}</dd></div>
          </dl> : <p className="muted">{backup.error || "无法读取此备份的元数据。"}</p>}
          {item?.verification ? <p className="system-backup-result">校验通过 · SQLite 数据库完整性与 SHA-256 匹配。</p> : null}
          {item?.compatibility ? <p className="system-backup-result">升级检查：{item.compatibility.compatible ? "兼容" : "不兼容"}（{item.compatibility.sourceProgramVersion} → {item.compatibility.targetProgramVersion}）</p> : null}
          {item?.restore ? <p className="system-backup-result">恢复目录：<code>{item.restore.location}</code> · 仅数据库</p> : null}
          {backup.status === "metadata" ? <div className="system-backup-actions">
            <button type="button" disabled={busy !== null} onClick={() => void runAction(backup.backupId, "verify")}>
              {rowBusy === "verify" ? "正在校验…" : "校验备份"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void runAction(backup.backupId, "check-upgrade")}>
              {rowBusy === "check-upgrade" ? "正在检查…" : "检查升级"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void runAction(backup.backupId, "restore")}>
              {rowBusy === "restore" ? "正在恢复…" : "恢复到新目录"}
            </button>
          </div> : null}
        </article>;
      })}
    </div> : null}
    {snapshot?.backups.some((backup) => backup.status === "metadata") ? <p className="muted">恢复结果可在 {snapshot.restoreDirectory} 下找到；页面不会自动导入或启动恢复的数据。</p> : null}
  </main>;
}
