# ConnectBot SSH Android 技术决策

状态：Android 首版切换到 ConnectBot 模块；以下按当前源码更新，iOS SSH 仍仅有决策记录。

## 选择

- Android 原生层使用 `BridgeConnectBotSSH` Capacitor 插件和 `BridgeConnectBotSshActivity`。Web 工作台继续独立维护，也供 iPhone 使用；Web 与 Android 原生两边均可按需求增加功能。旧 React/xterm SSH 页面、`BridgeSSH` 传输插件和 SSHJ 依赖均已移除。
- SSH/PTY 传输切换到 ConnectBot `cbssh` `org.connectbot.sshlib:sshlib:0.5.0`；终端模拟和触摸交互切换到 `org.connectbot:termlib:0.3.13`。
- `termlib` 是原生 Compose/libvterm 组件，宿主负责 SSH/PTY 字节流、resize 和生命周期；cbssh 负责连接、认证、PTY、背压和 shell。
- SSH 连接、终端、保活任务和当前 tmux 选择由 Android App 进程内的全局会话状态管理；多个主机可分别保留连接，离开或重建原生页面只解除界面绑定，明确断开时才关闭对应连接。临时 exec/SFTP 通道结束不会自动关闭连接；每 30 秒优先发送 SSH ping，不支持时使用当前 PTY 尺寸的窗口请求，连接或终端中断后由 App 级会话以退避方式自动重连，保留终端和草稿；新交互式 shell 建立后按 Session ID 与创建时间恢复仍存在的 tmux 目标。连接或会话活动期间启动带系统通知的 Android 前台服务，页面切换和照片选择只解除或暂停界面，不关闭连接；最后一个连接结束后停止服务。系统强制停止进程、网络变化或设备省电限制仍可能中断连接，不自动重发输入。
- 登录成功后先进入交互式 zsh shell，用户点击 tmux 才打开 Session 列表；列表查询、文件操作和终端交互复用同一个已认证 SSH 连接，切换 tmux Session 不重新执行 SSH 握手或认证。
- 首次进入 Session 时，当前交互式 zsh shell 执行 attach；已经 attach 时先发送 tmux detach 控制序列，并等待终端输出匹配 `detached` 后再把目标 attach 命令写回同一个 shell。当前文本匹配不能可靠区分普通程序输出，也没有确认新 Session 实际附着；若发生误匹配，attach 命令仍可能进入旧 pane。详情及待验证场景见 [Android App 架构与风险评审](../doc/android-app-architecture-review-2026-11-02.md)。
- 原生 Composer 的诊断记录由 App 全局持有并在私有存储中保留，可跨页面、会话重连和进程重建；停止时直接复制，另保留文件导出。日志仅记录白名单生命周期、网络、心跳和错误类别等元数据，不写终端文本或凭据。
- 连接中断后 App 级会话在前台或后台重试，工作区的“重连”直接重试当前连接；主机指纹变化须在界面确认。密码、临时私钥和口令仅保存在活动会话内存供重连使用，显式断开时清空，不写入主机配置或日志；已保存私钥按需从设备密钥库读取。进程被终止后内存凭据不再存在，只有已保存私钥可在重新打开工作区时自动认证。
- 系统文件选择器是临时 UI 交接，不应触发健康 SSH 会话的列表刷新、重连或断开；若进程因系统回收重建，工作区会优先恢复最近使用且已保存私钥的主机，并以私有存储中的 Session ID 与创建时间核对上次 tmux 目标。
- 原生 Composer 的横向快捷键和附件滚动区显式避开 Android system gesture inset，并保留左右内容边距；系统边缘滑动不能抢占 Composer 的横向滚动。
- `cbssh`/`termlib` 要求 Kotlin 2.4 metadata 和 Android API 37；当前工程使用 AGP 9.4、Gradle 9.6，并显式声明 `compileSdk` minor API 37.2。
- 不新增 SSH 中转服务或第二套 tmux 服务。当前工作区持有配对 Bridge origin 时，账号/用量、Git、Session 管理、Session 技能、Session 文件和 Composer 附件优先使用 Bridge API 的 Bearer 与 Action Token；可安全回退时使用目标机 `ssh-session` CLI 或 SFTP。没有 Session 的普通 SSH shell 继续通过 SSH/SFTP 发现技能和访问文件。Session 请求携带 ID 和创建时间，文件页绑定根目录，API 附件完成后确认 SSH 主机可读。可能已执行的 API 写入发生响应丢失时报告结果未知，不自动重试。终端输入和 Composer 消息仍通过 SSH PTY，不产生 Web Session 操作历史。服务端对原生 SSH API 记录脱敏请求路由、Session ID、状态和耗时；默认主机配置共享不构成对所有自选 SSH 主机、Bridge 实例或数据库的身份校验。
- `ssh-session` 降级不检查或访问 Bridge SQLite；Git、tmux、Codex app-server 和独立的 tmux-resurrect 快照文件分别提供对应功能。降级快照与 Web 快照隔离，API 恢复且能访问相同快照目录时，两端可查看并通过 API 恢复并重新关联原 Session；Android 同时合并 CLI 快照以兼容旧服务或不同目录。纯 CLI 恢复、终结和账号标记不写 Web 数据库，可能需要在 Web 重新核对；API 不可用时也无法列出只记录在 Web 数据库中的旧挂起 Session。
- 私钥通过 `BridgeConnectBotSshActivity` 内的 Android `ACTION_OPEN_DOCUMENT` 原生选择器导入，私钥文本和口令不进入 React/Capacitor JSON bridge。
- 私钥最多读取 256 KiB；临时选择的私钥仅保存在活动 App 会话内存中以支持重连，显式断开时清空，已保存私钥的明文仅在每次认证时短暂解密并清空。支持 OpenSSH legacy PEM、OpenSSH new-format 和 PKCS#8；PuTTY 明确返回不支持。
- 私钥口令在新的原生 Activity 内输入；私钥明文、URI、路径和 SSH 异常原文不得进入 WebView、日志或错误消息。生成密钥的密文可进入 App 私有 SharedPreferences，但只能由 Android Keystore 中的包装密钥解密。
- 加密私钥的缺少/错误 passphrase 映射为不泄露内容的错误码。
- 原生配置页借鉴 ConnectBot 的公钥工作流，提供 Ed25519 / RSA 3072 keygen：私钥使用兼容 cbssh 的 PKCS#8 PEM，公钥输出为 `authorized_keys` 单行并支持复制；生成密钥的加密副本由 App 私有存储和 Android Keystore 保存。
- cbssh 0.5.0 是独立 SSH 库；ConnectBot 应用的 `oss` 变体及其 Conscrypt 不随它自动引入。Bridge 的 Ed25519 密钥生成和 JCA 签名/验签使用 cbssh 已依赖的 Tink；SSH 公钥编码使用 cbssh 公开接口，Ed25519 DER 编解码复用其内部读写器，升级 cbssh 时须复测新旧密钥。RSA 使用 Android 默认 JCA provider 的 CRT、SHA-256 和 SHA-512 实现，不再注册额外 RSA provider。
- 主题不再作为 SSH 页面临时参数传递；Web `ThemeProvider` 通过 `BridgeNativeTheme` 同步解析后的明/暗主题到原生 SharedPreferences，所有后续原生活动从同一全局配置读取。

