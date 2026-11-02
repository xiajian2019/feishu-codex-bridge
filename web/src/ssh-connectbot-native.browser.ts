import type { PluginListenerHandle } from "@capacitor/core";
import type { AppUpdateAction, BridgeConnectBotSshOpenRequest, BridgeConnectBotSshWorkspaceRequest, NativeAppUpdateBanner, SshOptions, SshWorkspaceClosedEvent } from "./ssh-connectbot-native.js";

export function openNativeTerminal(_request: BridgeConnectBotSshOpenRequest): Promise<void> {
  return Promise.reject(new Error("ConnectBot SSH 仅支持 Android App。"));
}

export function isNativeSshWorkspaceAvailable(): boolean { return false; }

export function openNativeSshWorkspace(_request?: BridgeConnectBotSshWorkspaceRequest): Promise<void> {
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

export async function setNativeSshWorkspaceVisible(_visible: boolean): Promise<boolean> { return false; }
export async function closeNativeSshWorkspace(): Promise<void> {}
export async function setNativeAppUpdateBanner(_banner: NativeAppUpdateBanner): Promise<void> {}
export function onNativeAppUpdateAction(_listener: (action: AppUpdateAction) => void): Promise<PluginListenerHandle> {
  return Promise.reject(new Error("ConnectBot SSH 仅支持 Android App。"));
}
