# Android App 架构与风险评审

日期：2026-11-03。

状态：基于当前 checkout 源码和验证证据的评审与整改建议。SSH 与 Web API 融合是现有产品设计；账号、Git、Session 管理、技能、Session 文件及 Composer 附件优先使用配对 Bridge API，符合回退条件时保留 SSH CLI/SFTP。源码、编译和定向测试证据不等同于已安装 APK、真实设备或真实 Mac 的行为证明。

## 范围与结论

- 当前分支为 `feature/capacitor-mobile-app`；评审基于当前 checkout，工作区包含未提交修改，`aefb388` 仅作为最近提交基线，不将提交或源码状态当作已安装 APK 的行为证明。
- Web 工作台和 Android 原生 SSH 是需要长期保留、可以分别迭代的两条使用路径；Web 工作台也是 iPhone 的使用入口。Android 使用 Capacitor + React/Vite 复用 Web 工作台，原生 SSH 使用 Compose、ConnectBot `sshlib` 和 `termlib`。两种实现并存本身不是需要消除的风险。
- 当前 Web tmux 页面通过 xterm 和 Bridge WebSocket 访问 Bridge 主机的 tmux；Android 原生 SSH 直接连接 SSH 主机。旧 React/xterm 直连 SSH 页面和 `BridgeSSH` 传输插件已移除，iOS 也没有相应原生 SSH 插件；不将 Web tmux 能力等同于 iPhone 已实现直接 SSH。
- 原生 SSH 工作区当前保留 API-first 注入；没有新增“DNS 解析必须相同”的门槛。
- `web/src/bridge-global-config.ts` 提供统一的默认 Mac 主机；私有 Bridge 地址在配置时会替换主机，默认 SSH 入口也使用该主机。已保存的 SSH 主机、手动输入、回环和公网 HTTPS 地址仍可能不同，因此这是**默认配置复用**，不是运行时对每条连接的身份绑定。
- 用户选择保留局域网 HTTP。它不提供传输加密；本次不要求证书，也不把保留 HTTP 本身标为待完成的 P0 整改。
- 以下 P1 表示需要优先处理的条件性正确性/可靠性风险；P2 表示维护、分发或待验证风险。本次未发现足以在现有证据下单独认定为已发生攻击或已造成数据丢失的 P0 事件。

## 当前链路

```text
手机 React/WebView
  ├─ 配对 Bridge API → Bearer、Action Token、事件/终端短期票据
  └─ BridgeConnectBotSSH → 原生 Compose / termlib / cbssh
       ├─ SSH 连接：交互式 PTY、终端输入与 Composer 消息发送
       ├─ 账号、Git、Session 管理、技能和文件：Bridge API 优先；可回退时用 SSH CLI/SFTP
       ├─ Composer 附件：Bridge API 分片上传，SSH 校验可读；不可达时可回退 SFTP
       └─ 进程内 BridgeSshAppState 管理会话；前台 Service 提升存活优先级
```

工作区有 Bridge origin 且能取到该 origin 的凭据时，Session 列表、账号/用量、Git 列表/Diff/预览/下载、保存/挂起/恢复/结束、Session 技能发现、Session 文件浏览/预览/上传/下载及 Composer 附件上传优先使用 API。读取请求在网络、鉴权、服务不可用或响应无效等情况下可回退；文件列表遇到旧版服务或被截断时回退 SFTP。文件名含反斜杠时使用 SFTP，以保留 POSIX 字面文件名，避免被 Web 文件 API 当作目录分隔符。写请求一旦可能到达服务端，遇到网络中断、5xx 或无效响应会提示结果未知，不自动重复执行；附件上传仅在开始写入前确认 API 不可用时回退。没有 tmux Session 身份的普通 SSH 文件、附件和技能发现仍用 SSH/SFTP；全局技能 API 不能按该 shell 的 `CODEX_HOME` 精确限定，并可能被项目技能去重遮蔽。原生终端按键与 Composer 消息目前仍经 SSH PTY，不会进入 Web 的 Session 操作历史。

原生 API 和文件请求禁止自动跟随重定向；Session 请求校验 ID 与创建时间，文件读写还绑定首次打开时的根目录。向 Composer 转发 API 文件路径，以及 Composer 的 API 附件上传完成后，都会检查当前 SSH 主机可读。Bridge 对标记为 Android 原生 SSH 的受支持 API 请求记录操作路由、Session ID、HTTP 状态和耗时，不记录 token、查询参数、文件名或内容；日志表示请求结果，不等同于远端进程已执行。上述校验仍不证明 API 和 SSH 指向同一 Mac、同一个 tmux server 或数据库。

