import { useEffect, useRef, useState, type ReactElement } from "react";
import { getMobileConnection, isMobileApp } from "./mobile-runtime.js";
import { isNativeSshWorkspaceAvailable, openNativeSshWorkspace } from "./ssh-connectbot-native.js";
import { getConfiguredGlobalMacHost } from "./bridge-global-config.js";

/** Resume the native SSH workspace while leaving the current tmux page mounted. */
export function TmuxSshShortcut({ onError }: { onError: (message: string) => void }): ReactElement | null {
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const openWorkspace = async (): Promise<void> => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      await openNativeSshWorkspace({
        defaultHost: getConfiguredGlobalMacHost(),
        ...(getMobileConnection()?.server ? { bridgeServerOrigin: getMobileConnection()!.server } : {}),
      });
    } catch (error) {
      if (mountedRef.current) onError(error instanceof Error && error.message ? error.message : "无法打开 SSH 工作区，请重试。");
    } finally {
      openingRef.current = false;
      if (mountedRef.current) setOpening(false);
    }
  };

  if (!isMobileApp() || !isNativeSshWorkspaceAvailable()) return null;
  return <button
    className="dashboard-action dashboard-icon-button dashboard-ssh-shortcut"
    type="button"
    onClick={() => void openWorkspace()}
    disabled={opening}
    aria-label="继续已有 SSH 会话"
    title="继续已有 SSH 会话"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M12 16h5" />
    </svg>
  </button>;
}
