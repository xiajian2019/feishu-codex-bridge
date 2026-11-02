import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { MobileConnectionContent, MobileEnvironmentDialog } from "../web/src/MobileConnectionGate.js";
import {
  listNativeSshOptions as listBrowserSshOptions,
  onNativeSshReturnToWorkbench as onBrowserSshReturnToWorkbench,
} from "../web/src/ssh-connectbot-native.browser.js";

function renderConnectionCenter(path: string): string {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(MobileConnectionContent, null, "已配对的 Bridge 内容")));
}

describe("mobile connection center", () => {
  it("keeps both modes available while Bridge is still loading", () => {
    const html = renderConnectionCenter("/");
    expect(html).toContain("选择连接方式");
    expect(html).toContain("SSH / Mac");
    expect(html).toContain("正在恢复连接");
    expect(html).not.toContain('aria-label="SSH 登录"');
  });

  it("opens the SSH login on the legacy route without waiting for Bridge", () => {
    const html = renderConnectionCenter("/ssh");
    expect(html).toContain('aria-label="SSH 登录"');
    expect(html).toContain("继续已有 SSH 会话");
    expect(html).toContain("管理主机和密钥");
    expect(html).toContain("登录并打开终端");
    expect(html).not.toContain("正在恢复连接");
    expect(html).not.toContain("已配对的 Bridge 内容");
  });

  it("keeps App version details expandable and exposes both update actions inside the environment dialog", () => {
    const html = renderToStaticMarkup(createElement(MobileEnvironmentDialog, {
      options: [], busy: null, message: null, currentServer: "https://bridge.fixture", appVersion: "0.5.0 (100)",
      updateBanner: createElement("aside", { role: "status" }, "发现新的 Bridge App"),
      appChecking: false, appDownloading: false, appActionsBusy: false, appMessage: null, appError: null,
      onCheckUpdate: () => {}, onDownloadApp: () => {}, onSelect: () => {}, onOpenConnectionSettings: () => {}, onClose: () => {},
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("0.5.0 (100)");
    expect(html).toContain("检查更新");
    expect(html).toContain("手动下载 App");
    expect(html).toContain("<summary>版本详情</summary>");
    expect(html).toContain("内置页面");
    expect(html.indexOf("发现新的 Bridge App")).toBeLessThan(html.indexOf("切换 Bridge 环境"));
  });

  it("does not expose Android SSH metadata from a browser", async () => {
    await expect(listBrowserSshOptions()).rejects.toThrow("ConnectBot SSH 仅支持 Android App。");
    await expect(onBrowserSshReturnToWorkbench(() => {})).rejects.toThrow("ConnectBot SSH 仅支持 Android App。");
  });
});
