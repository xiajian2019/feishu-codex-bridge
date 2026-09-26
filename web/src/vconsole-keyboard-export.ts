import type VConsole from "vconsole";

type ExportPlugin = InstanceType<typeof VConsole.VConsolePlugin>;
type DebugWindow = Window & {
  VConsole?: typeof VConsole;
  VConsoleOutputLogsPlugin?: new (vConsole: VConsole) => ExportPlugin;
  __tmuxKeyboardLog?: string[];
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
    const status = document.getElementById("tmux-log-export-status");
    if (status) status.textContent = text;
  };
  const getLogs = (): string => {
    debugWindow.__tmuxKeyboardPaused = true;
    const logs = (debugWindow.__tmuxKeyboardLog ?? []).join("\n");
    if (!logs) message("暂无记录：进入 session，点击输入框并复现后，再打开此面板。");
    return logs;
  };
  const exportLogs = (): void => {
    const logs = getLogs();
    if (!logs) return;
    const url = URL.createObjectURL(new Blob([logs], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "tmux-keyboard-" + new Date().toISOString().replace(/[:.]/g, "-") + ".log";
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
      message("已复制全部键盘日志，采集已暂停。");
    } else {
      message("自动复制未成功，请长按下方文本全选复制，或使用导出日志。");
    }
  };
  const plugin = new constructor.VConsolePlugin("tmuxKeyboardLog", "键盘日志");
  plugin.on("ready", () => {});
  plugin.on("renderTab", (callback) => callback(`<div style="padding:16px">
        <p id="tmux-log-export-status">进入 session 后点击输入框开始记录，复现后在此复制或导出。</p>
        <p>打开 vConsole 自动暂停；关闭面板后，再点击消息输入框继续。同一 session 保留最近 300 条，新 session 首次点击重新记录。</p>
        <textarea id="tmux-log-export-text" readonly hidden style="width:100%;height:160px;font-size:16px" aria-label="键盘日志导出文本"></textarea>
      </div>`));
  plugin.on("showConsole", () => { debugWindow.__tmuxKeyboardPaused = true; });
  plugin.on("show", () => {
    message(`已保存 ${debugWindow.__tmuxKeyboardLog?.length ?? 0} 条键盘日志，采集已暂停。`);
  });
  plugin.on("addTool", (callback) => callback([
    { name: "复制日志", onClick: copyLogs },
    { name: "导出日志", onClick: exportLogs },
  ]));
  vConsole.addPlugin(plugin);
  installed.add(vConsole);
}
