import { afterEach, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolveComposerAssets, touchComposerAssets, type ComposerAssetReference } from "../web/src/composer-asset-client.js";

const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
});

it("handles more than one server batch without imposing a Composer attachment count limit", async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ content: "fixture-action" }) } });
  const calls: Array<{ path: string; count: number }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body)) as { assetIds: string[] }).assetIds;
    calls.push({ path: String(input), count: ids.length });
    return new Response(JSON.stringify(String(input).endsWith("/resolve")
      ? { assets: ids.map((assetId) => ({ assetId, path: `/tmp/${assetId}`, name: "file.bin", contentType: "application/octet-stream", sizeBytes: 1 })) }
      : { ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const assets: ComposerAssetReference[] = Array.from({ length: 129 }, () => ({
    assetId: "composer_item_" + randomUUID(), transferId: "composer_transfer_" + randomUUID(), sessionCreatedAt: 41,
    name: "file.bin", contentType: "application/octet-stream", sizeBytes: 1,
  }));
  const resolved = await resolveComposerAssets("$41", 41, assets);
  expect(resolved).toHaveLength(129);
  await touchComposerAssets("$41", 41, assets);
  expect(calls.filter((call) => call.path.endsWith("/resolve")).map((call) => call.count)).toEqual([64, 64, 1]);
  expect(calls.filter((call) => call.path.endsWith("/touch")).map((call) => call.count)).toEqual([64, 64, 1]);
});
