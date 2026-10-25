import type { CodexUsageAccount } from "./types.js";

export type TmuxCodexHomeOption = { id: string; label: string; available: boolean };

// These are the two account labels exposed by the local Bridge setup. The
// home IDs remain server-owned because they are derived from the actual paths.
export const CODEX_HOME_LABEL_FALLBACKS = ["默认", "second"] as const;
export const UNKNOWN_CODEX_HOME_LABEL = "已关联账号";

const CODEX_HOME_CACHE_KEY = "feishu-codex-bridge.tmux.codex-homes";

export function normalizeCodexHomeOptions(value: unknown): TmuxCodexHomeOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): TmuxCodexHomeOption[] => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const rawLabel = typeof record.label === "string" ? record.label.trim() : "";
    const label = rawLabel || CODEX_HOME_LABEL_FALLBACKS[index] || `账号 ${index + 1}`;
    return [{ id, label, available: record.available === true }];
  });
}

export function mergeCodexHomeOption(
  homes: TmuxCodexHomeOption[],
  account: Pick<CodexUsageAccount, "homeId" | "label" | "available">,
): TmuxCodexHomeOption[] {
  const homeId = account.homeId.trim();
  if (!homeId) return homes;
  const existingIndex = homes.findIndex((home) => home.id === homeId);
  const label = account.label.trim() || homes[existingIndex]?.label || CODEX_HOME_LABEL_FALLBACKS[0];
  const next = { id: homeId, label, available: account.available };
  if (existingIndex < 0) return [...homes, next];
  const existing = homes[existingIndex];
  if (existing.id === next.id && existing.label === next.label && existing.available === next.available) return homes;
  return homes.map((home, index) => index === existingIndex ? next : home);
}

export function resolveCodexHomeLabel(
  homeId: string | null | undefined,
  homes: TmuxCodexHomeOption[],
  usageAccount: Pick<CodexUsageAccount, "homeId" | "label"> | null = null,
): string {
  if (!homeId) return "未标记";
  if (usageAccount?.homeId === homeId && usageAccount.label.trim()) return usageAccount.label.trim();
  return homes.find((home) => home.id === homeId)?.label || UNKNOWN_CODEX_HOME_LABEL;
}

export function readCachedCodexHomeOptions(): TmuxCodexHomeOption[] {
  if (typeof window === "undefined") return [];
  try {
    return normalizeCodexHomeOptions(JSON.parse(window.localStorage.getItem(CODEX_HOME_CACHE_KEY) || "null"));
  } catch {
    return [];
  }
}

export function cacheCodexHomeOptions(homes: TmuxCodexHomeOption[]): void {
  if (typeof window === "undefined" || homes.length === 0) return;
  try {
    window.localStorage.setItem(CODEX_HOME_CACHE_KEY, JSON.stringify(homes));
  } catch {
    // Local storage is only a display fallback; the live API remains authoritative.
  }
}
