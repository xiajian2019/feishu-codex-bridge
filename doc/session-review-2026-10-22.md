# 项目会话复盘与风险评审（2026-10-22）

评审源码基线：`543238f2fdf5ed68bd1d25bad418ec7739bc7b71`，分支 `feature/add_tmux_session_task`。初次评审只更新文档；随后按用户要求在当前工作区修复 N2/N3，具体证据见各项后续记录。其余风险保持待办，没有执行安装版部署或手动启停服务。

## 1. 会话覆盖与决策依据

通过项目现有 `CodexAppServerClient` 调用 ChatGPT App 内置 CLI 的 `thread/list`、`thread/read`，关闭 notify hook；按当前仓库 cwd 分别查询两个可用 Home 的未归档/已归档会话并按 thread ID 去重。共返回 **54 个 thread，478 条用户消息**，包括本次对话；默认 Home 49 个，second 5 个。second 的 5 个 thread 本次返回的用户消息均为空，不能因此推断原始会话内容已丢失。本统计不包含其他 cwd 或未登记 Home。

以各会话用户需求及后续纠正为主，长消息按相关主题复核；工具执行记录不作为逐条审计对象。没有把完整会话、图片、凭据或运行数据库写入仓库。历史记录用于确认意图，代码用于确认现状；已回退的实验不记作功能交付。

| 反复出现的主题 | 本次确认的长期约定 | 代表会话 |
| --- | --- | --- |
| 开发服务反复无法访问、重启目标混淆 | 开发是 5173/17310、LAN 绑定、后台存活；按原有约定选择主库软链接，但它与 7310 的启停范围不同 | `01a0ea83…`、`01a0eb63…`、`01a163a1…` |
| 终端只更新部分画面、resize 后滚动失效 | 初始快照优化、后续本地 scrollback、用户上翻位置、复制/链接都必须保留；原始 PTY/ANSI 过滤实验已回退 | `01a0daec…`、`01a118dd…`、`01a15244…`、`01a163a1…` |
| 长按复制多次改值 | 最后确认是 1.5 秒；双端点独立拖动，复制成功后再清除；原 AGENTS 的 3 秒已纠正 | `01a0eb94…` |
| 列表与详情信息密度 | 减少重复标题、英文装饰、说明和留白；操作靠近标题；共享布局同时覆盖所有页面 | `01a0db2a…`、`01a118dd…`、`01a14a4c…` |
| iOS 自动放大与主题可读性 | 可编辑输入至少 16 px，普通导航不随之放大；暗色 hover、选中、错误提示都要能看清文字 | `01a0e211…`、`01a0e8b9…` |
| Home 切换、历史缓存与 Token | 区分顶部筛选、thread 持久偏好和历史实际归属；日统计持久化，不展示无可靠来源的模型统计 | `01a0f084…`、`01a11b59…` |
| Demo 新页与日志复制 | 保留当前工作页；异步启动预开标签页；日志复制图标放框内右下角 | `01a14a4c…`、`01a156a9…` |
| 统一任务面板与执行链路 | 聚合展示、独立执行/恢复；History 参数不误加到 tmux 快捷键，文件操作按实际入口定位 | `01a104ea…`、`01a0eb94…`、`01a0e211…` |
| 多次要求“全部提交” | 用户明确指定全量时覆盖当前 checkout 全部已审阅代码变更；提交后确认无遗漏，不把范围缩成当前会话改动 | `01a156a9…`、`01a163a1…` |

上述约定已合入根目录 [AGENTS.md](../AGENTS.md)。本文件保存证据与待办，避免将整份风险清单堆进常驻项目指令。

## 2. 当前风险（按优先级）

P1 表示应优先修复、会影响任务正确性/控制边界或造成已观察到的操作回归；P2 表示后续治理。这里的“复现”均使用隔离 fixture，不表示曾在正式数据上执行相同操作。

### N1 / P1：共用数据库的服务会错误恢复另一实例的活动任务

**证据**：`src/main.ts:75` 在创建 Dashboard Dispatcher 时调用恢复；开发 Web-only 也经过这个入口。`src/db.ts:3664` 的 `recoverInterruptedRuns()` 查询所有 `RUNNING`，没有核对 `service_instance_id`、owner 存活或租约。`src/codex-history.ts:459` 在每次构造服务时，把持久化的 `running/cancelling` 改为 `interrupted` 并写回。

