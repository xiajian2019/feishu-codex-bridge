import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface BridgeConnectBotSshOpenRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  startupCommand?: string;
  profileId?: string;
  keyId?: string;
}

export interface SshProfileOption {
  id: string; label: string; host: string; port: number; username: string; keyId: string; startupCommand: string;
}
export interface SshKeyOption { id: string; nickname: string; algorithm: string }
export interface SshOptions { profiles: SshProfileOption[]; keys: SshKeyOption[] }

export interface SshWorkspaceClosedEvent { returnToWorkbench?: boolean }

interface BridgeConnectBotSSHPlugin {
  openTerminal(request: BridgeConnectBotSshOpenRequest): Promise<void>;
  openWorkspace(options?: { mode?: "manage" }): Promise<void>;
  listOptions(): Promise<SshOptions>;
  addListener(event: "workspaceClosed", listener: (event: SshWorkspaceClosedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "returnToWorkbench", listener: () => void): Promise<PluginListenerHandle>;
}

const NativeBridgeConnectBotSSH = registerPlugin<BridgeConnectBotSSHPlugin>("BridgeConnectBotSSH");

export function openNativeTerminal(request: BridgeConnectBotSshOpenRequest): Promise<void> {
  return NativeBridgeConnectBotSSH.openTerminal(request);
}

export function isNativeSshWorkspaceAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("BridgeConnectBotSSH");
}

export function openNativeSshWorkspace(mode?: "manage"): Promise<void> {
  return NativeBridgeConnectBotSSH.openWorkspace(mode ? { mode } : {});
}

export function listNativeSshOptions(): Promise<SshOptions> {
  return NativeBridgeConnectBotSSH.listOptions();
}

export function onNativeSshWorkspaceClosed(listener: (event: SshWorkspaceClosedEvent) => void): Promise<PluginListenerHandle> {
  return NativeBridgeConnectBotSSH.addListener("workspaceClosed", listener);
}

export function onNativeSshReturnToWorkbench(listener: () => void): Promise<PluginListenerHandle> {
  return NativeBridgeConnectBotSSH.addListener("returnToWorkbench", listener);
}
