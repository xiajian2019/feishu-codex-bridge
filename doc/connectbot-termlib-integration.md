# ConnectBot termlib 集成边界

本文记录 Android 端接入 `org.connectbot:termlib:0.3.13` 的边界：终端适配层与 SSH 实现解耦，原生 Host 由 `BridgeConnectBotSshActivity` 承载。适配层本身不是 Activity，由独立 Capacitor 插件和原生页面承载。

## 为什么只接入 termlib

ConnectBot 的 `termlib` 是一个终端模拟与渲染组件，输入输出的 PTY、SSH、Telnet 连接由宿主应用负责。它提供 libvterm 驱动的 Compose 终端、原生滚动、触摸选择、缩放、动态尺寸、组合字符和键盘处理能力；这正好解决当前 WebView/xterm 版本的输入通道和移动端终端交互问题，同时不会把 ConnectBot 的 Host 数据库、页面和生命周期整体搬进 Bridge。

上游参考：

- [ConnectBot termlib](https://github.com/connectbot/termlib)
- [termlib README / architecture](https://github.com/connectbot/termlib/blob/main/lib/README.md)
- [termlib API documentation](https://termlib.connectbot.org/0.3.13/)
- Maven Central 坐标：[org.connectbot:termlib:0.3.13](https://central.sonatype.com/artifact/org.connectbot/termlib/0.3.13)

termlib 和 ConnectBot 项目使用 Apache-2.0；最终构建接入依赖时要把上游许可证和 NOTICE 归入 APK 的第三方声明流程。termlib 内部使用的 libvterm 另有 MIT 许可，不能因为只引用 Maven artifact 就省略归属。

## 本次新增文件

### `BridgeSshTerminalView.kt`

这个文件包含三层职责：

1. `BridgeSshTerminalTransport`：SSH/PTy 的最小适配接口。
2. `BridgeSshTerminalSession`：创建并持有一个 termlib `TerminalEmulator`，转发原始字节、状态和 resize，并负责 transport 的解绑/关闭。
3. `BridgeSshTerminalView`：把 `TerminalEmulator` 交给 termlib 的 `Terminal` Compose composable。

字节方向保持原样，不在这一层做 UTF-8 解码，也不把大段输入拆成 React/Capacitor 消息：

| 方向 | 接口 | 语义 |
| --- | --- | --- |
| SSH → 终端 | `BridgeSshTerminalTransport.Listener.onSshOutput` | 远端 PTY 原始字节，送入 `TerminalEmulator.writeInput` |
| 终端 → SSH | `BridgeSshTerminalTransport.writeToSsh` | termlib 键盘/IME/快捷键产生的原始字节 |
| 尺寸 → SSH | `BridgeSshTerminalTransport.requestResize` | rows、columns，以及可选的像素尺寸 |
| 状态 → UI | `Listener.onStateChanged` / `onClosed` | 连接生命周期，不依赖 Capacitor 事件名 |

`BridgeSshTerminalSession` 会复制跨边界的字节缓冲区，避免 SSH socket 线程复用读缓冲时污染 libvterm 或远端写入。输入输出仍由具体 SSH transport 负责线程调度、背压、认证和错误处理。

`TerminalEmulatorFactory.create` 的 `onResize` 回调会把 termlib 根据 Compose 布局计算出的 rows、columns 和像素尺寸转发给 transport，因此正常布局变化也能触发远端 PTY resize。若宿主希望明确控制固定网格，可以给 `BridgeSshTerminalView` 传 `forcedSize`，同一 rows/columns 会通过 `session.resize` 同步给 transport。transport 必须把 resize 放入自己的非阻塞队列，不能在 termlib 的 UI looper 回调里做阻塞网络 I/O。

原生 SSH 在普通屏幕上使用 termlib 的本地 scrollback。tmux 客户端的备用屏幕没有对应的本地历史；从原生选择器进入 Session 后，在终端下滑或使用“到顶部”时，通过独立 SSH exec 只读获取该 Session 当前 pane 的最近 1000 行，放到本地只读终端中浏览。实时终端继续接收输出；滑回底部或点“返回实时”关闭历史视图，不向 tmux/Codex 发送滚轮、进入 copy mode 或修改远端会话。手动输入命令进入的 tmux Session 尚未关联选择器身份，备用屏幕不能使用此历史回退。

Composer 聚焦时只隐藏 termlib 的本地渲染光标；原始 PTY 字节不变，失焦时按远端光标状态恢复。输入期间固定显示三行并在输入框内部滚动，失焦后仍可展开到六行。SSH Activity 已使用 `adjustResize`，因此界面不再重复应用键盘内边距；PTY resize 对连续变化做 180 ms 合并，首次尺寸和最终稳定尺寸仍会发送。

精确检查了 `termlib-0.3.13.aar` 和对应 sources：`TerminalEmulatorFactory.create` 暴露 `onKeyboardInput: (ByteArray) -> Unit` 与 `onResize: (TerminalDimensions) -> Unit`；`TerminalEmulator` 暴露 `writeInput`、`resize` 和 `dimensions`；`Terminal` 暴露 `forcedSize`、`resizeSuspended` 以及触摸/选择相关 Compose 参数。需要注意，0.3.13 的 `TerminalEmulator` 没有公开 `close()`/`dispose()` 方法，本适配层的 `session.close()` 只解绑并关闭 SSH transport，随后丢弃 session，不能再次使用 emulator；如果后续升级 termlib 暴露显式释放 API，再单独补充生命周期处理。

### `BridgeSshTerminalScreen.kt`

这是一个很薄的 Compose screen shell：可选的标题/连接状态栏加上全屏 termlib 终端。它没有 `Activity`、`ComponentActivity`、`ComposeView` 创建、Intent、导航或 Capacitor 注册逻辑。

默认不替 session 所有者关闭连接。只有在 Compose 宿主明确拥有 session 生命周期时，才传 `closeSessionOnDispose = true`；切换原生页面或 tab 时通常应保持 session，由更上层的连接管理器决定何时调用 `session.close()`。由于 0.3.13 没有 emulator 的显式释放方法，宿主更要避免重复创建而不回收引用。

## 当前的 Capacitor 原生承载方式

当前原生 host 负责以下流程：

```text
BridgeConnectBotSSH plugin / BridgeConnectBotSshActivity
        │
        ├─ 创建 BridgeSshTerminalTransport
        │    ├─ writeToSsh -> 现有 SSH PTY 写入
        │    ├─ onSshOutput <- SSH reader 回调
        │    ├─ requestResize -> SSH session.resize
        │    └─ state callbacks -> native page state
        │
        ├─ 创建 BridgeSshTerminalSession(transport)
        └─ ComposeView.setContent {
             BridgeSshTerminalScreen(session)
           }
```

当前由 `BridgeConnectBotSshActivity` 作为原生宿主：

1. Capacitor 插件接收 Host 配置并打开专用的原生 Compose 页面。
2. 页面内完成私钥选择、Host Key 确认、cbssh 认证和 PTY 生命周期；WebView 只保留 Host 配置入口。

无论采用哪一种，`BridgeSshTerminalTransport` 都不应把私钥文本送进 Compose。当前项目已有原生私钥选择/短生命周期句柄逻辑；未来 adapter 应继续让认证留在原生 SSH 层，终端适配层只接收已经建立的 PTY 字节流。

## 与当前项目的关系

- 旧 `BridgeSSHPlugin.java`/sshj 传输路径及 SSHJ 依赖已移除；当前 SSH 入口统一调用 `BridgeConnectBotSSH` 原生页面，密钥格式解析和公钥编码使用 ConnectBot 与项目内原生实现。
- `android/app/build.gradle`、Kotlin/Compose 配置和 `termlib`/`cbssh` 依赖已经接入；Android Debug APK 已成功构建。
- React/Web 页面只负责连接中心中的 SSH Host 配置和打开原生页面；终端输入、输出、滚动和选择由原生 termlib 处理。
- `cbssh` 负责 SSH/PTY，原生 Host 负责私钥、Host Key、连接生命周期和快捷键；tmux session 管理面板仍需下一步接到 command channel。

## 当前编译边界

这两个 `.kt` 文件已经由原生 Activity 使用，依赖 Kotlin Android plugin、Compose compiler、Compose UI 和 `org.connectbot:termlib:0.3.13`。默认入口已经切换到原生页面；APK 构建已通过，但尚未完成 Android 真机和真实 Mac SSH 验收。

这次对精确 artifact 的额外检查得到：`termlib-0.3.13.aar` 的 AAR metadata 声明 `minCompileSdk=37`；其 POM/Gradle metadata 使用 Kotlin stdlib 2.4.20，并带有 Compose UI 1.11.2、Compose runtime 1.11.4 和 Compose BOM 2026.09.00 的运行时依赖。项目配置已按此对齐并完成 APK 编译验证。

剩余必须完成并验证：

1. `BridgeConnectBotSshActivity` 的安装和生命周期验证。
2. 使用 cbssh transport 验证断线、host-key 等待、输入背压和 resize 失败。
3. Android 真机验证：长文本/粘贴、Ctrl/Alt/Shift、功能键、触摸滚动、长按选择复制、软键盘 resize、alternate screen、连续输出及连接关闭。

Android APK 编译已经完成；在真实 Android 设备和 Mac `sshd` 验收完成前，仍不能把 SSH 端到端体验描述为发布完成。

## 本次验证记录

- 已下载并检查 Maven Central 的 `org.connectbot:termlib:0.3.13` AAR、POM、Gradle metadata 和 sources jar。
- 已用 `javap`/源码核对 `TerminalEmulatorFactory.create`、`TerminalEmulator.writeInput`、`TerminalEmulator.resize`、`Terminal` 的 `forcedSize`/`resizeSuspended` 参数，以及 0.3.13 没有 `TerminalEmulator.close()` 的事实。
- `git diff --check` 通过。
- `:app:compileDebugKotlin`、`:app:testDebugUnitTest` 和 `:app:assembleDebug` 已通过；构建使用 AGP 9.4、Gradle 9.6、Kotlin 2.4 和 `compileSdk` minor API 37.2。依赖下载期间使用过本机临时 Maven 代理，构建后已移除代理配置和脚本。
- 当前工作区的 Android 配置和新原生 Host 均为未提交改动，未执行回退或删除。
