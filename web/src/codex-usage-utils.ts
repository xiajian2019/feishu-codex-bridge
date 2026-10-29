import type { CodexUsageAccount, CodexUsageResponse } from "./types.js";

export function getCodexUsageRemainingPercentages(account: CodexUsageAccount | null): [string, string] {
  const windowsByDuration = new Map<string, { duration: number | null; remainingPercent: number }>();
  for (const bucket of account?.quota?.buckets ?? []) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window || !Number.isFinite(window.usedPercent)) continue;
      const duration = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
      const key = duration === null ? "unknown" : String(duration);
      const previous = windowsByDuration.get(key);
      const remainingPercent = 100 - clampPercent(window.usedPercent);
      if (!previous || remainingPercent < previous.remainingPercent) {
        windowsByDuration.set(key, { duration, remainingPercent });
      }
    }
  }

  const windows = [...windowsByDuration.values()].sort((left, right) => {
    if (left.duration === null) return right.duration === null ? 0 : 1;
    if (right.duration === null) return -1;
    return left.duration - right.duration;
  });
  const percentages = windows.slice(0, 2).map(({ remainingPercent }) => formatPercent(remainingPercent));
  return [percentages[0] ?? "—", percentages[1] ?? "—"];
}

export function preserveCodexUsageAccount(
  previous: CodexUsageAccount | null,
  latest: CodexUsageAccount,
): CodexUsageAccount {
  if (!previous || previous.homeId !== latest.homeId) return latest;
  const preserveQuota = !latest.quota && Boolean(latest.errors?.quota && previous.quota);
  const preserveTokenUsage = !latest.tokenUsage && Boolean(latest.errors?.tokenUsage && previous.tokenUsage);
  if (!preserveQuota && !preserveTokenUsage) return latest;
  return {
    ...latest,
    ...(preserveQuota ? { quota: previous.quota } : {}),
    ...(preserveTokenUsage ? { tokenUsage: previous.tokenUsage } : {}),
    ...(preserveTokenUsage ? { tokenUsageUpdatedAt: previous.tokenUsageUpdatedAt } : {}),
    stale: {
      ...(preserveQuota ? { quota: true } : {}),
      ...(preserveTokenUsage ? { tokenUsage: true } : {}),
    },
  };
}

export function preserveLastSuccessfulCodexUsage(
  previous: CodexUsageResponse | null,
  latest: CodexUsageResponse,
): CodexUsageResponse {
  if (!previous) return latest;
  const previousAccounts = new Map(previous.accounts.map((account) => [account.homeId, account]));
  return {
    ...latest,
    accounts: latest.accounts.map((account) => preserveCodexUsageAccount(previousAccounts.get(account.homeId) ?? null, account)),
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
