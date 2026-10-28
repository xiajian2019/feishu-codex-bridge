import { describe, expect, it } from "bun:test";
import { createMobileFetch, normalizeBridgeServer, parseMobilePairingInput, type MobileConnection } from "../web/src/mobile-connection.js";

describe("mobile connection configuration", () => {
  it("accepts HTTPS and LAN HTTP, rejects public cleartext, credentials and subpaths", () => {
    expect(normalizeBridgeServer(" https://bridge.example.com/ ")).toBe("https://bridge.example.com");
    for (const host of ["192.168.1.2", "10.1.2.3", "172.16.0.2", "mac.local", "100.100.1.2", "[fd12::1]"]) {
      expect(normalizeBridgeServer(`http://${host}:17310`)).toBe(`http://${host}:17310`);
    }
    for (const value of ["http://example.com", "http://172.32.0.1", "https://user:secret@bridge.example.com", "file:///tmp", "https://bridge.example.com/api", "https://bridge.example.com?token=secret"]) {
      expect(() => normalizeBridgeServer(value)).toThrow();
    }
  });

  it("reads browser pairing links without leaking the code into the saved address", () => {
    expect(parseMobilePairingInput("https://bridge.example.com/#pair=ABCD-EFGH-JKLM")).toEqual({ server: "https://bridge.example.com", code: "ABCDEFGHJKLM" });
    expect(parseMobilePairingInput("http://192.168.1.2:17310", "abcd efgh jklm")).toEqual({ server: "http://192.168.1.2:17310", code: "ABCDEFGHJKLM" });
    expect(parseMobilePairingInput("bridgecodex://connect?server=https%3A%2F%2Fbridge.example.com&code=ABCDEFGHJKLM")).toEqual({ server: "https://bridge.example.com", code: "ABCDEFGHJKLM" });
    expect(() => parseMobilePairingInput("https://bridge.example.com", "123")).toThrow();
    expect(() => parseMobilePairingInput("https://bridge.example.com/#other=secret")).toThrow();
  });

  it("uses the code and server carried by a pasted link instead of stale manual values", () => {
    expect(parseMobilePairingInput("http://10.15.55.17:7310/#pair=ABCD-EFGH-JKLM", "NPQRSTUVWXYZ", "http://192.168.1.2:17310"))
      .toEqual({ server: "http://10.15.55.17:7310", code: "ABCDEFGHJKLM" });
    expect(parseMobilePairingInput("bridgecodex://connect?server=https%3A%2F%2Fbridge.example.com&code=ABCDEFGHJKLM", "NPQRSTUVWXYZ"))
      .toEqual({ server: "https://bridge.example.com", code: "ABCDEFGHJKLM" });
  });

  it("accepts a standalone code in the unified input with an explicitly selected Bridge", () => {
    expect(parseMobilePairingInput(" abcd-efgh-jklm ", "", "http://10.15.55.17:7310"))
      .toEqual({ server: "http://10.15.55.17:7310", code: "ABCDEFGHJKLM" });
    expect(() => parseMobilePairingInput("ABCD-EFGH-JKLM")).toThrow("仅有配对码");
    for (const server of ["http://public.example.com", "https://user:secret@bridge.example.com", "file:///tmp", "https://bridge.example.com/api"]) {
      expect(() => parseMobilePairingInput("ABCD-EFGH-JKLM", "", server)).toThrow();
    }
  });

  it("does not replace an invalid embedded pairing code with a stale fallback", () => {
    expect(() => parseMobilePairingInput("https://bridge.example.com/#pair=invalid", "ABCDEFGHJKLM")).toThrow("12 位配对码");
    expect(() => parseMobilePairingInput("https://bridge.example.com/#pair=", "ABCDEFGHJKLM")).toThrow("没有找到配对码");
    expect(() => parseMobilePairingInput("https://bridge.example.com/#other=value", "ABCDEFGHJKLM")).toThrow("没有找到配对码");
  });
});

