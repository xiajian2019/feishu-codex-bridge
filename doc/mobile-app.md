# Android / iOS App

首版使用 Capacitor 8.5.3，把现有 React 页面构建进手机安装包。App 启动后配置 Bridge 地址并配对，再访问任务、Codex History、tmux 和文件页面。Mac 上的 Bridge、Codex、tmux 和数据库继续在 Mac 上运行，手机不执行本地开发任务。

App 与浏览器的功能差异、已发现风险和分批优化建议见 [App 与浏览器差异化适配评审（2026-10-27）](app-browser-adaptation-review-2026-10-27.md)。该评审针对源码工作区，不等同于已部署版本或真机验收结果。

当前 Android App 的整体架构、风险分级和整改顺序见 [Android App 架构与风险评审（2026-11-02）](android-app-architecture-review-2026-11-02.md)。该文档是实施建议和验收门槛，不代表风险已经修复。

Web 工作台和 Android/iOS 原生 SSH 是长期并存的使用路径，三者均可独立增加功能。当前 Web tmux 经 Bridge WebSocket 访问 Bridge 主机，原生 SSH 经手机直连 SSH 主机；Web tmux 与原生 SSH 不是同一条传输链路。

内置单配置 OpenVPN 的可行性、包体目标和实施计划见 [手机 App 内置 OpenVPN 评估](mobile-openvpn-feasibility-2026-11-01.md)；当前仅为方案，尚未实现。

## 构建与安装

先安装项目依赖，再构建并同步两个原生工程：

```bash
bun install
bun run mobile:doctor
bun run mobile:build
```

`mobile:build` 生成 `dist/mobile` 并执行 Capacitor sync；原有 `bun run build:web` 仍输出 `dist/web`，不会替换已部署网页。只同步已有构建可用 `bun run mobile:sync`。`mobile:doctor` 只读检查工具，不安装 SDK，不启动或重启 Bridge；缺少工具时以非零状态退出。

首次或网络受限时解析 iOS SwiftPM 依赖，可使用 `HTTP_PROXY` / `HTTPS_PROXY`（也接受小写变量）：

```bash
HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 bun run mobile:ios:resolve
```

脚本会把已提供的代理变量同步为大小写两套后传给 `xcodebuild`；不保存代理地址，也不会覆盖 `CapApp-SPM/Package.swift`。SwiftPM/Git 是否完全使用代理仍取决于本机 Xcode/SwiftPM 版本和网络环境。

Android App 在配对后及回前台时比较更新包与实际安装的 versionCode；首次连接旧版本也会提示，点击“稍后”暂缓 30 分钟。已下载、打开安装器和已安装分别记录，取消安装或拒绝安装权限后仍可重试。更新状态按服务器隔离。已配对且 Bridge 可访问时，即使停留在原生 SSH 工作区也会检查更新并在顶部提供更新、下载和稍后操作；未配对或 Bridge 不可访问时无法从该来源检查或下载。环境切换弹窗的 App 区域提供“检查更新”和“手动下载 App”；主动检查会重新显示已暂缓的新版本，手动下载也支持当前版本。原连接维护中的下载入口继续保留。

服务端读取 `android/app/build/outputs/apk/debug/app-debug.apk` 及同目录 Gradle 生成的 `output-metadata.json`；可用 `FEISHU_CODEX_BRIDGE_ANDROID_APK` 指定其他构建输出。首次检查时流式复制为同目录 `.bridge-updates/<SHA-256>.apk` 快照，返回带摘要的下载路径，源 APK 的字节替换不会改变该快照。但当前目录仍属于构建输出，本轮观察到重打包回收旧快照，跨构建持久留存仍待迁至独立目录；不能承诺旧 revision 一直可用。自定义路径必须同时提供对应构建元数据。更新接口始终要求 App Bearer。安装和“手动下载 APK”均先下载至缓存，原生侧校验大小、SHA-256、包名、预期版本和签名摘要交集，拒绝降级后才打开安装器或流式写入系统 Downloads；系统安装器仍负责最终签名兼容判断与安装确认。APK 传输禁用重定向并需要保持 App 在前台；普通文件仍使用系统 DownloadManager，入队前校验初始 URL、origin 与本机对应凭据，其重定向目标尚未完成专项验证。

旧版本若在下载 100% 后提示“更新校验信息无效”，原因是原生桥接把 Integer 数值误读为 Long；本轮已统一读取正安全整数，不取消任何更新校验。旧二进制本身无法由下载的新 APK 自动修正，需手动覆盖安装本次修复包一次；不要先卸载或清空数据。

Android 构建通过 `scripts/mobile-version.mjs` 分配构建号，使用被忽略的 `android/.bridge-version.json` 与既有 APK 输出记录防止同秒重编译/时钟回退复用编号。版本名称与 UA 从 `package.json` 读取；跨开发机编号、正式渠道及签名策略另行制定。

普通 Web 构建会替换为不含原生依赖的浏览器 runtime；App 使用独立构建入口和 runtime。分别构建两者后，运行 `bun run mobile:verify` 检查浏览器产物没有混入原生插件、App 凭据逻辑或 App 专用 viewport 配置。

