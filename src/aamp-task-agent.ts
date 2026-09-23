import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  findExecutableInPath,
  prependPath,
  resolveLarkConfigDir,
} from "./runtime-env.js";
import {
  AampRestartTrace,
  collectAampRestartPhases,
  type AampRestartPhase,
} from "./aamp-restart.js";
import { resolveAampStateHome } from "./feishu-credentials.js";
import type { BridgeConfig, Logger } from "./types.js";

const PACKAGE_NAME = "@larktask/aamp-feishu-task-agent";
const PACKAGE_BIN_NAMES = ["aamp-feishu-task-agent", "feishu-task-agent"] as const;
const DEFAULT_AAMP_LARK_CLI_PATH = join(
  homedir(),
  ".aamp",
  "npm-global",
  "bin",
  "lark-cli",
);
const AAMP_SERVICE_LABEL = "com.larktask.aamp-feishu-task-agent";
const AAMP_CARD_DEDUP_STATE_FILENAME = "lark-card-dedup.json";
const AAMP_SERVICE_REPAIR_MARKER_FILENAME = "launchd-repair.json";
const AAMP_SERVICE_READY_TIMEOUT_MS = 300_000;
const AAMP_SERVICE_CONTROL_LOCK_FILENAME = "service-v1-control.lock";
const AAMP_RESTART_TRACE_FILENAME = "restart-phases.jsonl";
const AAMP_SKIP_MACOS_QUARANTINE = "1";

export type AampRestartMode = "hot" | "cold";

export interface AampRestartArguments {
  mode: AampRestartMode;
  forwardedArgs: string[];
}

interface AampHotRestartResult {
  status: "completed" | "fallback" | "timeout";
  reason?: string;
}

interface AampLaunchdSelection {
  binding_ids?: unknown;
}

export interface AampCardDedupEntry {
  messageId: string;
}

export interface AampTaskAgentOptions {
  projectRoot: string;
  /** Bridge config path used by read-only cross-mode Codex queries. */
  configPath?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  /** SQLite path shared with the AAMP runtime persistence patch. */
  sqlitePath?: string;
  /** Directory where the AAMP runtime stores downloaded image attachments. */
  attachmentsDir?: string;
  logger?: Logger;
}

/**
 * Project-side adapter for the official AAMP package.
 *
 * The package remains the owner of binding, Feishu IM/task events, agent
 * conversations, interactive cards, reconnects, and launchd lifecycle. This
 * adapter only supplies its public CLI with a stable executable, the selected
 * lark-cli config store, and small PATH shims for local Codex/lark-cli calls.
 */
export class AampTaskAgentRuntime {
  private readonly config: BridgeConfig;
  private readonly projectRoot: string;
  private readonly configPath: string;
  private readonly inheritedEnv: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly shimDir: string;
  private readonly officialCommandPath: string;
  private readonly commandPath: string;
  private readonly taskCommandPath: string;
  private readonly taskAgentShortCommandPath: string;
  private readonly serviceBootstrapPath: string;
  private readonly sqlitePath: string;
  private readonly attachmentsDir: string;

  constructor(config: BridgeConfig, options: AampTaskAgentOptions) {
    this.config = config;
    this.projectRoot = resolve(options.projectRoot);
    this.configPath = resolve(options.configPath ?? join(this.projectRoot, "config.json"));
    this.inheritedEnv = options.inheritedEnv ?? process.env;
    this.logger = options.logger;
    this.shimDir = join(this.projectRoot, "runtime", "aamp", "bin");
    this.officialCommandPath = resolveTaskAgentCommand(this.projectRoot);
    this.commandPath = join(this.shimDir, "aamp-task-agent-command");
    // The official bootstrap rewrites AAMP_TASK_COMMAND_PATH during updates.
    // Keep that mutable command separate from the project-owned service wrapper
    // so BUN_OPTIONS and the runtime patches survive package upgrades.
    this.taskCommandPath = join(this.shimDir, "feishu-task-agent-cli");
    const aampBinDir = resolve(
      this.inheritedEnv.AAMP_BIN_DIR?.trim() || join(homedir(), ".aamp", "bin"),
    );
    this.taskAgentShortCommandPath = join(aampBinDir, "feishu-task-agent");
    this.serviceBootstrapPath = join(this.shimDir, "feishu-task-agent-service");
    this.sqlitePath = resolve(options.sqlitePath ?? join(this.projectRoot, "runtime", "bridge.db"));
    this.attachmentsDir = resolve(
      options.attachmentsDir ?? join(this.projectRoot, "runtime", "aamp", "attachments"),
    );
  }

  public async install(): Promise<void> {
    await this.run(["install"]);
  }

  public async start(): Promise<void> {
    await this.run(["start"]);
  }

  public async stop(): Promise<void> {
    await this.run(["stop"]);
  }

