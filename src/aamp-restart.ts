import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type AampRestartPhaseStatus = "completed" | "failed" | "unavailable";

export interface AampRestartPhase {
  name: string;
  durationMs: number | null;
  status: AampRestartPhaseStatus;
  detail?: string;
}

export interface AampRestartTraceOptions {
  logFile?: string;
  runId?: string;
  output?: (line: string) => void;
  now?: () => number;
}

export interface AampRestartLogCollectionOptions {
  logRoot?: string;
  startedAtMs: number;
  finishedAtMs: number;
}

export interface AampRestartLogCollection {
  runDir?: string;
  phases: AampRestartPhase[];
}

interface TraceToken {
  name: string;
  startedAtMs: number;
}

interface TimestampedLine {
  timestampMs: number;
  message: string;
}

interface ParsedRun {
  directory: string;
  startedAtMs: number;
  successful: boolean;
  readyAtMs?: number;
  failureReason?: string;
}

const DEFAULT_LOG_ROOT = join(homedir(), ".aamp", "logs");
const SERVICE_RUN_COMMAND = "__service-run";

/**
 * Small project-owned trace for the adapter boundary. The official package
 * remains responsible for the runtime; this class only records when the
 * adapter enters/leaves a phase and never makes tracing failure-fatal.
 */
export class AampRestartTrace {
  private readonly output: (line: string) => void;
  private readonly now: () => number;
  private readonly logFile?: string;
  private readonly runId: string;
  private readonly records: AampRestartPhase[] = [];

  constructor(options: AampRestartTraceOptions = {}) {
    this.output = options.output ?? ((line) => console.log(line));
    this.now = options.now ?? (() => Date.now());
    this.logFile = options.logFile;
    this.runId = options.runId || `${Date.now()}-${process.pid}`;
    this.append({ type: "restart.started", timestamp: new Date(this.now()).toISOString() });
  }

  public get phases(): AampRestartPhase[] {
    return [...this.records];
  }

