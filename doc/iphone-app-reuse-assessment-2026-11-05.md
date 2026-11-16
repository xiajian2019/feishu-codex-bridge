# Android 到 iPhone App 复用评估报告

日期：2026-11-05
评估对象：当前 checkout 的 `feature/capacitor-mobile-app`
评估范围：现有 Capacitor/React 移动工作台、Android 原生 SSH 工作区、移动鉴权/文件能力、Android VPN 与更新能力。

## 结论摘要

本项目并不是“把 Android UI 翻译成 iOS UI”这一种迁移，而是两条实现路径的组合：

```text
可跨平台复用的路径：React/Vite → Capacitor WebView → Bridge API/WebSocket
Android 专属路径：React 入口 → Kotlin/Java → ConnectBot cbssh/termlib → SSH PTY/tmux
```

结论按不同目标分为两档：

| 目标 | 可复用程度 | 判断 |
| --- | ---: | --- |
| iPhone 先提供现有 App 的配对、任务、History、Web tmux、文件、Git、Demo 和分享能力 | **约 85%–95%** | 主要复用现有 React/Vite、服务端 API、xterm、Capacitor 插件和移动鉴权链路；iOS 工程已经存在，但仍需完整 Xcode、签名和真机验收。 |
| iPhone 也要达到 Android 原生 SSH 工作区的完整能力 | **约 55%–65% 的功能/契约复用** | Web/API 能力仍大部分复用，但 SSH 传输、终端、Host Key、Keychain、SFTP、Composer 原生页面和生命周期需要 iOS 实现。 |
| Android 原生 SSH 模块的直接源码复用 | **约 0%–10%** | Kotlin/Java、Jetpack Compose、Android Keystore、Android Activity/Service、ConnectBot `sshlib` 和 `termlib` 不能直接在 iOS 编译；可复用的是协议边界、数据格式、测试场景和安全规则。 |

这里的百分比不是按代码行数计算，而是按用户可见能力和实现边界估算。若把“逻辑可迁移但代码必须重写”也算作复用，比例会高；若只算可以原样复制的源码，Android 原生 SSH 部分几乎没有可直接复制的代码。

## 当前实现基线

### 已经具备的跨平台基础

