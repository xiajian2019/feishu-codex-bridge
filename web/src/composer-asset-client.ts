import type { Attachment, CreateAttachment } from "@assistant-ui/react";
import { getActionToken } from "./api.js";
import { readBridgeJson } from "./bridge-json.js";
import { getBridgeCapabilities } from "./client-capabilities.js";

const PREFIX = "bridge-composer-asset:";
const ASSET_ID = /^composer_item_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TRANSFER_ID = /^composer_transfer_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class ComposerAssetRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export interface ComposerAssetReference {
  assetId: string;
  transferId: string;
  sessionCreatedAt: number;
  name: string;
  contentType: string;
  sizeBytes: number;
}
export interface ComposerAssetAdoption {
  transferId: string;
  text: string;
  assets: Array<{ assetId: string; itemId: string; name: string; contentType: string; sizeBytes: number }>;
  unavailableItemIds: string[];
}
export interface ResolvedComposerAsset {
  assetId: string;
  path: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}

export function supportsComposerAssets(): boolean {
  return getBridgeCapabilities()?.features.includes("composer-transfer-assets") === true;
}

export function isComposerAssetReference(value: unknown): value is ComposerAssetReference {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<ComposerAssetReference>;
  return typeof asset.assetId === "string" && ASSET_ID.test(asset.assetId)
    && typeof asset.transferId === "string" && TRANSFER_ID.test(asset.transferId)
    && Number.isSafeInteger(asset.sessionCreatedAt) && Number(asset.sessionCreatedAt) >= 0
    && typeof asset.name === "string" && asset.name.length > 0 && asset.name.length <= 1024
    && typeof asset.contentType === "string" && asset.contentType.length <= 256
    && Number.isSafeInteger(asset.sizeBytes) && Number(asset.sizeBytes) > 0;
}

export function composerAssetAttachment(asset: ComposerAssetReference): CreateAttachment {
  if (!isComposerAssetReference(asset)) throw new Error("草稿附件引用无效。");
  return {
    id: PREFIX + asset.assetId,
    type: asset.contentType.startsWith("image/") ? "image" : "file",
    name: asset.name,
    contentType: asset.contentType,
    content: [{ type: "text", text: PREFIX + JSON.stringify(asset) }],
  };
}

export function composerAssetFromAttachment(attachment: Pick<Attachment, "id" | "content">): ComposerAssetReference | null {
  if (!attachment.id.startsWith(PREFIX) || !attachment.content || attachment.content.length !== 1) return null;
  const part = attachment.content[0];
  if (!part || part.type !== "text" || !part.text.startsWith(PREFIX)) return null;
  try {
    const asset: unknown = JSON.parse(part.text.slice(PREFIX.length));
    return isComposerAssetReference(asset) && attachment.id === PREFIX + asset.assetId ? asset : null;
  } catch { return null; }
}

