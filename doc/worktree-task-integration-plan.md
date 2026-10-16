# Task Desk 与 Tmux Dashboard 的 Git Worktree 集成评估与 To-do

评估日期：2026-10-11；实现更新：2026-10-12
状态：核心实现、全量自动化回归和生产构建完成；进程级故障注入、真实 Codex、浏览器与设备验收待完成
范围：Bridge Web Task Desk、Git worktree 生命周期、Tmux Dashboard 关联

## 结论

建议把 Git worktree 作为 Task Desk 任务拥有的工作区资源，由 Bridge 后端持久化其目录、分支、基准提交和生命周期；Tmux Dashboard 可以打开或关联该工作区。任务、运行、worktree 和 tmux session 之间使用稳定 ID 关联。

首期限定在 Web Task Desk 的 `tasks/runs/outbox` 和 tmux session；Direct 的 `bridge_tasks`、AAMP 的 `aamp_tasks` 保持独立。Task Desk 新建表单默认沿用原执行目录，用户可为单个任务勾选独立 worktree；从 tmux 创建 Bridge 任务时自动创建独立 worktree。Composer 继续用于向当前 tmux 中的 Codex 会话发送 follow-up。

## 当前系统基线

- Web Task Desk 在 `Dispatcher.submitWebTask()` 中把登记项目路径保存为 `task.repo`。worker 要求它与项目登记路径一致，并以该路径启动 Codex SDK。显式重试和续问也验证项目路径；执行前后 Git 快照目前针对 `task.repo`。[任务提交](../src/dispatcher.ts#L181) [worker](../src/codex-worker.ts#L96) [快照](../src/dispatcher.ts#L524)
- tmux 创建 API 只接收项目 key，并在项目根目录创建 session。`tmux_sessions` 保存项目、Codex Home、工作目录和 session 生命周期，没有任务/worktree 外键。[tmux API](../src/tmux-dashboard-api.ts#L583) [session 表](../src/db.ts#L505)
- Composer 的 `task_submit` 会把文本写入所选终端并保存投递记录；它不创建 `tasks/runs` 中的 Task Desk 任务。[tmux 投递](../src/tmux-dashboard-api.ts#L1009) 当前已有读取 pane 实际目录的 `getCurrentPanePath()`，可用于从 session 发起新的结构化任务。[tmux-dashboard.ts](../src/tmux-dashboard.ts#L123)
- 个人 Ruby `codex-worktree` 包含需求命名、base 检查、Git 锁、worktree 和分支创建、冲突重命名、可选 setup、Codex 启动与结束状态报告。需求文件图片解析和编辑器入口可以由 Task Desk 表单及现有附件机制承接。
- 个人 Ruby `clean-worktree` 会检查远程分支和脏状态，但预览前也会 `fetch origin --prune`；对于没有远程分支的干净本地分支，它可能直接删除该分支，未先证明分支已合并。它也不检查 Bridge 活动任务或关联 tmux session。

## 建议的数据与执行模型

- **Project**：项目注册表中的可信 Git 仓库根目录。
- **Task**：现有 Web 任务，保留其项目 key、任务描述、运行和 review 记录。
- **Task workspace**：该任务专属 worktree，记录 `workspace_id`、`task_guid`、`project_key`、登记项目路径与 Git common directory、执行目录、worktree 路径、branch、base ref/SHA、来源 tmux session、生命周期和续问关闭状态。
- **Tmux session**：可选关联 `workspace_id`；路径由服务端从已登记工作区解析，客户端不提交任意 cwd。

`task.repo` 继续表示登记项目根目录。worker 使用独立保存的 workspace 路径；任务重试、续问、恢复和 Git 快照复用同一个工作区。这样保留项目白名单校验，也让任务线程有稳定的工作目录。

Git 操作由 TypeScript/Bun 服务封装，使用参数数组执行 Git 命令、按 Git common directory 加锁，并规范化真实路径。默认 worktree 根目录在 Bridge 数据库目录旁的 `worktrees/`；若该目录位于源仓库内，会退到仓库外的 `.bridge-worktrees/<repo>/`。branch 使用 `bridge/tasks/<标题 slug>-<任务 ID 短后缀>`。SQLite 与 Git 命令无法组成原子事务，因此先持久化 `provisioning` 状态，再创建 worktree；Bridge 重启后核对 Git 实际状态并恢复或报告失败。已有 Task Desk 幂等回执覆盖重复提交，避免重试创建第二个 worktree。

## 分阶段 To-do

### 阶段 0：确定产品与状态边界

- [x] 决定首期 Task Desk 每个任务单独 opt-in，默认关闭；tmux 创建 Bridge 任务默认启用隔离。收集使用数据后再考虑项目级默认。
- [x] 确定默认 worktree 根目录、`bridge/tasks` 分支前缀、从当前 Git HEAD 建立 base、以标题 slug 和短任务 ID 命名；不使用个人路径或分支前缀。
- [x] 定义 `provisioning`、`ready`、`failed`、`retained`、`removed` 状态及独立的续问关闭时间；执行状态、review 状态和工作区状态分别保存。
- [x] 源目录有未提交改动时阻止隔离任务，详情展示 base commit；明确新 worktree 不会复制这些改动。
- [x] 首期不自动运行仓库里的 setup shell 脚本。

### 阶段 1：Task Desk 创建和运行于独立 worktree

- [x] 新增 Git workspace 服务：读取仓库根/common dir、检查状态、生成唯一 branch/路径、加锁、创建、验证、恢复、inventory 和安全移除。
- [x] 新增 SQLite `task_workspaces` 表；为旧 `tmux_sessions` 数据库增量添加 `workspace_id`；保留既有任务/运行数据。
- [x] Task Desk 提交保存隔离选项；幂等 receipt 和 `provisioning` 工作区记录在同一事务落库。
- [x] worker 验证登记项目与 Git common directory，并使用独立工作目录启动 SDK。
- [x] 显式重试、续问和前后快照复用同一 worktree/thread；完成的任务保留工作区供 review。
- [x] 任务详情与系统管理页显示分支、base SHA、路径和错误；系统管理增加托管/未托管 worktree inventory。
- [x] 自动化覆盖 dirty source、同键并发提交、重复 provision 恢复、项目仓库不匹配、重试续问复用和备份恢复 workspace 元数据。
- [ ] 通过进程级故障注入，分别在 SQLite provisioning 写入和 `git worktree add` 前后杀进程，再验恢复；当前已实现协调逻辑，尚未做该故障注入。

### 阶段 2：Tmux Dashboard 关联任务工作区

- [x] 为 tmux session 增加 nullable `workspace_id` 关联字段及旧数据库迁移。
- [x] 任务详情的“在 Tmux 打开”只传 workspace ID；服务端解析目录并复用或创建 tmux session。
- [x] tmux session 列表/详情显示关联任务和 branch，并提供返回 Task Desk 的链接。
- [x] 增加“从当前目录创建 Bridge 任务”入口；读取 pane 当前路径、项目、分支、base SHA 和 dirty 状态，提交前校验目录与 SHA 未变化。
- [x] 保留 Composer 发消息行为；新任务进入 Web Task Desk 状态机并创建独立 worktree。
- [x] worker 活动期间拒绝创建可写 tmux session；清理前检查关联 workspace ID 和 pane 当前目录。
- [x] 自动化覆盖缺失 Action Token、当前 pane 基准变化会被拒绝、客户端任意路径不作为工作目录、打开 session、活动 session 阻止清理、结束 session 后清理，以及未登记 worktree 只展示。
- [ ] 手动验收目录移动、tmux pane 在同一 session 内 `cd` 到 worktree、真实 tmux server 场景。

### 阶段 3：安全清理与遗留 worktree 管理

- [x] 增加只读 inventory，分别列出 Bridge 托管工作区和 Git 发现但未托管的 worktree；未托管项仅展示。
- [x] inventory 显示托管和未托管 worktree 的 dirty 数量、远程 refs、相对基准的提交数、task/run/session blockers；读取不 fetch、不 prune。
- [x] 清理要求先关闭续问，并阻止活动 run、dirty worktree、活动 tmux session 和无法确认的 tmux 状态。
- [x] 目录移除默认保留 branch；branch 删除是单独选项，只在无远程 ref 且已合并/无新增提交时使用 `git branch -d`。
- [x] 清理需配对设备和 Action Token 显式触发；结束 tmux session 使用既有独立操作。
- [x] 自动化覆盖 dirty/未合并保护、活动 session 拦截、结束 session 后清理、保留 branch 和托管/未托管 inventory。
- [ ] 手动验收真实远程分支、并发编辑和系统 Git worktree prune 状态。

### 阶段 4：真实使用验收与默认策略

- [ ] 在常用项目和真实 Codex SDK 上完成一次完整使用；当前端到端回归用隔离 Git fixture 和 fake worker，不代表真实 Codex 执行。
- [ ] 在真实使用中记录创建耗时、失败原因、隔离选择率、工作区保留时间和清理阻止原因。
- [ ] 根据真实使用数据决定是否增加项目级默认和 setup 支持。
- [x] SQLite 旧表迁移、worktree 元数据备份/恢复、全量自动化回归与 production build 已通过：`bun run test` 281 pass，`bun run build` 成功。
- [ ] 在真实浏览器中检查 Task Desk 和 Tmux 页面交互，再用真实 Mac/iPhone 验收；自动化 HTTP 回归不替代浏览器/设备验收。

## 主要风险和决策

- `SUCCEEDED` 或 review `accepted` 不等于 workspace 可删除：Web 任务完成后仍可追加 follow-up，清理会破坏继续使用同一 thread 的条件。保留动作应由用户显式执行。
- Git 创建与 SQLite 写入不是同一个事务；必须支持 provisioning 记录、锁、重启后协调和可观察的失败状态。
- Task workspace 元数据随 Bridge SQLite 备份恢复；Git worktree 的文件内容不随备份复制。跨目录/主机恢复时，执行前会重新核验路径和 Git common directory，缺失或不匹配时阻止运行。
- Tmux Dashboard 连接的是 Bridge 主机上的 tmux server。关联工作区必须使用该主机上的真实路径，不把 pane 内嵌套 SSH 的目标目录误认为本机仓库。
- 不能因目录名、session 名或相似 branch 名推断任务关联；只能使用持久化 ID。
- worktree 路径校验、任务变更 API 和 session 创建 API 继续沿用 Bridge 配对鉴权、Action Token 与同源校验。
- Bridge 备份会保存 SQLite 中的 worktree 元数据，不复制 Git worktree 文件内容。恢复到其他路径/主机时，worker 会重新验证原路径和 common directory；无法确认时阻止执行并保留数据。
- 真实 Codex/macOS/iPhone 和浏览器手动交互尚未验收；fake worker/HTTP 集成测试只证明 Bridge 状态、Git worktree 和 API 的联动。

## 实施入口索引

- [Task Desk 调度](../src/dispatcher.ts)
- [Git worktree 服务](../src/git-workspaces.ts)
- [Codex SDK worker](../src/codex-worker.ts)
- [Tmux Dashboard API](../src/tmux-dashboard-api.ts)
- [Tmux session 与 Git 工作区快照](../src/db.ts)
- [Task Desk 前端](../web/src/App.tsx)
- [任务工作区管理页](../web/src/TaskWorkspaces.tsx)
- [Tmux Dashboard 前端](../web/src/TmuxDashboard.tsx)
