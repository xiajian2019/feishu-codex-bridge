import type { TaskInput } from "./types.js";

export function buildInitialPrompt(input: TaskInput): string {
  return [
    "飞书任务标题：",
    input.summary,
    "",
    `目标项目：${input.projectKey}`,
    "",
    "飞书任务描述：",
    input.description || "（无描述）",
    "",
    "工作目录已经设置为指定仓库。",
    "",
    "要求：",
    `- 仅在映射到 ${input.projectKey} 的当前仓库工作`,
    "- 保留用户已有的无关修改",
    "- 使用配置指定的 sandbox",
    "- 完成最小且合适的修改",
    "- 运行针对性验证",
    "- 不要自动 commit、push 或 merge",
    "- 最后给出修改文件和实际运行检查的简洁摘要",
  ].join("\n");
}

export function buildFeedbackPrompt(
  previous: TaskInput | null,
  current: TaskInput,
): string {
  if (
    previous &&
    previous.projectKey === current.projectKey &&
    previous.mode === current.mode &&
    previous.summary === current.summary &&
    current.description.startsWith(previous.description) &&
    current.description.length > previous.description.length
  ) {
    const appended = current.description.slice(previous.description.length);
    return [
      "用户通过飞书任务追加了反馈：",
      appended,
      "",
      "请基于当前 thread 继续处理，完成后重新总结结果。",
    ].join("\n");
  }

  return [
    "用户通过飞书任务更新了需求。以下是更新后的完整内容：",
    "",
    `任务标题：${current.summary}`,
    `目标项目：${current.projectKey}`,
    `模式：${current.mode}`,
    "",
    "任务描述：",
    current.description || "（无描述）",
    "",
    "请基于当前 thread 继续处理，完成后重新总结结果。",
  ].join("\n");
}

export function buildRunPrompt(
  current: TaskInput,
  previous: TaskInput | null,
  hasThread: boolean,
): string {
  return hasThread ? buildFeedbackPrompt(previous, current) : buildInitialPrompt(current);
}

export function truncateForComment(value: string, maxCharacters = 3500): string {
  const normalized = value.trim();
  if (normalized.length <= maxCharacters) {
    return normalized;
  }
  return `${normalized.slice(0, maxCharacters - 1)}…`;
}

export function formatStartedComment(
  runId: string,
  projectKey: string,
  sandboxMode: string,
): string {
  return [
    "[Codex] 已开始执行",
    "",
    `运行编号：${runId}`,
    `项目：${projectKey}`,
    `模式：${sandboxMode}`,
  ].join("\n");
}

export function formatCompletedComment(args: {
  runId?: string;
  projectKey: string;
  finalResponse: string;
  threadId: string | null;
  duration: string;
}): string {
  return [
    "[Codex] 执行完成，等待验收",
    "",
    "结果：",
    truncateForComment(args.finalResponse || "Codex 未返回文本摘要。"),
    "",
    ...(args.runId ? [`运行编号：${args.runId}`, ""] : []),
    `线程：${args.threadId ?? "未取得"}`,
    `耗时：${args.duration}`,
    "",
    "完成此飞书任务表示接受结果；",
    "如需修改，请编辑任务描述并追加反馈。",
  ].join("\n");
}

export function formatFailedComment(error: string, proxyFailure = false): string {
  const prefix = proxyFailure
    ? "代理 127.0.0.1:7897 不可用，本轮没有完成。"
    : "Codex 本轮执行失败。";
  return [
    "[Codex] 执行失败",
    "",
    prefix,
    `错误：${truncateForComment(error, 1800)}`,
    "",
    "修正问题后，请编辑任务描述或追加“重试：1”再重新执行。",
  ].join("\n");
}

export function formatBlockedComment(message: string): string {
  return [
    "[Codex] 配置错误，未启动执行",
    "",
    message,
    "",
    "请修正任务的项目、模式或清单归属后再继续。",
  ].join("\n");
}

export function formatCanceledComment(reason: string, runId?: string): string {
  return [
    "[Codex] 执行已取消",
    "",
    ...(runId ? [`运行编号：${runId}`, ""] : []),
    reason,
  ].join("\n");
}

export function formatDuration(startedAt: string, finishedAt = new Date().toISOString()): string {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
  );
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分 ${remainder} 秒`;
  }
  return `${minutes} 分 ${remainder} 秒`;
}
