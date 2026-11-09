export interface BridgeSshSessionSelection {
  bridgeOrigin: string;
  sessionId: string;
  createdAt: number;
  expectedSshHost?: string;
  expectedSshPort?: number;
}

export interface BridgeSshSessionContext extends BridgeSshSessionSelection {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
}

export class BridgeSshSessionContextError extends Error {
  readonly code = "BRIDGE_SSH_CONTEXT_MISMATCH";

  constructor(message = "Bridge、SSH 主机和 Session 上下文不一致，请刷新后重试。") {
    super(message);
    this.name = "BridgeSshSessionContextError";
  }
}

function normalizedOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new BridgeSshSessionContextError("Bridge 环境无效。");
  let url: URL;
  try { url = new URL(value); } catch { throw new BridgeSshSessionContextError("Bridge 环境无效。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new BridgeSshSessionContextError("Bridge 环境无效。");
  }
  return url.origin;
}

function normalizedHost(value: unknown): string {
  if (typeof value !== "string") throw new BridgeSshSessionContextError("SSH 主机无效。");
  const host = value.trim().replace(/^\[|\]$/g, "");
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f\/?#@]/u.test(host)) {
    throw new BridgeSshSessionContextError("SSH 主机无效。");
  }
  return host.toLowerCase();
}

function normalizedPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new BridgeSshSessionContextError("SSH 端口无效。");
  }
  return value as number;
}

function normalizedUsername(value: unknown): string {
  if (typeof value !== "string") throw new BridgeSshSessionContextError("SSH 用户名无效。");
  const username = value.trim();
  if (!username || username.length > 255 || /[\s\u0000-\u001f\u007f]/u.test(username)) {
    throw new BridgeSshSessionContextError("SSH 用户名无效。");
  }
  return username;
}

function normalizedSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^\$\d{1,16}$/u.test(value)) {
    throw new BridgeSshSessionContextError("Session ID 无效，请刷新后重试。");
  }
  return value;
}

function normalizedCreatedAt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BridgeSshSessionContextError("Session createdAt 无效，请刷新后重试。");
  }
  return value as number;
}

export function createBridgeSshSessionSelection(input: unknown): BridgeSshSessionSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BridgeSshSessionContextError();
  const value = input as Record<string, unknown>;
  const selection: BridgeSshSessionSelection = {
    bridgeOrigin: normalizedOrigin(value.bridgeOrigin),
    sessionId: normalizedSessionId(value.sessionId),
    createdAt: normalizedCreatedAt(value.createdAt),
  };
  if (value.expectedSshHost !== undefined) selection.expectedSshHost = normalizedHost(value.expectedSshHost);
  if (value.expectedSshPort !== undefined) selection.expectedSshPort = normalizedPort(value.expectedSshPort);
  return selection;
}

export function createBridgeSshSessionContext(input: unknown): BridgeSshSessionContext {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BridgeSshSessionContextError();
  const value = input as Record<string, unknown>;
  const selection = createBridgeSshSessionSelection(value);
  const context: BridgeSshSessionContext = {
    ...selection,
    sshHost: normalizedHost(value.sshHost),
    sshPort: normalizedPort(value.sshPort),
    sshUsername: normalizedUsername(value.sshUsername),
  };
  if (context.expectedSshHost && context.expectedSshHost !== context.sshHost) throw new BridgeSshSessionContextError("SSH 主机已变化，请重新选择 Session。");
  if (context.expectedSshPort !== undefined && context.expectedSshPort !== context.sshPort) throw new BridgeSshSessionContextError("SSH 端口已变化，请重新选择 Session。");
  return context;
}

export function assertSameBridgeSshSessionContext(expected: BridgeSshSessionContext, actual: BridgeSshSessionContext): void {
  if (expected.bridgeOrigin !== actual.bridgeOrigin
    || expected.sshHost !== actual.sshHost
    || expected.sshPort !== actual.sshPort
    || expected.sshUsername !== actual.sshUsername
    || expected.sessionId !== actual.sessionId
    || expected.createdAt !== actual.createdAt) {
    throw new BridgeSshSessionContextError();
  }
}

export function bridgeSshSessionContextKey(context: BridgeSshSessionContext): string {
  return [context.bridgeOrigin, context.sshHost, context.sshPort, context.sshUsername, context.sessionId, context.createdAt].join("\u0000");
}