## 需优先处理的风险

### P1-1：tmux 切换确认不可靠，当前不能标为已修复

[BridgeSshAppState.kt](../android/app/src/main/java/dev/feishu/codex/bridge/BridgeSshAppState.kt) 在发送 detach 后等待输出匹配 `detached`，匹配则发送下一条 attach；未匹配在约两秒后返回结果未知。但匹配器在获取写锁和发送 detach **之前**已注册，且接收普通终端输出；例如 `job detached successfully` 同样匹配。自定义 tmux prefix、普通程序输出或时序交错可能造成误判；无法确认时也可能发生实际已脱离但 UI 仍保留旧选择。

即使 attach 两次 SSH 写入都返回 `Written`，[BridgeConnectBotSshActivity.kt](../android/app/src/main/java/dev/feishu/codex/bridge/BridgeConnectBotSshActivity.kt) 也会更新所选 Session 和草稿作用域；这还不是 tmux 已成功附着的回执。切换结果不确定时，先查看终端并核对当前 Session，再发送消息。建议后续使用能关联具体 SSH PTY、旧/新 Session 身份的确认机制，分别覆盖成功、超时、误匹配、前缀变更和慢输出；不要只改等待时长。

### P1-2：输入队列有数量上限，但跨操作顺序和失败处理仍有缺口

[BridgeSshAppState.kt](../android/app/src/main/java/dev/feishu/codex/bridge/BridgeSshAppState.kt) 的普通终端输入使用容量 128 的队列；这是**条目数**，不是总字节数限制。Composer 发送和 tmux 切换仍直接竞争同一写锁，不经过这个队列，因此先入队的终端输入未必先于后续 Composer/切换写入。队列满时设置失败并请求重连，但队列消费者在写每个已排队条目前没有再次检查失败状态；旧队列可能在恢复过程关闭旧通道前继续写出。

建议将普通输入、Composer 提交和切换纳入同一有序写入边界，定义失败后的队列处置并明确告知未发送/结果未知；不要自动重放未知结果。大附件不设应用层大小上限，资源保护应采用分块、流控、磁盘空间提示和可恢复清理，不通过缩小既有功能解决。

### P1-3：CLI 回退不再依赖 Bridge 数据库，但降级状态仍有同步边界

Android 仍发送兼容旧版本的 `ssh-session --offline`，但当前 [src/ssh-session-cli.ts](../src/ssh-session-cli.ts) 不再检查、打开或写入 Bridge SQLite，也不再调用 `lsof`。Git 直接复用 tmux/Git 逻辑；账号标记读取和更新 tmux 的 `CODEX_HOME`，用量查询走 Codex app-server。Git 优先使用 App 随 Session 身份传来的逻辑工作目录，旧 App 未传目录时使用当前 pane 工作目录。兼容参数 `--db` 和 `FEISHU_CODEX_BRIDGE_SSH_DB` 仍可传入，但不影响降级执行。

降级保存/挂起使用 tmux-resurrect 的独立 `bridge-ssh-fallback` 快照目录和按 Session 记录的文件元数据，不覆盖 Web 快照；读取和恢复仍校验 Session ID 与创建时间。Bridge API 再次可用且看到相同快照目录时，Web 和 Android 可以列出并通过 API 恢复这些快照；通过 API 恢复会重新关联已有的 Session 数据。恢复结果不确定时禁止自动重试。降级期间直接通过 CLI 恢复、终结或更改账号标记不会写入 Web 数据库：Web 历史/状态和账号标记可能需要重新核对；API 不可达时 CLI 也无法列出只存在于 Web 数据库中的旧挂起记录。若 SSH 与 Bridge 使用不同快照目录，Web 无法自动看到该降级快照，但 Android SSH 列表会合并 CLI 的快照。

API 写请求可能已被服务端处理，但响应在网络中丢失；当前客户端对此提示结果未知，并停止自动 CLI/SFTP 重试，避免重复操作。文件锁遇到异常退出后可能残留，需先确认没有其他操作再处理锁文件；现有保护没有实现跨重启的通用幂等协议。仍需覆盖目标切换、真实网络中断及不同安装实例。

### P1-4：API、SSH 与数据库目标可能不一致

