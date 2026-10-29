# App 与浏览器差异化适配评审

评审日期：2026-10-27。范围：当前 `feature/capacitor-mobile-app` 分支，基线提交 `0acfd26`，包含尚未提交的工作区实现，**不等同于已安装 APK 或 7310 部署版本**。

本次沿路由、平台适配层、鉴权、缓存、文件传输及原生工程检查 App 相关调用链；这是面向 App 产品化的横向评审，不是全部后端代码的逐行安全审计。只整理问题与方案，不在本次评审中实施业务修复、提交代码或启停服务。

## 实施进度（2026-10-29）

以下问题描述保留 2026-10-27 的评审原状；后续实施情况以本节为准。第一批已在当前工作区落地，尚未代表真机验收或稳定服务部署。

| 条目 | 进度 | 本批结果与边界 |
| --- | --- | --- |
| APP-01 原子环境切换 | 源码及自动化验证完成 | 使用独立地址/凭据探测，失败保持旧环境；有写请求未结束时拒绝切换，探测期间阻止新写请求。提交切换后封住旧页面请求并回到根页，迟到的上传分块不会发送到新后端；旧草稿在 pagehide 仍写回旧作用域。 |
| APP-02 缓存/草稿隔离 | 本文列出的主要业务存储已接入 | App 以服务器 origin + 服务端安装实例/设备作用域隔离 tmux 文本/附件、History 详情/Home、任务续问、JSON 离线缓存、技能缓存与 JJ 选择。注销/失效清理当前作用域，保留其他环境和主题；异步附件操作及 GET 响应有作用域检查。浏览器已有安全的 Task/History 草稿作用域保留，避免升级时丢失已隔离草稿。 |
| APP-03 兼容协商 | 基础协议及降级提示完成 | 已授权 `/api/auth/status` 附带后端版本、协议要求及实际可用能力；未知新协议/过高最低版本拒绝进入。已知不支持的页面不挂载，接口不发出；旧版缺少能力信息时在连接/环境管理提示未知，不冒充完整兼容。展示 App 安装版本、内置前端构建和后端版本；空/HTML/404 响应转为可读错误，正常 204 删除成功仍可处理。 |
| APP-04 更新状态 | 第二批源码完成，待真机验收 | 根据系统已安装 versionCode 判断新版；按服务器记录 available/downloading/downloaded/installer-opened/installed/error，安装器打开不视为安装成功。“稍后”暂缓 30 分钟；首次连接旧包也提示新版，回前台重新比较实际安装版本，保留已校验包供重试。 |
| APP-05 更新文件验证 | 第二批核心链路完成，分发策略待定 | 服务端流式复制为 SHA-256 命名的不可变快照；安装和手动下载共用严格同源、版本路径检查，原生侧流式校验大小、摘要、包名、versionCode/versionName，并拒绝降级，校验后才安装或写入 Downloads。Android 构建号加锁递增并防时钟回退，versionName/UA/前端版本使用 package.json；正式签名、跨开发机/渠道版本号分配与发布留存仍待制定。 |
| APP-06 Demo 外开授权 | 第二批源码及 HTTP 验证完成，待系统浏览器验收 | App 换取 60 秒一次性票据，浏览器兑换限定单个 Demo 的 HttpOnly Cookie（8 小时），随后跳转到无票据 URL。不能访问管理接口、日志或其他 Demo，原 App 授权撤销后失效；Bearer 不进入 URL，也不进入代理上游。 |
| APP-07 返回与弹层 | 第三批主要入口完成，待真机验收 | 统一按可见层级消费一次返回，覆盖环境、扫码、终端详情、文件/图片预览、History 工具、用量/重置确认、任务/项目/快捷键表单与设备确认。忙碌确认阻止穿透，关闭后恢复可用焦点；异步预览关闭时取消旧请求，迟到结果不重新打开。系统键盘与根页最小化仍需真实 Android 验收。 |
| APP-09 前后台契约 | 第三批核心实现完成 | JJ、History、任务列表/详情、用量、通知收件箱及设备读取接入前台/在线调度，回前台补拉并保留增量游标；旧环境停止调度。App 后台不再发起新的业务写请求/上传分块，Downloads 前台上传中断后需手动核对并重试。未实现原生后台上传或杀进程后恢复本地 File 的能力。 |
| APP-10 下载恢复 | 第三批元数据与原生控制完成，待真机验收 | 已收到入队回执的系统下载 ID、文件名、字节数与状态按服务器/设备作用域保存，重启后重新查系统结果；提供取消、完成后打开及回原页面重试说明。元数据不保存 URL/Bearer，7 天有效，恢复最多 200 条；切换保留各环境，注销清除当前记录，系统下载和公共文件由用户在系统中管理。 |
| APP-11 大 Blob 导出 | 第三批先补大小边界 | 原生 Blob 导出超过 8 MiB 时在整文件 Base64 转换前拒绝，提示使用文件页流式下载或减少日志；通用原生 URI 分块导出仍待后续实施。 |
| APP-12 扫码依赖 | 第三批清理完成，权限需真机验收 | 保留实际使用的网页实时扫码、本地图片及拍照识别；删除无 UI 调用的原生扫码函数、依赖及 Android/iOS 工程引用，剩 6 个官方插件。相机拒绝、占用和缺失分别提示恢复方式；权限拒绝后的系统行为仍待验收。 |
| APP-13 文件能力降级 | 第三批主要入口完成 | App 图片使用保存入口，图片预览不再依赖 ClipboardItem 或显示复制图片按钮；PDF 明确使用授权下载及系统打开/分享，浏览器继续 iframe。原生下载完成后可按系统 ID 打开文件，缺少查看应用或文件被移除时返回可读原因。 |
| APP-14 / APP-16 | 14 仍需专项真机回归；16 设置完成 | 保留现有终端输出、触摸滚动与安全区实现；增加摇一摇开关及启用时的运动权限申请/拒绝提示，保留手动环境入口。没有实测硬件采样、软键盘、端点拖动或 iOS 权限表现。 |
| APP-08 / APP-15 / APP-17 | 待推进 | 原生通知与后台推送、系统 Deep Link 注册、HTTPS/权限及正式签名分发尚未在第三批实施。APP-05 的正式更新渠道与跨构建机版本分配也仍待完善。 |

