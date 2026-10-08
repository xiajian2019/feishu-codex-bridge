import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z, ZodError } from "zod";

import { EXECUTION_MODES, type BridgeConfig, type ExecutionMode, type ModeConfig, type ProjectConfig } from "./types.js";

const projectSchema = z.object({
  optionGuid: z.string().min(1),
  repo: z.string().min(1),
}).strict();

const modeSchema = z.object({
  optionGuid: z.string().min(1),
  sandboxMode: z.enum(["read-only", "workspace-write"]),
}).strict();

const webSchema = z.object({
  enabled: z.boolean().default(true),
  // Config stays loopback-only by default. The authenticated system service
  // opts into LAN binding for QR pairing through its LaunchAgent.
  host: z.literal("127.0.0.1").default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(7310),
}).strict();

const aampWorktreeSchema = z.object({
  enabled: z.boolean().default(true),
  projectMapPath: z.string().trim().min(1).optional(),
  globalAgentsPath: z.string().trim().min(1),
  taskDir: z.string().trim().min(1),
  worktreeRoot: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).default("HEAD"),
  branchPrefix: z.string().trim().min(1).default("xiajian/agent"),
}).strict();

const relaySchema = z.object({
  enabled: z.boolean().default(false),
  aampHost: z.string().trim().min(1).optional(),
  statusUrl: z.string().trim().min(1).optional(),
  authToken: z.string().trim().min(1).optional(),
}).strict();

const executionSchema = z.object({
  mode: z.enum(EXECUTION_MODES),
}).strict();

const directFeishuSchema = z.object({
  // Optional in direct mode: the shared adapter can read an existing AAMP
  // Codex binding, while these fields remain available as explicit overrides.
  appId: z.string().trim().min(1).optional(),
  appSecret: z.string().trim().min(1).optional(),
  appIdEnv: z.string().trim().min(1).default("FEISHU_APP_ID"),
  appSecretEnv: z.string().trim().min(1).default("FEISHU_APP_SECRET"),
  domain: z.string().trim().min(1).optional(),
  groupAllowlist: z.array(z.string().trim().min(1)).default([]),
  dmMode: z.enum(["open", "allowlist", "disabled"]).default("open"),
  dmAllowlist: z.array(z.string().trim().min(1)).default([]),
  allowedSenderOpenIds: z.array(z.string().trim().min(1)).default([]),
  requireMention: z.boolean().default(true),
  replyInThread: z.boolean().default(false),
}).strict();

const directPermissionRuleSchema = z.object({
  chatId: z.string().trim().min(1).optional(),
  senderOpenId: z.string().trim().min(1).optional(),
  chatType: z.enum(["p2p", "group"]).optional(),
  allow: z.boolean().optional(),
  allowAttachments: z.boolean().optional(),
  allowCancel: z.boolean().optional(),
}).strict().superRefine((rule, context) => {
  if (!rule.chatId && !rule.senderOpenId && !rule.chatType) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "at least one of chatId, senderOpenId, or chatType is required",
    });
  }
});

const directPermissionsSchema = z.object({
  defaultAllow: z.boolean().default(true),
  allowAttachments: z.boolean().default(true),
  allowCancel: z.boolean().default(true),
  rules: z.array(directPermissionRuleSchema).default([]),
}).strict();

const directRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  initialDelaySeconds: z.number().int().min(1).max(300).default(5),
  maxDelaySeconds: z.number().int().min(1).max(3_600).default(120),
}).strict().superRefine((retry, context) => {
  if (retry.maxDelaySeconds < retry.initialDelaySeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxDelaySeconds"],
      message: "must be greater than or equal to initialDelaySeconds",
    });
  }
});

const directSchema = z.object({
  projectKey: z.string().trim().min(1).optional(),
  mode: z.string().trim().min(1).optional(),
  retry: directRetrySchema.default({}),
  feishu: directFeishuSchema.default({}),
  permissions: directPermissionsSchema.default({}),
}).strict();

const localNotificationsSchema = z.object({
  // Disabled by default so existing installations do not change behavior until
  // the user explicitly opts into local system notifications.
  enabled: z.boolean().default(false),
  mode: z.enum(["poll", "hook"]).default("poll"),
  intervalSeconds: z.number().int().min(10).max(3_600).default(60),
}).strict();

