export type AuthGateView = "content" | "loading" | "mobile-connection" | "browser-pairing";

/** Native pairing belongs to the connection center; browsers keep their pairing flow. */
export function authGateView(options: {
  mobile: boolean;
  authenticated: boolean | null;
  offlineFallback: boolean;
  hasError: boolean;
}): AuthGateView {
  if (options.mobile && (options.authenticated === false || (options.authenticated === null && options.hasError))) {
    return "mobile-connection";
  }
  if (options.authenticated || options.offlineFallback) return "content";
  if (options.authenticated === null && !options.hasError) return "loading";
  return "browser-pairing";
}
