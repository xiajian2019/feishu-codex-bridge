import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { consumeCodexResetCredit, fetchCodexUsage } from "./api.js";
import { preserveLastSuccessfulCodexUsage } from "./codex-usage-utils.js";
import { useMobileBack } from "./use-mobile-back.js";
import { startForegroundPolling } from "./foreground-polling.js";
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
const ACCOUNT_USAGE_PAGE_SIZE = 7;
const GLOBAL_USAGE_PAGE_SIZE = 30;
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
      setSnapshot((previous) => preserveLastSuccessfulCodexUsage(previous, result));
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
    return startForegroundPolling(async () => { await loadUsage(); }, REFRESH_INTERVAL_MS);
  }, [loadUsage]);

  return (
    <main className="codex-usage-page">
      <header className="codex-usage-header">
        <div className="codex-usage-page-heading">
          <h1>Codex 用量</h1>
          <span className="codex-usage-updated">
            {snapshot ? `额度与 Token 于 ${formatTimestamp(snapshot.generatedAt)} 检查` : "额度与 Token 每分钟检查"}
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
        <>
          <GlobalDailyUsageChart buckets={snapshot.globalDailyUsageBuckets} />
          <section className="codex-usage-grid" aria-label="Codex 账户用量">
            {snapshot.accounts.map((account) => (
              <UsageAccountCard key={account.homeId} account={account} onRefresh={loadUsage} />
            ))}
          </section>
        </>
      ) : null}

      <p className="codex-usage-note">
        额度窗口与 Token 数据每次读取 Codex app-server；历史日桶按账号及 UTC 日期保存，并允许服务端回补。
      </p>
    </main>
  );
}

