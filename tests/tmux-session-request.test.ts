import { describe, expect, it } from "bun:test";
import { requestTmuxSessions } from "../web/src/tmux-session-request.js";

const url = "/tmux-dashboard/api/sessions?includeHomes=0";
const payload = JSON.stringify({ sessions: [{ id: "$1" }] });

describe("Session list transient failure recovery", () => {
  it("retries a single foreground timeout with a new controller even when fetch ignores abort", async () => {
    const signals: AbortSignal[] = [];
    const retries: string[] = [];
    const result = await requestTmuxSessions(url, {
      signal: new AbortController().signal, timeoutMs: 10, retryTimeoutMs: 50,
      onRetry: (details) => retries.push(details.reason),
      fetcher: async (_url, init) => {
        signals.push(init!.signal!);
        expect(init!.cache).toBe("no-store");
        return signals.length === 1 ? new Promise<Response>(() => {}) : new Response(payload);
      },
    });
    expect(result.rawResponse).toBe(payload);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(retries).toEqual(["Session 列表请求超时，请重试。"]);
  });

  it("retries a network error and a temporary proxy error exactly once", async () => {
    for (const failure of ["network", "proxy"]) {
      let calls = 0;
      const result = await requestTmuxSessions(url, {
        signal: new AbortController().signal,
        fetcher: async () => {
          calls += 1;
          if (calls === 1) {
            if (failure === "network") throw new TypeError("Failed to fetch");
            return new Response("<html>gateway down</html>", { status: 502 });
          }
          return new Response(payload);
        },
      });
      expect(result.status).toBe(200);
      expect(calls).toBe(2);
    }
  });

  it("bounds reading the response body as well as opening the connection", async () => {
    let calls = 0;
    const result = await requestTmuxSessions(url, {
      signal: new AbortController().signal, timeoutMs: 10,
      fetcher: async () => ++calls === 1 ? new Response(new ReadableStream()) : new Response(payload),
    });
    expect(result.rawResponse).toBe(payload);
    expect(calls).toBe(2);
  });

  it("cancels without retrying or reporting an offline failure when visibility changes", async () => {
    const controller = new AbortController();
    let calls = 0;
    let retries = 0;
    const pending = requestTmuxSessions(url, {
      signal: controller.signal, onRetry: () => { retries += 1; },
      fetcher: async () => { calls += 1; return new Promise<Response>(() => {}); },
    });
    controller.abort(new Error("visibility changed"));
    await expect(pending).rejects.toThrow("visibility changed");
    expect(calls).toBe(1);
    expect(retries).toBe(0);
  });

  it("keeps persistent failures visible after the bounded retry", async () => {
    let calls = 0;
    await expect(requestTmuxSessions(url, {
      signal: new AbortController().signal, timeoutMs: 10, retryTimeoutMs: 10,
      fetcher: async () => { calls += 1; return new Promise<Response>(() => {}); },
    })).rejects.toThrow("Session 列表请求超时");
    expect(calls).toBe(2);
  });

  it("does not retry rejected pairing or client requests", async () => {
    let calls = 0;
    await expect(requestTmuxSessions(url, {
      signal: new AbortController().signal,
      fetcher: async () => { calls += 1; return new Response('{"error":"pairing required"}', { status: 401 }); },
    })).rejects.toThrow("pairing required");
    expect(calls).toBe(1);
  });
});
