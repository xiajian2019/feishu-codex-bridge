import type VConsole from "vconsole";

type ExportPlugin = InstanceType<typeof VConsole.VConsolePlugin>;
type DebugWindow = Window & {
  VConsole?: typeof VConsole;
  VConsoleOutputLogsPlugin?: new (vConsole: VConsole) => ExportPlugin;
  __tmuxDebugLog?: string[];
  __tmuxKeyboardLog?: string[];
  __tmuxDebugLogPaused?: boolean;
  __tmuxKeyboardPaused?: boolean;
};

const installed = new WeakSet<VConsole>();

export async function installKeyboardLogExport(vConsole: VConsole, constructor: typeof VConsole): Promise<void> {
  if (installed.has(vConsole)) return;
  const debugWindow = window as DebugWindow;
  // The upstream bundle registers its constructor on window and requires VConsole there.
  debugWindow.VConsole = constructor;
  await import("vconsole-outputlog-plugin");
  const OutputPlugin = debugWindow.VConsoleOutputLogsPlugin;
  if (!OutputPlugin) throw new Error("The vConsole log export plugin did not load.");
  // Keep the package's original exporter for the vConsole Console log panel.
  new OutputPlugin(vConsole);

  const message = (text: string): void => {
    const status = document.getElementById("tmux-debug-log-export-status");
    if (status) status.textContent = text;
  };
  const getLogs = (): string => {
    debugWindow.__tmuxDebugLogPaused = true;
    debugWindow.__tmuxKeyboardPaused = true;
    const logs = (debugWindow.__tmuxDebugLog ?? debugWindow.__tmuxKeyboardLog ?? []).join("\n");
    if (!logs) message("暂无记录：点击输入框下方的日志按钮开始收集，再复现问题。");
    return logs;
  };
  const exportLogs = (): void => {
    const logs = getLogs();
    if (!logs) return;
    const url = URL.createObjectURL(new Blob([logs], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "tmux-debug-" + new Date().toISOString().replace(/[:.]/g, "-") + ".log";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    message("已发起日志下载，采集已暂停。");
  };
  const copyLogs = (): void => {
    const logs = getLogs();
    if (!logs) return;
    // HTTP LAN pages do not have navigator.clipboard; run synchronously in the tap gesture.
    const field = document.getElementById("tmux-log-export-text") as HTMLTextAreaElement | null;
    if (!field) return;
    field.hidden = false;
    field.value = logs;
    field.focus();
    field.select();
    field.setSelectionRange(0, logs.length);
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { /* Leave selected text as fallback. */ }
    if (copied) {
      field.blur();
      field.hidden = true;
      message("已复制全部调试日志，采集已暂停。");
    } else {
      message("自动复制未成功，请长按下方文本全选复制，或使用导出日志。");
    }
  };
  const plugin = new constructor.VConsolePlugin("tmuxDebugLog", "调试日志");
  plugin.on("ready", () => {});
  plugin.on("renderTab", (callback) => callback(`<div style="padding:16px">
        <p id="tmux-debug-log-export-status">点击输入框下方的日志按钮开始记录，复现后再次点击完成。</p>
        <p>完成后日志会自动加入输入框，发送消息时上传给 Codex。打开 vConsole 会暂停继续记录。</p>
        <textarea id="tmux-log-export-text" readonly hidden style="width:100%;height:160px;font-size:16px" aria-label="调试日志导出文本"></textarea>
      </div>`));
  plugin.on("showConsole", () => {
    debugWindow.__tmuxDebugLogPaused = true;
    debugWindow.__tmuxKeyboardPaused = true;
  });
  plugin.on("hideConsole", () => {
    debugWindow.__tmuxDebugLogPaused = false;
    debugWindow.__tmuxKeyboardPaused = false;
  });
  plugin.on("show", () => {
    message(`已保存 ${(debugWindow.__tmuxDebugLog ?? debugWindow.__tmuxKeyboardLog)?.length ?? 0} 条调试日志，采集已暂停。`);
  });
  plugin.on("addTool", (callback) => callback([
    { name: "复制日志", onClick: copyLogs },
    { name: "导出日志", onClick: exportLogs },
  ]));
  vConsole.addPlugin(plugin);
  installed.add(vConsole);
}
