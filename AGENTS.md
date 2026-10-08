# Feishu Codex Bridge 项目约定

本文只记录项目级的架构、行为和 UI 约定，用来补充适用的用户级 AGENTS，不复制个人工作流或凭据。Codex 历史 session 用于回溯用户决策，当前源码和配置是实现现状的依据；遇到不一致先核对源码。修改前检查当前分支和工作区，保留已有改动，不要覆盖无关内容，也不要把个人凭据或本机临时状态写入文档。

## 系统服务与实现架构

`src/main.ts` 是进程入口。`execution.mode` 的活动模式为 `aamp-relay` 或 `feishu-sqlite-codex`；`feishu-sqlite-acp` 只是 Direct 的兼容别名。未设置该字段时，旧配置按 `aamp.enabled` 兼容回退，但 `LEGACY_POLLING_ENABLED` 为 `false`，所以旧 Poller 不会启动。不要让同一个 Bot 同时运行 AAMP 和 Direct。

| 子系统 | 实现 | 职责和边界 |
| --- | --- | --- |
| AAMP + Relay | `AampTaskAgentRuntime`、`AampRelayClient` | 官方 AAMP Agent 拥有 Feishu WSS/IM/CardKit 事件入口、Agent 绑定和重连；Bridge 维护 SQLite 业务记录、启动补偿和本地 Web。 |
| 原生直连 | `FeishuSqliteCodexRuntime` | `@larksuiteoapi/node-sdk` 接收 Feishu 事件，Bridge 用 SQLite 做去重、持久化任务/续问、附件状态、租约、恢复和 outbox；Codex 执行由 `@openai/codex-sdk` 完成。它不启动 AAMP、Relay、ACP 或 ACPX。`feishu-sqlite-acp` 是兼容配置别名，实际仍走 Codex SDK。 |
| Web Task Desk | `Dispatcher`、`ChildWorkerRunner`、`codex-worker` | Web 新建任务使用 `tasks/runs/outbox` 状态机和 Codex SDK worker；这条链路与原生直连消息的 `bridge_tasks` 状态机分开。tmux Dashboard 不是 Task Desk 的执行后端。 |
| 统一 Web 服务 | `DashboardServer`、`web/src/main.tsx` | 生产中由 Bridge 进程内托管；Task Desk、系统管理、Codex History 和 tmux Dashboard 共用一套 Web/API 服务与认证，不再拆成独立 verifier 服务。 |
| Codex History | `CodexHistoryService`、`CodexAppServerClient` | 通过 Codex app-server 的 `thread/list`/`thread/read` 读取，通过 Codex SDK 恢复会话；不同 `CODEX_HOME` 独立查询。不要直接解析 `auth.json`、Codex SQLite 或 JSONL 代替官方接口。 |
| tmux Dashboard | `TmuxDashboardApi`、`web/src/TmuxDashboard.tsx` | 连接 Bridge 主机已有的默认 tmux server，提供只读 xterm 输出、输入框控制和 Session 文件页；不创建隔离 tmux server，也不代表 pane 内嵌套 SSH 的目标机。 |
| 本机 Codex 通知 | `LocalCodexNotificationWatcher` / `LocalCodexNotificationInbox` | `poll` 轮询 Codex app-server，`hook` 接收 Codex 官方 notify hook。只通知本机 Codex CLI/App 的结束状态；Feishu/AAMP 任务已有卡片，不重复发本机通知。 |

- 主任务链路：AAMP 模式由官方 AAMP runtime 持有 Feishu 长连接；Direct 模式由 Lark SDK 收事件并把任务/续问写入 SQLite，再由 Codex SDK 执行，outbox 异步更新飞书卡片。Web Task Desk 是另一条由 `Dispatcher` 排队、`ChildWorkerRunner` 启动 Codex worker 的链路。
- Direct 消息中的 `项目`/`模式` 只能选择已登记的 key，不能通过消息文本指定任意仓库路径。未路由到项目时进入独立只读的非 Git 咨询目录；已登记 Direct 任务的回复应作为同一任务/线程的 follow-up。切换项目或 sandbox 时新建 Codex thread。
- Bridge Task Desk 的 Web 新建任务要求选择已启用项目，标题由描述生成，sandbox 沿用配置默认值；附件每个最多 25 MiB、每任务最多 10 个，图片作为 Codex 视觉输入。Direct Feishu 消息附件有自己的下载/恢复生命周期，不与 Web staged attachments 共用数据库记录。
- 若 Direct 复用 AAMP binding，选择顺序为当前 AAMP service selection、匹配 `lark.profile`、可用 Codex binding；只使用在线且可用的 binding。`lark-cli profile list` 只用于 profile 选择/状态，不是 Secret 来源。
- `--web-only` 只启动本地 Web API/看板和 Web Task Desk，不启动 Feishu/AAMP 消息入口。开发启动默认绑定 `0.0.0.0`：Vite 为 `5173`，Bridge API 为 `17310`；`dev`、`dev:api`、`dev:tmux-api` 脚本设置 `FEISHU_CODEX_BRIDGE_LAN_BIND=1`，`web/vite.config.ts` 的 Vite host 也为 `0.0.0.0`。`dev:web` 中的 `http://127.0.0.1:17310` 只是 Vite 本机代理目标，不是监听地址。生产 Bridge 默认仍为 `127.0.0.1:7310`。旧独立 verifier 的 `7320` 已退役。
- 生产 Web 服务默认仅监听 loopback。只有显式设置 `FEISHU_CODEX_BRIDGE_LAN_BIND=1` 才开放 LAN 监听；LAN 访问仍需配对。页面读取走授权 session，状态修改还应使用 `X-Bridge-Action-Token` 和同源校验。

