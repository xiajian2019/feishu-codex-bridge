import { describe, expect, test } from "bun:test";
import { assertInstallTransport, chooseDevice, formatDeviceStatus, parseOptions, physicalDevices, resolveIpDevice } from "../scripts/ios-device.mjs";

function row(name: string, udid: string, transport: string, reality = "physical") {
  return {
    identifier: `core-${udid}`,
    properties: {
      hardware: { udid, reality, platform: "iOS" },
      connection: { pairingState: "paired", transportType: transport, state: "connected" },
      state: { name, developerModeStatus: { enabled: {} } },
    },
  };
}

describe("iOS device installation selection", () => {
  test("selects only physical paired devices and detects a wireless connection", () => {
    const devices = physicalDevices([row("iPhone", "phone", "localNetwork"), row("Simulator", "sim", "sameMachine", "simulated")]);
    expect(devices).toHaveLength(1);
    expect(chooseDevice(devices, null).udid).toBe("phone");
    expect(() => assertInstallTransport(devices[0])).not.toThrow();
  });

  test("accepts USB by default and can enforce wireless-only mode", () => {
    const wired = physicalDevices([row("iPhone", "phone", "wired")])[0];
    expect(() => assertInstallTransport(wired)).not.toThrow();
    expect(() => assertInstallTransport(wired, true)).toThrow("--wireless-only");
    expect(() => assertInstallTransport({ ...wired, transport: "unknown" })).toThrow("无法确认可安装连接");
  });

  test("requires an explicit target when several devices are available", () => {
    const devices = physicalDevices([row("Phone A", "a", "wired"), row("Phone B", "b", "localNetwork")]);
    expect(() => chooseDevice(devices, null)).toThrow("多个");
    expect(chooseDevice(devices, "Phone B").udid).toBe("b");
    expect(() => chooseDevice(devices, "missing")).toThrow("未找到");
    expect(chooseDevice([], null, false)).toBeNull();
  });

  test("explains when a paired phone is currently unavailable", () => {
    const device = { ...physicalDevices([row("iPhone", "phone", "localNetwork")])[0], transport: "unknown", connectionState: "unavailable" };
    expect(formatDeviceStatus(device)).toContain("未发现连接，已配对，开发者模式已开启，连接不可用");
    expect(() => chooseDevice([device], null)).toThrow("设备已配对，但当前没有可用连接");
  });

  test("checks whether CoreDevice can resolve an IP before treating it as a device", () => {
    const ip = "10.15.64.113";
    expect(() => resolveIpDevice(ip, true, () => { throw new Error("device not found"); })).toThrow("无法将 IP 10.15.64.113 识别为设备");
    expect(() => resolveIpDevice(ip, true, () => ({ result: row("iPhone", "phone", "wired") }))).toThrow("--wireless-only");
    expect(resolveIpDevice(ip, true, () => ({ result: row("iPhone", "phone", "localNetwork") })).udid).toBe("phone");
  });

  test("parses explicit build, wireless IP, and provisioning options without installing implicitly", () => {
    expect(parseOptions(["--build-only", "--device", "My iPhone"])).toMatchObject({ buildOnly: true, device: "My iPhone", wirelessOnly: false });
    expect(parseOptions(["--ip", "10.15.64.113"])).toMatchObject({ ip: "10.15.64.113", device: null });
    expect(parseOptions(["--wireless-only"]).wirelessOnly).toBe(true);
    expect(parseOptions(["--allow-usb"]).wirelessOnly).toBe(false);
    expect(parseOptions(["--allow-provisioning-updates"]).allowProvisioningUpdates).toBe(true);
    expect(() => parseOptions(["--device"])).toThrow();
    expect(() => parseOptions(["--ip", "10.15.64.999"])).toThrow("无效的 iPhone IPv4 地址");
    expect(() => parseOptions(["--device", "My iPhone", "--ip", "10.15.64.113"])).toThrow("不能同时使用");
    expect(() => parseOptions(["--check", "--build-only"])).toThrow();
  });
});
