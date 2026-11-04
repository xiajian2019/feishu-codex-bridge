import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface BridgeConnectBotSshOpenRequest {
  host: string;
  port: number;
  username: string;
  /** Origin only; the native side reads the matching token from AndroidKeyStore. */
  bridgeServerOrigin?: string;
  password?: string;
  startupCommand?: string;
  profileId?: string;
  keyId?: string;
}

export interface BridgeConnectBotSshWorkspaceRequest {
  bridgeServerOrigin?: string;
  defaultHost?: string;
  mode?: "manage";
}

export interface SshProfileOption {
  id: string; label: string; host: string; port: number; username: string; keyId: string; startupCommand: string;
}
export interface SshKeyOption { id: string; nickname: string; algorithm: string }
export interface SshOptions { profiles: SshProfileOption[]; keys: SshKeyOption[] }

export interface SshWorkspaceClosedEvent { returnToWorkbench?: boolean }
export type AppUpdateAction = "install" | "download" | "dismiss";
export interface NativeAppUpdateBanner {
  visible: boolean;
  detail?: string;
  status?: string;
  error?: string;
  busy?: boolean;
  downloaded?: boolean;
  progressPercent?: number;
  progressText?: string;
}

interface BridgeConnectBotSSHPlugin {
  openTerminal(request: BridgeConnectBotSshOpenRequest): Promise<void>;
  openWorkspace(request: BridgeConnectBotSshWorkspaceRequest): Promise<void>;
  listOptions(): Promise<SshOptions>;
  setWorkspaceVisible(options: { visible: boolean }): Promise<{ workspaceOpen: boolean }>;
  closeWorkspace(): Promise<void>;
  setUpdateBanner(options: NativeAppUpdateBanner): Promise<void>;
  addListener(event: "workspaceClosed", listener: (event: SshWorkspaceClosedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "returnToWorkbench", listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: "updateAction", listener: (event: { action: AppUpdateAction }) => void): Promise<PluginListenerHandle>;
}

const NativeBridgeConnectBotSSH = registerPlugin<BridgeConnectBotSSHPlugin>("BridgeConnectBotSSH");

export function openNativeTerminal(request: BridgeConnectBotSshOpenRequest): Promise<void> {
  return NativeBridgeConnectBotSSH.openTerminal(request);
}

export function isNativeSshWorkspaceAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("BridgeConnectBotSSH");
}

export function openNativeSshWorkspace(request: BridgeConnectBotSshWorkspaceRequest): Promise<void> {
  return NativeBridgeConnectBotSSH.openWorkspace(request);
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

export async function setNativeSshWorkspaceVisible(visible: boolean): Promise<boolean> {
  if (!isNativeSshWorkspaceAvailable()) return false;
  return (await NativeBridgeConnectBotSSH.setWorkspaceVisible({ visible })).workspaceOpen;
}

export async function closeNativeSshWorkspace(): Promise<void> {
  if (isNativeSshWorkspaceAvailable()) await NativeBridgeConnectBotSSH.closeWorkspace();
}

export async function setNativeAppUpdateBanner(banner: NativeAppUpdateBanner): Promise<void> {
  if (isNativeSshWorkspaceAvailable()) await NativeBridgeConnectBotSSH.setUpdateBanner(banner);
}

export function onNativeAppUpdateAction(listener: (action: AppUpdateAction) => void): Promise<PluginListenerHandle> {
  return NativeBridgeConnectBotSSH.addListener("updateAction", ({ action }) => listener(action));
}
