# Feishu Codex Bridge

这个项目保留三种启动模式，使用 `execution.mode` 选择；未填写该字段时继续兼容旧配置：`aamp.enabled=true` 仍默认进入 AAMP，否则进入已禁用的旧轮询路径。

- 旧兼容模式：原先轮询飞书 `Codex 工作台` 任务清单的代码仍保留，当前启动入口已禁用，不会创建 Poller/Dispatcher。
- AAMP + Relay 模式：把 `@larktask/aamp-feishu-task-agent` 作为 Feishu WSS/IM/CardKit 入口，将 AAMP host 指向内网自建 Relay；官方包继续负责飞书任务智能体、交互卡片、绑定和重连，本项目补充 SQLite 业务状态、启动补偿和本地看板。
- 原生直连模式：`@larksuiteoapi/node-sdk` 负责飞书 WebSocket 文本消息，SQLite 负责去重、任务租约和 durable outbox，`@openai/codex-sdk` 负责 Codex thread；不启动 AAMP、Relay、ACP 或 ACPX。`feishu-sqlite-acp` 仅作为此前方案的兼容配置别名，实际同样走 Codex SDK。

原生直连模式处理文本和常见图片/文件附件，并使用飞书原生流式卡片展示 Codex 进度；支持 `/cancel`、`取消`、`停止`、`中断` 取消当前任务、细粒度权限、SQLite 任务租约和启动恢复。服务不使用 Dagu、Webhook 或公网 meshmail。Web 看板默认只监听 `127.0.0.1:7310`，不允许通过配置绑定到非 loopback 地址。

## tmux Dashboard

统一启动 Bridge 后，从 http://127.0.0.1:7310/tmux-dashboard 打开 tmux Dashboard。项目名称和目录保存在 Bridge 主库 runtime/bridge.db；看板直接枚举现有 tmux server 中的实时会话，不启动独立 verifier 服务。

旧的 /tmux verifier 页面、/api/tmux 接口和 tmux-session 任务执行模式已移除。旧 tmux-verifier.db 已移回项目 runtime/，作为独立本地历史文件保留；不导入 bridge.db，程序也不再读写它，该文件不纳入 Git 提交。

## Bridge Task Desk

任务面板支持直接新建任务：选择项目后填写描述即可，不要求单独标题或模式。可附加图片及普通文件，单个文件上限 25 MiB、每任务最多 10 个；附件存入本机 Bridge 数据目录，SDK 模式会把图片作为视觉输入，并可在任务详情预览图片或下载文件。标题由描述首行生成，模式沿用服务器配置的默认 sandbox；所有新任务统一由 Codex SDK 执行；tmux Dashboard 用于浏览和操作现有 tmux 会话，不作为任务执行后端。项目管理提供名称/目录搜索、状态筛选、新增和编辑；停用项目不会出现在任务或 tmux 目录选择器中。项目表是运行时唯一来源；旧 project map 仅在 SQLite 项目表为空时迁移一次。

## Codex 历史会话

统一 Bridge 启动后，从 http://127.0.0.1:7310/codex-history 打开本机 Codex 历史页面。页面通过 Codex app-server 的只读 `thread/list` 和 `thread/read` 协议读取会话，不直接解析 `auth.json`、SQLite 或 JSONL，也不会启动任务、继续会话或写入 Bridge 数据库。

默认会读取当前 `CODEX_HOME`（未设置时为 `~/.codex`）以及 `~/.codex/accounts/*` 下的独立 home；每个 home 都会用自己的 `CODEX_HOME` 和状态数据库目录启动一个短生命周期查询客户端，因此两个登录账号的历史不会混在一起。若账号目录不在这个结构中，可用系统环境变量 `FEISHU_CODEX_HISTORY_HOMES`（macOS 用冒号分隔多个绝对路径）补充路径。页面支持按 home、关键词、归档状态和运行状态筛选，并可打开会话轮次与命令执行详情。

## 安装和配置

研发环境需要 Bun >=1.4.2（项目通过 `.bun-version` 固定版本）；CI、开发脚本、LaunchAgent 和 Portable Runtime 均使用 Bun，不需要 Node.js。给非研发同事使用时，Portable 发布包可以直接双击 `install.command`；安装器会自动寻找 ChatGPT App 内置 Codex 或本机独立 Codex CLI，不要求手动填写 CLI 路径。

```bash
bun --version # requires >= 1.4.2
bun install
bun link --global
feishu-codex-bridge install
```

`feishu-codex-bridge install` 会依次完成：

1. 没有 `config.json` 时交互式初始化；已有配置默认保留，只在原 Codex 路径失效时自动修复 `codex.cliPath`。
2. 执行 Bun、Codex CLI、Feishu 凭据、路由、SQLite 和编译产物检查。
3. 生成并启动 macOS LaunchAgent。

初始化时不再要求输入 Git 仓库；Codex 路径会自动检测，Feishu App ID/Secret 和代理可选。需要预登记项目时再使用高级参数 `--repo /absolute/path/to/repository`；没有项目字段的消息仍可走只读咨询路径。已有 AAMP binding 时，Feishu 凭据可以留空。需要只生成服务而暂不启动时使用 `feishu-codex-bridge install --no-start`；只初始化或排障时仍可使用 `feishu-codex-bridge init` 和 `feishu-codex-bridge doctor`。

### Portable Runtime 发布包

给没有 Bun 环境的接收方使用时，可以构建按 macOS CPU 架构划分的便携压缩包。双击 `install.command` 后，安装器默认把发布包复制到 `~/Applications/Feishu Codex Bridge`，不会把 Downloads 目录作为长期运行目录；默认目录可在 `install.defaults` 中修改，也可以在安装时输入其他目录。

