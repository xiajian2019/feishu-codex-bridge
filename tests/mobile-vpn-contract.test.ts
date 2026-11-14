import { describe, expect, it } from "bun:test";
import {
  classifyMobileVpnPlatform, mobileVpnUnavailableMessage, normalizeMobileVpnProfileSelection,
} from "../web/src/mobile-vpn-contract.js";

describe("mobile VPN platform contract", () => {
  it("keeps Android control enabled without exposing iOS profile import", () => {
    expect(classifyMobileVpnPlatform("android", true)).toEqual({
      platform: "android", pluginAvailable: true, enabled: true, profileImport: false, externalOpenVPNConnect: false,
    });
  });

  it("enables iOS only when BridgeAutoVpn is available", () => {
    expect(classifyMobileVpnPlatform("ios", false)).toEqual({
      platform: "ios", pluginAvailable: false, enabled: false, profileImport: false, externalOpenVPNConnect: false,
    });
    expect(classifyMobileVpnPlatform("ios", true)).toEqual({
      platform: "ios", pluginAvailable: true, enabled: true, profileImport: true, externalOpenVPNConnect: false,
    });
  });

  it("keeps browser routing native-free", () => {
    expect(classifyMobileVpnPlatform("web", true)).toEqual({
      platform: "browser", pluginAvailable: false, enabled: false, profileImport: false, externalOpenVPNConnect: false,
    });
  });

  it("exposes the iOS OpenVPN Connect fallback without enabling Packet Tunnel", () => {
    expect(classifyMobileVpnPlatform("ios", false, true)).toEqual({
      platform: "ios", pluginAvailable: false, enabled: false, profileImport: false, externalOpenVPNConnect: true,
    });
  });

  it("accepts only an opaque native selection handle and never profile contents", () => {
    expect(normalizeMobileVpnProfileSelection({ selectionId: "native-selection-1", fileName: "boohee.ovpn", content: "private key" }))
      .toEqual({ selectionId: "native-selection-1", fileName: "boohee.ovpn" });
    expect(() => normalizeMobileVpnProfileSelection({ selectionId: "", fileName: "boohee.ovpn" })).toThrow();
    expect(() => normalizeMobileVpnProfileSelection({ selectionId: "native-selection-1", fileName: "secret.txt" })).toThrow("请选择 .ovpn 配置文件");
  });

  it("makes platform-specific unavailable states actionable", () => {
    expect(mobileVpnUnavailableMessage("ios", "import")).toContain("iOS App");
    expect(mobileVpnUnavailableMessage("ios", "wifi")).toContain("手动输入 SSID");
    expect(mobileVpnUnavailableMessage("android", "sync")).toContain("Android App");
  });
});
