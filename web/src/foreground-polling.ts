const ACTIVITY_EVENT = "bridge:foreground-change";
let appActive = true;
export function setAppForeground(active: boolean): void {
  appActive = active;
  window.dispatchEvent(new Event(ACTIVITY_EVENT));
}
export function isAppForeground(): boolean {
  return appActive && document.visibilityState !== "hidden";
}

/** Serial read-only polling. Pause aborts old reads; resume starts a fresh read and preserves the caller's cursor. */
export function startForegroundPolling(request: (signal: AbortSignal) => Promise<boolean | void>, intervalMs: number): () => void {
  let stopped = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const eligible = () => isAppForeground() && navigator.onLine !== false;
  const pause = (): void => {
    generation += 1;
    clearTimeout(timer); timer = undefined;
    controller?.abort(); controller = null;
  };
  const run = async (): Promise<void> => {
    if (stopped || controller || !eligible()) return;
    clearTimeout(timer); timer = undefined;
    const current = new AbortController();
    controller = current;
    const version = generation;
    let keepPolling: boolean | void = true;
    try { keepPolling = await request(current.signal); }
    catch { /* Callers expose their own error state; foreground recovery retries reads only. */ }
    finally {
      if (version === generation && !stopped) {
        controller = null;
        if (keepPolling !== false && eligible()) timer = setTimeout(() => void run(), intervalMs);
      }
    }
  };
  const changed = (): void => {
    if (!eligible()) pause();
    else void run();
  };
  document.addEventListener("visibilitychange", changed);
  const environmentChanged = (): void => { stopped = true; pause(); };
  window.addEventListener("bridge:mobile-connection", environmentChanged);
  for (const event of ["online", "offline", "focus", "pageshow", "bridge:mobile-resume", ACTIVITY_EVENT]) window.addEventListener(event, changed);
  void run();
  return () => {
    stopped = true; pause();
    document.removeEventListener("visibilitychange", changed);
    window.removeEventListener("bridge:mobile-connection", environmentChanged);
    for (const event of ["online", "offline", "focus", "pageshow", "bridge:mobile-resume", ACTIVITY_EVENT]) window.removeEventListener(event, changed);
  };
}
