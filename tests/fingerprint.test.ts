import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computeInputHash, parseTaskInput, serializeTaskInput } from "../src/fingerprint.js";
import type { TaskInput } from "../src/types.js";

describe("computeInputHash", () => {
  const input: TaskInput = {
    projectKey: "food",
    mode: "implement",
    summary: "修复时区",
    description: "增加回归测试",
  };

  it("uses the documented NUL-delimited tuple", () => {
    const expected = createHash("sha256")
      .update("food\0implement\0修复时区\0增加回归测试", "utf8")
      .digest("hex");
    expect(computeInputHash(input)).toBe(expected);
  });

  it("changes when mode or task text changes", () => {
    expect(computeInputHash({ ...input, mode: "review" })).not.toBe(computeInputHash(input));
    expect(computeInputHash({ ...input, description: "增加更多回归测试" })).not.toBe(
      computeInputHash(input),
    );
  });

  it("round-trips the persisted input form", () => {
    expect(parseTaskInput(serializeTaskInput(input))).toEqual(input);
    expect(parseTaskInput("not-json")).toBeNull();
  });
});
