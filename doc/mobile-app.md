# Android / iOS App

首版使用 Capacitor 8.5.3，把现有 React 页面构建进手机安装包。App 启动后配置 Bridge 地址并配对，再访问任务、Codex History、tmux 和文件页面。Mac 上的 Bridge、Codex、tmux 和数据库继续在 Mac 上运行，手机不执行本地开发任务。

App 与浏览器的功能差异、已发现风险和分批优化建议见 [App 与浏览器差异化适配评审（2026-10-27）](app-browser-adaptation-review-2026-10-27.md)。该评审针对源码工作区，不等同于已部署版本或真机验收结果。

## 构建与安装

先安装项目依赖，再构建并同步两个原生工程：

```bash
bun install
bun run mobile:doctor
bun run mobile:build
```

`mobile:build` 生成 `dist/mobile` 并执行 Capacitor sync；原有 `bun run build:web` 仍输出 `dist/web`，不会替换已部署网页。只同步已有构建可用 `bun run mobile:sync`。`mobile:doctor` 只读检查工具，不安装 SDK，不启动或重启 Bridge；缺少工具时以非零状态退出。

Android App 会在已配对且回到前台时检查固定 APK 路径 `android/app/build/outputs/apk/debug/app-debug.apk` 的文件指纹；发现重新编译的 APK 后显示更新提示。也可以通过 `FEISHU_CODEX_BRIDGE_ANDROID_APK` 指定其他本机 APK 路径。更新接口需要当前手机的 Bearer 配对凭据；更新提示可以直接交给 Android 安装器，也可以选择下载 APK。已配对后的连接管理页将“App 更新”折叠在连接确认与现有连接操作之后；展开后可用“手动下载 APK”通过系统 DownloadManager 保存到 Downloads，完成后手动安装。未配对时不显示更新入口。

普通 Web 构建会替换为不含原生依赖的浏览器 runtime；App 使用独立构建入口和 runtime。分别构建两者后，运行 `bun run mobile:verify` 检查浏览器产物没有混入原生插件、App 凭据逻辑或 App 专用 viewport 配置。

| 平台 | 构建环境 | 打开工程 | 安装方式 |
| --- | --- | --- | --- |
| iOS 15+ | macOS、完整 Xcode 26+、Apple 签名账号；依赖使用 Swift Package Manager | `bun run mobile:open:ios` | 在 Xcode 选择 App target、Signing & Capabilities 中的 Team 和手机，执行 Run；分发需另行签名、Archive/TestFlight |
| Android 8+（API 26） | JDK 21+、Android SDK Platform 36、platform-tools；建议 Android Studio Otter 2025.2.1+ | `bun run mobile:open:android` | 本地 debug APK 固定生成 `arm64-v8a`；Android Studio Run；或在 `android` 目录执行 `./gradlew assembleDebug`，安装 `app/build/outputs/apk/debug/app-debug.apk` |

JDK 不在默认路径时设置 `JAVA_HOME`；SDK 不在默认目录时设置 `ANDROID_HOME`，或通过 Android Studio 生成被忽略的 `android/local.properties`。首次 Android 构建需要下载 Gradle 和 Maven 依赖，首次 iOS 构建需要解析 Swift packages。

App 名称为 `Bridge`，应用标识为 `dev.feishu.codex.bridge`。正式发布前确认应用标识归属、签名、图标、版本号和隐私披露；当前工程没有配置分发凭据或商店发布任务。`mobile:build` 不是 APK/IPA 构建，不产生已签名安装包。

## 首次连接

1. 启动支持 App 配对接口的当前版本 Bridge，确认手机能访问它。LAN 场景需显式启用 `FEISHU_CODEX_BRIDGE_LAN_BIND=1`；手机填写 Mac 的地址，例如 `http://192.168.1.20:17310`，不能填写手机自己的 `localhost`。
2. 在 Mac 运行 `bun run web:pair`（源码环境）或 `feishu-codex-bridge web:pair`（安装版），确认命令使用的配置和数据库就是目标服务；不要为了配对切换数据库或重启安装版。
3. 在 App 的“配对链接或配对码”输入框粘贴完整链接，App 自动从链接读取服务地址和配对码，不需要重复输入。只有单独配对码时，展开“仅有配对码”确认 Bridge 地址。复制地址时使用 API/统一 Bridge 服务地址；开发环境是 `17310`，Vite 的 `5173` 不是 App 的后端。也可打开“扫描配对二维码”，使用相机识别或“选择本地图片”从相册/文件中识别二维码；图片在手机本地解码，识别到有效内容后再发起配对。
4. 配对后进入原有工作台。在设备管理中撤销手机设备会使该设备的凭据失效，需要重新配对。

推荐 HTTPS；证书必须受手机系统信任。自用 HTTP 连接限局域网、回环、链路本地地址与私有网络地址（含常见 VPN 的 `100.64.0.0/10`）。公网 HTTP 会在连接页被拒绝。LAN HTTP 不提供传输加密，请只在可信网络使用。

