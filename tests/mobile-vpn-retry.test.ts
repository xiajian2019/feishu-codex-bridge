import { describe, expect, it } from "bun:test";
import { createMobileVpnRetry } from "../web/src/mobile-vpn-retry.js";

describe("VPN target recovery", () => {
  it("retries an unavailable Bridge as soon as the target is reachable", () => {
    let attempts = 0;
    const recovery = createMobileVpnRetry(() => { attempts += 1; });
    recovery.onReachable("unavailable", false);
    expect(attempts).toBe(1);
  });

  it("keeps an API outage pending even when the connection center is otherwise ready", () => {
    let attempts = 0;
    const recovery = createMobileVpnRetry(() => { attempts += 1; });
    recovery.onUnavailable("ready", false);
    recovery.onReachable("ready", false);
    expect(attempts).toBe(1);
  });

  it("waits for a loading connection to fail, then retries only once", () => {
    let attempts = 0;
    const recovery = createMobileVpnRetry(() => { attempts += 1; });
    recovery.onReachable("loading", false);
    expect(attempts).toBe(0);
    recovery.onState("unavailable", false);
    recovery.onState("unavailable", false);
    expect(attempts).toBe(1);
  });

  it("does not replace connection settings the user is editing", () => {
    let attempts = 0;
    const recovery = createMobileVpnRetry(() => { attempts += 1; });
    recovery.onReachable("unavailable", true);
    recovery.onReachable("loading", false);
    recovery.onState("loading", true);
    recovery.onState("unavailable", false);
    expect(attempts).toBe(0);
  });

  it("does not turn a successful connection or first-time setup into a retry", () => {
    let attempts = 0;
    const recovery = createMobileVpnRetry(() => { attempts += 1; });
    recovery.onReachable("loading", false);
    recovery.onReachable("ready", false);
    recovery.onState("unavailable", false);
    recovery.onReachable("loading", false);
    recovery.onState("ready", false);
    recovery.onState("unavailable", false);
    recovery.onReachable("loading", false);
    recovery.onState("setup", false);
    recovery.onState("unavailable", false);
    expect(attempts).toBe(0);
  });
});
