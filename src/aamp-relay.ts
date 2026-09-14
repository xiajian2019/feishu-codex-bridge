import type { StateDatabase } from "./db.js";
import type { AampTaskStatus, BridgeConfig, Logger } from "./types.js";

export interface AampRelayTaskStatus {
  taskId: string;
  status: AampTaskStatus;
  errorMessage?: string;
  markdown?: string;
  raw: unknown;
}

export interface RelayHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type RelayHttpClient = (
  url: string,
  options?: { headers?: Record<string, string> },
) => Promise<RelayHttpResponse>;

export interface AampRelayReconcileReport {
  inspected: number;
  aligned: number;
  skipped: number;
  failed: number;
}

/**
 * Small control-plane client for the private Relay. The official AAMP SDK
 * carries dispatch/update/result traffic; this client is deliberately only
 * used for the one-shot startup compensation scan.
 */
export class AampRelayClient {
  private readonly statusUrl?: string;
  private readonly authToken?: string;
  private readonly http: RelayHttpClient;

  constructor(
    relay: BridgeConfig["relay"],
    options: { http?: RelayHttpClient } = {},
  ) {
    this.statusUrl = relay.statusUrl;
    this.authToken = relay.authToken;
    this.http = options.http ?? defaultHttpClient;
  }

  public async queryTaskStatus(taskId: string): Promise<AampRelayTaskStatus | null> {
    if (!this.statusUrl) return null;
    const url = buildStatusUrl(this.statusUrl, taskId);
    const response = await this.http(url, {
      headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {},
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`AAMP Relay status query failed (${response.status})${body ? `: ${body.slice(0, 500)}` : ""}`);
    }
    const payload = await response.json();
    return parseRelayTaskStatus(taskId, payload);
  }
}

export async function reconcileRunningAampTasks(
  db: StateDatabase,
  relay: AampRelayClient,
  logger?: Logger,
): Promise<AampRelayReconcileReport> {
  const running = db.listRunningAampTasks();
  const report: AampRelayReconcileReport = {
    inspected: running.length,
    aligned: 0,
    skipped: 0,
    failed: 0,
  };
  for (const task of running) {
    try {
      const remote = await relay.queryTaskStatus(task.aamp_task_id);
      if (!remote) {
        report.skipped += 1;
        continue;
      }
      const patch: Parameters<StateDatabase["updateAampTask"]>[1] = {
        status: remote.status,
        relayStatus: remote.raw,
        eventType: "relay.status",
        event: remote.raw,
      };
      if (remote.errorMessage) patch.errorMsg = remote.errorMessage;
      if (remote.markdown !== undefined) patch.lastDeltaText = remote.markdown;
      db.updateAampTask(task.aamp_task_id, patch);
      report.aligned += 1;
    } catch (error) {
      report.failed += 1;
      logger?.warn("failed to reconcile AAMP task with Relay", {
        aampTaskId: task.aamp_task_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

function buildStatusUrl(statusUrl: string, taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  if (statusUrl.includes("{taskId}")) return statusUrl.replaceAll("{taskId}", encoded);
  if (statusUrl.includes("{task_id}")) return statusUrl.replaceAll("{task_id}", encoded);
  return `${statusUrl.replace(/\/+$/, "")}/${encoded}`;
}

function parseRelayTaskStatus(taskId: string, payload: unknown): AampRelayTaskStatus {
  const record = asRecord(payload) ?? {};
  const data = asRecord(record.data);
  const nested = asRecord(data?.task) ?? data ?? asRecord(record.task) ?? record;
  const rawStatus = firstString(nested?.status, nested?.state, nested?.phase);
  const status = normalizeStatus(rawStatus);
  if (!status) {
    throw new Error(`AAMP Relay returned no supported status for task ${taskId}`);
  }
  const errorMessage = firstString(
    nested?.error_msg,
    nested?.errorMsg,
    nested?.error,
    record.error_msg,
    record.errorMsg,
    record.error,
    ...(status === "failed" || status === "cancelled" ? [nested?.message, record.message] : []),
  );
  return {
    taskId,
    status,
    errorMessage,
    markdown: firstString(
      nested?.last_delta_text,
      nested?.markdown,
      nested?.output,
      nested?.result,
    ),
    raw: payload,
  };
}

function normalizeStatus(value: string | undefined): AampTaskStatus | undefined {
  if (!value) return undefined;
  switch (value.trim().toLowerCase()) {
    case "pending":
    case "queued":
    case "dispatching":
    case "dispatched":
      return "pending";
    case "running":
    case "streaming":
    case "in_progress":
    case "in-progress":
      return "running";
    case "done":
    case "completed":
    case "succeeded":
    case "success":
      return "done";
    case "failed":
    case "rejected":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return undefined;
  }
}

function defaultHttpClient(url: string, options?: { headers?: Record<string, string> }): Promise<RelayHttpResponse> {
  const fetchFunction = (globalThis as unknown as {
    fetch?: (input: string, init?: { headers?: Record<string, string> }) => Promise<RelayHttpResponse>;
  }).fetch;
  if (!fetchFunction) throw new Error("Node fetch is unavailable; use a custom Relay HTTP client");
  return fetchFunction(url, {
    headers: {
      Accept: "application/json",
      ...(options?.headers ?? {}),
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}
