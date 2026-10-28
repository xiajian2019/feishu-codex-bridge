import { afterEach, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BackendFeatureGate } from "../web/src/BackendFeatureGate.js";
import { assertBridgeApiSupported, parseBridgeCapabilities, setBridgeCapabilities } from "../web/src/client-capabilities.js";
import { readBridgeJson } from "../web/src/bridge-json.js";
import { getJson } from "../web/src/api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { setBridgeCapabilities(null); globalThis.fetch = originalFetch; });
const metadata = { schemaVersion: 1, protocolVersion: 1, minimumClientProtocol: 1, version: "0.5.fixture", features: ["tmux"] };

it("distinguishes legacy metadata, absent features and an incompatible minimum client", () => {
  expect(parseBridgeCapabilities(undefined)).toBeNull();
  expect(parseBridgeCapabilities(metadata)).toMatchObject(metadata);
  expect(() => parseBridgeCapabilities({ ...metadata, minimumClientProtocol: 2 })).toThrow("更新版本的 App");
  for (const broken of [{}, { ...metadata, schemaVersion: 2 }, { ...metadata, features: "all" }]) {
    expect(() => parseBridgeCapabilities(broken)).toThrow("兼容协议");
  }
});

it("does not mount unsupported pages or send their API requests", async () => {
  setBridgeCapabilities(parseBridgeCapabilities(metadata));
  let rendered = false;
  function Body() { rendered = true; return <p>content</p>; }
  const html = renderToStaticMarkup(<BackendFeatureGate feature="backups"><Body /></BackendFeatureGate>);
  expect(rendered).toBe(false);
  expect(html).toContain("请升级后端");
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({}); }) as typeof fetch;
  await expect(getJson("/api/system/backups")).rejects.toThrow("不支持数据备份");
  expect(calls).toBe(0);
  expect(() => assertBridgeApiSupported("/tmux-dashboard/api/sessions")).not.toThrow();
});

it("reports empty and HTML API responses without exposing JSON parser errors or page content", async () => {
  await expect(readBridgeJson(new Response(""))).rejects.toThrow("空响应");
  await expect(readBridgeJson(new Response("<html>private proxy diagnostic</html>"))).rejects.toThrow("不是有效 JSON");
  globalThis.fetch = (async () => new Response("")) as typeof fetch;
  await expect(getJson("/api/projects")).rejects.toThrow("空响应");
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  await expect(getJson("/api/attachments/fixture", { method: "DELETE" })).resolves.toBeNull();
  globalThis.fetch = (async () => Response.json({ error: "Not found" }, { status: 404 })) as typeof fetch;
  await expect(getJson("/api/missing")).rejects.toThrow("当前后端不支持该接口");
});