**隔离复现**：两个 `StateDatabase` 连接指向同一临时库。连接 A 写入一个 owner 仍存活的 `RUNNING` run，连接 B 执行启动恢复，状态立即变成 `FAILED`。随后 A 正常完成，得到 **run 为 `WAITING_REVIEW`、task 仍为 `FAILED`** 的不一致结果。History 的活动记录也被另一个服务构造过程改成 `interrupted`。

**影响**：当前开发管理器默认指向主库软链接，开发重启/watch reload 可以干扰安装版活动任务；安装版重启也可能影响开发任务。SQLite WAL 只解决数据库并发访问，不解决业务 owner 归属。`Dispatcher.pump()` 还在 DB claim 之前启动 worker（`src/dispatcher.ts:602`），多实例同时取队列时存在抢占前启动的窗口。

**建议**：为 Task Desk/History 增加跨进程 owner 与租约，先原子取得执行权再启动 worker；只恢复 owner 已失效的 run，完成写入也核对 owner/当前状态。沿用用户的主库选择约定；自动化演练使用临时库，不能用悄悄切换 DB 掩盖归属问题。

**验收**：A 运行、B 启动/重启时 A 的状态和中断能力不变；两个实例竞争同一队列只启动一个 worker；杀掉 A 后才允许符合策略的恢复；task/run 最终状态一致。

### N2 / P1：tmux 和部分设备写接口绕过统一 Action Token/同源检查

**后续修复（当前工作区）**：tmux 的非只读方法及设备管理写接口统一校验身份、Action Token 和同源；初次 pairing claim 用一次性配对码并检查 Origin，诊断导出作为同源的只读表单 POST 保留。前端附件上传/设备改名/撤销/生成配对码同步携带 token。`tests/web-connection-security.test.ts` 覆盖 8 个写入口的未配对/缺 token/错误 token/不同 Origin 拒绝，以及合法创建、删除、配对与诊断导出；原始复现证据保留如下。

**证据**：`src/web.ts:326` 只为 tmux 写操作中的几个具体 POST 路径调用 `requireActionAuthorization()`，遗漏 `POST /sessions`、`DELETE /sessions/:id`、`POST /attachments`。配对开始、设备撤销等分支（`src/web.ts:261` 起）也直接走 session 鉴权，没有等价 Action Token 检查。

**隔离复现**：使用已配对 fixture cookie、不带 Action Token、携带不同 Origin 请求，假的 tmux 创建返回 **201**、删除返回 **204**；普通 `/api/projects` 写接口对相同请求返回 **403**。未创建或删除任何真实 tmux session。

**边界**：这证明服务器写入校验不一致，不是“未配对用户可直接执行命令”的证据。`SameSite=Strict` 能缓解部分浏览器跨站攻击，但不替代服务器同源/Action Token 契约，尤其是同站不同端口和开发环境本地信任场景。

**建议/验收**：按 HTTP 方法统一保护状态修改，只为 pairing claim 等必要入口设置明确例外；附件下载/诊断导出区别处理。逐条验证未配对 401、已配对但缺 token/跨源 403、有效同源请求成功；后端校验不依赖前端是否主动发了 token。

### N3 / P1：撤销设备没有终止已建立的终端连接

**后续修复（当前工作区）**：WS/SSE 绑定原配对 cookie，发送输出、处理输入和异步提交继续执行前重新检查权限；同实例撤销/登出同步清理连接，另一实例写库或会话过期通过逐次校验及每秒检查处理空闲连接。仅关闭 attach 客户端，保留 tmux session；等待中的粘贴不再补发回车。新隔离测试覆盖单设备撤销不影响其他设备、全部撤销/登出、跨 DB 连接撤销、空闲 WS/SSE、过期 cookie、粘贴等待与未完成的初始快照。尚未做真机操作验收。

**证据**：`src/web.ts:2854` 仅在 WebSocket upgrade 时检查身份；`src/tmux-dashboard-api.ts:1202` 的消息处理沿用建立连接时的 `deviceId`，没有重新确认设备未撤销。SSE 也只清理关闭的连接，未保存设备身份以响应撤销（`src/web.ts:2877`）。

