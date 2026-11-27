import { describe, expect, test } from "bun:test";
import { AppStoreConnectTestflightClient } from "../src/app-store-connect-testflight.js";

describe("AppStoreConnectTestflightClient", () => {
  test("waits for processing and adds the uploaded build to the existing internal group", async () => {
    const requests: Array<{ method: string; url: string; body?: string }> = [];
    let buildReads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ method, url, body });
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/apps") {
        return new Response(JSON.stringify({ data: [{ type: "apps", id: "app-1", attributes: { bundleId: "com.example.app" } }] }), { status: 200 });
      }
      if (parsed.pathname === "/v1/betaGroups") {
        return new Response(JSON.stringify({ data: [{ type: "betaGroups", id: "group-1", attributes: { name: "测试", isInternalGroup: true } }] }), { status: 200 });
      }
      if (parsed.pathname === "/v1/apps/app-1/builds") {
        buildReads += 1;
        const processingState = buildReads === 1 ? "PROCESSING" : "VALID";
        return new Response(JSON.stringify({ data: [{ type: "builds", id: "build-1", attributes: { version: "3", processingState } }] }), { status: 200 });
      }
      if (parsed.pathname === "/v1/builds/build-1/relationships/betaGroups" && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (parsed.pathname === "/v1/builds/build-1/relationships/betaGroups" && method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ errors: [{ detail: `unexpected request: ${method} ${url}` }] }), { status: 500 });
    };

    const client = new AppStoreConnectTestflightClient({
      keyPath: "unused",
      keyId: "unused",
      issuerId: "unused",
      apiRoot: "https://api.test",
      tokenProvider: () => "test-token",
      fetcher,
      pollIntervalMs: 0,
      maxAttempts: 2,
    });

    await expect(client.attachBuildToInternalGroup("com.example.app", 3, "测试")).resolves.toEqual({
      appId: "app-1",
      buildId: "build-1",
      betaGroupId: "group-1",
      betaGroupName: "测试",
    });
    const buildRequests = requests.filter((request) => request.url.includes("/v1/apps/app-1/builds"));
    expect(buildRequests.length).toBeGreaterThan(0);
    expect(buildRequests.every((request) => {
      const query = new URL(request.url).searchParams;
      return !query.has("filter[version]") && !query.has("sort") && query.get("limit") === "200";
    })).toBe(true);
    expect(requests.some((request) => request.method === "POST" && JSON.parse(request.body ?? "{}").data?.[0]?.id === "group-1")).toBe(true);
  });
});
