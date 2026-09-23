import {
  findModeByOptionGuid,
  findProjectByOptionGuid,
} from "./config.js";
import { computeInputHash, serializeTaskInput } from "./fingerprint.js";
import type {
  BridgeConfig,
  ConfigProblem,
  LarkCustomField,
  LarkTask,
  RoutedTask,
} from "./types.js";

export type RouteResult =
  | { ok: true; task: RoutedTask }
  | { ok: false; problem: ConfigProblem };

export function routeTask(task: LarkTask, config: BridgeConfig): RouteResult {
  if (!task.guid) {
    return problem("TASK_INVALID", "飞书任务缺少 guid，无法安全处理。");
  }

  const belongsToTasklist = (Array.isArray(task.tasklists) ? task.tasklists : []).some(
    (membership) =>
      membership !== null &&
      typeof membership === "object" &&
      membership.tasklist_guid === config.lark.tasklistGuid,
  );
  if (!belongsToTasklist) {
    return problem(
      "NOT_IN_TASKLIST",
      "任务不属于配置的 Codex 工作台清单，已拒绝执行。",
    );
  }

  const allowedCreators = config.lark.allowedCreatorOpenIds;
  if (allowedCreators && allowedCreators.length > 0) {
    const creatorId = task.creator?.id;
    if (!creatorId || !allowedCreators.includes(creatorId)) {
      return problem(
        "CREATOR_NOT_ALLOWED",
        "任务创建人不在配置允许的 open_id 白名单中，已拒绝执行。",
      );
    }
  }

  const projectOption = readSingleSelect(
    task.custom_fields,
    config.lark.projectFieldGuid,
    "项目",
  );
  if (!projectOption.ok) {
    return projectOption;
  }
  const project = findProjectByOptionGuid(config, projectOption.optionGuid);
  if (!project) {
    return problem(
      "PROJECT_UNKNOWN",
      `项目字段选项 ${projectOption.optionGuid} 未在本地白名单中配置，已拒绝执行。`,
    );
  }

  const modeOption = readSingleSelect(
    task.custom_fields,
    config.lark.modeFieldGuid,
    "模式",
  );
  if (!modeOption.ok) {
    return modeOption;
  }
  const mode = findModeByOptionGuid(config, modeOption.optionGuid);
  if (!mode) {
    return problem(
      "MODE_UNKNOWN",
      `模式字段选项 ${modeOption.optionGuid} 未在配置中登记，已拒绝执行。`,
    );
  }

  const summary = typeof task.summary === "string" ? task.summary : "";
  const description = typeof task.description === "string" ? task.description : "";
  if (summary.trim().length === 0) {
    return problem("TASK_INVALID", "飞书任务标题为空，已拒绝启动 Codex。");
  }
  const input = {
    projectKey: project.key,
    mode: mode.key,
    summary,
    description,
  };

  return {
    ok: true,
    task: {
      taskGuid: task.guid,
      summary,
      description,
      projectKey: project.key,
      mode: mode.key,
      repo: project.value.repo,
      sandboxMode: mode.value.sandboxMode,
      inputHash: computeInputHash(input),
      input,
      completed: isLarkTaskCompleted(task),
      origin: "feishu",
      url: typeof task.url === "string" ? task.url : undefined,
    },
  };
}

export function isLarkTaskCompleted(task: Pick<LarkTask, "status" | "completed_at">): boolean {
  if (task.status === "done" || task.status === "completed") {
    return true;
  }
  return Boolean(task.completed_at && task.completed_at !== "0");
}

function readSingleSelect(
  fields: LarkCustomField[] | undefined,
  fieldGuid: string,
  label: string,
): { ok: true; optionGuid: string } | { ok: false; problem: ConfigProblem } {
  const matches = (Array.isArray(fields) ? fields : []).filter(
    (field): field is LarkCustomField =>
      typeof field === "object" && field !== null && field.guid === fieldGuid,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      problem: {
        code: label === "项目" ? "PROJECT_MISSING" : "MODE_MISSING",
        message: `任务未选择${label}单选字段，已拒绝启动 Codex。`,
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      problem: {
        code: "TASK_INVALID",
        message: `任务的${label}字段出现重复值，已拒绝启动 Codex。`,
      },
    };
  }
  const optionGuid = matches[0].single_select_value;
  if (typeof optionGuid !== "string" || optionGuid.length === 0) {
    return {
      ok: false,
      problem: {
        code: label === "项目" ? "PROJECT_MISSING" : "MODE_MISSING",
        message: `任务未选择有效的${label}单选项，已拒绝启动 Codex。`,
      },
    };
  }
  return { ok: true, optionGuid };
}

function problem(
  code: ConfigProblem["code"],
  message: string,
): { ok: false; problem: ConfigProblem } {
  return { ok: false, problem: { code, message } };
}

// Kept as a named helper so worker-facing code can inspect the exact persisted form.
export function inputTextForTask(task: RoutedTask): string {
  return serializeTaskInput(task.input);
}
