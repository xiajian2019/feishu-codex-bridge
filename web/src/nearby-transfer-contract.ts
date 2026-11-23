export const NEARBY_SERVICE_TYPE = "_bridge-nearby._tcp";
export const NEARBY_DEFAULT_PORT = 43_891;

export type NearbyConnectionState = "connecting" | "requested" | "connected" | "rejected" | "closed" | "failed";
export type NearbyPlatform = "android" | "ios" | "unknown";

export interface NearbyPeer {
  id: string;
  name: string;
  deviceId?: string;
  platform?: NearbyPlatform;
  host?: string;
  port?: number;
  token?: string;
  source: "mdns" | "hotspot";
}

export interface NearbyConnection {
  id: string;
  peer: NearbyPeer;
  state: NearbyConnectionState;
  incoming?: boolean;
  error?: string;
}

export interface NearbyFileOffer {
  connectionId: string;
  transferId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface NearbyReceivedFile {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: number;
  path: string;
}

export interface NearbyFileSelection {
  selectionId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface NearbyFileProgress {
  connectionId: string;
  transferId: string;
  direction: "send" | "receive";
  bytes: number;
  totalBytes: number;
}

export interface NearbyNetworkInfo {
  gateway?: string;
  addresses: string[];
  wifi: boolean;
}

export interface NearbyServerInfo {
  deviceId: string;
  displayName: string;
  port: number;
  token: string;
}

export interface NearbyError {
  code: string;
  message: string;
  connectionId?: string;
  transferId?: string;
}

export type NearbyDiagnosticLevel = "debug" | "info" | "error";

export interface NearbyDiagnostic {
  timestamp: number;
  level: NearbyDiagnosticLevel;
  phase: string;
  message: string;
  connectionId?: string;
  transferId?: string;
}

export interface NearbyListenerHandle {
  remove(): Promise<void>;
}