  public async run(args: string[]): Promise<void> {
    if (args.length === 0) {
      throw new Error("AAMP command is required, for example: start or status");
    }
    const command = args[0];
    const restartStartedAtMs = command === "restart" ? Date.now() : undefined;
    const restartArguments = restartStartedAtMs === undefined
      ? undefined
      : parseAampRestartArguments(args, this.inheritedEnv);
    const restartTrace = restartStartedAtMs === undefined
      ? undefined
      : new AampRestartTrace({ logFile: resolveAampRestartTraceFile(this.inheritedEnv) });
    const repairsLaunchd = shouldRepairLaunchd(command);
    try {
      const env = restartTrace
        ? restartTrace.measureSync("准备本地适配环境", () => this.prepareEnvironment())
        : this.prepareEnvironment();
      this.logger?.info("running official AAMP task-agent command", {
        command,
        profile: this.config.lark.profile,
        larkConfigDir: env.LARKSUITE_CLI_CONFIG_DIR,
      });

      const commandPath = existsSync(this.commandPath)
        ? this.commandPath
        : this.officialCommandPath;
      if (restartArguments) {
        if (restartArguments.mode === "hot") {
          const token = restartTrace!.begin("快速重启（保留 launchd 服务）");
          let hotRestart: AampHotRestartResult;
          try {
            hotRestart = await this.restartHot(restartArguments.forwardedArgs, restartTrace!);
            restartTrace!.end(
              token,
              hotRestart.status === "completed"
                ? "completed"
                : hotRestart.status === "fallback"
                  ? "unavailable"
                  : "failed",
              hotRestart.reason,
            );
          } catch (error) {
            restartTrace!.end(
              token,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
          if (hotRestart.status === "fallback") {
            restartTrace!.info("快速重启不可用，回退官方冷重启", {
              reason: hotRestart.reason || "unknown",
            });
            await restartTrace!.measure("官方 AAMP 冷重启", () => spawnInherited(
              commandPath,
              restartArguments.forwardedArgs,
              { cwd: this.projectRoot, env },
            ));
          } else if (hotRestart.status === "timeout") {
            restartTrace!.info("快速重启已触发但未 ready，不再自动重复冷重启", {
              reason: hotRestart.reason || "unknown",
            });
            throw new Error(hotRestart.reason || "AAMP 快速重启未能在等待窗口内 ready");
          }
        } else {
          restartTrace!.info("按 --cold 执行官方冷重启");
          await restartTrace!.measure("官方 AAMP 冷重启", () => spawnInherited(
            commandPath,
            restartArguments.forwardedArgs,
            { cwd: this.projectRoot, env },
          ));
        }
      } else {
        await spawnInherited(
          commandPath,
          args,
          {
            cwd: this.projectRoot,
            env,
          },
        );
      }
      if (repairsLaunchd) {
        if (restartTrace) {
          await restartTrace.measure("检查 launchd 兼容路径", () => this.repairLaunchdService(command));
        } else {
          await this.repairLaunchdService(command);
        }
      }
    } finally {
      if (restartTrace && restartStartedAtMs !== undefined) {
        this.printRestartSummary(restartTrace, restartStartedAtMs);
      }
    }
  }

  private async restartHot(
    forwardedArgs: string[],
    trace: AampRestartTrace,
  ): Promise<AampHotRestartResult> {
    const fallback = (reason: string): AampHotRestartResult => ({ status: "fallback", reason });
    if (process.platform !== "darwin") {
      return fallback("launchd 快速重启仅支持 macOS");
    }
    if (forwardedArgs.length !== 1 || forwardedArgs[0] !== "restart") {
      return fallback("restart 带有官方参数，无法安全复用当前 launchd 服务配置");
    }

    const bootstrapShimPath = this.serviceBootstrapPath;
    const plistPath = join(
      homedir(),
      "Library",
      "LaunchAgents",
      `${AAMP_SERVICE_LABEL}.plist`,
    );
    if (!existsSync(bootstrapShimPath) || !existsSync(plistPath)) {
      return fallback("launchd plist 或项目 bootstrap shim 尚未生成");
    }

    let currentPlist: string;
    try {
      currentPlist = readFileSync(plistPath, "utf8");
    } catch (error) {
      return fallback(`无法读取 launchd plist：${error instanceof Error ? error.message : String(error)}`);
    }
    const expectedPlist = replaceLaunchdBootstrapPath(currentPlist, bootstrapShimPath);
    if (expectedPlist === undefined || expectedPlist !== currentPlist) {
      return fallback("launchd 当前仍指向官方 bootstrap，先执行一次官方冷重启以修复路径");
    }
    if (!currentPlist.includes("<string>__service-run</string>")) {
      return fallback("launchd plist 不是 AAMP 后台服务格式");
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const target = `gui/${uid}/${AAMP_SERVICE_LABEL}`;
    const stateHome = resolveAampStateHome(this.inheritedEnv);
    const readinessPath = join(stateHome, "service-v1", "readiness.json");
    const selectionPath = join(stateHome, "service-v1", "selection.json");

    try {
      return await withServiceControlLock(
        join(stateHome, AAMP_SERVICE_CONTROL_LOCK_FILENAME),
        async () => {
          const current = await trace.measure("检查 launchd 服务", () => (
            spawnCaptured("/bin/launchctl", ["print", target])
          ));
          if (current.exitCode !== 0) {
            return fallback("AAMP launchd 服务当前未加载");
          }
          if (!/(?:^|\n)\s*state\s*=\s*running\b/.test(current.stdout)) {
            return fallback("AAMP launchd 服务已加载但当前未运行");
          }
          const selection = readAampLaunchdSelection(selectionPath);
          if (!selection.length) {
            return fallback("未找到 AAMP 后台绑定选择，无法安全快速重启");
          }

          trace.measureSync("清理旧 readiness", () => {
            rmSync(readinessPath, { force: true });
          });
          const kicked = await trace.measure("launchctl kickstart -k", () => (
            spawnCaptured("/bin/launchctl", ["kickstart", "-k", target])
          ));
          if (kicked.exitCode !== 0) {
            return fallback(
              `launchctl kickstart 失败：${kicked.stderr.trim() || kicked.stdout.trim() || "unknown"}`,
            );
          }
          await trace.measure("等待服务 ready", () => waitForLaunchdReady(
            target,
            readinessPath,
            (elapsedMs) => trace.info("服务仍在启动", { elapsedMs }),
            resolveAampRestartReadyTimeout(this.inheritedEnv),
          ));
          trace.info("快速重启完成", { target, readinessPath });
          return { status: "completed" };
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("等待 AAMP launchd 服务 ready 超时")) {
        return { status: "timeout", reason };
      }
      return fallback(reason);
    }
  }

  private printRestartSummary(trace: AampRestartTrace, startedAtMs: number): void {
    let collected: { runDir?: string; phases: AampRestartPhase[] } = { phases: [] };
    try {
      collected = collectAampRestartPhases({
        logRoot: this.inheritedEnv.AAMP_LOG_DIR,
        startedAtMs,
        finishedAtMs: Date.now(),
      });
    } catch (error) {
      trace.info("无法采集官方运行阶段日志", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (collected.runDir) trace.info("已采集官方运行阶段", { runDir: collected.runDir });
    trace.printSummary(composeAampRestartPhases(trace.phases, collected.phases));
  }

  private prepareEnvironment(): Record<string, string> {
    mkdirSync(this.shimDir, { recursive: true, mode: 0o700 });

    const bunPackageManagerPrefix = join(this.projectRoot, "runtime", "aamp", "bun-global");
    const bunPackageManagerBin = join(bunPackageManagerPrefix, "bin");
    mkdirSync(bunPackageManagerBin, { recursive: true, mode: 0o700 });
    const packageManagerScriptPath = join(this.projectRoot, "scripts", "aamp-bun-package-manager.mjs");
    for (const directory of [this.shimDir, bunPackageManagerBin]) {
      writeExecutable(join(directory, "node"), buildBunNodeShim(process.execPath));
      writeExecutable(
        join(directory, "npm"),
        buildBunPackageManagerShim(process.execPath, packageManagerScriptPath, "npm"),
      );
      writeExecutable(
        join(directory, "npx"),
        buildBunPackageManagerShim(process.execPath, packageManagerScriptPath, "npx"),
      );
    }

    const larkCliPath = resolveAampLarkCliPath(this.config, this.inheritedEnv);
    const configDir = resolveLarkConfigDir(this.config, this.inheritedEnv, true);
    const larkCliShimPath = join(this.shimDir, "lark-cli");
    const serviceBootstrapShimPath = this.serviceBootstrapPath;
    const cardDedupStatePath = join(
      this.projectRoot,
      "runtime",
      "aamp",
      AAMP_CARD_DEDUP_STATE_FILENAME,
    );
    const taskAgentMetadata = readTaskAgentMetadata(this.officialCommandPath);
    writeExecutable(
      join(this.shimDir, "codex"),
      buildExecutableShim({
        target: this.config.codex.cliPath,
        environment: {
          ...buildProxyEnvironment(this.config),
          LARKSUITE_CLI_CONFIG_DIR: configDir,
        },
      }),
    );
    if (process.platform === "darwin") {
      // The upstream bootstrap has no opt-out for its quarantine probe. Keep
      // the bypass scoped to the service-owned PATH shim rather than touching
      // the system xattr binary or the installed package.
      writeExecutable(join(this.shimDir, "xattr"), buildAampXattrShim());
    }
    if (larkCliPath) {
      writeExecutable(
        larkCliShimPath,
        buildLarkCliShim({
          target: larkCliPath,
          configDir,
          cardDedupStatePath,
          compatScriptPath: join(this.projectRoot, "scripts", "aamp-lark-cli-compat.mjs"),
          bunPath: process.execPath,
        }),
      );
      writeExecutable(
        serviceBootstrapShimPath,
        buildServiceBootstrapShim({
          target: this.taskAgentShortCommandPath,
          taskCommandPath: this.taskCommandPath,
          taskAgentName: taskAgentMetadata.name,
          taskAgentVersion: taskAgentMetadata.version,
          runtimeRegisterPath: resolveBunAampPreloadPath(join(this.projectRoot, "scripts", "aamp-runtime-register.mjs")),
          larkCliShimPath,
          configDir,
          shimDir: this.shimDir,
          environment: {
            ...buildAampNetworkEnvironment(this.config),
            AAMP_TASK_SKIP_MACOS_QUARANTINE: AAMP_SKIP_MACOS_QUARANTINE,
            AAMP_COMMAND_CONFIG_PATH: this.configPath,
            ...(this.inheritedEnv.CODEX_HOME ? { CODEX_HOME: this.inheritedEnv.CODEX_HOME } : {}),
            NPM_CONFIG_CACHE: resolveAampNpmCacheDir(this.inheritedEnv),
            NPM_GLOBAL_PREFIX: bunPackageManagerPrefix,
            ...buildAampPersistenceEnvironment(this.config, this.sqlitePath, this.attachmentsDir),
            ...buildAampWorktreeEnvironment(
              this.config,
              join(this.projectRoot, "runtime", "aamp", "worktree-tasks"),
            ),
          },
        }),
      );
      writeExecutable(
        this.commandPath,
        buildOfficialCommandShim({
          target: this.officialCommandPath,
          bootstrapPath: this.taskCommandPath,
          runtimeRegisterPath: resolveBunAampPreloadPath(join(this.projectRoot, "scripts", "aamp-runtime-register.mjs")),
          bunPath: process.execPath,
        }),
      );
      try {
        seedAampCardDedupState(cardDedupStatePath, this.inheritedEnv);
      } catch (error) {
        this.logger?.warn("could not seed AAMP card dedup state", {
          path: cardDedupStatePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Set this before the official controller handles install/start/restart.
    // It writes this value into launchd's plist and starts the service from it;
    // repairing the plist after the command returns leaves a replay window.
    const env = buildAampEnvironment(
      this.config,
      this.inheritedEnv,
      this.shimDir,
      larkCliPath ? serviceBootstrapShimPath : undefined,
    );
    env.NPM_GLOBAL_PREFIX = bunPackageManagerPrefix;
    if (larkCliPath) {
      // The official bootstrap persists this value into the Feishu runtime
      // profile and passes it verbatim to the Agent prompt. It must therefore
      // be the absolute compatibility shim, not merely a PATH-preferred name.
      env.AAMP_LARK_CLI_BIN = larkCliShimPath;
    } else {
      delete env.AAMP_LARK_CLI_BIN;
      delete env.AAMP_TASK_BOOTSTRAP_PATH;
    }
    env.AAMP_COMMAND_CONFIG_PATH = this.configPath;
    return env;
  }

  private async repairLaunchdService(_command: string): Promise<void> {
    if (process.platform !== "darwin") return;

    const bootstrapShimPath = this.serviceBootstrapPath;
    if (!existsSync(bootstrapShimPath)) return;
    const plistPath = join(
      homedir(),
      "Library",
      "LaunchAgents",
      `${AAMP_SERVICE_LABEL}.plist`,
    );
    if (!existsSync(plistPath)) return;

    const currentPlist = readFileSync(plistPath, "utf8");
    const repairedPlist = replaceLaunchdBootstrapPath(currentPlist, bootstrapShimPath);
    if (repairedPlist === undefined) {
      this.logger?.warn("AAMP launchd plist has an unexpected format", { path: plistPath });
      return;
    }
    const markerPath = join(this.projectRoot, "runtime", "aamp", AAMP_SERVICE_REPAIR_MARKER_FILENAME);
    const plistChanged = repairedPlist !== currentPlist;
    if (plistChanged) writePrivateFile(plistPath, repairedPlist);
    if (!plistChanged) {
      // The environment passed above made the official controller write the
      // correct bootstrap path before launchd was started. Do not reload a
      // healthy service here: that would create another event-replay window.
      if (!existsSync(markerPath)) {
        writePrivateFile(
          markerPath,
          `${JSON.stringify({ version: 1, bootstrapPath: bootstrapShimPath, repairedAt: new Date().toISOString() }, null, 2)}\n`,
        );
      }
      this.logger?.info("AAMP launchd service already uses project compatibility shims", {
        bootstrapPath: bootstrapShimPath,
        larkCliPath: join(this.shimDir, "lark-cli"),
      });
      return;
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const target = `gui/${uid}/${AAMP_SERVICE_LABEL}`;
    const domain = `gui/${uid}`;
    const current = await spawnCaptured("/bin/launchctl", ["print", target]);
    if (current.exitCode === 0) {
      const stopped = await spawnCaptured("/bin/launchctl", ["bootout", target]);
      if (stopped.exitCode !== 0 && !launchdNotLoaded(stopped)) {
        throw new Error(
          `failed to reload AAMP launchd service: ${stopped.stderr.trim() || stopped.stdout.trim()}`,
        );
      }
      if (stopped.exitCode === 0 && !(await waitForLaunchdUnloaded(target))) {
        throw new Error("failed to reload AAMP launchd service: service remained loaded after bootout");
      }
    }
    const started = await bootstrapLaunchdService(domain, plistPath);
    if (started.exitCode !== 0) {
      throw new Error(
        `failed to bootstrap repaired AAMP launchd service: ${started.stderr.trim() || started.stdout.trim()}`,
      );
    }
    const stateHome = resolveAampStateHome(this.inheritedEnv);
    await waitForLaunchdReady(
      target,
      join(stateHome, "service-v1", "readiness.json"),
      undefined,
      resolveAampRestartReadyTimeout(this.inheritedEnv),
    );
    writePrivateFile(
      markerPath,
      `${JSON.stringify({ version: 1, bootstrapPath: bootstrapShimPath, repairedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    this.logger?.info("reloaded AAMP launchd service with project compatibility shims", {
      bootstrapPath: bootstrapShimPath,
      larkCliPath: join(this.shimDir, "lark-cli"),
    });
  }
}

export function parseAampRestartArguments(
  args: string[],
  inherited: NodeJS.ProcessEnv = process.env,
): AampRestartArguments {
  if (args.length === 0 || args[0] !== "restart") {
    throw new Error("AAMP restart arguments must start with restart");
  }
  let mode: AampRestartMode = inherited.AAMP_RESTART_MODE === "cold" ? "cold" : "hot";
  let explicitMode: AampRestartMode | undefined;
  const forwardedArgs = [args[0]];
  for (const arg of args.slice(1)) {
    const requestedMode = arg === "--hot"
      ? "hot"
      : arg === "--cold"
        ? "cold"
        : undefined;
    if (!requestedMode) {
      forwardedArgs.push(arg);
      continue;
    }
    if (explicitMode && explicitMode !== requestedMode) {
      throw new Error("restart cannot combine --hot and --cold");
    }
    explicitMode = requestedMode;
    mode = requestedMode;
  }
  return { mode, forwardedArgs };
}

function resolveAampRestartTraceFile(inherited: NodeJS.ProcessEnv): string {
  return resolve(
    inherited.AAMP_RESTART_TRACE_FILE
      || join(
        inherited.AAMP_LOG_DIR || join(homedir(), ".aamp", "logs"),
        AAMP_RESTART_TRACE_FILENAME,
      ),
  );
}

function resolveAampRestartReadyTimeout(inherited: NodeJS.ProcessEnv): number {
  const configured = Number(inherited.AAMP_RESTART_READY_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 5_000 && configured <= 900_000) {
    return configured;
  }
  return AAMP_SERVICE_READY_TIMEOUT_MS;
}

export function composeAampRestartPhases(
  adapterPhases: AampRestartPhase[],
  observedPhases: AampRestartPhase[],
): AampRestartPhase[] {
  if (!observedPhases.length) return adapterPhases;
  const adapter = adapterPhases.filter((phase) => (
    phase.name === "准备本地适配环境"
      || phase.name === "快速重启（保留 launchd 服务）"
      || phase.name === "检查 launchd 兼容路径"
      || phase.name === "官方 AAMP 冷重启"
  ));
  const total = observedPhases.find((phase) => phase.name === "总耗时");
  return [
    ...adapter,
    ...observedPhases.filter((phase) => phase.name !== "总耗时"),
    ...(total ? [total] : []),
  ];
}

function readAampLaunchdSelection(selectionPath: string): string[] {
  try {
    const selection = JSON.parse(readFileSync(selectionPath, "utf8")) as AampLaunchdSelection;
    if (!Array.isArray(selection.binding_ids)) return [];
    return [...new Set(
      selection.binding_ids.filter((value): value is string => (
        typeof value === "string" && value.length > 0
      )),
    )];
  } catch {
    return [];
  }
}

async function withServiceControlLock<T>(
  lockPath: string,
  callback: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const ownerPath = join(lockPath, "owner.json");
  while (Date.now() - startedAt < 10_000) {
    let acquired = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      acquired = true;
      writePrivateFile(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      );
      try {
        return await callback();
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (acquired || errorCode(error) !== "EEXIST") throw error;
      let ownerPid: number | undefined;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
        const parsedPid = Number(owner.pid);
        if (Number.isInteger(parsedPid) && parsedPid > 0) ownerPid = parsedPid;
      } catch {
        // The official controller may be between mkdir and owner.json write.
      }
      if (!ownerPid) {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs < 5_000) {
            await delay(150);
            continue;
          }
        } catch {
          continue;
        }
      }
      if (!ownerPid || !isProcessAlive(ownerPid)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      await delay(150);
    }
  }
  throw new Error("后台服务配置正在被另一个 feishu-task-agent 进程使用");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function buildAampEnvironment(
  config: BridgeConfig,
  inherited: NodeJS.ProcessEnv = process.env,
  shimDir?: string,
  serviceBootstrapPath?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string") env[key] = value;
  }
  const configDir = resolveLarkConfigDir(config, inherited, true);
  env.AAMP_LARK_CLI_CONFIG_DIR = configDir;
  env.LARKSUITE_CLI_CONFIG_DIR = configDir;
  Object.assign(env, buildAampNetworkEnvironment(config));
  env.AAMP_TASK_SKIP_MACOS_QUARANTINE = AAMP_SKIP_MACOS_QUARANTINE;
  const npmCacheDir = resolveAampNpmCacheDir(inherited);
  env.NPM_CONFIG_CACHE = npmCacheDir;
  env.npm_config_cache = npmCacheDir;
  if (config.relay.enabled && config.relay.aampHost) {
    env.AAMP_TASK_AAMP_HOST = config.relay.aampHost;
  }
  if (shimDir) env.PATH = prependPath(shimDir, env.PATH);
  if (serviceBootstrapPath) env.AAMP_TASK_BOOTSTRAP_PATH = serviceBootstrapPath;
  return env;
}

/**
 * The official controller removes proxy variables before creating its online
 * bridge environment. Keep configured values under adapter-owned names so the
 * runtime loader can restore them after that cleanup.
 */
export function buildAampNetworkEnvironment(config: BridgeConfig): Record<string, string> {
  const environment: Record<string, string> = {};
  if (config.codex.env.HTTP_PROXY) environment.AAMP_TASK_HTTP_PROXY = config.codex.env.HTTP_PROXY;
  if (config.codex.env.HTTPS_PROXY) environment.AAMP_TASK_HTTPS_PROXY = config.codex.env.HTTPS_PROXY;
  return environment;
}

function buildProxyEnvironment(config: BridgeConfig): Record<string, string> {
  const environment: Record<string, string> = {};
  if (config.codex.env.HTTP_PROXY) environment.HTTP_PROXY = config.codex.env.HTTP_PROXY;
  if (config.codex.env.HTTPS_PROXY) environment.HTTPS_PROXY = config.codex.env.HTTPS_PROXY;
  return environment;
}

export function buildLarkCliShim(options: {
  target: string;
  configDir: string;
  cardDedupStatePath: string;
  compatScriptPath: string;
  bunPath: string;
}): string {
  const lines = ["#!/bin/sh", "set -eu"];
  lines.push(`export LARKSUITE_CLI_CONFIG_DIR=${shellQuote(options.configDir)}`);
  lines.push(`export AAMP_REAL_LARK_CLI_BIN=${shellQuote(options.target)}`);
  lines.push(`export AAMP_LARK_CARD_DEDUP_STATE=${shellQuote(options.cardDedupStatePath)}`);
  lines.push(
    `exec ${shellQuote(options.bunPath)} ${shellQuote(options.compatScriptPath)} "$@"`,
    "",
  );
  return lines.join("\n");
}

export function buildOfficialCommandShim(options: {
  target: string;
  bootstrapPath: string;
  runtimeRegisterPath?: string;
  bunPath?: string;
}): string {
  const lines = ["#!/bin/sh", "set -eu"];
  if (options.runtimeRegisterPath) {
    lines.push(bunOptionsAssignment(options.runtimeRegisterPath));
  }
  lines.push(`export AAMP_TASK_COMMAND_PATH=${shellQuote(options.bootstrapPath)}`);
  if (isNodeTaskAgentEntry(options.target)) {
    lines.push(`exec ${shellQuote(options.bunPath || process.execPath)} ${shellQuote(options.target)} "$@"`, "");
  } else {
    lines.push(`exec /bin/bash -s -- "$@" < ${shellQuote(options.target)}`, "");
  }
  return lines.join("\n");
}

export function buildServiceBootstrapShim(options: {
  target: string;
  taskCommandPath?: string;
  taskAgentName?: string;
  taskAgentVersion?: string;
  runtimeRegisterPath?: string;
  larkCliShimPath: string;
  configDir: string;
  shimDir: string;
  environment?: Record<string, string>;
}): string {
  const lines = [
    "#!/bin/sh",
    "set -eu",
    `AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-${doubleQuoteValue(options.taskAgentName || PACKAGE_NAME)}}"`,
    `AAMP_TASK_AGENT_VERSION="${doubleQuoteValue(options.taskAgentVersion || "0.0.0")}"`,
  ];
  if (options.taskCommandPath) {
    lines.push(`export AAMP_TASK_COMMAND_PATH=${shellQuote(options.taskCommandPath)}`);
  }
  if (options.runtimeRegisterPath) {
    lines.push(bunOptionsAssignment(options.runtimeRegisterPath));
  }
  lines.push(`export AAMP_LARK_CLI_BIN=${shellQuote(options.larkCliShimPath)}`);
  lines.push(`export AAMP_LARK_CLI_CONFIG_DIR=${shellQuote(options.configDir)}`);
  lines.push(`export LARKSUITE_CLI_CONFIG_DIR=${shellQuote(options.configDir)}`);
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    if (!isSupportedAampServiceEnvironmentKey(key)) {
      throw new Error(`unsupported AAMP service environment key: ${key}`);
    }
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push(`export PATH=${shellQuote(options.shimDir)}:"\${PATH:-}"`);
  lines.push(`exec ${shellQuote(options.target)} "$@"`, "");
  return lines.join("\n");
}

export function buildAampPersistenceEnvironment(
  config: BridgeConfig,
  sqlitePath: string,
  attachmentsDir: string,
): Record<string, string> {
  const environment: Record<string, string> = {
    AAMP_BRIDGE_SQLITE_PATH: resolve(sqlitePath),
    AAMP_BRIDGE_ATTACHMENTS_DIR: resolve(attachmentsDir),
  };
  if (config.relay.enabled && config.relay.aampHost) {
    environment.AAMP_TASK_AAMP_HOST = config.relay.aampHost;
  }
  return environment;
}

export function buildAampWorktreeEnvironment(
  config: BridgeConfig,
  metadataDir: string,
): Record<string, string> {
  const worktree = config.aamp.worktree;
  if (!worktree?.enabled) return {};
  return {
    AAMP_CODEX_WORKTREE_ENABLED: "1",
    AAMP_CODEX_PROJECT_MAP: worktree.projectMapPath,
    AAMP_CODEX_GLOBAL_AGENTS: worktree.globalAgentsPath,
    AAMP_CODEX_TASK_DIR: worktree.taskDir,
    AAMP_CODEX_WORKTREE_ROOT: worktree.worktreeRoot,
    AAMP_CODEX_WORKTREE_BASE_REF: worktree.baseRef,
    AAMP_CODEX_WORKTREE_BRANCH_PREFIX: worktree.branchPrefix,
    AAMP_CODEX_WORKTREE_METADATA_DIR: metadataDir,
  };
}

export function replaceLaunchdBootstrapPath(
  plist: string,
  bootstrapPath: string,
): string | undefined {
  const programArguments = /(<key>ProgramArguments<\/key>\s*<array>\s*<string>)([\s\S]*?)(<\/string>)/;
  const match = programArguments.exec(plist);
  if (!match) return undefined;
  const replacement = `${match[1]}${xmlEscape(bootstrapPath)}${match[3]}`;
  return plist.replace(match[0], replacement);
}

export function mergeAampCardDedupSeedEntries(
  currentEntries: Record<string, AampCardDedupEntry>,
  taskState: unknown,
): Record<string, AampCardDedupEntry> {
  const next = { ...currentEntries };
  const tasks = asRecord(asRecord(taskState)?.tasks);
  if (!tasks) return next;
  for (const task of Object.values(tasks)) {
    const record = asRecord(task);
    const replyTo = asString(record?.bridgeMessageId) || asString(record?.userMessageId);
    const messageId = asString(record?.helpCardMessageId);
    // The official state is authoritative when it already knows the latest
    // help card. This also repairs mappings left behind by an earlier
    // unshimmed restart that created a duplicate card.
    if (replyTo && messageId && next[replyTo]?.messageId !== messageId) {
      next[replyTo] = { messageId };
    }
  }
  return next;
}

export function seedAampCardDedupState(
  dedupStatePath: string,
  inherited: NodeJS.ProcessEnv = process.env,
): void {
  const currentState = readAampCardDedupState(dedupStatePath);
  let entries = currentState.entries;
  let changed = false;
  for (const statePath of findAampTaskStateFiles(inherited)) {
    let taskState: unknown;
    try {
      taskState = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    } catch {
      continue;
    }
    const merged = mergeAampCardDedupSeedEntries(entries, taskState);
    if (!cardDedupEntriesEqual(merged, entries)) changed = true;
    entries = merged;
  }
  if (!changed) return;
  writePrivateFile(
    dedupStatePath,
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
  );
}

function resolveTaskAgentCommand(projectRoot: string): string {
  const require = createRequire(import.meta.url);
  try {
    const packageJsonPath = require.resolve(`${PACKAGE_NAME}/package.json`) as string;
    const packageRoot = dirname(packageJsonPath);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = packageJson.bin;
    const binPath = typeof bin === "string"
      ? bin
      : bin
        ? PACKAGE_BIN_NAMES.map((name) => bin[name]).find((value) => typeof value === "string")
        : undefined;
    if (binPath) {
      const resolvedBin = resolve(packageRoot, binPath);
      if (existsSync(resolvedBin)) return resolvedBin;
    }
  } catch {
    // Fall through to the package-manager-created bin shim below. This keeps
    // the adapter tolerant of a future package export map change.
  }

  const localBin = join(projectRoot, "node_modules", ".bin", "feishu-task-agent");
  if (existsSync(localBin)) return localBin;
  throw new Error(
    `${PACKAGE_NAME} is not installed. Run bun install before using the AAMP runtime.`,
  );
}

function isNodeTaskAgentEntry(target: string): boolean {
  if (/\.(?:c|m)?js$/i.test(target)) return true;
  try {
    return readFileSync(target, "utf8").startsWith("#!/usr/bin/env node");
  } catch {
    return false;
  }
}

function readTaskAgentMetadata(commandPath: string): { name: string; version: string } {
  let source = "";
  try {
    source = readFileSync(commandPath, "utf8");
  } catch {
    // The package metadata fallback below keeps the generated wrapper useful
    // if a future package changes its bin layout.
  }
  const name = source.match(/^AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-([^}]*)\}"$/m)?.[1]
    || PACKAGE_NAME;
  const version = source.match(/^AAMP_TASK_AGENT_VERSION="([^"]+)"/m)?.[1]
    || readTaskAgentPackageVersion();
  return { name, version };
}

function readTaskAgentPackageVersion(): string {
  const require = createRequire(import.meta.url);
  try {
    const packageJsonPath = require.resolve(`${PACKAGE_NAME}/package.json`) as string;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.length > 0
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveAampLarkCliPath(
  config: BridgeConfig,
  inherited: NodeJS.ProcessEnv,
): string | undefined {
  const configured = config.lark.cliPath;
  if (configured) return configured;

  const explicit = [inherited.AAMP_LARK_CLI_BIN, inherited.LARK_CLI_PATH]
    .find((value) => typeof value === "string" && isAbsolute(value));
  if (explicit) return explicit;

  if (existsSync(DEFAULT_AAMP_LARK_CLI_PATH)) return DEFAULT_AAMP_LARK_CLI_PATH;
  return findExecutableInPath("lark-cli", inherited.PATH);
}

function resolveAampNpmCacheDir(inherited: NodeJS.ProcessEnv): string {
  return resolve(
    inherited.AAMP_NPM_CACHE_DIR
      || inherited.AAMP_TASK_NPM_CACHE_DIR
      || inherited.NPM_CONFIG_CACHE
      || inherited.npm_config_cache
      || join(homedir(), ".aamp", "npm-cache"),
  );
}

function readAampCardDedupState(
  filePath: string,
): { version: 1; entries: Record<string, AampCardDedupEntry> } {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const entries = asRecord(asRecord(parsed)?.entries);
    if (!entries) return { version: 1, entries: {} };
    return {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(entries).filter(([, value]) => isCardDedupEntry(value)),
      ) as Record<string, AampCardDedupEntry>,
    };
  } catch {
    return { version: 1, entries: {} };
  }
}

function findAampTaskStateFiles(inherited: NodeJS.ProcessEnv): string[] {
  const stateHome = inherited.AAMP_TASK_STATE_HOME
    || join(homedir(), ".aamp", "feishu-task-agent");
  const runtimeHome = inherited.AAMP_TASK_RUNTIME_HOME
    || join(stateHome, "runtime-v1");
  const bindingsDir = join(runtimeHome, "bindings");
  const stateFiles: string[] = [];
  for (const bindingDir of directoryEntries(bindingsDir)) {
    const instancesDir = join(
      bindingsDir,
      bindingDir,
      "feishu-bridge",
      "task-runtime",
      "instances",
    );
    for (const instanceDir of directoryEntries(instancesDir)) {
      const statePath = join(instancesDir, instanceDir, "im", "state.json");
      if (existsSync(statePath)) stateFiles.push(statePath);
    }
  }
  return stateFiles;
}

function directoryEntries(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isCardDedupEntry(value: unknown): value is AampCardDedupEntry {
  return Boolean(asString(asRecord(value)?.messageId));
}

function cardDedupEntriesEqual(
  left: Record<string, AampCardDedupEntry>,
  right: Record<string, AampCardDedupEntry>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key]?.messageId === right[key]?.messageId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shouldRepairLaunchd(command: string): boolean {
  return ["install", "add", "start", "restart"].includes(command);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function writePrivateFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

interface CapturedProcess {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnCaptured(file: string, args: string[]): Promise<CapturedProcess> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: CapturedProcess): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ exitCode: 127, stdout: "", stderr: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      finish({ exitCode: 127, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.once("close", (exitCode) => {
      finish({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function launchdNotLoaded(result: CapturedProcess): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes("could not find service")
    || output.includes("no such process")
    || output.includes("service is not loaded");
}

async function waitForLaunchdReady(
  target: string,
  readinessPath: string,
  onProgress?: (elapsedMs: number) => void,
  timeoutMs = AAMP_SERVICE_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  while (Date.now() < deadline) {
    const status = await spawnCaptured("/bin/launchctl", ["print", target]);
    if (status.exitCode === 0 && /(?:^|\n)\s*state\s*=\s*running\b/.test(status.stdout)) {
      try {
        const readiness = JSON.parse(readFileSync(readinessPath, "utf8")) as {
          state?: unknown;
        };
        if (readiness.state === "ready") return;
      } catch {
        // The service may be running while it is still preparing its bindings.
      }
    }
    const now = Date.now();
    if (onProgress && now - lastProgressAt >= 5_000) {
      onProgress(now - startedAt);
      lastProgressAt = now;
    }
    await delay(500);
  }
  throw new Error(`等待 AAMP launchd 服务 ready 超时（${timeoutMs} ms）`);
}

async function waitForLaunchdUnloaded(target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const status = await spawnCaptured("/bin/launchctl", ["print", target]);
    if (status.exitCode !== 0 && launchdNotLoaded(status)) return true;
    if (attempt < 24) await delay(500);
  }
  return false;
}

async function bootstrapLaunchdService(domain: string, plistPath: string): Promise<CapturedProcess> {
  let result: CapturedProcess = {
    exitCode: 1,
    stdout: "",
    stderr: "launchctl bootstrap was not attempted",
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await spawnCaptured("/bin/launchctl", ["bootstrap", domain, plistPath]);
    if (result.exitCode === 0 || attempt === 4) return result;

    // launchctl can briefly keep the old service transaction around after
    // bootout. A short retry avoids leaving the service unloaded on an
    // otherwise successful AAMP restart.
    await delay(500);
  }

  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function buildExecutableShim(options: {
  target: string;
  environment: Record<string, string>;
}): string {
  const lines = ["#!/bin/sh", "set -eu"];
  for (const [key, value] of Object.entries(options.environment)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push(`exec ${shellQuote(options.target)} "$@"`, "");
  return lines.join("\n");
}

/**
 * The upstream bootstrap has no opt-out for its macOS quarantine probe. The
 * service PATH points at this shim first; it is a no-op only when the adapter
 * explicitly enables the skip flag, otherwise it preserves the system call.
 */
export function buildBunNodeShim(bunPath: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `exec ${shellQuote(bunPath)} "$@"`,
    "",
  ].join("\n");
}

export function buildBunPackageManagerShim(
  bunPath: string,
  scriptPath: string,
  command: "npm" | "npx",
): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `exec ${shellQuote(bunPath)} ${shellQuote(scriptPath)} ${command} "$@"`,
    "",
  ].join("\n");
}
export function buildAampXattrShim(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `if [ "\${AAMP_TASK_SKIP_MACOS_QUARANTINE:-}" = ${shellQuote(AAMP_SKIP_MACOS_QUARANTINE)} ]; then`,
    "  exit 0",
    "fi",
    `exec ${shellQuote("/usr/bin/xattr")} "$@"`,
    "",
  ].join("\n");
}

function writeExecutable(filePath: string, content: string): void {
  let current: string | undefined;
  try {
    current = readFileSync(filePath, "utf8");
  } catch {
    // The shim is generated on first use.
  }
  if (current !== content) writeFileSync(filePath, content, { mode: 0o700 });
  chmodSync(filePath, 0o700);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveBunAampPreloadPath(runtimeRegisterPath: string): string {
  const uid = process.getuid?.() ?? "user";
  const projectHash = createHash("sha256").update(resolve(runtimeRegisterPath)).digest("hex").slice(0, 12);
  const preloadDirectory = join("/private/tmp", `feishu-codex-bridge-aamp-${uid}-${projectHash}`);
  mkdirSync(preloadDirectory, { recursive: true, mode: 0o700 });
  chmodSync(preloadDirectory, 0o700);
  const preloadPath = join(preloadDirectory, "runtime-register.mjs");
  writeFileSync(
    preloadPath,
    `import ${JSON.stringify(pathToFileURL(runtimeRegisterPath).href)};\n`,
    { mode: 0o600 },
  );
  chmodSync(preloadPath, 0o600);
  return preloadPath;
}

function bunOptionsAssignment(runtimeRegisterPath: string): string {
  return `export BUN_OPTIONS=${shellQuote(`--preload=${runtimeRegisterPath} `)}"\${BUN_OPTIONS:-}"`;
}

function doubleQuoteValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");
}

function isSupportedAampServiceEnvironmentKey(key: string): boolean {
  return /^AAMP_CODEX_[A-Z0-9_]+$/.test(key)
    || /^AAMP_BRIDGE_[A-Z0-9_]+$/.test(key)
    || key === "AAMP_COMMAND_CONFIG_PATH"
    || key === "CODEX_HOME"
    || key === "AAMP_TASK_AAMP_HOST"
    || key === "AAMP_TASK_HTTP_PROXY"
    || key === "AAMP_TASK_HTTPS_PROXY"
    || key === "AAMP_TASK_SKIP_MACOS_QUARANTINE"
    || key === "NPM_CONFIG_CACHE"
    || key === "npm_config_cache"
    || key === "NPM_GLOBAL_PREFIX";
}

function spawnInherited(
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        `official feishu-task-agent ${args[0]} failed with ${
          signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`
        }`,
      ));
    });
  });
}
