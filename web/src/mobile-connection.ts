/** Shared by the App runtime and tests; no native APIs or browser globals here. */
export interface MobileConnection {
  server: string;
  token: string | null;
}

export function isPrivateBridgeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host === "::1") return true;
  if (/^(fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127);
}

export function normalizeBridgeServer(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("请输入完整的 Bridge 地址，例如 https://mac.example.com。"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Bridge 地址需使用 HTTP 或 HTTPS，且不能包含用户名或密码。");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("请输入 Bridge 的服务地址，或粘贴完整配对链接。");
  }
  if (url.protocol === "http:" && !isPrivateBridgeHost(url.hostname)) {
    throw new Error("公网地址请使用 HTTPS；HTTP 仅用于局域网或本机连接。");
  }
  return url.origin;
}

export function parseMobilePairingInput(value: string, rawCode = "", defaultServer = ""): { server: string; code: string } {
  const text = value.trim();
  const standaloneCode = text.replace(/[\s-]/g, "").toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{12}$/.test(standaloneCode)) {
    if (!defaultServer.trim()) throw new Error("单独使用配对码时，请展开“仅有配对码”填写 Bridge 地址。");
    return { server: normalizeBridgeServer(defaultServer), code: standaloneCode };
  }
  let candidate: URL;
  try { candidate = new URL(text); }
  catch { throw new Error("请粘贴完整的配对链接，或输入 12 位配对码。"); }
  let embeddedCode: string | null = null;
  if (candidate.protocol === "bridgecodex:" && candidate.hostname === "connect") {
    const server = candidate.searchParams.get("server");
    if (!server) throw new Error("配对链接缺少 Bridge 地址。");
    embeddedCode = candidate.searchParams.get("code");
    candidate = new URL(server);
  } else if (candidate.hash) {
    embeddedCode = new URLSearchParams(candidate.hash.slice(1)).get("pair");
    if (!embeddedCode) throw new Error("配对链接中没有找到配对码。");
    candidate.hash = "";
  }
  const server = normalizeBridgeServer(candidate.toString());
  const code = (embeddedCode ?? rawCode.trim()).replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) throw new Error("请输入 12 位配对码，或粘贴 Mac 上生成的配对链接。");
  return { server, code };
}

export function isBridgeApiPath(pathname: string): boolean {
  return pathname === "/healthz" || pathname.startsWith("/api/") || pathname.startsWith("/tmux-dashboard/api/");
}

/** Credentials are attached only to Bridge API requests, never arbitrary external URLs. */
export function createMobileFetch(options: {
  pageOrigin: string;
  connection: () => MobileConnection | null;
  fetch: typeof fetch;
  unauthorized?: (connection: MobileConnection) => void;
  beforeRequest?: (method: string, pathname: string) => () => void;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const suppliedUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(suppliedUrl, options.pageOrigin);
    const connection = options.connection();
    const page = new URL(options.pageOrigin);
    // URL.origin is "null" for capacitor://, so compare protocol and host too.
    const fromApp = url.protocol === page.protocol && url.host === page.host;
    const fromBridge = connection && url.origin === connection.server;
    if ((!fromApp && !fromBridge) || !isBridgeApiPath(url.pathname)) return options.fetch(input, init);
    if (!connection) throw new Error("请先设置 Bridge 连接。");
    const target = new URL(url.pathname + url.search, connection.server);
    const original = input instanceof Request ? new Request(input, init) : null;
    const headers = new Headers(original?.headers ?? init?.headers);
    headers.delete("Authorization");
    if (connection.token) headers.set("Authorization", "Bearer " + connection.token);
    // Rewrapping a Request body turns even JSON/File into a streaming upload in
    // Chromium, which then requires HTTP/2. Keep ordinary bodies intact for LAN HTTP/1.
    const method = original?.method ?? init?.method ?? "GET";
    const release = options.beforeRequest?.(method, url.pathname);
    try {
      const body = original && original.body && method !== "GET" && method !== "HEAD"
        ? await original.arrayBuffer() : init?.body;
      const response = await options.fetch(target.toString(), {
        ...init, method, body, headers,
        ...(original ? { signal: original.signal, cache: original.cache } : {}),
        credentials: "omit", mode: "cors", redirect: "error",
      });
      const current = options.connection();
      if (current?.server !== connection.server || current.token !== connection.token) {
        throw new DOMException("Bridge connection changed", "AbortError");
      }
      if (response.status === 401 && connection.token) options.unauthorized?.(connection);
      return response;
    } finally {
      release?.();
    }
  }) as typeof fetch;
}