默认 Web 和 SSH 的主机来自同一配置，但 SSH 可选其他已保存主机，Bridge origin 也可能是不同地址/环境。当前业务 API 使用配对 Bridge，回退与交互式终端使用当前 SSH 目标；Session 的 ID/创建时间、文件根目录和附件可读校验可以拒绝部分不匹配，不能建立机器或数据库同一性的证明。只有当用户实际选择了不同目标，且相关标识恰好匹配时，才可能产生跨目标读取或写入；目前没有本轮真实误操作证据。

建议先把当前 Bridge 环境、SSH 目标和 CLI 使用的数据库作用域展示清楚，并补齐不同主机、同主机不同 Bridge 实例、不同 tmux server 的契约测试。保持 API-first 与 CLI 回退；不要仅靠 IP 相等、DNS 解析或移除其中一路来声称身份一致。

### P1-5：下载边界只验证了初始请求

[BridgeUpdaterPlugin.java](../android/app/src/main/java/dev/feishu/codex/bridge/BridgeUpdaterPlugin.java) 对普通 Android 系统下载比较传入 URL、传入 origin 和本机该 origin 保存的 token。它没有独立读取 Web 当前选中的环境，也没有在此代码中限制请求路径；请求随后交给系统 DownloadManager，当前代码没有对重定向目标执行二次检查。因此不能把它描述为“只允许当前环境的固定更新路径”或“已证明所有下载不会跨 origin 重定向”。

APK 更新是另一条链路：Web 先校验更新 URL/摘要，FileTransfer 设置 `disableRedirects: true`，原生侧检查文件大小、摘要、包名、版本及签名摘要的交集，系统安装器仍有最终签名与安装判断。签名轮换、多签、重定向和原生环境隔离尚需设备/针对性测试，不能仅凭 mocked Web 测试宣称完整通过。

## 其他风险与已有保护

- **后台生命周期（P2/验收项）：** `BridgeSshAppState` 在进程内持有已建立会话，Activity 退出视图不等于断开；Service 提供前台通知。异常 `onDestroy` 会尝试重新申请 Service，但系统可拒绝后台启动，失败后有警告；`START_NOT_STICKY` 和进程死亡后失去内存凭据仍成立。已有 instrumentation 测试覆盖部分 Activity/文件选择器生命周期；系统回收、厂商省电和真机网络切换需另验收。
- **凭据和 Host Key：** Bridge token 与已保存 SSH 私钥使用 Android Keystore 包装；首次/变化的 SSH Host Key 需要确认，自动重连对未知/变化密钥失败关闭。WebView 可调用凭据插件，属于高信任边界；保留打包页面、外链隔离与日志脱敏，并测试实际导航路径。
- **Web 与 Android 原生两条路径的维护边界：** 两边都可独立增加功能、适配不同平台，不以收敛成一种实现或删除依赖为目标。需要明确各入口的传输方式和支持范围，并分别验证鉴权、终端交互、文件和重连；可按实际需求共享业务规则或配置，但不以强制共用核心作为前提。
- **全局原生弹框挂载与 Activity 膨胀（P2/维护风险）：** App 更新提醒需要同时覆盖 Capacitor WebView 和原生 SSH `ComposeView`，因此由顶级 Activity 作为窗口级挂载点是合理的；它能保证两个页面只显示一个原生 Material 弹框，也避免 SSH 工作区打开/关闭时重复创建提醒。风险不在“挂到 Activity”本身，而在继续把更新状态、下载业务、按钮动作、Compose UI、View 层级和销毁清理全部写入已经承担 SSH transport、tmux/Session、文件选择器、Composer 与宿主生命周期的 `BridgeConnectBotSshActivity`，后续每增加一个全局能力都会扩大耦合、重建竞态和测试范围。

  当前更新弹框已使用单一原生 `BridgeAppUpdateBanner` 作为展示层；Activity 只额外挂载一个顶层 `ComposeView`，插件转发状态和动作，App 安装包内置页面仍是现有更新检查/下载状态机的协调者，浏览器页面不再渲染第二套提醒 UI。该范围暂不构成新的 P1 功能风险，但 Activity 中已有的 overlay 状态、创建/移除、置顶和 `onDestroy` 清理应视为待抽取的维护边界。

  建议拆成以下职责，保持顶级 Activity 只做窗口和生命周期托管：

  ```text
  BridgeConnectBotSshActivity / MainActivity
      └─ BridgeAppUpdateOverlayController
          ├─ 创建、更新、移除顶层 ComposeView
          ├─ 处理 WebView/SSH 工作区切换时的 z-order
          ├─ 转发 install / download / dismiss 动作
          └─ BridgeAppUpdateBanner（纯 Compose UI）
  ```

  `BridgeAppUpdateOverlayController` 不应判断版本、处理 snooze、下载 APK 或验证签名；这些仍由现有 App 更新协调层和原生更新插件负责，避免在 Controller 与 WebView 之间再复制一套状态机。若未来要求更新检查完全脱离内置页面，再单独评估原生 `BridgeAppUpdateCoordinator`，迁移期间不能同时保留两套状态来源。

  该拆分的验收门槛包括：Activity 重建、WebView reload、SSH 工作区打开/隐藏/关闭以及回前台后最多存在一个弹框；弹框外区域不阻断 WebView 或 SSH 输入；忙碌、进度、失败、稍后和安装器取消状态能继续回传；插件 listener 失效或 Activity 销毁时不残留 ComposeView；手动下载入口、APK 摘要/签名校验和服务器作用域保持不变。源码编译和定向测试不能替代 Android 真机对层级、触摸和前后台生命周期的验收。
