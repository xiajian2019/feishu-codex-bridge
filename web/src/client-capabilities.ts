export const CLIENT_PROTOCOL_VERSION = 1;
export type BridgeFeature = "tmux" | "codex-history" | "download-uploads" | "mobile-apk-update" | "backups";
export interface BridgeCapabilities {
  schemaVersion: 1;
  protocolVersion: number;
  minimumClientProtocol: number;
  version: string;
  features: BridgeFeature[];
}
let current: BridgeCapabilities | null = null;
const labels: Record<BridgeFeature, string> = {
  tmux: "终端与 Session 文件", "codex-history": "Codex 历史", "download-uploads": "文件上传",
  "mobile-apk-update": "App 更新", backups: "数据备份",
};

export function parseBridgeCapabilities(value: unknown): BridgeCapabilities | null {
  // Missing metadata means a legacy backend, not "all capabilities supported".
  if (value === undefined || value === null) return null;
  const row = value as Partial<BridgeCapabilities>;
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.protocolVersion) || Number(row.protocolVersion) < 1
    || !Number.isSafeInteger(row.minimumClientProtocol) || Number(row.minimumClientProtocol) < 1
    || typeof row.version !== "string" || !Array.isArray(row.features) || row.features.some((item) => typeof item !== "string")) {
    throw new Error("当前后端的兼容协议无法识别，请升级 App 或后端。");
  }
  if (Number(row.minimumClientProtocol) > CLIENT_PROTOCOL_VERSION) {
    throw new Error("当前后端需要更新版本的 App，请先更新 App。");
  }
  return { ...row, features: [...row.features] } as BridgeCapabilities;
}
export function setBridgeCapabilities(value: BridgeCapabilities | null): void { current = value; }
export function getBridgeCapabilities(): BridgeCapabilities | null { return current; }
export function bridgeFeatureUnavailable(feature: BridgeFeature): string | null {
  return current && !current.features.includes(feature) ? `当前后端不支持${labels[feature]}，请升级后端或切换环境。` : null;
}
export function assertBridgeApiSupported(path: string): void {
  let feature: BridgeFeature | undefined;
  if (path.startsWith("/tmux-dashboard/")) feature = "tmux";
  else if (path.startsWith("/api/codex/threads") || path === "/api/codex/homes") feature = "codex-history";
  else if (path.startsWith("/api/download-uploads")) feature = "download-uploads";
  else if (path.startsWith("/api/mobile/update")) feature = "mobile-apk-update";
  else if (path.startsWith("/api/system/backups")) feature = "backups";
  const message = feature && bridgeFeatureUnavailable(feature);
  if (message) throw new Error(message);
}
