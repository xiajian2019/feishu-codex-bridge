import { describe, expect, it } from "bun:test";
import { authStateKey, readGlobalAuthState, writeGlobalAuthState } from "../web/src/auth-state.js";

describe("global authentication state", () => {
  it("isolates metadata by Bridge origin and opaque device scope", () => {
    const state = { authenticated: true, status: { authenticated: true }, error: null, offlineFallback: false };
    writeGlobalAuthState("https://one.example.com", "device-one", state);
    expect(readGlobalAuthState("https://one.example.com", "device-one")).toEqual(state);
    expect(readGlobalAuthState("https://one.example.com", "device-two")).toBeNull();
    expect(readGlobalAuthState("https://two.example.com", "device-one")).toBeNull();
  });

  it("normalizes the server to an origin without retaining URL secrets", () => {
    const key = authStateKey("https://bridge.example.com/private?token=secret", "device-one");
    expect(key).toContain(encodeURIComponent("https://bridge.example.com"));
    expect(key).not.toContain("secret");
    expect(key).not.toContain("token");
  });
});
