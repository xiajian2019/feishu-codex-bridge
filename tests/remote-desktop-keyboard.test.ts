import { describe, expect, it } from "bun:test";
import { remoteDesktopTextKeyEvents } from "../web/src/remote-desktop-keyboard.js";

describe("remote desktop keyboard input", () => {
  it("keeps submitted text local until it is converted to an ordered key sequence", () => {
    expect(remoteDesktopTextKeyEvents("Xcode\r\n下一步\t", true)).toEqual([
      { keysym: 0x58 },
      { keysym: 0x63 },
      { keysym: 0x6f },
      { keysym: 0x64 },
      { keysym: 0x65 },
      { keysym: 0xff0d, code: "Enter" },
      { keysym: 0x01004e0b },
      { keysym: 0x01004e00 },
      { keysym: 0x01006b65 },
      { keysym: 0xff09, code: "Tab" },
      { keysym: 0xff0d, code: "Enter" },
    ]);
  });
});
