let activeDraftScope: string | null = null;

/** The server derives this opaque value from the installation and current device session. */
export function setLocalDraftScope(value: string | null | undefined): void {
  activeDraftScope = typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value)
    ? value
    : null;
}

export function getLocalDraftScope(): string | null {
  return activeDraftScope;
}
