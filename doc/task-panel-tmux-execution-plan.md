# Bridge 任务面板可选 tmux 执行计划

状态：已取消。2026-09-23 决定移除 verifier 和 tmux 任务执行，只保留 tmux Dashboard；本文仅作历史方案记录。

## 目标

看板以纯文本描述新建任务，不要求标题或模式；标题由描述首行生成，项目必须从 SQLite 中可用的登记项选择。执行目标可选现有 Codex SDK（默认）或 tmux session。选择 tmux 后，任务详情保存本次 run 对应的具体 session，并可直接打开该 session 查看执行过程。继续使用现有任务状态、事件、取消和结果页面，不另建一套任务状态机。

## 当前代码基线

- 计划形成时的基线是 `main`：任务面板提供查询、详情、反馈和中断，没有新建任务表单或 `POST /api/tasks` 创建入口。
- 代码中有两条 Codex SDK 路径。旧任务列表使用 `tasks/runs → Dispatcher → ChildWorkerRunner → codex-worker.ts`；Direct Feishu runtime 使用独立的 `bridge_tasks`，由 `FeishuSqliteCodexRuntime` 调 Codex SDK。`main.ts` 当前关闭 legacy polling；Direct runtime 由 Feishu 消息触发，未连接当前 Web 任务面板的提交入口。
- tmux verifier 已提供 session 创建、幂等发消息、事件/屏幕快照和终端 attach。其数据保存在独立的 `tmux-verifier.db`，session ID 与任务数据库之间目前没有关联。
- tmux Dashboard 列出普通本地 tmux sessions；其中可能是 shell 或其他程序。它不能证明目标 pane 正在运行 Codex，也不提供任务回合完成事件。

实施决定：增加 `POST /api/tasks`，新任务进入既有 `tasks/runs → Dispatcher` 状态与调度链。Codex SDK 仍为默认执行方式；tmux 仅可选 Bridge verifier 管理、启用任务跟踪的本机 Codex session，不改动 Direct Feishu 的 `bridge_tasks` 流程。项目名称、绝对路径和状态由新的 SQLite `projects` 表管理；旧 project map 仅在项目表为空时导入一次。

## 推荐行为

1. 提交表单只要求项目、执行方式和文本描述；标题从描述首行生成，不暴露模式选择，服务使用配置的默认 sandbox 模式。
2. 执行方式提供 `Codex SDK`（默认）和 `tmux session`。
3. tmux 方式首版只允许选择 Bridge tmux verifier 管理的、可用的 Codex session；不把普通 tmux Dashboard 中任意 session 当作执行目标，避免将任务文本发送到 shell 或无关程序。
4. 提交时绑定所选 verifier `session_id`。任务与 session 使用稳定 ID 关联，不依赖可重命名的 tmux session 名称。
5. 从任务详情进入“查看 tmux session”，直接打开同一个 session 的终端页面；页面可展示 session 名、机器、工作目录和当前连接状态。
6. SDK 方式仍走现有 executor 和状态更新。tmux 方式通过已有 verifier 的消息和终端接口执行，不同时启动第二个 SDK turn。

如果实际诉求是让 Bridge 为每个任务自动创建一个全新的 tmux session，而不是从列表选择已有 Codex session，需要在确认时明确；这会改变 session 生命周期和清理范围，计划中的 session 选择器及复用规则需要相应调整。

## 最小改动方案

### 0. 已确认的提交入口与回合结束信号

- 看板任务通过新增 API 写入原有 `tasks/runs`，复用 Dispatcher、运行状态、历史和取消逻辑；不迁移或合并 `bridge_tasks`。
- 只允许本机、工作目录与所选项目一致且已启用任务跟踪的 Bridge Codex session；普通 tmux session 和远程 session 不作为执行目标。
- Codex 官方 `agent-turn-complete` hook 写入 verifier 事件；完成事件必须匹配本次发送的输入文本，不能仅因 session 仍运行或任意回合结束就判定任务成功。

### 项目注册表

- 在 Bridge SQLite 中保存 `projects(name, path, status)`，Web 提供创建、改路径和启用/停用操作；可用目录供任务和 tmux 页面选择。
- 首次发现项目表为空时，从用户旧 `~/.codex/project_map.yaml` 或 `~/.codex/project-map.yaml` 迁入一次；后续以 SQLite 为唯一运行时来源，不再从 YAML 刷新或覆盖管理结果。
- tmux Dashboard、tmux verifier 和 Direct Feishu 路由共用项目表；AAMP worktree adapter 接收由项目表导出的路由数据。