const configSchema = z.object({
  pollIntervalSeconds: z.number().int().positive().default(20),
  maxConcurrency: z.literal(1).default(1),
  // One hour is long enough for repository reviews while bounding orphaned runs.
  runTimeoutSeconds: z.number().int().positive().default(3600),
  // Omitted for backwards compatibility: aamp.enabled=true still selects AAMP.
  execution: executionSchema.optional(),
  aamp: z.object({
    enabled: z.boolean().default(false),
    stopOnShutdown: z.boolean().default(false),
    worktree: aampWorktreeSchema.optional(),
  }).strict().default({}),
  relay: relaySchema.default({}),
  direct: directSchema.default({}),
  localNotifications: localNotificationsSchema.default({}),
  web: webSchema.default({}),
  lark: z.object({
    profile: z.string().trim().min(1),
    configDir: z.string().trim().min(1).optional(),
    cliPath: z.string().trim().min(1).optional(),
    tasklistGuid: z.string().min(1),
    projectFieldGuid: z.string().min(1),
    modeFieldGuid: z.string().min(1),
    allowedCreatorOpenIds: z.array(z.string().min(1)).optional(),
  }).strict(),
  codex: z.object({
    cliPath: z.string().min(1),
    env: z.object({
      HTTP_PROXY: z.string().trim().min(1).optional(),
      HTTPS_PROXY: z.string().trim().min(1).optional(),
    }).strict().default({}),
  }).strict(),
  // A direct Feishu runtime can start before a project or execution mode has
  // been selected. The task message may provide those values later. AAMP and
  // the legacy task-list path still validate that their registries are not
  // empty below, when they are the active execution mode.
  projects: z.record(projectSchema).default({}),
  modes: z.record(modeSchema).default({}),
}).strict();

export interface ConfigLoadOptions {
  /** Skip local repository checks when parsing a fixture or planning a config. */
  checkRepositories?: boolean;
  /** Override execution.mode without mutating the JSON config on disk. */
  executionMode?: ExecutionMode;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(
  raw: unknown,
  options: ConfigLoadOptions = {},
): BridgeConfig {
  let config: BridgeConfig;
  try {
    const parsed = configSchema.parse(raw);
    const mode: ExecutionMode = options.executionMode
      ?? parsed.execution?.mode
      ?? (parsed.aamp.enabled ? "aamp-relay" : "legacy-polling");
    config = {
      ...parsed,
      execution: { mode },
    } as BridgeConfig;
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ");
      throw new ConfigError(`Invalid config: ${details}`);
    }
    throw error;
  }

  validateUniqueGuids(config);
  if (!isAbsolute(config.codex.cliPath)) {
    throw new ConfigError(
      "codex.cliPath must be an absolute path to the system Codex CLI",
    );
  }
  if (config.lark.configDir && !isAbsolute(config.lark.configDir)) {
    throw new ConfigError(
      "lark.configDir must be an absolute path to the lark-cli config directory",
    );
  }
  if (config.lark.cliPath && !isAbsolute(config.lark.cliPath)) {
    throw new ConfigError(
      "lark.cliPath must be an absolute path to the lark-cli executable",
    );
  }
  if (config.aamp.worktree) {
    const worktreePaths = {
      globalAgentsPath: config.aamp.worktree.globalAgentsPath,
      taskDir: config.aamp.worktree.taskDir,
      worktreeRoot: config.aamp.worktree.worktreeRoot,
    };
    for (const [field, value] of Object.entries(worktreePaths)) {
      if (!isAbsolute(value)) {
        throw new ConfigError(`aamp.worktree.${field} must be an absolute path`);
      }
    }
  }

