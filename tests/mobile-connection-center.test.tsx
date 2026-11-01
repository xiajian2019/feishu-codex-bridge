import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { MobileConnectionContent } from "../web/src/MobileConnectionGate.js";
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

  it("does not expose Android SSH metadata from a browser", async () => {
    await expect(listBrowserSshOptions()).rejects.toThrow("ConnectBot SSH 仅支持 Android App。");
    await expect(onBrowserSshReturnToWorkbench(() => {})).rejects.toThrow("ConnectBot SSH 仅支持 Android App。");
  });
});