### 1. 扩展现有提交字段

- `POST /api/tasks` 接收文本描述、可用项目及可选 `executionBackend`/tmux `sessionId`；标题自动生成，模式省略时由服务使用默认配置，不提供图片/附件上传。
- SDK 请求不传新字段时按 `codex-sdk` 处理，兼容现有任务和重试。
- tmux 请求在入队前验证 session 存在、状态可用且为 verifier 管理的 Codex session；校验失败返回可读错误，不创建半成品 run。

### 2. 将执行目标保存到 run

- 目标选择按一次执行尝试保存，建议对 `runs` 做向后兼容的 nullable/additive 字段，例如 `execution_backend`、`tmux_session_id`；旧记录默认解释为 SDK 执行。
- 保留 verifier 独立数据库；Bridge 数据库只保存 session ID，不跨数据库建外键。任务详情通过 verifier API 读取 session 信息。
- 每次重试/重新执行都保留自己的 executor 和 session 关联，历史 run 不被后续选择覆盖。

### 3. 在现有调度边界增加 tmux executor

- Dispatcher、队列、任务/run 状态、事件流、评论/outbox 和看板数据模型继续共用。
- 按 run 中保存的 backend 分发：SDK 继续使用现有 Codex worker；tmux 使用一个小型 adapter 调用 verifier `sendMessage` 并监听已验证的回合完成事件。
- 以 `run_id` 派生稳定的 `clientMessageId`，重试同一请求时复用相同幂等键，避免重复注入任务。
- 同一个 tmux session 同时只允许一个 Bridge 活动 run；至少在 Bridge 内做占用检查。一个 session 中由用户手动开始的 Codex 回合是否也需要检测，取决于第 0 步拿到的信号。

### 4. 接入详情、取消和恢复

- 任务/运行详情返回 `tmux_session_id` 及 session 摘要，增加直达 `/tmux` 终端的链接；`TmuxApp` 支持按 URL 中的 session ID 自动选中并 attach。
- 取消 tmux run 时只中断当前 Codex 回合并释放 Bridge 占用，不停止或 kill 用户的 tmux session。用户手动停止 session 时，将关联中的活动 run 标成失败/取消并说明原因。
- 服务重启沿用既有 interrupted-run recovery：run 保留 session ID 并标记失败，不重新发送 prompt，也不创建重复 session；任务详情仍可尝试打开原 session 诊断。

### 5. 验证与小流量启用

- 覆盖默认 SDK 任务无行为变化、tmux session 校验、幂等重试、同 session 并发保护、回合成功/失败、取消、session 消失、服务重启恢复，以及任务详情直达终端。
- 先对一个 verifier 管理的本地 Codex session 做端到端验证；确认 task/run 状态与 Codex 回合状态一致后，再开放该选项。

## 风险与边界

- 当前任务数据存在 `tasks/runs` 与 `bridge_tasks` 两套模型。首版只接入确认后的那条现存提交链，不合并数据库、不迁移另一条链，也不同时支持两个提交入口。
- 当前 tmux verifier 持久化 session、message 和屏幕事件，但还没有 Bridge run 关联及 Codex 回合完成状态。第 0 步是技术验收门槛，而不是普通实现细节。
- 普通 tmux session 与 verifier Codex session 不等价。首版不对未经识别的 session 执行 `send-keys`。
- tmux session 生命周期长于单个任务 run。任务完成/取消只结束 Bridge run；是否保留该 session 由用户后续操作决定。

## 已确认的范围与限制

1. 新建任务接口为 `POST /api/tasks`，SDK 默认，tmux 为显式可选项。
2. tmux 目标从现有、受 Bridge 管理并支持完成事件跟踪的 Codex session 中选择；不为每个任务自动创建 session。
3. 成功、失败、取消仍回写既有任务/run 状态；session 完成事件须与本次任务输入匹配，取消只中断回合、不终止 tmux session。
4. 在功能更新后创建的本机 Bridge Codex session 才会启用任务完成跟踪；旧 session 需新建后才能出现在 tmux 任务目标列表。

## 实施边界

只改看板任务 API、原任务/run 存储与调度、SQLite 项目注册表、tmux verifier 完成信号和必要的 UI/测试；不自动提交、发布或重启服务。