迁移策略：无作用域的旧 tmux 草稿、旧 History 详情、旧离线缓存等**不自动读取或归入某一环境**，防止误发送；旧数据暂留，注销/收到失效状态时清理。旧后端如没有提供有效设备作用域，保留当前编辑内存但禁用业务草稿持久化，并明确提示升级，不能退回所有环境共享一个默认 key。新 tmux 草稿/附件有效期为 7 天。

第一批验证：20 个相关测试文件共 **128 项通过、0 失败、2211 次断言**，包含真实 App runtime（仅原生凭据替身）的延迟探测/失败/并发写请求场景、隔离存储 fixture、临时 DB 的 HTTP/WS/SSE 鉴权以及原浏览器上传/缓存回归。前后端 TypeScript、Web 构建、移动构建、`mobile:verify` 及 Android `assembleDebug` 已通过，debug APK 已更新到原固定路径。存储 fixture 不是浏览器 IndexedDB 端到端测试，原生替身不代替手机系统权限验证；7310 兼容性、手机触摸与实际安装结果仍待验收。未部署、未操作 7310、未提交或推送。

第二批（2026-10-28）验证：更新状态、APK 快照、原生传输替身、环境切换、能力协议、Demo 限定授权及 App HTTP 鉴权共 8 个测试文件 **40 项通过**。Web/移动构建、Capacitor 同步、产物隔离检查及前后端 TypeScript 通过；前端以 Bun 执行时触发 60 秒上限取消，改用 Node 执行同一 TypeScript 编译器后在上限内通过。Android 原生校验插件及 debug APK 编译通过，使用实际产物核对了包名、versionCode/versionName 与更新元数据，并验证了摘要快照。原生校验的真实系统行为、安装取消/拒绝权限、干净手机浏览器仍需真机验收；正式签名、更新渠道与跨构建机版本管理仍待实施。第二批代码尚未提交或部署。

第三批（2026-10-29）验证：20 个相关测试文件 **123 项通过、0 失败、2104 次断言**，涵盖返回层级、后台/离线暂停与恢复、旧响应、下载元数据跨重启/跨作用域隔离、原生下载控制替身、导出限制、传感器拒绝及前两批鉴权/更新回归。前后端 TypeScript、Web/移动构建、Capacitor 同步、产物隔离与 Android debug 编译通过。浏览器自动化初始化超时；纯逻辑、原生替身和编译证据不代替真实返回键/键盘、杀进程后 DownloadManager、文件查看器、相机或手势验收。本批未安装手机、部署 7310 或提交代码。

第三批调试包：`android/app/build/outputs/apk/debug/app-debug.apk`，包名 `dev.feishu.codex.bridge`，versionName `0.5.0`，versionCode `87582968`，大小 5,493,212 字节；已核对包内前端与本次移动构建一致。这是 debug 构建，不代表正式签名分发版本。

## 1. 结论与边界

现有“共享 React 业务页面 + 独立移动构建 + 原生能力适配”的方向可以保留，不需要重写一套原生业务 UI。需要分别处理的是身份、环境、设备能力和生命周期，而不只是窄屏样式。

优先处理六项 P1：环境切换的原子性、跨环境缓存隔离、前后端版本兼容、APK 更新状态、更新文件验证、Demo 外开后的鉴权。它们比继续增加动效或原生按钮更影响日常可靠性。

证据标记：

- **源码确认**：已定位实际实现；风险推演不代表已经在生产或手机上复现。
- **待真机验证**：依赖 WebView、操作系统、权限、网络或硬件，单元测试不能下结论。
- **产品建议**：现状未必是缺陷，但需要明确两端体验和承诺。

### 当前 App 与两个环境的真实关系

