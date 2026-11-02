/**
 * Process-wide authentication metadata. The browser's HttpOnly cookie remains
 * owned by the browser; this store contains only the response state needed when
 * AuthGate is remounted by the mobile connection center.
 */
export interface GlobalAuthState<T = unknown> {
  authenticated: boolean | null;
  status: T | null;
  error: string | null;
  offlineFallback: boolean;
}

const states = new Map<string, GlobalAuthState>();

export function authStateKey(server: string, deviceScope: string | null | undefined): string {
  const origin = new URL(server).origin;
  const scope = typeof deviceScope === "string" && deviceScope.length > 0 ? deviceScope : "pending";
  return `bridge-auth:v1:${encodeURIComponent(origin)}:${encodeURIComponent(scope)}`;
}

export function readGlobalAuthState<T>(server: string, deviceScope: string | null | undefined): GlobalAuthState<T> | null {
  return (states.get(authStateKey(server, deviceScope)) as GlobalAuthState<T> | undefined) ?? null;
}

export function writeGlobalAuthState<T>(server: string, deviceScope: string | null | undefined, state: GlobalAuthState<T>): void {
  states.set(authStateKey(server, deviceScope), { ...state });
}

export function clearGlobalAuthState(server: string, deviceScope?: string | null): void {
  states.delete(authStateKey(server, deviceScope));
}