新的 release 入口只生成当前 macOS 架构的 Bun 单一二进制包。旧的 core/lite/direct 多模式打包逻辑保留在 legacy 入口：

```bash
bun run release
bun run release:legacy -- --mode lite
bun run release:legacy -- --mode core
```

如需一条命令完成重建、使用真实配置/数据库从新 `release/` 包重启直连服务，并校验 LaunchAgent 状态：

```bash
bun run portable:restart
```

该命令会先完成构建和 smoke test，再执行带有 `--config`、`--db` 和 `--mode feishu-sqlite-codex` 的 `service restart`，最后执行 `service status`；构建失败时不会停止正在运行的服务。可用 `--config <path>`、`--db <path>` 和 `--mode <mode>` 覆盖默认值，`--skip-build` 仅重用现有 `dist` 打包。

发布 GitHub Release（默认使用 `package.json` 版本生成 `v0.4.0` tag）：

```bash
bun run release:github
```

该命令当前只构建新的 Bun 单一二进制包，Core/Lite 打包步骤暂时停用；随后提交并推送当前分支和版本 tag，GitHub Actions 会构建 macOS arm64 包并上传到对应 Release。仍可用 --tag、--message、--skip-build 或 --dry-run 覆盖默认行为。

产物默认写入根目录 `release/`，包含已构建的 Bridge 和生产依赖，不包含源码、测试、配置密钥或运行数据。新的 Bun 单一二进制包由包内编译产物直接启动，不再携带或下载独立 Bun runtime；legacy 包继续使用原有 runtime/launcher 逻辑。可以用 `--output <path>` 覆盖默认目录。接收方解压后可以直接双击 `install.command`；也可以执行：

```bash
./feishu-codex-bridge install
```

Lite 包默认不包含 Bun 和独立 Codex CLI；它属于 legacy 打包路径，启动器会按需下载并缓存 Bun。`codex:update` 在便携包中被禁用，升级时使用下面的 Portable 更新命令。

新的默认发布入口生成当前架构的 Bun 单一二进制 Direct 包，不携带独立 Bun runtime。Core/Lite legacy 构建器暂时不参与 GitHub Release；Direct 首次安装仍可能需要联网准备 lark-cli 原生二进制。

已安装 Portable 包的自动更新现在下载版本化 Direct 包，先下载并验证 SHA-256，再执行完整版本替换。固定安装根目录中的 config.json 和 runtime 数据在版本切换时保留；失败会回滚。Core/Lite 包型暂时不再由 GitHub Actions 打包。

```bash
./feishu-codex-bridge update
./feishu-codex-bridge update --check
./feishu-codex-bridge update --schedule
./feishu-codex-bridge update --auto
./feishu-codex-bridge update --file ./feishu-codex-bridge-core-darwin-arm64.tar.gz
# 如需完整替换为 direct 包：
./feishu-codex-bridge update --mode direct --file ./feishu-codex-bridge-direct-darwin-arm64-v0.4.0.tar.gz
./feishu-codex-bridge update --unschedule
```

已有配置启用 AAMP 时，请使用 `./feishu-codex-bridge aamp:start --config <path>`；`service start` 仅启动原生直连 Codex，不会显示 AAMP 的任务统计。

### 全局 CLI

首次在项目目录中执行一次全局链接：

```bash
bun link --global
```

之后可以在任意目录直接调用项目中的全部 `bun run` 脚本，命令会自动回到本项目根目录执行：

```bash
feishu-codex-bridge list
feishu-codex-bridge aamp:status
feishu-codex-bridge aamp:task -- ff96da58
feishu-codex-bridge test
feishu-codex-bridge install
```

也支持显式的 `run` 形式：`feishu-codex-bridge run aamp:restart`。CLI 会从当前 `package.json` 动态读取脚本，因此新增脚本后无需再修改命令行包装器。更新本项目代码后重新执行一次 `bun link --global` 即可刷新全局链接。

项目已经将 `@larktask/aamp-feishu-task-agent` 加入依赖，并由 lockfile 锁定当前 dev 版本，推荐通过项目脚本调用它：

```bash
bun run aamp:install   # 首次绑定 Agent 和飞书 Bot
bun run aamp:status
bun run aamp:start
```

上游 AAMP Agent 的部分脚本仍以 `node`、`npm` 和 `npx` 命令名启动子任务。桥接服务为这些入口提供 Bun-backed 兼容 shim，并将全局包、二进制和缓存限定在项目运行目录；实际执行器仍是固定版本的 Bun。

SQLite 使用 Bun 内置的 `bun:sqlite`，不需要安装或编译原生数据库扩展。项目通过 `.bun-version` 固定 Bun 1.4.2，以保证运行时 SQLite API 一致：

```bash
bun --version
bun -e 'import("bun:sqlite").then(() => console.log("bun:sqlite available"))'
```

配置中的每个已登记仓库必须是已存在的 Git 仓库。原生直连允许暂不登记项目和模式，等任务派发时再通过路由头选择；默认示例映射为：

```text
food      -> /Users/xiajian/works/boohee/food
go-boohee -> /Users/xiajian/works/boohee/go-boohee
```

启动前检查当前用户的系统 Codex 登录状态：

```bash
codex login status
```

### 原生直连模式

将配置切换为：

```json
{
  "execution": { "mode": "feishu-sqlite-codex" },
  "direct": {
    "feishu": {
      "appIdEnv": "FEISHU_APP_ID",
      "appSecretEnv": "FEISHU_APP_SECRET",
      "groupAllowlist": [],
      "dmMode": "open",
      "dmAllowlist": [],
      "allowedSenderOpenIds": [],
      "requireMention": true,
      "replyInThread": false
    },
    "permissions": {
      "defaultAllow": true,
      "allowAttachments": true,
      "allowCancel": true,
      "rules": []
    }
  }
}
```

