# 对比 lobehub 和 multica

先说结论：它们不是同一类产品。

项目 更准确的定位 核心价值
━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LobeHub 通用 AI Agent 平台和 Agent 工作台 Agent、模型、MCP、Skills、记忆、任务、聊天渠道和 Agent Team
───────────── ─────────────────────────────────────────── ───────────────────────────────────────────────────────────────
Multica 人与编程 Agent 协作的任务管理/执行控制面 Issue、Run、Runtime、队列、执行日志、重试、审查和多机器 Agent
───────────── ─────────────────────────────────────────── ───────────────────────────────────────────────────────────────
你的 Bridge 个人 Mac 上 Codex/tmux 的远程控制与运维桥 iPhone、飞书、Web 远程查看和续问本机 Codex

LobeHub 当前已经从早期的聊天界面发展为“Super-Agent”平台，强调 Agent Team、任务调度、主动工作、MCP/Skills/Agent 市场，以及接入 Codex、Claude Code 等外部 Agent。LobeHub 官方仓库
(https://github.com/lobehub/lobehub)

Multica 则更像“AI 工程团队的 Linear/Jira + Runner”：Issue 描述工作目标，Run 表示一次执行，Runtime 是具体机器和 Agent CLI，Daemon 在本机领取任务并启动 Codex、Claude Code
等工具；它还提供执行日志、重试、取消、审查门禁和多 Runtime 管理。Multica 官方仓库 (https://github.com/multica-ai/multica) Daemon 与 Runtime 文档
(https://multica.ai/docs/daemon-runtimes) Run 生命周期文档 (https://multica.ai/docs/tasks)

你的 Bridge 目前更窄、更本地化：Codex 仍运行在 Mac 上，tmux 是已有会话，飞书 Direct、Web Task Desk、AAMP 和 tmux 各自保留执行状态，仅在 Web 上做聚合。这一点与项目自己的定位和路线图是
一致的：README.md (README.md:3) product-review-roadmap.md (doc/product-review-roadmap.md:23)

对 Bridge 最有价值的借鉴，优先级大致如下。

1. 最值得借鉴 Multica 的数据模型

把这些概念明确区分：

Task / Issue：用户想完成什么
Run：这次具体执行尝试
Runtime：由哪台机器、哪个 Codex/CLI 执行
Workspace：在哪个目录或 worktree 执行
Artifact：产生了什么 diff、文件、日志
Review：是否经过人工验收和发布

Bridge 已经有 tasks/runs/outbox，也有 Direct/AAMP/tmux 多来源。下一步更应该加强“统一只读视图”和运行语义，而不是把所有状态机强行合并。你当前路线图中“聚合查看、所属服务执行”的方向是正确
的。

2. 借鉴 Multica 的 Runtime 和可靠性语义

尤其是：

• Runtime 在线/离线、心跳、能力和并发数；
• 任务排队、领取、执行、等待、失败、取消；
• 机器暂时离线时是等待还是失败；
• 重试是否创建新的 Run，而不是覆盖旧记录；
• 任务执行目录是否被另一个 Run 占用。

这对 Bridge 的 Direct、Web Task Desk 和未来多台 Mac 执行很有帮助。Multica 的本机 Daemon 设计可以作为参考，但不必照搬成完整的多机平台。

3. 借鉴 LobeHub 的 Agent Profile、Skills 和上下文组织

Bridge 现在的“项目注册”可以进一步发展为：

项目
├── 默认工作目录
├── 默认模型/推理强度
├── 项目级 Skills
├── 权限和允许动作
└── 可用的 Codex/Agent Runtime

LobeHub 对 Agent、Skills、MCP、Memory、项目上下文的组织方式，适合参考其产品层设计。尤其是把“任务内容”和“执行 Agent 的长期角色/技能”分开，而不是每次都把所有规则拼进提示词。

4. 借鉴两者的“人机协作闭环”

Bridge 现在已经有取消、续问、重试、人工验收和 Git 元数据。可以继续强化：

提交任务
→ 执行
→ 查看过程和产物
→ 追加意见
→ 人工验收
→ 明确决定是否提交/推送/创建 PR/合并

这里 Multica 的 Review Gate 很有参考价值。尤其要继续保持你现在的边界：Agent 完成不等于代码已经发布，不能自动推断用户授权了 commit、push 或 merge。

暂时不建议照搬的部分：

• 不要因为 LobeHub 使用 PostgreSQL、Redis、对象存储、搜索服务和 Agent Gateway，就把 Bridge 从本地 SQLite 重构成重型中心化平台。Bridge 的优势正是单机、自托管、低运维。
• 不要为了“支持多 Agent”立刻把 tmux 替换掉。你的 tmux Dashboard 服务的是已有的长生命周期 Codex 会话；Multica 的 Run Workspace 服务的是隔离、可排队、可回收的自动任务，两者不是同一种执
行环境。

• 不要马上追求 LobeHub 式主动找活、自动唤醒和 Agent Team。对你的个人 Mac 和真实代码目录而言，权限、数据泄露、并发写入和误操作风险比功能展示更重要。
• 不要一开始支持几十种 Agent CLI。先把 Codex SDK、Codex CLI、tmux 这条链路的恢复、幂等、日志和审查做好。

我的建议是：Bridge 不需要变成 LobeHub 或 Multica，而应吸收 Multica 的执行控制模型、吸收 LobeHub 的 Agent/Skill 产品模型。

长期可以形成这样的组合：

LobeHub：Agent/Skill/对话和生态层
Multica：任务、Runtime、队列和团队协作层
Bridge：你的 Mac 上的 Codex/tmux 本地执行层与 Feishu/iPhone 入口

但当前阶段最实际的路线是：继续保持 Bridge 的本地架构，只补强 Task → Run → Runtime → Artifact → Review 这条主线。

另外，严格说两者都不能简单按“标准 Apache/MIT 开源项目”理解：LobeHub 使用基于 Apache 2.0 的 LobeHub Community License，Multica 也明确称为 source-available，并在 Apache 2.0
基础上增加了托管服务、商业嵌入和品牌等条件。LobeHub LICENSE (https://github.com/lobehub/lobehub/blob/canary/LICENSE) Multica LICENSE
(https://github.com/multica-ai/multica/blob/main/LICENSE)