- App 使用 Capacitor 8.5.3；移动端独立构建输出 `dist/mobile`，浏览器构建输出 `dist/web`。`vite.mobile.config.ts` 只增加移动标记、安全区配置和移动输出目录，React 页面仍从同一套 `web/src` 代码构建。[vite.mobile.config.ts](../web/vite.mobile.config.ts#L6-L24)
- 移动运行时已经把 Bridge 地址、Bearer 凭据、配对、连接切换、前后台恢复、SSE/终端票据和下载/分享状态集中在 TypeScript 层。[mobile-runtime.ts](../web/src/mobile-runtime.ts#L121-L186) [mobile-runtime.ts](../web/src/mobile-runtime.ts#L236-L342)
- 服务端的移动配对、Bearer 鉴权、Action Token、一次性路径绑定 stream ticket、SSE 和 tmux WebSocket 语义与客户端平台无关。[web.ts](../src/web.ts#L311-L389) [mobile-auth.ts](../src/mobile-auth.ts#L30-L78)
- iOS 的 Capacitor SPM 容器已经包含 App、扫码、浏览器、剪贴板、FileTransfer、Filesystem、本地通知和 Share 等标准插件。[Package.swift](../ios/App/CapApp-SPM/Package.swift#L4-L38)
- iOS 已有 Bridge 凭据插件，使用 Keychain 的 `WhenUnlockedThisDeviceOnly`；这覆盖的是 Bridge Bearer token，不等于 SSH 私钥、密码和 Host Key 已完成。[BridgeCredentialsPlugin.swift](../ios/App/App/BridgeCredentialsPlugin.swift#L15-L78)
- iOS 已有分享扩展、App Group 和 Bridge 分享收件箱插件，分享内容只写入本机收件箱，不会自动上传或执行。[BridgeViewController.swift](../ios/App/App/BridgeViewController.swift#L3-L7) [BridgeShareInboxPlugin.swift](../ios/App/App/BridgeShareInboxPlugin.swift#L13-L54) [ShareViewController.swift](../ios/App/ShareExtension/ShareViewController.swift#L29-L96)

### Android 原生能力的边界

- Android 的 `MainActivity` 同时承担 Capacitor 宿主和嵌入式 SSH 宿主，并注册 SSH、凭据、更新、分享、主题、Composer 数据、动作感知和自动 VPN 插件。[MainActivity.java](../android/app/src/main/java/dev/feishu/codex/bridge/MainActivity.java#L7-L45)
- SSH 原生实现依赖 ConnectBot `sshlib:0.5.0`、Tink、`termlib:0.3.13` 和 Jetpack Compose；这些依赖没有对应的 iOS 实现可直接复用。[build.gradle](../android/app/build.gradle#L55-L79)
- `BridgeConnectBotSshActivity.kt` 将连接设置、认证、Host Key、tmux、终端、文件、Composer、生命周期、诊断和恢复集中在一个约 3,400 行的 Activity 中。它是 Android 的工作实现，但不适合按文件整体翻译成 Swift。[BridgeConnectBotSshActivity.kt](../android/app/src/main/java/dev/feishu/codex/bridge/BridgeConnectBotSshActivity.kt#L110-L120)
- Web 端的原生 SSH 入口明确把能力限制为 Android：`isNativeSshWorkspaceAvailable()` 检查 `Capacitor.getPlatform() === "android"` 和 `BridgeConnectBotSSH` 插件。[ssh-connectbot-native.ts](../web/src/ssh-connectbot-native.ts#L40-L60)
- 当前 iOS `BridgeViewController` 只注册凭据和分享收件箱，没有 `BridgeConnectBotSSH` 插件。因此，当前 iPhone 即使能构建，也只能走 Web 工作台路径，不能打开 Android 原生 SSH 工作区。[BridgeViewController.swift](../ios/App/App/BridgeViewController.swift#L3-L7)

## 按功能的复用矩阵

“直接复用”表示同一份 TypeScript/React/服务端代码可继续使用；“行为复用”表示规则、接口、测试向量或用户语义可以沿用，但原生实现需要重写。

| 功能 | 直接复用 | 行为/契约复用 | iPhone 需要做的工作 |
| --- | ---: | ---: | --- |
| React 页面、路由、主题、CSS、任务面板、History、Demo、系统管理 | 95%–100% | 100% | 主要做 iOS WebView、键盘、安全区、触摸和窄屏真机回归。 |
| Bridge 配对、Bearer、Action Token、设备撤销 | 90%–100% | 100% | 复用服务端和 TS；验证 Keychain 锁屏、撤销后连接和跨环境切换。 |
| SSE、tmux WebSocket、一次性 stream ticket | 95%–100% | 100% | 复用票据协议和 WebSocket 客户端；验证 iOS 前后台、网络切换、连接恢复。 |
| Web tmux terminal、xterm、Session 列表、Git/Diff/文件页面 | 90%–100% | 100% | 复用 Web 路径；这不是 Android 原生 SSH 的替代实现，需单独做 iPhone 触摸滚动、软键盘和高输出量验收。 |
| 扫码、浏览器打开、剪贴板、Filesystem、FileTransfer、系统分享 | 70%–90% | 80%–100% | 标准 Capacitor iOS 插件已在 SPM 中；补权限、文件 URL、分享取消、磁盘不足和真机行为验证。 |
| 本地通知、通知点击和安全导航恢复 | 70%–90% | 80%–100% | 复用 TS 的通知去重和安全路由；验证 iOS 权限、通知 action、冷启动和 App Group/设备作用域。 |
| 分享收件箱 | 80%–90% | 90%–100% | iOS 主 App、扩展和 App Group 已有；需完成签名配置、扩展真机分享和大文件/授权失效验收。 |
| Bridge token 存储 | 80%–90% | 100% | iOS Keychain 插件已实现；需补锁屏、删除、错误映射和安装/卸载策略测试。 |
| Android 原生 SSH 连接、密码/密钥认证、Host Key | 0%–10% | 50%–70% | 重新选择并验证 Swift SSH 库；实现 Keychain 私钥、Host Key 确认/变化阻断和错误状态。 |
| SSH PTY、终端渲染、resize、滚动、复制、全屏程序 | 0%–10% | 40%–60% | 选择 SwiftTerm/其他终端路线，重写字节流、PTY、输入法、选择和前后台恢复；不能把 WebSocket tmux 结果当作 SSH 证明。 |
| SSH tmux 选择、attach/detach、断线重连 | 0%–10% | 50%–70% | 复用 Session 身份、`id + createdAt`、tmux 保护和“不自动重放未知写入”的规则；重写 SSH 侧命令和状态机。 |
| SSH SFTP 文件、预览、下载和 Composer 附件 | 0%–10% | 50%–70% | 重写 SFTP、路径/符号链接边界、独占上传、失败清理和 API-first/SSH fallback 适配。 |
| Android 原生 Composer、快捷键、技能和草稿 | 0%–10% | 60%–80% | 可复用 bracketed paste、技能触发、附件状态和结果未知等行为；UI、IME、终端写入队列需 iOS 重新实现。 |
| Android 前台 Service、后台 SSH 存活 | 0% | 40%–60% | iOS 没有同等的长期交互式 SSH 前台 Service；应采用前台暂停/关闭、回前台重连、tmux 保留远端进程的模型。 |
| OpenVPN for Android 自动连接 | 0% | 0%–20% | AIDL、Android 包发现、Wi-Fi/位置权限和现有 OpenVPN 客户端控制不能复用；iOS 需要 Network Extension、VPN 配置、签名 entitlement 和分发审核，建议独立立项。 |
| APK 自更新和 Android DownloadManager | 0% | 不适用 | iOS 不能安装 APK；应使用 App Store/TestFlight/企业分发。普通文件下载可复用 Capacitor FileTransfer + Share，但不复用 APK 更新状态机。 |
| Android JVM/UI 测试 | 0%–20% | 50%–80% | 可复用测试场景、fixture、协议向量和安全断言；测试代码需迁移为 Swift/XCTest/XCUITest 或 Web 测试。当前没有 iOS 测试 target。 |

## 两种落地方案

### 方案 A：iPhone 首版只做 Capacitor/Web 工作台（推荐）

范围包括配对、任务、Codex History、Web tmux、文件、Git、Demo、通知、扫码、分享和移动下载/导出，不承诺 iOS 直接 SSH。

优点：

- 复用比例最高，约 85%–95%；不需要引入新的 SSH 原生库。
- 服务端、React 页面、xterm、鉴权、stream ticket、文件 API 和大部分测试都保持一套实现。
- 当前 iOS 壳、Keychain、Share Extension 和标准 Capacitor 插件已经存在，主要缺口是 Xcode 构建、签名和真机验证。
- 不会把 Web tmux 和 Android SSH 两条不同传输链路强行合并，风险最小。

代价：iPhone 不能在 Bridge 不可达时直接 SSH 到 Mac，也不能使用 Android 原生 SSH 的 SFTP/Composer fallback。这个差异应在 App 连接页明确展示，而不是把 Web tmux 宣称为原生 SSH。

### 方案 B：iPhone 追平 Android 原生 SSH

建议拆成以下阶段：

1. **iOS SSH 技术 Spike**：在当前 iOS 15 工程和真实 Xcode 中锁定 SwiftTerm + SSH 库组合，完成依赖解析、编译、密码认证、PTY、Host Key 和真实 Mac `sshd` 连接。
2. **最小 SSH 工作区**：主机/用户名/密码、Keychain 私钥、Host Key 首次确认与变化阻断、交互式 PTY、终端渲染、列行 resize、tmux attach 和前台重连。
3. **功能 parity**：tmux 选择器、SFTP 文件、预览/下载、Composer、快捷键、技能、附件上传、API-first/fallback 和结果未知提示。
4. **生命周期与安全验收**：网络切换、前后台、锁屏/解锁、私钥删除、Keychain 锁定、进程重建、中文宽字符、全屏 TUI、触摸滚动、复制和高吞吐输出。
5. **独立评估 VPN**：若必须保留 Android 的自动 VPN 行为，再单独设计 Network Extension 和签名/分发方案，不把它混入 SSH port 的第一轮验收。

实现时应先抽出跨平台契约，而不是复制 `BridgeConnectBotSshActivity.kt`：

- 连接状态：连接中、Host Key 待确认、认证中、已认证、PTY 已建立、输出中、断开、错误、用户主动关闭。
- 终端操作：发送字节、读取字节块、列行 resize、EOF、关闭；不把 ANSI 字节先转换成 Web 文本。
- 安全边界：私钥、密码和 Host Key 不进入 WebView、URL、日志或普通配置；Bridge token 与 SSH 凭据分离。
- Session 身份：沿用 Session ID 与 `createdAt`，恢复前重新确认目标；未知写入结果不自动重放。
- 文件边界：禁止绝对路径/`..` 穿越、拒绝越界符号链接、上传独占创建、失败清理和 API/SSH 目标可读性检查。
- 测试向量：从现有 Kotlin 测试提取输入、输出和错误分类，转成 Swift/XCTest 与 Web 共享 fixture。

## 主要风险

### 1. 把 Web tmux 当成 Android SSH 的可复用实现

Web 终端是 `React/xterm → Bridge WebSocket → Bridge 主机 tmux`；Android 原生是 `ConnectBot → Mac sshd → PTY → tmux`。两者的鉴权、断线、滚动、生命周期和目标机器边界不同。iPhone 如果只走 Web 工作台，不需要实现 SSH；如果要直接 SSH，就必须建立新的原生传输链路。

### 2. iOS 当前只有 Bridge 凭据存储，没有 SSH 凭据体系

现有 iOS Keychain 插件只存 Bridge server 对应的 Bearer token。SSH 私钥、私钥口令、Host Key 指纹和主机配置必须使用独立命名空间、独立删除策略和独立日志脱敏规则，不能把 Bridge token 插件直接当作 SSH 存储已完成。

### 3. iOS 后台模型不能照搬 Android 前台 Service

Android 的 `BridgeSshConnectionService` 只提供连接存活保护，iOS 没有等价的长期交互式 SSH 保活承诺。正确的 iOS 方案应让 tmux 保留远端工作进程，App 前台恢复时重新连接、重新确认 Host Key/PTY 尺寸和当前 Session，而不是承诺后台一直持有可写终端。

### 4. Android-only 更新和 VPN 没有 iOS 直译

APK 自更新只能留在 Android；iOS 需要 App Store/TestFlight 或其他正式分发。OpenVPN for Android 的 AIDL 控制、包查询、位置/Wi-Fi 权限和外部客户端状态也不能转为 iOS API 调用，Network Extension 是单独的工程和签名边界。

### 5. 当前 iOS 工具链不足以证明可编译

本机当前只有 Command Line Tools，`xcodebuild` 无法运行完整 Xcode；iOS 最低版本是 15，且 `CapApp-SPM/Package.swift` 由 Capacitor CLI 管理，不应在未验证的情况下直接修改它加入 SSH 依赖。候选 Swift SSH 库必须在目标 Xcode、iOS 15 和当前 Capacitor 工程中实际解析和编译。

### 6. Android 原生实现集中度高，直接移植会放大维护风险

Android 生产源码约 15,318 行，iOS 当前自有 Swift/分享扩展源码约 315 行；行数不能作为复用率，但说明 SSH parity 并不是补一个插件注册即可完成。应把连接、终端、文件、Composer 和生命周期拆成 iOS 独立模块，保持和 Android 相同的行为契约，而不是按 Activity 行号逐段翻译。

## 本次验证结果与边界

| 检查 | 结果 | 可证明的范围 |
| --- | --- | --- |
| `bun run mobile:verify` | 通过 | `dist/web` 未混入原生插件/App 凭据逻辑，Web/App viewport 构建隔离。 |
| `bun run --bun tsc -p web/tsconfig.json --noEmit` | 通过 | 当前 Web/移动 TypeScript 类型检查。 |
| `bun run --bun tsc -p tsconfig.json --noEmit` | 通过 | 当前后端 TypeScript 类型检查。 |
| 移动鉴权、连接、stream、handoff、Android SSH API 定向测试 | **36 pass / 0 fail / 275 assertions** | TS/API/fixture 逻辑；其中包含服务端临时端口，已在授权环境重跑。 |
| `bun run mobile:doctor` | 未通过 | Java 21 和 Android SDK 可用；本机缺完整 Xcode、Android Studio。 |
| iOS `xcodebuild` / IPA / 真机 | 未执行 | 当前环境没有完整 Xcode；不能把 iOS 壳、SPM 文件或语法检查写成 iOS 编译/分发通过。 |
| Android 真实设备、真实 Mac SSH/tmux/Codex | 本次未执行 | 本报告不把 JVM、fixture 或静态源码当作真机和生产行为证明。 |

## 建议决策

建议把 iPhone 首版定义为 **Capacitor/Web 工作台**，先完成完整 Xcode、签名、iPhone WebSocket/xterm、Keychain、分享扩展、通知、文件分享和前后台验收。这样可以先交付大部分 Android App 的远程管理能力，预计复用 85%–95%。

只有在“Bridge 不可达时仍需手机直连 Mac SSH”是明确的核心需求时，才启动方案 B；此时按独立 iOS 原生 SSH 项目估算，功能契约可复用约 55%–65%，Android SSH 源码本身不能作为可直接移植资产。VPN 和 iOS 分发更新应另立验收项，不纳入第一轮 SSH parity 承诺。

## 参考文件

- [手机 App 指南](mobile-app.md)
- [移动端 SSH：iOS 技术决策记录](mobile-ssh-ios-decision.md)
- [Android App 架构与风险评审](android-app-architecture-review-2026-11-02.md)
- [移动端第一批能力增强](mobile-phase-one-2026-10-29.md)
- [移动构建隔离脚本](../scripts/check-mobile-isolation.mjs)
- [移动原生适配层](../web/src/mobile-native.ts)
- [Android SSH 技术决策](../android/bridge-ssh-technical-decision.md)
