import { spawn, spawnSync } from "node:child_process";

const DEFAULT_INTERFACE = "en0";
const DEFAULT_TIMEOUT_MS = 350;
const DEFAULT_CONCURRENCY = 24;

function fail(message) {
  throw new Error(message);
}

function parseOptions(args) {
  const options = {
    interfaceName: DEFAULT_INTERFACE,
    ip: null,
    target: null,
    probe: true,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--no-probe") options.probe = false;
    else if (argument === "--json") options.json = true;
    else if (argument === "--interface" || argument === "-i") options.interfaceName = args[++index] ?? fail(`${argument} 需要网卡名称。`);
    else if (argument === "--ip") options.ip = args[++index] ?? fail("--ip 需要 IPv4 地址。");
    else if (argument === "--target") options.target = args[++index] ?? fail("--target 需要 IPv4 地址。");
    else if (argument === "--timeout-ms") options.timeoutMs = Number(args[++index]);
    else if (argument === "--concurrency") options.concurrency = Number(args[++index]);
    else fail(`无法识别的参数：${argument}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 50 || options.timeoutMs > 3_000) {
    fail("--timeout-ms 必须是 50 到 3000 之间的整数。");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 64) {
    fail("--concurrency 必须是 1 到 64 之间的整数。");
  }
  if (options.ip !== null) parseIPv4(options.ip);
  if (options.target !== null) parseIPv4(options.target);
  return options;
}

function parseIPv4(value) {
  if (typeof value !== "string") fail("IPv4 地址必须是文本。");
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
    fail(`无效的 IPv4 地址：${value}`);
  }
  return octets.map(Number);
}

function ipv4ToInt(value) {
  const [a, b, c, d] = parseIPv4(value);
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function intToIPv4(value) {
  const normalized = Number(value) >>> 0;
  return [normalized >>> 24, (normalized >>> 16) & 255, (normalized >>> 8) & 255, normalized & 255].join(".");
}

function netmaskToInt(value) {
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16) >>> 0;
  return ipv4ToInt(value);
}

function prefixLength(netmask) {
  const value = netmaskToInt(netmask);
  let prefix = 0;
  let sawZero = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if ((value & (2 ** bit)) !== 0) {
      if (sawZero) fail(`子网掩码不是连续掩码：${netmask}`);
      prefix += 1;
    } else {
      sawZero = true;
    }
  }
  return prefix;
}

function intToNetmask(value) {
  return intToIPv4(value);
}

function parseIfconfigIPv4(output, interfaceName = DEFAULT_INTERFACE) {
  const interfaceBlock = output
    .split(/\n(?=\S)/)
    .find((block) => block.startsWith(`${interfaceName}:`)) ?? output;
  const match = interfaceBlock.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+netmask\s+(0x[0-9a-f]+|\d{1,3}(?:\.\d{1,3}){3})/i);
  if (!match) fail(`网卡 ${interfaceName} 没有可读取的 IPv4 地址。`);
  const ip = match[1];
  const netmask = intToNetmask(netmaskToInt(match[2]));
  const broadcast = interfaceBlock.match(/\bbroadcast\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1] ?? null;
  return { interfaceName, ip, netmask, prefix: prefixLength(netmask), broadcast };
}

function parseNetworksetupInfo(output) {
  const value = (label) => output.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? null;
  return { ip: value("IP address"), netmask: value("Subnet mask"), gateway: value("Router") };
}

function parseRouteGet(output) {
  const fields = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^([^:]+):\s*(.+)$/);
    if (match) fields.set(match[1].trim(), match[2].trim());
  }
  const get = (label) => fields.get(label) ?? null;
  return { destination: get("route to"), gateway: get("gateway"), interfaceName: get("interface"), flags: get("flags") };
}

function describeNetwork(ip, netmask) {
  const address = ipv4ToInt(ip);
  const mask = netmaskToInt(netmask);
  const network = (address & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const first = network + (broadcast - network >= 1 ? 1 : 0);
  const last = broadcast - (broadcast - network >= 1 ? 1 : 0);
  return {
    ip,
    netmask: intToNetmask(mask),
    prefix: prefixLength(netmask),
    cidr: `${intToIPv4(network)}/${prefixLength(netmask)}`,
    networkAddress: intToIPv4(network),
    broadcastAddress: intToIPv4(broadcast),
    firstHost: intToIPv4(first),
    lastHost: intToIPv4(last),
    hostCount: Math.max(0, last - first + 1),
    addresses: Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => intToIPv4(first + index)),
  };
}

function parseArpAddresses(output, interfaceName) {
  const addresses = new Set();
  for (const line of output.split("\n")) {
    if (interfaceName && !new RegExp(`\\bon\\s+${interfaceName}\\b`).test(line)) continue;
    const match = line.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([^\s]+)/);
    if (match && match[2] !== "(incomplete)") addresses.add(match[1]);
  }
  return addresses;
}

function runSync(command, args, timeout = 5_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  if (result.error) fail(`${command} 执行失败：${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function run(command, args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr, timedOut: signal === "SIGTERM" });
    });
  });
}

