/** Serialize settings snapshots so a slow native call cannot restore an older Wi-Fi list. */
export function createMobileVpnSettingsSync(
  read: () => readonly string[],
  apply: (ssids: string[]) => Promise<boolean>,
): () => Promise<boolean> {
  let previous = Promise.resolve(true);
  return () => {
    const snapshot = [...read()];
    const next = previous.then(() => apply(snapshot)).catch(() => false);
    previous = next;
    return next;
  };
}
