# 第一阶段交付清单

备份策略更新：2026-10-27，仅备份 SQLite，并增加每天主机时间 01:00 的系统定时备份；下方历史验证记录保留原日期。阶段状态复核日期：2026-10-07。这里的「第一阶段」指原[路线图](product-review-roadmap.md#第一批独立任务交付状态)列出的五项，不等于 A–F 六个阶段全部完成。五项均已进入当前分支 `feature/add_tmux_session_task`，并有本地验证；未据此认定远端 CI、生产部署或真实手机验收通过。人工检查范围见[浏览器冒烟清单](browser-smoke-checklist.md)。

| 项目 | 状态 | 已交付行为 |
| --- | --- | --- |
| 附件生命周期 | 已实现并测试 | Web staged 附件超过 24 小时在启动/上传时清理；已绑定附件不受暂存清理影响。Codex History 的终态 run 每个 thread 最多保留 4 个、全局最多 40 个，运行/取消中的 run 不计入上限；结束后最多保留 24 小时。测试覆盖完成、失败、取消、到期、数量淘汰、并发绑定、越界链接与重启孤儿文件。未知孤儿文件不自动删除。 |
| CI 质量门 | 工作流已实现；远端结果未核对 | `.github/workflows/ci.yml` 对 PR/分支 push 配置 macOS 14、固定 Bun、frozen lockfile、只读权限和过期运行取消，执行完整测试与构建/类型检查。本地曾通过同类命令；本次未查询 Actions 运行结果。 |
| 备份、检查和恢复到新目录 | 已实现并测试 | `backup create/verify/restore` 仅处理 Bridge SQLite 数据库，使用一致性快照、SHA-256 清单及 schema 指纹；v3 标记备份范围和手动/系统定时来源。v1/v2 也只恢复数据库，保留库内原有附件路径；缺失附件不阻止操作。恢复拒绝覆盖现有目录。 |
| Web 任务提交幂等性 | 已实现并测试 | `web_task_submissions` 持久化请求键和规范化负载；同键同内容返回原任务，同键不同内容返回 409。任务、运行、附件绑定与回执在同一事务提交；运行中和终态任务不会因重放再次执行。重启恢复已确认的 QUEUED Web run。浏览器模拟服务已接收但响应丢失，再次提交复用原键并只得到一个任务。 |
| Direct 任务只读列表和详情 | 已实现并测试 | `/api/direct/tasks[/:id]` 提供配对后读取、搜索、状态过滤和分页；详情含续问、附件状态、接收/执行事件。旧 `/direct-tasks` 深链跳转到统一任务面板；当前面板已汇总 Bridge/Direct，支持按来源访问详情及有条件地追加信息。独立 Direct 列表 API 仍只读。 |

## 五项的可复核验收

| 项目 | 当前可核对的验收结果 | 证据入口 | 尚需人工或生产验收 |
| --- | --- | --- | --- |
| 附件生命周期 | ✅ Web 暂存超期清理与已绑定保护；✅ History 终态回看、超期/数量淘汰、运行中保护；✅ 并发绑定和不越界删除；✅ 重启后未知孤儿保留 | [History 附件服务](../src/codex-history-attachments.ts)、[生命周期测试](../tests/codex-history-attachments.test.ts)、[Web HTTP 测试](../tests/web-submission-idempotency.test.ts) | 在隔离浏览器完成 History 附件回看；确定未知孤儿文件的人工清理流程 |
| CI 质量门 | ✅ PR/push 触发、固定 Bun、`--frozen-lockfile`、`bun run test`、`bun run build` 均已写入工作流 | [CI 配置](../.github/workflows/ci.yml)、[Bun 版本](../.bun-version)、[构建脚本](../package.json) | 查看当前提交对应的远端 Actions 结果；失败时记录并修复 |
| 备份与恢复 | ✅ 活跃 WAL 数据入快照；✅ SQLite SHA-256、完整性与 schema 校验；✅ 拒绝现存目标及不可信路径；✅ v1/v2/v3 数据库恢复兼容；✅ 01:00 定时备份、时间戳、每日去重、成功后清理及最近 3 个成功副本保护 | [备份实现](../src/bridge-backup.ts)、[备份测试](../tests/bridge-backup.test.ts)、[CLI](../src/backup-cli.ts) | 将当前版本部署到运行服务；实际凌晨调度与定期恢复检查 |
| Web 幂等提交 | ✅ 相同键和负载只生成一个任务/运行；✅ 不同负载返回 409；✅ 事务失败整体回滚；✅ 已确认 QUEUED run 重启入队、已有回执不重复执行；✅ 响应丢失的隔离浏览器重试 | [提交调度](../src/dispatcher.ts)、[回执表](../src/db.ts)、[幂等测试](../tests/web-submission-idempotency.test.ts) | 使用真实设备与弱网重试检查交互；旧客户端省略键时不保证跨请求去重 |
| Direct 只读入口 | ✅ 配对鉴权、筛选/分页、详情子记录及深链；✅ 旧链接跳转；✅ 不把 Direct 状态写入 Web `tasks/runs` | [Direct API](../src/web.ts)、[统一查询](../src/db.ts)、[页面路由](../web/src/main.tsx)、[HTTP 测试](../tests/web-submission-idempotency.test.ts) | 真实飞书任务与手机浏览器验收；AAMP 尚未并入统一列表 |

五项之外，本分支又实现了 Bridge/Direct 统一列表、原任务条件续问、逐轮详情、Markdown 结果和 tmux 近期重复提交拦截。这些进展已标在[路线图阶段表](product-review-roadmap.md#4-分阶段路线图)，不把它们算作五项的原始交付验收。

## 后续 P1 推进（不计入首批五项）

| 方向 | 当前分支实现 | 尚需验收或补齐 |
| --- | --- | --- |
| 统一入口 | Bridge、Direct、AAMP 三来源列表/详情和待处理筛选；AAMP 只读 | 真实飞书记录与手机回归 |
| 连续任务 | Web 失败/取消显式幂等重试、逐轮人工验收、运行前后 Git 元数据 | 不可变产物/diff 快照与真实手机闭环；共享目录不能自动归因 |
| 可靠续聊 | Codex History 最小运行元数据和哈希幂等回执落库；重启时只读核对官方 thread，不自动重发 | 真实 Codex 运行、断网/刷新/重启交互；tmux 崩溃窗口另行验证 |
| 草稿和快捷键 | Task Desk 与 History 草稿按安装实例/设备会话隔离；本机/跨标签页失效，活动页面每 30 秒检查服务端快捷键版本 | 多设备与浏览器存储受限场景；Task Desk 暂存附件刷新后需重选 |
| 运维 | `backup list/inspect/check-upgrade` CLI 与系统管理操作页；仅 SQLite 的每日定时备份及保留策略；授权运行状态页统计各来源引用并只读预览 tmux 未引用文件 | 部署当前版本并验收实际凌晨调度；实际磁盘用量与跨来源清理策略 |
| 连续任务产物 | 运行前后有界记录变更路径的 SHA-256 和大小；详情显示采集时指纹，并标记超限、不安全或不可读文件 | 当前只保存指纹元数据，不能还原文件内容或查看不可变 diff；指纹采集为工作区级证据，不能归因到单个任务 |
| tmux 送达恢复 | 超过 10 秒等待窗口的持久化 `sending` 记录在只读查询中显示“送达结果未知”，不自动更新数据库或重发；同内容重复提交继续拦截 | 已覆盖数据库重开后的投影行为；进程崩溃注入、用户显式处置流程和浏览器交互仍待验收 |

## 命令与使用边界

源码 checkout：

```bash
bun run backup create --db /absolute/path/bridge.db --out /absolute/path/new-backup
bun run backup verify --backup /absolute/path/new-backup
bun run backup restore --backup /absolute/path/new-backup --out /absolute/path/new-restore
```

Portable 或已链接的 CLI 用 `feishu-codex-bridge backup` 替代 `bun run backup`。必须显式指定源 `--db`；备份输出目录和恢复目录必须不存在。旧脚本的 `--data-root`、`--web-root`、`--direct-root` 和 `--aamp-root` 仍可传入，但不再影响备份范围。

备份只保存 Bridge 主库中的任务、项目、配对记录、附件路径等 SQLite 持久化记录，以及用于校验的 `manifest.json`；不读取或复制附件、配置、项目仓库、Codex 账户数据或其他文件。使用 SQLite 一致性快照覆盖 WAL 中已提交的数据，目录权限为 0700，文件为 0600。数据库文件 SHA-256、SQLite 完整性、外键和结构指纹仍会校验；清单自身没有单独的哈希。`list/inspect` 只读取清单元数据。

Bridge 常驻进程按主机时区每天 01:00 自动备份，名称为 `scheduled-<UTC 时间戳>`，清单标记 `source: scheduled`；手动备份标记 `manual`。该策略适用于 Web-only、Direct 和 AAMP 模式，不依赖浏览器页面保持打开；`--once` 命令不启动定时器。休眠或停机后，当日 01:00 之后恢复运行会补做当日备份，不追补每个历史日期；相同日期的稳定目录名避免重启或共享同库的进程重复发布备份。失败后每分钟重试。

只有新备份完成并通过校验，才按主机日期清理 3 天前且不在最近 3 个成功系统定时备份之内的副本；当日及前两日属于保留日期。失败或损坏的备份不计入成功副本数，保留供检查；手动备份和旧版备份不自动删除。停机多日时，即使旧副本超过 3 天，也会保护最近 3 个成功副本。

新旧格式（v1/v2/v3）均只恢复 `bridge.db` 到全新目录；旧备份内附件文件及其清单记录不参与校验或恢复。库内原有附件路径保持不变，附件是否存在不影响数据库恢复。恢复命令不启动 worker、不覆盖数据库，也不切换正在运行的服务。

提交接口的 `idempotencyKey` 为 1–200 字符；旧客户端可省略，但省略时不提供跨请求去重。浏览器在当前表单未确认成功时保留键，负载改变时换键，确认成功后清除；持久化草稿及刷新后恢复表单仍属于后续阶段。服务器回执跨进程重启保留。服务中断前已开始运行的任务沿用失败标记，不自动重跑；只有尚未执行的 QUEUED Web run 恢复入队。

Direct 列表分页最多 100 条；详情的续问、附件和事件分别按时间倒序分页，展示独立总数。列表来源恒为 Direct，未根据目录或名称推断跨来源关联。

## 验证记录

- 2026-10-02 阶段一历史结果：`bun run test` 242 通过、0 失败（45 个测试文件），使用临时数据库和测试替身；HTTP 测试在允许 loopback 监听的环境运行。`bun run build` 通过，包含 Web 生产构建与前后端类型检查。Vite 当时提示大型 bundle。
- 2026-10-05 当前分支专项复核：附件、备份、tmux 去重相关非 HTTP 用例 15 通过；`tests/web.test.ts` 与 `tests/web-submission-idempotency.test.ts` 在允许 loopback 监听的环境下 13 通过。首次在受限环境运行的 HTTP 用例因无法监听临时端口失败，允许监听后全部通过。本次未重新运行完整测试和构建。
- 新增页面的服务端深链修复后，复跑相关 HTTP 回归与完整构建。
- Headless Chrome 152：隔离实例配对、Web 响应丢失后重试、Direct 分页/搜索/详情/深链刷新、390px 深色宽度检查、注销后 401；执行器为 fake。
- 备份 CLI 演练：从临时库恢复 1 个 Web 任务、32 个 Direct 任务及 Web 幂等回执；三类已下载附件的复制和路径迁移另由自动化测试覆盖。
- 当前复核未测试真实手机、真实飞书事件、真实 Codex 执行、Codex History 浏览器续问或 tmux 浏览器交互，也未查询远端 Actions；没有将自动化测试或构建结果视为这些运行时验收通过。
- 2026-10-07 下一轮专项：备份、运行产物指纹、dispatcher、tmux 提交与系统健康相关测试 29 项通过；前后端 TypeScript 检查、`bun run build:web` 和 `git diff --check` 通过。Vite 仍提示 tmux/dashboard viewer bundle 超过 500 KiB。指纹仅保存 SHA-256/大小，不保存内容；tmux 用测试数据库重开验证只读未知送达投影，未进行进程级故障注入或浏览器/手机验收。
- 2026-10-05 P1 本地完整测试记录：269 通过、0 失败（54 个文件），`bun run build` 与 `git diff --check` 通过。2026-10-07 备份专项 9 项通过，前后端类型检查通过；当前运行 WAL 数据库的 v2 隔离备份/校验/升级兼容/恢复演练包含 47 个 tmux 附件（约 14.1 MiB），恢复后 47 个文件均存在且外键无违例。演练目录已清理，服务未切换。尚未运行 v2 变更后的完整全套测试、浏览器点击、真实设备和远端 CI。
- 隔离 Web-only 进程以临时库绑定 `0.0.0.0:17311`，本机根 HTML 与 `/healthz` 均返回 200；已停止并删除临时库。浏览器连接不可用，未进行页面点击与视觉验收。

- 2026-10-27 SQLite 备份策略：全量 `bun test` 497 通过、0 失败（88 个测试文件、4122 个断言）；前后端 TypeScript 检查、`bun run build:web` 和 `git diff --check` 通过。覆盖 WAL、缺失附件、v1/v2/v3 仅数据库恢复、每日 01:00 时间边界、延迟备份按日期清理、重启/共享库去重、失败不清理及最近 3 个成功副本保护。隔离浏览器在 320/390/1280px 下无横向溢出，已点击创建、校验、升级检查及旧 v1 恢复；恢复目录只包含 `bridge.db`，连续模拟 5 天后保留 3 个系统定时备份，手动备份保留。测试使用临时数据库，隔离服务已停止并清理；未部署安装版或实际等待凌晨执行。浏览器仍有既有 CSP inline-script 与 favicon 404 控制台提示，未将其描述为零错误。
