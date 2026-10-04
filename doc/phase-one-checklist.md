# 第一阶段交付清单

状态更新日期：2026-10-02。本阶段五项已实现并完成本地验证；当时尚未提交、发布或重启生产服务。本清单记录阶段一的历史快照，当前提交和远端 CI 状态应以 Git 和 GitHub Actions 为准。原始评审见 [路线图](product-review-roadmap.md)，浏览器检查范围见 [冒烟清单](browser-smoke-checklist.md)。

| 项目 | 状态 | 已交付行为与证据 |
| --- | --- | --- |
| 附件生命周期 | 已实现并测试 | Web staged 附件超过 24 小时在启动/上传时清理；已绑定附件不受暂存清理影响。Codex History 的终态 run 每个 thread 最多保留 4 个、全局最多 40 个，运行/取消中的 run 不计入上限；结束后最多保留 24 小时。测试覆盖完成、失败、取消、到期、数量淘汰、并发绑定、越界链接与重启孤儿文件。未知孤儿文件不自动删除。 |
| CI 质量门 | 已实现，本地命令通过 | `.github/workflows/ci.yml` 在 PR/分支 push 上执行；macOS 14、固定 Bun、frozen lockfile、只读权限、取消过期运行。运行完整测试和构建/类型检查；尚未推送，远端 Actions 未运行。 |
| 备份、检查和恢复到新目录 | 已实现并测试 | `backup create/verify/restore` 使用 SQLite 一致性快照、SHA-256 清单及 schema 指纹；包含持久化关联的 Web/Direct/AAMP 附件。恢复拒绝覆盖现有目录，改写附件路径并验证完整性。测试覆盖 WAL、符号链接数据库入口、附件篡改、路径穿越和失败清理。CLI 在临时库完成创建、校验、恢复，并验证任务和幂等回执。 |
| Web 任务提交幂等性 | 已实现并测试 | `web_task_submissions` 持久化请求键和规范化负载；同键同内容返回原任务，同键不同内容返回 409。任务、运行、附件绑定与回执在同一事务提交；运行中和终态任务不会因重放再次执行。重启恢复已确认的 QUEUED Web run。浏览器模拟服务已接收但响应丢失，再次提交复用原键并只得到一个任务。 |
| Direct 任务只读列表和详情 | 已实现并测试 | `/direct-tasks` 与 `/api/direct/tasks[/:id]` 提供配对后读取、搜索、状态过滤、分页和深链；详情含续问、附件状态、接收事件和执行事件。只读 Direct 自己的表，未增加取消/重试/续问写接口。HTTP 与桌面/390px 浏览器检查通过。 |

## 命令与使用边界

源码 checkout：

```bash
bun run backup create --db /absolute/path/bridge.db --data-root /absolute/path/bridge-install --out /absolute/path/new-backup
bun run backup verify --backup /absolute/path/new-backup
bun run backup restore --backup /absolute/path/new-backup --out /absolute/path/new-restore
```

Portable 或已链接的 CLI 用 `feishu-codex-bridge backup` 替代 `bun run backup`。必须显式指定源 `--db`；自定义附件目录可通过 `--web-root`、`--direct-root`、`--aamp-root` 补充。备份输出目录和恢复目录必须不存在。

备份包含 Bridge 主库中的任务、项目、配对记录等持久化数据及有引用的附件；不包含 `config.json`、项目仓库、Codex 账户数据、内存中的历史续聊映射或未知孤儿文件。附件复制期间检测到文件变化或引用文件缺失会失败，不生成可用备份。默认限制为 10,000 个附件引用、单文件 250 MiB、附件合计 2 GiB。备份目录权限为 0700。备份用于恢复演练，恢复命令不启动 worker、不切换正在运行的服务。

提交接口的 `idempotencyKey` 为 1–200 字符；旧客户端可省略，但省略时不提供跨请求去重。浏览器在当前表单未确认成功时保留键，负载改变时换键，确认成功后清除；持久化草稿及刷新后恢复表单仍属于后续阶段。服务器回执跨进程重启保留。服务中断前已开始运行的任务沿用失败标记，不自动重跑；只有尚未执行的 QUEUED Web run 恢复入队。

Direct 列表分页最多 100 条；详情的续问、附件和事件分别按时间倒序分页，展示独立总数。列表来源恒为 Direct，未根据目录或名称推断跨来源关联。

## 验证记录

- `bun run test`：242 通过、0 失败（45 个测试文件），使用临时数据库和测试替身；HTTP 测试在允许 loopback 监听的环境运行。
- `bun run build`：通过，包含 Web 生产构建与前后端类型检查。Vite 仍提示已有大型 bundle。
- 新增页面的服务端深链修复后，复跑相关 HTTP 回归与完整构建。
- Headless Chrome 152：隔离实例配对、Web 响应丢失后重试、Direct 分页/搜索/详情/深链刷新、390px 深色宽度检查、注销后 401；执行器为 fake。
- 备份 CLI 演练：从临时库恢复 1 个 Web 任务、32 个 Direct 任务及 Web 幂等回执；三类已下载附件的复制和路径迁移另由自动化测试覆盖。
- 未测试真实手机、真实飞书事件、真实 Codex 执行、Codex History 浏览器续问或 tmux 浏览器交互；没有将自动化测试或构建结果视为这些运行时验收通过。
