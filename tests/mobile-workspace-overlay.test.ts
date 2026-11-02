import { describe, expect, it } from "bun:test";
import { createMobileWorkspaceOverlay } from "../web/src/mobile-workspace-overlay.js";

describe("native SSH workspace while switching environments", () => {
  it("restores the same workspace after cancel and closes only the view after a switch", async () => {
    const calls: string[] = [];
    const overlay = createMobileWorkspaceOverlay({
      hide: async () => { calls.push("hide"); return true; },
      show: async () => { calls.push("show"); },
      close: async () => { calls.push("close"); },
    });
    expect(await overlay.open()).toBe(true);
    await overlay.dismiss();
    expect(calls).toEqual(["hide", "show"]);
    expect(await overlay.open()).toBe(true);
    await overlay.leave();
    expect(calls).toEqual(["hide", "show", "hide", "close"]);
  });

  it("opens the dialog normally when no SSH workspace is visible", async () => {
    const calls: string[] = [];
    const overlay = createMobileWorkspaceOverlay({
      hide: async () => false,
      show: async () => { calls.push("show"); },
      close: async () => { calls.push("close"); },
    });
    expect(await overlay.open()).toBe(true);
    await overlay.dismiss();
    await overlay.leave();
    expect(calls).toEqual([]);
  });

  for (const action of ["dismiss", "leave"] as const) {
    it(`handles ${action} while the native view is being hidden`, async () => {
      const calls: string[] = [];
      let complete!: (hidden: boolean) => void;
      const overlay = createMobileWorkspaceOverlay({
        hide: () => new Promise<boolean>((resolve) => { complete = resolve; }),
        show: async () => { calls.push("show"); },
        close: async () => { calls.push("close"); },
      });
      const opening = overlay.open();
      expect(await overlay.open()).toBe(false);
      await overlay[action]();
      complete(true);
      expect(await opening).toBe(false);
      expect(calls).toEqual([action === "dismiss" ? "show" : "close"]);
    });
  }
});