**隔离复现**：配对后建立假的 tmux WebSocket，执行 `revokeAll()`；随后 HTTP 鉴权已为 **false**，同一连接仍能把 `input` 写入 fake terminal。

**建议/验收**：按设备记录连接，撤销时关闭对应 WebSocket/SSE，并在命令执行前核验会话有效性；方案需覆盖两个实例共用库时的撤销传播。撤销后旧连接无法继续读/写，新 HTTP/WS 均拒绝；关闭的只是 attach 客户端，tmux session 和内部 Codex 仍存活。SSE 泄漏后续事件为源码推断，本次只复现了 WebSocket 输入。

### N4 / P1：开发服务的 PID/ready 判定不能证明进程身份

**证据**：`scripts/dev-server.mjs:121` 只读取数值 PID、检查进程组存在就发 TERM/KILL；没有核对 cwd、命令、创建时间和端口归属。`waitForReady()` 只看 URL 的任意 2xx；`restart` 先停掉两个服务再开始检查/启动（第 240 行）。

**现象**：本会话实际遇到“Vite/API 已停止，但 17310 仍被无记录进程占用”，restart 失败并留下 Vite 停止的半可用状态。PID 重用导致误杀、旧 listener 使新进程误报 ready 是源码确认的防护缺口，未对真实进程做故障注入。

**建议/验收**：状态文件保存启动身份与配置/DB 指纹，增设管理锁；停止前核对进程身份，启动后核对 port owner 和实例 ID；stop 后重新确认 listener 已释放，失败时返回两个服务各自状态。用 stale PID、被占端口、重复 restart 和半启动失败的 fixture 验证，不能杀错进程或对旧 listener 报启动成功。

### N5 / P1：部署命令的中断与源码回退没有覆盖运行产物

**证据**：`scripts/deploy-portable-release.mjs:84` 将构建、更新、`restart: true`、服务 start/status 串在一次调用内；子进程启动没有显式的取消传播契约。取消外层工具等待不能证明这些阶段已停止。

**现象**：本会话用户把目标纠正为开发环境后，先前启动的 Portable 部署仍完成了安装入口切换/7310 重启。后来源码回退只恢复 checkout，已安装二进制不会随之恢复。这个事件不能归类成“生产没动过”。

**建议**：开发重启与安装版部署入口明确分开；构建完成先输出产物、目标、旧版本和新版本供核对，再进入已有授权范围内的激活阶段。父命令需要跟踪子进程、在安全阶段响应取消，激活阶段采用明确完成/回滚策略并输出实际结果。取消后检查真实进程和安装入口；不要自动覆盖数据库。

**验收**：分别在构建中、激活前、激活中取消；激活前不应切换版本，激活中必须得到完成或回滚的确定结果。代码/安装包/运行进程三个状态都有证据。测试使用临时安装目录和假的 lifecycle，不操作现有 7310。

### N6 / P1：终端仍缺少可验证的快照与增量同步契约

**证据**：`src/tmux-dashboard-api.ts:1457` 在初始快照 ready 之前丢弃 PTY 输出；`captureInitialScreen()` 固定等待 60 ms、优先 `capture-pane -a -e`，以清屏和换行写到浏览器（第 1490 行）。这是文字/样式快照与后续终端控制流的拼接，不是完整 parser 状态恢复。xterm 自带实现明确 alternate buffer 没有 scrollback，见 `node_modules/@xterm/xterm/src/common/buffer/BufferSet.ts:42`。

**现象与不确定性**：用户报告局部画面不更新，重新进入恢复；本会话改成原始 PTY 后滚动回归，追加 ANSI 过滤后仍不能滚动，两轮均已回退。现有源码能证明同步边界有缺口，**尚不能证明原截图的唯一根因**，也不能把“替换为原始 PTY”记为正确修复。

**建议**：先在默认 tmux server 的临时 fixture 收集接收序号、buffer type、`baseY/viewportY`、尺寸、render 范围和时序；分别检查 buffer 已更新但 canvas 未绘制、视口停在历史、snapshot/PTY 状态不一致。再确定如何同步，保留低重绘和本地历史滚动。

