import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { consumeCodexResetCredit, fetchCodexUsage } from "./api.js";
import type {
  CodexResetCreditConsumeOutcome,
  CodexUsageResetCredit,
  CodexUsageAccount,
  CodexUsageLimitBucket,
  CodexUsageRateLimitWindow,
  CodexUsageResponse,
} from "./types.js";

const REFRESH_INTERVAL_MS = 60_000;
const RESET_ATTEMPT_STORAGE_PREFIX = "feishu-codex-bridge.reset-credit-attempt";
const resetAttemptFallback = new Map<string, string>();

export function CodexUsage(): ReactElement {
  const [snapshot, setSnapshot] = useState<CodexUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const hasLoaded = useRef(false);

  const loadUsage = useCallback(async (): Promise<void> => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setError(null);
    setLoading(!hasLoaded.current);
    setRefreshing(hasLoaded.current);
    try {
      const result = await fetchCodexUsage();
      setSnapshot((previous) => preserveLastSuccessfulData(previous, result));
      hasLoaded.current = true;
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      requestInFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadUsage();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadUsage]);

  return (
    <main className="codex-usage-page">
      <header className="codex-usage-header">
        <div className="codex-usage-page-heading">
          <h1>Codex 用量</h1>
          <span className="codex-usage-updated">
            {snapshot ? `更新于 ${formatTimestamp(snapshot.generatedAt)} · 每分钟刷新` : "每分钟自动刷新"}
          </span>
        </div>
        <button className="primary codex-usage-refresh" type="button" onClick={() => void loadUsage()} disabled={loading || refreshing}>
          {refreshing ? "刷新中…" : "立即刷新"}
        </button>
      </header>

      {error ? <div className="codex-usage-error" role="alert">{error}</div> : null}
      {loading && !snapshot ? <div className="codex-usage-empty">正在读取 Codex 账户用量…</div> : null}
      {snapshot && snapshot.accounts.length === 0 ? (
        <div className="codex-usage-empty">没有发现已登记的 Codex 账户。</div>
      ) : null}
      {snapshot && snapshot.accounts.length > 0 ? (
        <section className="codex-usage-grid" aria-label="Codex 账户用量">
          {snapshot.accounts.map((account) => (
            <UsageAccountCard key={account.homeId} account={account} onRefresh={loadUsage} />
          ))}
        </section>
      ) : null}

      <p className="codex-usage-note">
        额度窗口和每日 Token 数由 Codex app-server 返回；不同账户可能返回不同窗口。页面仅显示 Codex 提供的数据，不估算 API 费用。
      </p>
    </main>
  );
}

