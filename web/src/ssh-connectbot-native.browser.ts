import type { PluginListenerHandle } from "@capacitor/core";
import type { BridgeConnectBotSshOpenRequest, SshOptions, SshWorkspaceClosedEvent } from "./ssh-connectbot-native.js";

export function openNativeTerminal(_request: BridgeConnectBotSshOpenRequest): Promise<void> {
  return Promise.reject(new Error("ConnectBot SSH 仅支持 Android App。"));
}

export function isNativeSshWorkspaceAvailable(): boolean { return false; }

export function openNativeSshWorkspace(_mode?: "manage"): Promise<void> {
  return Promise.reject(new Error("ConnectBot SSH 仅支持 Android App。"));
}

export function listNativeSshOptions(): Promise<SshOptions> {
  return Promise.reject(new Error("ConnectBot SSH 仅支持 Android App。"));
}

export function onNativeSshWorkspaceClosed(_listener: (event: SshWorkspaceClosedEvent) => void): Promise<PluginListenerHandle> {
  return Promise.reject(new Error("ConnectBot SSH 仅支持 Android App。"));
}

export function onNativeSshReturnToWorkbench(_listener: () => void): Promise<PluginListenerHandle> {
  return Promise.reject(new Error("ConnectBot SSH 仅支持 Android App。"));
}