App 内置页面，不使用 Capacitor `server.url` 加载远端网页，也不允许远程站点进入具有原生插件权限的主 WebView。网页依旧使用原来的 Cookie 配对；App 使用独立设备 Bearer 凭据并保留服务端的设备撤销机制。终端和事件流使用短期、限定路径的一次性连接票据，长期凭据不放入链接。

## 手机适配与凭据

- App 复用现有 React 页面，增加连接管理、系统返回与前后台恢复；断开浏览器连接或进入后台不会结束 Mac 上的 tmux session。
- App WebView 会在系统原始 User-Agent 后追加 `BridgeApp/0.5.0 (Android)` 或 `BridgeApp/0.5.0 (iOS)`，服务端可据此区分原生 App 与普通浏览器；不包含配对 token。
- 同一配对授权再次访问时会更新 UA（变化时立即更新），设备页显示 App 版本与系统摘要，原始 UA 收入折叠详情；保留用户设置的名称。原生下载沿用 WebView UA，避免系统下载器覆盖设备的 App 标识。设备列表前台每 30 秒及重新聚焦时刷新。
- App 的文件、附件、导出和 APK 下载共用全局下载提示：显示文件名、实际字节进度、完成结果和失败原因，切换页面仍可查看，可收起提示并清除已结束记录。记录保留于本次 App 运行期；App 进程重启后，可从系统下载列表查看 Android 下载结果。没有总大小时显示不确定进度，不把任务入队或收到全部字节当作保存完成。
- Android 文件下载通过系统 DownloadManager 保存到 Downloads，并显示系统下载通知；App 在前台读取系统真实进度，回到前台后立即刷新，只有系统确认完成才提示保存完成并显示实际保存文件名，支持打开系统下载列表。iOS 文件下载到 App 缓存后通过系统分享面板保存或转交其他应用，提示区分下载、保存／分享和取消，不承诺系统面板已经保存成功。Android FileProvider 只公开更新安装所需的缓存 `bridge-downloads/` 子目录。附件选择沿用系统 WebView 的文件选择器。
- Android App 在 1.8 秒内连续两次明显反向晃动会打开环境管理弹窗，两次至少间隔 160 ms，无需停稳；按固定 80 ms 时间窗口判断力度，降低传感器采样频率差异的影响。触发后冷却 1.5 秒，切到后台或传感器中断会清除未完成的计数。同一 Mac 主机的 `5173` 标为开发环境，`7310` 标为稳定环境；已配对环境直接切换，未配对环境进入连接管理重新配对。
- 外部网页通过系统 Browser 插件打开；复制通过原生 Clipboard 插件适配。
- `BridgeCredentials` 自定义插件按服务地址读写凭据：`get({server}) -> {token: string | null}`、`set({server, token})`、`remove({server})`。
- iOS 凭据使用 `WhenUnlockedThisDeviceOnly` Keychain，不进行 iCloud 同步；Android 使用 Keystore 的 AES-GCM 密钥加密，私有 SharedPreferences 中只保存密文，并排除备份和设备迁移。凭据不写入 localStorage。
- Capacitor 原生日志关闭，避免插件参数或结果中的设备凭据进入调试日志。iOS 提供局域网用途说明和有限 ATS 私网异常；Android 开启 LAN 所需的 cleartext，连接页限制 HTTP 目的地址。
- 安全区使用 iOS `env(safe-area-inset-*)` 和 Capacitor Android SystemBars 注入的 `--safe-area-inset-*`。软键盘、横竖屏和终端滚动仍需真机验收。

原生源码在 `android/`、`ios/`。Gradle wrapper、SPM manifest 和自定义插件纳入版本控制；同步后的 Web 资源、构建缓存、个人 SDK 路径、签名文件和本机工程状态由 `.gitignore` 排除。修改前端后重新执行 `mobile:build`，再在 IDE 运行，避免安装包携带旧页面。

## 环境隔离与后端兼容

- 环境按钮切换的是 API；App 始终使用安装包内置页面，不会自动加载 5173 的最新网页或 7310 的旧网页。连接/环境管理显示 App 安装版本、内置页面构建和后端版本。
- 切换前独立验证目标，离线或协议不兼容时保持原环境；缺少/失效的目标凭据才进入配对。有写请求尚未结束时需等待；探测期间禁止新的业务写请求，提交后回到根页，防止旧页面/迟到上传分块使用新后端。
- App 草稿与业务缓存按服务器、安装实例和授权设备隔离。切换环境保留各自草稿；注销或凭据失效清理当前作用域，其他环境与主题保留。浏览器原有按设备隔离的 Task/History 草稿继续使用原作用域。
- 无作用域的旧数据不自动归入新环境，避免同名 session/thread 混用；旧数据暂留到注销/失效清理。新 tmux 草稿和附件保留 7 天。服务端没有设备作用域时不会降级到共用存储键，会提示草稿不能跨重启保存。
- 新后端在已授权的 `/api/auth/status` 返回兼容协议与功能能力。已知不支持的功能显示升级提示并阻止接口调用；旧后端没有能力信息时标为未知，不保证全部功能兼容。过高的最低客户端要求会阻止进入；空/HTML 等错误响应给出可读原因，不显示 JSON 解析器原始异常。