function sessionRoot(sessionId: string): string {
  return `/tmux-dashboard/api/sessions/${encodeURIComponent(sessionId)}/composer-assets`;
}
function transferRoot(sessionId: string, targetId: string, transferId: string): string {
  return `/tmux-dashboard/api/sessions/${encodeURIComponent(sessionId)}/composer-transfer/${encodeURIComponent(targetId)}/${encodeURIComponent(transferId)}`;
}
async function jsonRequest<T>(url: string, sessionCreatedAt: number, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Bridge-Session-Created-At", String(sessionCreatedAt));
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", "application/json");
    headers.set("X-Bridge-Action-Token", await getActionToken(init.signal ?? undefined));
  }
  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  const payload = await readBridgeJson<T & { error?: string }>(response);
  if (!response.ok) throw new ComposerAssetRequestError(payload.error || `草稿附件请求失败（${response.status}）。`, response.status);
  return payload;
}
function validateAdoption(value: ComposerAssetAdoption): ComposerAssetAdoption {
  if (!value || !TRANSFER_ID.test(value.transferId) || typeof value.text !== "string" || !Array.isArray(value.assets)
    || !Array.isArray(value.unavailableItemIds) || value.unavailableItemIds.some((id) => typeof id !== "string" || !ASSET_ID.test(id))
    || value.assets.some((item) => !item || !ASSET_ID.test(item.assetId) || item.itemId !== item.assetId || typeof item.name !== "string"
      || typeof item.contentType !== "string" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0)) {
    throw new Error("Bridge 返回的草稿附件信息无效。");
  }
  return value;
}
export async function adoptComposerTransfer(sessionId: string, sessionCreatedAt: number, targetId: string, transferId: string): Promise<ComposerAssetAdoption> {
  return validateAdoption(await jsonRequest<ComposerAssetAdoption>(transferRoot(sessionId, targetId, transferId) + "/adopt", sessionCreatedAt, { method: "POST", body: "{}" }));
}
export async function pendingComposerAdoptions(sessionId: string, sessionCreatedAt: number): Promise<{ adoptions: ComposerAssetAdoption[]; preparing: Array<{ targetId: string; transferId: string }> }> {
  const payload = await jsonRequest<{ adoptions: ComposerAssetAdoption[]; preparing: Array<{ targetId: string; transferId: string }> }>(sessionRoot(sessionId) + "/pending", sessionCreatedAt);
  if (!Array.isArray(payload.adoptions) || !Array.isArray(payload.preparing)
    || payload.preparing.some((entry) => !entry || typeof entry.targetId !== "string" || !/^composer_target_[a-f0-9-]{36}$/i.test(entry.targetId)
      || typeof entry.transferId !== "string" || !TRANSFER_ID.test(entry.transferId))) throw new Error("Bridge 返回的待恢复附件信息无效。");
  return { adoptions: payload.adoptions.map(validateAdoption), preparing: payload.preparing };
}
export async function acknowledgeComposerAdoption(sessionId: string, sessionCreatedAt: number, transferId: string): Promise<void> {
  await jsonRequest(sessionRoot(sessionId) + `/adoptions/${encodeURIComponent(transferId)}/ack`, sessionCreatedAt, { method: "POST", body: "{}" });
}
export async function resolveComposerAssets(sessionId: string, sessionCreatedAt: number, assets: ComposerAssetReference[]): Promise<ResolvedComposerAsset[]> {
  const resolved: ResolvedComposerAsset[] = [];
  for (let offset = 0; offset < assets.length; offset += 64) {
    const batch = assets.slice(offset, offset + 64);
    const payload = await jsonRequest<{ assets: ResolvedComposerAsset[] }>(sessionRoot(sessionId) + "/resolve", sessionCreatedAt, {
      method: "POST", body: JSON.stringify({ assetIds: batch.map((asset) => asset.assetId) }),
    });
    if (!Array.isArray(payload.assets) || payload.assets.length !== batch.length
      || payload.assets.some((asset) => !asset || !ASSET_ID.test(asset.assetId) || typeof asset.path !== "string" || !asset.path
        || typeof asset.name !== "string" || typeof asset.contentType !== "string" || !Number.isSafeInteger(asset.sizeBytes))) {
      throw new Error("Bridge 返回的附件路径无效。");
    }
    const expected = new Set(batch.map((asset) => asset.assetId));
    if (new Set(payload.assets.map((asset) => asset.assetId)).size !== expected.size || payload.assets.some((asset) => !expected.has(asset.assetId))) {
      throw new Error("Bridge 返回的附件与草稿不匹配。");
    }
    resolved.push(...payload.assets);
  }
  return resolved;
}
export async function touchComposerAssets(sessionId: string, sessionCreatedAt: number, assets: ComposerAssetReference[]): Promise<void> {
  for (let offset = 0; offset < assets.length; offset += 64) {
    await jsonRequest(sessionRoot(sessionId) + "/touch", sessionCreatedAt, { method: "POST", body: JSON.stringify({ assetIds: assets.slice(offset, offset + 64).map((asset) => asset.assetId) }) });
  }
}
export async function releaseComposerAsset(sessionId: string, sessionCreatedAt: number, assetId: string): Promise<void> {
  await jsonRequest(sessionRoot(sessionId) + `/${encodeURIComponent(assetId)}`, sessionCreatedAt, { method: "DELETE" });
}
export async function readComposerAsset(sessionId: string, sessionCreatedAt: number, assetId: string, signal: AbortSignal, thumbnail = false): Promise<Blob | null> {
  const response = await fetch(sessionRoot(sessionId) + `/${encodeURIComponent(assetId)}/content${thumbnail ? "?thumbnail=1" : ""}`, {
    headers: { "X-Bridge-Session-Created-At": String(sessionCreatedAt) }, signal, cache: "no-store",
  });
  if (thumbnail && response.status === 204) return null;
  if (!response.ok) {
    const payload = await readBridgeJson<{ error?: string }>(response);
    throw new Error(payload.error || `读取草稿附件失败（${response.status}）。`);
  }
  return response.blob();
}