## Native key boundary

```text
React/Capacitor: openNativeTerminal({ host, port, username, password?, startupCommand? })
Android native: ACTION_OPEN_DOCUMENT -> char[] -> cbssh authenticatePublicKey()
Android native: passphrase and Host Key prompt stay in BridgeConnectBotSshActivity
```

`privateKey` 不再是 Web/Capacitor 参数。原生选择器只接受可读文件，读取上限为 256 KiB；`PuTTY` 文件不转换，直接返回不支持。
- PTY 使用 `xterm-256color`；SSH 原始字节直接进入 termlib/libvterm，不再经过 React/Capacitor Base64 输出事件或每次按键的 WebView 消息。
- 建立连接时，未知或已变化的 Host Key 必须等待明确确认；确认后的指纹按 host 与 port 保存在 Android 私有 SharedPreferences 中。连接建立后释放页面确认回调，若后续密钥交换出现变化则拒绝，并由用户重新连接确认。

## 不在本轮实现

- Android 的 SSH 主入口使用连接中心中的原生 SSH 工作区；SSH CLI 和 Bridge 服务端已有相关实现，不能再表述为“未修改服务端”。
- 不实现 Room 级别的完整 ConnectBot 密钥数据库或 Mosh；生成或主动导入的无口令 SSH 密钥通过 `BridgeSshKeyStore` 持久化，记录/密文在 App 私有 SharedPreferences，AES 包装密钥在 Android Keystore，使用时才解密到 Activity 内存。带口令私钥可选择用于当前连接，暂不支持保存。
- tmux 选择器通过同一 SSH 连接上的临时 exec 通道读取现有会话；首次选择在当前交互式 shell 中发送 attach，已附加时先 detach 再 attach，连接本身不随 Session 切换重建。新建会话及窗口切换仍可通过终端或 Composer 操作。
- iOS 方案暂不选型落地。未来需在当前 iOS 15 Capacitor 工程中单独验证 SwiftTerm + Citadel/SwiftNIO SSH 的依赖解析、Host Key、Keychain、PTY、前后台和真机行为，不能把 Android 插件实现视为 iOS 兼容证明。

## 依赖风险边界

cbssh 的官方兼容性测试覆盖 OpenSSH、AsyncSSH 和 Dropbear，但当前 Bridge 仍需使用真实 Mac `sshd` 验证私钥认证、首次/变化 Host Key、tmux attach、resize、长文本输入、触摸滚动、长按复制、断线与前后台恢复；JVM 单元测试和 APK 构建不能替代这些验证。
