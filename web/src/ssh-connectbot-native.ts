import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { BridgeSshSessionSelection } from "./bridge-ssh-session-context.js";

export type { BridgeSshSessionContext, BridgeSshSessionSelection } from "./bridge-ssh-session-context.js";

export interface BridgeConnectBotSshOpenRequest {
  host: string;
  port: number;
  username: string;
  /** Origin only; the native side keeps it as Bridge context and never receives a token. */
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
  presentation?: "sheet";
  sessionSelection?: BridgeSshSessionSelection;
}

export type NativeSshPlatform = "android" | "ios";

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
  getDefaultProfile(): Promise<{ profileId: string | null }>;
  setDefaultProfile(options: { profileId: string | null }): Promise<{ profileId: string | null }>;
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
  return getNativeSshPlatform() !== null;
}

/**
 * Native SSH presents the same request differently on each mobile platform:
 * Android embeds a Compose surface over the existing WebView, while iOS uses
 * a UIKit page sheet. Keep the platform explicit at the Web boundary so a
 * missing native plugin never turns into a misleading half-screen action.
 */
export function getNativeSshPlatform(): NativeSshPlatform | null {
  const platform = Capacitor.getPlatform();
  if ((platform !== "android" && platform !== "ios") || !Capacitor.isPluginAvailable("BridgeConnectBotSSH")) return null;
  return platform;
}

export function openNativeSshWorkspace(request: BridgeConnectBotSshWorkspaceRequest): Promise<void> {
  return NativeBridgeConnectBotSSH.openWorkspace(request);
}

export function listNativeSshOptions(): Promise<SshOptions> {
  return NativeBridgeConnectBotSSH.listOptions();
}

export function getNativeSshDefaultProfile(): Promise<string | null> {
  return NativeBridgeConnectBotSSH.getDefaultProfile().then(({ profileId }) => profileId ?? null);
}

export function setNativeSshDefaultProfile(profileId: string | null): Promise<string | null> {
  return NativeBridgeConnectBotSSH.setDefaultProfile({ profileId }).then(({ profileId: saved }) => saved ?? null);
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