如需在本机收到 Codex 任务完成提醒，可以开启 macOS 系统通知轮询；不发送飞书消息，也不改变任务提交方式：

```json
{
  "localNotifications": {
    "enabled": true,
    "intervalSeconds": 60
  }
}
```

服务会每 60 秒查询 Codex app-server 中来源为 `cli` 或 `appServer` 的线程，只在观察到线程从运行中进入完成或错误状态时调用 macOS Notification Center。首次启动只建立历史线程基线，不会重复提醒旧任务。通知状态保存在 `runtime/codex-local-notifications.json`；Bridge/AAMP 任务已经有飞书卡片，因此不再由本地通知 watcher 发送。

macOS 通知由主服务异步发送，不依赖额外的原生通知组件，也不会阻塞事件循环。来自 ChatGPT App（`appServer`）的任务会先发送通知，10 秒后执行 `/usr/bin/open -b com.openai.codex`；来自 Codex CLI（`cli`）的任务只发送通知，不打开 ChatGPT App。这个定时器保持引用，因此 `--once` 通常也会等待延迟动作完成；如果进程被强制终止，延迟打开仍会丢失。

安装器还会配置 Codex 官方用户级 `notify` hook。它会保留已有的 Computer Use 通知程序，并链式调用 Feishu Bridge；安装后 `localNotifications.mode` 为 `hook`，不再使用 thread 轮询。若需要恢复旧方案，可将该字段改回 `poll`。ChatGPT App、Codex CLI 与 IDE 使用同一个 `CODEX_HOME` 时共享该用户级配置；修改后需要重启 ChatGPT App。

如果已经通过 `bun run aamp:install` 绑定过 Codex，直连模式会只读复用
`~/.aamp/feishu-task-agent/bindings-v1.json` 中同一个 Codex Bot 的凭据；不需要再把
`appId`/`appSecret` 写入 `config.json`，也不需要把 Secret 放进 LaunchAgent 环境变量。
直连模式不会启动或修改 AAMP 服务。若没有 AAMP binding，仍兼容原来的显式配置和环境变量
方式：

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx bun run start -- --config ./config.json
```

AAMP binding 的选择顺序是当前 AAMP service selection、`lark.profile` 匹配和可用的 Codex
binding；只使用 `state=ready/pending` 且 `environment=online` 的记录。AAMP binding store
是本地受保护的凭据文件，直连适配器只读它，不调用 AAMP 的写入/启动流程。若同时运行 AAMP
和原生直连，请先停止其中一个，避免同一个 Bot 建立两个长连接。

`lark-cli profile list` 只能列出 profile 和校验状态，不会把 App Secret 返回给调用方；因此公共
适配层以 AAMP 的 binding store 作为 Bot 凭据来源，以 lark-cli profile 作为辅助选择信息。这与
官方 AAMP 的存储边界一致，也避免在直连模式中复制一份 Secret 配置。

直接模式会使用安装器自动发现的 Codex 路径：Codex SDK 负责启动和消费 Codex thread，不依赖 ACP/ACPX。`项目` 和 `模式` 都是消息中的可选路由字段。没有填写 `项目` 时，Bridge 将任务视为通用技术咨询，不会假定某个仓库或项目，也不会因为缺少路由而把任务标记为失败；该咨询会在独立的只读非 Git 目录中执行。填写 `项目：<projectKey>` 后，才进入对应仓库的项目任务路径；此时 `模式` 仍可省略并使用默认实现模式。项目/模式注册表本身也可暂时为空，只要当前消息不要求进入具体项目。

任务消息支持以下独立行格式（中文或英文均可）：

直连模式中 `模式` 行为可选；未指定时默认使用 `implement`，无模式注册表时使用内置 `implement/workspace-write` 默认。

```text
项目：food
模式：implement

