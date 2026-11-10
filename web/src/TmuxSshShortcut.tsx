import { useEffect, useRef, useState, type ReactElement } from "react";
import { getMobileConnection, isMobileApp } from "./mobile-runtime.js";
import { getNativeSshPlatform, isNativeSshWorkspaceAvailable, openNativeSshWorkspace, type NativeSshPlatform } from "./ssh-connectbot-native.js";
import { getConfiguredGlobalMacHost } from "./bridge-global-config.js";
import type { BridgeSshSessionSelection } from "./bridge-ssh-session-context.js";

export async function openNativeSshWorkspaceFromDashboard(
  presentation: "full" | "sheet" = "full",
  sessionSelection?: BridgeSshSessionSelection,
): Promise<void> {
  await openNativeSshWorkspace({
    defaultHost: getConfiguredGlobalMacHost(),
    ...(getMobileConnection()?.server ? { bridgeServerOrigin: getMobileConnection()!.server } : {}),
    ...(sessionSelection ? { sessionSelection } : {}),
    ...(presentation === "sheet" ? { presentation } : {}),
  });
}

/** Resume the native SSH workspace while leaving the current tmux page mounted. */
export function TmuxSshShortcut({ onError, sessionSelection }: { onError: (message: string) => void; sessionSelection?: BridgeSshSessionSelection }): ReactElement | null {
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
      await openNativeSshWorkspaceFromDashboard("full", sessionSelection);
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

export function TmuxMobileTerminalMode({
  terminalInputEnabled,
  terminalAttached,
  onToggleTerminalInput,
  onError,
  sessionSelection,
  onOpenWebShell,
  webShellOpen = false,
  webShellRetained = false,
}: {
  terminalInputEnabled: boolean;
  terminalAttached: boolean;
  onToggleTerminalInput: () => void;
  onError: (message: string) => void;
  sessionSelection?: BridgeSshSessionSelection;
  onOpenWebShell?: () => void;
  webShellOpen?: boolean;
  webShellRetained?: boolean;
}): ReactElement {
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const [opening, setOpening] = useState(false);
  const nativePlatform: NativeSshPlatform | null = isNativeSshWorkspaceAvailable() ? getNativeSshPlatform() : null;
  const nativeAvailable = nativePlatform !== null;
  const closeMenu = (): void => {
    if (menuRef.current) menuRef.current.open = false;
  };
  const openNativeSheet = async (): Promise<void> => {
    if (opening || !nativeAvailable) return;
    setOpening(true);
    try {
      await openNativeSshWorkspaceFromDashboard("sheet", sessionSelection);
      closeMenu();
    } catch (error) {
      onError(error instanceof Error && error.message ? error.message : "无法打开原生 SSH 工作区，请重试。");
    } finally {
      setOpening(false);
    }
  };

  const active = terminalInputEnabled || webShellOpen;
  return <details ref={menuRef} className="dashboard-codex-actions dashboard-terminal-mode-options">
    <summary className={`dashboard-terminal-mode-toggle${active ? " is-active" : ""}`} aria-label="选择终端操作方式" title="选择终端操作方式">
      {active ? (
        <svg className="dashboard-terminal-mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3" y="4" width="18" height="15" rx="2" />
          <path d="m7 9 3 3-3 3" />
          <path d="M13 15h3M17 8v6" />
        </svg>
      ) : (
        <svg className="dashboard-terminal-mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3" y="4" width="18" height="15" rx="2" />
          <path d="m7 9 3 3-3 3" />
          <path d="M13 15h2" />
          <rect x="15" y="13" width="6" height="6" rx="1.2" />
          <path d="M17 13v-1a2 2 0 0 1 4 0v1" />
        </svg>
      )}
    </summary>
    <div className="dashboard-codex-actions-panel" role="menu" aria-label="终端操作方式">
      <button type="button" role="menuitem" disabled={!terminalAttached} aria-pressed={terminalInputEnabled} onClick={() => { closeMenu(); onToggleTerminalInput(); }}>
        {terminalInputEnabled ? "关闭终端输入" : "开启终端输入"}
      </button>
      {onOpenWebShell ? (
        <button type="button" role="menuitem" disabled={!terminalAttached && !webShellOpen} aria-pressed={webShellOpen} onClick={() => { closeMenu(); onOpenWebShell(); }}>
          {webShellOpen ? "最小化命令终端" : webShellRetained ? "恢复命令终端" : "打开命令终端"}
        </button>
      ) : null}
      {nativeAvailable ? (
        <button type="button" role="menuitem" disabled={!nativeAvailable || opening} onClick={() => void openNativeSheet()}>
          {opening ? "正在打开原生 SSH…" : nativePlatform === "android" ? "打开原生 SSH（安卓半屏）" : "打开原生 SSH（iOS 半屏）"}
        </button>
      ) : null}
    </div>
  </details>;
}