export function CodexUsageDialog({
  accountLabel,
  account,
  loading,
  error,
  onRefresh,
  onClose,
}: {
  accountLabel: string;
  account: CodexUsageAccount | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const [refreshing, setRefreshing] = useState(false);
  useMobileBack(true, onClose, 200);

  return (
    <div
      className="codex-usage-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="codex-usage-modal codex-usage-details-modal" role="dialog" aria-modal="true" aria-labelledby="codex-usage-details-title">
        <header className="codex-usage-modal-header">
          <div className="codex-usage-modal-title">
            <h2 id="codex-usage-details-title">{account ? "Codex 用量" : `${accountLabel} · Codex 用量`}</h2>
          </div>
          <div className="codex-usage-modal-header-actions">
            <button
              className="codex-usage-modal-refresh"
              type="button"
              onClick={async () => {
                setRefreshing(true);
                try {
                  await onRefresh();
                } finally {
                  setRefreshing(false);
                }
              }}
              disabled={loading || refreshing}
            >{loading || refreshing ? "刷新中…" : "刷新"}</button>
            <button className="codex-usage-modal-close" type="button" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>
        <div className="codex-usage-details-body">
          {error ? <div className="codex-usage-error" role="alert">{error}</div> : null}
          {loading && !account ? <div className="codex-usage-empty">正在读取 Codex 账户用量…</div> : null}
          {account ? <UsageAccountCard account={account} onRefresh={onRefresh} showResetCredits={false} embedded /> : null}
          {!loading && !account && !error ? <div className="codex-usage-empty">暂无可显示的 Codex 账户用量。</div> : null}
        </div>
      </section>
    </div>
  );
}

function UsageAccountCard({ account, onRefresh, showResetCredits = true, embedded = false }: {
  account: CodexUsageAccount;
  onRefresh: () => Promise<void>;
  showResetCredits?: boolean;
  embedded?: boolean;
}): ReactElement {
  const [resetCreditsOpen, setResetCreditsOpen] = useState(false);
  const [confirmingCredit, setConfirmingCredit] = useState<CodexUsageResetCredit | null>(null);
  const [consumeBusy, setConsumeBusy] = useState(false);
  const [consumeError, setConsumeError] = useState<string | null>(null);
  const [consumeMessage, setConsumeMessage] = useState<string | null>(null);
  const [submittedCreditIds, setSubmittedCreditIds] = useState<Set<string>>(() => new Set());
  const buckets = account.quota?.buckets ?? [];
  const dailyBuckets = account.tokenUsage?.dailyUsageBuckets ?? [];
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
    <article className={`codex-usage-account${embedded ? " is-embedded" : ""}`}>
      <header className="codex-usage-account-header">
        <div className="codex-usage-account-heading">
          <div className="codex-usage-account-title">
            {embedded ? <strong className="codex-usage-account-name">{account.label}</strong> : <h2>{account.label}</h2>}
            <div className="codex-usage-account-badges">
              {planType ? <span className="codex-usage-plan">{formatPlanType(planType)}</span> : null}
              <span className={`codex-usage-status is-${status.state}`}>{status.label}</span>
            </div>
          </div>
          {showResetCredits && typeof resetCreditCount === "number" ? (
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
          <h3>Token 统计</h3>
          {account.tokenUsageUpdatedAt ? <span className="codex-usage-muted">同步于 {formatTimestamp(account.tokenUsageUpdatedAt)}</span> : null}
        </div>
        {account.stale?.tokenUsage ? <p className="codex-usage-stale">本次读取失败，以下为上次成功结果。</p> : null}
        {account.errors?.tokenUsage && !account.stale?.tokenUsage ? <p className="codex-usage-inline-error">{account.errors.tokenUsage}</p> : null}
        {!account.errors?.tokenUsage ? (
          <>
            <div className="codex-usage-metrics">
              <UsageMetric
                label="累计 Token"
                value={formatTokenUnit(summary?.lifetimeTokens)}
              />
              <UsageMetric
                label="单日峰值"
                value={formatTokenUnit(summary?.peakDailyTokens)}
              />
              <UsageMetric label="连续活跃" value={formatDays(summary?.currentStreakDays)} />
            </div>
            <DailyUsageChart buckets={dailyBuckets} />
          </>
        ) : null}
      </section>

      {showResetCredits && resetCreditsOpen ? (
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
  useMobileBack(true, () => {
    if (consumeBusy) return;
    if (confirmingCredit) onCancelConfirm();
    else onClose();
  }, 210);
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
  const [pageOffset, setPageOffset] = useState(0);
  if (buckets.length === 0) return <p className="codex-usage-muted codex-usage-no-daily">暂无每日 Token 数据。</p>;
  const pageCount = Math.ceil(buckets.length / ACCOUNT_USAGE_PAGE_SIZE);
  const pageIndex = Math.min(pageOffset, pageCount - 1);
  const pageEnd = buckets.length - pageIndex * ACCOUNT_USAGE_PAGE_SIZE;
  const pageStart = Math.max(0, pageEnd - ACCOUNT_USAGE_PAGE_SIZE);
  const visibleBuckets = buckets.slice(pageStart, pageEnd);
  const maxTokens = Math.max(...visibleBuckets.map((bucket) => bucket.tokens), 1);
  return (
    <>
      <div className="codex-usage-chart-navigation">
        <span>{visibleBuckets[0]?.startDate} 至 {visibleBuckets[visibleBuckets.length - 1]?.startDate} · 共 {buckets.length} 条日记录</span>
        {pageCount > 1 ? (
          <div>
            {pageIndex < pageCount - 1 ? (
              <HistoryArrowButton
                direction="older"
                label="查看较早的 7 天 Token 用量"
                onClick={() => setPageOffset((current) => Math.min(current + 1, pageCount - 1))}
              />
            ) : null}
            {pageIndex > 0 ? (
              <HistoryArrowButton
                direction="newer"
                label="查看较新的 7 天 Token 用量"
                onClick={() => setPageOffset((current) => Math.max(0, current - 1))}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="codex-usage-chart" aria-label="每日 Token 用量">
        {visibleBuckets.map((bucket) => {
          const height = Math.max(3, Math.round((bucket.tokens / maxTokens) * 100));
          return (
            <div className="codex-usage-chart-day" key={bucket.startDate} title={`${bucket.startDate} · ${formatTokenUnit(bucket.tokens)} Token`}>
              <strong>
                <span>{formatTokenUnit(bucket.tokens)}</span>
              </strong>
              <div className="codex-usage-chart-track"><span style={{ height: `${height}%` }} /></div>
              <span>{bucket.startDate.slice(-5)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function GlobalDailyUsageChart({ buckets }: { buckets: Array<{ startDate: string; tokens: number }> }): ReactElement {
  const [pageOffset, setPageOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const validBuckets = buckets
    .filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate) && Number.isFinite(Date.parse(`${bucket.startDate}T00:00:00Z`)))
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  if (validBuckets.length === 0) {
    return (
      <section className="codex-usage-overview">
        <h2>总体每日 Token</h2>
        <p className="codex-usage-muted">暂无已保存的每日 Token 数据。</p>
      </section>
    );
  }
  const latestKnownDate = validBuckets[validBuckets.length - 1]?.startDate;
  const latestKnownMs = latestKnownDate ? Date.parse(`${latestKnownDate}T00:00:00Z`) : Number.NaN;
  const earliestKnownMs = validBuckets.length > 0 ? Date.parse(`${validBuckets[0]!.startDate}T00:00:00Z`) : Number.NaN;
  const rangeDayCount = Number.isFinite(latestKnownMs) && Number.isFinite(earliestKnownMs)
    ? Math.floor((latestKnownMs - earliestKnownMs) / 86_400_000) + 1
    : 0;
  const pageCount = Math.max(1, Math.ceil(rangeDayCount / GLOBAL_USAGE_PAGE_SIZE));
  const pageIndex = Math.min(pageOffset, pageCount - 1);
  const pageEndMs = latestKnownMs - pageIndex * GLOBAL_USAGE_PAGE_SIZE * 86_400_000;
  const rangeStartMs = Math.max(earliestKnownMs, pageEndMs - (GLOBAL_USAGE_PAGE_SIZE - 1) * 86_400_000);
  const visibleBuckets = validBuckets.filter((bucket) => {
    const bucketMs = Date.parse(`${bucket.startDate}T00:00:00Z`);
    return bucketMs >= rangeStartMs && bucketMs <= pageEndMs;
  });
  const selectedBucket = visibleBuckets.find((bucket) => bucket.startDate === selectedDate);

  const byDate = new Map(visibleBuckets.map((bucket) => [bucket.startDate, bucket.tokens]));
  const latestDate = new Date(pageEndMs).toISOString().slice(0, 10);
  const rangeStartDate = new Date(rangeStartMs).toISOString().slice(0, 10);
  const dayCount = Math.max(1, Math.floor((pageEndMs - rangeStartMs) / 86_400_000) + 1);
  const dates = Array.from({ length: dayCount }, (_, index) => new Date(rangeStartMs + index * 86_400_000).toISOString().slice(0, 10));
  const width = 960;
  const height = 220;
  const paddingX = 20;
  const paddingY = 18;
  const knownValues = [...byDate.values()];
  const maxTokens = Math.max(...knownValues, 1);
  const points = dates.map((date, index) => {
    const tokens = byDate.get(date);
    if (tokens === undefined) return { date, tokens: null, x: 0, y: 0 };
    const x = dates.length === 1
      ? width / 2
      : paddingX + (index / (dates.length - 1)) * (width - paddingX * 2);
    const y = height - paddingY - (tokens / maxTokens) * (height - paddingY * 2);
    return { date, tokens, x, y };
  });
  let path = "";
  let segmentStarted = false;
  for (const point of points) {
    if (point.tokens === null) {
      segmentStarted = false;
      continue;
    }
    path += `${segmentStarted ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)} `;
    segmentStarted = true;
  }
  const totalTokens = visibleBuckets.reduce((total, bucket) => total + bucket.tokens, 0);
  const labelIndexes = [...new Set([0, Math.floor((dates.length - 1) / 2), dates.length - 1])];

  return (
    <section className="codex-usage-overview" aria-label="总体每日 Token 用量">
      <header className="codex-usage-overview-header">
        <div>
          <h2>总体每日 Token</h2>
          <span>{rangeStartDate} 至 {latestDate} · {visibleBuckets.length} 个有数据的日期</span>
        </div>
        <div className="codex-usage-overview-actions">
          {pageCount > 1 ? (
            <div className="codex-usage-overview-navigation">
              {pageIndex < pageCount - 1 ? (
                <HistoryArrowButton
                  direction="older"
                  label="查看较早的 30 天 Token 用量"
                  onClick={() => {
                    setSelectedDate(null);
                    setPageOffset((current) => Math.min(current + 1, pageCount - 1));
                  }}
                />
              ) : null}
              {pageIndex > 0 ? (
                <HistoryArrowButton
                  direction="newer"
                  label="查看较新的 30 天 Token 用量"
                  onClick={() => {
                    setSelectedDate(null);
                    setPageOffset((current) => Math.max(0, current - 1));
                  }}
                />
              ) : null}
            </div>
          ) : null}
          <div className="codex-usage-overview-total">
            <span>本页累计</span>
            <strong>{formatTokenUnit(totalTokens)}</strong>
          </div>
        </div>
      </header>
      <div className={`codex-usage-point-detail${selectedBucket ? " is-selected" : ""}`} aria-live="polite">
        {selectedBucket ? (
          <>
            <span>{selectedBucket.startDate}</span>
            <strong>{formatTokenUnit(selectedBucket.tokens)} Token</strong>
          </>
        ) : <span>点击折线上的日期查看当日用量</span>}
      </div>
      <div className="codex-usage-line-chart">
        {visibleBuckets.length === 0 ? <p className="codex-usage-muted">该日期范围内暂无每日 Token 数据。</p> : null}
        {visibleBuckets.length > 0 ? (
          <>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`每日 Token 折线图，${rangeStartDate} 至 ${latestDate}，本页累计 ${formatTokenUnit(totalTokens)}`}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            if (bounds.width <= 0) return;
            const chartX = ((event.clientX - bounds.left) / bounds.width) * width;
            let nearestDate: string | null = null;
            let nearestDistance = Number.POSITIVE_INFINITY;
            for (const point of points) {
              if (point.tokens === null) continue;
              const distance = Math.abs(point.x - chartX);
              if (distance < nearestDistance) {
                nearestDate = point.date;
                nearestDistance = distance;
              }
            }
            if (nearestDate) setSelectedDate(nearestDate);
          }}
        >
          <title>总体每日 Token 用量</title>
          {[0.25, 0.5, 0.75].map((fraction) => {
            const y = paddingY + fraction * (height - paddingY * 2);
            return <line key={fraction} x1={paddingX} x2={width - paddingX} y1={y} y2={y} className="codex-usage-line-grid" />;
          })}
          <path d={path} className="codex-usage-line-path" />
          {points.filter((point) => point.tokens !== null).map((point) => (
            <circle
              key={point.date}
              cx={point.x}
              cy={point.y}
              r={selectedDate === point.date ? "5.5" : "4.5"}
              className={`codex-usage-line-point${selectedDate === point.date ? " is-selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${point.date}，${formatTokenUnit(point.tokens)} Token`}
              aria-pressed={selectedDate === point.date}
              onFocus={() => setSelectedDate(point.date)}
              onClick={() => setSelectedDate(point.date)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedDate(point.date);
                }
              }}
            >
              <title>{point.date} · {formatTokenUnit(point.tokens)} Token</title>
            </circle>
          ))}
        </svg>
        <div className="codex-usage-line-labels">
          {labelIndexes.map((index) => <span key={dates[index]}>{dates[index]?.slice(5)}</span>)}
        </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function HistoryArrowButton({
  direction,
  label,
  onClick,
}: {
  direction: "older" | "newer";
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button className="codex-usage-history-arrow" type="button" onClick={onClick} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={direction === "older" ? "M15 18 9 12l6-6" : "m9 18 6-6-6-6"} />
      </svg>
    </button>
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
  const remainingMinutes = Math.max(1, Math.ceil(difference / 60_000));
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;
  const remaining = days > 0
    ? `剩余 ${days} 天${hours > 0 ? ` ${hours} 小时` : ""}`
    : hours > 0
      ? `剩余 ${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}`
      : `剩余 ${minutes} 分钟`;
  return `${dateLabel}（${remaining}）`;
}

function formatTimestampFromSeconds(timestamp: number): string {
  const date = new Date(timestamp * 1_000);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
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

function formatTokenUnit(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const isBillions = value >= 100_000_000;
  const divisor = isBillions ? 100_000_000 : 10_000;
  const roundedTenths = Math.round((value / divisor) * 10);
  return `${(roundedTenths / 10).toFixed(1)}${isBillions ? "亿" : "万"}`;
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
