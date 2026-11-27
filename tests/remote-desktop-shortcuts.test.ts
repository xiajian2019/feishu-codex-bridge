import { describe, expect, it } from "bun:test";
import { REMOTE_DESKTOP_SHORTCUTS, sendRemoteDesktopShortcut } from "../web/src/remote-desktop-shortcuts.js";

describe("remote desktop shortcuts", () => {
  it("sends Command+Tab as an ordered press and release sequence", () => {
    const calls: Array<[number, string | null | undefined, boolean | undefined]> = [];
    sendRemoteDesktopShortcut({ sendKey: (...args) => calls.push(args) }, REMOTE_DESKTOP_SHORTCUTS.switchApp);

    expect(calls).toEqual([
      [0xffeb, "MetaLeft", true],
      [0xff09, "Tab", true],
      [0xff09, "Tab", false],
      [0xffeb, "MetaLeft", false],
    ]);
  });

  it("sends Command+Space for Spotlight", () => {
    const calls: Array<[number, string | null | undefined, boolean | undefined]> = [];
    sendRemoteDesktopShortcut({ sendKey: (...args) => calls.push(args) }, REMOTE_DESKTOP_SHORTCUTS.spotlight);

    expect(calls).toEqual([
      [0xffeb, "MetaLeft", true],
      [0x20, "Space", true],
      [0x20, "Space", false],
      [0xffeb, "MetaLeft", false],
    ]);
  });

  it("releases Command when the shortcut key fails", () => {
    const calls: Array<[number, string | null | undefined, boolean | undefined]> = [];
    expect(() => sendRemoteDesktopShortcut({
      sendKey: (...args) => {
        calls.push(args);
        if (args[0] === 0xff09 && args[2] === true) throw new Error("socket closed");
      },
    }, REMOTE_DESKTOP_SHORTCUTS.switchApp)).toThrow("socket closed");

    expect(calls.at(-1)).toEqual([0xffeb, "MetaLeft", false]);
  });
});
