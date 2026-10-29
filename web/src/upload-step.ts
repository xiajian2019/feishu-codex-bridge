/** Bound individual upload steps, including response parsing and local file reads. */
export function uploadStep<T>(run: (signal: AbortSignal) => Promise<T>, options: {
  signal?: AbortSignal;
  timeoutMs: number;
  message: string;
}): Promise<T> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(options.signal?.reason ?? new DOMException("已取消上传。", "AbortError"));
  if (options.signal?.aborted) { cancel(); return Promise.reject(controller.signal.reason); }
  options.signal?.addEventListener("abort", cancel, { once: true });
  let rejectAbort!: (reason: unknown) => void;
  const abort = (): void => rejectAbort(controller.signal.reason);
  const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException(options.message, "TimeoutError")), options.timeoutMs);
  return Promise.race([Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return run(controller.signal);
  }), interrupted]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
    options.signal?.removeEventListener("abort", cancel);
  });
}