  public async measure<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const token = this.begin(name);
    try {
      const result = await operation();
      this.end(token, "completed");
      return result;
    } catch (error) {
      this.end(token, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  public measureSync<T>(name: string, operation: () => T): T {
    const token = this.begin(name);
    try {
      const result = operation();
      this.end(token, "completed");
      return result;
    } catch (error) {
      this.end(token, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  public begin(name: string): TraceToken {
    const startedAtMs = this.now();
    this.output(`[aamp-restart] 阶段开始：${name}`);
    this.append({
      type: "restart.phase.started",
      phase: name,
      timestamp: new Date(startedAtMs).toISOString(),
    });
    return { name, startedAtMs };
  }

  public end(
    token: TraceToken,
    status: AampRestartPhaseStatus,
    detail?: string,
  ): AampRestartPhase {
    const finishedAtMs = this.now();
    const phase: AampRestartPhase = {
      name: token.name,
      durationMs: Math.max(0, finishedAtMs - token.startedAtMs),
      status,
      ...(detail ? { detail } : {}),
    };
    this.records.push(phase);
    const suffix = status === "completed"
      ? `（${formatAampDuration(phase.durationMs)}）`
      : `（${status}${detail ? `：${detail}` : ""}）`;
    this.output(`[aamp-restart] 阶段结束：${token.name}${suffix}`);
    this.append({
      type: "restart.phase.finished",
      phase: token.name,
      status,
      durationMs: phase.durationMs,
      ...(detail ? { detail } : {}),
      timestamp: new Date(finishedAtMs).toISOString(),
    });
    return phase;
  }

  public add(phase: AampRestartPhase): void {
    this.records.push({ ...phase });
    this.append({
      type: "restart.phase.observed",
      phase: phase.name,
      status: phase.status,
      durationMs: phase.durationMs,
      ...(phase.detail ? { detail: phase.detail } : {}),
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  public info(message: string, details?: Record<string, unknown>): void {
    this.output(`[aamp-restart] ${message}`);
    this.append({
      type: "restart.info",
      message,
      ...(details ? { details } : {}),
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  public printSummary(phases = this.records): void {
    const lines = formatAampRestartTable(phases);
    for (const line of lines) this.output(line);
    if (this.logFile) this.output(`[aamp-restart] 阶段日志：${this.logFile}`);
    this.append({
      type: "restart.summary",
      phases,
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  private append(event: Record<string, unknown>): void {
    if (!this.logFile) return;
    try {
      mkdirSync(dirname(this.logFile), { recursive: true, mode: 0o700 });
      appendFileSync(
        this.logFile,
        `${JSON.stringify({ restartId: this.runId, ...event })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(this.logFile, 0o600);
    } catch {
      // Diagnostics must never prevent an AAMP restart.
    }
  }
}

export function formatAampDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
}

export function formatAampRestartTable(phases: AampRestartPhase[]): string[] {
  const nameWidth = Math.max(
    34,
    ...phases.map((phase) => phase.name.length),
  );
  const separator = `  ${"━".repeat(nameWidth)}  ${"━".repeat(14)}`;
  const lines = [
    "",
    "AAMP restart 阶段耗时",
    `  ${"阶段".padEnd(nameWidth)}  耗时`,
    separator,
  ];
  for (const phase of phases) {
    const status = phase.status === "failed"
      ? "失败"
      : phase.status === "unavailable"
        ? "未采集"
        : "";
    const duration = status ? `${formatAampDuration(phase.durationMs)} ${status}` : formatAampDuration(phase.durationMs);
    lines.push(`  ${phase.name.padEnd(nameWidth)}  ${duration}`);
    if (phase.detail) lines.push(`    原因：${phase.detail}`);
  }
  lines.push("  注：服务 ready=最终 service run 的 bootstrap→ready；总耗时=本次 restart 命令的墙钟时间。");
  lines.push("  注：快速/冷重启、前序尝试及 ACP/Feishu 阶段可能重叠或属于不同尝试，耗时不可直接相加。");
  return lines;
}

export function collectAampRestartPhases(
  options: AampRestartLogCollectionOptions,
): AampRestartLogCollection {
  const logRoot = resolve(options.logRoot || DEFAULT_LOG_ROOT);
  const runsRoot = join(logRoot, "runs");
  const candidates = readServiceRuns(runsRoot, options.startedAtMs, options.finishedAtMs);
  if (!candidates.length) return { phases: [] };

  const successful = candidates.filter((run) => run.successful);
  const run = [...(successful.length ? successful : candidates)].sort(
    (left, right) => left.startedAtMs - right.startedAtMs,
  ).at(-1);
  if (!run) return { phases: [] };

  const phases: AampRestartPhase[] = [];
  const previousFailure = candidates
    .filter((candidate) => !candidate.successful && candidate.startedAtMs < run.startedAtMs)
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .at(-1);
  const oneClickLines = readTimestampedLines(join(run.directory, "one-click.log"));
  const firstLine = oneClickLines[0];
  const versionLine = oneClickLines.find((line) => line.message.includes("当前版本："));
  const helperRegistryLine = oneClickLines.find((line, index) => (
    Boolean(versionLine)
      && index > oneClickLines.indexOf(versionLine as TimestampedLine)
      && line.message.includes("using npm registry:")
  ));
  const acpInitStart = findStageTimestamp(run.directory, "acp-init", "starting");

  if (firstLine && run.startedAtMs > 0) {
    phases.push({
      name: "重启开始到最终服务启动",
      durationMs: Math.max(0, firstLine.timestampMs - options.startedAtMs),
      status: "completed",
    });
  }
  if (previousFailure) {
    phases.push({
      name: "前序服务启动尝试",
      durationMs: Math.max(0, run.startedAtMs - previousFailure.startedAtMs),
      status: "failed",
      detail: [
        previousFailure.failureReason,
        "区间从前一次 service run 开始到本次 service run 开始，可能包含回退冷重启，不代表 launchd 自动重试",
      ].filter(Boolean).join("；"),
    });
  }
  if (firstLine && versionLine) {
    phases.push({
      name: "外层 bootstrap 初始化",
      durationMs: Math.max(0, versionLine.timestampMs - firstLine.timestampMs),
      status: "completed",
    });
  }
  if (helperRegistryLine && acpInitStart) {
    phases.push({
      name: "__prepare-agent 再次执行 bootstrap",
      durationMs: Math.max(0, acpInitStart - helperRegistryLine.timestampMs),
      status: "completed",
    });
  }

  const acpInit = findStageEvent(run.directory, "acp-init");
  const acpStart = findStageEvent(run.directory, "acp-start");
  const feishuStart = findStageEvent(run.directory, "feishu-start");
  phases.push(...stagePhase("ACP 初始化", acpInit));
  phases.push(...stagePhase("Codex ACP 启动", findAgentStartedEvent(run.directory) || acpStart));
  phases.push(...stagePhase("Feishu Bridge 启动", feishuStart));

  if (run.readyAtMs !== undefined) {
    phases.push({
      name: "服务 ready",
      durationMs: Math.max(0, run.readyAtMs - (firstLine?.timestampMs || run.startedAtMs)),
      status: "completed",
    });
  }
  phases.push({
    name: "总耗时",
    durationMs: Math.max(0, options.finishedAtMs - options.startedAtMs),
    status: run.successful ? "completed" : "failed",
    ...(run.successful
      ? {}
      : { detail: "后台服务本次启动未达到 ready，可能被后续重启或 launchd 终止" }),
  });
  return { runDir: run.directory, phases };
}

function stagePhase(
  name: string,
  event: Record<string, unknown> | undefined,
): AampRestartPhase[] {
  if (!event) return [];
  const status = event.status === "failed" ? "failed" : "completed";
  const durationValue = Number(event.durationMs);
  return [{
    name,
    durationMs: Number.isFinite(durationValue) ? Math.max(0, durationValue) : null,
    status,
    ...(typeof event.error === "string" ? { detail: event.error } : {}),
  }];
}

function readServiceRuns(
  runsRoot: string,
  startedAtMs: number,
  finishedAtMs: number,
): ParsedRun[] {
  if (!existsSync(runsRoot)) return [];
  const runs: ParsedRun[] = [];
  for (const name of readdirSync(runsRoot)) {
    const directory = join(runsRoot, name);
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (manifest.command !== SERVICE_RUN_COMMAND) continue;
      const runStartedAtMs = Date.parse(String(manifest.started_at || ""));
      if (!Number.isFinite(runStartedAtMs)
        || runStartedAtMs < startedAtMs - 5_000
        || runStartedAtMs > finishedAtMs + 5_000) continue;
      const bindings = Array.isArray(manifest.bindings) ? manifest.bindings : [];
      const statuses = bindings.filter((binding): binding is Record<string, unknown> => (
        Boolean(binding) && typeof binding === "object" && !Array.isArray(binding)
      ));
      const readyAtValues = statuses
        .filter((binding) => binding.status === "running")
        .map((binding) => Date.parse(String(binding.updated_at || "")))
        .filter((value) => Number.isFinite(value));
      const failedBinding = statuses.find((binding) => binding.status !== "running");
      const manifestReason = typeof failedBinding?.reason === "string"
        ? compactFailureReason(failedBinding.reason)
        : undefined;
      runs.push({
        directory,
        startedAtMs: runStartedAtMs,
        successful: statuses.length > 0 && statuses.every((binding) => binding.status === "running"),
        ...(readyAtValues.length ? { readyAtMs: Math.max(...readyAtValues) } : {}),
        ...(!statuses.every((binding) => binding.status === "running")
          ? { failureReason: manifestReason || readRunFailureReason(directory) }
          : {}),
      });
    } catch {
      // A run can be observed while launchd is still writing its manifest.
    }
  }
  return runs;
}

function readRunFailureReason(directory: string): string | undefined {
  const errorsPath = join(directory, "errors.jsonl");
  if (!existsSync(errorsPath)) return undefined;
  try {
    for (const line of readFileSync(errorsPath, "utf8").split("\n")) {
      try {
        const event = JSON.parse(line) as { message?: unknown };
        if (typeof event.message === "string" && event.message.length > 0) {
          return compactFailureReason(event.message);
        }
      } catch {
        // Ignore non-JSON lines in the official error log.
      }
    }
  } catch {
    // The run can still be in progress while its error log is being written.
  }
  return undefined;
}

function compactFailureReason(reason: string): string {
  const message = reason.replace(/\s+/g, " ").trim();
  return message.length > 240
    ? `${message.slice(0, 237)}...`
    : message;
}

function readTimestampedLines(filePath: string): TimestampedLine[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => {
      const match = /^(\S+)\s+/.exec(line);
      if (!match) return undefined;
      const timestampMs = Date.parse(match[1]);
      if (!Number.isFinite(timestampMs)) return undefined;
      return { timestampMs, message: line.slice(match[0].length) };
    })
    .filter((line): line is TimestampedLine => Boolean(line));
}

function readJsonlEvents(directory: string): Record<string, unknown>[] {
  if (!existsSync(directory)) return [];
  const events: Record<string, unknown>[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
        try {
          const event = JSON.parse(line) as unknown;
          if (event && typeof event === "object" && !Array.isArray(event)) {
            events.push(event as Record<string, unknown>);
          }
        } catch {
          // Bridge logs may contain human-readable lines between JSON events.
        }
      }
    } catch {
      // A bridge log can disappear during cleanup; continue with other files.
    }
  }
  return events;
}

function findStageEvent(
  directory: string,
  stage: string,
): Record<string, unknown> | undefined {
  return readJsonlEvents(directory)
    .filter((event) => event.type === "bridge.stage" && event.stage === stage)
    .filter((event) => event.status === "succeeded" || event.status === "failed")
    .sort((left, right) => (
      Date.parse(String(left.timestamp || "")) - Date.parse(String(right.timestamp || ""))
    ))
    .at(-1);
}

function findStageTimestamp(
  directory: string,
  stage: string,
  status: string,
): number | undefined {
  const timestamp = readJsonlEvents(directory)
    .filter((event) => event.type === "bridge.stage" && event.stage === stage && event.status === status)
    .map((event) => Date.parse(String(event.timestamp || "")))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)
    .at(0);
  return timestamp;
}

function findAgentStartedEvent(directory: string): Record<string, unknown> | undefined {
  return readJsonlEvents(directory)
    .filter((event) => event.type === "agent.started")
    .sort((left, right) => Date.parse(String(left.timestamp || "")) - Date.parse(String(right.timestamp || "")))
    .at(-1);
}