## 状态、鉴权与服务生命周期

- `StateDatabase` 使用 `.bun-version` 固定的 Bun 1.4.2 和内置 `bun:sqlite`；主库默认位于当前 Bridge 数据目录 `runtime/bridge.db`，`--db` 可显式指定。SQLite schema 通过迁移保留既有数据。`projects` 表是项目注册表唯一来源，旧 project map 只在表为空时迁移；停用项目不进入任务/Session 选择器。
- `tasks/runs/outbox`、`aamp_tasks` 和 `inbound_events/bridge_tasks/bridge_task_followups` 是不同业务状态机，不能因字段相似就合并表或迁移历史。直接消息事件先做幂等去重，再持久化任务/续问、租约和附件状态；执行恢复依据 SQLite，不靠内存队列。
- `runtime/tmux-verifier.db` 是旧 verifier 留存的历史文件，不导入 `bridge.db`，当前程序不应再打开或写入它。
- Web 页面由 `WebPairingAuth` 配对 session 保护。未配对设备不能读取 Dashboard API；不要公开管理端配对码。状态修改沿用 Action Token 和 same-origin 校验；上传接口不得绕过。
- Direct 模式可只读复用 `~/.aamp/feishu-task-agent/bindings-v1.json` 中现有 Bot 凭据；不要复制 App Secret 到配置、LaunchAgent 环境或日志，也不要让 Direct 创建/启动/修改 binding。Resolver 只用在线可用的 binding；`lark-cli profile list` 不是 Secret 来源。
- 同一个 Bot 同一时间只允许一个 Feishu WebSocket 消费者。切换 AAMP/Direct 前先确认旧运行时已停止，避免重复事件、重复任务或“目标服务不存在”。
- 附件存储路径按来源区分：Direct Feishu 附件在 `runtime/direct/attachments`，Web Task Desk 有自己的 staged/task attachment 目录，tmux 文件页直接访问 session 工作目录；不要互相替代或把临时目录当成远端文件根目录。
- Feishu 事件、任务/续问状态和待投递 outbox 应先持久化，再异步调用 Codex 或 Feishu 网络接口。outbox 失败由重试恢复；不要让卡片回调等待网络发送，也不要因服务重启自动重复一条已完成任务。
- Codex app-server 的只读客户端使用 `app-server -c notify=[] --listen stdio://`，避免订阅并重放通用通知。完成提醒只接受带非空 `thread-id` 的 `agent-turn-complete`；不能把 `turn-ended` 或任意 JSON 当成完成事件。
- Task Desk 和 Direct 中的 Feishu 项目字段必须匹配项目注册表，不能指定任意本地路径。不要为新功能清空或用测试库覆盖用户的 `bridge.db`；Task Desk、Direct 和 AAMP 的任务身份/恢复规则彼此独立，不能互相推断。
- 本地开发服务重启默认使用生产主库（源码 checkout 中通常由 `runtime/bridge.db` 指向正式数据文件）；只有任务或启动参数明确指定 `runtime/dev/bridge.db` 等开发库时才切换。重启前核实进程的配置和实际 `--db` 路径，不凭 `dev:*` 脚本名称推断数据库。诊断、配对或启停服务前也先确认实际配置和 DB。`web:pair` 不带 `--db` 时连接当前 Bridge 实例的正式库，测试库必须显式传 `--db`。
- Portable 默认安装根目录为 `~/Applications/Feishu Codex Bridge`，版本目录通过 `current` 切换；升级保留该目录的 `config.json` 和 `runtime` 数据，先校验 SHA-256，再切换并支持回滚。不要把下载目录或仓库 `dist/` 当作长期运行目录。新版 `bun run release` 生成当前架构单一 Bun 二进制；旧 Core/Lite/Direct 多模式只属于 `bun run release:legacy`。
- `service start` 启动 Direct；AAMP 使用 `aamp:start` 及其对应 lifecycle 命令。若 `aamp.stopOnShutdown=false`，停止 Bridge 不代表 AAMP 已停止，需分别核实。
- Codex CLI 路径先使用有效配置，再自动发现 ChatGPT App 内置 CLI/系统 CLI；不要假定安装了 Homebrew Codex，也不要硬编码开发机个人路径。上游 AAMP 脚本可能调用 `node`/`npm`/`npx`，项目通过 Bun-backed shim 兼容，实际 runtime 仍是 Bun。

