# 手机 App VPN 复用与 OpenVPN 内置方案评估

日期：2026-11-01
状态：Android 已实现通过外部客户端自动连接；已在模拟器使用临时配置验证，尚未在华为真机或公司 VPN 验收。Bridge 本身没有内嵌 OpenVPN 内核。

## 结论

可以复用手机上已经建立的 VPN 网络，Bridge 的工作台和原生 SSH 在路由允许时都能使用它。当前实现由 Android 顶层 Activity 全局检查 OpenVPN 状态，在非例外网络尝试连接或恢复；Bridge API 端口探测只用于恢复工作台连接。其他可选路线如下：

1. **先确认手机系统 VPN 是否原生支持这份 OpenVPN 配置**；若支持，在系统中配置连接后，Bridge 直接使用，不需要打包 VPN 内核。
2. 若系统不支持，但保留截图中的 OpenVPN for Android：先评估通过其外部 API 操作已有的单个配置，在 Bridge 显示状态并由用户点击连接；不需要把 OpenVPN 内核打包进 Bridge。
3. 只有确实需要脱离外部 VPN 客户端、在 Bridge 内自行导入和管理 `.ovpn` 时，再考虑 OpenVPN 3 C++ 内核加 Android `VpnService` 的完整内嵌方案。

外部客户端自动连接已在模拟器验证，仍需实际手机验证；第三条是可行性方案而非已完成实现。无论采用哪条，VPN、Bridge 配对和 SSH 登录仍是独立环节。

完整内嵌方案的主要工作量不在配置界面，而在内核交叉编译、Android TUN/路由/DNS 对接、凭据保护、网络切换和真实公司配置兼容性。一个配置不意味着只支持一个服务器地址或可以丢掉配置中的协议、安全及路由选项。手机上的现有 VPN 客户端继续可用，作为对照和回退。截图显示的 LZO 和证书策略需要优先做真实兼容性验证，不能只根据 OpenVPN 2.x 协议兼容宣称可以连接。

**各方案的包体目前都没有可靠的增量数字。** 外部 API 方案不打包 VPN 内核和 TLS 库，但接口代码也不是零字节；完整内嵌方案可把 Android arm64 APK 增量 **不超过 5 MiB** 当作工程目标，而非承诺或用户已经确认的上限，先构建最小内核并测量。超出目标时展示 OpenSSL/mbedTLS 的实测结果和取舍，再决定是否继续，不通过删除现有功能或依赖来抵消体积。

## 华为手机系统 VPN 和现有客户端能否复用

### 已经连接的 VPN 网络可以直接复用

截图里的 OpenVPN for Android 使用系统 VPN 机制。它连接成功后，只要其路由和“允许的应用”设置覆盖 Bridge，Bridge 的 HTTP/WebSocket、原生 SSH 及相应流量就可以使用这个连接；不需要在 Bridge 再装一套协议内核或 OpenSSL。系统浏览器和系统下载是否也经过 VPN，仍取决于实际应用范围及路由。