修复食物单位换算问题，并运行相关测试。
```

也支持 `project: food`、`mode=implement`。当消息没有路由头时，会依次使用 `direct.projectKey`/`direct.mode`；如果对应注册表恰好只有一个值，也会自动使用唯一值。项目和模式仍必须来自配置注册表，不能通过 Feishu 文本绕过本地仓库白名单。飞书消息、Codex 事件、卡片状态和附件元数据会先写入 SQLite；卡片流和卡片操作响应都通过独立 outbox worker 投递，不会让卡片回调等待 Feishu 网络请求。图片作为 `local_image` 输入，文件以任务专属本地路径提供给 Codex；附件保留在 `runtime/direct/attachments/<bridge-task-id>/` 供故障排查和恢复复用。同一会话会复用已保存的 Codex thread；切换到不同项目或沙箱模式时会自动新建 thread，避免跨仓库恢复旧会话。任务卡片按“状态摘要—请求/进度/结果折叠区—操作区”分组，执行期间也能点击“查看详情”，不必先发送 `/recent`。回复直连任务的原始消息、机器人结果卡或 Feishu thread 时，会作为同一任务的后续 turn 处理，不会新增任务 ID，并继续更新原卡片；续问中省略的项目和模式会继承父任务。

权限规则按 `chatId`、`senderOpenId`、`chatType` 匹配，匹配字段越多优先级越高；规则可分别控制消息、附件和取消能力。例如：

```json
{
  "direct": {
    "permissions": {
      "defaultAllow": false,
      "allowAttachments": false,
      "allowCancel": true,
      "rules": [
        {
          "chatId": "oc_personal",
          "senderOpenId": "ou_owner",
          "allow": true,
          "allowAttachments": true
        }
      ]
    }
  }
}
```

取消只作用于同一会话中当前用户的任务，或显式指定同一会话/用户的任务 ID。服务重启时会接管上次运行留下的任务，复用已保存的 thread 和附件；这是 at-least-once 恢复语义，极端崩溃窗口内 Feishu 可能收到重复卡片，但不会静默丢弃已落库任务。卡片投递连续失败后会降级为文本回复。

原生直连提供独立的 `codex:` 命令组，不会调用 AAMP：

```bash
bun run codex:doctor
bun run codex:install     # 只生成 plist；即使 config.json 仍是 AAMP 模式也可执行
bun run codex:start       # 安装并启动原生直连 LaunchAgent
bun run codex:status
bun run codex:recent -- --limit 10
bun run codex:notify  # 前台运行本机系统通知轮询器
bun run codex:threads -- --project food --source cli,appServer
bun run codex:thread -- thr_123 --turns
bun run codex:task -- bridge_20260910 --json
bun run codex:cancel -- bridge_20260910 --reason "不再需要"
bun run codex:retry -- bridge_20260910
bun run codex:logs -- --follow
bun run codex:stop
# bun run codex:uninstall # 停止并删除 LaunchAgent plist
```

完整帮助使用 `bun run codex -- --help`。`codex:` 命令默认把本次进程的执行模式覆盖为 `feishu-sqlite-codex`，不会修改 `config.json`；也可以显式使用 `--mode feishu-sqlite-acp`（兼容别名）或 `--execution-mode feishu-sqlite-codex`。例如：

```bash
bun run codex:install -- --mode feishu-sqlite-codex
bun run codex:start -- --execution-mode feishu-sqlite-codex
bun run start -- --mode feishu-sqlite-codex
```

`codex:install`/`codex:setup` 只生成用户目录下的 LaunchAgent，不自动启动，且不要求当前 `execution.mode` 已经是直连模式；`codex:start`/`codex:restart` 会把选中的直连模式写入 LaunchAgent 的 `--execution-mode` 参数，再启动服务。实际启动不要求 `direct.projectKey`、`direct.mode`，但首次处理任务时必须能从消息路由头、默认值或唯一注册表项解析出项目和模式；飞书凭据仍必须有效。`--bun /path/to/bun` 可显式指定 LaunchAgent 使用的 Bun；默认会优先寻找满足 `>=1.4.2` 的 Bun，不依赖 launchd 加载 shell 配置。`codex:uninstall`/`codex:remove` 会停止并删除该 plist；`codex:recover` 负责接管已过期任务，`--force` 前必须先停止服务。`codex:task` 会同时显示任务事件、附件和 durable outbox，`codex:worktrees` 只查看配置仓库的 Git worktree，原生直连不会像 AAMP ACP 模式那样为每条消息创建隔离 worktree。

`codex:threads`/`codex:thread` 是独立的只读 Codex app-server 查询，不会写入 Bridge SQLite，也不会启动或继续执行任务。默认查询未归档的 `cli` 和 `appServer` 来源；可用以下参数筛选：

- `--source cli,appServer` 或重复传入 `--source`：线程来源。
- `--project food`：按已配置项目对应的仓库路径筛选；也可以使用重复的 `--cwd /absolute/path`。
- `--provider openai`：模型提供方；`--search TEXT`：按 Codex 提取的线程标题搜索。
- `--archived`：只查询归档线程；默认只查询未归档线程。
- `--status active,idle`：按运行时状态筛选；`--since`/`--until`：按最近更新时间筛选，接受 ISO 日期/时间。
- `--sort recency_at --direction desc`：排序字段和方向；`--limit N`、`--cursor CURSOR`：分页。
- `--json`：输出结构化结果；使用 `codex:thread -- <thread-id> --turns` 查看指定线程的只读轮次详情。

状态和时间筛选属于本地二次筛选，因此会分页读取最多 10,000 个匹配来源的线程后再计算结果；默认 `useStateDbOnly=true`，避免查询为了修复 Codex 元数据而扫描并更新 JSONL 日志。App、CLI 和 Bridge 必须使用同一个本地 Codex 状态目录（默认 `~/.codex`，或同一个 `CODEX_HOME`），否则不会出现在同一份查询结果中。

直连服务的容错策略：LaunchAgent 保持 `KeepAlive`，并设置 `ThrottleInterval=10` 防止异常退出时快速重启风暴；`codex:start`/`codex:restart` 对 launchd 的 `Operation already in progress`（exit 37）使用串行锁和指数退避。Feishu WebSocket 的 ping 频率由服务端下发，客户端使用 5 秒的 liveness watchdog；连接长期处于 `reconnecting`/`idle` 或进入 `failed` 时由健康检查重建通道，连续 3 次恢复失败则退出进程交给 LaunchAgent 重启。初次连接失败会在进程内重试。Codex 的网络断开、连接重置、临时服务不可用、限流和 SQLite busy 等暂时性错误默认最多尝试 3 次，等待 5 秒、10 秒、20 秒并加入少量抖动；认证、权限、配置和明确的业务/执行错误不会自动重跑。可在 `direct.retry` 中调整 `maxAttempts`、`initialDelaySeconds` 和 `maxDelaySeconds`。

`codex:update` 默认更新项目中的 `@openai/codex-sdk` 依赖；`codex:update -- --check` 只检查 SDK 和系统 Codex CLI 版本，不会自动升级系统 CLI。LaunchAgent 不会继承当前终端临时 `export` 的飞书凭据；后台运行时优先复用 AAMP binding，也可以在未提交的 `config.json` 中配置凭据，或在用户目录的 plist 中配置环境变量。

如果要继续使用当前 AAMP 入口，保留 `execution.mode: "aamp-relay"`（或删除 `execution` 并设置 `aamp.enabled: true`）。

`config.json` 中的 `codex.cliPath` 由安装器自动写入。macOS 上会优先使用独立 Codex CLI；找不到时会查找 ChatGPT App 的内置路径，例如 `/Applications/ChatGPT.app/Contents/Resources/codex`。桥接通过 SDK 的 `codexPathOverride` 调用该路径，不使用 `node_modules` 中随 SDK 安装的 Codex 二进制。

如果使用 AAMP 隔离 profile，`lark.profile` 必须填写完整名称，`lark.configDir` 必须指向同一个配置目录；不会在 profile 不存在时静默改用 `work` 或其他 profile。例如：

```json
{
  "aamp": { "enabled": true, "stopOnShutdown": false },
  "relay": {
    "enabled": true,
    "aampHost": "http://127.0.0.1:8787",
    "statusUrl": "http://127.0.0.1:8787/api/tasks"
  },
  "lark": {
    "profile": "aamp-feishu-task-cli_aa1c1a04feb89d24",
    "configDir": "/Users/xiajian/.lark-cli-aamp-one-click-v1",
    "cliPath": "/Users/xiajian/.aamp/npm-global/bin/lark-cli"
  }
}
```

检查 profile 时也要使用同一个目录：

```bash
LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-aamp-one-click-v1" \
  lark-cli profile list