| 平台 | 构建环境 | 打开工程 | 安装方式 |
| --- | --- | --- | --- |
| iOS 15+ | macOS、完整 Xcode 26+、Apple 签名账号；依赖使用 Swift Package Manager | `bun run mobile:open:ios` | 在 Xcode 选择 App target、Signing & Capabilities 中的 Team 和手机，执行 Run；分发需另行签名、Archive/TestFlight |
| Android 8+（API 26） | JDK 21+、Android SDK compile SDK 37.2、platform-tools；Android target SDK 为 36 | `bun run mobile:open:android` | 本机打包：`bun run mobile:android:build`，实际逻辑位于项目 `scripts/build-apk.mjs`；生成固定为 `arm64-v8a` 的 debug APK，不会自动安装。APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk` |

JDK 不在默认路径时设置 `JAVA_HOME`；SDK 不在默认目录时设置 `ANDROID_HOME`，或通过 Android Studio 生成被忽略的 `android/local.properties`。首次 Android 构建需要下载 Gradle 和 Maven 依赖，首次 iOS 构建需要解析 Swift packages。当前 `mobile:doctor` 仍检查 Platform 36，不会确认 compile SDK 37.2 已安装；以实际 Gradle 构建为准。

`App` 与 `AppVpn` 都使用同一个 Bridge App 身份，Bundle ID 均为 `dev.feishu.codex.bridge`。默认 `App` 已包含系统 OpenVPN 隧道和原有的 App 内 VPN 实验入口；`AppVpn` 保留为兼容的旧构建入口。正式发布前确认应用标识归属、签名、图标、版本号、第三方许可和隐私披露；当前工程没有配置分发凭据或商店发布任务。`mobile:build` 不是 APK/IPA 构建，不产生已签名安装包。

### App 管理与分发

Web 端新增“系统管理 → App 管理”（`/system-management/apps`），一个 App 记录可以只配置 iOS、只配置 Android，或同时配置两端。已有 `ios_testflight_apps` 记录会自动迁移为 iOS-only App；旧的 `/system-management/testflight` 页面和 `/api/mobile/testflight/*` 接口继续保留兼容。

- iOS 卡片保留 TestFlight 构建/上传和 Processing/内部群组状态；如果 Mac 发现已配对、解锁、开发者模式可用且 USB 直连的 iPhone/iPad，会额外提供“构建并 USB 安装”。该动作只构建并安装选定 App，不替换原 `mobile:ios:install` 的 Bridge 专用自动续签流程。
- Android 卡片读取配置的 APK 与 `output-metadata.json`，沿用不可变快照、包名、版本、大小和 SHA-256 校验，提供会话保护的 APK 下载地址。它不替代 Bridge 自身的 Android 更新检查、缓存校验、系统安装器和手机环境窗口入口。
- App 管理页面只负责按 App 聚合发布与下载动作；原有 iOS OTA 仍在系统设置/iPhone 页面，通用“上传下载”仍在原页面，避免把不同数据源的文件下载混成 App 发布包。

### iOS TestFlight 上传

iOS 签名使用运行命令的进程环境中的 Apple Team ID，不在工程中写死。先在当前 shell 设置 `BRIDGE_IOS_DEVELOPMENT_TEAM`；通过 Bridge 服务触发构建时，需在该服务的环境中设置相同变量。直接调用 `xcodebuild` 时可传入 `"DEVELOPMENT_TEAM=$BRIDGE_IOS_DEVELOPMENT_TEAM"`。不要将个人 Team ID、签名私钥或描述文件提交到仓库。

```bash
export BRIDGE_IOS_DEVELOPMENT_TEAM="<10 位 Apple Team ID>"
```

TestFlight 需要付费 Apple Developer Program 团队、App Store Connect 中已创建的 iOS App 记录，以及与工程一致的 Bundle ID。首次上传前在 App Store Connect 创建 App，选择 `dev.feishu.codex.bridge`；脚本不会代替创建 App 记录、接受 Apple 协议或填写出口合规信息。

脚本默认使用 `App` scheme 的 `PersonalRelease` 配置，先构建当前 checkout 的移动端资源，再归档、签名并上传到 App Store Connect。当前 App 包含分享扩展和 `BridgePacketTunnel.appex`，主 App 与扩展必须使用同一个具备对应能力的付费团队；免费 Personal Team 只能用于有限的本机开发安装，不能作为这条 TestFlight 分发链路的签名依据。

```bash
# 只检查 Xcode、Team、Bundle ID 和当前版本，不构建或上传
bun run mobile:ios:testflight -- --check

# 首次上传；当前工程默认版本为 1.0，构建号为 1
bun run mobile:ios:testflight -- --build-number 1 --internal-only

# 后续上传必须使用新的构建号
bun run mobile:ios:testflight -- --build-number 2 --internal-only
```

默认允许 Xcode 自动更新签名配置；只使用已有描述文件时加 `--no-provisioning-updates`。如果前端资源已经构建并同步，可加 `--skip-mobile-build`。只归档或使用已有归档重试上传：

```bash
bun run mobile:ios:testflight -- --build-number 3 --archive-only
bun run mobile:ios:testflight -- --upload-only --archive-path 'ios/App/build/testflight/Bridge-<时间>.xcarchive' --internal-only
```

也可以通过环境变量给 `xcodebuild` 提供 App Store Connect API Key；脚本只传递路径、Key ID 和 Issuer ID，不读取或保存 `.p8` 内容：

```bash
APP_STORE_CONNECT_API_KEY_PATH=/private/keys/AuthKey_ABC123.p8 \
APP_STORE_CONNECT_API_KEY_ID=ABC123 \
APP_STORE_CONNECT_API_ISSUER_ID=00000000-0000-0000-0000-000000000000 \
bun run mobile:ios:testflight -- --build-number 4 --internal-only
```

上传命令成功只表示 Apple 已接收交付，仍需在 App Store Connect → TestFlight 等待 Processing 完成，处理可能出现的 Export Compliance，然后把构建加入 Internal Testing 组。`--internal-only` 适合本人验证，安装仍需在 iPhone 上安装 TestFlight 并用有权访问该 App Store Connect App 的 Apple Account 接受邀请。每次重编译都要递增 `CFBundleVersion`；不能用相同构建号重复上传。

TestFlight 的管理入口现在是“系统管理 → App 管理”。基础信息保存在 Bridge SQLite 的 `mobile_apps` 表中，iOS 配置仍包含源码目录、Xcode 工程、构建输出目录、Bundle ID、Team、Scheme、Configuration、Target、Info.plist 路径和内部测试开关；上传时浏览器只提交表记录的 `appId`，服务端按记录调用受控脚本，不接受浏览器传入任意命令。旧 TestFlight 页面仍可访问，App Store Connect API Key 仍从 Bridge 进程环境读取，不写入数据库。

## 首次连接

1. 启动支持 App 配对接口的当前版本 Bridge，确认手机能访问它。LAN 场景需显式启用 `FEISHU_CODEX_BRIDGE_LAN_BIND=1`；手机填写 Mac 的地址，例如 `http://192.168.1.20:17310`，不能填写手机自己的 `localhost`。
2. 在 Mac 运行 `bun run web:pair`（源码环境）或 `feishu-codex-bridge web:pair`（安装版），确认命令使用的配置和数据库就是目标服务；不要为了配对切换数据库或重启安装版。
3. 在 App 的“配对链接或配对码”输入框粘贴完整链接，App 自动从链接读取服务地址和配对码，不需要重复输入。只有单独配对码时，展开“仅有配对码”确认 Bridge 地址。复制地址时使用 API/统一 Bridge 服务地址；开发环境是 `17310`，Vite 的 `5173` 不是 App 的后端。也可打开“扫描配对二维码”，使用相机识别或“选择本地图片”从相册/文件中识别二维码；图片在手机本地解码，识别到有效内容后再发起配对。
4. 配对后进入原有工作台。在设备管理中撤销手机设备会使该设备的凭据失效，需要重新配对。

如需复用已有设备，在已登录的设备管理页找到该授权，点击其“生成二维码”，再用目标设备扫码或打开链接。成功后保留原授权编号、名称和已延期的有效期，并轮换凭据使原登录退出；二维码五分钟内有效且只能使用一次，生成其他二维码会使未使用的旧码失效。有效授权及未标记撤销的过期授权可以复用；历史上已标记撤销的记录不会自动恢复。

推荐 HTTPS；证书必须受手机系统信任。自用 HTTP 连接限局域网、回环、链路本地地址与私有网络地址（含常见 VPN 的 `100.64.0.0/10`）。公网 HTTP 会在连接页被拒绝。LAN HTTP 不提供传输加密，请只在可信网络使用。

## iOS 命令行构建与安装

在 Xcode 中完成一次设备配对和自动签名配置后，可用以下命令构建最新前端、同步 iOS 资源和插件、编译签名并安装到已配对的 iPhone：

```bash
bun run mobile:ios:install
```

默认 `App` scheme 的产物为 `App.app`，包含 TunnelKit OpenVPN、`BridgePacketTunnel.appex` 和分享扩展。主 App 与 Packet Tunnel 扩展必须使用同一付费 Apple 开发者团队，并各自具备 `packet-tunnel-provider` entitlement 和有效的 provisioning profile；两者还共享 App Group 和 VPN Keychain 访问组。Xcode 自动签名可为可用的团队创建或更新这些描述文件。`--allow-provisioning-updates` 可让命令行构建更新签名；是否能更新取决于 Xcode 中的账号和团队权限。`--vpn` 保留原来的 `AppVpn` 兼容构建入口，不需要用它才能获得系统 VPN。

在 App 的网络设置中选择并保存“外部 OpenVPN Connect”或“内置 TunnelKit”；该选择保存在本机，手动检查和专用 Bridge 连接探测失败后的自动恢复遵循此选择，默认沿用外部客户端。外部方式需要已安装 OpenVPN Connect，Bridge 只能打开它，实际配置选择和连接需在该客户端中完成。切换到外部方式时，Bridge 关闭自己 VPN 配置的 On Demand 自动连接；已建立的连接可能需要在系统设置中断开。

选择内置方式后，可在网络设置中导入 `.ovpn` 文件并按需输入认证信息，首次创建 VPN 配置时应在 iPhone 上确认系统授权。VPN 使用系统 Packet Tunnel，实际设备流量、DNS 和路由由配置及服务器下发内容决定；免 VPN Wi-Fi 使用系统 On Demand 忽略规则。读取当前 SSID 还需要 Access Wi-Fi Information entitlement 和 Apple 所列的系统条件；不能读取时仍可手动填写免 VPN 网络。App 内 VPN 实验入口继续独立保留。新配置的主 App 与扩展通过共享 Keychain 读取完整配置和密码引用；系统 VPN 配置保留连接所需的服务器地址、用户名与显示名称。旧配置需在更新成功后才会迁移。真机仍需验证导入、授权、服务器兼容和网络切换。

项目内的 TunnelKit 使用 GPLv3，所含 LZO 使用 GPLv2+；其作者也提供另行协商的商业许可。Apple 付费开发者资格和 Network Extension 签名不自动授予第三方库的商业许可，分发前需按实际许可证和分发方式核对义务。

默认同时支持 USB 有线和 Wi-Fi / 局域网连接，脚本会根据设备当前的连接方式自动选择安装通道。设备完成一次有线配对后，可以拔线再运行 `bun run mobile:ios:install --check`，确认显示 `Wi-Fi / 局域网`；保留数据线时则会显示 `USB`。如果有多台设备，用 `--device "设备名称"` 指定；需要强制只走无线时加 `--wireless-only`。`--allow-usb` 仍作为旧命令兼容，但 USB 已默认支持。首次下载 Swift 包可能需要较长时间。

`devicectl` 使用 CoreDevice 已知的设备名称、UDID 或 DNS 名称；单独知道 iPhone 的 Wi-Fi IP 不代表 CoreDevice 能发现它。无线安装前先拔掉 USB 并检查：

```bash
bun run mobile:ios:install -- --check
bun run mobile:ios:install -- --device "设备 UDID" --wireless-only
```

仍可使用 `--ip` 或 `BRIDGE_IOS_DEVICE_IP`，但只有 CoreDevice 将该地址识别为设备时才可使用；脚本会在构建前检查，并在 `--wireless-only` 下核对实际连接方式。如果无法识别，请先检查 Xcode 的设备配对和网络发现，再改用 `--device`。

`bun run mobile:ios:install --build-only` 只生成签名 App，不安装、不启用自动续签；未发现设备时使用通用 iOS 构建目标。手动构建默认使用现有签名配置；需要 Xcode 更新签名配置时，可显式加 `--allow-provisioning-updates`。脚本核对同步后的 Web 资源、Bundle ID 和签名，安装后再检查设备上是否存在 Bridge。设备必须保持可连接，必要时解锁并确认系统提示。

成功安装后，脚本为该 checkout 和设备启用 macOS 用户级自动续签任务，并保存本次安装的 App 快照。它每小时检查一次主 App、分享扩展的描述文件以及实际签名证书，以最早到期时间为准；剩余不超过 24 小时时，通过 Xcode 已登录的账户申请新描述文件并重签快照，再覆盖安装到原设备。个人团队通常受限的是 7 天描述文件，不一定是签名证书本身。后台续签不会构建或安装工作区中后来修改的 App 代码；只有在确实取得更长有效期、团队、App 身份和签名权限一致时才安装。需要新描述文件时，脚本使用只用于申请签名的临时工程调用 Xcode，再用获得的描述文件重签快照。它不撤销证书，只临时移开与本 App 精确匹配的自动管理缓存；备份放在 Xcode 监听目录之外，操作结束后恢复，遇到同名新文件时保留备份。

```bash
bun run mobile:ios:install -- --renew-status        # 查看是否启用和已登记的最早到期时间
bun run mobile:ios:install -- --renew-now           # 立即尝试续签已登记设备
bun run mobile:ios:install -- --disable-auto-renew  # 停用自动续签，保留 App 和快照
```

定时任务需要 Mac 已开机且用户已登录、Xcode 账户和签名钥匙串可用、Mac 可连接 Apple 服务，并且 iPhone 已配对且可通过 USB 或局域网连接；可能需要解锁手机或在 Mac 确认钥匙串访问。指定 `--wireless-only` 安装时，后台也遵守无线限制。失败会写入 `--renew-status` 显示的日志、尝试发送 Mac 通知，并在下次整点重试；Mac 休眠期间错过的检查会在唤醒后合并执行，关机或长期离线无法保证及时续签。若检测到设备上的安装位置或版本改变，会暂停自动覆盖并要求重新运行安装命令；这些元数据不能证明其他工具从未替换过相同位置和版本的 App。状态显示的是本脚本上次成功登记的签名信息，不是从手机实时读取的到期时间。此前已安装的 App 需要重新运行一次安装命令才能登记和启用自动续签；不要删除或移动该 checkout，调度任务会从这里运行脚本。即使自动化已启用，Apple 账户授权、设备连接或签名服务出现问题仍可能导致过期，无法承诺永不中断。

### iOS OTA 无线安装

OTA 使用已签名的 App 生成 IPA，并提供独立的 Safari 安装页；系统读取 HTTPS manifest 后负责下载和安装。可以使用现有 VPN 的 Mac IPv4，也可以使用 Tailscale 私网 HTTPS。两种方式都要求 iPhone 能通过对应网络访问 Mac，且描述文件包含该设备；安装页请求成功或 IPA 下载完成都不代表 iOS 已安装成功。

使用本机环境要求的、可从 iPhone 访问的 Mac IPv4 配置 HTTPS 安装入口。以下示例中的地址需要替换为实际环境地址；命令会构建当前 checkout 的手机前端及 iOS App、生成安装包并启动用户级 OTA 服务：

```bash
export BRIDGE_IOS_OTA_HOST="<Mac 的可达 IPv4>"
export BRIDGE_IOS_OTA_BASE_URL="https://${BRIDGE_IOS_OTA_HOST}:5173/ios-ota"
bun run mobile:ios:ota -- --base-url "$BRIDGE_IOS_OTA_BASE_URL"
```

OTA 默认构建同一 Bundle ID 的 `App`，包含系统 VPN 和 App 内 VPN 实验入口，并要求已配置 Network Extension 签名。`--vpn` 仍可选择原 `AppVpn` 兼容构建：

```bash
bun run mobile:ios:ota -- --vpn --base-url "$BRIDGE_IOS_OTA_BASE_URL"
```

VPN IP 直连需要可信 HTTPS。首次运行会在当前用户的 `Library/Application Support/Feishu Codex Bridge/ios-ota-tls` 下生成独立根证书和仅本机使用的私钥，在终端打印供 iPhone 安装的 `.cer` 文件及 SHA-256 指纹。通过 AirDrop 等可信方式把 **`.cer` 公钥证书**发送到 iPhone，在“设置 → 通用 → VPN 与设备管理”安装，再到“设置 → 通用 → 关于本机 → 证书信任设置”启用完全信任。此根证书会被 iPhone 全局信任，私钥应留在 Mac；不用时可在 iPhone 移除证书。如果已有受 iPhone 信任且包含该 IP 的证书，可用 `--tls-cert <证书> --tls-key <私钥>`，无需生成本地根证书。VPN IP 变化后需用新 IP 重启 OTA 服务；自动生成的服务证书会使用同一根证书更新。

Tailscale 模式使用 Tailnet 的 HTTPS 证书，不需要把本地根证书装进 iPhone。Mac 和 iPhone 需要连接同一 Tailnet，并在 Tailscale 管理后台启用 HTTPS Certificates：

```bash
bun run mobile:ios:ota -- --check --tailscale
bun run mobile:ios:ota -- --tailscale
```

脚本只配置自己的 Tailscale HTTPS 端口，默认 `18443`，本机服务默认 `18731`；发现已有其他服务占用时停止，不执行 `tailscale serve reset` 或覆盖其他路由。也可以用 `--base-url https://...` 指向已存在的可信 HTTPS 反向代理；此模式只启动本机回环 HTTP 服务，外部代理需由使用者自行配置。

开发环境可让 OTA 安装页和 Vite 共用 `5173`：Vite 会把 `/ios-ota/` 代理到本机 OTA 服务。首次配置时使用上述 IPv4 生成证书，然后启动 OTA 服务和 Vite：

```bash
bun run mobile:ios:ota -- --stop
bun run dev:https:configure -- --ip "$BRIDGE_IOS_OTA_HOST"
bun run mobile:ios:ota -- --start --base-url "$BRIDGE_IOS_OTA_BASE_URL" --port 18731
bun run dev:web:restart
```

之后安装链接会是 `https://<Mac 的 IPv4>:5173/ios-ota/<短时令牌>/`；iPhone 只需信任一次该 OTA 根证书。`5173` 仍同时提供普通 Web 页面，不能把 OTA 服务直接改为占用 5173。

命令完成后会打印 24 小时内有效的安装链接及二维码，有效期不会超过签名到期时间。首次在 iPhone Safari 打开短时链接会为该浏览器建立 30 天的 OTA 授权；把输出的 HTTPS 首页添加到主屏幕后，可以在授权期内直接打开并安装最新已发布的包。该授权独立于 Bridge 配对，仅用于 OTA；不要把安装链接或根证书私钥发给他人。需要撤销 OTA 浏览器授权和全部未过期链接时运行 `bun run mobile:ios:ota -- --revoke-sessions`。之后可用 `bun run mobile:ios:ota -- --link --base-url "$BRIDGE_IOS_OTA_BASE_URL"` 生成新链接，`bun run mobile:ios:ota -- --stop` 停止 OTA 服务，安装包和证书保留。

每次运行默认命令会重新构建并发布当前 checkout 的同一 Bundle ID `App`，其中包含系统 VPN，并自动使用高于已发布包的 `CFBundleVersion`，避免 iOS 把新 IPA 当成同一构建而拒绝覆盖。也可用 `--build-number <正整数>` 显式指定构建号；默认已构建产物位于 `ios/App/build/DeviceDerivedData/Build/Products/PersonalDebug-iphoneos/App.app`。兼容入口 `AppVpn` 的产物位于 `Debug-iphoneos/AppVpn.app`，可用 `--vpn` 让脚本构建；若只想发布已经构建的签名 App，可用 `--app <App.app 或 AppVpn.app>`，脚本会拒绝不高于已发布构建号的包；`--no-serve` 只生成包。签名剩余不超过 24 小时时，发布过程先申请新描述文件并重签快照。OTA 服务启动后还会每小时检查最新安装包：临近到期时自动重签并发布**相同 App 的新签名包**，无需 iPhone 当时被 Mac 发现；手机仍需打开安装页并确认系统安装，新签名才会在手机生效。续签失败会记录到 OTA 目录的 `refresh-error.log` 并尝试在 Mac 通知，下次整点重试。

OTA 通过 iOS 系统安装，不会自动向现有 `mobile:ios:install` 续签任务登记安装成功；系统更换安装位置后，旧续签任务会按保护规则暂停。需要恢复 Mac 的自动覆盖续签时，重新连接设备并运行一次 `bun run mobile:ios:install`。不能因文件已下载就推断手机已安装，实际 Safari、证书信任和 iPhone 安装仍须真机验收。

已配对 Bridge 的 iPhone App 可以从环境切换窗口打开 iOS 安装页；iPhone Safari 中也可在“系统管理 → 系统设置”查看安装包状态、打开安装页或触发 Mac 构建发布。App 页面会同时显示当前构建号和目标构建号；目标不高于当前 App 时会阻止无效安装并提示先发布新构建。Android 和桌面 Web 不显示 iOS 入口。安装链接通过已配对会话和操作令牌签发，链接最多有效 30 分钟；系统安装器不携带 Bridge 会话，未过期的链接与 Bridge 设备撤销独立，应避免转发。构建发布只生成并发布安装包，不代表手机已经安装。

安装版 Bridge 启动目录不在源码 checkout 时，会尝试读取当前用户唯一的 OTA LaunchAgent 定位服务及源码；有多个服务或路径不同可设置 `FEISHU_CODEX_BRIDGE_IOS_OTA_DIR` 和 `FEISHU_CODEX_BRIDGE_IOS_OTA_SOURCE`，必要时用 `FEISHU_CODEX_BRIDGE_IOS_OTA_BUN` 指定 Bun。Bridge 必须能访问对应目录和源码，后台构建依赖 Mac 的 Xcode、签名账户及钥匙串。

开发服务可以复用 iPhone 已信任的 OTA 根证书，为 Mac 当前 LAN IP 单独签发 5173 服务证书：

```bash
bun run dev:https:configure -- --ip "$BRIDGE_IOS_OTA_HOST"  # 换成 Mac 当前 IPv4
bun run dev:web:restart                          # 仅重启当前 checkout 的 Vite
```

配置后，同一个 5173 端口同时支持原有 HTTP 与 HTTPS；如 `https://<Mac 的 IPv4>:5173/`。HTTPS 证书仅覆盖配置时指定的 IP、`127.0.0.1` 与 `localhost`，IP 变化后需重新配置并重启 Vite。该证书与 OTA 服务端证书分开，根证书不变；不改变 17310 API、7310 安装版服务或用户数据。HTTPS 需要手机能访问该 IP，并已在系统证书信任设置中完全信任根证书。

无线连接排查可运行：

```bash
bun run network:ip-audit -- --ip "$BRIDGE_IOS_OTA_HOST" --target "<目标 IPv4>"
```

脚本读取网卡的子网掩码、网关和到目标地址的路由，然后对本地网段做受控 ICMP/ARP 探测。输出中的“候选地址”只代表本次没有观察到响应，不能当作地址所有权确认；手动配置前应使用 DHCP 保留或让网络管理员确认。`--no-probe` 只读取路由，不发送探测包；`--json` 输出机器可读结果。

## iOS 本机崩溃诊断

App 启动时订阅 Apple MetricKit 的系统崩溃诊断；诊断交付后保存到手机 App 私有目录 `Library/Application Support/BridgeCrashReports`。在“系统设置”或“App-only VPN 实验”中的“本机崩溃报告”可查看和主动分享报告。记录仅在用户主动分享时离开手机，包含系统返回的堆栈、信号和构建号；不会读取或附加 VPN 配置、用户名或密码。系统交付可能延迟，也可能没有可用报告，系统原有 `.ips` 仍是补充信息。

“生成线程快照”使用 PLCrashReporter 1.12.2 采集运行中的线程状态，不会故意触发崩溃，也不会注册信号或异常处理器；快照与真实崩溃分别标记。堆栈可能需要与对应构建的 dSYM 配合符号化。该能力只对安装了新版本后的事件生效；iOS 真机上的崩溃交付和分享流程需要单独验收。

## iOS 原生 SSH 工作区

iOS App 的 `SSH / Mac` 入口会打开原生工作区：支持密码登录、未加密 Ed25519/ECDSA 私钥登录、首次主机密钥确认、交互式 PTY、终端 resize、连接后命令、主机配置保存，以及从 Tmux 页面打开全屏或半屏工作区。可在手机上生成 Ed25519 密钥，或通过系统文件选择器导入私钥；公钥可查看和复制，并需添加到 SSH 主机的 `~/.ssh/authorized_keys`。私钥材料与元数据分离保存到 `WhenUnlockedThisDeviceOnly` Keychain，不进入 WebView；RSA、加密私钥暂不支持。主机密钥显示稳定的 OpenSSH `SHA256:` 指纹，并按规范化主机和端口持久保存已确认的公钥；相同主机密钥自动信任，变化时才重新确认。密码只通过一次性原生调用进入连接对象，不写入 WebView 存储；主机配置只保存主机、端口、用户名、密钥 ID 和启动命令等非敏感元数据。普通进入工作区会自动载入最近保存且有可用私钥的主机并连接；管理模式才打开主机设置。主机设置默认不读取或展开 Bridge Session；可按需展开绑定，或从已选 Tmux Session 打开时自动读取。iOS 使用 Keychain 中的 Bridge token 校验绑定的 `bridgeOrigin + SSH host/port/user + sessionId + createdAt`，身份不一致则拒绝 API 绑定。

iOS Composer 将内容写入当前 SSH 终端；附件经 SFTP 分块上传到当前 SSH 主机，并在内容中附上远端路径。多行内容和附件需要终端启用括号粘贴模式；上传失败或写入结果未知时保留草稿并提示。Session 文件页目前提供只读目录列表，完整预览、上传和下载仍需跟进；Session 列表和 identity 校验仍是只读绑定层。原生 SSH 依赖的 SwiftTerm、SwiftNIO SSH 和固定 revision 的 NIOSFTP 已加入 Xcode App target；Xcode 依赖解析、编译、真实 Mac `sshd`/tmux 和 iPhone 触摸/软键盘验收必须分别完成，不能用浏览器或源码检查替代。

## Android SSH 工作区

App 连接中心可在 Bridge 配对和 SSH / Mac 登录之间切换。SSH 不依赖 Bridge 服务或配对；在已配对的工作台中可通过“系统管理 → App 连接”返回连接中心。SSH 登录表单可选择原生保存的主机和密钥；已保存私钥按需从设备密钥库读取。密码或临时私钥只在活动 App 会话内存中保留以便重连，显式断开时清空，不写入主机配置。主机、密钥的原有管理功能继续保留。App 鉴权失效时返回此连接中心，可直接选择 SSH；浏览器仍使用原有配对页面。Android 启用摇一摇后，在前台大幅摇晃两下可打开环境选择；在 SSH 工作区取消选择会恢复原界面，转到 Bridge 时只关闭 SSH 界面而不主动断开其 App 会话。

Android App 启动、回到前台和网络变化时会检查已安装的 **OpenVPN for Android**（`de.blinkt.openvpn`）；顶层 Activity 存活期间还会每 30 秒检查一次。免 VPN Wi-Fi 可在连接中心的网络设置中配置，未配对和 SSH 模式也可打开。配置的免 VPN Wi-Fi 上跳过自动启动；如果有免 VPN 列表但无法识别当前 Wi-Fi，会请求精确位置权限。读取 SSID 还需要开启系统位置服务；仍无法识别时跳过自动连接。Bridge 只读取当前 Wi-Fi 的 SSID，不读取 GPS 坐标。其他可用网络上检查并启动或恢复所选 VPN，与 Bridge 是否配对、Bridge/SSH 的 IP 或端口是否可达无关。已有选中 VPN 正在连接或已连接时不重复启动，检测到其他活动 VPN 时不自动替换；认证失败时暂停自动重试，需检查 OpenVPN 配置后手动重试。免 VPN Wi-Fi 不会主动断开已连接的 VPN；在其他网络手动断开后，App 运行时会再次尝试连接。

摇一摇打开环境弹窗后，可点击当前地址旁的紧凑 VPN 按钮，主动检查当前网络和 VPN；结果在当前页面显示，不主动打开 OpenVPN 主界面。手动检查与自动检查都遵守免 VPN Wi-Fi 列表，匹配时提示已跳过连接；配置了例外但无法确认当前 Wi-Fi 时也不会启动 VPN。手动检查不受自动重试间隔限制，可主动再试一次认证失败的配置，但仍不会自动替换其他 VPN。检查通过并发起连接后，Bridge 会继续监听 OpenVPN 状态，确认收到连接成功状态后显示“VPN 连接成功”并自动清除；失败或超时则保留具体提示。

首次使用需要在 OpenVPN 客户端授权 Bridge 控制，并在系统要求时确认 VPN 权限；已有一个 VPN 配置时自动选用，存在多个配置时选择一次。若客户端需要输入密码，或系统需要授权，仍可能显示相应原生界面。配置、证书和密码继续由 OpenVPN 保管。关闭 Bridge 不会断开 VPN，但顶层 Activity 销毁或进程被系统终止后 Bridge 的定期检查也会停止，后台启动、系统省电策略及 VPN 自身重连仍受 Android 和客户端限制。Bridge API 网络不可达时另行探测当前 API 端口，最多重试 60 秒；端口恢复后通知工作台重试，端口不可达也可能只是 API 未启动。不会自动重放 SSH 终端输入。旧版目标不可达触发流程曾在模拟器使用临时配置测试；本次全局检查仍需华为真机和公司 VPN 验收。

认证成功后，App 进程内的全局 SSH 会话继续持有交互式 zsh、保活任务和当前 tmux 目标；原生终端嵌入 App 的现有 Activity，关闭终端界面只解除绑定，不会主动断开 SSH。Android 在连接建立及会话活动期间启动前台服务，并显示系统连接通知；所有连接和连接尝试均结束后停止服务。tmux 列表、Session 文件和 Composer 附件优先使用配对 Bridge API；符合回退条件时分别使用 SSH 临时命令或 SFTP。没有 tmux Session 身份的普通 SSH 文件、附件和技能发现继续使用 SSH/SFTP。

连接成功后先进入交互式 zsh，点击 tmux 打开 Session 列表；列表支持刷新、按名称/目录/ID 筛选和查看附着状态。第一次进入 Session 会在当前 zsh 中执行 attach；已进入一个 Session 时，当前实现发送 detach 控制序列并等待终端输出匹配 `detached`，超时不继续发送目标 attach。但该文本可能来自普通程序输出，匹配器也可能在 detach 发送前收到输出，因此并不能可靠证明 detach 完成；attach 的 `Written` 也不证明已经附着。切换结果不确定时，请先检查终端和 Session，再发送消息。SSH 连接或终端中断后，App 级会话在前台和后台自动重试；工作区的重连按钮也直接重试当前连接。重连后按 Session ID 和创建时间核对并重新附加上次 tmux Session，不重放 Composer 或终端输入。目标不存在时提示重新选择；主机指纹变化时须手动确认。进程终止会清除内存凭据，重新打开时只有已保存私钥的主机可自动认证并尝试恢复已记录的 tmux 目标。前台服务不能阻止系统强制停止进程、设备省电策略或网络切换造成断线，tmux 仍负责保留 Mac 上的 Codex 进程。

原生 SSH 终端的“更多操作”提供当前 Session 的 Git 文件列表、搜索、Diff、文本预览和下载。账号列表、账号标记/检测、用量、Git 和 Session 快照/挂起/恢复/结束优先走配对 Bridge API，读取请求遇到网络或服务不可用等情况时回退目标 SSH 主机上的 `ssh-session` CLI；Session 文件及技能保留 SFTP/SSH 回退。文件列表不完整、旧版服务未提供截断标记或路径包含字面反斜杠时使用 SFTP。写入请求可能已执行但响应丢失时显示结果未知，先刷新核对，不自动重复写入。Composer 附件使用 API 分片上传并确认当前 SSH 主机可读，开始上传前 API 不可用时回退 SFTP；终端按键与 Composer 消息仍经 SSH PTY，不产生 Web Session 操作历史。Bridge 为原生 SSH API 请求记录脱敏路由、Session ID、状态和耗时，不记录令牌、文件内容或查询参数。

Git 状态包含工作区、暂存区及未跟踪文件，Diff/文本预览沿用 Web 的大小限制。账号标记写入所操作 tmux Session 的 `CODEX_HOME`，供用量查询和新建窗口、窗格继承，不会更改现有 shell 或已经运行的 Codex。默认 SSH 和私有 Bridge 目标复用同一个 Mac 主机配置，但已保存或手动选择的 SSH 主机、不同 Bridge 环境和不同数据库未自动绑定；切换目标后应核对当前环境和 Session。检测当前账号需要系统允许读取目标 Codex 进程的环境；环境不可读时应手动选择。

目标机需要包含 `ssh-session` 命令的新版 Bridge，当前仅修改源码不会自动更新已安装版本。SSH 登录环境优先使用 `FEISHU_CODEX_BRIDGE_SSH_CLI` 指定的 Bridge 启动器，其次使用 PATH 中的 `feishu-codex-bridge`，最后查找默认便携安装位置。CLI 降级直接调用 tmux、Git 和 Codex app-server，不检查、打开或写入 Bridge SQLite；旧的 `--db`、`FEISHU_CODEX_BRIDGE_SSH_DB` 参数仍可传入但不再参与降级操作。`FEISHU_CODEX_BRIDGE_SSH_CONFIG` 仍可指定 Codex 配置。新 App 会传入 Session 的逻辑工作目录；旧 App 未提供时 Git 降级查看当前 tmux pane 目录。

挂起先保存所选 Session 的快照并停止其中的进程。API 不可达时，CLI 在 tmux-resurrect 目录下的 `bridge-ssh-fallback` 中保存独立快照和身份元数据，不覆盖 Web 快照；恢复按 tmux-resurrect 的配置重建窗格和允许恢复的进程，不保证恢复进程的内存状态。Bridge API 恢复后，若两边配置同一快照目录，Web 和 Android 可看到降级快照，通过 API 恢复时重新关联已有 Session 记录。仅通过 CLI 恢复、终结或修改账号标记不会写入 Web 数据库，状态及账号可能需在 Web 重新核对；降级期间无法列出只存在于 Web 数据库中的旧挂起记录。目标机需要 tmux、tmux-resurrect、Git 和 Codex CLI；同一降级快照操作使用文件锁，异常退出留下锁时须先确认没有其他操作再处理。存在同名挂起快照时，先恢复或改名，避免覆盖。旧 Python 版本若曾在 `~/.feishu-codex-bridge/ssh-sessions/` 留下独立快照，这些文件不会被删除或自动并入 Web 数据库。手机界面、系统文件下载、实际 SSH 断线和真实主机恢复仍需设备验收。

Android 原生 SSH Composer 的“调试日志”按钮首次点击开始记录，再次点击停止并直接复制 JSON；若断线后停在主机或连接设置页，可使用“停止并复制诊断日志”。原有“导出滚动日志”仍可保存文件。记录覆盖 Activity/工作区与系统文件选择器生命周期、SSH 连接与重连阶段、会话断开来源、心跳、前台服务及网络类型变化；进程重建后继续记录，并在系统提供时附上退出原因。报告包括设备型号、Android/App 版本和电池优化状态，不采集其他应用或系统全量 logcat、SSH 地址、用户名、命令、终端文本、密码或私钥，异常只保留类型和固定错误类别。Activity 事件最多保留最近 800 条，数据保存在 App 私有存储；开始新记录会覆盖上一次记录。

App 内置页面，不使用 Capacitor `server.url` 加载远端网页，也不允许远程站点进入具有原生插件权限的主 WebView。网页依旧使用原来的 Cookie 配对；App 使用独立设备 Bearer 凭据并保留服务端的设备撤销机制。终端和事件流使用短期、限定路径的一次性连接票据，长期凭据不放入链接。

## 手机适配与凭据

第一批能力增强的入口、配置和验收边界见 [移动端第一批能力增强](mobile-phase-one-2026-10-29.md)：系统分享收件箱、本机原生通知/待处理、安全唤起与工作页恢复。后台即时推送已按用户选择明确为待配置，不能用本地通知插件宣称完成后台推送。

- App 复用现有 React 页面，增加连接管理、系统返回与前后台恢复；断开浏览器连接或进入后台不会结束 Mac 上的 tmux session。Android 返回按顶层弹层、页面内详情、路由历史处理，根页由原生入口最小化；环境/预览/扫码/确认/编辑表单统一注册，忙碌确认不会穿透到底层页面。系统键盘优先行为仍需真机检查。
- “附近传文件”位于 `/nearby-transfer`，是独立于 Bridge API 配对/请求链路的移动端功能模块。双方 App 前台打开页面后启动原生 `BridgeNearbyTransfer` 服务：普通局域网发布/浏览 `_bridge-nearby._tcp`，Android 连接 iPhone Personal Hotspot 时可使用当前 DHCP gateway 直连固定 TCP 端口 `43891`。服务、Bonjour/NSD、TCP 连接、文件 offer/接收和诊断监听由全局附近传输会话维持，离开页面或打开系统文件选择器不会因页面卸载主动断开；Android 与 iOS 都会在 hello 中交换设备 ID、设备名、平台和配对 token，并按设备 ID 合并双方同时发起造成的重复连接。列表显示原生设备名和平台，不再使用应用名作为设备名。移动端选择文件由原生文件选择器返回 `selectionId` 和元数据，控制帧仍使用少量 JSON，文件内容改为原生直接读取 URI 后通过 TCP 发送 `dataStart + binary bytes + dataEnd`，不再把文件内容切成 Base64 经过 Capacitor bridge；接收端原生直接写入 App 缓存，接收前需要用户确认，支持原生“打开查看”以及独立的“保存/分享”入口。页面保留最近 200 条原生启动、发现、连接和协议诊断日志，可复制；Android 也会写入 Logcat 的 `BridgeNearbyTransfer`，iOS 写入带 `[BridgeNearbyTransfer]` 前缀的控制台。当前版本不承诺进程被系统终止后的后台发现、后台接收或断点续传。
- App WebView 会在系统原始 User-Agent 后追加 `BridgeApp/0.5.0 (Android)` 或 `BridgeApp/0.5.0 (iOS)`，服务端可据此区分原生 App 与普通浏览器；不包含配对 token。
- 同一配对授权再次访问时会更新 UA（变化时立即更新），设备页显示 App 版本与系统摘要，原始 UA 收入折叠详情；保留用户设置的名称。原生下载沿用 WebView UA，避免系统下载器覆盖设备的 App 标识。设备列表前台每 30 秒及重新聚焦时刷新。
- App 的文件、附件和导出共用顶部下载提示：显示文件名、实际字节进度、完成结果和失败原因，可收起提示并清除已结束记录。已收到入队回执的 Android 系统下载按服务器/设备作用域保存最小元数据（不保存 URL 或长期凭据），有效期 7 天，恢复最多 200 条；重启后重新查询系统结果。前台缓存下载/分享若被进程回收则标为中断，不能冒充已保存。没有总大小时显示不确定进度，不把任务入队或收到全部字节当作保存完成。
- Android 文件下载通过系统 DownloadManager 保存到 Downloads，并显示系统下载通知；App 在前台读取真实进度，支持取消活动任务、打开已完成文件或系统下载列表。重试需回原文件页面再次操作。注销/撤销清理当前作用域的本机记录；系统下载可能继续，用户可从系统下载中取消，已保存公共文件不自动删除。iOS 下载到缓存后通过系统分享面板保存或转交其他应用，区分下载、分享和取消。Android FileProvider 仅公开 `bridge-downloads/` 缓存子目录供图片复制和文件分享使用，不公开其他私有文件。附件选择沿用系统 WebView 的文件选择器。
- App 在 1.8 秒内连续大幅反向摇晃两下会打开环境管理弹窗；每次需达到较强力度并持续一小段时间，两次无需停稳。降低将短暂碰撞和单次晃动的回弹误判为两次的可能；触发后冷却 1.5 秒，切到后台或传感器中断会清除未完成的计数。同一 Mac 主机的 `5173` 标为开发环境，`7310` 标为稳定环境；已配对环境直接切换，未配对环境进入连接管理重新配对。
- 系统设置提供“大幅摇晃两下切换环境”开关；启用时如平台要求运动权限，会请求并报告拒绝，手动环境入口始终可用。Android 前台优先使用原生加速度计，不可用时回退 WebView DeviceMotion；iOS 使用 WebView DeviceMotion。真实设备的传感器灵敏度仍待验收。
- JJ、History、任务列表/详情、用量、收件箱和设备读取在后台/离线暂停，回前台补拉读取；环境切换后旧页面停止调度。上传属于前台操作，后台不发起新的业务写请求或分块，Downloads 上传中断后提示手动核对再重试；不承诺后台上传或进程回收后恢复 File。
- 扫码保留网页相机、图片识别与拍照入口，并恢复 `@capacitor/barcode-scanner@3.1.3`，新增“使用原生扫码”选择；切换前释放网页相机，取消/失败后仍可选择原链路。本批增加本地通知后 Android/iOS 工程当前同步 8 个官方插件。拒绝相机权限、相机占用、没有相机分别显示恢复说明。
- 图片复制按钮保留，Android 使用受限缓存 URI 的原生图片剪贴板，iOS 使用图片 Clipboard；保存/分享是额外选择，不把保存或复制文件名冒充图片复制。PDF 恢复授权加载后的 iframe 内嵌预览，并保留系统打开/分享；WebView 的真实显示效果仍需真机验收。
- 原生 Blob 导出取消 8 MiB 硬上限，改为每次 512 KiB 分块写缓存；Android 从受限缓存 URI 流式转存到 Downloads，iOS 通过缓存 URI 分享，不对整文件做 Base64 桥接。保留原导出入口，磁盘/权限错误明确报告，不以缩减导出内容代替实现。
- 外部网页通过系统 Browser 插件打开；复制通过原生 Clipboard 插件适配。
- App 打开 Demo 时换取短时一次性授权链接，系统浏览器获得仅限所选 Demo 的 HttpOnly Cookie，正常跳转后链接不再含票据。授权最长 8 小时，且随原 App 的设备授权撤销而失效；不会获得 Bridge 管理权限。服务端重启或过期后从 App 再次打开。
- `BridgeCredentials` 自定义插件按服务地址读写凭据：`get({server}) -> {token: string | null}`、`set({server, token})`、`remove({server})`。
- iOS 凭据使用 `WhenUnlockedThisDeviceOnly` Keychain，不进行 iCloud 同步；Android 使用 Keystore 的 AES-GCM 密钥加密，私有 SharedPreferences 中只保存密文，并排除备份和设备迁移。凭据不写入 localStorage。
- Capacitor 原生日志关闭，避免插件参数或结果中的设备凭据进入调试日志。iOS 提供局域网用途说明和有限 ATS 私网异常；Android 开启 LAN 所需的 cleartext，连接页限制 HTTP 目的地址。
- 安全区使用 iOS `env(safe-area-inset-*)` 和 Capacitor Android SystemBars 注入的 `--safe-area-inset-*`。软键盘、横竖屏和终端滚动仍需真机验收。

原生源码在 `android/`、`ios/`。Gradle wrapper、SPM manifest 和自定义插件纳入版本控制；同步后的 Web 资源、构建缓存、个人 SDK 路径、签名文件和本机工程状态由 `.gitignore` 排除。修改前端后重新执行 `mobile:build`，再在 IDE 运行，避免安装包携带旧页面。

## 环境隔离与后端兼容

- 环境按钮切换的是 API；App 始终使用安装包内置页面，不会自动加载 5173 的最新网页或 7310 的旧网页。环境弹窗默认显示 App 安装版本；内置页面构建和后端版本可展开“版本详情”查看。
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

2026-11-08 iOS SSH 阶段验证：

- 使用 `HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 bun run mobile:ios:resolve` 解析 SwiftTerm `1.15.0`、SwiftNIO SSH `0.13.0` 与 SwiftNIO `2.81.0`；随后 `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 通过。
- iOS 原生已覆盖密码/未加密 Ed25519/ECDSA 私钥、Session 列表只读选择、文本 Composer API-first、Composer 附件分块上传和 `bridgeOrigin + SSH host/port/user + sessionId + createdAt` identity 校验；未完成 SFTP 完整文件操作、签名安装和真机验收。

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

首版未接入 APNs/FCM 推送、后台常驻推送、应用商店分发或静默安装更新；Android 已有检查、下载和手动打开系统安装器的更新流程。Bridge WebSocket 进入后台后由系统管理；重新进入前台恢复工作台，不承诺后台 WebSocket 始终存活。Android SSH 的前台连接服务与 WebSocket 连接分别管理。

## 官方资料

- [Capacitor 接入与同步](https://capacitorjs.com/docs/getting-started)
- [Capacitor 8 环境要求](https://capacitorjs.com/docs/updating/8-0)
- [Swift Package Manager](https://capacitorjs.com/docs/ios/spm)
- [原生 File Transfer](https://capacitorjs.com/docs/apis/file-transfer)
- [Apple 局域网 ATS 规则](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
