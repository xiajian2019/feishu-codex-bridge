import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { MobileAutoVpnSettings, MobileConnectionContent, MobileEnvironmentDialog } from "../web/src/MobileConnectionGate.js";
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
    expect(html).toContain("<summary>网络设置</summary>");
    expect(html).toContain("免 VPN 的 Wi‑Fi");
    expect(html).not.toContain('aria-label="SSH 登录"');
  });

  it("keeps App version details expandable and exposes the manual update actions inside the environment dialog", () => {
    const html = renderToStaticMarkup(createElement(MobileEnvironmentDialog, {
      options: [], busy: null, message: null, currentServer: "https://bridge.fixture", appVersion: "0.5.0 (100)",
      vpnChecking: false, vpnMessage: null, onCheckVpn: () => {},
      appChecking: false, appDownloading: false, appActionsBusy: false, appMessage: null, appError: null,
      onCheckUpdate: () => {}, onDownloadApp: () => {}, onSelect: () => {}, onOpenConnectionSettings: () => {}, onClose: () => {},
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("0.5.0 (100)");
    expect(html).toContain("检查更新");
    expect(html).toContain("手动下载 App");
    expect(html).toContain('aria-label="检查并连接 VPN"');
    expect(html).toContain(">VPN</button>");
    expect(html).not.toContain("<svg");
    expect(html.indexOf("https://bridge.fixture")).toBeLessThan(html.indexOf('aria-label="检查并连接 VPN"'));
    expect(html).toContain("<summary>版本详情</summary>");
    expect(html).toContain("内置页面");
    expect(html).not.toContain("发现新的 Bridge App");

    const loadingHtml = renderToStaticMarkup(createElement(MobileEnvironmentDialog, {
      options: [], busy: null, message: null, currentServer: "https://bridge.fixture", appVersion: "浏览器预览",
      vpnChecking: true, vpnMessage: "正在检查 VPN 和当前网络…", onCheckVpn: () => {},
      appChecking: false, appDownloading: false, appActionsBusy: false, appMessage: null, appError: null,
      onCheckUpdate: () => {}, onDownloadApp: () => {}, onSelect: () => {}, onOpenConnectionSettings: () => {}, onClose: () => {},
    }));
    expect(loadingHtml).toContain('aria-label="正在检查 VPN"');
    expect(loadingHtml).toContain('aria-busy="true"');
    expect(loadingHtml).toContain("正在检查 VPN 和当前网络…");
  });

  it("places the global target and Wi-Fi VPN exemption settings in connection management", () => {
    const html = renderToStaticMarkup(createElement(MobileAutoVpnSettings));
    expect(html).toContain("自动 VPN 网络设置");
    expect(html).toContain("全局 IP");
    expect(html).toContain("免 VPN 的 Wi‑Fi");
    expect(html).toContain('aria-label="读取当前 Wi‑Fi"');
    expect(html).toContain("Bridge 只读取 SSID，不读取 GPS 坐标");
    expect(html).toContain("保存网络配置");
  });

  it("does not expose Android SSH metadata from a browser", async () => {
    await expect(listBrowserSshOptions()).rejects.toThrow("ConnectBot SSH 仅支持 Android App。");
    await expect(onBrowserSshReturnToWorkbench(() => {})).rejects.toThrow("ConnectBot SSH 仅支持 Android App。");
  });
});