```

桥接服务不会设置 `CODEX_API_KEY`，也不会把 `LARK_*` 或 `FEISHU_*` 凭据传给 Codex agent。AAMP 官方控制器创建在线环境时会清理代理变量；适配层将配置的 `HTTP_PROXY`、`HTTPS_PROXY` 暂存为 `AAMP_TASK_HTTP_PROXY`、`AAMP_TASK_HTTPS_PROXY`，由运行时加载补丁在官方清理后恢复到 AAMP/ACP/Feishu 子进程环境，同时在 `runtime/aamp/bin` 生成不包含密钥的 `codex`/`lark-cli` shim。macOS 服务还会通过同一目录下的 `xattr` shim 跳过官方 quarantine 检查，避免每次启动触发约 6 秒的权限处理；不修改 `node_modules`。

这里的 `lark-cli` shim 不只放在 PATH 中：适配层会把它作为绝对路径写入官方 Feishu task runtime 的 `feishu.cliBin`，因此 Agent prompt 中即使使用绝对路径，也会进入正确的 AAMP profile/config 目录。macOS launchd 使用项目的绝对 bootstrap 路径，在服务启动前注入运行时补丁与 CLI 环境，保证服务自动拉起时继续生效。官方包本身不被修改，升级依赖后 shim 会在下一次 AAMP 命令时重新生成。

官方 Bridge 重启时会重放历史 mailbox 事件；对于仍处于 `help_needed` 状态的任务，某些版本会再次创建相同的帮助卡。IM 使用 SDK 发送卡片，不能仅依靠 lark-cli shim 去重。项目通过 `BUN_OPTIONS --preload` 在加载官方 `FeishuBridgeRuntime` 时安装求助卡补丁：已有卡片且问题相同时跳过重放，问题变化时更新原卡，同一任务的并发事件串行处理。更新失败保留原卡 ID，不回退新增消息。补丁复用官方持久化 state，不修改 node_modules；上游运行时接口变化时会明确报错，升级后需重新验证。

AAMP 流式回复卡片和等待补充信息的求助卡会显示“中断执行”按钮。点击后适配层通过官方 `AampClient.sendCancel()` 向任务原目标发送 `task.cancel`，目标 ACP agent 会终止当前 Codex turn；原卡随后更新为“本轮执行已中断”，不会另发一张结果卡。重复点击是幂等的；如果发送失败，原卡会保留“重试中断”按钮。服务级停止仍使用 `bun run aamp:stop`。

AAMP 本地 ACP agent 支持按任务隔离。开启 `aamp.worktree` 后，只有任务正文或 dispatch context 中存在且命中 Bridge SQLite 可用项目的 `项目：<名称>` 才进入隔离流程；每个命中任务会先写成独立 Markdown 文件，再从配置的 `baseRef` 创建唯一分支和 Git worktree，ACP session 使用该 worktree 作为 `--cwd`。没有项目字段的聊天任务继续使用官方 AAMP 路径；项目字段存在但未登记或已停用时会报告路由错误，不会猜测目录或在错误项目中执行。这保留了官方 AAMP 的消息、附件、流式卡片和 `task.cancel`，不会在已经运行的 ACP/Codex 会话里再嵌套调用 `codex-worktree`。任务完成或中断后会关闭该任务的 ACP session，但保留任务文件、分支和 worktree 供检查，也不会自动 commit、push、merge、部署或删除。

`worktreeRoot` 是所有项目 worktree 的公共父目录，项目名会由运行时追加一次。例如配置为 `/Users/xiajian/.codex/worktrees` 时，`food` 项目的任务目录为 `/Users/xiajian/.codex/worktrees/food/wt-<前两个任务词>-<任务哈希>`，不会把接收任务的桥接仓库名（如 `ai-work`）放进路径。分支格式为 `<branchPrefix>/<项目名>/<3-4 个有效任务词>-<任务哈希>`。

```json
{
  "aamp": {
    "enabled": true,
    "stopOnShutdown": false,
    "worktree": {
      "enabled": true,
      "globalAgentsPath": "/Users/xiajian/.codex/AGENTS.md",
      "taskDir": "/Users/xiajian/works/ai_work/codex/tasks",
      "worktreeRoot": "/Users/xiajian/.codex/worktrees",
      "baseRef": "HEAD",
      "branchPrefix": "xiajian/agent"
    }
  }
}
```

任务文件名为 `aamp-<project>-<task-id>-<hash>.md`；运行时元数据保存在项目忽略的 `runtime/aamp/worktree-tasks/`。同一任务事件被重放时会复用原 worktree，不会再创建一份。若源 checkout 有未提交修改，隔离任务仍从 `baseRef` 的已提交版本开始，prompt 会明确提示这些本地修改没有被复制。

可以用项目 CLI 查看最近执行情况：

```bash
bun run aamp:recent -- --limit 10
bun run aamp:recent -- --limit 10 --full-message
bun run aamp:task -- ff96da58       # 支持完整 ID 或唯一前缀
bun run aamp:task -- ff96da58 --json
bun run aamp:worktrees
```

`aamp:recent` 汇总任务状态、项目、worktree、原始消息摘要和最近 AAMP run；默认显示每条消息前 1200 个字符，使用 `--full-message` 展开已保存的完整消息。`aamp:task` 进一步显示任务文件、分支、基线、事件、日志目录、完整用户消息和 worktree 当前 Git 改动；`aamp:worktrees` 只列出已经生成隔离 worktree 的任务。`aamp:inspect` 是 `aamp:task` 的别名。命令只读本地元数据、AAMP 日志和状态文件，不会操作飞书或修改 Git。

看板配置默认值如下；`enabled` 可用于临时关闭页面，`host` 固定为 loopback：

```json
{
  "web": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 7310
  }
}
```

## 飞书任务约定

在指定清单中创建两个单选自定义字段：

- `项目`：每个选项 GUID 映射到 `config.json` 中的一个本地仓库。
- `模式`：`实现` 使用 `workspace-write`，`审查` 使用 `read-only`。

任务必须属于配置的清单，且项目和模式都必须是已知单选项。第一次创建 thread 后项目会锁定；切换项目会进入 `BLOCKED_CONFIG`，需要新建任务。

修改标题或描述会触发同一 Codex thread 的下一轮执行。描述只在末尾追加内容时，发送新增内容作为反馈；其他修改发送更新后的完整需求。任务完成表示验收；运行中的任务被完成时会请求取消。

桥接服务不会自动 commit、push、merge、发布或删除仓库。

## 运行

默认读取当前目录的 `config.json`，数据库和日志放在 `runtime/`：

```bash
bun run start:all
```

当 `aamp.enabled=true` 时，主入口启动 AAMP + Relay 和 Web 看板；旧任务清单的轮询、Dispatcher 执行链已经禁用。打开 <http://127.0.0.1:7310> 可以查看只读任务看板和 AAMP 状态接口：

- 按状态、项目和模式筛选任务。
- 按标题、描述、任务 GUID、Codex thread ID 或错误文本搜索。
- 查看正在执行任务的 Worker、Codex turn/item 事件和最后进展。
- 查看任务的完整 run 历史、提示词、最终响应、usage 和飞书 outbox 状态。
- 旧兼容模式的中断、反馈操作接口仍保留在代码中，但当前入口不会启用。
- React 页面通过 SSE 接收任务状态、run 进展和执行事件变化，只更新受影响的任务行和详情区块；连接断开时自动使用快照轮询并重连。
- 详情弹窗持续显示实时进展，反馈草稿和操作状态由前端组件独立维护，不会被进展更新覆盖；“刷新详情”用于主动校准完整快照。

查询接口为 `GET /healthz`、`GET /api/session`、`GET /api/tasks`、`GET /api/tasks/:taskGuid`、`GET /api/aamp/tasks`、`GET /api/aamp/tasks/:id`、`GET /api/codex/homes`、`GET /api/codex/threads`、`GET /api/codex/threads/:homeId/:threadId` 和 `GET /api/events`；旧兼容模式的 `POST /api/tasks/:taskGuid` 操作接口当前不会配置 Dispatcher。页面包含 CSP、禁止 iframe 和 `no-store` 响应头。系统安装的服务支持局域网配对，任务 API、Codex history API、tmux API、SSE 和终端 WebSocket 都要求已配对会话；不要将服务暴露到公网。

页面支持一次性配对。系统安装后运行 `feishu-codex-bridge web:pair`，源码目录运行 `bun run web:pair`；CLI 自动选择当前机器的局域网 IPv4 和 `config.json` 中的 `web.port`（默认 7310），并始终写入生产库 `runtime/bridge.db`。可用 `--url`、`--port` 覆盖地址，或用 `--db` 显式指定数据库；URL/端口不会自动切换到开发库。手机扫描二维码后，网页从 URL fragment 自动 claim，服务端签发一个 30 天 HttpOnly 会话 Cookie，二维码 5 分钟后失效且只能使用一次。未认证网页只显示等待扫码提示。认证后从 `/pair-admin` 进入设备管理，可查看已配对设备并撤销所有手机；刷新配对码需重新运行 `web:pair`。配对状态保存在 Bridge 使用的 SQLite 数据库中。\n
前端源码位于 web/，生产构建输出到 dist/web，由同一个 Bridge Bun 进程静态托管。开发时运行 bun run dev:api 和 bun run dev:web，然后打开 http://127.0.0.1:5173。开发 API 监听 127.0.0.1:17310，只使用 runtime/dev/bridge.db，不触碰 LaunchAgent 的服务或 7310 生产数据库，也不会启动 Feishu/AAMP/Relay/Codex 消息运行时；Vite 的 Bridge 和 tmux Dashboard API/WebSocket 都代理到这个开发 API。dev:api 默认读取 config.example.json，也可用 --config、--db、--web-port 覆盖配置、数据路径和端口；Vite 目标可用 BRIDGE_WEB_API_TARGET 覆盖。tmux Dashboard 连接现有默认 tmux server。发布或 LaunchAgent 启动前仍须执行 bun run build。\n
开发环境中的 `dev:api` 和 `dev:tmux-api` 都启动当前 `src/main.ts --web-only`，监听 17310 并使用 `runtime/dev/bridge.db`；`dev:web` 的 Vite `/api` 代理只指向这个开发 API，不依赖 7310 生产服务。开发模式会自动发现可用的 Codex CLI 路径。

默认 `runTimeoutSeconds` 为 `3600` 秒（1 小时）；超时会先终止 Worker，必要时再强制结束，并将本轮标记为失败。

也可以显式指定配置和数据库：

```bash
bun run start:all -- --config ./config.json --db ./runtime/bridge.db
```

如果使用 `bun run start:all -- --config ...`，程序也会兼容这个额外的参数分隔符。

`lark-cli` 调用使用参数数组，不经过 shell。清单的 `tasklist_guid`、分页参数和 `completed: false` 统一通过 `--params` 传入，兼容当前 CLI 的通用参数接口。默认从 PATH 查找 `lark-cli`，也可以在配置中设置绝对路径 `lark.cliPath`，或通过 `LARK_CLI_PATH` 覆盖。

当 `aamp.enabled` 为 `true` 时，`bun run start` 或 `bun run start:all` 会先打开共享 SQLite 并执行一次 `running` 任务补偿查询，再调用官方 `feishu-task-agent start`，同时启动同一进程内的 SQLite 看板。旧 Poller、Dispatcher 不会启动；AAMP Relay 负责任务触发和流式事件，运行时补丁在 `task.dispatch` 发送前和 `task.update/task.result/task.failed` 生命周期写入 SQLite。

推荐使用：

```bash
bun run build
bun run start:all -- --config ./config.json --db ./runtime/bridge.db
```

`start` 和 `start:all` 当前是同一套 AAMP + Web 入口；`start:all` 只是明确表达“启动完整桥接服务”。如果 `aamp.enabled` 没有打开，程序会直接提示旧轮询模式已禁用，不会启动轮询。

也可以单独使用：

```bash
bun run aamp:restart
bun run aamp:restart -- --cold  # 强制走官方 bootout/bootstrap 冷重启
bun run aamp:logs
bun run aamp:stop
```

`aamp:restart` 在 macOS 上默认使用适配层的快速重启：保留已经加载的
`com.larktask.aamp-feishu-task-agent` launchd 服务，只执行 `launchctl kickstart -k`
并等待新的 `readiness.json`。这样可以跳过一次 `bootout/bootstrap` 以及命令入口的
重复 bootstrap；如果服务未加载、plist 仍指向官方 bootstrap、存在额外官方参数或
快速路径在发出 kickstart 前失败，会自动回退到官方冷重启。快速路径默认最多等待
5 分钟 ready；如果只是启动较慢而超时，不会立即再启动一遍服务，避免把两次启动
时间叠加，命令会报错并保留当前服务供继续排查。`--hot` 可以显式选择快速路径，`--cold`
可以用于排障或需要完整重载 launchd 配置的场景。这里的“热”是服务级快速重启，
ACP/Codex 和 Feishu Bridge 进程仍会重新建立；官方包没有提供进程内重载接口，因而
不会伪造真正的进程内热更新。

每次 `restart` 都会在终端逐阶段输出开始/结束日志，并将结构化记录追加到
`~/.aamp/logs/restart-phases.jsonl`（也可用 `AAMP_RESTART_TRACE_FILE` 覆盖）。命令
结束时会汇总官方运行目录中的 bootstrap、ACP、Codex、Feishu Bridge 和 readiness
耗时。ACP/Codex 与 Feishu Bridge 可能并行启动，表格中的阶段耗时不可直接相加；若
出现前序启动尝试未完成，也会在汇总中标出失败原因。“服务 ready”只表示最终选中
的那次 service run 从 bootstrap 日志开始到 ready 的耗时；“总耗时”才是整个 restart
命令从开始到最终 ready 的累计耗时，其中可以包含超时、前序尝试和冷重启回退。

ready 等待上限可用 `AAMP_RESTART_READY_TIMEOUT_MS` 覆盖，取值范围为 5 秒到 15 分钟。

适配层还把 Bun 的包缓存固定到 `~/.aamp/npm-cache`，避免 macOS 清理 `TMPDIR` 后出现
`_cacache/... ENOENT` 并触发一次额外的 launchd 重试；可通过 `AAMP_NPM_CACHE_DIR`
覆盖该目录。

`aamp.stopOnShutdown` 默认是 `false`，表示 Bridge 退出时保留官方 launchd 服务；如果希望 Bridge 进程退出时一并停止它，改成 `true`。

### AAMP Relay + SQLite 状态

`relay.aampHost` 会通过 `AAMP_TASK_AAMP_HOST` 传给官方 Feishu/AACP Bridge，必须填写内网 Relay 地址；不要填写 `https://meshmail.ai`。`relay.statusUrl` 只用于启动时对 SQLite 中 `running` 任务做一次状态对齐，不会轮询抢任务。

