# 人工浏览器冒烟清单

状态（2026-10-02）：已执行下述隔离浏览器检查；真实手机未测试。浏览器结果和真机结果要分别记录，桌面浏览器通过不能代替 iOS/Android 真机验收。

## 隔离要求

- 所有检查使用临时 Bridge 配置、临时 SQLite 数据库、临时附件目录和一次性测试项目。测试项目只能指向新建的 disposable Git 仓库；项目注册表不得包含用户项目或生产目录。
- Bridge 使用 Web-only 模式，并显式传入临时数据库路径。启动前解析数据库真实路径，确认没有符号链接到 `runtime/bridge.db` 或任何生产库。
- Codex History 检查仅使用专用测试 `CODEX_HOME`、测试线程和测试附件；不得打开日常账号的历史或使用生产线程。无法准备隔离测试 home 时，将该项记为未执行。
- tmux Dashboard 使用 Bridge 主机已有的默认 tmux server。只在其中创建名称唯一、工作目录位于临时 fixture 的无害测试 session；Bridge 和测试工具操作前核对 session ID、名称和工作目录。自动化测试可注入 tmux operations fake；人工浏览器检查不得启动或关闭独立 tmux server。
- 不连接 Feishu/AAMP Bot，不使用生产凭据，不向真实项目或用户 session 写入文件。每项结束后清理临时服务、数据库、文件、Codex home 和本次创建的测试 session；不得停止默认 tmux server 或清理其他 session。

## 检查用例

| # | 用例 | 步骤和预期 | 浏览器 | 真机 |
| --- | --- | --- | --- | --- |
| 1 | 配对、鉴权和撤销 | 在未配对浏览器验证受保护 API 拒绝访问；用隔离实例的一次性配对码 claim 后可读取页面；从设备页撤销本设备，再确认受保护页面/API 失效。验证状态变更仍需要 Action Token 和同源请求。 | 配对、注销后拒绝访问已验证；设备页撤销未执行 | 未测试 |
| 2 | Web Task Desk 提交 | 项目选择器只出现临时 fixture；提交一个无副作用的测试任务，检查列表、进度、详情和最终状态。幂等性实现后，在响应丢失/重复点击场景重放同一个 key，确认只保留一个 task/run/worker；使用的目录和 Codex profile 必须是隔离测试资源。 | fake worker 提交及响应丢失后重试通过 | 未测试 |
| 3 | Codex History 续问和附件 | 在专用 CODEX_HOME 中打开预置测试 thread，检查列表和详情；续问时附加一个无敏感信息的小文件，检查新 turn 与附件显示，并确认清理只删除本次暂存文件。不得选择默认用户 home 或真实会话。 | 未执行 | 未测试 |
| 4 | tmux 断线重连和 session 存活 | 连接现有默认 tmux server 中临时创建的测试 session，确认输出来自测试进程；关闭浏览器连接后重新打开并 reconnect，确认同一 session ID 和测试进程仍在。只在显式点击“结束 Session”后清理该测试 session。 | 未执行 | 未测试 |
| 5 | Session 文件预览和上传边界 | 在临时 session 工作目录放置测试文本；确认可预览并上传小文件到当前目录，同名文件冲突不会覆盖。尝试 `../` 穿越及指向目录外的符号链接，服务应拒绝访问；检查 fixture 外没有文件被读取或写入。 | 未执行 | 未测试 |
| 6 | Direct 任务查看 | 对隔离 Direct fixture 检查状态/关键词筛选、列表和各详情分页、续问/附件/事件、详情深链刷新，以及没有未经授权的写入操作。 | 30/2 分页、搜索、详情、刷新与手机宽度检查通过 | 未测试 |

## 记录

每次运行记录日期、浏览器及版本、Bridge commit、使用的 fixture 标识、各用例结果和失败证据。真实手机需单独记录设备型号、OS 版本、浏览器和结果；没有运行时标记为“未测试”，不要用构建或 API 检查替代。


## 2026-10-02 隔离运行

- 浏览器：Headless Chrome 152，另以 390 × 844 viewport 检查 Direct 深色详情无横向溢出；不代表真机验收。
- 基线：`feature/add_tmux_session_task` 工作区的阶段一未提交改动（HEAD `9348499`）。使用临时 SQLite、disposable Git 项目和假的 worker；无 Feishu/AAMP/Codex 调用。
- Direct 新增检查：32 条 fixture 记录分页为 30/2，关键词过滤到 1 条，详情显示续问/附件状态/事件，详情深链刷新成功。
- Web 提交：拦截第一次 POST 的响应，服务确认 201 后模拟网络失败；页面重试复用同一键，API 最终只有 1 个任务，状态为 WAITING_REVIEW。
- 配对：未配对显示引导页面，配对后可读取；注销后 Direct 与 Task Desk API 返回 401，刷新回到配对引导。设备管理页的撤销按钮未验证。
- Codex History 续问、tmux 重连、Session 文件浏览仍未执行浏览器检查。
- 已知控制台现象：原有主题初始化 inline script 被 CSP 拒绝；首次请求 favicon 404。故障注入产生一次预期的 Failed to fetch。此次没有把控制台标为无错误，也没有修改这些既有行为。
