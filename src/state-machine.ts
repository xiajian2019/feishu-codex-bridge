import type { TaskState } from "./types.js";

export type TaskAction =
  | "queue"
  | "ignore"
  | "accept"
  | "cancel"
  | "block-config";

export interface StateDecisionInput {
  state: TaskState | null;
  completed: boolean;
  validConfig: boolean;
  projectChanged: boolean;
  inputChanged: boolean;
}

/** Pure state/action rules used by the dispatcher and unit tests. */
export function decideTaskAction(input: StateDecisionInput): TaskAction {
  if (input.projectChanged) {
    return "block-config";
  }

  if (input.completed) {
    if (input.state === "RUNNING" || input.state === "QUEUED") {
      return "cancel";
    }
    if (input.state === "WAITING_REVIEW") {
      return "accept";
    }
    return "ignore";
  }

  if (!input.validConfig) {
    return "block-config";
  }

  if (input.state === "RUNNING") {
    return "ignore";
  }

  if (input.state === "QUEUED") {
    return input.inputChanged ? "queue" : "ignore";
  }

  if (
    input.state === null ||
    input.state === "DISCOVERED" ||
    input.state === "BLOCKED_CONFIG" ||
    input.state === "WAITING_REVIEW" ||
    input.state === "FAILED" ||
    input.state === "ACCEPTED" ||
    input.state === "CANCELED"
  ) {
    return input.inputChanged || input.state === null || input.state === "BLOCKED_CONFIG"
      ? "queue"
      : "ignore";
  }

  return "ignore";
}

export function isTerminalState(state: TaskState): boolean {
  return state === "ACCEPTED" || state === "CANCELED";
}