function UsageAccountCard({ account, onRefresh }: {
  account: CodexUsageAccount;
  onRefresh: () => Promise<void>;
}): ReactElement {
  const [resetCreditsOpen, setResetCreditsOpen] = useState(false);
  const [confirmingCredit, setConfirmingCredit] = useState<CodexUsageResetCredit | null>(null);
  const [consumeBusy, setConsumeBusy] = useState(false);
  const [consumeError, setConsumeError] = useState<string | null>(null);
  const [consumeMessage, setConsumeMessage] = useState<string | null>(null);
  const [submittedCreditIds, setSubmittedCreditIds] = useState<Set<string>>(() => new Set());
  const buckets = account.quota?.buckets ?? [];
  const dailyBuckets = account.tokenUsage?.dailyUsageBuckets?.slice(-7) ?? [];
  const summary = account.tokenUsage?.summary;
  const resetCreditCount = account.quota?.resetCreditsAvailableCount;
  const resetCredits = account.quota?.resetCredits;
  const planType = account.quota?.planType || buckets.find((bucket) => bucket.planType)?.planType;
  const status = account.stale?.quota
    ? { label: "额度数据沿用上次结果", state: "unknown" }
    : account.available
    ? account.quota?.ordinaryUsageAllowed === true
      ? { label: "当前可用", state: "available" }
      : account.quota?.ordinaryUsageAllowed === false
        ? { label: "普通额度不可用", state: "unavailable" }
        : { label: "状态未提供", state: "unknown" }
    : { label: "账户目录不可用", state: "unavailable" };

  return (
    <article className="codex-usage-account">
      <header className="codex-usage-account-header">
        <div className="codex-usage-account-heading">
          <div className="codex-usage-account-title">
            <h2>{account.label}</h2>
            <div className="codex-usage-account-badges">
              {planType ? <span className="codex-usage-plan">{formatPlanType(planType)}</span> : null}
              <span className={`codex-usage-status is-${status.state}`}>{status.label}</span>
            </div>
          </div>
          {typeof resetCreditCount === "number" ? (
            <button
              className="codex-usage-credit-trigger"
              type="button"
              onClick={() => {
                setConsumeError(null);
                setConsumeMessage(null);
                setConfirmingCredit(null);
                setResetCreditsOpen(true);
              }}
              aria-label={`${account.label}有 ${resetCreditCount} 张可用重置卡，查看详情`}
            >
              可用重置卡 {resetCreditCount}<span aria-hidden="true">›</span>
            </button>
          ) : null}
        </div>
      </header>

      <section className="codex-usage-section">
        <div className="codex-usage-section-heading">
          <h3>额度窗口</h3>
        </div>
        {account.stale?.quota ? <p className="codex-usage-stale">本次读取失败，以下为上次成功结果。</p> : null}
        {account.errors?.quota && !account.stale?.quota ? <p className="codex-usage-inline-error">{account.errors.quota}</p> : null}
        {!account.errors?.quota && buckets.length === 0 ? (
          <p className="codex-usage-muted">Codex 当前没有返回额度窗口。</p>
        ) : null}
        {buckets.length > 0 ? (
          <div className="codex-usage-buckets">
            {buckets.map((bucket, index) => (
              <QuotaBucket key={`${bucket.limitId ?? bucket.limitName ?? "limit"}-${index}`} bucket={bucket} />
            ))}
          </div>
        ) : null}
      </section>

      <section className="codex-usage-section codex-usage-token-section">
        <div className="codex-usage-section-heading">
          <h3>账户 Token 统计</h3>
          <span className="codex-usage-muted">每日统计</span>
        </div>
        {account.stale?.tokenUsage ? <p className="codex-usage-stale">本次读取失败，以下为上次成功结果。</p> : null}
        {account.errors?.tokenUsage && !account.stale?.tokenUsage ? <p className="codex-usage-inline-error">{account.errors.tokenUsage}</p> : null}
        {!account.errors?.tokenUsage ? (
          <>
            <div className="codex-usage-metrics">
              <UsageMetric label="累计 Token" value={formatTokens(summary?.lifetimeTokens)} />
              <UsageMetric label="单日峰值" value={formatTokens(summary?.peakDailyTokens)} />
              <UsageMetric label="连续活跃" value={formatDays(summary?.currentStreakDays)} />
            </div>
            <DailyUsageChart buckets={dailyBuckets} />
          </>
        ) : null}
      </section>

      {resetCreditsOpen ? (
        <ResetCreditDialog
          account={account}
          credits={resetCredits}
          availableCount={resetCreditCount}
          confirmingCredit={confirmingCredit}
          consumeBusy={consumeBusy}
          consumeError={consumeError}
          consumeMessage={consumeMessage}
          submittedCreditIds={submittedCreditIds}
          onRefresh={onRefresh}
          onClose={() => {
            if (consumeBusy) return;
            setResetCreditsOpen(false);
            setConfirmingCredit(null);
          }}
          onChoose={(credit) => {
            setConsumeError(null);
            setConsumeMessage(null);
            setConfirmingCredit(credit);
          }}
          onCancelConfirm={() => {
            if (consumeBusy) return;
            setConfirmingCredit(null);
            setConsumeError(null);
          }}
          onConfirm={async () => {
            if (!confirmingCredit || consumeBusy) return;
            setConsumeBusy(true);
            setConsumeError(null);
            const attempt = getOrCreateResetAttemptKey(account.homeId, confirmingCredit.id);
            try {
              const result = await consumeCodexResetCredit({
                homeId: account.homeId,
                creditId: confirmingCredit.id,
                idempotencyKey: attempt.idempotencyKey,
              });
              setConsumeMessage(resetCreditOutcomeMessage(result.outcome));
              if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
                setSubmittedCreditIds((current) => new Set(current).add(confirmingCredit.id));
                setConfirmingCredit(null);
              } else if (result.outcome !== "unknown") {
                clearResetAttemptKey(attempt.storageKey);
                setConfirmingCredit(null);
              }
              await onRefresh();
            } catch (requestError: unknown) {
              setConsumeError(
                `${requestError instanceof Error ? requestError.message : String(requestError)} 消费结果可能尚未确认；再次确认会复用同一请求编号。`,
              );
            } finally {
              setConsumeBusy(false);
            }
          }}
        />
      ) : null}
    </article>
  );
}

