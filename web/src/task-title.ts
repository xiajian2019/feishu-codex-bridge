export function directTaskTitle(text: string, limit = 160): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part
    && !/^(?:项目|project|执行模式|模式|mode)\s*[:：=]/iu.test(part));
  return line?.slice(0, limit) || "附件任务";
}
