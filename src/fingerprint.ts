import { createHash } from "node:crypto";

import type { TaskInput } from "./types.js";

/**
 * The fingerprint intentionally excludes comments and all other task metadata.
 * It mirrors the design document's project/mode/title/description tuple.
 */
export function computeInputHash(input: TaskInput): string {
  return createHash("sha256")
    .update(
      [input.projectKey, input.mode, input.summary, input.description].join("\0"),
      "utf8",
    )
    .digest("hex");
}

export function serializeTaskInput(input: TaskInput): string {
  return JSON.stringify(input);
}

export function parseTaskInput(value: string | null | undefined): TaskInput | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<TaskInput>;
    if (
      typeof parsed.projectKey !== "string" ||
      typeof parsed.mode !== "string" ||
      typeof parsed.summary !== "string" ||
      typeof parsed.description !== "string"
    ) {
      return null;
    }
    return parsed as TaskInput;
  } catch {
    return null;
  }
}
