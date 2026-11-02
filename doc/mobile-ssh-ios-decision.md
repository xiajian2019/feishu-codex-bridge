# 移动端 SSH：iOS 技术决策记录

状态：决策记录，未实现

记录日期：2026-10-30

## 结论

当前首版明确采用 Android 优先。Android 采用 ConnectBot `cbssh + termlib` 的原生 SSH/终端页面；React 只负责独立入口和连接配置。iOS 本轮不实现 SSH，只记录候选方案、兼容性风险和跨平台协议边界。

本文件不是 iOS 功能说明，也不是实现完成证明。仓库中没有因为本记录而新增 iOS SSH 代码、依赖、页面、路由或配置；后续任何进度报告都不能把本文件引用为“iOS 已支持 SSH”。

Android SSH 与现有 Web tmux Dashboard 是两条独立链路：

```text
现有 Web 路径：React/xterm → Bridge WebSocket/API → Bridge 主机上的 tmux
SSH 路径：     React 配置入口 → ConnectBot cbssh/termlib → Mac sshd → PTY → tmux attach
```

两条路径可以共享移动端视觉语言和终端交互约定，但不共享 Bridge Bearer token、WebSocket、Bridge 数据库或 Web 端的任务状态。SSH 的目标是 Mac 的 `sshd` 和其后的 PTY；不是直接连接 tmux server，也不是在 Bridge 增加 SSH 中转服务。

## 为什么 iOS 本轮只记录决策

1. 用户已经确定首版 Android 优先。把 iOS 同时纳入实现会扩大原生传输、终端渲染、键盘、生命周期和真机验证范围，不能为 Android 首版提供必要收益。
2. 当前工程的 iOS 最低平台是 iOS 15；`ios/App/CapApp-SPM/Package.swift` 由 Capacitor CLI 管理，并明确标注不要手工修改。新增 Swift SSH 依赖前，必须先验证它与当前 Capacitor SPM 结构、Swift/Xcode 工具链和 iOS 15 的组合，而不是直接改受管理文件。
3. 候选库的主线平台声明并不稳定地对应当前工程：Citadel `0.9.2` 的包声明为 iOS 14，但当前主线 `Package.swift` 已声明 iOS 17。两者不能仅凭项目名称或旧版本经验互换，必须在目标工程中做实际解析、编译和真机验证。
4. iOS 还需要单独验证 Host Key 确认、Keychain 可用性、PTY/全屏终端、前后台切换、网络恢复和软键盘行为。当前没有这些验证结果，因此本轮只固化决策边界，不生成“兼容”或“可发布”的结论。

## 当前工程基线

- App 是 Capacitor + React/Vite，现有移动端页面复用 Web 工作台。
- 当前 tmux 页面在 `web/src/TmuxDashboard.tsx`，终端渲染使用 `@xterm/xterm`，传输逻辑在 `web/src/tmux-terminal-runtime.ts`。
- iOS 工程的 SPM 容器是 `ios/App/CapApp-SPM/Package.swift`，平台声明为 `.iOS(.v15)`，文件注释说明由 Capacitor CLI 管理。
- 现有 `BridgeCredentials` 是 Bridge 配对凭据能力；文档已规定 iOS Bridge 凭据使用 `WhenUnlockedThisDeviceOnly` Keychain。这个现有能力不等于 SSH 私钥、密码或 Host Key 已经接入，SSH 应使用独立命名空间和独立生命周期设计。
- 本轮不修改上述代码、依赖和受 Capacitor 管理的 SPM 文件。

相关源码与约定：

