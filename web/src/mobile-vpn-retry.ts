/** Retry an unavailable Bridge after the native VPN target becomes reachable. */
export function createMobileVpnRetry(retry: () => void): {
  onUnavailable(state: "loading" | "setup" | "ready" | "unavailable", editing: boolean): void;
  onReachableApi(): void;
  onReachable(state: "loading" | "setup" | "ready" | "unavailable", editing: boolean): boolean;
  onState(state: "loading" | "setup" | "ready" | "unavailable", editing: boolean): void;
} {
  let pending = false;
  let loading = false;
  return {
    onUnavailable(_state, editing) {
      pending = !editing;
    },
    onReachableApi() {
      pending = false;
      loading = false;
    },
    onReachable(state, editing) {
      if (editing) { pending = false; loading = false; return false; }
      if (pending) { pending = false; retry(); return true; }
      if (state === "loading") loading = true;
      else if (state === "unavailable") { loading = false; retry(); return true; }
      else { loading = false; }
      return false;
    },
    onState(state, editing) {
      if (editing) { pending = false; loading = false; return; }
      if (state === "loading") return;
      const shouldRetry = state === "unavailable" && loading;
      loading = false;
      if (shouldRetry) retry();
    },
  };
}
