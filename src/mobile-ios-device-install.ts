import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredMobileApp } from "./types.js";

export type MobileIosDeviceInstallState = "idle" | "running" | "succeeded" | "failed";

export interface MobileIosDeviceInfo {
  udid: string;
  identifier: string;
  name: string;
  pairing: string;
  transport: string;
  connectionState: string;
  developerMode: string;
}

export interface MobileIosDeviceInstallStatus {
  available: boolean;
  sourceAvailable: boolean;
  signingConfigured: boolean;
  usbAvailable: boolean;
  devices: MobileIosDeviceInfo[];
  state: MobileIosDeviceInstallState;
  deviceName?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface PersistedStatus {
  state: MobileIosDeviceInstallState;
  deviceName?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

function installScriptPath(): string | null {
  const configured = process.env.FEISHU_CODEX_BRIDGE_IOS_INSTALL_SCRIPT?.trim();
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured ? resolve(configured) : null,
    join(moduleDirectory, "..", "scripts", "ios-app-install.mjs"),
    join(process.cwd(), "scripts", "ios-app-install.mjs"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((value) => existsSync(value)) ?? null;
}

function readDevices(): MobileIosDeviceInfo[] {
  if (process.platform !== "darwin") return [];
  const directory = mkdtempSync(join(tmpdir(), "bridge-ios-managed-status-"));
  const output = join(directory, "devices.json");
  try {
    const result = spawnSync("xcrun", ["devicectl", "list", "devices", "--timeout", "10", "--json-output", output, "--quiet"], {
      encoding: "utf8", timeout: 15_000,
    });
    if (result.error || result.status !== 0 || !existsSync(output)) return [];
    const rows = (JSON.parse(readFileSync(output, "utf8")) as { result?: { devices?: unknown[] } }).result?.devices;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const value = row as Record<string, any>;
      const hardware = value.properties?.hardware ?? value.hardwareProperties ?? {};
      const connection = value.properties?.connection ?? value.connectionProperties ?? {};
      const state = value.properties?.state ?? value.deviceProperties ?? {};
      if (hardware.reality !== "physical" || !["iOS", "iPadOS"].includes(String(hardware.platform))) return [];
      const udid = hardware.udid ?? value.hardwareProperties?.udid;
      if (typeof udid !== "string" || !udid) return [];
      return [{
        udid, identifier: String(value.identifier ?? ""), name: String(state.name ?? value.deviceProperties?.name ?? "未命名设备"),
        pairing: String(connection.pairingState ?? "unknown"), transport: String(connection.transportType ?? "unknown"),
        connectionState: String(connection.state ?? value.connectionProperties?.tunnelState ?? "unknown"),
        developerMode: state.developerModeStatus?.enabled ? "enabled" : state.developerModeStatus?.disabled ? "disabled" : "unknown",
      }];
    });
  } catch {
    return [];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readPersisted(path: string): PersistedStatus {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedStatus>;
    if (!["idle", "running", "succeeded", "failed"].includes(value.state ?? "")) throw new Error("invalid status");
    if (value.state === "running") return {
      state: "failed", deviceName: value.deviceName, finishedAt: new Date().toISOString(),
      message: "Bridge 重启前的 iOS 本地安装状态未知，请重新检查设备。",
    };
    return { state: value.state as MobileIosDeviceInstallState, deviceName: value.deviceName, message: value.message, startedAt: value.startedAt, finishedAt: value.finishedAt };
  } catch {
    return { state: "idle" };
  }
}

export class MobileIosDeviceInstall {
  private readonly children = new Map<string, ChildProcess>();
  private readonly statuses = new Map<string, PersistedStatus>();

  private statusPath(app: StoredMobileApp): string {
    return join(app.ios!.build_directory, `.bridge-managed-install-${app.id}.json`);
  }

  private logPath(app: StoredMobileApp): string {
    return join(app.ios!.build_directory, `.bridge-managed-install-${app.id}.log`);
  }

  private readStatus(app: StoredMobileApp): PersistedStatus {
    const cached = this.statuses.get(app.id);
    if (cached) return cached;
    const status = readPersisted(this.statusPath(app));
    this.statuses.set(app.id, status);
    return status;
  }

  private persist(app: StoredMobileApp, status: PersistedStatus): void {
    const ios = app.ios!;
    mkdirSync(ios.build_directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(ios.build_directory, `.bridge-managed-install-${app.id}.tmp`), JSON.stringify(status), { encoding: "utf8", mode: 0o600 });
    renameSync(join(ios.build_directory, `.bridge-managed-install-${app.id}.tmp`), this.statusPath(app));
    this.statuses.set(app.id, status);
  }

  private resolveBun(): string | null {
    const configured = process.env.FEISHU_CODEX_BRIDGE_IOS_INSTALL_BUN?.trim();
    if (configured) return configured;
    if (/^bun(?:\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
    return (process.env.PATH ?? "").split(delimiter).map((part) => join(part, "bun")).find((path) => existsSync(path)) ?? null;
  }

  status(app: StoredMobileApp): MobileIosDeviceInstallStatus {
    if (!app.ios) return { available: false, sourceAvailable: false, signingConfigured: false, usbAvailable: false, devices: [], state: "idle" };
    const ios = app.ios;
    const script = installScriptPath();
    const devices = readDevices();
    const usbDevices = devices.filter((device) => device.transport === "wired" && device.pairing === "paired" && device.connectionState === "connected");
    const current = this.readStatus(app);
    const sourceAvailable = process.platform === "darwin" && Boolean(script) && existsSync(ios.project_path);
    const signingConfigured = /^[A-Z0-9]{10}$/.test(ios.team_id);
    return {
      available: app.enabled && sourceAvailable && signingConfigured && usbDevices.length > 0 && current.state !== "running",
      sourceAvailable, signingConfigured, usbAvailable: usbDevices.length > 0, devices,
      state: current.state, deviceName: current.deviceName, message: current.message, startedAt: current.startedAt, finishedAt: current.finishedAt,
    };
  }

  startInstall(app: StoredMobileApp, requestedDevice?: unknown): MobileIosDeviceInstallStatus {
    if (!app.ios) throw new Error("该 App 未配置 iOS。");
    if (!app.enabled) throw new Error("该 App 已停用。");
    if (this.children.has(app.id)) throw new Error("该 App 的 iOS 安装正在进行中，请稍后查看状态。");
    const script = installScriptPath();
    if (process.platform !== "darwin" || !script || !existsSync(app.ios.project_path)) throw new Error("找不到 iOS 本地安装脚本或 Xcode 工程。");
    const bun = this.resolveBun();
    if (!bun) throw new Error("找不到 Bun，无法启动 iOS 本地安装。");
    const devices = readDevices().filter((device) => device.transport === "wired" && device.pairing === "paired" && device.connectionState === "connected");
    const requested = typeof requestedDevice === "string" ? requestedDevice.trim() : "";
    const candidates = requested ? devices.filter((device) => [device.udid, device.identifier, device.name].includes(requested)) : devices;
    if (candidates.length === 0) throw new Error(requested ? "未找到指定的 USB iPhone/iPad，请确认手机已解锁并信任此 Mac。" : "未发现 USB 连接的 iPhone/iPad，请插入数据线并确认手机已解锁。");
    // The App management UI intentionally has no device picker. When no device
    // was requested, use the first paired wired device reported by CoreDevice.
    const device = candidates[0]!;
    if (device.developerMode === "disabled") throw new Error(`请在“${device.name}”上开启开发者模式。`);
    mkdirSync(app.ios.build_directory, { recursive: true, mode: 0o700 });
    const fd = openSync(this.logPath(app), "a", 0o600);
    const env = {
      ...process.env,
      BRIDGE_IOS_INSTALL_SOURCE: app.ios.source_path, BRIDGE_IOS_INSTALL_PROJECT: app.ios.project_path,
      BRIDGE_IOS_INSTALL_BUILD_DIR: app.ios.build_directory, BRIDGE_IOS_INSTALL_BUNDLE_ID: app.ios.bundle_id,
      BRIDGE_IOS_INSTALL_TEAM: app.ios.team_id, BRIDGE_IOS_INSTALL_SCHEME: app.ios.scheme,
      BRIDGE_IOS_INSTALL_CONFIGURATION: app.ios.configuration, BRIDGE_IOS_INSTALL_TARGET: app.ios.target_name,
    };
    let child: ChildProcess;
    try { child = spawn(bun, [script, "--device", device.udid], { cwd: app.ios.source_path, env, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    const startedAt = new Date().toISOString();
    this.children.set(app.id, child);
    this.persist(app, { state: "running", deviceName: device.name, startedAt, message: "已开始构建并安装到 USB 设备。" });
    child.once("error", (error) => {
      if (this.children.get(app.id) !== child) return;
      this.children.delete(app.id);
      this.persist(app, { state: "failed", deviceName: device.name, startedAt, finishedAt: new Date().toISOString(), message: `iOS 本地安装进程启动失败：${error.message}` });
    });
    child.once("exit", (code, signal) => {
      if (this.children.get(app.id) !== child) return;
      this.children.delete(app.id);
      this.persist(app, {
        state: code === 0 ? "succeeded" : "failed", deviceName: device.name, startedAt, finishedAt: new Date().toISOString(),
        message: code === 0 ? `已安装到“${device.name}”。` : `iOS 本地安装失败（${signal ?? code ?? "unknown"}），请查看 Mac 上的安装日志。`,
      });
    });
    return this.status(app);
  }

  stop(): void {
    for (const [id, child] of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      this.children.delete(id);
    }
  }
}