- [CapApp-SPM/Package.swift](../ios/App/CapApp-SPM/Package.swift#L4-L8)
- [手机 App 指南](mobile-app.md#L47-L71)
- [TmuxDashboard.tsx](../web/src/TmuxDashboard.tsx#L126-L126)
- [tmux-terminal-runtime.ts](../web/src/tmux-terminal-runtime.ts#L42-L44)

## iOS 候选方案

以下项目是后续评估候选，不代表已选型、已集成或已经通过当前工程验证。

| 候选 | 可参考内容 | 当前已知风险或待验证项 |
| --- | --- | --- |
| [SwiftTerm + Citadel 0.9.2](https://github.com/migueldeicaza/SwiftTerm) + [Citadel 0.9.2](https://github.com/orlandos-nl/Citadel/tree/0.9.2) | SwiftTerm 提供 Swift 侧 VT100/xterm 终端模拟器和 iOS 视图；Citadel 提供较高层的 Swift SSH API。 | `0.9.2` 的 `Package.swift` 声明 iOS 14，理论上与 iOS 15 平台下限不冲突，但仍需在当前 Xcode/Capacitor 工程中解析、编译并验证 SSH 交互、Host Key 和 PTY。它依赖的 SwiftNIO SSH 版本、Swift Crypto、C 目标和构建设置也不能从平台声明推断为可用。 |
| [SwiftTerm + swift-nio-ssh](https://github.com/apple/swift-nio-ssh) | SwiftTerm 官方资料说明其 iOS SSH 示例使用 SwiftNIO SSH；可以直接观察终端视图与 SSH channel 的连接方式。 | SwiftNIO SSH 官方定位是程序化 SSH 实现和构建块，不是开箱即用的生产客户端。认证、Host Key 策略、交互式 shell、PTY resize、错误映射和生命周期需要自行组合并测试；尚未验证与 iOS 15 及本工程 SPM 容器的组合。 |
| [SwiftTerm + libssh2](https://github.com/libssh2/libssh2) | libssh2 是 BSD-3-Clause 的 C SSH2 库，可作为跨语言协议层候选；SwiftTerm 负责终端模拟。 | 需要额外的 C/Swift 包装、构建和内存/线程边界；Host Key、认证、PTY、SFTP 和错误模型不能由“有 SSH2 库”这一事实直接推出。许可证、构建产物和 iOS 15 集成也需单独审查。 |

候选项目的上述描述仅依据其公开仓库、`README` 和包清单中的可见信息。候选库版本、平台声明和依赖关系会变化，真正实现前必须锁定版本并在本工程中复核。

## 未来必须保持的跨平台协议边界

Android 首版通过 native 页面实现这些边界，未来 iOS 只需选择自己的 native 页面或 React/xterm 页面，不应重新定义网络语义：

- 连接输入：主机、端口、用户名、认证方式、Host Key 策略；不包含 Bridge API 地址、Bridge Bearer token 或任意本地仓库路径。
- 生命周期事件：连接中、需要确认 Host Key、需要认证、已认证、PTY 已建立、收到输出、连接关闭、连接错误。事件名称可以在 Android 实现时落成具体接口，但 iOS 不应依赖 Android 私有字段。
- 终端操作：发送字节、调整列数/行数、关闭连接。输出应保持字节/分块语义，不能把 ANSI 控制序列先转成 Web 文本再让另一端猜测终端状态。
- 远端目标：通过 SSH 登录 Mac 后，在明确的交互式 PTY 中执行或附加 tmux session。tmux session 的发现、选择和 attach 命令属于 SSH 端的交互流程，不等于 Bridge 的 Session API。
- 认证失败、Host Key 拒绝、网络中断、PTY 退出和用户主动断开必须是可区分的状态；不能用“WebSocket 断开”或“Bridge 离线”文案替代 SSH 状态。

这是一份接口边界，不是当前已存在的原生插件 API。实现时若需要调整事件名称或字段，应先更新此记录或对应设计，再分别验证 Android 和未来 iOS 的映射。

## 两条可选 UI 路线

### 路线 A：原生 SSH 页面

未来 iOS 可使用 SwiftUI/UIKit 页面、SwiftTerm 原生终端视图和原生 SSH 传输；Android 也可以采用原生终端组件。React 只负责入口、导航交接或完全不参与终端字节流。

优点是终端渲染、PTY 输出、输入法、滚动和平台生命周期在同一侧处理；代价是 Android/iOS 需要维护两套 Host 管理、键盘工具栏、状态和视觉适配。该路线不能因为候选库存在就视为已验证。

### 路线 B：React/xterm 页面

该路线不再是 Android 首版主链路。当前 React/xterm 代码保留为过渡回退，但 SSH 终端输入、输出、滚动、选择和快捷键已转向原生 termlib。iOS 若未来复用 React/xterm，仍必须单独验证 Native → Capacitor → WebView → xterm 的吞吐、背压、中文/宽字符、alternate screen、选择、滚动、软键盘和前后台恢复。

这两条路线共享的是 SSH 的逻辑状态和数据边界，不代表共用实现。现有 Web tmux Dashboard 继续保留，不因新增 SSH 页面而移除、替换或削弱。

## 安全和生命周期边界

### Host Key

- 首次连接必须有明确的 Host Key 展示和确认流程；不能默认“接受任何 Host Key”，也不能把指纹校验失败伪装成普通网络重试。
- 后续应按主机身份保存已确认的 Host Key/指纹，并能在变化时阻断连接、显示差异并允许用户重新审查。具体存储位置、迁移和删除策略待实现阶段确定。
- Host Key 的确认记录与 Bridge 设备授权、Bridge Cookie、WebSocket 票据分离。

### Keychain

- iOS 未来的 SSH 密码、私钥和必要的私钥口令必须进入 Keychain，不得写入 `localStorage`、URL、日志或普通配置文件。
- 可参考当前 Bridge 凭据的 `WhenUnlockedThisDeviceOnly` 策略，但不能直接宣称它已经覆盖 SSH；SSH 凭据的账户、主机、设备迁移和锁屏行为需要单独验证。
- 私钥导入、删除、备份/迁移、Keychain 锁定期间的失败表现和日志脱敏都属于 iOS 实现验收项。

### PTY 与 tmux

- 交互式 SSH 必须以 PTY 语义承载终端，并支持列数/行数变化；`TERM`、颜色、全屏程序、中文宽字符和控制序列要以实测结果为准。
- tmux 用于承载断线后的工作状态；SSH 连接断开不应杀死 tmux session 或其中的 Codex/终端程序。
- SSH PTY 与现有 Bridge WebSocket 终端不是同一连接。不能将一条链路的重连、滚动或鉴权状态推断到另一条链路。

### 后台与重连

- iOS 后台不承诺维持一个长期交互式 SSH/PTY。进入后台时可暂停或关闭连接，回到前台后重新建立 SSH 并重新确认当前 session 状态。
- “后台重连”只表示前台恢复时的恢复策略，不表示后台持续执行、不表示系统推送，也不表示手机一直持有一个可写的远程终端。
- 重连后要重新处理网络、认证、Host Key 和 PTY 尺寸；tmux 负责保存远端工作状态，客户端负责恢复观察和输入。

### Mosh 与 SFTP

- Mosh 不在 Android 首版或本 iOS 决策的实现范围内。它涉及不同的传输、UDP/网络策略和服务器能力，不能作为 SSH 重连的简单替换。
- SFTP 不在首版终端范围内。它是独立的文件传输能力，需要单独设计目录范围、覆盖策略、权限提示、断点/失败行为和与现有 Session 文件页、App 附件流的边界。
- 在 SSH + PTY + tmux attach 经真实验证前，不增加 Mosh/SFTP 依赖，也不以“候选库支持”作为功能完成依据。

## iOS 开始实现前的验证门槛

未来若重新启动 iOS 实现，至少需要形成以下证据后才能更新状态：

1. 锁定候选库版本，并在当前 iOS 15 工程和实际 Xcode 工具链中完成依赖解析、编译和链接；不能直接修改由 Capacitor 管理的 `CapApp-SPM/Package.swift` 作为未经验证的接入手段。
2. 使用真实 Mac `sshd` 和 tmux 验证密码/密钥认证、首次/已知/变化 Host Key、PTY attach、resize、中文和全屏终端输出。
3. 验证网络切换、断线、前后台、锁屏/解锁和重新连接；确认 tmux 与 Codex 进程不会被客户端连接关闭误杀。
4. 验证私钥/密码/Host Key 的 Keychain 行为、删除和日志脱敏；检查没有凭据进入 URL、Bridge Web API 或普通 WebView 存储。
5. 若选择 React/xterm，补充 Native → Capacitor → WebView → xterm 的高吞吐、背压、alternate screen、触摸滚动、复制和软键盘证据；若选择原生页面，则补充原生终端渲染和交互证据。
6. 单独检查候选库许可证、传递依赖、平台下限、维护状态和发布包体影响。

在这些门槛完成前，iOS 状态保持“未实现、待评估”。

## 参考资料

- 当前工程：[CapApp-SPM/Package.swift](../ios/App/CapApp-SPM/Package.swift)、[手机 App 指南](mobile-app.md)、[TmuxDashboard.tsx](../web/src/TmuxDashboard.tsx)、[tmux-terminal-runtime.ts](../web/src/tmux-terminal-runtime.ts)。
- [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)：Swift 终端模拟器；其公开说明包含 iOS 终端视图和 SSH 集成示例，但不因此证明已适配本工程。
- [Citadel 0.9.2 Package.swift](https://github.com/orlandos-nl/Citadel/blob/0.9.2/Package.swift)：记录版本的平台声明和依赖关系。
- [Citadel 当前主线 Package.swift](https://github.com/orlandos-nl/Citadel/blob/main/Package.swift)：记录主线 iOS 版本变化风险。
- [SwiftNIO SSH](https://github.com/apple/swift-nio-ssh)：程序化 SSH 构建块，不能直接当作完整移动端 SSH 客户端。
- [libssh2](https://github.com/libssh2/libssh2)：C 语言 SSH2 库候选；接入 iOS 需要单独处理包装、构建和安全边界。
