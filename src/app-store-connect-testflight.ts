import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API_ROOT = "https://api.appstoreconnect.apple.com";

interface AppStoreConnectResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
}

interface AppStoreConnectResponse {
  data?: AppStoreConnectResource[];
  errors?: Array<{ code?: string; title?: string; detail?: string }>;
}

export interface AppStoreConnectTestflightClientOptions {
  keyPath: string;
  keyId: string;
  issuerId: string;
  fetcher?: typeof fetch;
  apiRoot?: string;
  tokenProvider?: () => string;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export interface AttachedBetaGroup {
  appId: string;
  buildId: string;
  betaGroupId: string;
  betaGroupName: string;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function createApiToken(options: Pick<AppStoreConnectTestflightClientOptions, "keyPath" | "keyId" | "issuerId">): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: options.keyId, typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: options.issuerId,
    iat: now - 30,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({ key: readFileSync(options.keyPath), dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${base64Url(signature)}`;
}

function errorMessage(payload: AppStoreConnectResponse, status: number): string {
  const details = payload.errors?.map((error) => error.detail || error.title || error.code).filter(Boolean).join("；");
  return `App Store Connect API 请求失败（${status}）${details ? `：${details}` : "。"}`;
}

function resourceAttribute(resource: AppStoreConnectResource, key: string): unknown {
  return resource.attributes?.[key];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AppStoreConnectTestflightClient {
  private readonly fetcher: typeof fetch;
  private readonly apiRoot: string;
  private readonly tokenProvider: () => string;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;

  public constructor(options: AppStoreConnectTestflightClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.apiRoot = (options.apiRoot ?? API_ROOT).replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider ?? (() => createApiToken(options));
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 40;
  }

  private async request<T extends AppStoreConnectResponse>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.apiRoot}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${this.tokenProvider()}`,
      },
    });
    const text = await response.text();
    let payload: T;
    try {
      payload = (text ? JSON.parse(text) : {}) as T;
    } catch {
      payload = {} as T;
    }
    if (!response.ok) throw new Error(errorMessage(payload, response.status));
    return payload;
  }

  private async findAppId(bundleId: string): Promise<string> {
    const query = new URLSearchParams({ "filter[bundleId]": bundleId, limit: "200" });
    const result = await this.request<{ data?: AppStoreConnectResource[] }>(`/v1/apps?${query}`);
    const app = result.data?.find((item) => resourceAttribute(item, "bundleId") === bundleId) ?? result.data?.[0];
    if (!app) throw new Error(`App Store Connect 中找不到 Bundle ID 为 ${bundleId} 的 App。`);
    return app.id;
  }

  private async findInternalGroup(appId: string, bundleId: string, groupName: string): Promise<AppStoreConnectResource> {
    const query = new URLSearchParams({
      "filter[app]": appId,
      "filter[isInternalGroup]": "true",
      limit: "200",
    });
    const result = await this.request<{ data?: AppStoreConnectResource[] }>(`/v1/betaGroups?${query}`);
    const group = result.data?.find((item) => resourceAttribute(item, "name") === groupName
      && resourceAttribute(item, "isInternalGroup") === true);
    if (!group) throw new Error(`App Store Connect 中找不到 Bundle ID 为 ${bundleId} 的内部测试群组“${groupName}”。`);
    return group;
  }

  private async findBuild(appId: string, buildNumber: number): Promise<AppStoreConnectResource | null> {
    // The app-scoped builds endpoint currently rejects filter[version] and sort
    // even though those parameters are accepted by the global builds endpoint.
    // Fetch the allowed page and match the build number locally instead.
    const query = new URLSearchParams({ limit: "200" });
    const result = await this.request<{ data?: AppStoreConnectResource[] }>(`/v1/apps/${encodeURIComponent(appId)}/builds?${query}`);
    return result.data?.find((item) => resourceAttribute(item, "version") === String(buildNumber)) ?? null;
  }

  private async buildHasGroup(buildId: string, groupId: string): Promise<boolean> {
    const result = await this.request<{ data?: AppStoreConnectResource[] }>(`/v1/builds/${encodeURIComponent(buildId)}/relationships/betaGroups?limit=200`);
    return Boolean(result.data?.some((item) => item.id === groupId));
  }

  public async attachBuildToInternalGroup(bundleId: string, buildNumber: number, groupName: string): Promise<AttachedBetaGroup> {
    const appId = await this.findAppId(bundleId);
    const group = await this.findInternalGroup(appId, bundleId, groupName);
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const build = await this.findBuild(appId, buildNumber);
      const processingState = build ? resourceAttribute(build, "processingState") : null;
      if (build && processingState === "VALID") {
        if (!(await this.buildHasGroup(build.id, group.id))) {
          await this.request(`/v1/builds/${encodeURIComponent(build.id)}/relationships/betaGroups`, {
            method: "POST",
            body: JSON.stringify({ data: [{ type: "betaGroups", id: group.id }] }),
          });
        }
        return { appId, buildId: build.id, betaGroupId: group.id, betaGroupName: groupName };
      }
      if (processingState === "FAILED" || processingState === "INVALID") {
        throw new Error(`构建 ${buildNumber} 在 App Store Connect Processing 失败（${processingState}）。`);
      }
      if (attempt + 1 < this.maxAttempts) await delay(this.pollIntervalMs);
    }
    throw new Error(`构建 ${buildNumber} 在 App Store Connect 仍未完成 Processing，暂未加入内部测试群组“${groupName}”。`);
  }
}
