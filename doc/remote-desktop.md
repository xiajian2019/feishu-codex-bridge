# 远程桌面

Web、iOS 和 Android 的「远程桌面」使用 noVNC 连接运行 Bridge 的主机。它与 Tmux 和 SSH 是独立入口，关闭网页或断开连接不会关闭 Tmux Session。

## 开始使用

1. 在 Mac 的「系统设置 → 通用 → 共享」中启用「屏幕共享」，并允许需要使用的 Mac 用户访问。
2. 在已经配对 Bridge 的浏览器或 App 中打开「远程桌面」，点击「连接桌面」。服务器要求登录时输入 Mac 账号及密码，或其配置的 VNC 密码。
3. 页面可切换只读、适应屏幕、原始尺寸和画面移动。双指点击对应右键，双指拖动用于滚动；键盘区提供修饰键、方向键和文字输入。剪贴板通过页面中的按钮明确发送或复制。

Bridge 固定连接运行它的主机上的 `127.0.0.1:5900`，不接受客户端提供其他主机或端口。Mac 必须保持可访问且屏幕共享正在运行；重启、休眠、锁屏或 FileVault 场景的可用性取决于 Mac 的状态与配置。

同一个单页应用中切换到其他功能时，已建立的远程桌面连接会保留；离开远程桌面后键盘和鼠标输入停用，后台仍会接收画面并消耗流量。返回时继续使用该连接；点击「断开连接」、切换 Bridge、设备授权失效或关闭页面时结束连接。浏览器真正重载、网络中断或系统回收页面后，需要重新连接。

使用 HTTPS 或受信任的 VPN 连接 Bridge。浏览器的安全上下文和 WebCrypto 会影响 Mac 账号认证；屏幕与输入会经过 Bridge，VNC 登录凭据不会由 Bridge 保存。手机 App 必须能连接当前 Bridge：该版本没有独立于 Bridge 服务的 VNC 直连或后台保活。

## 连接成功但画面黑屏

连接成功只表示屏幕共享的认证和 RFB 握手已完成，不代表 Mac 已经成功采集并发送画面。黑屏可能有多种原因；如果 Mac 的 `screensharingd` 日志出现 `Unable to capture screen`，并且系统拒绝了 `com.apple.screensharing.agent` 的 `kTCCServiceScreenCapture` 请求，需要先处理 Mac 的屏幕捕获授权，重连或更换 VNC 客户端不能修复该授权。

可在 Mac 本机的「系统设置 → 通用 → 共享」中关闭后重新开启「屏幕共享」，按系统提示完成授权，然后重新连接并确认是否出现画面。操作会断开现有屏幕共享连接。如果授权仍被拒绝，继续检查系统设置中的「隐私与安全性 → 屏幕与系统音频录制」，并按实际列出的项目和系统提示处理。画面恢复后还需单独确认键盘和鼠标控制是否可用：`kTCCServicePostEvent` 被拒绝会影响输入控制。相关入口见 [Apple 屏幕共享设置](https://support.apple.com/guide/mac-help/mh11848/mac) 和 [屏幕录制权限说明](https://support.apple.com/guide/mac-help/mchld6aa7d23/mac)。

`tccutil reset ScreenCapture` 只会重置权限决定，不能直接授予授权；不要把它当作黑屏修复命令。无法操作 Mac 本机时，不应将服务端口可达或连接成功视为权限已经恢复。

## 实现与验证

- 前端固定使用 `@novnc/novnc`，以 RFB 字节流连接 Bridge。代码和许可见仓库依赖与 `web/public/open-source-licenses`。
- 建立 WebSocket 前通过现有设备授权和 Action Token 获取一次性、短期票据。服务端固定连接本机，检查连接期授权，撤销或过期时断开 WebSocket 和 TCP。
- `web/novnc-compat.ts` 将 noVNC 1.7 的 H.264 顶层异步探测转为可等待的初始化，保留现有 Web 构建目标；探测无响应时回退其他编码。升级 noVNC 时需要重新检查该兼容处理。
- Web、iOS、Android 使用同一页面。浏览器模拟、前端构建、手机安装包和真机手势/软键盘是不同验证层级。
