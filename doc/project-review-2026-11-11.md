# 项目复核与文档状态（2026-11-11）

本次以当前 checkout `feature/capacitor-mobile-app`、源码和配置为现状依据。工作区含其他未提交 Android、iOS、Web 与 APK 构建改动；本次只更新文档，不据此推断这些代码已部署、打包或通过真机验收。历史评审中的代码行号和测试状态不自动代表当前实现。

## 当前架构摘要

| 入口 | 执行方式与状态来源 | 当前边界 |
| --- | --- | --- |
| 飞书 Direct | `FeishuSqliteCodexRuntime` + Codex SDK；独立 `bridge_tasks` / follow-up / outbox | 不与 Web Task Desk 的 `tasks/runs` 合并 |
| Web Task Desk | `Dispatcher` + worker + Codex SDK；SQLite 保存 task/run/workspace | 可配置独立 Git worktree；其所有者和跨实例恢复仍需改进 |
| Tmux Dashboard | 浏览器经 Bridge WebSocket 连接 Bridge 主机 tmux；可显式开启原始终端输入 | 不代表手机直连 SSH，也不会操作 pane 内的另一台 SSH 主机 |
| Android / iOS SSH | 手机原生 SSH 直接连接 SSH 主机；iOS 为 SwiftNIO/SwiftTerm 工作区 | 与 Web tmux 是不同传输和生命周期；真机状态不能由 Web 模拟推断 |
| Codex History | `CodexHistoryService` 管理详情和续聊 | 当前 thread 列表优先直接只读 Codex state SQLite，详情经 `thread/read`；列表方式违反项目约定，详见 R4 |

## 需要跟进的发现

### R1 / 高：共享数据库启动恢复会中断另一实例的活动 Web run

`src/main.ts` 创建 Dashboard Dispatcher 时调用 `recoverInterruptedRuns()`；`src/db.ts` 按 `state='RUNNING'` 恢复，没有按 `service_instance_id`、存活 owner 或租约过滤。两个同时打开同一临时 SQLite 的连接中，连接 B 可将连接 A 的 RUNNING run 和 task 标为 FAILED；连接 A 随后完成后，run 变成 WAITING_REVIEW，但 task 仍 FAILED。

复核使用独立临时数据库完成：`before={task:RUNNING,run:RUNNING}`，另一连接恢复后均为 FAILED；模拟原 worker 完成后 task/run 状态不一致。History 服务构造时也会把共享库中所有 `running/cancelling` 元数据恢复为 `interrupted`。这证明数据库恢复逻辑没有实例所有权边界，不代表访问过真实 Bridge 数据库或运行中的 Codex worker。

建议优先为 Web Dispatcher 和 History run 增加原子 owner/lease，只有确认 owner 失效后才恢复；worker 完成写入也需校验 owner 和活动状态。以两个服务实例共库、owner 正常完成、owner 被杀的临时数据库用例验收。

### R2 / 高：无快照的 Session 恢复会被同步流程标记结束

`tmux-resurrect` 的批量恢复遇到“候选 Session 没有快照”时直接跳过，不加入 `failures`。随后 CLI 按 `failures.length===0` 计算 `synced:true`，并把当前 tmux 列表同步进数据库；缺席的活动 Session 记录会被标记 ended，后续候选筛选又排除 ended 记录。

用临时 SQLite、fake tmux 列表和 fake resurrect 结果复现：有一个候选、没有恢复项、没有 failures 时返回 `synced:true`，原数据库记录变为 ended。真实插件的“无快照即跳过”分支已在源码核实；没有连接真实 tmux 或运行数据。另有单 Session 恢复异常被放入 `failures` 时，CLI 仍打印 `ok:true` 且退出码为 0；`synced` 仅由 failures 推导，而数据库 busy 时 `syncTmuxSessions` 会吞掉异常，因此 `ok`/`synced` 都不能单独证明恢复和写库成功。

在 CLI 行为修复并增加失败/无快照/SQLite busy 测试之前，执行手动恢复前应确认插件快照存在，并逐项核对 `candidates`、`restored`、`failures`、`synced` 及最终 Session 列表。

### R3 / 高：iOS SSH 诊断将任意底层错误公开写入日志

`BridgeIOSSHWorkspace.swift` 的 `bridgeIOSSHErrorDetails()` 直接使用 `String(describing: error)`，只按字符数截断；其结果进入可复制诊断缓冲，并由 `OSLog` 以 `privacy: .public` 记录。网络、SSH pipeline、Keychain 等错误若包含主机、路径或其他上下文，截断本身不会脱敏。本次没有发现凭据实际泄漏的运行证据；这是需修复并测试的暴露面。

建议记录稳定错误类别、domain/code 和连接阶段，避免输出任意 `localizedDescription` / `String(describing:)`；对用户可复制日志和系统日志使用同一明确的脱敏函数，并用带 host/path/secret 的 fake Error 验证不含敏感值。

### R4 / 高：Codex History 列表实现违反项目数据访问约定

项目 `AGENTS.md` 规定 History 通过官方 app-server `thread/list` / `thread/read`，禁止直接解析 Codex SQLite 或 JSONL。当前 `CodexHistoryService.queryHome()` 优先查询 `state_*.sqlite` 的 `threads` 表和 `thread_history_*.sqlite` 的 `thread_turns` 表；只有没有可用表时才回退 `thread/list`。详情仍使用 `thread/read`，续聊使用 SDK，显式交互审批使用 app-server。

这属于实现与项目约定的确定性偏差，不能在 README 或接口说明中写成列表始终通过 app-server。应单独决定恢复官方接口读取，或先修订项目政策并处理上游私有 schema 漂移风险；本次只在文档标出偏差，没有修改 History 实现。

### R5 / 中：Web 终端桌面链接点击没有通过浏览器回归

隔离浏览器中，终端首行的 HTTP 链接在桌面鼠标点击没有打开新页；同一 fixture 下手机触摸链接可以打开。现有 `registerTerminalLinkProvider()` 将 xterm 回调的 `bufferLineNumber` 再次用于 0-based `getLine()`，返回 range 时又加一，代码位置需要按 xterm 1-based 行号合同复核。链接代码不在本次工作区改动中；该结果是隔离页面观察，不是真实 tmux 或设备证据。

### R6 / 中：tmux 输出队列按批 flush，但没有慢客户端积压上限

`src/tmux-dashboard-api.ts` 将 PTY 输出按 256 KiB 批次发送，并具备 ping/pong 心跳与授权重验；这限制单次批次，不等于限制 `WebSocket.bufferedAmount` 或客户端总积压。当前没有慢客户端背压/积压上限的实测结论。建议在加入限流前以隔离的暂停读取客户端测量缓冲和恢复行为，不能直接丢 ANSI 字节或关闭 tmux session。

## 文档处理约定

- `doc/session-review-2026-10-22.md`、`doc/product-review-roadmap.md`、`doc/phase-one-checklist.md`、`doc/worktree-task-integration-plan.md` 等包含固定基线、日期和测试结果的文件保留为历史记录；引用它们时需标明历史日期。
- 当前构建说明、README 架构表、运维流程和移动端功能矩阵应以当前源码与脚本为准；“本地编译/隔离浏览器通过”不写成已部署或真机验收。
- 本次没有运行完整测试套件、全量构建、真实服务、真实 tmux/SSH、iOS 或 Android 设备。两项恢复风险使用独立临时 SQLite 与 fake 执行器复现；临时目录在结束时清理。
