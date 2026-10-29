export type TerminalSubmissionResult = { ok: boolean; message?: string };

export function failPendingTmuxSubmissionsOnDisconnect(
  waiters: Map<string, (result: TerminalSubmissionResult) => void>,
): void {
  for (const resolve of waiters.values()) {
    resolve({ ok: false, message: "终端连接已断开，消息可能已经送达；请先检查 Session，再决定是否重发。" });
  }
  waiters.clear();
}
