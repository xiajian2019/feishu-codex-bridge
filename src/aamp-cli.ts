import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectAampTasks,
  findAampTask,
  formatAampRecent,
  formatAampTask,
} from "./aamp-inspect.js";
import { AampTaskAgentRuntime } from "./aamp-task-agent.js";
import { loadConfig } from "./config.js";

interface AampCliArguments {
  configPath: string;
  command: string[];
  help: boolean;
}

export function parseAampCliArguments(
  argv: string[],
  cwd = process.cwd(),
): AampCliArguments {
  let configPath = resolve(cwd, "config.json");
  const command: string[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--config requires a path");
      configPath = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    command.push(arg);
  }
  return { configPath, command, help };
}

export async function runAampCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseAampCliArguments(argv);
  if (args.help || args.command.length === 0) {
    printUsage();
    return;
  }
  const config = loadConfig(args.configPath);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (await runAampInspectionCommand(args.command, config, projectRoot)) return;
  const runtime = new AampTaskAgentRuntime(config, { projectRoot });
  await runtime.run(args.command);
}

function printUsage(): void {
  console.log(
    [
      "Usage: pnpm run aamp -- <install|start|stop|restart|status|logs|list|add|remove|update>",
      "       pnpm run aamp:restart [-- --hot|--cold]",
      "       pnpm run aamp:recent -- [--limit N] [--full-message] [--json]",
      "       pnpm run aamp:task -- <task-id-or-prefix> [--json]",
      "       pnpm run aamp:inspect -- <task-id-or-prefix> [--json]",
      "       pnpm run aamp:worktrees [--json]",
      "  --config path  bridge config JSON (default: ./config.json)",
      "",
      "The command is forwarded to the installed official @larktask/aamp-feishu-task-agent package.",
      "Run `pnpm run aamp:install` once to create the official AAMP binding.",
    ].join("\n"),
  );
}

async function runAampInspectionCommand(
  command: string[],
  config: Awaited<ReturnType<typeof loadConfig>>,
  projectRoot: string,
): Promise<boolean> {
  const name = command[0];
  if (!["recent", "task", "inspect", "worktrees"].includes(name)) return false;
  const inspection = createAampInspection(config, projectRoot);
  const json = command.includes("--json");
  const fullMessage = command.includes("--full-message");
  if (name === "recent") {
    const limit = parseLimit(command);
    const snapshot = collectAampTasks(inspection);
    console.log(json ? JSON.stringify(snapshot, null, 2) : formatAampRecent(snapshot, limit, { fullMessage }));
    return true;
  }
  if (name === "worktrees") {
    const snapshot = collectAampTasks(inspection);
    const worktrees = snapshot.tasks.filter((task) => task.worktreePath);
    console.log(json ? JSON.stringify(worktrees, null, 2) : formatAampRecent({ ...snapshot, tasks: worktrees }, worktrees.length, { fullMessage }));
    return true;
  }
  const selector = command.find((value, index) => index > 0 && !value.startsWith("--"));
  if (!selector) throw new Error(`${name} requires a task id or prefix`);
  const task = findAampTask(collectAampTasks(inspection), selector);
  console.log(json ? JSON.stringify(task, null, 2) : formatAampTask(task));
  return true;
}

function createAampInspection(
  config: Awaited<ReturnType<typeof loadConfig>>,
  projectRoot: string,
) {
  return {
    metadataDir: join(projectRoot, "runtime", "aamp", "worktree-tasks"),
    taskDir: config.aamp.worktree?.taskDir || join(projectRoot, "codex", "tasks"),
    logDir: process.env.AAMP_LOG_DIR,
    stateHome: process.env.AAMP_TASK_STATE_HOME,
  };
}

function parseLimit(command: string[]): number {
  const index = command.findIndex((value) => value === "--limit" || value.startsWith("--limit="));
  if (index < 0) return 5;
  const argument = command[index];
  const value = Number(argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : command[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("--limit must be an integer between 1 and 100");
  }
  return value;
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  runAampCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