| 使用方式 | 页面从哪里来 | API 从哪里来 | 身份与存储 |
| --- | --- | --- | --- |
| 浏览器打开 5173 | 当前 Vite 前端 | Vite 代理到 17310 | 浏览器 Cookie；浏览器存储按网页 origin 隔离 |
| 浏览器打开 7310 | 该服务部署的网页 | 7310 | 浏览器 Cookie；与 5173 的网页存储隔离 |
| App 选择开发环境 5173 | APK/IPA 内置的 `dist/mobile` | 5173 代理到 17310 | 原生 Bearer；页面始终处于 App 本地 origin |
| App 选择稳定环境 7310 | **仍是同一份内置页面** | 7310 | 按服务器保存 Bearer；并不会自动隔离全部 Web 存储 |

因此，在 App 中切换到 5173 **不会自动加载刚修改的网页代码**，切到 7310 也**不会变成 7310 自带的旧界面**。目前属于切换 API，不是网页热更新。内置前端变更仍需重新构建安装包；只改后端逻辑则可以由目标后端生效。

此外，端口不同不代表数据库不同。当前项目允许开发服务使用正式主库；测试环境隔离必须核实实际 DB 和执行器，不能直接拿真实 5173/7310 数据做破坏性实验。

依据：[Capacitor 配置](../capacitor.config.ts)、[移动构建配置](../web/vite.mobile.config.ts)、[Web 构建配置](../web/vite.config.ts)、[连接与环境界面](../web/src/MobileConnectionGate.tsx)。

## 2. 全功能适配清单

下表“应优化”是后续建议，不表示本次已经实现。

| 功能域 | 浏览器应保留 | App 应优化或区别处理 | 当前判断 / 关联项 |
| --- | --- | --- | --- |
| 首次连接、扫码配对 | 当前站点 Cookie 配对；地址来自网页 | 保存多服务器身份；相机/相册权限、取消与重试；不要把 localhost 当成 Mac | 已有基础；APP-12、17 |
| 登录、设备管理、撤销 | Cookie、Action Token、同源校验 | Keychain/Keystore Bearer；失效后清理该设备敏感缓存；UA 只做展示 | 身份分离已做；APP-02 |
| 环境切换 | 通过 URL/标签页切换网页与后端 | 原子切换 API、清理旧连接、保留对应环境草稿；显示三个版本 | APP-01、02、03 |
| 任务面板、详情、续问 | 共享业务接口、列表及表单 | 断网只读状态、返回后增量刷新；发送前锁定目标环境；不重复提交 | APP-01、02、09 |
| Codex History、模型与账号用量 | 保留 Home 和 thread 的业务语义 | 环境隔离详情缓存及偏好；大历史按需渲染；缓存须明确陈旧 | APP-02、03、09 |
| tmux 输出及终端输入 | 鼠标选择、键盘快捷键、外链新页 | 手势滚动、1.5 秒选择、IME、安全区、前台重连；默认只读不变 | 已有专项实现；APP-14 |
| Composer 草稿和附件 | 页面刷新后恢复草稿 | 草稿、附件按环境/设备/session 隔离；键盘和进程回收恢复 | APP-02、09、14 |
| Session 文件、Git 变更、任务附件 | 浏览器预览和下载 | 统一下载代理；原生保存/分享；图片复制和 PDF 降级；路径仍指向 Mac | 下载适配已有；APP-10、11、13 |
| 上传下载工具、链接解析 | 浏览器选择文件、页面内进度 | 明确前台上传与系统后台下载差别；重启后恢复下载记录 | APP-09、10、11 |
| Demo | 新标签页，保留当前工作页 | 在无插件权限的浏览器中打开，并解决独立鉴权；不能直接加载进主 WebView | APP-06 |
| 终端/Markdown/普通外链 | 新标签页及安全协议过滤 | 站内路由、认证下载、远端网页分流；返回 App 保留现场 | 已有包装；APP-06、13、15 |
| 通知 | 站内提示 + 用户授权的 Web Notification | 原生本地通知；后台完成提醒需要额外推送链路，不靠常驻 WebSocket | APP-08 |
| 系统管理、项目、技能、自动化、机器 | 共享业务逻辑和服务端校验 | 清楚标明“操作的是 Mac/服务器”，不能让手机路径误当服务器路径 | 业务复用；APP-03、14 |
| Git 工作区、JJ 工具 | 共享远端操作和日志 | 后台暂停轮询，回前台补拉；危险操作确认目标环境/仓库 | APP-01、09 |
| 运行状态、备份和恢复 | 继续使用服务器端生命周期 | 区分“重启后端”和“退出 App”；恢复前提示连接可能中断，失败后可重连 | 业务复用；APP-03、09 |
| 系统返回、弹窗 | 浏览器历史、Esc、关闭按钮 | Android 返回先关顶层弹窗，再退路由，根页最小化 | APP-07 |
| 摇一摇、手动系统入口 | 浏览器不启用硬件触发 | 两次晃动、防误触、可关闭、始终保留手动入口 | APP-16 |
| 软件更新 | 刷新网页即可更新前端 | 比较安装版本，校验文件，明确下载/安装状态；不是网页刷新 | APP-03、04、05 |
| HTTPS、LAN、权限 | 浏览器自己的证书与权限环境 | WebView 与原生下载都要验证；相机、局域网、安装权限分别提示 | APP-17 |
| 主题、布局、无障碍 | 桌面信息密度、键盘可达性 | 安全区、横屏、16px 输入、触控尺寸、焦点及读屏 | APP-07、14 |
| 调试、日志导出、分发 | Web 版本和接口诊断 | 增加 App/前端/后端版本与网络层；导出前脱敏；签名与 ABI 单独管理 | APP-03、17 |