2026-10-28 第一批环境安全改进的相关 128 项测试、前后端类型检查、Web/移动构建、产物隔离检查和 Android debug APK 编译通过；其中原生 API、IndexedDB 使用替身的测试不能代替 Android/iOS 真机验收。具体实施进度和仍未修复的 P1 项见上述差异化适配评审。

## 验证范围

2026-10-27 配对交互优化验证：

- 全量测试 506 项通过、0 失败（88 个文件、4342 个断言）；前后端 TypeScript、Web/App 前端构建、Capacitor sync、`mobile:verify` 与 diff 检查通过。
- 隔离 Chromium 使用生成的二维码和模拟接口，验证完整链接只需一个输入框，链接内地址和配对码优先于旧手动值；单独配对码可配合折叠的地址设置使用。更新入口位于连接确认和现有连接操作之后、在表单外且默认收起。
- 相机不可用时本地图片仍可识别；空白图片、无关二维码与配对码失效均有提示，可重新选择同一图片重试。模拟相机画面可实时识别并自动配对；退出后停止相机轨道。
- 模拟系统图片选择器引发的同步 visibilitychange，扫码页保持存在并能继续配对；图片仍在解码时用系统返回退出，解码结束后不会在后台提交配对。配对码和设备 token 未写入浏览器存储。
- 320/390/1280px 深浅主题无横向溢出，输入框保持 16px。仅重建 App 前端并同步原生工程，没有重新编译 APK/IPA、安装真机或部署服务；相机权限、系统相册和实际 Android/iOS WebView 行为仍需真机验收。

2026-10-25 的开发机验证：

- 完整测试 400 项通过，0 失败；前后端 TypeScript 检查通过。新增测试覆盖手机配对、Bearer/CORS、流票据、设备撤销、HTTP/1 文件请求体、连接切换与 SSE 生命周期；原浏览器鉴权和连接回归通过。
- `build:web`、`mobile:build` 与 `mobile:verify` 通过，Android/iOS 工程同步七个官方插件；iOS plist/Xcode project 结构校验与 Swift 语法解析通过。
- 在临时数据库和 fake tmux 的独立服务上，用 390px Chromium 验证地址拒绝、配对链接、任务页面、终端首帧与恢复连接、Session 文件预览及连接管理；另验证普通浏览器使用 Cookie 配对且没有 App 连接控件。检查了连接页深浅色、16px 输入框和横向溢出。这些是浏览器模拟，不能代替原生 WebView 验收。
- 在隔离布局 fixture 中加载真实样式，模拟四边安全区、键盘缩小视口、视口上移和横屏，检查 tmux 工具栏/Composer 位置、只读/输入模式及普通网页不增加 padding。

工具检查确认 JDK 21、Android SDK Platform 36、platform-tools 和 Android Emulator 可用；本机只有 Xcode Command Line Tools，没有完整 Xcode 或 Android Studio。Android debug APK 已完成编译，但尚未签名发布、安装到真机或验证原生扫码相机、Keychain/Keystore、系统分享和真实手机触摸行为。iOS 尚未编译。当前服务未部署或重启；App 需要连接运行此分支服务端源码的 Bridge。

发布或用于日常工作前，应分别在 Android 与 iPhone 检查：

- [ ] 首次安装、地址校验、配对失败和成功、强制退出后的自动恢复、主动断开与重新配对。
- [ ] Android/iOS 实时扫码、从相册/文件选择二维码图片、相机权限拒绝后的图片替代路径、取消选择和再次识别；系统返回关闭扫码页，配对请求提交中保持等待。
- [ ] 设备撤销同时终止手机现有终端/事件连接，并拒绝后续 API 请求；失效凭据有可理解的提示。
- [ ] 任务列表/详情/续问、History 列表/详情、tmux 初次连接与重连。
- [ ] 只读/终端输入模式、连续输出、上翻历史、1.5 秒长按选择、复制和外链。
- [ ] 附件选择、文件下载/系统分享、Git 变更预览；大文件、取消分享、断网和磁盘空间不足。
- [ ] 刘海/系统栏安全区、横竖屏、软键盘、系统返回键、后台返回和网络切换。
- [ ] HTTPS 信任链与自用 LAN HTTP，iOS 首次局域网授权、拒绝权限后恢复。

首版未接入 APNs/FCM 推送、后台常驻执行、应用商店分发或自动更新。进入后台后由系统管理连接；重新进入前台恢复工作台，不承诺后台 WebSocket 始终存活。

## 官方资料

- [Capacitor 接入与同步](https://capacitorjs.com/docs/getting-started)
- [Capacitor 8 环境要求](https://capacitorjs.com/docs/updating/8-0)
- [Swift Package Manager](https://capacitorjs.com/docs/ios/spm)
- [原生 File Transfer](https://capacitorjs.com/docs/apis/file-transfer)
- [Apple 局域网 ATS 规则](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
