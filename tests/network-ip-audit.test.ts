import { describe, expect, test } from "bun:test";
import {
  collapseRanges,
  describeNetwork,
  parseArpAddresses,
  parseIfconfigIPv4,
  parseNetworksetupInfo,
  parseOptions,
  parseRouteGet,
} from "../scripts/network-ip-audit.mjs";

const ifconfig = `en0: flags=8863<UP,BROADCAST,RUNNING> mtu 1500
\tinet6 fe80::1%en0 prefixlen 64 scopeid 0xe
\tinet 10.15.53.70 netmask 0xffffff80 broadcast 10.15.53.127
`;

describe("network IP audit parsing", () => {
  test("parses macOS ifconfig and calculates a /25 host range", () => {
    const state = parseIfconfigIPv4(ifconfig, "en0");
    expect(state).toMatchObject({ ip: "10.15.53.70", netmask: "255.255.255.128", prefix: 25, broadcast: "10.15.53.127" });
    expect(describeNetwork(state.ip, state.netmask)).toMatchObject({
      cidr: "10.15.53.0/25", firstHost: "10.15.53.1", lastHost: "10.15.53.126", hostCount: 126,
    });
  });

  test("parses route and networksetup output", () => {
    expect(parseRouteGet("   route to: 10.15.64.113\n    gateway: 10.15.53.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE>"))
      .toEqual({ destination: "10.15.64.113", gateway: "10.15.53.1", interfaceName: "en0", flags: "<UP,GATEWAY,DONE>" });
    expect(parseNetworksetupInfo("IP address: 10.15.53.70\nSubnet mask: 255.255.255.128\nRouter: 10.15.53.1"))
      .toEqual({ ip: "10.15.53.70", netmask: "255.255.255.128", gateway: "10.15.53.1" });
  });

  test("recognizes ARP entries only on the selected interface", () => {
    const output = `? (10.15.53.1) at 18:de:d7:f1:00:19 on en0 ifscope [ethernet]\n? (10.15.53.85) at (incomplete) on en0 ifscope [ethernet]\n? (10.15.53.12) at aa:bb:cc:dd:ee:ff on en5 ifscope [ethernet]`;
    expect([...parseArpAddresses(output, "en0")]).toEqual(["10.15.53.1"]);
  });

  test("formats candidate IPs as compact ranges and validates options", () => {
    expect(collapseRanges(["10.15.53.2", "10.15.53.3", "10.15.53.5"])).toEqual(["10.15.53.2-10.15.53.3", "10.15.53.5"]);
    expect(parseOptions(["--interface", "en0", "--ip", "10.15.53.70", "--target", "10.15.64.113", "--no-probe"]))
      .toMatchObject({ interfaceName: "en0", ip: "10.15.53.70", target: "10.15.64.113", probe: false });
    expect(() => parseOptions(["--timeout-ms", "20"])).toThrow();
  });
});