### 已有且应保留的适配

- Web 和 App 使用不同 runtime，正常 Web 构建不应打入原生插件与 App 凭据逻辑。
- 主 WebView 加载本地受信任资源，不使用远端 `server.url` 装载可调用原生插件的网页。
- 浏览器 Cookie、App Bearer 和设备撤销分离；写操作保留 Action Token 与来源校验，实时连接使用短期一次性票据。
- App 已有统一下载入口、真实系统下载进度、前后台恢复查询；iOS 分享取消也有单独提示，不能再把“请求入队”当作完成。
- tmux 已有隐藏时断开 attach、回前台强制重连；事件流已做后台暂停和重新获取票据，不能把旧版本的“没有恢复逻辑”当成本次新问题。
- 原生文本复制、外链 Browser、设备 UA 简化显示、安全区和终端 viewport 均已有实现。
- 本地 Android debug APK 已限制 `arm64-v8a`，不要再次把未删 ABI 当成现存问题。

以上是源码实现状态，不代表原生能力全部完成真机验收。主要依据：[移动 runtime](../web/src/mobile-runtime.ts)、[原生适配](../web/src/mobile-native.ts)、[事件流](../web/src/mobile-stream.ts)、[终端](../web/src/TmuxDashboard.tsx)、[设备管理](../web/src/DeviceAuthorizations.tsx)、[Android 构建](../android/app/build.gradle)。

## 3. P1：先处理正确性与身份边界

### APP-01 环境切换先修改全局连接，再校验目标

**源码确认。** [mobile-runtime.ts](../web/src/mobile-runtime.ts) 的 `switchMobileConnection()` 先执行 `connection = { server, token }`，随后才请求目标 `/api/auth/status`；失败再回滚。`createMobileFetch` 会使用该全局连接。

在最长 12 秒的校验窗口，旧页面的轮询、发送或分块上传可能被路由到目标服务器。已有“丢弃旧连接响应”防护不能撤销已经发出的写请求。这里确认的是竞态窗口，未对真实环境发起并发写操作复现。

建议：用显式目标地址与凭据独立探测，成功后一次性提交连接；切换期间冻结新写操作，确认/等待正在发送的任务，终止旧轮询和流。缺少凭据、凭据失效、目标离线分别提示，不把所有失败都引向重新配对。

验收：延迟目标探测，同时触发旧页面写请求，提交切换前不得写入目标；探测失败保持旧环境；快速连续切换不能由较早探测结果覆盖最终选择；上传跨切换不得把后续分块发到另一台服务器。

### APP-02 多处缓存和草稿没有服务器/设备作用域

**源码确认。** App 所有环境共用本地页面 origin，不能依赖浏览器的跨端口存储隔离：

| 存储 | 当前键/范围 | 风险 |
| --- | --- | --- |
| tmux 文本及 IndexedDB 附件 | 只按 sessionId / attachmentId | 同名 session 可能恢复另一环境的草稿或附件 |
| History 详情 | homeId + threadId | 同 ID 时可能先显示另一环境缓存的会话内容 |
| 通用 GET 离线缓存 | 请求 URL，常见为相对 `/api/...` | 切换后离线或服务失败，可能回退到旧环境内容 |
| 任务详情续问草稿 | source + taskId | 同业务 ID 在其他实例出现时可能复用旧文本 |
| 部分界面偏好 | Home、JJ 选中运行等全局 key | 偏好指向另一环境不存在的对象 |

依据：[tmux-draft-store.ts](../web/src/tmux-draft-store.ts)、[CodexHistory.tsx](../web/src/CodexHistory.tsx)、[connection-state.ts](../web/src/connection-state.ts)、[TaskDetailPage.tsx](../web/src/TaskDetailPage.tsx)、[JjTools.tsx](../web/src/JjTools.tsx)。

现有 [local-draft-cleanup.ts](../web/src/local-draft-cleanup.ts) 未覆盖全部上述存储；`forgetMobileCredential()` 删除原生凭据，也没有统一清理这些敏感缓存。即使两个端口当前共用 DB，连接到其他 Mac 或撤销后换设备身份时仍然需要隔离。

建议：业务数据键统一为“规范化服务器 origin + 安装实例 ID + 授权设备作用域 + 资源 ID”；主题等纯 UI 偏好可以继续全局共享。复用已有 Task Create 的作用域设计；为旧无作用域键安排清理迁移，不能静默猜测其归属。分别定义切换保留、主动断开清理、撤销清理和容量/TTL 策略。

验收：两个临时实例故意使用相同 session/thread/task ID；切换、离线、撤销、重新配对后均不串草稿、附件或历史。所有实验使用隔离 DB 与 fixture，不碰生产任务。

### APP-03 内置前端与所选后端没有统一兼容协商

**源码确认 + 产品边界。** 环境按钮仅改变 API 地址并 reload 本地页面；当前环境文案“实时查看最新改动”容易被理解成网页热更新。现有更新接口描述 APK 文件，不是业务 API 的能力协商。

