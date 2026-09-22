import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  AampRestartTrace,
  collectAampRestartPhases,
  formatAampRestartTable,
} from "../src/aamp-restart.js";
import {
  composeAampRestartPhases,
  parseAampRestartArguments,
} from "../src/aamp-task-agent.js";

describe("AAMP restart diagnostics", () => {
  it("parses hot/cold flags without forwarding adapter-only arguments", () => {
    expect(parseAampRestartArguments(["restart"])).toEqual({
      mode: "hot",
      forwardedArgs: ["restart"],
    });
    expect(parseAampRestartArguments(["restart", "--cold"])).toEqual({
      mode: "cold",
      forwardedArgs: ["restart"],
    });
    expect(parseAampRestartArguments(["restart", "--hot", "--official-flag"])).toEqual({
      mode: "hot",
      forwardedArgs: ["restart", "--official-flag"],
    });
    expect(() => parseAampRestartArguments(["restart", "--hot", "--cold"])).toThrow(
      "cannot combine --hot and --cold",
    );
  });

  it("collects official bootstrap and bridge stages into the restart table", () => {
    const root = mkdtempSync(join(tmpdir(), "aamp-restart-"));
    try {
      const runDir = join(root, "runs", "20260910T103629-95894");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "manifest.json"), JSON.stringify({
        command: "__service-run",
        started_at: "2026-09-10T02:36:36.456Z",
        bindings: [{ status: "running", updated_at: "2026-09-10T02:37:15.799Z" }],
      }));
      writeFileSync(join(runDir, "one-click.log"), [
        "2026-09-10T10:36:29+0800 [aamp-one-click] logs directory: run",
        "2026-09-10T10:36:35+0800 [aamp-one-click] 当前版本：0.1.1-dev.7",
        "2026-09-10T10:36:41+0800 [aamp-one-click] using npm registry: https://registry.npmjs.org/",
      ].join("\n"));
      writeFileSync(join(runDir, "bridge.jsonl"), [
        JSON.stringify({
          type: "bridge.stage",
          stage: "acp-init",
          status: "starting",
          timestamp: "2026-09-10T02:36:51.448Z",
        }),
        JSON.stringify({
          type: "bridge.stage",
          stage: "acp-init",
          status: "succeeded",
          timestamp: "2026-09-10T02:37:03.567Z",
          durationMs: 12119,
        }),
        JSON.stringify({
          type: "bridge.stage",
          stage: "acp-start",
          status: "succeeded",
          timestamp: "2026-09-10T02:37:09.543Z",
          durationMs: 5962,
        }),
        JSON.stringify({
          type: "agent.started",
          timestamp: "2026-09-10T02:37:09.542Z",
          durationMs: 5101,
        }),
        JSON.stringify({
          type: "bridge.stage",
          stage: "feishu-start",
          status: "succeeded",
          timestamp: "2026-09-10T02:37:15.792Z",
          durationMs: 12140,
        }),
      ].join("\n"));

      const result = collectAampRestartPhases({
        logRoot: root,
        startedAtMs: Date.parse("2026-09-10T02:36:00.000Z"),
        finishedAtMs: Date.parse("2026-09-10T02:37:16.000Z"),
      });

      expect(result.runDir).toBe(runDir);
      expect(result.phases.map((phase) => phase.name)).toEqual([
        "重启开始到最终服务启动",
        "外层 bootstrap 初始化",
        "__prepare-agent 再次执行 bootstrap",
        "ACP 初始化",
        "Codex ACP 启动",
        "Feishu Bridge 启动",
        "服务 ready",
        "总耗时",
      ]);
      expect(result.phases.find((phase) => phase.name === "ACP 初始化")?.durationMs).toBe(12119);
      expect(result.phases.find((phase) => phase.name === "Codex ACP 启动")?.durationMs).toBe(5101);
      expect(result.phases.find((phase) => phase.name === "服务 ready")?.durationMs).toBe(46799);
      expect(formatAampRestartTable(result.phases).join("\n")).toContain("总耗时");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records adapter phases without making diagnostics failure-fatal", () => {
    let clock = 1_000;
    const output: string[] = [];
    const trace = new AampRestartTrace({
      now: () => clock,
      output: (line) => output.push(line),
    });
    const token = trace.begin("快速重启（保留 launchd 服务）");
    clock += 1250;
    trace.end(token, "completed");

    expect(trace.phases).toEqual([{
      name: "快速重启（保留 launchd 服务）",
      durationMs: 1250,
      status: "completed",
    }]);
    expect(output.some((line) => line.includes("阶段开始"))).toBe(true);
    expect(output.some((line) => line.includes("阶段结束"))).toBe(true);
  });

  it("keeps a completed cold fallback visible in the combined summary", () => {
    const phases = composeAampRestartPhases(
      [
        { name: "准备本地适配环境", durationMs: 4, status: "completed" },
        { name: "快速重启（保留 launchd 服务）", durationMs: 95_334, status: "unavailable" },
        { name: "官方 AAMP 冷重启", durationMs: 96_382, status: "completed" },
        { name: "检查 launchd 兼容路径", durationMs: 2, status: "completed" },
      ],
      [
        { name: "服务 ready", durationMs: 89_196, status: "completed" },
        { name: "总耗时", durationMs: 191_724, status: "completed" },
      ],
    );

    expect(phases.map((phase) => phase.name)).toEqual([
      "准备本地适配环境",
      "快速重启（保留 launchd 服务）",
      "官方 AAMP 冷重启",
      "检查 launchd 兼容路径",
      "服务 ready",
      "总耗时",
    ]);
  });
});
