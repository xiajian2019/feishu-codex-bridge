import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLarkCliPath } from "../src/direct-feishu-setup.js";

describe("standalone direct Feishu setup", () => {
  it("resolves the bundled lark-cli without AAMP state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-lark-cli-"));
    const executable = join(directory, "lark-cli");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    expect(resolveLarkCliPath({
      lark: {
        profile: "direct",
        tasklistGuid: "tasklist",
        projectFieldGuid: "project",
        modeFieldGuid: "mode",
      },
    }, { PATH: directory })).toBe(executable);
  });
});