依据：[MobileConnectionGate.tsx](../web/src/MobileConnectionGate.tsx) 的 `buildEnvironmentOptions()` / `selectEnvironment()`、[移动入口](../web/src/mobile-entry.tsx)、[移动构建](../web/vite.mobile.config.ts)。

建议：建立轻量能力响应，至少返回实例 ID、后端版本、支持的功能及最低客户端要求。界面区分“App 安装版本 / 内置前端构建 / 当前后端版本”，明确“切后端不会切网页版本”。不支持的 API 禁用入口并说明升级方向；404/非 JSON/空响应要转换为可读兼容错误，不能直接展示 `Unexpected end of JSON input`。

不要为了获得旧版网页而让远程页面进入有原生插件权限的主 WebView。如果确实需要查看旧界面，通过独立、无插件权限的浏览器打开。

验收：当前 App 分别连接新后端与精简旧版 fixture；缺少更新、文件、上传或管理接口时可降级；不能以“7310 返回 200”证明兼容。7310 的真实版本兼容性本轮未验证。

### APP-04 更新提醒混淆“见过、下载、安装成功”

**源码确认。** [MobileConnectionGate.tsx](../web/src/MobileConnectionGate.tsx) 使用一个全局 `MOBILE_APK_REVISION_KEY`：首次检查直接记为基线；点击稍后、下载请求成功入队、打开安装器后，都会记下相同 revision。

结果可能是：旧 App 首次连接不提示已有新版；取消安装或下载失败后，同一版不再主动提醒。调用安装器成功并不表示用户完成安装；此处问题在更新提醒状态，不是否定下载管理器已有的真实完成状态。

建议：将 `available / downloading / downloaded / installer-opened / installed` 分开；“稍后”只设置提醒截止时间；按更新渠道隔离状态。读取实际已安装版本，回前台后重新比较；安装是否成功不能靠启动安装器的 Promise 判断。

验收：新安装旧包、取消安装、下载中断、拒绝未知来源权限、点稍后再回来、跨环境检查，均能正确重试且不会提示“已更新”。

### APP-05 更新链路缺少客户端文件验证和一致的目标校验

**源码确认。** 当前存在三个独立缺口：

1. [mobile-runtime.ts](../web/src/mobile-runtime.ts) 的手动下载校验同源和固定下载路径；`installMobileApkUpdate()` 直接拼接服务端返回的 `downloadUrl`，没有同等校验，之后会将 Bearer 交给原生下载。正常服务当前返回固定相对路径；这是异常响应下的防御缺口，不是已发现 token 外泄。
2. [web.ts](../src/web.ts) 计算并返回 SHA-256/size，随后下载读取可被下一次构建覆盖的固定 APK；客户端 [mobile-native.ts](../web/src/mobile-native.ts) 没有对下载文件校验这两个字段，也没有确认包名/预期版本。
3. [build.gradle](../android/app/build.gradle) 的 versionCode 按构建分钟生成；同分钟重编译可能同版本号，时钟回退也不能保证递增。App UA 版本另在 [capacitor.config.ts](../capacitor.config.ts) 固定，缺少单一版本来源。

建议：安装/手动下载共用严格同源路径检查；发布不可变的 revision 文件，按 revision 下载，校验 SHA-256、大小、包名、版本后再调用系统安装器。版本号、前端 build ID、UA 使用统一生成来源；维护开发/稳定更新渠道和正式签名策略。

Android 系统安装器仍有自己的 APK/签名检查，不能把以上缺口描述成“任意未签名文件均可安装”。之前缓存 URI/FileProvider 的修复不是本轮重新确认的未修复问题。

验收：跨域 URL、错误 hash、截断文件、构建时替换 APK、错误包名、降级包和用户取消都得到明确结果；下载完成不直接写“安装成功”。

### APP-06 Demo 外开浏览器后没有自动继承 App 身份

**源码确认 + 待运行时验证。** [DemoCatalog.tsx](../web/src/DemoCatalog.tsx) 在 App 中通过 `openBridgeExternal(bridgeUrl(demo.openPath))` 打开；[mobile-native.ts](../web/src/mobile-native.ts) 使用 Browser 插件。该浏览器上下文不能假定拥有 WebView 的 Bearer，而 Demo 代理/入口可能需要网页 Cookie。

因此“App 已配对，点 Demo 却要求认证或打不开”是需要验证的真实边界；如果系统浏览器以前已经配对过，可能暂时掩盖问题。本轮未在干净系统浏览器复现。

建议：允许用户明确选择独立浏览器配对；若需要无感衔接，设计限定 Demo/路径、短时、一次性的外开授权交换，不传长期 Bearer 到 URL、不公开 Demo。外部站点不获得原生插件权限。

验收：系统浏览器从未配对时也有清晰闭环；票据过期/重放/换路径失败；正常浏览器继续新页打开，App 返回后仍保留原工作现场。

## 4. P2：原生交互、后台行为与体验

### APP-07 返回键和弹窗缺少统一优先级

