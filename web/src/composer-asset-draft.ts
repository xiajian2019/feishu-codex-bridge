import type { Attachment, CreateAttachment } from "@assistant-ui/react";
import { appendComposerTransferText } from "./composer-transfer-text.js";
import { composerAssetAttachment, composerAssetFromAttachment, type ComposerAssetAdoption, type ComposerAssetReference } from "./composer-asset-client.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import { loadDraftMetadata, saveDraftMetadata, type DraftAttachment } from "./tmux-draft-store.js";

export interface AssetDraftComposer {
  getState(): { text: string; attachments: readonly Attachment[] };
  setText(text: string): void;
  addAttachment(attachment: File | CreateAttachment): Promise<void>;
}

export function serializeComposerDraftAttachments(attachments: readonly Attachment[]): DraftAttachment[] {
  return attachments.flatMap((attachment) => {
    const remote = composerAssetFromAttachment(attachment);
    if (remote) return [{ id: attachment.id, name: remote.name, contentType: remote.contentType, size: remote.sizeBytes, lastModified: 0, remote }];
    if (attachment.status.type === "complete" || !attachment.file) return [];
    return [{ id: attachment.id, name: attachment.name, contentType: attachment.contentType ?? "application/octet-stream", size: attachment.file.size, lastModified: attachment.file.lastModified }];
  });
}

export function saveComposerAssetDraft(composer: AssetDraftComposer, sessionId: string, imported: Set<string>, scope = getLocalDraftScope()): boolean {
  const state = composer.getState();
  return saveDraftMetadata(sessionId, { text: state.text, attachments: serializeComposerDraftAttachments(state.attachments), importedTransferIds: [...imported].slice(-1000) }, scope);
}

/** Apply an acknowledged-by-user transfer exactly once before acknowledging it to Bridge. */
export async function applyComposerAssetAdoption(
  composer: AssetDraftComposer, sessionId: string, sessionCreatedAt: number, adoption: ComposerAssetAdoption,
  imported: Set<string>, expectedScope = getLocalDraftScope(), isCurrent: () => boolean = () => true,
): Promise<void> {
  const assertScope = (): void => {
    if (!expectedScope || expectedScope !== getLocalDraftScope() || !isCurrent()) throw new Error("Bridge、设备或 Session 已变化，草稿未继续导入。");
  };
  assertScope();
  for (const id of loadDraftMetadata(sessionId)?.importedTransferIds ?? []) imported.add(id);
  if (!imported.has(adoption.transferId)) {
    if (adoption.unavailableItemIds.length) throw new Error("部分手机附件已失效，请重新发送文件。");
    for (const item of adoption.assets) {
      assertScope();
      const asset: ComposerAssetReference = { assetId: item.assetId, transferId: adoption.transferId, sessionCreatedAt, name: item.name, contentType: item.contentType, sizeBytes: item.sizeBytes };
      if (!composer.getState().attachments.some((existing) => composerAssetFromAttachment(existing)?.assetId === asset.assetId)) {
        await composer.addAttachment(composerAssetAttachment(asset));
        assertScope();
      }
    }
    const current = composer.getState().text;
    const next = appendComposerTransferText(current, adoption.text);
    if (next !== current) composer.setText(next);
    imported.add(adoption.transferId);
  }
  assertScope();
  if (!saveComposerAssetDraft(composer, sessionId, imported, expectedScope)) throw new Error("无法保存草稿，请检查设备存储后重试。");
}
