# Android Composer 配置副本

Android App 在应用私有数据库 `bridge-composer.db` 中保存已配对 Bridge 的 Composer 配置副本，供原生 SSH Composer 读取。数据库由 Android 系统 SQLite 管理，不包含 Bridge token、SSH 密码或私钥。同一 App 的覆盖升级保留应用私有数据；卸载 App 会删除它们，当前 App 不启用系统备份。

## 数据与作用域

`composer_snapshots` 保存完整 JSON 快照、格式版本和同步时间，以认证设备作用域、数据类别和可选 Session 键作为主键；`composer_meta` 只记录当前已验证的来源。认证作用域包括 Bridge 地址、安装实例和设备身份，不使用无作用域的全局缓存。不同来源的副本相互独立，切换来源只取消旧来源的当前选择，不删除旧副本；设备退出或授权撤销时清理对应来源。

| 类别 | 内容 | 更新时机 |
| --- | --- | --- |
| `shortcuts` | Web 返回的全部快捷键分组和条目，包括标题、值、类型、显示位置、顺序、启用状态、危险标记、使用次数及服务端 revision | Bridge 已验证连接后；快捷键配置变更、网络恢复或 App 返回前台时重新读取 |
| `skills` | Web 技能管理接口返回的完整技能元数据及置顶、排序偏好 | 与快捷键配置同步；Web 更新技能偏好后刷新 |
| `session-skills` | Web Composer 获取到的对应 Session 技能列表 | Web 读取该 Session 的有效技能列表后保存；键同时包含 Session ID 和创建时间 |
| `local-usage` | 原生 SSH 快捷键使用次数 | 原生点击后更新，按当前 Bridge 来源或离线作用域单独保存，不被 Web 同步覆盖 |

同步使用独立的实时读取，不把 Web 的失败回退缓存当作新数据。无效或失败的单项不会覆盖该类别原有副本，已成功读取的类别可以独立更新；请求和写入会检查当前认证来源，迟到的旧来源响应不能写入当前来源。离线时保留上次成功的副本。安装更新本身不会重置或用内置默认值覆盖数据库；用户选择的连接后同步仍会按 Bridge 当前配置更新副本。

Web 的 Session 草稿和附件仍使用既有按认证设备、Bridge 和 Session 隔离的存储。SSH 草稿和附件仍使用既有按 SSH 主机、账号和 Session 隔离的存储；它们不会因复制配置而被合并或迁移，也不把大型附件放入 SQLite。Session 技能快照属于其来源 Bridge，使用前还必须确认 SSH 主机和 Session 身份匹配，不能仅凭同名 Session 跨主机复用。

## 原生读取与演进

原生组件通过 `BridgeComposerDatabase.readActive(dataset, key)` 读取当前来源的副本；未同步时返回空值，调用方保留自己的离线默认行为。`BridgeComposerData` Capacitor 插件只接受受控的类别和 JSON 结构。新数据库只在首次创建时建表；升级或降级到未实现的 schema 版本会失败并保留原数据，后续变更必须添加显式迁移和保留数据的测试。

Android SSH Composer 读取快捷键分组、显示位置、顺序及使用次数，提供分页快捷键面板和窄屏更多菜单。没有可用副本时使用从 Web 默认配置生成的内置快照，不写入或覆盖 SQLite；更新默认配置后运行 `bun scripts/generate-native-composer-defaults.ts`，并用 `--check` 核对生成结果。

技能选择器可通过快捷键或输入 `$` 打开，插入时保留其余草稿；输入法仍在组合文字时不会触发。它优先显示经过主机和 Session 身份校验的缓存，同时通过 SSH 发现当前 Session 项目目录、tmux 的 `CODEX_HOME` 和 SSH 主目录中的技能。当前 Codex 进程也可能使用与 tmux 环境不同的账号，因此同一 Session 的 Web 缓存会与 SSH 发现结果合并；缓存仍以最近一次 Web 同步为准。无法发现时可以手动输入技能名。SSH 文件浏览从当前 Session 的实际工作目录读取，未选 Session 时从 SSH 主目录读取，不复用 Bridge 主机的文件 API。

iOS SSH 原生页面与 SQLite 插件尚未实现；iOS App 使用现有 Web 路径，不会调用 Android 插件。
