import { describe, expect, it } from "bun:test";

import { decideTaskAction, isTerminalState } from "../src/state-machine.js";

describe("task state machine", () => {
  it("cancels a running task completed in Feishu", () => {
    expect(
      decideTaskAction({
        state: "RUNNING",
        completed: true,
        validConfig: true,
        projectChanged: false,
        inputChanged: false,
      }),
    ).toBe("cancel");
  });

  it("accepts a completed result after review", () => {
    expect(
      decideTaskAction({
        state: "WAITING_REVIEW",
        completed: true,
        validConfig: true,
        projectChanged: false,
        inputChanged: false,
      }),
    ).toBe("accept");
  });

  it("queues changed feedback and ignores unchanged feedback", () => {
    const base = {
      state: "WAITING_REVIEW" as const,
      completed: false,
      validConfig: true,
      projectChanged: false,
    };
    expect(decideTaskAction({ ...base, inputChanged: true })).toBe("queue");
    expect(decideTaskAction({ ...base, inputChanged: false })).toBe("ignore");
  });

  it("blocks a project switch even when the new task fields are otherwise valid", () => {
    expect(
      decideTaskAction({
        state: "WAITING_REVIEW",
        completed: false,
        validConfig: true,
        projectChanged: true,
        inputChanged: true,
      }),
    ).toBe("block-config");
  });

  it("only treats accepted and canceled as terminal", () => {
    expect(isTerminalState("ACCEPTED")).toBe(true);
    expect(isTerminalState("CANCELED")).toBe(true);
    expect(isTerminalState("FAILED")).toBe(false);
  });
});
