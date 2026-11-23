import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppStoreConnectTestflightClient } from "./app-store-connect-testflight.js";
import type { StoredIosTestflightApp } from "./types.js";

export type MobileIosTestflightState = "idle" | "running" | "succeeded" | "failed";
export type MobileIosTestflightBetaGroupState = "pending" | "added" | "failed";

export interface MobileIosTestflightStatus {
  available: boolean;
  sourceAvailable: boolean;
  signingConfigured: boolean;
  apiKeyConfigured: boolean;
  state: MobileIosTestflightState;
  buildNumber: number | null;
  nextBuildNumber: number;
  betaGroupName: string;
  betaGroupState: MobileIosTestflightBetaGroupState | null;
  betaGroupMessage?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

const DEFAULT_BETA_GROUP_NAME = "测试";

function betaGroupName(): string {
  return process.env.FEISHU_CODEX_BRIDGE_IOS_TESTFLIGHT_BETA_GROUP_NAME?.trim() || DEFAULT_BETA_GROUP_NAME;
}

interface PersistedStatus {
  state: MobileIosTestflightState;
  buildNumber: number | null;
  betaGroupName?: string;
  betaGroupState?: MobileIosTestflightBetaGroupState;
  betaGroupMessage?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

function positiveBuildNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("TestFlight 构建号必须是正整数。");
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectBuildNumber(app: StoredIosTestflightApp): number {
  try {
    const project = readFileSync(join(app.project_path, "project.pbxproj"), "utf8");
    const configuration = escapeRegExp(app.configuration);
    const blocks = [...project.matchAll(new RegExp(`\\/\\*\\s*${configuration}\\s*\\*\\/\\s*=\\s*\\{\\s*isa = XCBuildConfiguration;\\s*buildSettings = \\{([\\s\\S]*?)\\n\\s*\\};\\s*name = ${configuration};\\s*\\};`, "g"))];
    const block = blocks.map((match) => match[1]).find((value) => {
      const productName = value.match(/^\s*PRODUCT_NAME\s*=\s*"?([^";\n]+)"?;/m)?.[1]?.trim();
      return value.includes(`INFOPLIST_FILE = ${app.info_plist_path};`)
        && (productName === app.target_name || productName === "$(TARGET_NAME)" || productName === "$(PRODUCT_NAME)");
    });
    const match = block?.match(/CURRENT_PROJECT_VERSION\s*=\s*(\d+);/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function archiveBuildNumber(path: string, targetName: string): number {
  const info = join(path, "Products/Applications", `${targetName}.app`, "Info.plist");
  if (!existsSync(info)) return 0;
  const result = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", info], { encoding: "utf8" });
  const value = Number(result.stdout?.trim());
  return result.status === 0 && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function highestArchivedBuild(directory: string, targetName: string): number {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcarchive"))
      .reduce((highest, entry) => Math.max(highest, archiveBuildNumber(join(directory, entry.name), targetName)), 0);
  } catch {
    return 0;
  }
}

function testflightScriptPath(): string | null {
  const configured = process.env.FEISHU_CODEX_BRIDGE_IOS_TESTFLIGHT_SCRIPT?.trim();
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured ? resolve(configured) : null,
    join(moduleDirectory, "..", "scripts", "ios-testflight.mjs"),
    join(process.cwd(), "scripts", "ios-testflight.mjs"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((value) => existsSync(value)) ?? null;
}

function needsMobileAssetBuild(app: StoredIosTestflightApp): boolean {
  return existsSync(join(app.source_path, "package.json"))
    && existsSync(join(app.source_path, "scripts", "mobile.mjs"));
}

function readPersisted(path: string): PersistedStatus {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedStatus>;
    if (!["idle", "running", "succeeded", "failed"].includes(value.state ?? "")
      || (value.buildNumber !== null && value.buildNumber !== undefined && (!Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1))) {
      throw new Error("invalid status");
    }
    if (value.state === "running") {
      return {
        state: "failed",
        buildNumber: value.buildNumber ?? null,
        message: "Bridge 重启前的 TestFlight 上传状态未知，请重新检查 App Store Connect。",
        finishedAt: new Date().toISOString(),
        betaGroupName: value.betaGroupName,
        betaGroupState: value.betaGroupState,
        betaGroupMessage: value.betaGroupMessage,
      };
    }
    return {
      state: value.state as MobileIosTestflightState,
      buildNumber: value.buildNumber ?? null,
      message: value.message,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      betaGroupName: value.betaGroupName,
      betaGroupState: value.betaGroupState,
      betaGroupMessage: value.betaGroupMessage,
    };
  } catch {
    return { state: "idle", buildNumber: null };
  }
}

export class MobileIosTestflight {
  private readonly children = new Map<string, ChildProcess>();
  private readonly statuses = new Map<string, PersistedStatus>();
  private readonly betaGroupAssignments = new Map<string, Promise<void>>();

  private statusPath(app: StoredIosTestflightApp): string {
    return join(app.build_directory, `.bridge-web-upload-${app.id}.json`);
  }

  private logPath(app: StoredIosTestflightApp): string {
    return join(app.build_directory, `.bridge-web-upload-${app.id}.log`);
  }

  private readStatus(app: StoredIosTestflightApp): PersistedStatus {
    const cached = this.statuses.get(app.id);
    if (cached) return cached;
    const status = readPersisted(this.statusPath(app));
    this.statuses.set(app.id, status);
    return status;
  }

  private persist(app: StoredIosTestflightApp, status: PersistedStatus): void {
    mkdirSync(app.build_directory, { recursive: true, mode: 0o700 });
    const path = this.statusPath(app);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(status), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    this.statuses.set(app.id, status);
  }

  private resolveBun(): string | null {
    const configured = process.env.FEISHU_CODEX_BRIDGE_IOS_TESTFLIGHT_BUN?.trim();
    if (configured) return configured;
    if (/^bun(?:\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
    return (process.env.PATH ?? "").split(delimiter).map((part) => join(part, "bun")).find((path) => existsSync(path)) ?? null;
  }

  status(app: StoredIosTestflightApp): MobileIosTestflightStatus {
    const script = testflightScriptPath();
    const sourceAvailable = process.platform === "darwin"
      && Boolean(script)
      && existsSync(app.project_path);
    const signingConfigured = /^[A-Z0-9]{10}$/.test(app.team_id);
    const apiKeyConfigured = Boolean(process.env.APP_STORE_CONNECT_API_KEY_PATH?.trim()
      && process.env.APP_STORE_CONNECT_API_KEY_ID?.trim()
      && process.env.APP_STORE_CONNECT_API_ISSUER_ID?.trim());
    const current = this.readStatus(app);
    const currentBetaGroupName = current.betaGroupName ?? betaGroupName();
    if (current.state === "succeeded" && current.buildNumber
      && (current.betaGroupState === "pending" || current.betaGroupState === "failed")) {
      if (current.betaGroupState === "failed") {
        this.persist(app, {
          ...current,
          betaGroupState: "pending",
          betaGroupMessage: undefined,
          message: "上传已成功，正在重试加入内部测试群组。",
        });
      }
      this.scheduleBetaGroupAssignment(app, current.buildNumber);
    }
    const projectBuild = projectBuildNumber(app);
    const archivedBuild = highestArchivedBuild(app.build_directory, app.target_name);
    const completedBuild = current.state === "failed" ? 0 : current.buildNumber ?? 0;
    const completedOrArchivedBuild = Math.max(archivedBuild, completedBuild);
    return {
      available: app.enabled && sourceAvailable && signingConfigured && apiKeyConfigured,
      sourceAvailable,
      signingConfigured,
      apiKeyConfigured,
      state: current.state,
      buildNumber: current.buildNumber,
      nextBuildNumber: Math.max(projectBuild, completedOrArchivedBuild > 0 ? completedOrArchivedBuild + 1 : 0, 1),
      betaGroupName: currentBetaGroupName,
      betaGroupState: current.betaGroupState ?? null,
      betaGroupMessage: current.betaGroupMessage,
      message: current.message,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
    };
  }

  startUpload(app: StoredIosTestflightApp, value?: unknown): MobileIosTestflightStatus {
    if (!app.enabled) throw new Error("该 TestFlight App 已停用。");
    if (this.children.has(app.id)) throw new Error("该 TestFlight App 上传正在进行中，请稍后查看状态。");
    const current = this.status(app);
    if (current.betaGroupState === "pending" && current.buildNumber) {
      throw new Error("该 TestFlight App 上一个构建正在进行中，等待内部群组关联，请稍后再提交。");
    }
    const buildNumber = value === undefined || value === null
      ? current.nextBuildNumber
      : positiveBuildNumber(value);
    const script = testflightScriptPath();
    if (process.platform !== "darwin") throw new Error("TestFlight 上传需要 macOS 和完整 Xcode。");
    if (!script || !existsSync(app.project_path)) throw new Error("找不到 TestFlight 上传脚本或该 App 的 Xcode 工程。");
    const bun = this.resolveBun();
    if (!bun) throw new Error("找不到 Bun，无法启动 TestFlight 上传。");
    if (!process.env.APP_STORE_CONNECT_API_KEY_PATH?.trim()
      || !process.env.APP_STORE_CONNECT_API_KEY_ID?.trim()
      || !process.env.APP_STORE_CONNECT_API_ISSUER_ID?.trim()) {
      throw new Error("请先在 Bridge 进程环境中配置完整的 App Store Connect API Key。");
    }
    mkdirSync(app.build_directory, { recursive: true, mode: 0o700 });
    const fd = openSync(this.logPath(app), "a", 0o600);
    const scriptArgs = [script, "--build-number", String(buildNumber), ...(app.internal_only ? ["--internal-only"] : [])];
    if (!needsMobileAssetBuild(app)) scriptArgs.push("--skip-mobile-build");
    const child = spawn(bun, scriptArgs, {
      cwd: app.source_path,
      env: {
        ...process.env,
        BRIDGE_IOS_DEVELOPMENT_TEAM: app.team_id,
        BRIDGE_IOS_TESTFLIGHT_SOURCE: app.source_path,
        BRIDGE_IOS_TESTFLIGHT_PROJECT: app.project_path,
        BRIDGE_IOS_TESTFLIGHT_BUILD_DIR: app.build_directory,
        BRIDGE_IOS_TESTFLIGHT_PUBLIC_DIR: app.public_directory,
        BRIDGE_IOS_TESTFLIGHT_BUNDLE_ID: app.bundle_id,
        BRIDGE_IOS_TESTFLIGHT_SCHEME: app.scheme,
        BRIDGE_IOS_TESTFLIGHT_CONFIGURATION: app.configuration,
        BRIDGE_IOS_TESTFLIGHT_TARGET: app.target_name,
        BRIDGE_IOS_TESTFLIGHT_INFO_PLIST: app.info_plist_path,
      },
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    this.children.set(app.id, child);
    const startedAt = new Date().toISOString();
    this.persist(app, { state: "running", buildNumber, startedAt, betaGroupName: betaGroupName(), betaGroupState: "pending" });
    child.once("error", (error) => {
      if (this.children.get(app.id) !== child) return;
      this.children.delete(app.id);
      this.persist(app, { state: "failed", buildNumber, startedAt, finishedAt: new Date().toISOString(), message: `上传进程启动失败：${error.message}` });
    });
    child.once("exit", (code, signal) => {
      if (this.children.get(app.id) !== child) return;
      this.children.delete(app.id);
      if (code === 0) {
        this.persist(app, {
          state: "succeeded",
          buildNumber,
          startedAt,
          finishedAt: new Date().toISOString(),
          betaGroupName: betaGroupName(),
          betaGroupState: "pending",
          message: "上传命令已完成，正在等待 App Store Connect Processing 后加入内部测试群组。",
        });
        this.scheduleBetaGroupAssignment(app, buildNumber);
      } else {
        this.persist(app, { state: "failed", buildNumber, startedAt, finishedAt: new Date().toISOString(), message: `TestFlight 上传失败（${signal ?? code ?? "unknown"}），请查看 Mac 上的上传日志。` });
      }
    });
    return this.status(app);
  }

  private scheduleBetaGroupAssignment(app: StoredIosTestflightApp, buildNumber: number): void {
    if (this.betaGroupAssignments.has(app.id)) return;
    const task = this.attachBetaGroup(app, buildNumber).finally(() => this.betaGroupAssignments.delete(app.id));
    this.betaGroupAssignments.set(app.id, task);
    void task;
  }

  private async attachBetaGroup(app: StoredIosTestflightApp, buildNumber: number): Promise<void> {
    const groupName = betaGroupName();
    try {
      const client = new AppStoreConnectTestflightClient({
        keyPath: process.env.APP_STORE_CONNECT_API_KEY_PATH?.trim() ?? "",
        keyId: process.env.APP_STORE_CONNECT_API_KEY_ID?.trim() ?? "",
        issuerId: process.env.APP_STORE_CONNECT_API_ISSUER_ID?.trim() ?? "",
      });
      await client.attachBuildToInternalGroup(app.bundle_id, buildNumber, groupName);
      const current = this.readStatus(app);
      if (current.state !== "succeeded" || current.buildNumber !== buildNumber) return;
      this.persist(app, {
        ...current,
        betaGroupName: groupName,
        betaGroupState: "added",
        betaGroupMessage: `已加入内部测试群组“${groupName}”。`,
        message: `上传完成，已加入内部测试群组“${groupName}”。`,
      });
    } catch (error) {
      const current = this.readStatus(app);
      if (current.state !== "succeeded" || current.buildNumber !== buildNumber) return;
      const message = error instanceof Error ? error.message : String(error);
      this.persist(app, {
        ...current,
        betaGroupName: groupName,
        betaGroupState: "failed",
        betaGroupMessage: message,
        message: `上传成功，但加入内部测试群组“${groupName}”失败：${message}`,
      });
    }
  }

  stop(): void {
    for (const [id, child] of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      this.children.delete(id);
    }
  }
}