## 项目边界

- 当前 tmux 页面是 `/tmux-dashboard`，服务端由 Bridge 进程内的 `TmuxDashboardApi` 提供。旧的独立 `/tmux` verifier 已退役；不要恢复其页面、API、数据库或启动流程。
- Dashboard 连接 Bridge 主机上的现有 tmux server。它不代表 tmux pane 里可能通过 SSH 登录的另一台机器，也没有可复用的下游 SSH/SFTP 凭据。
- xterm 页面是只读的 tmux 输出视图；输入框把消息交给选中的 Codex session。不要把它当作可直接输入任意 shell 命令的终端。
- 关键入口：服务端路由与鉴权在 `src/web.ts`，tmux API 和终端流在 `src/tmux-dashboard-api.ts`，session 枚举在 `src/tmux-dashboard.ts`；React 路由在 `web/src/main.tsx`。

## Session 文件页

- 文件页位于 `/tmux-dashboard/files/:sessionId`，由 composer 的文件夹快捷键打开。返回时恢复原 session；不要把文件操作接到浏览器附件暂存目录或 Codex history。
- composer 的“＋”用于把本地附件作为 Codex 输入；文件夹快捷键用于浏览/管理 Bridge 主机上的 session 文件。两者的数据流不同，不能让一个入口替代另一个。
- 文件页根目录必须由服务端按 session ID 从 tmux session 的工作目录取得。忽略客户端提供的根路径；每次文件访问都验证 session 仍存在。
- 对文件路径执行规范化和真实路径范围检查；拒绝绝对路径和 `..` 穿越，不跟随或展示越界符号链接。新增文件 API 时保留这一边界。
- 上传写入当前浏览目录，文件上限为 100 MiB；已有同名文件返回冲突，不静默覆盖。上传请求使用 Bridge Action Token。下载由浏览器保存到用户配置的位置。
- 搜索框对当前目录的文件名做不区分大小写的模糊匹配。若要改为递归搜索，需同时考虑目录规模和遍历上限。
- 文件夹整行进入目录；文件整行打开预览。行内预览、下载操作保持独立可点击。整行点击层必须透明；hover/active 背景加在行容器上，避免遮住文件名。
- 文本预览使用只读 CodeMirror 6；当前按需高亮 JS/TS、JSON、Markdown、Python、YAML、HTML、CSS、XML。继续维护选中文字与背景色的对比度，不要让预览获得未经请求的写入能力。
- 深色模式的文件行 hover/active 使用低亮度背景并把背景加在行容器上；错误提示使用深色主题配色。不要让整行透明点击层覆盖文字或使用刺眼的白色选中底色。
- 文件页标题显示当前目录名和完整路径，返回按钮靠右；路径导航旁放刷新、上传操作，列表保持紧凑。

## Composer 与移动端

- composer 收起状态的快捷键顺序：添加附件（＋）、滚动到顶部、滚动到底部、打开 Session 文件、调试日志、导出滚动诊断。展开状态保留关闭键、顶部/底部、文件、日志与滚动诊断，再显示 Esc/方向键/回车/Ctrl 等按键。调整排列时保留＋与文件入口之间的明显间隔，避免误触。
- tmux composer 的单个附件上限是 10 MiB；不要重新引入旧的 4 张图片上限。按 session 保留未发送草稿，页面刷新/弱网恢复不能无故清空输入和附件。
- 移动端快捷键按钮至少保持 32 px 触控尺寸，快捷键之间留出间距；搜索输入字号保持 16 px，避免 iOS 聚焦时自动缩放。
- tmux snapshot 是为了减少重绘。后续滚动使用 xterm 本地 scrollback；触摸滚动不要发送远端 tmux scroll 事件。
- 关闭或重连浏览器 WebSocket 只结束 tmux attach 客户端，不得关闭 tmux session 或其中的 Codex 进程；只有用户明确触发“结束 Session”才执行 `kill-session`。
- 移动端长按选择延迟保持 3 秒；两个选区端点可独立拖动，`Copy` 按钮靠近选区。仅在复制成功后清除选区，复制失败时保留以便重试。
- 初始 `capture-pane` 快照用于减少重绘；不要把固定 60 ms 描述为最终画面已稳定。若调整捕获时序，分别复现快速输出和用户手动滚动。
- 移动端 session 详情会收起侧栏并暂停 session 列表轮询；返回列表时恢复。收起导航后不要留下空白导航行或遮挡点击的容器。

## 验证

- 前端类型检查：`bun run --bun tsc -p web/tsconfig.json --noEmit`。
- 后端类型检查：`bun run --bun tsc -p tsconfig.json --noEmit`。
- 前端生产构建：`bun run build:web`；完整构建：`bun run build`。
- 静态构建结果不代表服务已重启或浏览器行为已验证。涉及 live UI、API、tmux 或文件访问时，单独说明做过的运行时验证；不要把未执行的测试描述为通过。