SQLite 的 `aamp_tasks` 表以 `aamp_task_id` 为主键，保存 `chat_id`、CardKit `card_id`、卡片消息 ID、图片本地路径、累计 Markdown、审批按钮状态、错误和会话快照。AAMP 运行时补丁使用同一个 WAL 数据库连接写入；看板可通过 `GET /api/aamp/tasks` 和 `GET /api/aamp/tasks/:id` 查看这些业务状态。

### 全局飞书斜杠命令

AAMP 和原生直连模式都会在 Feishu 入站消息进入正常任务派发前拦截以下简单命令，并返回同一套 V2 卡片；未知的斜杠命令仍按普通任务交给当前 Agent：

- `/help`：列出当前支持的全局斜杠命令。
- `/cancel [任务ID]`：取消当前接入模式中的活动任务。
- `/status`：返回当前接入模式、Feishu/AAMP 连接状态，以及 AAMP/直连任务计数。
- `/usage`：返回本机最近的 Codex 账户限额快照，以及当前 Feishu 会话对应的 AAMP ACP 累计 token 用量。
- `/recent`：以飞书卡片合并列出当前会话最近的 10 个 AAMP 和直连任务，按更新时间倒序，每条明确标注接入模式。
- `/tasks <任务ID>`：显示 AAMP 或直连任务详情；任务 ID 支持完整值或唯一前缀。