可以在 Bridge 的连接中心增加“打开系统 VPN 设置”和粗粒度网络状态。Android 官方提供 [`Settings.ACTION_VPN_SETTINGS`](https://developer.android.com/reference/android/provider/Settings#ACTION_VPN_SETTINGS)，但具体华为设备可能没有匹配页面，需要回退到普通设置并提示用户；此入口不自动选中、连接或断开某个 VPN。现有 `BridgeSshActivityDiagnostics.kt` 已使用 `NetworkCapabilities.TRANSPORT_VPN` 记录默认网络类型，可参考其模式，但它尚不是完整的 VPN 控制或配置检测功能。即使检测到 VPN，也不能证明是公司配置或公司电脑可达，应分别检测 Bridge/SSH 的连接结果。

### 系统能否替代外部 OpenVPN 客户端

在手机“设置”中搜索 **VPN**，查看新增 VPN 的**类型**和是否能导入 `.ovpn`，不必公开配置内容。机型和系统版本不同，不能仅凭“有 VPN 设置”断言支持 OpenVPN：

- 若列表有 OpenVPN 且可导入或完整配置，才有机会直接使用系统客户端。需要在当前手机逐项确认 UDP、用户名/密码加客户端证书、LZO、证书策略、DNS 和路由能否正常工作；系统显示已连接之后还要测试 Bridge 和 SSH。
- 华为官方确实说明部分**鸿蒙电脑/二合一设备**提供轻量 OpenVPN，但其支持的参数有限；这份说明不适用于证明该用户手机具备同样功能。[华为设备说明](https://consumer.huawei.com/cn/support/content/zh-cn16051333/)
- 若系统只提供 IKEv2/IPsec 等类型，不能把 OpenVPN 地址、端口和证书直接当成 IKEv2 配置。只有公司另有受支持的 IKEv2/IPsec 接入、认证及配置时，才能使用系统协议；不应自行更改公司服务器。Android 的 [`Ikev2VpnProfile`](https://developer.android.com/reference/android/net/Ikev2VpnProfile) 和 [`VpnManager`](https://developer.android.com/reference/android/net/VpnManager) 也是针对平台支持的 VPN 协议，不能把 OpenVPN `.ovpn` 直接转换成 IKEv2；其配置/启动接口面向调用 App 自己配置的 profile，不能假设普通 App 可接管系统中任意已有 VPN。

### 可以优先验证：控制已安装的 OpenVPN for Android

截图生成信息显示的客户端版本为 `0.7.64`。查阅该上游版本的源码，其外部 AIDL API 提供列出 profile、按 UUID 启动、断开及状态回调；真实安装包是否保留该 API 以及华为系统上的行为仍需验证。[0.7.64 接口](https://github.com/schwabe/ics-openvpn/blob/v0.7.64/remoteExample/src/main/aidl/de/blinkt/openvpn/api/IOpenVPNAPIService.aidl) / [调用示例](https://github.com/schwabe/ics-openvpn/blob/v0.7.64/remoteExample/src/main/java/de/blinkt/openvpn/remote/MainFragment.java)

当前实现流程：

1. Android 顶层 Activity 同步连接中心的免 VPN Wi-Fi 列表，启动、前台恢复及网络变化时检查 VPN；顶层 Activity 存活期间每 30 秒复查。免 VPN Wi-Fi 跳过启动；列表非空而 Wi-Fi 无法识别时先请求位置权限，仍无法识别则跳过。Bridge 是否配对、目标 IP 和端口是否可达不决定 VPN 启动。
2. 绑定指定客户端并调用外部 API 的 `prepare`；首次控制授权和系统 VPN 授权由用户在前台确认。客户端未安装、无配置或授权失败时显示提示，现有 Bridge/SSH 功能仍可使用。[Android 包可见性](https://developer.android.com/training/package-visibility)
3. 一个 profile 时自动选择，多个 profile 时由用户选择一次并保存标识。Bridge 不读取或复制 `.ovpn`、证书、私钥、账号密码。选中的 VPN 已连接或正在连接则等待；其他 VPN 活跃时不自动替换；暂停的选中 VPN 在没有其他活动 VPN 时恢复；认证失败时停止自动重试并提示用户。
4. 调用 `startProfile` 或 `resume`，由现有客户端处理认证、协议和隧道；需要密码或授权时允许其显示原生界面。Bridge API 不可达时另外轮询当前 API 端口最多 60 秒，端口可达后通知工作台重试；不会自动重放 SSH 输入。
5. Bridge 不调用外部客户端的 `disconnect()`；免 VPN Wi-Fi、页面关闭和 App 退出也不会主动断开 VPN。在非例外网络手动断开后，App 运行时会再次尝试连接。顶层 Activity 销毁或 App 进程停止后不再运行检查，后台启动和保活受 Android 系统及 VPN 客户端限制。

用户已有这一客户端，因此不必新增 VPN 应用或重新导入证书；但卸载它后这种方式不能工作，且其维护、后台运行和兼容性仍依赖该客户端。`0.7.64` 的许可文件将用于外部控制的 `remoteExample` 代码标为 Apache 2.0；这不同于把其 VPN 核心移植进 Bridge。实际使用时仍需核对具体复制文件、许可声明及应用分发条件。[该版本许可](https://github.com/schwabe/ics-openvpn/blob/v0.7.64/doc/LICENSE.txt)

此前按目标不可达触发的外部 API 自动连接曾在 Mac 的 Android 36 ARM64 模拟器中配合官方 OpenVPN for Android 0.7.64 和临时本机测试服务完成授权、自动连接和 TLS 握手；还验证了重开 Bridge 不会断开已有 VPN。测试使用临时证书和模拟目标，不证明公司路由或华为系统行为。下方 8.5–15 人日仅适用于完全内嵌 OpenVPN 的另一条路线。

## 结合当前手机配置的判断

本节只记录截图中可见的功能类别，不记录公司网关、账号、设备标识或证书内容。用户称当前客户端为 OpenVPN Connect；不过截图中显示的包名与界面属于 **OpenVPN for Android**（`de.blinkt.openvpn`，生成配置标注 OpenVPN 2.x）。不能根据这几张图判断手机是否同时使用官方 OpenVPN Connect；本方案以截图里的客户端行为作为实际对照。OpenVPN 3 是兼容 OpenVPN 2.x 协议的不同实现，并不保证每项配置、GUI 默认值和服务器推送都相同。

| 截图可见情况 | 对单配置方案的具体影响 |
| --- | --- |
| 一个已启用的服务器，传输协议为 UDP，未使用代理；界面连接超时设为 120 秒 | PoC 优先覆盖 UDP 和实际网关；是否有其他隐藏的 `remote`、重试配置及超时语义仍需核实。不要把服务器地址/端口硬编码进 App。 |
| `dev tun`、`client`、`auth-user-pass`，登录类型是用户名/密码加客户端证书 | 原生导入与连接必须同时支持 CA、客户端证书、私钥和用户名/密码；不能只做密码登录或只做证书登录。截图显示这三项证书/密钥在当前客户端中标为内联数据，但不证明手头原始 `.ovpn` 一定包含它们或可以直接导出。 |
| LZO Compression 已勾选 | 这是首要兼容性门槛；截图未展示最终生效的压缩指令和服务器协商结果，不能据此断言服务器正在双向压缩，见下文。 |
| 生成的 OpenVPN 2.x 配置包含 `tls-cert-profile legacy`；“Load OpenSSL legacy provider”未勾选 | 两者是不同设置。OpenVPN 3 的所查版本能解析该证书 profile，但不同 TLS 后端和实际证书约束仍须实测；截图不能证明证书一定使用弱算法，也不能据此打开 OpenSSL legacy provider。 |
| 生成配置包含 `management` 及其客户端/口令/hold 指令，路径指向旧客户端私有目录 | 这是旧 App 驱动 OpenVPN 2.x 的管理接口配置，不能原样复制到 Bridge 或当成可携带的 `.ovpn`；桥接应使用 OpenVPN 3 Client API 和自己的原生凭据输入。 |
| 生成配置声明了 `IV_SSO` 等客户端能力 | 这是客户端宣告，不证明该服务器当前要求 SSO/MFA，也不应照搬设备标识或伪装客户端身份。需通过实际连接和公司策略核实。 |
| 可见 IP AND DNS、ROUTING、ALLOWED APPS 标签，但未展示其内容 | 无法判断当前 DNS、分流范围或允许哪些 App；这些 Android 客户端设置不一定包含在 `.ovpn` 中，迁移时须单独核对。 |
| 生成的客户端平台信息显示 Android 12 / API 31、arm64 | 优先在当前手机及 `arm64-v8a` 构建上验证；不据此声称其他版本或 ABI 已通过。 |

截图没有展示完整配置、实际下发的路由/DNS、加密算法、TLS 附加密钥、服务器策略或成功连接日志。未来实施仍需要通过受控导入获得完整配置及所需认证材料；截图无法替代它们，也不应把密码或私钥发到聊天中。应先确认旧客户端能否安全导出包含所需内联证书/密钥的可携带配置，或使用公司提供的原始配置并在原生侧补充缺失材料；截图中的 GENERATED CONFIG 是运行时生成内容，不能直接整段当成可移植配置。

### LZO 与旧证书策略：先验证，再定方案

1. 首选与公司 VPN 管理方确认服务器是否仍要求 LZO，能否按服务器和客户端兼容方式迁移到不压缩；不要擅自更改公司配置。压缩和加密组合有 VORACLE 风险，OpenVPN 已弃用相关压缩选项；勾选本身并不证明当前连接已受到攻击。[OpenVPN 安全说明](https://openvpn.net/security-advisory/the-voracle-attack-vulnerability/) / [压缩迁移说明](https://community.openvpn.net/Pages/Compression)
2. 所查 OpenVPN 3 内核默认 `compressionMode` 为 `no`（仅压缩 stub）；其 `asym` 是仅允许接收服务器发来的压缩数据。源码在未定义 `NO_LZO` 且未链接外部 LZO 库时提供内置 LZO **解压**实现，发出的数据不压缩；内核 Client API 有单独的 `compressionMode` 设置，不能假设只传入旧客户端的配置文件就会启用相同模式。它可能减少依赖，但**不能保证**满足当前服务器：须用实际 profile、服务端推送和真实双向流量验证；不能把 asym 或 stub 宣称为双向 LZO。见 [Client API](https://github.com/OpenVPN/openvpn3/blob/0abc8313b8fe5f63dbebc10d53094952957845d9/client/ovpncli.hpp) / [内核选择逻辑](https://github.com/OpenVPN/openvpn3/blob/0abc8313b8fe5f63dbebc10d53094952957845d9/openvpn/compress/lzoselect.hpp)。
3. 若确认服务器确实要求额外 LZO 支持，比较完整 LZO 与内置非对称模式的体积、安全和许可；外部 LZO 库使用 GPL，可能改变分发义务，必须连同具体版本与链接方式审核，不能仅依据 OpenVPN 3 的 MPL 选项判断整个包的许可。[OpenVPN 对 LZO 的许可说明](https://github.com/OpenVPN/openvpn/blob/master/COPYING)
4. `tls-cert-profile legacy` 可见于旧客户端生成的配置，并不等于截图勾选了 OpenSSL legacy provider。先验证公司 CA 与服务端证书在默认或更严格策略下能否通过；若确有兼容需要，明确比较现有行为、实际证书链和选用后端的策略，再决定如何处理，不能静默忽略证书校验或启用额外旧算法。截图中的“未勾选证书指纹”只说明未启用这项额外校验，不能推断没有 CA 校验。

## 当前项目的实际情况

以下判断基于本次 checkout `feature/capacitor-mobile-app`，源码提交 `0111a5f` 及当前工作区；APK 是已有构建输出，不能证明它由当前全部源码构建或已安装到手机。

| 检查项 | 当前情况 | 对方案的影响 |
| --- | --- | --- |
| App 外壳 | Capacitor 8.5.3；Android `minSdk=26`、`targetSdk=36`；开发 APK 仅 `arm64-v8a` | 可加原生插件，但必须保留 Android 8+ 兼容性并实际验证其他计划分发的 ABI。 |
| 现有 SSH | `sshlib:0.5.0`、`termlib:0.3.13`；Bouncy Castle 用于原生密钥生成 | 当前 SSH 连接和原生终端统一走 ConnectBot；VPN 是网络层新能力，不替换 SSH。 |
| 现有 VPN | Manifest 没有 VPN service；iOS App entitlements 没有 Network Extension | 若 Bridge 自持 VPN 协议和隧道，需要原生实现；复用手机已建立的 VPN 则不需要新增隧道。 |
| 现有入口 | 连接中心区分 Bridge 和 SSH / Mac；已配对工作台可返回连接中心 | VPN 应作为这两种连接方式共同使用的独立状态和操作，在 Bridge 不可达时也能打开。 |
| 外部网络消费者 | Demo 通过系统浏览器打开；Android 普通文件下载使用系统 `DownloadManager` | 如果只允许 Bridge 应用进 VPN，外部浏览器肯定不属于 Bridge 应用，系统下载也需实测其路由；不能只验证 App 内请求。 |

### ConnectBot 和 OpenSSL 能否复用？

结论是：**目前没有证据表明已有可供 OpenVPN C++ 直接复用的 OpenSSL；现有 SSH 加密依赖不等于 OpenVPN 实现。**

- `android/app/build.gradle` 声明了 ConnectBot 的 JVM SSH 库、终端 AAR，以及 Java 的 `bcprov`/`bcpkix`。它们服务于现有 SSH 和终端；即使 Java 侧提供加密能力，也不能直接替代 OpenVPN 3 所需的 C/C++ TLS 和数据通道实现。
- 检查已有的 `android/app/build/outputs/apk/debug/app-debug.apk`：大小为 **38,048,793 字节，约 36.29 MiB**；APK 内未看到独立的 `libssl.so` 或 `libcrypto.so`。其中 `lib/arm64-v8a/libjni_cb_term.so` 为 **3,571,688 字节，约 3.41 MiB**，其 ELF 动态依赖也没有 `libssl`/`libcrypto`。这不足以断言系统或所有静态链接产物中完全没有 OpenSSL，但不能据此获得一个可复用的公共 OpenSSL API。
- 系统自身的加密实现是平台内部实现，不应假设其私有原生符号可作为跨 Android 版本稳定支持的 OpenSSL 接口。PoC 应自带并锁定受支持的密码学后端及安全更新，不从系统私有库强行链接。
- 上述原生 `.so` 在这个 APK 中是未压缩存放；Maven AAR 内该同名文件则是压缩存放。**AAR 下载大小不能直接当作 APK 增量**，更不能根据目前这些数字推算 OpenVPN 的体积。

OpenVPN 3 官方源码支持 OpenSSL 和 mbedTLS 两种构建后端；两者的 Android 交叉编译、公司配置支持和 APK 增量均需用同一原型实测。也不建议为复用 Java Bouncy Castle 自行实现 OpenVPN 协议或把核心密码逻辑改写成 Java。参见 [OpenVPN 3 README](https://github.com/OpenVPN/openvpn3/blob/0abc8313b8fe5f63dbebc10d53094952957845d9/README.md)。

## 路线比较

| 路线 | 优点 | 代价与判断 |
| --- | --- | --- |
| 已连接的手机 VPN / 系统设置入口 | 使用系统已有隧道，无需引入 VPN 内核；截图客户端可继续使用 | 需要用户在系统或现有客户端连接；如果在 Bridge 增加入口和状态，仍有少量尚未测量的代码增量。 |
| **外部 API 控制现有 OpenVPN for Android** | 可望在 Bridge 控制已有单配置，不迁移私钥或引入第二套 VPN 内核 | 必须保留现有客户端、授予外部控制权限，并在用户手机验证接口/交互。推荐优先做小型 PoC。 |
| **OpenVPN 3 内核 + Android 原生隧道** | 官方 Connect 使用同类内核；协议兼容 OpenVPN 2.x；不必搬入多配置界面 | 需要自行完成原生构建、JNI、系统 VPN、配置/凭据和生命周期；与截图中生成的 OpenVPN 2.x 配置在 LZO、证书策略和 profile 上的兼容性必须实测。作为不依赖外部客户端时的备选。 |
| 直接移植 OpenVPN for Android | 与截图中的客户端属于同一项目，配置行为可能更接近 | 是完整 App 而非官方支持的通用轻量 SDK；移植和维护边界大，且需处理 GPL 等许可证义务。与用户现用版本的行为仍需验证，不作为首选。 |
| 基于现有 SSH 库或 Java 加密库自写 OpenVPN | 理论上可能复用部分 Java 代码 | SSH、TLS、OpenVPN 协议和系统 TUN 是不同层；实现及安全验证成本高，不能证明更小，不建议。 |

OpenVPN 3 仓库在本次检查的 `0abc8313` 版本提供 C++ Client API；其源码树没有可直接引入本项目的完整 Android AAR/Gradle VPN 客户端，README 中的现成构建示例主要针对 Linux。因此不要把它当作添加一行 Gradle 依赖即可工作的现成 Android SDK。具体参见 [Client API](https://github.com/OpenVPN/openvpn3/blob/0abc8313b8fe5f63dbebc10d53094952957845d9/client/ovpncli.hpp) 和 [OpenVPN for Android 项目说明](https://github.com/schwabe/ics-openvpn)。

### 许可证与公司策略

- 本次查阅的 OpenVPN 3 `0abc8313` 版本采用 **MPL-2.0 或 AGPL-3.0** 双许可；MPL 是值得优先评估的选择。实际引入时应固定版本并复核每个使用文件、适配代码及所有第三方依赖的许可证。参见 [该版本许可证](https://github.com/OpenVPN/openvpn3/blob/0abc8313b8fe5f63dbebc10d53094952957845d9/LICENSE.md)。
- 选择 MPL 并分发二进制时，需履行适用的许可及通知义务，并按要求提供受 MPL 覆盖的源码，包括对这些文件的修改；不要笼统认定必须公开整个 Bridge，也不要认定没有任何源码义务。AGPL 路径、其他依赖和具体分发方式应单独评估。当前项目根目录未发现已跟踪的 `LICENSE` 文件，分发前还需确认项目自身的授权安排。
- 公司 VPN 可能限制客户端类型、证书、设备注册或 SSO/MFA。只有公司策略允许且真实配置兼容时，内核原型才能替代现有客户端；不通过绕过设备检查或降低服务端认证要求解决兼容问题。

## 备选：Bridge 自带 OpenVPN 的 Android 方案

```text
连接中心：VPN 配置 / 状态 / 连接与断开
  ├─ 原有 Bridge 工作台和配对
  └─ 原有原生 SSH / tmux
          │ 均使用系统网络
Capacitor BridgeVPN：只传状态和非敏感操作
          │
Android 原生配置与凭据 ── VpnService / 前台服务
          │                         │ TUN、路由、DNS、MTU
          └──── JNI ── OpenVPN 3 内核及选定 TLS 后端 ── 公司 VPN 网关
```

### 用户操作

1. 在 App 的连接中心增加独立的“公司 VPN”区域，能在尚未配对或 Bridge 离线时使用。已有 Bridge 和 SSH 入口、浏览器行为均保持。
2. 使用 Android 系统文件选择器导入一个 `.ovpn`；原生层校验后保存为唯一配置。界面展示配置名称、连接状态及简短失败原因，不展示或回传私钥、密码或完整配置。需要用户名、密码或证书口令时使用原生输入；是否保存认证信息由用户明确选择。若配置内联了账号密码，应在原生侧将其单独处理，确保“忘记密码”能删除保存的密码而不破坏 CA/证书/私钥。
3. 点击连接时调用 `VpnService.prepare()`；若系统要求，则由用户确认 VPN 授权。再显示连接中、已连接、重连中、已断开或错误。VPN 已连接不等于 Bridge 在线：配对、Bridge HTTP/WebSocket、原生 SSH 状态分别展示。
4. 保留明确断开、替换和删除配置的操作。导入替换采用原子保存：解析失败时保留旧配置；当前已连接时先让用户明确选择断开和替换，避免静默中断。删除或断开 VPN 不清除 Bridge 配对、SSH 主机、密钥或草稿。

### 隧道和路由

- 原生层为 OpenVPN 3 的 `eval_config`、`provide_creds`、阻塞式 `connect`、`stop`、状态事件及 TunBuilder 回调提供 JNI 适配；连接运行在后台线程，不阻塞 WebView。正确处理 TUN 文件描述符、回调线程、取消和进程退出，确保只存在一个活动连接。
- 用 `VpnService.Builder` 应用已认证服务端与 profile 提供的接口地址、路由、DNS、搜索域、MTU 和 IPv4/IPv6 设置。VPN 传输 socket 须在连接前调用 `VpnService.protect()`，避免 VPN 流量再次进入隧道。Android 当前一个用户/工作配置只能有一个活动 VPN；启用 Bridge VPN 可能停止手机当前 VPN，UI 应在连接前说明并保留回退入口。[Android VPN 官方说明](https://developer.android.com/develop/connectivity/vpn)
- 首版建议 **不设置应用白名单**，按配置和服务器下发的路由工作，让相同目的地址上的系统浏览器、系统下载等也可使用设备级 VPN。截图未展示现有客户端的 ALLOWED APPS 设置，不能断言其当前就是设备级；如果原客户端有限制应用，迁移前须明确展示范围变化并确认。只路由指定内网还是全部流量，取决于配置和服务端推送；不能擅自加默认全隧道路由，也不能丢掉服务端要求的默认路由。与现有客户端的实际允许应用、DNS、IPv6、默认路由行为必须逐项对照。
- “仅 Bridge 应用走 VPN”可作为后续可选能力，使用 Android 允许列表，但只有在明确验证外部浏览器、DownloadManager 和其他独立进程后才能承诺原有功能正常。不能为了让此模式可用而删除 Demo 外部打开或现有下载能力。
- VPN 授权被撤销、系统切换到另一 VPN、Wi-Fi/蜂窝变化或服务被回收时，更新真实状态并释放隧道资源；在用户先前明确连接的前提下处理网络恢复和重试。用户主动断开后不自动重连。服务器明确返回 `AUTH_FAILED` 时停止自动重试；用户选择保存了密码时，参照截图中的“断开并忘记密码”行为清除已保存的认证密码并提示重新输入，保留 CA、客户端证书、私钥和其他配置。新传输网络需正确保护 VPN socket 和处理底层网络变更，不能重放 SSH 输入或业务写请求。
- 前台服务、通知权限及后台启动限制须按目标 Android 版本逐一验证；现有 SSH 的 `connectedDevice` 前台服务不自动证明 VPN service 声明正确。首版若不能可靠支持系统 always-on，应按系统 API 明确关闭该支持；不要承诺断线后所有流量自动阻断或具备 kill switch。

### 配置兼容和安全

- 配置只有一个**槽位**，但该文件可包含多个 `remote`、重试与故障切换、CA/客户端证书/私钥、`tls-auth`/`tls-crypt`、认证方式、密码算法及路由等。交由内核解析并按真实配置确认支持情况，不因界面简单而自行裁掉指令。
- 优先支持证书内联的统一配置。若实际文件引用外部 CA、证书、密钥或 PKCS#12，需要在 PoC 确认并通过系统选择器安全导入相应文件，或清楚提示缺少文件；不假装单文件可用。若需要动态口令、浏览器 SSO、硬件密钥或 Connect 专有设备策略，先验证并单独评估，不能以跳过认证代替支持。
- 不执行配置引用的脚本或任意命令；对不支持且影响认证、加密、路由或 DNS 的指令明确报错。保留服务端证书/主机校验及 profile 安全要求，不为了连通而忽略错误或降级加密。OpenVPN Connect 本身也并非支持全部指令，见 [官方不支持指令说明](https://openvpn.net/connect-docs/directives-not-supported/)。
- `.ovpn` 可能包含证书、私钥及认证信息。原文件、口令和动态令牌只在原生侧处理；本机持久化内容使用 Android Keystore 管理的密钥加密，排除备份和设备迁移。日志、崩溃信息、Capacitor 参数和诊断导出只保留脱敏的错误分类及状态，不包含密钥、账号、服务器地址或完整 profile。内存清除尽力而为，不声称 Java/C++ 字符串可被完全擦除。
- 配置里的公司服务器地址与认证信息不要提交到仓库，也不要通过普通聊天或工单粘贴。验证真实配置时，仅记录经用户认可的非敏感能力类别；自动化使用临时测试 CA、账号和 VPN 服务。

## iOS 评估

现有 iOS 15+ 工程没有 Packet Tunnel target，也没有 Network Extension entitlement。未来可以尝试复用同一 OpenVPN 3 内核，但必须新增 `NEPacketTunnelProvider` 扩展、路由/DNS 对接、容器 App 与扩展的安全数据共享、签名和 provisioning profile；Android 的 `VpnService`/JNI 不能直接复用。Apple 的 Packet Tunnel 需要配置 Network Extensions capability 和有效签名配置；不能简单断言所有开发账号都要额外申请特殊人工授权，具体以账号类型和分发方式核验。[Apple 配置说明](https://developer.apple.com/documentation/xcode/configuring-network-extensions/) / [Apple DTS 对 entitlement 的说明](https://developer.apple.com/forums/thread/814047)

iOS 的后台生命周期、系统 VPN 配置、密钥访问和真机签名要单独验证；App Store 或其他分发方式还有各自的规则。Android 方案通过不代表 iOS 已实现或可发布。建议先完成 Android 可行性，再确定 iOS 是否投入；现有 iOS 继续使用原来的外部 VPN 方式。

## 备选：内嵌内核的体积与实施计划

估算适用于一名熟悉 Android/JNI 的工程师，假设公司配置不要求额外的 SSO、设备注册或外部硬件密钥。**合计约 8.5–15 人日**，是初步工作量而不是交付承诺；真实配置、构建问题或策略限制可能显著增加时间。

| 阶段 | 工作与产出 | 初估 | 继续条件 |
| --- | --- | --- | --- |
| 0. 配置盘点 | 已从截图识别 UDP、用户名密码加证书、LZO 勾选及 legacy 证书策略；继续在受控环境确认完整 profile、实际压缩/证书协商、允许应用、路由、DNS 和 MFA，不记录秘密 | 0.5–1 人日 | 公司策略允许接入；确认当前客户端能否导出完整配置及所需材料。 |
| 1. 最小 PoC | 固定 OpenVPN 3 与依赖版本，编译 arm64；打通 JNI、`VpnService.protect`、TUN、UDP 及用户名密码加证书认证；比较 OpenSSL/mbedTLS，并优先验证 LZO stub/内置非对称模式与证书策略 | 2–3 人日 | 临时测试网关及经授权的真实配置双向可用，给出真实 APK 增量和许可证清单；若 LZO、证书、体积或公司策略阻塞，先停下来评估。 |
| 2. 可用 Android 功能 | 单配置原生导入及加密保存、必要认证、状态与连接入口、真实推送的路由/DNS、断开和错误处理 | 3–5 人日 | Bridge 和 SSH 均可通过真实配置访问目标，安全校验及旧入口保留。 |
| 3. 网络与恢复 | 前台通知、网络切换/失联/撤销、资源释放、手动断开语义与状态恢复 | 1–2 人日 | 不循环连接、不因页面退出误断、不重放业务写入。 |
| 4. 回归与验收 | 自动化、调试/发布构建与包体复测、真实设备/公司网络及 Web 回归 | 2–4 人日 | 下述验收项有实际证据；问题与剩余平台限制明确记录。 |

后续 iOS 在 Android 内核及实际配置已验证、签名可用的前提下，粗估另需 **5–10 人日**，不包含复杂认证、审核或长期维护；需另做原型后重新估算。

### 包体如何比较

1. 使用同一源码基线、Gradle/NDK、依赖、ABI 和构建类型分别生成不带/带 VPN 内核的 APK；不为了比较而移除 SSH、扫码等既有功能。当前已有 APK 的 36.29 MiB 仅供背景参考，不作为严格对照基线。
2. 记录 APK 文件字节数与安装后占用；逐项比较 `lib/<ABI>/`、DEX、资源和可执行文件，区分压缩大小、未压缩大小及 APK 对齐。分别记录 debug 与实际分发构建；当前 `release` 配置没有开启代码压缩，不能假设 R8 已经缩减依赖。
3. 对 OpenSSL 与 mbedTLS 在相同 profile、同一 ABI、相同构建选项下分别测量，确认证书、算法和 TLS 功能后再选更合适的一种。必要时使用安全且可重复的 native strip、静态链接及按 ABI 分发；单个 arm64 APK 已有 ABI 限定，不能再把多 ABI 拆包当作额外节省。正式 AAB 的单设备下载量需用对应设备规格单独测量。
4. 同时验证 Android 版本、计划分发的 ABI 和 16 KiB 页面大小兼容性，保留依赖版本、许可证、构建脚本与更新来源。5 MiB 目标达不到时，以实际数字、兼容性和维护成本重新决策。

## 验收边界

- **自动化与构建**：使用临时配置/密钥和本地测试 VPN，覆盖导入失败与替换回滚、凭据不泄露、CA/服务器校验失败、账号密码加客户端证书、认证失败后清除已保存密码、LZO 协商及非对称兼容、关键指令不支持、重复连接/取消、TUN/FD 释放、socket protect、路由/DNS/IPv6 映射；按项目 APK skill 串行构建并区分 debug 与分发产物。
- **复用路径的真实 Android 设备**：验证系统 VPN 设置跳转、显示 VPN 状态与目标可达性分离；若验证外部 API，再检查授权/拒绝、选择已有 profile、连接/断开、口令提示、外部切换、卸载或更新客户端、后台恢复、Bridge 退出后 VPN 不被误断。核对现有“允许的应用”、路由，以及浏览器与系统下载行为。
- **内嵌路径的真实 Android 设备**：对比同一 profile 及相关客户端设置在截图所示现有客户端与 Bridge 中的连接、LZO 协商及双向文件/网络传输、证书验证、公司 Mac 地址、允许应用、DNS、IPv4/IPv6、拆分或全隧道路由。验证 Bridge 配对/API/WebSocket、原生 SSH/tmux、文件下载、系统浏览器 Demo；实际测试 VPN 切换、授权撤销、锁屏、前后台、Wi-Fi/蜂窝切换、断线恢复、手动断开、系统回收及通知。观察耗电和系统电池限制。
- **Web 与其他平台**：普通浏览器构建和既有 Web 行为不依赖 Android 插件；关闭内置 VPN 后既有 Bridge/SSH 连接路径仍可使用。iOS 继续走已有方式，不将 Android 测试当成 iOS 验证。
- **不作虚假推断**：APK 编译或“VPN 已连接”均不证明公司电脑可访问、DNS/路由正确或后台可持续运行；公司真实网关、手机和公司策略必须分别验收。本次没有连接公司 VPN、导入公司配置或完成华为真机验证。