**源码确认。** Android 原生返回先派发 `MOBILE_BACK_EVENT`，没有消费就 history back 或最小化。当前只有 [MobilePairingScanner.tsx](../web/src/MobilePairingScanner.tsx) 注册消费；[环境弹窗](../web/src/MobileConnectionGate.tsx) 是 React `role="dialog"`，不是操作系统原生弹窗，也未接同一返回处理。

建议统一顶层弹窗注册和焦点恢复，顺序为“系统键盘实际行为 → 顶层弹窗/预览 → 路由返回 → 根页最小化”。浏览器保持 Esc 和返回历史；危险确认不可因返回触发默认提交。用户所说“系统弹窗”若指真正原生选择框，应单独确认交互方案。

验收：环境选择、图片预览、扫码、文件对话框与键盘分别测试；一次返回只关闭最上层，不离开正在编辑的页面。键盘优先级必须真机确认。

### APP-08 系统通知仍主要是 Web Notification

**源码确认。** [Workbench.tsx](../web/src/Workbench.tsx)、[SystemSettings.tsx](../web/src/SystemSettings.tsx)、[upload-manager.tsx](../web/src/upload-manager.tsx) 调用浏览器 `Notification`；尚无完整原生本地通知/远程推送适配。

浏览器可以保留当前授权与站内提示。App 应按能力显示原生通知设置，拒绝权限仍保留站内结果；不要出现“不支持浏览器通知”却让用户以为整个 App 无法通知。真正后台任务完成通知需要服务器事件、APNs/FCM 或回前台补拉，不应承诺后台 WebSocket 常驻。

验收：授权/拒绝、前台/后台/杀进程、点击通知跳转对应环境和任务、跨设备重复通知去重。

### APP-09 上传与普通轮询没有完整的 App 后台契约

**源码确认 + 产品建议。** 终端与 SSE 已处理生命周期，但 [JjTools.tsx](../web/src/JjTools.tsx)、[CodexHistory.tsx](../web/src/CodexHistory.tsx) 等仍有各自定时刷新；不能把 Web 定时器节流视为统一的原生后台策略。[upload-manager.tsx](../web/src/upload-manager.tsx) 的任务和 File 在 React 内存中，卸载会取消，也没有完整的进程重启任务恢复。

建议：共享 `foreground / online / activeEnvironment` 调度，后台暂停不必要轮询，回前台重取版本并增量补拉。明确当前上传属于前台任务；如果要承诺后台上传，再实现原生后台传输、持久任务 ID 与安全的文件访问授权。服务器分块接口存在，不等于客户端已具备杀进程恢复。

验收：短暂后台、系统回收、断网、换 Wi-Fi、切环境后不重复发送；上传失败能解释原因，不能显示虚假“后台继续中”。

### APP-10 下载任务只在本次进程中可追踪

**源码确认。** [mobile-download-manager.ts](../web/src/mobile-download-manager.ts) 保存内存任务和系统下载 ID；Android DownloadManager 可能继续执行，但重启 App 后没有恢复这些任务的业务上下文。这是体验缺口，现有文档已经说明，不是系统下载一定失败。

建议：持久化最小任务信息（原生 ID、文件名、环境标识、时间、状态），不落长期 token；回前台/重启查询系统结果。补充取消、重试、完成后打开文件、容量/网络错误和过期记录清理。下载器重定向时的鉴权头行为需专项验证；不能把尚未验证的行为直接定性为凭据泄露。

验收：入队后杀进程，重启能找到正确任务；并发同名文件、未知长度、磁盘满、系统取消分别正确展示；撤销/退出对未完成任务的策略明确，已保存公共文件不能承诺远程擦除。

### APP-11 Blob 导出走整文件 Base64，需限制大文件场景

**源码确认。** [mobile-native.ts](../web/src/mobile-native.ts) 的 `shareBlob()` 把 Blob 转为完整 Base64，再跨插件传递；[BridgeUpdaterPlugin.java](../android/app/src/main/java/dev/feishu/codex/bridge/BridgeUpdaterPlugin.java) 再解码为完整 byte 数组。JS 字符串、桥接和原生数组会带来额外内存副本，低内存设备的大导出存在风险，未实测崩溃。

建议：小型诊断日志可以保留但设置边界；大文件优先服务器 URL 流式下载或原生缓存 URI 转存，避免主线程整文件转换。统一正确 MIME、文件名、取消/进度及清理策略。

验收：小日志、大图片、大文本和大归档在低内存手机测试峰值内存、响应和失败恢复；不把图片/文本一律标成 octet-stream 后就认为完成打开体验。

### APP-12 网页扫码已使用，原生扫码依赖仍保留

**源码确认。** 当前连接页使用 [MobilePairingScanner.tsx](../web/src/MobilePairingScanner.tsx) → [PairingScanner.tsx](../web/src/PairingScanner.tsx) 的网页相机和图片识别；`scanMobilePairingQr()` → `scanPairingQr()` 的原生插件路径仍存在，但本次调用点检索未发现界面调用。原生 barcode-scanner 依赖仍会进入工程。

建议二选一：App 以原生扫码为主、共享图片识别作降级；或保留网页扫码，确认全调用链后移除未用原生依赖。不要同时承担两套体积却只验证一套。先测 APK 各部分体积再量化收益，不直接声称删插件必减 30 MB。