`/threads` 与当前 Feishu 接入模式无关；它会展示当前会话的 AAMP 任务，并补充本机 Codex App/CLI threads。卡片会为每条任务/thread 单独显示“查看详情”或“查看执行”操作，点击后查看具体执行情况。支持的筛选参数见上文。

仅以下诊断和恢复命令属于原生直连任务，AAMP 任务不会在这些命令或卡片中展示：

- `/thread`：当前 thread ID、项目、模式和最近任务。
- `/resume <任务ID或thread ID>`：从历史 Codex thread 创建一轮继续任务。
- `/retry <任务ID>`：重新排队失败或已取消任务。
- `/queue`：查看排队中、运行中和待取消任务。
- `/progress [任务ID]`：查看最新执行进度。
- `/events <任务ID>`：查看 Codex 事件时间线。
- `/changes <任务ID>`：查看文件变更事件。
- `/commands <任务ID>`：查看 shell 命令及状态。
- `/tools <任务ID>`：查看 MCP 工具调用记录。

例如：`/threads --project food --source cli,appServer --search "fix bug" --status active`

`/recent` 会跳过提示词以 `/` 开头的系统辅助命令；每条任务提供“详情”和“屏蔽”操作，长请求默认折叠，任务之间用分隔线区分。AAMP 和直连任务卡均提供可点击的“查看详情”；只有当任务的接入模式与当前运行模式一致时才显示“中断”：AAMP 模式只能中断 AAMP 任务，直连模式只能中断直连任务。回调处理也会再次校验任务来源，旧卡片或伪造回调不能跨模式取消。屏蔽记录保存在共享 SQLite 中；任务列表和详情始终按当前 Feishu `chat_id` 隔离。