**验收**：只读/输入两种模式；首次/重连；持续输出 30 秒与静止画面；上翻历史后继续输出；resize/软键盘开合；长按 1.5 秒、选择复制、链接新页。用真实 iOS 验证；字符串过滤单测和类型检查不替代这些结果。步骤补入 [浏览器冒烟清单](browser-smoke-checklist.md)。

### N7 / P2：终端输出缺少慢客户端背压与半开连接检测

**证据**：`src/tmux-dashboard-api.ts:1164` 的队列达到 256 KiB 就 `client.send()`，限制的是本轮批量大小；没有检查 `client.bufferedAmount`、限制连接数或等待客户端处理确认，也未见 ping/pong 心跳。前端从后台回来时 `connect()` 对仍标记 OPEN 的 socket 直接返回（`web/src/TmuxDashboard.tsx:892`）。

**影响/建议**：移动弱网、大量输出或半开 TCP 下可能出现发送积压、内存增长或“看起来连上但没更新”。尚未负载复现。为每连接设待发字节上限、后台/空闲心跳和可观测计数；超限后安全关闭 attach 并重新同步，不能随意丢 ANSI 字节或杀掉 tmux session。模拟暂停读取与半开连接，记录 RSS、buffered bytes 和恢复时长再定参数。

### N8 / P2：History 正文缓存没有跟随设备作用域和撤销清理

**证据**：`web/src/CodexHistory.tsx:110` 的 key 只含 home/thread；缓存保存完整 detail（最多 3 项、单项 600,000 字符、TTL 1 小时），移除部分路径不等于移除对话正文。`web/src/local-draft-cleanup.ts:5` 只清理草稿与 pending submission，没有清理 History detail 或 tmux 草稿。`AuthGate` 初始化后也没有持续复核已撤销状态。

**建议/验收**：将敏感缓存按 installation/device scope 隔离，撤销/登出和检测 401 后统一清理对应数据；所有正文缓存保留容量和 TTL。共享浏览器重新配对、切换 Bridge 实例、另设备撤销当前设备时，旧详情和旧附件草稿不应混入新作用域。这是源码审查结论，本次没有运行浏览器隐私场景。

### N9 / P2：Demo 页面与工作台共享 Origin，且子进程生命周期不完整

**证据**：`src/web.ts:374` 把本地 Demo HTML/JS 直接代理到工作台 Origin；第 2778 行清除了上游 cookie，但浏览器执行的 Demo 脚本仍与 Bridge 同源，具有向 Bridge 发起带 cookie 请求的能力。第 2706 行启动脚本只保存在内存 Map，stop 时只向直接子进程发送 TERM（第 234 行），没有验证后代退出或端口释放。

**建议**：将 Demo 明确视为受信任代码；如果要加载来源不同的应用/插件，采用独立 Origin 或受限 sandbox 和短期访问凭证。区分 starting/ready/failed，管理脚本及其子进程并检查实际 port owner；同一 Demo 的健康响应不能证明由本次启动的进程提供。本次没有执行不可信脚本或探测真实 Demo 数据。

## 3. 可以进一步优化的部分

| 顺序 | 优化切片 | 可验证的完成条件 |
| --- | --- | --- |
| 1 | Task Desk/History 实例归属与恢复（N1） | 两个实例共库并行、任一重启、owner 被杀的场景均不会错误恢复另一实例；先 claim 再启动，task/run 一致 |
| 2 | 写接口与长连接撤销（N2/N3） | HTTP 路由鉴权矩阵覆盖；撤销后已建立连接不能继续读写；跨实例生效 |
| 3 | 开发管理器和部署状态（N4/N5） | stale PID 不误杀、同端口旧进程不误报 ready；取消部署给出明确阶段和产物状态 |
| 4 | 终端观测与移动回归（N6/N7） | 先重现原问题并保留诊断，再做一项改动；新旧实现通过同一真机矩阵，弱网和大量输出有边界 |
| 5 | 缓存与 Demo 边界（N8/N9） | 撤销清除当前作用域的敏感缓存；Demo 信任范围、进程 owner、ready 状态明确 |
| 6 | Git 变更页按需读取 | `inspectGitChanges()` 当前每次完整 status、逐文件 stat、全量 diff；先统计大仓库请求耗时，再将文件列表/选中文件 diff/内容预览拆开。已有 diff 不因内容预览仍在 loading 而被遮住（`web/src/TmuxGitChanges.tsx:293`） |
| 7 | 按职责拆模块 | `web.ts` 3,498 行、`db.ts` 5,094 行、`tmux-dashboard-api.ts` 1,770 行；优先抽出统一鉴权、终端传输、Demo supervisor、owner/recovery。每次移动一个职责并保留接口回归，避免整体重写 |

