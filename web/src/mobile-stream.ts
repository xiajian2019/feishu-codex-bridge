/** EventSource retries must obtain a new single-use ticket for every connection. */
export function subscribeToTicketedEvents(options: {
  url: () => Promise<string>;
  onChange: (event: MessageEvent<string>) => void;
  onStatus: (status: "connecting" | "connected" | "disconnected") => void;
  resumeEvent: string;
}): () => void {
  let disposed = false;
  let source: EventSource | null = null;
  let connecting = false;
  let generation = 0;
  let retryTimer = 0;
  let attempts = 0;
  const available = (): boolean => navigator.onLine !== false && document.visibilityState !== "hidden";
  const disconnect = (): void => {
    generation += 1;
    connecting = false;
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    source?.close();
    source = null;
  };
  const retry = (): void => {
    if (disposed || retryTimer || !available()) return;
    const delay = Math.min(1_000 * 2 ** Math.min(attempts++, 4), 15_000);
    retryTimer = window.setTimeout(() => { retryTimer = 0; void connect(); }, delay);
  };
  const connect = async (): Promise<void> => {
    if (disposed || connecting || source || !available()) return;
    connecting = true;
    const requestGeneration = ++generation;
    options.onStatus("connecting");
    try {
      const url = await options.url();
      if (disposed || generation !== requestGeneration || !available()) return;
      const next = new EventSource(url);
      source = next;
      next.addEventListener("task.updated", (event) => {
        if (!disposed && source === next) options.onChange(event as MessageEvent<string>);
      });
      next.onopen = () => {
        if (disposed || source !== next) return;
        attempts = 0;
        options.onStatus("connected");
      };
      next.onerror = () => {
        if (disposed || source !== next) return;
        // Disable EventSource's implicit reconnect: that would reuse a consumed ticket.
        disconnect();
        options.onStatus("disconnected");
        retry();
      };
    } catch {
      if (disposed || generation !== requestGeneration) return;
      options.onStatus("disconnected");
      retry();
    } finally {
      if (generation === requestGeneration) connecting = false;
    }
  };
  const resume = (): void => {
    disconnect();
    if (available()) void connect();
    else options.onStatus("disconnected");
  };
  window.addEventListener("online", resume);
  window.addEventListener("offline", resume);
  window.addEventListener(options.resumeEvent, resume);
  document.addEventListener("visibilitychange", resume);
  if (available()) void connect();
  else options.onStatus("disconnected");
  return () => {
    disposed = true;
    disconnect();
    window.removeEventListener("online", resume);
    window.removeEventListener("offline", resume);
    window.removeEventListener(options.resumeEvent, resume);
    document.removeEventListener("visibilitychange", resume);
  };
}
