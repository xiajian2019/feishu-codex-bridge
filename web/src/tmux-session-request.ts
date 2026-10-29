class SessionRequestError extends Error {
  constructor(message: string, public readonly retryable: boolean) { super(message); }
}

export interface SessionRequestOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  retryTimeoutMs?: number;
  fetcher?: typeof fetch;
  onRetry?: (details: { elapsedMs: number; reason: string }) => void;
}

/** Retry one transient polling failure without discarding the last successful list. */
export async function requestTmuxSessions(
  url: string,
  options: SessionRequestOptions,
): Promise<{ status: number; rawResponse: string }> {
  const fetcher = options.fetcher ?? fetch;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal.aborted) throw options.signal.reason;
    const controller = new AbortController();
    const started = performance.now();
    let rejectCancellation!: (error: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const onAbort = (): void => {
      rejectCancellation(options.signal.reason);
      controller.abort(options.signal.reason);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      const error = new SessionRequestError("Session 列表请求超时，请重试。", true);
      rejectCancellation(error);
      controller.abort(error);
    }, attempt === 0 ? options.timeoutMs ?? 15_000 : options.retryTimeoutMs ?? 5_000);
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(url, {
            headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal,
          });
          const rawResponse = await response.text();
          if (!response.ok) {
            let message = `Session 列表请求失败（HTTP ${response.status}）。`;
            try { message = (JSON.parse(rawResponse) as { error?: string }).error || message; } catch { /* Proxy error pages. */ }
            throw new SessionRequestError(message, response.status >= 500);
          }
          return { status: response.status, rawResponse };
        })(),
        cancellation,
      ]);
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      if (attempt > 0 || !(error instanceof TypeError || error instanceof SessionRequestError && error.retryable)) throw error;
      options.onRetry?.({ elapsedMs: Math.round(performance.now() - started), reason: error.message });
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
    }
  }
  throw new Error("Session 列表请求失败。");
}
