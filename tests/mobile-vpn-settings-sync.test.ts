import { describe, expect, it } from "bun:test";
import { createMobileVpnSettingsSync } from "../web/src/mobile-vpn-settings-sync.js";

describe("global VPN Wi-Fi settings synchronization", () => {
  it("applies each saved snapshot in order even when the first native call is slow", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ssids = ["Office"];
    const applied: string[][] = [];
    const sync = createMobileVpnSettingsSync(() => ssids, async (value) => {
      applied.push(value);
      if (value[0] === "Office") await gate;
      return true;
    });
    const first = sync();
    ssids.push("Mutated later");
    ssids = ["Home"];
    const second = sync();
    await Promise.resolve();
    expect(applied).toEqual([["Office"]]);
    release?.();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(applied).toEqual([["Office"], ["Home"]]);
  });

  it("reports native failure and still applies the next settings", async () => {
    let attempts = 0;
    const sync = createMobileVpnSettingsSync(() => [], async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("native unavailable");
      return true;
    });
    expect(await sync()).toBe(false);
    expect(await sync()).toBe(true);
  });
});