  // Relay settings belong to the AAMP runtime. A direct invocation must be
  // able to override an old AAMP config without being blocked by stale relay
  // fields that the direct runtime never reads.
  if (config.execution.mode === "aamp-relay") {
    if (config.relay.enabled && !config.relay.aampHost) {
      throw new ConfigError("relay.aampHost is required when relay.enabled=true");
    }
    if (config.relay.aampHost && !isRelayUrl(config.relay.aampHost)) {
      throw new ConfigError("relay.aampHost must use http://, https://, ws://, or wss://");
    }
    if (config.relay.enabled && config.relay.aampHost && isPublicMeshmailUrl(config.relay.aampHost)) {
      throw new ConfigError("relay.aampHost must point to the internal AAMP Relay, not meshmail.ai");
    }
    if (config.relay.statusUrl && !isHttpUrl(config.relay.statusUrl)) {
      throw new ConfigError("relay.statusUrl must use http:// or https://");
    }
  }

  if (isDirectExecutionMode(config.execution.mode)) {
    if (config.direct.mode && !config.modes[config.direct.mode]) {
      throw new ConfigError(
        `direct.mode does not reference a configured mode: ${config.direct.mode}`,
      );
    }
  } else {
    if (Object.keys(config.projects).length === 0) {
      throw new ConfigError("at least one project is required outside direct Feishu mode");
    }
    if (Object.keys(config.modes).length === 0) {
      throw new ConfigError("at least one mode is required outside direct Feishu mode");
    }
  }

  for (const [projectKey, project] of Object.entries(config.projects)) {
    if (!isAbsolute(project.repo)) {
      throw new ConfigError(`projects.${projectKey}.repo must be an absolute path`);
    }
    if (options.checkRepositories !== false) {
      validateGitRepository(projectKey, project);
    }
  }

  return config;
}

export function isDirectExecutionMode(mode: ExecutionMode): boolean {
  return mode === "feishu-sqlite-codex" || mode === "feishu-sqlite-acp";
}

export function parseExecutionMode(value: string): ExecutionMode {
  if ((EXECUTION_MODES as readonly string[]).includes(value)) {
    return value as ExecutionMode;
  }
  throw new ConfigError(
    `未知 execution mode：${value}；可选值：${EXECUTION_MODES.join(", ")}`,
  );
}

function isRelayUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return ["http:", "https:", "ws:", "wss:"].includes(protocol);
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isPublicMeshmailUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "meshmail.ai" || hostname.endsWith(".meshmail.ai");
  } catch {
    return false;
  }
}

export function loadConfig(
  filePath: string,
  options: ConfigLoadOptions = {},
): BridgeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot read config ${filePath}: ${message}`);
  }
  return parseConfig(raw, options);
}

export function findProjectByOptionGuid(
  config: BridgeConfig,
  optionGuid: string,
): { key: string; value: ProjectConfig } | undefined {
  for (const [key, value] of Object.entries(config.projects)) {
    if (value.optionGuid === optionGuid) {
      return { key, value };
    }
  }
  return undefined;
}

export function findModeByOptionGuid(
  config: BridgeConfig,
  optionGuid: string,
): { key: string; value: ModeConfig } | undefined {
  for (const [key, value] of Object.entries(config.modes)) {
    if (value.optionGuid === optionGuid) {
      return { key, value };
    }
  }
  return undefined;
}

function validateUniqueGuids(config: BridgeConfig): void {
  const guids = [
    config.lark.tasklistGuid,
    config.lark.projectFieldGuid,
    config.lark.modeFieldGuid,
    ...Object.values(config.projects).map((project) => project.optionGuid),
    ...Object.values(config.modes).map((mode) => mode.optionGuid),
  ];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const guid of guids) {
    if (seen.has(guid)) {
      duplicates.add(guid);
    }
    seen.add(guid);
  }
  if (duplicates.size > 0) {
    throw new ConfigError(
      `GUIDs must be unique; duplicated: ${[...duplicates].join(", ")}`,
    );
  }
}

function validateGitRepository(projectKey: string, project: ProjectConfig): void {
  if (!existsSync(project.repo)) {
    throw new ConfigError(
      `projects.${projectKey}.repo does not exist: ${project.repo}`,
    );
  }
  try {
    if (!statSync(project.repo).isDirectory()) {
      throw new Error("path is not a directory");
    }
    const result = execFileSync(
      "git",
      ["-C", project.repo, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (result !== "true") {
      throw new Error("git did not identify a work tree");
    }
  } catch {
    throw new ConfigError(
      `projects.${projectKey}.repo is not a Git repository: ${project.repo}`,
    );
  }
}