首页/导航、任务聚合、草稿和幂等回执已具备基础，不需要重新从零设计。优化优先围绕“手机看到的状态可信、能恢复、能撤销、不会误操作另一环境”，再做样式和性能。

## 4. 验证证据与未覆盖范围

- 隔离诊断复现 **4 项**：Task Desk 跨连接错误恢复及最终 task/run 不一致；History 构造时覆盖活动状态；HTTP Action Token 路由缺口；撤销后 WebSocket 仍接受输入。使用 disposable SQLite、临时 localhost 端口和 mock tmux，未调用真实 Codex/Feishu。临时 DB 已清理。
- 原始诊断脚本保留在被忽略的 `tmp/project-review-2026-10-22.ts`，针对基线 `543238f` 断言原漏洞存在，不用于验证修复后的行为。N2/N3 的正式回归位于 `tests/web-connection-security.test.ts`；原始诊断未纳入提交。
- 本地相关测试：`bun test tests/db.test.ts tests/codex-history-recovery.test.ts tests/main.test.ts tests/web-auth.test.ts tests/tmux-submission.test.ts tests/git-workspaces.test.ts`，**37 pass / 0 fail，208 expectations**。这些测试通过仍未覆盖本次发现的多实例和撤销后连接场景。
- 远端当前 SHA 的 [CI run 39797646363](https://github.com/xiajian2019/feishu-codex-bridge/actions/runs/39797646363) 为 **completed / success**，另一条同 SHA [CI run 39797637925](https://github.com/xiajian2019/feishu-codex-bridge/actions/runs/39797637925) 同样成功。没有新建工作流运行。
- 受限沙箱首次临时监听报告 `port 0 EADDRINUSE`；在允许 loopback 的上下文重跑诊断成功。不能仅凭这一错误认定测试并发竞态。
- 本次未重跑完整测试/生产构建，未执行手机或浏览器 E2E、压测、真实 task 故障注入、正式数据写入、服务重启、安装版回滚、commit/push。N4–N9 中未注明隔离复现的部分属于源码/已有会话证据，应在后续实施时验证。
- N2/N3 后续修复：安全、HTTP、鉴权、tmux 提交和任务工作区相关测试最终 26 通过、0 失败，279 expectations；其中新增安全场景 10 项。覆盖被撤销 cookie 无法重新建立终端连接，后端/前端类型检查与前端构建通过（保留已有 Vite 大 chunk 警告）。未执行手动服务重启、安装版部署或真实终端输入；watch 模式可能随源码变化自行 reload。
- 共享工作区的其他会话同时新增了快捷键迁移代码与测试；扩展检查曾在 `tests/shortcut-config.test.ts` 的 `upgrades old TUI keys once while preserving custom ordering, labels and disabled keys` 发现数据库重开后 `updated_at` 不一致。该部分不属于 N2/N3 修复，未覆盖其改动或放宽断言，因此没有把扩展检查描述为全部通过。

## 5. 第一批实施检查表

- [ ] N1：设计 Task Desk 与 History 的 owner/lease，补跨实例启动与恢复用例，保持 Direct 独立状态机。
- [x] N2：统一 tmux/设备管理的 Action Token/同源检查，补必要例外、前端调用和隔离 HTTP 回归。
- [x] N3：WS/SSE 绑定配对身份并持续校验，覆盖同库多实例撤销；只关闭 attach，fake session 未被删除。
- [ ] N4：dev manager 增加身份握手、管理锁和端口复查，补启动失败/残留进程用例。
- [ ] N5：将构建与激活阶段的状态、取消及回滚结果显式输出，用临时安装 fixture 演练。
- [ ] N6：先保存原问题的诊断与手机行为基线，再提交可单独回退的终端修复并完成真机矩阵。

N2/N3 的勾选表示当前工作区已有源码和隔离回归证据，不代表安装版部署或真机验收；其余运行风险继续作为独立任务实施。
