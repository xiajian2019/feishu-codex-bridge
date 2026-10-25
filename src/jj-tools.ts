import { accessSync, constants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { getBunRuntime, type BunSubprocess } from "./bun-runtime.js";

export class JjToolError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

export type JjTerminalRuntime = ReturnType<typeof getBunRuntime>;

export interface JjRunSummary {
  id: string;
  command: string;
  state: "running" | "exited" | "stopped";
  exitCode: number | null;
  startedAt: string;
}

interface JjRun extends JjRunSummary {
  args: string[];
  output: string;
  offset: number;
  proc?: BunSubprocess;
  done?: Promise<void>;
}

const MAX_OUTPUT = 256 * 1024;
const MAX_RUNS = 16;

function field(input: Record<string, unknown>, key: string, required = false): string {
  const value = input[key];
  if (value !== undefined && typeof value !== "string") throw new JjToolError(`${key} 必须是文本。`);
  const text = (value as string | undefined)?.trim() ?? "";
  if ((required && !text) || text.length > 2_000 || /[\x00-\x1f\x7f]/.test(text) || text.startsWith("-")) {
    throw new JjToolError(`${key} 为空或格式无效。`);
  }
  return text;
}

export function buildJjArgs(input: Record<string, unknown>): string[] {
  const action = input.action;
  if (action === "names") return ["get", "names"];
  if (action === "jobs") {
    const name = field(input, "name");
    return ["get", "jobs", ...(name ? ["-n", name] : [])];
  }
  if (action === "run") {
    const job = field(input, "job", true);
    if (job.includes(",")) throw new JjToolError("每次请选择一个 Jenkins Job。");
    const name = field(input, "name");
    const args = ["run", job, ...(name ? ["-n", name] : []), "-v"];
    if (input.interactive === true) args.push("-i");
    if (input.parameters !== undefined && typeof input.parameters !== "string") throw new JjToolError("发布参数必须是文本。");
    const parameters = (input.parameters as string | undefined) ?? "";
    if (parameters.length > 8_000) throw new JjToolError("发布参数过长。");
    for (const line of parameters.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      if (!/^[A-Za-z_][\w.-]*=/.test(line) || /[\x00-\x1f\x7f]/.test(line)) throw new JjToolError("发布参数每行填写 KEY=value。");
      args.push("-a", line);
    }
    return args;
  }
  if (action === "builds") {
    if (field(input, "name")) throw new JjToolError("jj builds 使用 JJ 当前 Jenkins 配置，请清空配置名后查询。");
    const job = field(input, "job", true);
    if (job.includes(",")) throw new JjToolError("每次请选择一个 Jenkins Job。");
    const number = field(input, "buildNumber");
    if (number && !/^[1-9]\d{0,9}$/.test(number)) throw new JjToolError("构建号必须是正整数。");
    return ["builds", job, ...(number ? [number, "-v"] : [])];
  }
  if (action === "pods") {
    const app = field(input, "app");
    const namespace = field(input, "namespace") || "default";
    if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace) || namespace.length > 63) throw new JjToolError("命名空间格式无效。");
    const args = ["k8s", "pods", ...(app ? [app] : []), "-n", namespace];
    if (input.logs === true) args.push("-l", "--no-follow");
    else if (input.watch === true) args.push("-w");
    else args.push("-s");
    return args;
  }
  throw new JjToolError("不支持的 JJ 操作。");
}

function executableAt(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function findJj(): string | null {
  const configured = process.env.FEISHU_CODEX_JJ_PATH?.trim();
  if (configured) return executableAt(configured) ? configured : null;
  return [...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "jj")),
    "/opt/homebrew/bin/jj", "/usr/local/bin/jj"].find(executableAt) ?? null;
}