async function scanAddresses(addresses, timeoutMs, concurrency, probe = run) {
  const results = new Array(addresses.length);
  let cursor = 0;
  async function worker() {
    while (cursor < addresses.length) {
      const index = cursor++;
      const ip = addresses[index];
      const result = await probe("ping", ["-n", "-c", "1", "-W", String(timeoutMs), ip], timeoutMs + 500);
      results[index] = { ip, responded: result.status === 0, timedOut: Boolean(result.timedOut) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
  return results;
}

function collapseRanges(addresses) {
  const sorted = [...new Set(addresses)].sort((a, b) => ipv4ToInt(a) - ipv4ToInt(b));
  const ranges = [];
  for (const address of sorted) {
    const value = ipv4ToInt(address);
    const last = ranges.at(-1);
    if (!last || value !== last.end + 1) ranges.push({ start: value, end: value });
    else last.end = value;
  }
  return ranges.map(({ start, end }) => start === end ? intToIPv4(start) : `${intToIPv4(start)}-${intToIPv4(end)}`);
}

function printHelp() {
  console.log(`用法：bun run network:ip-audit -- [选项]

读取网卡路由并扫描当前 IPv4 网段。默认使用 en0，并探测每个主机地址。
  --interface, -i <网卡>       网卡名称，默认 en0
  --ip <地址>                  指定本机 IPv4；不指定时从网卡读取
  --target <地址>              额外显示到该地址的 route -n get 结果
  --no-probe                   只显示地址/路由，不发送 ping
  --timeout-ms <毫秒>          单个 ping 等待时间，默认 350
  --concurrency <数量>         并发探测数，默认 24
  --json                       输出机器可读 JSON
  --help                       显示帮助

注意：未收到 ping/ARP 响应只表示“本次未观察到”，不等于地址绝对空闲。手动配置前应使用路由器 DHCP 保留或网络管理员确认。`);
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(args);
  if (options.help) { printHelp(); return; }
  if (process.platform !== "darwin") fail("此脚本需要 macOS 的 ifconfig、route、arp 和 ping。\n");
  const runSyncImpl = dependencies.runSync ?? runSync;
  const runImpl = dependencies.run ?? run;
  const ifconfig = runSyncImpl("ifconfig", [options.interfaceName]);
  if (ifconfig.status !== 0) fail(`无法读取网卡 ${options.interfaceName}：${ifconfig.stderr.trim() || ifconfig.stdout.trim()}`);
  const detected = parseIfconfigIPv4(ifconfig.stdout, options.interfaceName);
  const ip = options.ip ?? detected.ip;
  const network = describeNetwork(ip, detected.netmask);
  const networksetup = runSyncImpl("networksetup", ["-getinfo", options.interfaceName === "en0" ? "Wi-Fi" : options.interfaceName]);
  const networkInfo = parseNetworksetupInfo(networksetup.stdout);
  const target = options.target ?? (network.gateway ?? networkInfo.gateway ?? network.firstHost);
  const routeTarget = target === ip ? network.firstHost === ip ? network.lastHost : network.firstHost : target;
  const routeResult = runSyncImpl("route", ["-n", "get", routeTarget]);
  const route = parseRouteGet(routeResult.stdout);
  const excluded = new Set([network.networkAddress, network.broadcastAddress, ip, route.gateway, networkInfo.gateway].filter(Boolean));
  const scanAddressesList = network.addresses.filter((address) => !excluded.has(address));
  const probes = options.probe ? await scanAddresses(scanAddressesList, options.timeoutMs, options.concurrency, runImpl) : [];
  const arpResult = options.probe ? runSyncImpl("arp", ["-an"]) : { stdout: "" };
  const arpAddresses = parseArpAddresses(arpResult.stdout, options.interfaceName);
  const occupied = probes.filter((probe) => probe.responded || arpAddresses.has(probe.ip)).map((probe) => ({ ...probe, source: probe.responded ? "icmp" : "arp" }));
  const occupiedIps = new Set(occupied.map((entry) => entry.ip));
  const candidates = options.probe ? scanAddressesList.filter((address) => !occupiedIps.has(address) && !arpAddresses.has(address)) : [];
  const report = {
    interface: options.interfaceName,
    local: { ...network, detectedBroadcast: detected.broadcast },
    networksetup: networkInfo,
    route,
    routeTarget,
    excluded: [...excluded].filter(Boolean),
    probe: options.probe ? { timeoutMs: options.timeoutMs, concurrency: options.concurrency, scanned: scanAddressesList.length, occupied, candidates, candidateRanges: collapseRanges(candidates) } : null,
    warning: "候选地址只是本次未观察到 ICMP/ARP 响应；手动配置前请使用 DHCP 保留或让网络管理员确认。",
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(`网卡：${report.interface}`);
  console.log(`本机 IPv4：${network.ip}`);
  console.log(`子网：${network.cidr}（掩码 ${network.netmask}）`);
  console.log(`可用主机范围：${network.firstHost} - ${network.lastHost}，共 ${network.hostCount} 个地址`);
  console.log(`网关：${networkInfo.gateway ?? route.gateway ?? "未知"}`);
  console.log(`到 ${routeTarget} 的路由：${route.interfaceName ?? "未知接口"}${route.gateway ? `，下一跳 ${route.gateway}` : "，直连或无网关"}`);
  if (options.probe) {
    console.log(`探测：扫描 ${scanAddressesList.length} 个地址（并发 ${options.concurrency}，单个等待 ${options.timeoutMs}ms）`);
    console.log(`已观察占用：${occupied.length ? occupied.map((entry) => `${entry.ip}(${entry.source})`).join(", ") : "无"}`);
    console.log(`候选地址（未观察到响应）：${candidates.length ? collapseRanges(candidates).join(", ") : "无"}`);
  } else {
    console.log("探测：已关闭；使用 --no-probe 只查看网络信息。 ");
  }
  console.log(`注意：${report.warning}`);
  return report;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`网络地址诊断失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export {
  collapseRanges,
  describeNetwork,
  main,
  parseArpAddresses,
  parseIfconfigIPv4,
  parseNetworksetupInfo,
  parseOptions,
  parseRouteGet,
  parseIPv4,
  scanAddresses,
};