describe("mobile fetch credential boundaries", () => {
  it("rewrites only Bridge APIs and preserves writes and Action Tokens", async () => {
    const requests: Request[] = [];
    let requestOptions: RequestInit | undefined;
    const connection: MobileConnection = { server: "https://mac.example.com", token: "private-token" };
    const transport = createMobileFetch({ pageOrigin: "capacitor://localhost/", connection: () => connection,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { requests.push(new Request(input, init)); requestOptions = init; return new Response("{}"); }) as typeof fetch });
    await transport("/api/tasks", { method: "POST", headers: { "X-Bridge-Action-Token": "action", "Content-Type": "application/json" }, body: '{"text":"hello"}' });
    const request = requests[0]!;
    expect(request.url).toBe("https://mac.example.com/api/tasks");
    expect(request.headers.get("Authorization")).toBe("Bearer private-token");
    expect(request.headers.get("X-Bridge-Action-Token")).toBe("action");
    expect(await request.text()).toBe('{"text":"hello"}');
    expect(requestOptions?.credentials).toBe("omit");
    expect(requestOptions?.redirect).toBe("error");
    expect(requestOptions?.body).toBe('{"text":"hello"}');
  });

  it("does not send App credentials to arbitrary origins, opaque URLs, or static assets", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const transport = createMobileFetch({ pageOrigin: "capacitor://localhost/", connection: () => ({ server: "https://mac.example.com", token: "private-token" }),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ input, init }); return new Response(""); }) as typeof fetch });
    for (const url of ["https://other.example.com/api/tasks", "capacitor://other/api/tasks", "data:text/plain,hi", "/assets/icon.png"]) await transport(url);
    expect(calls.every((call) => typeof call.input === "string" && call.init === undefined)).toBe(true);
  });

  it("uses the current connection and reports unauthorized only for its captured credential", async () => {
    let connection: MobileConnection = { server: "https://one.example.com", token: "one" };
    const unauthorized: MobileConnection[] = [];
    const requests: Request[] = [];
    const transport = createMobileFetch({ pageOrigin: "http://localhost/", connection: () => connection,
      unauthorized: (failed) => unauthorized.push(failed),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { requests.push(new Request(input, init)); return new Response("{}", { status: 401 }); }) as typeof fetch });
    await transport("/tmux-dashboard/api/sessions");
    connection = { server: "https://two.example.com", token: "two" };
    await transport("/api/projects");
    expect(requests.map((request) => request.headers.get("Authorization"))).toEqual(["Bearer one", "Bearer two"]);
    expect(unauthorized.map((failed) => failed.server)).toEqual(["https://one.example.com", "https://two.example.com"]);
  });

  it("keeps file uploads as File bodies on HTTP/1 and preserves AbortSignal", async () => {
    const file = new File(["fixture"], "fixture.txt", { type: "text/plain" });
    const controller = new AbortController();
    let sent: RequestInit | undefined;
    const transport = createMobileFetch({ pageOrigin: "capacitor://localhost/", connection: () => ({ server: "http://192.168.1.2:17310", token: "fixture" }),
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => { sent = init; return new Response("{}"); }) as typeof fetch });
    await transport("/tmux-dashboard/api/attachments", { method: "POST", body: file, signal: controller.signal });
    expect(sent?.body).toBe(file);
    expect(sent?.signal).toBe(controller.signal);
    expect(sent?.body instanceof ReadableStream).toBe(false);
  });

  it("discards an old server's in-flight response after switching connections", async () => {
    let connection: MobileConnection = { server: "https://one.example.com", token: "one" };
    let complete!: (response: Response) => void;
    const transport = createMobileFetch({ pageOrigin: "capacitor://localhost/", connection: () => connection,
      fetch: (() => new Promise<Response>((resolve) => { complete = resolve; })) as typeof fetch });
    const pending = transport("/api/auth/status");
    connection = { server: "https://two.example.com", token: "two" };
    complete(new Response('{"authenticated":true,"draftScope":"old-server"}'));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
