import { useCallback, useEffect, useState, type ReactElement } from "react";

import { getActionToken, getJson } from "./api.js";

interface BackupMetadata {
  formatVersion?: number;
  programVersion: string;
  createdAt: string;
  databaseBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  attachmentCountsByKind?: Record<"web" | "direct" | "aamp" | "tmux", number>;
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
}

interface BackupVerification {
  formatVersion?: number;
  programVersion: string;
  createdAt: string;
  databaseBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  attachmentCountsByKind?: Record<"web" | "direct" | "aamp" | "tmux", number>;
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
  attachmentCount: number;
  attachmentBytes: number;
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
      const formatVersion = snapshot?.backups.find((backup) => backup.backupId === backupId)?.metadata?.formatVersion ?? 1;
      const legacyNote = formatVersion < 2
        ? "此旧版清单未包含 tmux 附件；若备份数据库引用了 tmux 截图，恢复会被拒绝。"
        : "";
      if (!window.confirm(
        `将 ${backupId} 恢复到 backups/restores 下的全新目录。不会覆盖当前数据库，也不会切换或重启服务。${legacyNote}继续？`,
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
        setNotice(`${backupId} 的数据库和附件哈希校验通过。`);
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
    <p className="muted">备份保存在 Bridge 数据目录的 backups/。包含数据库记录引用的 Web、Direct、AAMP 和 tmux 附件；tmux 只收集任务提交记录中引用且仍存在的附件。不包含配置文件、项目仓库、Codex 账户数据库或未关联的文件。</p>
    <p className="muted">清单为数据库文件和每个已关联附件保存 SHA-256 内容摘要；“校验备份”会重新读取文件并比对这些摘要。列表只读清单元数据，显示“尚未校验”表示本次尚未执行文件校验；清单 JSON 自身没有单独的哈希。数据库结构指纹是另一项信息。“检查升级”会在临时副本上运行数据库迁移。“恢复到新目录”会先校验备份并写入独立目录，不会覆盖或切换当前服务。</p>
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
        const attachmentCounts = backup.metadata?.attachmentCountsByKind ?? { web: 0, direct: 0, aamp: 0, tmux: 0 };
        return <article className="system-backup-card" key={backup.backupId}>
          <header>
            <div>
              <h2>{backup.backupId}</h2>
              {backup.metadata ? <p className="muted">{formatTime(backup.metadata.createdAt)} · 程序 {backup.metadata.programVersion}</p> : null}
            </div>
            {backup.status === "invalid" ? <span className="system-backup-invalid">清单无效</span> : null}
          </header>
          {backup.metadata ? <dl>
            <div><dt>数据库</dt><dd>{formatBytes(backup.metadata.databaseBytes)}</dd></div>
            <div><dt>已关联附件</dt><dd>{backup.metadata.attachmentCount} 个 · {formatBytes(backup.metadata.attachmentBytes)}</dd></div>
            {backup.metadata.attachmentCount > 0 ? <div><dt>来源</dt><dd>{([
              ["web", "Task Desk"], ["direct", "Direct"], ["aamp", "AAMP"], ["tmux", "tmux"],
            ] as const).filter(([kind]) => attachmentCounts[kind] > 0)
              .map(([kind, label]) => `${label} ${attachmentCounts[kind]}`).join(" · ")}</dd></div> : null}
            <div><dt>清单版本</dt><dd>v{formatVersion}{formatVersion < 2 ? " · 未收录 tmux 附件" : " · 包含受引用的 tmux 附件"}</dd></div>
            <div><dt>文件 SHA-256 校验</dt><dd>{hashVerified ? "本页已校验" : "本页尚未校验"}</dd></div>
          </dl> : <p className="muted">{backup.error || "无法读取此备份的元数据。"}</p>}
          {item?.verification ? <p className="system-backup-result">校验通过 · 数据库和附件哈希匹配。</p> : null}
          {item?.compatibility ? <p className="system-backup-result">升级检查：{item.compatibility.compatible ? "兼容" : "不兼容"}（{item.compatibility.sourceProgramVersion} → {item.compatibility.targetProgramVersion}）</p> : null}
          {item?.restore ? <p className="system-backup-result">恢复目录：<code>{item.restore.location}</code> · {item.restore.attachmentCount} 个附件</p> : null}
          {backup.metadata && formatVersion < 2 ? <p className="system-backup-warning">旧版备份没有包含 tmux 截图；如果数据库仍引用这些截图，系统会阻止不完整恢复。请创建新版备份。</p> : null}
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