- **存储和文件（P2）：** 分享收件箱、本机草稿附件和远端附件的持久副本需要空间不足、孤儿文件及清理策略；不得静默删除用户保留的数据。大附件继续采用流式处理，任何新增硬上限或会影响现有功能的清理策略须单独确认。SSH 文件浏览已有路径、类型和符号链接检查，但并发替换及异常断链仍需针对性验证。
- **构建与发布（P2）：** 开发 APK 固定 `arm64-v8a`，更新源默认是 debug APK；正式签名、跨设备 ABI、版本与分发策略仍需单独建立。`android/variables.gradle` 使用 compile SDK 37.2，而 `mobile:doctor` 仍检查 Platform 36；doctor 通过不能证明 Android 构建所需 SDK 已齐全。

## 后续建议顺序

1. 在保留 SSH + API-first + 无 Bridge 数据库的 CLI/SFTP fallback 前提下，继续验证降级状态与 Web 的同步边界、目标切换和真实网络中断；区分 API 请求日志与 SSH PTY 提交的操作历史。
2. 处理 tmux 目标确认与输入队列顺序/失败边界；明确“写入成功”和“远端已执行”。
3. 在不移除能力的前提下检查下载 origin、系统重定向、签名兼容和本地空间清理。
4. 先将顶层更新弹框的 View 挂载、z-order 和销毁逻辑抽到独立 `BridgeAppUpdateOverlayController`，Activity 只保留生命周期委托；在此之前不继续向 Activity 增加同类全局弹框状态。
5. 分别验证 Web/iPhone、Android 原生、真实 Mac `sshd`/tmux/Codex、弱网、软键盘、前后台和进程死亡；需要时评估可共享的业务规则及正式分发。

## 验证记录与边界

- 2026-11-03：Android 定向 JVM 测试 32 项通过、1 项跳过；跳过项需要独立 SSH fixture。覆盖 API 路由、结果未知、文件/附件传输、字面反斜杠和 SFTP 回退，本地 HTTP fixture 覆盖分块、截断下载及拒绝重定向。
- 2026-11-03：后端相关测试 30 项通过；逻辑工作目录和 API 恢复相关的 6 项再次通过。使用临时目录、fake tmux 或隔离 tmux socket，验证数据库不存在/占用、快照隔离、最后一个 Session 恢复、API 重新关联记录和锁冲突；未连接用户主库或用户 tmux。前后端 TypeScript 检查及完整源码构建通过；编译后的 portable CLI 入口也在无 Bridge 数据库的临时 Git fixture 中通过。
- 2026-11-03：更新提醒改为单一原生 Activity 顶层 Material 弹框，Web 不再渲染重复提醒；Web 定向更新/连接测试 8 项通过，前后端 TypeScript、`build:web`、Android debug 主代码和 Android UI 测试源码编译通过。本轮未重建或安装 APK，也未执行 Android instrumentation、真机触摸、Activity 重建或前后台验收，因此 overlay 层级和生命周期仍属于待验收边界。
- 使用模拟 HTTP API 的浏览器夹具，在移动视口检查并点击 Web 的“SSH 快照”恢复入口，确认请求携带快照来源和 Session 创建时间。该夹具未连接实际 WebSocket，不代表真实服务、iPhone 或 Android 真机验收。
- 本次仅对匹配表达式做了最小示例验证：普通文本 `job detached successfully` 也能匹配；未用真实 tmux 执行误切换。
