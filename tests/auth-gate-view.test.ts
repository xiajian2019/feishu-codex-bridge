import { describe, expect, it } from "bun:test";
import { authGateView } from "../web/src/auth-gate-view.js";

const initial = { standaloneSsh: false, mobile: true, authenticated: null, offlineFallback: false, hasError: false };

describe("authentication routing", () => {
  it("routes an unauthenticated or failed native check to the connection center", () => {
    expect(authGateView({ ...initial, authenticated: false })).toBe("mobile-connection");
    expect(authGateView({ ...initial, hasError: true })).toBe("mobile-connection");
  });
  it("keeps browser pairing and the browser offline fallback", () => {
    expect(authGateView({ ...initial, mobile: false, authenticated: false })).toBe("browser-pairing");
    expect(authGateView({ ...initial, mobile: false, hasError: true })).toBe("browser-pairing");
    expect(authGateView({ ...initial, mobile: false, offlineFallback: true })).toBe("content");
  });
  it("keeps loading, authenticated content and standalone SSH available", () => {
    expect(authGateView(initial)).toBe("loading");
    expect(authGateView({ ...initial, authenticated: true })).toBe("content");
    expect(authGateView({ ...initial, standaloneSsh: true, authenticated: false })).toBe("content");
  });
});