function ResetCreditDialog({
  account,
  credits,
  availableCount,
  confirmingCredit,
  consumeBusy,
  consumeError,
  consumeMessage,
  submittedCreditIds,
  onRefresh,
  onClose,
  onChoose,
  onCancelConfirm,
  onConfirm,
}: {
  account: CodexUsageAccount;
  credits?: CodexUsageResetCredit[] | null;
  availableCount?: number | null;
  confirmingCredit: CodexUsageResetCredit | null;
  consumeBusy: boolean;
  consumeError: string | null;
  consumeMessage: string | null;
  submittedCreditIds: Set<string>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onChoose: (credit: CodexUsageResetCredit) => void;
  onCancelConfirm: () => void;
  onConfirm: () => Promise<void>;
}): ReactElement {
  const [refreshingDetails, setRefreshingDetails] = useState(false);
  const sortedCredits = Array.isArray(credits)
    ? [...credits].sort((left, right) => {
      const statusOrder = Number(right.status === "available") - Number(left.status === "available");
      if (statusOrder !== 0) return statusOrder;
      return (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER);
    })
    : [];
  const detailsUnavailable = !Array.isArray(credits);
  const noCredits = !detailsUnavailable && sortedCredits.length === 0 && (availableCount ?? 0) === 0;

  return (
    <div
      className="codex-usage-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !consumeBusy) onClose();
      }}
    >
      <section className="codex-usage-modal" role="dialog" aria-modal="true" aria-labelledby="codex-reset-credit-title">
        <header className="codex-usage-modal-header">
          <div className="codex-usage-modal-title">
            <h2 id="codex-reset-credit-title">{confirmingCredit ? "确认使用重置卡" : `${account.label}重置卡`}</h2>
          </div>
          <div className="codex-usage-modal-header-actions">
            <button
              className="codex-usage-modal-refresh"
              type="button"
              onClick={async () => {
                setRefreshingDetails(true);
                try {
                  await onRefresh();
                } finally {
                  setRefreshingDetails(false);
                }
              }}
              disabled={refreshingDetails || consumeBusy || confirmingCredit !== null}
            >{refreshingDetails ? "刷新中…" : "刷新"}</button>
            <button
              className="codex-usage-modal-close"
              type="button"
              onClick={onClose}
              disabled={consumeBusy}
              aria-label="关闭"
            >×</button>
          </div>
        </header>

        {confirmingCredit ? (
          <div className="codex-usage-confirm-body">
            <div className="codex-usage-credit-selected">
              <strong>{confirmingCredit.title || "Codex 用量重置卡"}</strong>
              <span>{formatCreditExpiry(confirmingCredit.expiresAt)}</span>
            </div>
            <p className="codex-usage-confirm-warning">
              确认后会立即消耗这张卡，并尝试重置该账户当前符合条件的额度窗口。此操作无法撤回。
            </p>
            {confirmingCredit.description ? <p className="codex-usage-credit-description">{confirmingCredit.description}</p> : null}
            {consumeError ? <div className="codex-usage-modal-error" role="alert">{consumeError}</div> : null}
            {consumeMessage ? <div className="codex-usage-modal-result" role="status">{consumeMessage}</div> : null}
            <footer className="codex-usage-modal-actions">
              <button type="button" onClick={onCancelConfirm} disabled={consumeBusy}>返回卡片列表</button>
              <button className="danger" type="button" onClick={() => void onConfirm()} disabled={consumeBusy}>
                {consumeBusy ? "正在确认…" : consumeError || consumeMessage ? "使用同一请求重试" : "确认使用这张卡"}
              </button>
            </footer>
          </div>
        ) : (
          <div className="codex-usage-credit-list">
            {typeof availableCount === "number" && sortedCredits.length > 0 && availableCount > sortedCredits.length ? (
              <p className="codex-usage-modal-note">Codex 返回 {availableCount} 张可用卡片；当前显示 {sortedCredits.length} 条详情。</p>
            ) : null}
            {consumeMessage ? <div className="codex-usage-modal-result" role="status">{consumeMessage}</div> : null}
            {noCredits ? <p className="codex-usage-modal-empty">当前没有可用的重置卡。</p> : null}
            {detailsUnavailable && (availableCount ?? 0) > 0 ? (
              <p className="codex-usage-modal-empty">
                Codex 返回了 {availableCount} 张可用卡，但没有提供单卡详情。当前无法确认卡片到期时间或指定要使用哪一张。
              </p>
            ) : null}
            {!detailsUnavailable && sortedCredits.length === 0 && !noCredits ? (
              <p className="codex-usage-modal-empty">Codex 暂未返回可展示的卡片详情，请刷新后重试。</p>
            ) : null}
            {sortedCredits.map((credit) => {
              const expired = isResetCreditExpired(credit.expiresAt);
              const alreadySubmitted = submittedCreditIds.has(credit.id);
              const canConsume = account.available
                && !account.stale?.quota
                && availableCount !== 0
                && credit.status === "available"
                && !expired
                && !alreadySubmitted;
              return (
                <article className="codex-usage-credit-row" key={credit.id}>
                  <div className="codex-usage-credit-main">
                    <div className="codex-usage-credit-title">
                      <strong>{credit.title || "Codex 用量重置卡"}</strong>
                      <span className={`codex-usage-credit-status is-${credit.status}`}>{formatResetCreditStatus(credit.status)}</span>
                    </div>
                    <div className={`codex-usage-credit-expiry${expired ? " is-expired" : ""}`}>
                      到期时间：{formatCreditExpiry(credit.expiresAt)}
                    </div>
                    <div className="codex-usage-credit-granted">获得于 {formatTimestampFromSeconds(credit.grantedAt)}</div>
                    {credit.description ? <p className="codex-usage-credit-description">{credit.description}</p> : null}
                    {expired && credit.status === "available" ? (
                      <p className="codex-usage-stale">服务端仍标记为可用，但到期时间已过；请刷新账户状态后再试。</p>
                    ) : null}
                  </div>
                  {credit.status === "available" ? (
                    <button
                      className="codex-usage-credit-use"
                      type="button"
                      onClick={() => onChoose(credit)}
                      disabled={!canConsume}
                    >
                      {alreadySubmitted ? "本次请求已完成" : "使用此卡"}
                    </button>
                  ) : null}
                </article>
              );
            })}
            {account.stale?.quota ? <p className="codex-usage-stale">额度数据是上次成功读取的结果；刷新成功前不能使用重置卡。</p> : null}
          </div>
        )}
      </section>
    </div>
  );
}

