# 第一阶段交付清单

状态复核日期：2026-10-05。这里的「第一阶段」指原[路线图](product-review-roadmap.md#第一批独立任务交付状态)列出的五项，不等于 A–F 六个阶段全部完成。五项均已进入当前分支 `feature/add_tmux_session_task`，并有本地验证；未据此认定远端 CI、生产部署或真实手机验收通过。人工检查范围见[浏览器冒烟清单](browser-smoke-checklist.md)。

| 项目 | 状态 | 已交付行为 |
| --- | --- | --- |
| 附件生命周期 | 已实现并测试 | Web staged 附件超过 24 小时在启动/上传时清理；已绑定附件不受暂存清理影响。Codex History 的终态 run 每个 thread 最多保留 4 个、全局最多 40 个，运行/取消中的 run 不计入上限；结束后最多保留 24 小时。测试覆盖完成、失败、取消、到期、数量淘汰、并发绑定、越界链接与重启孤儿文件。未知孤儿文件不自动删除。 |
| CI 质量门 | 工作流已实现；远端结果未核对 | `.github/workflows/ci.yml` 对 PR/分支 push 配置 macOS 14、固定 Bun、frozen lockfile、只读权限和过期运行取消，执行完整测试与构建/类型检查。本地曾通过同类命令；本次未查询 Actions 运行结果。 |
| 备份、检查和恢复到新目录 | 已实现并测试 | `backup create/verify/restore` 使用 SQLite 一致性快照、SHA-256 清单及 schema 指纹；新格式清单包含数据库引用的 Web/Direct/AAMP 附件及 tmux 任务提交记录中引用的本机附件。恢复拒绝覆盖现有目录，改写附件路径并验证完整性。恢复旧格式时若发现 tmux 附件引用，会阻止不完整恢复。 |
| Web 任务提交幂等性 | 已实现并测试 | `web_task_submissions` 持久化请求键和规范化负载；同键同内容返回原任务，同键不同内容返回 409。任务、运行、附件绑定与回执在同一事务提交；运行中和终态任务不会因重放再次执行。重启恢复已确认的 QUEUED Web run。浏览器模拟服务已接收但响应丢失，再次提交复用原键并只得到一个任务。 |
| Direct 任务只读列表和详情 | 已实现并测试 | `/api/direct/tasks[/:id]` 提供配对后读取、搜索、状态过滤和分页；详情含续问、附件状态、接收/执行事件。旧 `/direct-tasks` 深链跳转到统一任务面板；当前面板已汇总 Bridge/Direct，支持按来源访问详情及有条件地追加信息。独立 Direct 列表 API 仍只读。 |

## 五项的可复核验收

| 项目 | 当前可核对的验收结果 | 证据入口 | 尚需人工或生产验收 |
| --- | --- | --- | --- |
| 附件生命周期 | ✅ Web 暂存超期清理与已绑定保护；✅ History 终态回看、超期/数量淘汰、运行中保护；✅ 并发绑定和不越界删除；✅ 重启后未知孤儿保留 | [History 附件服务](../src/codex-history-attachments.ts)、[生命周期测试](../tests/codex-history-attachments.test.ts)、[Web HTTP 测试](../tests/web-submission-idempotency.test.ts) | 在隔离浏览器完成 History 附件回看；确定未知孤儿文件的人工清理流程 |
| CI 质量门 | ✅ PR/push 触发、固定 Bun、`--frozen-lockfile`、`bun run test`、`bun run build` 均已写入工作流 | [CI 配置](../.github/workflows/ci.yml)、[Bun 版本](../.bun-version)、[构建脚本](../package.json) | 查看当前提交对应的远端 Actions 结果；失败时记录并修复 |
| 备份与恢复 | ✅ 活跃 WAL 数据入快照；✅ 数据库/附件 SHA-256 与 schema 校验；✅ Web/Direct/AAMP/tmux 附件引用采集；✅ 拒绝现存目标及不可信路径；✅ 恢复后引用路径重定位；✅ 临时库与正式库隔离演练；✅ 旧清单兼容读取 | [备份实现](../src/bridge-backup.ts)、[备份测试](../tests/bridge-backup.test.ts)、[CLI](../src/backup-cli.ts) | 新版正式 tmux 附件备份和恢复演练；定期备份与恢复检查 |
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
| 运维 | `backup list/inspect/check-upgrade` CLI 与系统管理操作页；新清单按引用纳入 tmux 附件；授权运行状态页和各来源附件统计 | 用新版格式对正式 tmux 附件做备份/恢复演练；定期调度、实际磁盘用量与跨来源清理策略 |

## 命令与使用边界

源码 checkout：

```bash
bun run backup create --db /absolute/path/bridge.db --data-root /absolute/path/bridge-install --out /absolute/path/new-backup
bun run backup verify --backup /absolute/path/new-backup
bun run backup restore --backup /absolute/path/new-backup --out /absolute/path/new-restore
```

Portable 或已链接的 CLI 用 `feishu-codex-bridge backup` 替代 `bun run backup`。必须显式指定源 `--db`；自定义 Web/Direct/AAMP 附件目录可通过 `--web-root`、`--direct-root`、`--aamp-root` 补充。tmux 附件目录由 Bridge 固定管理。备份输出目录和恢复目录必须不存在。

备份包含 Bridge 主库中的任务、项目、配对记录等持久化数据及有引用的附件；不包含 `config.json`、项目仓库、Codex 账户数据、内存中的历史续聊映射或未知孤儿文件。附件复制期间检测到文件变化或引用文件缺失会失败，不生成可用备份。默认限制为 10,000 个附件引用、单文件 250 MiB、附件合计 2 GiB。备份目录权限为 0700。备份用于恢复演练，恢复命令不启动 worker、不切换正在运行的服务。

提交接口的 `idempotencyKey` 为 1–200 字符；旧客户端可省略，但省略时不提供跨请求去重。浏览器在当前表单未确认成功时保留键，负载改变时换键，确认成功后清除；持久化草稿及刷新后恢复表单仍属于后续阶段。服务器回执跨进程重启保留。服务中断前已开始运行的任务沿用失败标记，不自动重跑；只有尚未执行的 QUEUED Web run 恢复入队。

Direct 列表分页最多 100 条；详情的续问、附件和事件分别按时间倒序分页，展示独立总数。列表来源恒为 Direct，未根据目录或名称推断跨来源关联。

## 验证记录

- 2026-10-02 阶段一历史结果：`bun run test` 242 通过、0 失败（45 个测试文件），使用临时数据库和测试替身；HTTP 测试在允许 loopback 监听的环境运行。`bun run build` 通过，包含 Web 生产构建与前后端类型检查。Vite 当时提示大型 bundle。
- 2026-10-05 当前分支专项复核：附件、备份、tmux 去重相关非 HTTP 用例 15 通过；`tests/web.test.ts` 与 `tests/web-submission-idempotency.test.ts` 在允许 loopback 监听的环境下 13 通过。首次在受限环境运行的 HTTP 用例因无法监听临时端口失败，允许监听后全部通过。本次未重新运行完整测试和构建。
- 新增页面的服务端深链修复后，复跑相关 HTTP 回归与完整构建。
- Headless Chrome 152：隔离实例配对、Web 响应丢失后重试、Direct 分页/搜索/详情/深链刷新、390px 深色宽度检查、注销后 401；执行器为 fake。
- 备份 CLI 演练：从临时库恢复 1 个 Web 任务、32 个 Direct 任务及 Web 幂等回执；三类已下载附件的复制和路径迁移另由自动化测试覆盖。
- 当前复核未测试真实手机、真实飞书事件、真实 Codex 执行、Codex History 浏览器续问或 tmux 浏览器交互，也未查询远端 Actions；没有将自动化测试或构建结果视为这些运行时验收通过。
- 后续 P1 分支最终本地完整测试为 269 通过、0 失败（54 个文件），`bun run build` 与 `git diff --check` 通过，包含历史续聊 HTTP 同键重放/冲突回归。当前运行主库又在独立临时目录通过备份、校验、升级兼容检查和恢复：8 张关键表备份/恢复计数相同，外键无违例，引用附件 0 个；演练目录已清理，服务未切换。浏览器、真实设备、含附件正式恢复与远端 CI 仍未据此认定完成。
- 隔离 Web-only 进程以临时库绑定 `0.0.0.0:17311`，本机根 HTML 与 `/healthz` 均返回 200；已停止并删除临时库。浏览器连接不可用，未进行页面点击与视觉验收。