function dimension(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function summary(run: JjRun): JjRunSummary {
  const { id, command, state, exitCode, startedAt } = run;
  return { id, command, state, exitCode, startedAt };
}

export class JjToolsService {
  private readonly runs = new Map<string, JjRun>();
  private readonly executable: string | null;
  private readonly runtime?: JjTerminalRuntime;

  constructor(options: { executable?: string; runtime?: JjTerminalRuntime } = {}) {
    this.executable = options.executable ?? findJj();
    this.runtime = options.runtime;
  }

  list(): { executable: string | null; runs: JjRunSummary[] } {
    return { executable: this.executable, runs: [...this.runs.values()].reverse().map(summary) };
  }

  start(input: Record<string, unknown>): JjRunSummary {
    const args = buildJjArgs(input);
    const id = field(input, "requestId", true);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new JjToolError("requestId 格式无效。");
    const existing = this.runs.get(id);
    if (existing) {
      if (JSON.stringify(existing.args) !== JSON.stringify(args)) throw new JjToolError("此请求已用于其他命令。", 409);
      return summary(existing);
    }
    if (!this.executable) throw new JjToolError("未找到 JJ，请在 Mac 安装 JJ 或设置 FEISHU_CODEX_JJ_PATH。", 503);
    if ([...this.runs.values()].filter((run) => run.state === "running").length >= 4) throw new JjToolError("最多同时运行 4 条 JJ 命令，请先停止或等待已有命令。", 409);
    while (this.runs.size >= MAX_RUNS) {
      const oldest = [...this.runs.values()].find((run) => run.state !== "running");
      if (!oldest) break;
      this.runs.delete(oldest.id);
    }
    const command = [basename(this.executable), ...args].map((arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
    const run: JjRun = { id, args, command, state: "running", exitCode: null, startedAt: new Date().toISOString(), output: "", offset: 0 };
    const decoder = new StringDecoder("utf8");
    const append = (text: string): void => {
      run.output += text;
      if (run.output.length > MAX_OUTPUT) {
        const removed = run.output.length - MAX_OUTPUT;
        run.output = run.output.slice(removed);
        run.offset += removed;
      }
    };
    let outputEnded!: () => void;
    const eof = new Promise<void>((resolve) => { outputEnded = resolve; });
    try {
      const proc = (this.runtime ?? getBunRuntime()).spawn([this.executable, ...args], {
        env: { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG || "en_US.UTF-8" },
        terminal: {
          cols: dimension(input.cols, 100, 20, 240), rows: dimension(input.rows, 28, 5, 80), name: "xterm-256color",
          data: (_terminal, data) => append(decoder.write(Buffer.from(data))),
          exit: () => outputEnded(),
        },
      });
      run.proc = proc;
      run.done = proc.exited.then(async (code) => {
        // Drain the PTY before closing so short commands keep their final output.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([eof, new Promise<void>((resolve) => { timer = setTimeout(resolve, 200); })]);
        if (timer) clearTimeout(timer);
        append(decoder.end());
        run.exitCode = code;
        if (run.state === "running") run.state = "exited";
      }).catch((error: unknown) => {
        append(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`);
        run.state = "exited";
        run.exitCode = 1;
      }).finally(() => proc.terminal?.close());
      this.runs.set(id, run);
      return summary(run);
    } catch (error) {
      throw new JjToolError(`无法启动 JJ：${error instanceof Error ? error.message : String(error)}`, 503);
    }
  }

  read(id: string, offset = 0): JjRunSummary & { output: string; offset: number; truncated: boolean } {
    const run = this.get(id);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new JjToolError("输出位置无效。");
    return { ...summary(run), output: run.output.slice(Math.max(0, offset - run.offset)),
      offset: run.offset + run.output.length, truncated: offset < run.offset };
  }

  input(id: string, input: Record<string, unknown>): void {
    const run = this.get(id);
    if (run.state !== "running" || !run.proc?.terminal) throw new JjToolError("此 JJ 命令已结束。", 409);
    if (typeof input.data !== "string" || !input.data || Buffer.byteLength(input.data) > 16 * 1024) throw new JjToolError("终端输入为空或过长。");
    run.proc.terminal.write(input.data);
  }

  resize(id: string, input: Record<string, unknown>): void {
    const run = this.get(id);
    if (run.state === "running") run.proc?.terminal?.resize(dimension(input.cols, 100, 20, 240), dimension(input.rows, 28, 5, 80));
  }

  stop(id: string): void {
    const run = this.get(id);
    if (run.state !== "running" || !run.proc) return;
    // A Bun PTY child owns a process group. Include its kubectl/log followers.
    try {
      if (run.proc.pid) process.kill(-run.proc.pid, "SIGKILL");
      else run.proc.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    run.state = "stopped";
  }

  async dispose(): Promise<void> {
    for (const run of this.runs.values()) if (run.state === "running") this.stop(run.id);
    await Promise.all([...this.runs.values()].map((run) => run.done));
    this.runs.clear();
  }

  private get(id: string): JjRun {
    const run = this.runs.get(id);
    if (!run) throw new JjToolError("JJ 记录不存在或服务已重启。", 404);
    return run;
  }
}
