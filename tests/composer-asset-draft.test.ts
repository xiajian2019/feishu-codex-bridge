import { afterEach, beforeEach, expect, it } from "bun:test";
import type { Attachment, CreateAttachment } from "@assistant-ui/react";
import { applyComposerAssetAdoption, serializeComposerDraftAttachments, type AssetDraftComposer } from "../web/src/composer-asset-draft.js";
import { composerAssetAttachment, composerAssetFromAttachment, type ComposerAssetAdoption } from "../web/src/composer-asset-client.js";
import { getLocalDraftScope, setLocalDraftScope } from "../web/src/local-draft-scope.js";
import { loadDraftMetadata } from "../web/src/tmux-draft-store.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const values = new Map<string, string>();
let storageFails = false;
const storage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
  getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (storageFails) throw new Error("quota"); values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() };
const adoption: ComposerAssetAdoption = { transferId: "composer_transfer_11111111-1111-4111-8111-111111111111", text: "  新文字  ", unavailableItemIds: [], assets: [
  { assetId: "composer_item_22222222-2222-4222-8222-222222222222", itemId: "composer_item_22222222-2222-4222-8222-222222222222", name: "phone.png", contentType: "image/png", sizeBytes: 104857600 },
] };

function composer(initialText = "已有内容  \n"): AssetDraftComposer {
  const local = new File(["old"], "old.txt", { type: "text/plain" });
  let state: { text: string; attachments: Attachment[] } = { text: initialText, attachments: [{ id: "local", type: "file", name: local.name, contentType: local.type, file: local, status: { type: "requires-action", reason: "composer-send" } }] };
  return {
    getState: () => state,
    setText: (text) => { state = { ...state, text }; },
    async addAttachment(value: File | CreateAttachment) {
      if (value instanceof File) throw new Error("unexpected full file");
      state = { ...state, attachments: [...state.attachments, { ...value, id: value.id!, type: value.type ?? "file", status: { type: "complete" } }] };
    },
  };
}

beforeEach(() => {
  values.clear(); storageFails = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, location: { origin: "http://localhost" }, dispatchEvent() {} } });
  setLocalDraftScope("a".repeat(43), "http://localhost:5173");
});
afterEach(() => { setLocalDraftScope(null); if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });

it("appends remote references once and persists metadata without a full File", async () => {
  const draft = composer();
  const seen = new Set<string>();
  await applyComposerAssetAdoption(draft, "$41", 41, adoption, seen);
  expect(draft.getState().text).toBe("已有内容  \n\n  新文字  ");
  expect(draft.getState().attachments).toHaveLength(2);
  expect(draft.getState().attachments[1]?.file).toBeUndefined();
  expect(composerAssetFromAttachment(draft.getState().attachments[1]!)?.sizeBytes).toBe(104857600);
  const saved = loadDraftMetadata("$41")!;
  expect(saved.attachments).toHaveLength(2);
  expect(saved.attachments[1]?.remote?.assetId).toBe(adoption.assets[0]!.assetId);
  expect(saved.importedTransferIds).toEqual([adoption.transferId]);
  await applyComposerAssetAdoption(draft, "$41", 41, adoption, seen);
  expect(draft.getState().text).toBe("已有内容  \n\n  新文字  ");
  expect(draft.getState().attachments).toHaveLength(2);
  expect(composerAssetAttachment(saved.attachments[1]!.remote!).id).toBe(draft.getState().attachments[1]!.id);
});

it("retries a failed draft save without adding text or files twice", async () => {
  const draft = composer(); const seen = new Set<string>();
  storageFails = true;
  await expect(applyComposerAssetAdoption(draft, "$41", 41, adoption, seen)).rejects.toThrow("无法保存草稿");
  storageFails = false;
  await applyComposerAssetAdoption(draft, "$41", 41, adoption, seen);
  expect(draft.getState().text).toBe("已有内容  \n\n  新文字  ");
  expect(draft.getState().attachments).toHaveLength(2);
  expect(loadDraftMetadata("$41")?.importedTransferIds).toEqual([adoption.transferId]);
});

it("does not apply an adoption after the device scope changes", async () => {
  const draft = composer(); const oldScope = getLocalDraftScope();
  setLocalDraftScope("b".repeat(43), "http://localhost:5173");
  await expect(applyComposerAssetAdoption(draft, "$41", 41, adoption, new Set(), oldScope)).rejects.toThrow("Bridge、设备或 Session 已变化");
  expect(draft.getState().text).toBe("已有内容  \n");
  expect(draft.getState().attachments).toHaveLength(1);
});
