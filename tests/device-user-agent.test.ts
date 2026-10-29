import { describe, expect, it } from "bun:test";
import { describeDevice, type DeviceAuthorization } from "../web/src/device-authorizations.js";

const androidUA = "Mozilla/5.0 (Linux; Android 14; HUAWEI P60 Build/HUAWEIP60; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36";
const iosUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
function device(userAgent: string | null, deviceName = "Browser device"): DeviceAuthorization {
  return { sessionId: "fixture-identity", current: true, deviceName, userAgent, remoteAddress: "192.168.1.2",
    createdAt: "2026-10-27T00:00:00Z", lastSeenAt: "2026-10-27T00:00:00Z", expiresAt: "2026-11-27T00:00:00Z" };
}

describe("device user-agent presentation", () => {
  it("prioritizes Bridge App over Android WebView and browser compatibility tokens", () => {
    const profile = describeDevice(device(androidUA + " BridgeApp/0.5.0 (Android)"));
    expect(profile).toMatchObject({ name: "华为手机", app: true, browser: "Bridge App 0.5.0", system: "Android 14" });
    expect(profile.browser).not.toContain("Chrome");
    expect(profile.browser).not.toContain("WebView");
  });

  it("picks up App version changes while retaining the user's device name", () => {
    expect(describeDevice(device(androidUA + " BridgeApp/0.6.1-dev (Android)", "值班手机")))
      .toMatchObject({ name: "值班手机", customName: true, browser: "Bridge App 0.6.1-dev" });
  });

  it("recognizes iOS App UAs without misidentifying their Mac compatibility token", () => {
    expect(describeDevice(device(iosUA + " BridgeApp/0.5.0 (iOS)")))
      .toMatchObject({ name: "iPhone", app: true, browser: "Bridge App 0.5.0", system: "iOS 18.6" });
    expect(describeDevice(device("BridgeApp/0.5.0 (iOS)"))).toMatchObject({ browser: "Bridge App 0.5.0", system: "iOS" });
  });

  it("summarizes ordinary browsers and keeps unmarked WebViews distinct from Bridge App", () => {
    expect(describeDevice(device(androidUA))).toMatchObject({ app: false, browser: "内嵌浏览器 WebView 129.0", system: "Android 14", model: "HUAWEI P60" });
    expect(describeDevice(device(iosUA + " Version/18.6 Mobile/15E148 Safari/604.1")))
      .toMatchObject({ app: false, browser: "Safari 18.6", system: "iOS 18.6" });
    expect(describeDevice(device("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129.0.6668.81 Safari/537.36")))
      .toMatchObject({ app: false, browser: "Chrome 129.0", system: "macOS 10.15.7" });
  });

  it("does not treat an unrelated product containing BridgeApp as the App marker", () => {
    expect(describeDevice(device("OtherBridgeApp/0.5.0 (Android) Chrome/129.0"))).toMatchObject({ app: false, browser: "Chrome 129.0" });
    expect(describeDevice(device(null, "备用手机"))).toMatchObject({ name: "备用手机", app: false, browser: "未知浏览器", system: "未知系统" });
  });
});