`/usage` 的账户限额来自本机 Codex session 日志中最近一次 `rate_limits` 快照；AAMP ACP 会话用量来自 `~/.acpx/sessions` 中对应任务的累计 token 记录。任一来源没有数据时，卡片会明确显示暂无，不会用估算值代替。

官方包更新后重新启动服务，并检查日志中的 `help-card replay protection and task cancellation active` 和 `per-task ACP worktree isolation active`；运行时补丁依赖官方求助卡、流式卡片、AAMP 发送方法以及 ACP Bridge 的 session/cwd 接口，升级后必须运行回归测试：

```bash
bun update '@larktask/aamp-feishu-task-agent@dev'
bun run aamp:restart
```

完成任务和删除任务是两个不同操作：AAMP/飞书桥接默认把任务标记为完成，不会自动删除远端任务；`feishu-task-agent remove` 也只是删除绑定记录。远端删除属于高风险操作，必须在确认目标 GUID 和 profile 后，使用同一 `LARKSUITE_CLI_CONFIG_DIR` 的 `lark-cli task tasks delete ... --yes` 显式执行。

## LaunchAgent

原生直连推荐使用一条命令自动初始化、检查并生成/启动 plist：

```bash
feishu-codex-bridge install
```

等价的分步命令仍保留给排障和高级场景：

```bash
feishu-codex-bridge doctor
feishu-codex-bridge service install
feishu-codex-bridge service start
```

也可以手工将 `service/com.local.feishu-codex-bridge.plist` 复制到当前用户的 `~/Library/LaunchAgents/`；该模板中的 Node、项目、配置和数据库路径是本机示例，需要按实际路径修改。命令方式和手工方式最终使用同一个服务标签：

```text
com.local.feishu-codex-bridge
```

手工管理时：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.feishu-codex-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.local.feishu-codex-bridge
```

日志写入 `runtime/logs/bridge.stdout.log` 和 `runtime/logs/bridge.stderr.log`。停止服务：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.local.feishu-codex-bridge.plist
```

这和 `bun run aamp:start` 的 `feishu-task-agent-bootstrap` 服务是两套独立的 LaunchAgent。原生直连只运行一个桥接 Bun 进程，并在任务执行时启动 Codex CLI 子进程；不会启动 AAMP、Relay 或 ACP。两个服务不要同时连接同一个飞书机器人。

如果未来重新启用兼容模式，SIGTERM 处理会停止轮询、终止当前 worker、关闭 Web 监听和 SQLite，并保留 SQLite 状态和 outbox；当前 AAMP 模式的退出行为由 `aamp.stopOnShutdown` 控制。

## 测试

```bash
bun run test
bun run typecheck
```

测试使用假的 Lark client/worker，不需要飞书授权、代理或真实 Codex 登录。
