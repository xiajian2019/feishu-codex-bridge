/**
 * App-wide Mac target. Environment switching may change the port, but every
 * private Bridge endpoint and the default SSH target use this host.
 *
 * Native Android entry points receive this value from the WebView instead of
 * keeping a second user-specific IP constant.
 */
export const BRIDGE_GLOBAL_MAC_HOST = "10.15.53.70";

export function bridgeOriginForPort(port: number, protocol = "http:"): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError("Bridge port must be between 1 and 65535.");
  const url = new URL(`${protocol}//${BRIDGE_GLOBAL_MAC_HOST}`);
  url.port = String(port);
  return url.origin;
}

/** Replace a private Bridge endpoint's host while retaining its protocol/port. */
export function bridgeOriginWithGlobalMacHost(origin: string): string {
  const url = new URL(origin);
  url.hostname = BRIDGE_GLOBAL_MAC_HOST;
  return url.origin;
}
