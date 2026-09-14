export const AAMP_COMMAND_ACTION_KIND: "aamp_command";
export const AAMP_TASK_CANCEL_ACTION_KIND: "task_cancel";
export const AAMP_TASK_HIDE_ACTION_KIND: "aamp_task_hide";
export const GLOBAL_TASK_MODES: Readonly<{ AAMP: "aamp"; DIRECT: "direct" }>;

export interface GlobalCommand {
  command: "help" | "cancel" | "status" | "usage" | "recent" | "tasks"
    | "thread" | "resume" | "retry" | "queue" | "progress" | "events"
    | "changes" | "commands" | "tools";
  args: string[];
  raw?: string;
}

export interface GlobalCardRuntime {
  globalTaskMode: "aamp" | "direct";
  state?: Record<string, unknown>;
  config?: Record<string, unknown>;
  channel?: Record<string, unknown>;
  logger?: Record<string, unknown>;
  listGlobalTasks?: (chatId: string) => unknown[];
  getGlobalHiddenTaskIds?: (chatId: string) => string[];
  hideGlobalTask?: (taskId: string, chatId: string) => boolean;
}

export function parseAampCommand(content: unknown): GlobalCommand | undefined;
export function buildCommandCard(
  runtime: GlobalCardRuntime,
  chatId: string,
  command: GlobalCommand,
): object;
export function buildDirectInfoCard(runtime: GlobalCardRuntime, title: string, lines: string[]): object;
export function compactGlobalCard(card: object, maxElements?: number): object;
export function buildRecentCard(
  runtime: GlobalCardRuntime,
  chatId: string,
  limit?: number,
): object;
export function readCommandActionValue(event: unknown): Record<string, unknown> | undefined;
export function readAampCanonicalTaskStates(options?: {
  stateHome?: string;
  logDir?: string;
}): Record<string, Record<string, unknown>>;
