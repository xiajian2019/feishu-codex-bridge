# Advisor → Executor → Reviewer 工作流集成计划

评估日期：2026-11-12

状态：提案，尚未实施

范围：Web Task Desk、Git worktree、Tmux Dashboard、Codex CLI/SDK 执行协调

参考项目：[shadcn/improve](https://github.com/shadcn/improve)

## 1. 决策摘要

Bridge 借鉴 `shadcn/improve` 的工作流，不直接复制其 Agent Skill，也不把 Bridge 改造成云端多 Agent 控制平面。

目标流程是：

```text
强模型 Advisor（只读审查）
        ↓
自包含 Plan artifact（证据、范围、验证、STOP 条件）
        ↓
Bridge 独立 Git worktree
        ↓
便宜模型 Executor（按计划修改和测试）
        ↓
强模型 Reviewer（只读检查 diff、测试和范围）
        ↓
人工决定合并、返修或阻塞
```

Tmux 继续是主要的观察和控制入口。Executor 使用由 Bridge 管理的独立 worktree 和 tmux session；用户当前长期使用的 tmux session 不作为隔离执行目录。

首期只接入 Web Task Desk 的 `tasks/runs/outbox`、`task_workspaces` 和 Tmux Dashboard。Direct 的 `bridge_tasks`、AAMP 的 `aamp_tasks`、Codex History 和现有 Composer follow-up 保持现有边界。

## 2. 当前基线

当前 Bridge 已有以下可复用能力：

- `Dispatcher`、`runs`、`run_events`、outbox、worker PID、超时和进度状态。
- Web Task Desk 的 Git worktree 生命周期、任务目录校验、前后工作区快照和 Tmux 打开入口。
- Codex SDK worker 的独立 `workingDirectory`、sandbox、流式事件和 thread 持久化。
- Web run 的人工验收记录，且执行状态和人工 review 状态分开保存。
- Tmux Dashboard 的只读输出、显式终端输入、Composer 和任务工作区关联。

当前缺口：

1. 计划不是正式的数据对象，执行前后无法稳定追踪计划内容、基线和漂移。
2. Task Desk 的运行配置没有明确区分 Advisor、Executor、Reviewer 角色。
3. 执行完成后目前主要依赖人工 review，没有强模型复核 diff、范围和验证证据的独立阶段。
4. 没有针对计划 backlog 的 `reconcile` 流程，代码漂移后容易把旧计划交给执行器。

当前 checkout 有其他未提交和未跟踪改动。本计划不把这些改动视为可自动纳入的基线；任何实现前都必须重新确认分支、HEAD、dirty 文件和计划涉及的路径。

## 3. 产品和安全边界

### 3.1 保留的边界

- tmux session 仍运行本机 Codex CLI；Bridge 不提供云端执行环境。
- 用户当前长期 tmux session 只用于观察、手工 follow-up 和进入已创建的任务 worktree。
- Executor 不得直接写入用户正在使用的源 checkout。
- 合并、推送、创建 PR、发布和部署仍是独立的人工授权动作。
- Direct、AAMP、Web Task Desk 三套任务状态机继续分开，不能因字段相似而合并。
- 浏览器、真实 tmux、真实 Codex、SSH、手机和部署验收分别报告，不以静态或 fake worker 结果互相替代。

### 3.2 强制策略

| 角色 | 目录权限 | 允许修改 | 主要输出 |
| --- | --- | --- | --- |
| Advisor | `read-only` | 仅计划 artifact 或临时输出，不改源码 | Findings、计划、依赖顺序 |
| Executor | `workspace-write`，仅独立 worktree | 计划 Scope 内的文件 | 代码、测试、结构化执行报告 |
| Reviewer | `read-only`，读取 Executor worktree | 不改源码、不修复 | APPROVE、REVISE 或 BLOCK |
| Human | 由用户决定 | merge、push、发布等显式动作 | 最终交付决定 |

模型名不能由 Feishu 消息或浏览器请求任意传入。Bridge 应通过服务端配置的角色白名单选择模型和 reasoning effort；用户只能选择受支持的角色或预设。

## 4. 目标状态模型

计划状态独立于现有 `TaskState` 和 `task_workspaces` 状态，不把规划状态硬塞进任务执行状态。

建议的计划状态：

```text
DRAFT → READY → QUEUED → EXECUTING → VERIFYING
                                      ├─ APPROVED
                                      ├─ REVISE → EXECUTING
                                      ├─ BLOCKED
                                      └─ STALE → RECONCILE → READY / REJECTED
```

- `DRAFT`：Advisor 尚未完成或计划仍需人工选择。
- `READY`：计划已通过基本完整性检查，可以执行。
- `QUEUED`：已交给 Dispatcher，等待独立 worktree 和 worker。
- `EXECUTING`：Executor 正在执行。
- `VERIFYING`：Reviewer 正在复核，或等待验证命令完成。
- `APPROVED`：Reviewer 通过；不代表已经 merge 或发布。
- `REVISE`：需要把具体反馈交回同一个 Executor，最多两轮。
- `BLOCKED`：遇到 STOP 条件、范围越界、验证无法建立或复核失败。
- `STALE`：计划基线、范围文件或关键设计约束已漂移，不能直接执行。
- `REJECTED`：维护者明确放弃，或问题已在其他变更中解决。

现有 Web task/run/review/workspace 状态继续作为执行事实来源。计划状态只描述“这份计划和执行闭环走到了哪一步”。

## 5. Plan artifact 设计

### 5.1 计划必须包含

每份可执行计划至少包含：

- 目标和为什么值得做。
- 当前代码位置、符号和必要的短代码摘录。
- `planned HEAD SHA`。
- 生成计划时的 tracked dirty 路径、untracked 路径和有界 manifest hash。
- In-scope 文件和明确的 out-of-scope 文件。
- 角色、模型、sandbox 和审批策略。
- 按顺序拆分的修改步骤。
- 每一步的验证命令和预期结果。
- 测试场景及现有测试样例。
- STOP 条件。
- 依赖的其他计划和推荐执行顺序。
- 维护注意事项、延期事项和 reviewer 重点。

计划内容不得写入 secret、token、`.env` 值或可直接滥用的安全复现字符串；只记录位置、类型和修复要求。

### 5.2 存储建议

采用“双层存储”：

1. `runtime`/SQLite 保存运行时的不可变计划内容、hash、状态和执行关联，保证 worker 不依赖未提交的工作区文件。
2. 人工确认后，可把计划导出到 `doc/advisor-plans/` 或单独的项目文档，作为可审阅的长期记录。

Executor 收到的 prompt 必须内联完整计划内容，同时保存 `plan_content_sha256`。不能只传一个可能不存在于新 worktree 的相对路径。

### 5.3 建议数据字段

首期可以新增 `advisor_plans`，并给 `runs` 增加可空关联字段；不要改写现有 Direct/AAMP 表。

```text
advisor_plans
  plan_id
  task_guid
  project_key
  repo
  planned_head_sha
  dirty_manifest_json
  dirty_manifest_hash
  plan_content
  plan_content_sha256
  scope_json
  dependencies_json
  advisor_model
  executor_model
  reviewer_model
  status
  created_at
  updated_at

runs（新增可空字段）
  plan_id
  run_role
  model
  reasoning_effort
```

如果实施时发现现有 `runs` 已能表达这些字段，应优先增量扩展而不是再造第二套执行记录。

## 6. 漂移检查和执行前门槛

Advisor 生成计划时记录：

- 仓库真实路径和 Git common directory。
- 当前分支和 HEAD。
- 计划涉及的路径。
- tracked dirty/untracked manifest。
- 计划引用的关键配置和设计文档版本。

Executor 启动前必须重新检查：

1. 项目 key 仍映射到同一个登记仓库。
2. `planned HEAD SHA` 与允许的基线策略一致。
3. 计划 Scope 内没有未说明的变化。
4. 计划内容 hash 未变化。
5. worktree 的 branch、base SHA、真实路径和任务记录一致。
6. 依赖计划已是 `APPROVED` 或明确的 `DONE`。

任何检查失败都进入 `STALE` 或 `BLOCKED`，要求重新审查计划；不得让便宜模型自行猜测新代码结构，也不得自动 stash、reset、覆盖用户改动。

## 7. 分阶段执行计划

### 阶段 0：手工 Pilot，不改 Bridge

目标：验证流程收益，不先引入新的状态机。

步骤：

1. 在干净的 feature branch 上，用强模型执行一次 `branch` 或单领域审查。
2. 只选择 1～3 个高置信度计划。
3. 手工创建 Bridge 任务和独立 worktree，把完整计划文本交给便宜模型。
4. 通过 Tmux Dashboard 观察 Executor，禁止其操作原始 checkout。
5. 手工使用强模型复核 diff、测试和计划 Scope。

验收：

- 计划中每个重要判断都有路径和行号证据。
- Executor 不需要阅读原 Advisor 对话即可执行。
- 至少一次发现漂移后成功阻止执行，而不是静默使用旧计划。
- reviewer 能明确给出 APPROVE、REVISE 或 BLOCK。
- 没有自动 merge、push、部署或覆盖已有 dirty 改动。

阶段 0 未完成前，不实施全量自动化调度。

### 阶段 1：Plan artifact 和漂移门槛

建议范围：

- `src/types.ts`：计划状态、计划角色、结构化计划元数据。
- `src/db.ts`：`advisor_plans` 迁移、读写、hash 和状态转换。
- `src/dispatcher.ts`：计划依赖、执行前检查和 `STALE/BLOCKED` 结果。
- `src/git-workspaces.ts`：复用现有真实路径、base SHA 和 worktree 校验。
- `src/run-artifacts.ts`：必要时保存有界 manifest 和验证结果，不保存源文件内容。
- `tests/db.test.ts`、`tests/dispatcher.test.ts`、`tests/task-worktree-http.test.ts`：隔离数据库、漂移和 worktree 回归。

完成标准：

- 计划内容和 hash 持久化后，worker 重启仍能恢复同一计划。
- Scope 内 HEAD/dirty manifest 变化会阻止执行。
- Scope 外的既有用户改动不会被自动覆盖或清理。
- 新计划不会被错误写入 Direct 或 AAMP 状态表。
- 执行 prompt 使用数据库中的完整计划内容，而不是依赖未提交文件。

### 阶段 2：角色化模型路由

建议范围：

- `src/types.ts`、`src/config.ts`：增加角色配置、模型白名单和 reasoning effort 校验。
- `config.example.json`：提供 Advisor/Executor/Reviewer 预设示例，不写个人凭据。
- `src/codex-worker.ts`、`src/worker-runner.ts`：将运行角色、模型和 reasoning 传入 Codex SDK/CLI，并写入 progress/usage。
- `src/task-feature-name.ts`：保留当前临时、只读、失败回退模式，不把命名模型逻辑误当成执行模型配置。
- `tests/codex-worker.test.ts`、`tests/dispatcher.test.ts`：验证角色权限、参数传递和拒绝未知模型。

完成标准：

- Advisor/Reviewer 不能以 `workspace-write` 角色启动。
- Executor 必须绑定任务 worktree，不能传入客户端任意路径。
- 未登记模型、未知角色和不匹配的 sandbox 会在启动前拒绝。
- run 记录能显示实际角色、模型和 reasoning effort。

### 阶段 3：Reviewer 和返修闭环

建议范围：

- `src/dispatcher.ts`：增加 Reviewer run、具体反馈、最多两轮返修和最终阻塞。
- `src/db.ts`：保存 reviewer verdict、验证命令结果、范围检查结果和反馈 hash。
- `src/web.ts`：提供只读计划/执行/复核详情和显式返修操作。
- `web/src/TaskDetailPage.tsx`：显示计划、基线、Scope、Executor、Reviewer 和验证证据。
- `tests/web-run-review.test.ts`、`tests/dispatcher-web-retry.test.ts`：覆盖 approve/revise/block 和幂等行为。

边界：

- 现有人工 `web_run_reviews` 仍然保留，模型 verdict 不替代用户的最终验收。
- Reviewer 只读检查，不能在发现问题后直接修源码。
- 返修必须复用同一个计划和 worktree，并重新记录每轮 diff 与验证结果。
- 超过两轮返修转为 `BLOCKED`，由强模型重新规划。

### 阶段 4：Tmux Dashboard 集成

建议范围：

- `src/tmux-dashboard-api.ts`、`src/tmux-dashboard.ts`：从当前 pane 发起 Advisor 计划时，只使用服务端解析出的项目、真实路径、分支、base SHA 和 dirty 状态。
- `web/src/TmuxDashboard.tsx`：增加计划/执行状态入口，但保留当前 Composer、只读终端和显式终端输入的区别。
- `web/src/TaskDetailPage.tsx`：提供“在 Executor worktree 中打开 Tmux”。
- `src/workbench.ts`、Workbench 通知：只推送需要用户注意的计划漂移、Reviewer 结果和阻塞，不把普通 Codex 输出重复通知。
- `tests/task-worktree-http.test.ts` 及浏览器 fixture：验证 session/workspace/plan 关联和权限边界。

浏览器验收必须使用当前 checkout 提供的隔离服务和 fixture：实际点击计划入口、创建执行任务、打开 worktree、查看状态，并至少用一次 Playwright evaluate 检查相关布局/状态。截图、浏览器模拟和真实手机验收分开报告。

### 阶段 5：Reconcile 和运维观测

建议范围：

- `src/codex-cli.ts`：增加只读的计划列表、漂移检查、reconcile 和运行详情命令。
- Web 系统页或任务详情：显示 TODO、STALE、BLOCKED、APPROVED 计划及阻塞原因。
- SQLite backup：备份计划元数据和状态，不复制 worktree 文件内容。
- 运行指标：计划耗时、Executor 耗时、Reviewer 返修次数、漂移次数、阻塞原因、worktree 保留时间。

不要用“计划数量”或“模型调用次数”作为唯一成功指标；重点观察返修率、错误发现率、验证失败率和人工合并前的实际 diff 质量。

## 8. 验证矩阵

| 层级 | 必须证明 | 不能推断出的结论 |
| --- | --- | --- |
| TypeScript | `bun run --bun tsc -p tsconfig.json --noEmit`；前端另行检查 | 不能证明运行时状态机正确 |
| SQLite/单元 | 计划 hash、漂移、依赖、角色和恢复用临时 DB/fake worker 验证 | 不能证明真实 Codex 可执行 |
| HTTP | Action Token、同源、项目白名单、Scope 和幂等 | 不能证明浏览器交互和 tmux 实时输出 |
| Web 构建 | `bun run build:web` 或完整 `bun run build` | 不能证明服务已重启或页面由当前源码提供 |
| 浏览器 | Playwright 实际点击/输入、截图和 `browser_evaluate` | 不能证明真实 iPhone/Android 触摸体验 |
| 真实 tmux/Codex | 独立 worktree、真实 CLI 输出、取消、重启、慢输出 | 不能证明发布、部署或远程 SSH |
| 发布/部署 | 对应 commit SHA、CI/build ID、服务和 DNS 证据 | 不能由本地构建或旧记录推断 |

所有 lint、静态检查和质量检查遵循项目约定：最长等待 1 分钟；超时必须取消并报告为“超时取消”，不能写成通过。

## 9. STOP 条件

执行任一阶段时，满足以下条件必须停止并报告：

- 当前分支是 `master`，且没有得到隔离方式授权。
- 计划涉及路径在生成后发生变化，但没有完成 reconcile。
- 当前 checkout 或 source tmux session 的 dirty 改动无法明确区分为 Scope 外改动。
- 项目 key、真实仓库路径、Git common directory 或 worktree base 不匹配。
- 需要自动 stash、reset、覆盖用户文件或清理未托管 worktree。
- 需要修改 Direct、AAMP 或 Codex History 才能完成首期 Web Task Desk 目标。
- Executor 触碰 out-of-scope 文件，或 Reviewer 发现验证命令与计划不一致。
- 计划要求访问或输出 secret、token、`.env` 值。
- 需要 merge、push、发布、部署、安装 APK 或连接真实设备才能继续，但本阶段没有明确授权。
- 浏览器、真实 tmux、真实 Codex 或设备验证不可用；必须明确写成未完成，不能以静态结果替代。

## 10. 推荐执行顺序

```text
阶段 0 手工 Pilot
        ↓
阶段 1 Plan artifact + 漂移门槛
        ↓
阶段 2 Advisor/Executor/Reviewer 角色路由
        ↓
阶段 3 Reviewer + 返修闭环
        ↓
阶段 4 Tmux Dashboard 入口和观察体验
        ↓
阶段 5 Reconcile、备份和运维指标
```

优先级建议：先完成阶段 0 和阶段 1，再决定是否实施后续阶段。不要把移动端 UI、Direct/AAMP 适配、自动发布或全量九类审查放入第一批实现。

## 11. 交付定义

本计划完成不代表功能已经实现。只有在对应阶段的源码、测试、浏览器/真实环境证据和当前 commit 记录齐全后，才可把阶段标为完成。

任何阶段的实现都应保留用户现有 dirty work，显式列出修改文件，单独报告：

- 源码修改是否完成。
- 单元/HTTP/构建是否通过。
- 浏览器、真实 tmux、Codex、设备和部署是否验证。
- 是否创建了 commit、push、PR、merge 或发布。

默认不执行最后一组发布动作，除非用户另行明确授权。