App 权限文案应能区分“尚未授权 / 已拒绝 / 需去系统设置 / 相机占用”；浏览器保留站点权限指引。验收覆盖暗光、横竖屏、拒绝、相册取消、返回键和再次打开。是否使用原生相机不改变二维码内容的地址和配对校验。

### APP-13 图片复制、PDF 与文件打开不能只靠浏览器能力

**源码确认 + 待真机验证。** [TmuxSessionFiles.tsx](../web/src/TmuxSessionFiles.tsx) 的图片复制使用 ClipboardItem，失败会回退复制文件名；[LinkTools.tsx](../web/src/LinkTools.tsx) 使用 iframe 预览 PDF。WebView 对这些能力的实际支持不能由桌面浏览器推定。

建议：App 提供“保存图片 / 分享图片”，不能把复制文件名提示为复制图片成功；PDF 无法内嵌时提供原生查看/下载；认证媒体继续使用 [BridgeMedia.tsx](../web/src/BridgeMedia.tsx) 的授权加载，不能简单替换成无 Bearer 的远端 img 链接。

验收：图片复制返回内容正确；PDF、文本、图片、APK 与未知文件类型都有可用降级；外部查看器不获得长期凭据。

### APP-14 触摸、IME 与安全区必须保留独立真机验收

**已有实现 + 待真机验证。** [mobile-terminal-viewport.ts](../web/src/mobile-terminal-viewport.ts)、[terminal-touch.ts](../web/src/terminal-touch.ts)、[styles.css](../web/src/styles.css)、[mobile-app.css](../web/src/mobile-app.css) 已做适配，但媒体查询、固定工具栏、安全区及 WebView 键盘的组合仍需回归。

浏览器保留鼠标/键盘选择；App 重点覆盖只读/输入模式、中文组合输入、换行、软键盘反复开关、横屏、小屏/平板、底部手势区、长按端点拖动与外链。新输出不能把上翻用户拉回底部，触摸滚动不发送远端 tmux scroll。

终端输出链路已有因滚动回归而回退的历史约束；不要借本轮 App 适配重新引入未经真机验证的输出替换方案。验收需记录 buffer 类型、baseY/viewportY、尺寸和输出范围，而不是只看截图。

### APP-15 已有 deep-link 解析，不等于已接入系统唤起

**源码确认。** [mobile-connection.ts](../web/src/mobile-connection.ts) 可解析 `bridgecodex://connect`，但当前 [AndroidManifest.xml](../android/app/src/main/AndroidManifest.xml)、[iOS Info.plist](../ios/App/App/Info.plist) 未登记对应系统 URL scheme，原生生命周期中也未发现 `appUrlOpen` 处理。

建议：如需要“浏览器点链接直接打开 App 配对”，补齐系统注册、冷/热启动分发和用户确认；否则文案仅承诺复制粘贴/扫码，不承诺可唤起。所有入口复用同一地址校验，不自动执行链接携带的管理操作。

验收：未安装、冷启动、已运行、重复链接、错误协议/恶意地址、过期配对码；配对码不得进入持久 URL 历史或调试导出。

### APP-16 摇一摇只能是快捷入口，不能是唯一入口

**源码确认 + 待真机验证。** 当前 [mobile-shake.ts](../web/src/mobile-shake.ts) 已调整为固定时间窗口和两次明显反向晃动，有模拟不同采样频率的测试；[mobile-native.ts](../web/src/mobile-native.ts) 实际依赖 WebView DeviceMotion，不是原生 SensorManager/CoreMotion，也没有完整跨平台权限申请流程。

建议：保留系统管理里的手动连接/环境入口，提供关闭或灵敏度设置；相机等关键流程避免误触；Android 用真实设备采样校准，iOS 未验证前不承诺同等可用。环境弹窗当前是网页弹层，是否改原生见 APP-07。

验收：拿起手机、走路、打字不误触；连续自然晃动可触发；后台不触发；拒绝权限/无传感器时手动入口可用。单元测试通过只能证明输入轨迹下的算法行为。

### APP-17 HTTPS、权限、诊断与分发按平台建立发布门槛

**配置确认 + 待真机验证。** [iOS Info.plist](../ios/App/App/Info.plist) 已配置局域网说明、`NSAllowsLocalNetworking` 和私网 CIDR 例外；[AndroidManifest.xml](../android/app/src/main/AndroidManifest.xml) 允许 LAN cleartext；JS 拒绝公网 HTTP。iOS CIDR 配置不能简单判定为“无效”：Apple 官方文档明确支持 iOS 17 起在 NSExceptionDomains 使用 IP/CIDR；项目宣称支持的更早 iOS 版本需分别验证。[Apple ATS 例外规则](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)、[Apple 本地网络规则](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)。

建议：

- 分别测试 fetch、WS/SSE、原生文件传输、系统下载器的证书信任和错误提示；不要靠忽略证书错误解决自签证书问题。LAN HTTP 有意保留，但明确未加密且只用于可信网络。
- 相机、局域网、存储、通知、未知来源安装按用途与系统版本申请，拒绝后仍可继续其他功能；旧 Android 存储权限分支需专项检查，不为单个保存操作泛化申请全部权限。
- 诊断显示当前环境、后端可达性和三个版本；导出前清除 Authorization、Cookie、Action Token、stream ticket 与配对码，区分 WebView 请求失败和原生传输失败。
- 建立正式签名与版本递增、更新渠道、ABI/依赖体积检查；arm64 本地 APK 策略不自动等同于完整分发方案。尚未完成 iOS 编译/真机测试时不要标为 iOS 可发布。