function QuotaBucket({ bucket }: { bucket: CodexUsageLimitBucket }): ReactElement {
  const title = bucket.limitName || bucket.normalModelSlug || defaultBucketLabel(bucket.limitId);
  const windows = [
    bucket.primary === undefined ? null : { window: bucket.primary, label: "主窗口" },
    bucket.secondary === undefined ? null : { window: bucket.secondary, label: "次窗口" },
  ].filter((entry): entry is { window: CodexUsageRateLimitWindow | null; label: string } => entry !== null);

  return (
    <div className="codex-usage-bucket">
      <div className="codex-usage-bucket-title">
        <strong>{title}</strong>
        {bucket.credits?.unlimited ? <span>不限额</span> : bucket.credits?.balance ? <span>余额 {bucket.credits.balance}</span> : null}
      </div>
      {windows.length > 0 ? (
        <div className="codex-usage-windows">
          {windows.map(({ window, label }, index) => (
            <QuotaWindow key={`${label}-${index}`} window={window} label={label} />
          ))}
        </div>
      ) : <p className="codex-usage-muted">当前没有可显示的窗口数据。</p>}
    </div>
  );
}

function QuotaWindow({ window, label }: { window: CodexUsageRateLimitWindow | null; label: string }): ReactElement {
  if (!window) {
    return (
      <div className="codex-usage-window is-empty">
        <div className="codex-usage-window-heading"><strong>{label}</strong><span>暂无数据</span></div>
      </div>
    );
  }
  const used = clampPercent(window.usedPercent);
  const title = `${label} · ${formatWindowDuration(window.windowDurationMins)}`;
  return (
    <div className="codex-usage-window">
      <div className="codex-usage-window-heading">
        <strong>{title}</strong>
        <span>已用 {formatPercent(used)} · 剩余 {formatPercent(100 - used)}</span>
      </div>
      <div className="codex-usage-progress" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
        <span style={{ width: `${used}%` }} />
      </div>
      <div className="codex-usage-reset">{formatResetTime(window.resetsAt)}</div>
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="codex-usage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DailyUsageChart({ buckets }: { buckets: Array<{ startDate: string; tokens: number }> }): ReactElement {
  if (buckets.length === 0) return <p className="codex-usage-muted codex-usage-no-daily">暂无每日 Token 数据。</p>;
  const maxTokens = Math.max(...buckets.map((bucket) => bucket.tokens), 1);
  return (
    <div className="codex-usage-chart" aria-label="最近每日 Token 用量">
      {buckets.map((bucket) => {
        const height = Math.max(3, Math.round((bucket.tokens / maxTokens) * 100));
        return (
          <div className="codex-usage-chart-day" key={bucket.startDate} title={`${bucket.startDate} · ${formatTokens(bucket.tokens)} Token`}>
            <strong>{formatTokens(bucket.tokens)}</strong>
            <div className="codex-usage-chart-track"><span style={{ height: `${height}%` }} /></div>
            <span>{bucket.startDate.slice(-5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function defaultBucketLabel(limitId?: string | null): string {
  if (!limitId || limitId === "codex") return "Codex 总额度";
  return `额度组 ${limitId}`;
}

function getOrCreateResetAttemptKey(homeId: string, creditId: string): { storageKey: string; idempotencyKey: string } {
  const storageKey = `${RESET_ATTEMPT_STORAGE_PREFIX}:${homeId}:${creditId}`;
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return { storageKey, idempotencyKey: existing };
  } catch {
    // Try the in-memory fallback below when browser storage is unavailable.
  }
  const fallback = resetAttemptFallback.get(storageKey);
  if (fallback) return { storageKey, idempotencyKey: fallback };
  const idempotencyKey = createResetIdempotencyKey();
  try {
    window.localStorage.setItem(storageKey, idempotencyKey);
  } catch {
    resetAttemptFallback.set(storageKey, idempotencyKey);
  }
  return { storageKey, idempotencyKey };
}

function clearResetAttemptKey(storageKey: string): void {
  resetAttemptFallback.delete(storageKey);
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // The in-memory fallback above is enough for this tab.
  }
}

function createResetIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Some non-secure browser contexts expose crypto but disable randomUUID.
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function resetCreditOutcomeMessage(outcome: CodexResetCreditConsumeOutcome): string {
  switch (outcome) {
    case "reset": return "重置成功，已使用这张重置卡。";
    case "alreadyRedeemed": return "这次请求此前已成功完成，不会再次消耗重置卡。";
    case "nothingToReset": return "当前没有符合条件的额度窗口，未应用重置。";
    case "noCredit": return "账户当前没有可用重置卡，未应用重置。";
    default: return "Codex 返回了未识别的结果。请求编号已保留；请刷新状态后再用同一请求重试。";
  }
}

function formatResetCreditStatus(status: string): string {
  const labels: Record<string, string> = {
    available: "可用",
    redeeming: "处理中",
    redeemed: "已使用",
  };
  return labels[status] || "状态未知";
}

function isResetCreditExpired(expiresAt?: number | null): boolean {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt * 1_000 <= Date.now();
}

function formatCreditExpiry(expiresAt?: number | null): string {
  if (expiresAt === null) return "永不过期";
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "Codex 未提供到期时间";
  const date = new Date(expiresAt * 1_000);
  if (Number.isNaN(date.getTime())) return "到期时间无效";
  const dateLabel = date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const difference = date.getTime() - Date.now();
  if (difference <= 0) return `已于 ${dateLabel} 到期`;
  const days = Math.ceil(difference / 86_400_000);
  return days <= 7 ? `${dateLabel}（${days < 1 ? "24 小时内" : `${days} 天后`}到期）` : `${dateLabel} 到期`;
}

function formatTimestampFromSeconds(timestamp: number): string {
  const date = new Date(timestamp * 1_000);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function preserveLastSuccessfulData(
  previous: CodexUsageResponse | null,
  latest: CodexUsageResponse,
): CodexUsageResponse {
  if (!previous) return latest;
  const previousAccounts = new Map(previous.accounts.map((account) => [account.homeId, account]));
  return {
    ...latest,
    accounts: latest.accounts.map((account) => {
      const prior = previousAccounts.get(account.homeId);
      if (!prior) return account;
      const preserveQuota = !account.quota && Boolean(account.errors?.quota && prior.quota);
      const preserveTokenUsage = !account.tokenUsage && Boolean(account.errors?.tokenUsage && prior.tokenUsage);
      if (!preserveQuota && !preserveTokenUsage) return account;
      return {
        ...account,
        ...(preserveQuota ? { quota: prior.quota } : {}),
        ...(preserveTokenUsage ? { tokenUsage: prior.tokenUsage } : {}),
        stale: {
          ...(preserveQuota ? { quota: true } : {}),
          ...(preserveTokenUsage ? { tokenUsage: true } : {}),
        },
      };
    }),
  };
}

function formatWindowDuration(minutes?: number | null): string {
  if (typeof minutes !== "number" || minutes <= 0) return "用量窗口";
  if (minutes === 300) return "5 小时";
  if (minutes === 10_080) return "7 天";
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatResetTime(resetsAt?: number | null): string {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return "重置时间未提供";
  const resetDate = new Date(resetsAt * 1_000);
  if (Number.isNaN(resetDate.getTime())) return "重置时间未提供";
  const millisecondsUntilReset = resetDate.getTime() - Date.now();
  if (millisecondsUntilReset <= 0) {
    return `重置于 ${resetDate.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}（已过）`;
  }
  const remainingSeconds = Math.floor(millisecondsUntilReset / 1_000);
  return `重置于 ${resetDate.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}（${formatCountdown(remainingSeconds)}）`;
}

function formatCountdown(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}天 ${hours}小时后`;
  if (hours > 0) return `${hours}小时 ${minutes}分后`;
  return `${minutes}分钟后`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatTokens(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDays(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value} 天` : "—";
}

function formatPlanType(value: string): string {
  const labels: Record<string, string> = {
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    promax: "Pro Max",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    free: "Free",
  };
  return labels[value] || value;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}
