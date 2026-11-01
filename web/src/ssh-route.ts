export function isStandaloneSshPath(pathname: string): boolean {
  return pathname === "/ssh" || pathname.startsWith("/ssh/");
}