验收：LAN/VPN/IPv6、受信任/不受信任证书、权限拒绝、网络不可达与 API 不兼容有不同提示；发布前 Android、iOS 各自过关。该项对当前 Android 优化是 P2，对首次 iOS/正式分发则是发布阻断项。

## 5. 建议的平台边界

平台判断集中在现有 runtime，不在每个业务页面散落 UA 正则。UA 仅用于设备展示/日志，不用于授权，也不能作为唯一能力判断。

| 层 | 负责内容 | 不应承担 |
| --- | --- | --- |
| 共享页面与业务 API | 任务、History、tmux、文件与管理业务；请求/错误语义 | 直接操作插件或自行拼接 token 下载 URL |
| 客户端上下文 | 当前服务器、实例/设备作用域、版本能力、切换状态 | 用全局可变服务器隐式改写未确认的业务写操作 |
| 平台能力适配 | 下载/分享、外开、复制、通知、返回、生命周期、权限 | 根据 UA 放宽后端鉴权 |
| 原生插件 | 系统能力、最小权限、安全存储、传输和文件校验 | 执行任意 URL/文件路径或默认信任所有前端参数 |
| Bridge 后端 | 授权、来源校验、票据、资源权限、兼容能力、不可变更新文件 | 假定来自 App 的请求天然可信 |

优先扩展已有 `mobile-runtime.ts` / `mobile-runtime.browser.ts`，不为这份清单先建立庞大重构框架。浏览器继续正常工作应是每一阶段的验收条件。

## 6. 分批实施顺序

1. **环境与身份正确性**：APP-01、02、03。先补实例/设备作用域与能力协议，再收拢切换流程；同时补并发写入和离线缓存测试。
2. **更新与外开闭环**：APP-04、05、06。把升级从“提示一个新文件”变成可重试、可校验的状态机，解决干净浏览器打开 Demo 的身份边界。
3. **日常 Android 体验**：APP-07、09、10、12、13、14、16。先返回键、恢复、下载与扫码，再做手势校准；逐项保留真机证据。
4. **通知、后台及正式分发**：APP-08、11、15、17。后台上传/远程推送按实际需求另立范围，不在 UI 上先承诺；iOS 单独安排完整构建和真机验收。

任务、账号用量、项目管理、备份等服务器业务应继续复用，不需要仅因为运行在 App 就重写算法或维护另一套数据表。需要变化的是目标环境确认、原生交互、错误恢复和展示密度。

## 7. 验收矩阵与本轮证据

### 必测场景

| 维度 | 浏览器 | Android App | iOS App |
| --- | --- | --- | --- |
| 身份/环境 | 两个网页 origin、Cookie 失效 | 两个临时后端、同 ID 数据、撤销、重配对 | 同 Android，加 Keychain 和冷启动 |
| 文件 | 下载、上传、预览、复制 | 系统下载、进程重启、安装取消、磁盘满 | 原生传输、保存/分享取消、PDF 降级 |
| 终端 | 鼠标选择、快捷键、resize | 中文 IME、触摸滚动、后台重连、安全区 | 同 Android，加 Safari/WKWebView 差异 |
| 生命周期 | 多标签页、隐藏/恢复、离线 | 后台、系统回收、切网、返回键 | 后台、系统回收、局域网权限 |
| 版本/网络 | 旧 API、空/HTML 错误响应 | 旧 APK、新后端、旧后端、HTTPS/HTTP | 支持的 iOS 版本、ATS 与证书 |

### 本轮实际执行

已按当前工作区检查主要路由和上述平台调用链；运行以下单元测试，**50 项通过、0 失败、419 次断言**：

```bash
bun test tests/mobile-connection.test.ts tests/mobile-stream.test.ts \
  tests/mobile-download-manager.test.ts tests/mobile-native-download.test.ts \
  tests/mobile-shake.test.ts tests/device-user-agent.test.ts \
  tests/mobile-terminal-viewport.test.ts
```

覆盖：URL/凭据边界、旧请求响应隔离、文件请求体、SSE 票据生命周期、下载进度和完成/取消语义、UA 展示、晃动轨迹及终端 viewport。原生下载测试使用替身，不是操作系统下载器端到端验证。

**未执行**：本报告所提问题的修复、全量测试、真实 7310 兼容测试、真实数据故障注入、Android/iOS 真机全流程、iOS 编译、正式签名分发。尤其 APP-01 并发切换、APP-02 跨实例缓存、APP-04 安装结果及 APP-06 干净浏览器鉴权，不能用上述 50 项测试代替专门验收。

相关文档：[App 构建与连接](mobile-app.md)、[此前项目级风险评审](session-review-2026-10-22.md)、[浏览器冒烟清单](browser-smoke-checklist.md)。历史文档结论需以当前源码复核，不应直接当作当前缺陷清单。
