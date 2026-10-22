import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fallbackTaskFeatureName, parseTaskFeatureName, summarizeTaskFeatureName } from "../src/task-feature-name.js";

describe("Task feature names", () => {
  it("extracts a concise kebab-case name from Codex output", () => {
    expect(parseTaskFeatureName("feature name: prevent duplicate submissions")).toBe("prevent-duplicate-submissions");
    expect(parseTaskFeatureName("```text\nextract-weight-from-serving-size\n```\n")).toBe("extract-weight-from-serving-size");
  });

  it("limits fallback names and drops opaque identifiers", () => {
    expect(fallbackTaskFeatureName("Feishu task from ou_411e315ef3c8996291b76c41ef44b276 with retry handling")).toBe("feishu-task-from-ou-with");
  });

  it("invokes the configured Codex CLI with the requested model and effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-task-feature-name-"));
    try {
      const argsPath = join(root, "args.txt");
      const executable = join(root, "codex");
      writeFileSync(executable, [
        "#!/bin/sh",
        "output=",
        "previous=",
        "for arg in \"$@\"; do",
        "  if [ \"$previous\" = \"--output-last-message\" ]; then output=\"$arg\"; fi",
        "  previous=\"$arg\"",
        "done",
        "printf '%s\\n' \"$@\" > \"$TASK_FEATURE_ARGS\"",
        "printf '%s\\n' 'prevent-duplicate-submissions' > \"$output\"",
      ].join("\n") + "\n");
      chmodSync(executable, 0o700);

      const name = await summarizeTaskFeatureName({
        codexPath: executable,
        summary: "Prevent duplicate submissions",
        description: "Ensure repeated requests share one task.",
        env: { TASK_FEATURE_ARGS: argsPath },
      });

      const args = readFileSync(argsPath, "utf8");
      expect(name).toBe("prevent-duplicate-submissions");
      expect(args).toContain("--model\ngpt-5.6-luna\n");
      expect(args).toContain("--config\nmodel_reasoning_effort=\"low\"\n");
      expect(args).toContain("--sandbox\nread-only\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
