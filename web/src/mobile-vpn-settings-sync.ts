import type { IosVpnProvider } from "./bridge-global-config.js";

/** Serialize settings snapshots so a slow native call cannot restore older settings. */
export function createMobileVpnSettingsSync(
  read: () => readonly string[],
  apply: (ssids: string[], provider?: IosVpnProvider) => Promise<boolean>,
  readProvider: () => IosVpnProvider | undefined = () => undefined,
): () => Promise<boolean> {
  let previous = Promise.resolve(true);
  return () => {
    const snapshot = [...read()];
    const provider = readProvider();
    const next = previous.then(() => apply(snapshot, provider)).catch(() => false);
    previous = next;
    return next;
  };
}
