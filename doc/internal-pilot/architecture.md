# 架构图

## 1. iPhone 接续 Mac 上已有的 Codex session

这是第一场内部演示的主流程。Codex 继续运行在 Mac 上；iPhone 浏览器通过 Bridge 查看并向选中的 session 发送消息。

```mermaid
flowchart LR
    Phone["iPhone Safari<br/>Tmux Dashboard"]
    Auth["Web 配对会话<br/>认证与授权"]
    Bridge["Mac 上的 Bridge<br/>Web API / TmuxDashboardApi"]
    Tmux["Mac 上已有的 tmux server<br/>选中的 session / pane"]
    Codex["pane 中运行的 Codex"]
    Files["该 session 的工作目录"]

    Phone <-->|"受保护页面 / API / WebSocket"| Auth
    Auth <-->|"读取输出、发送消息、文件操作"| Bridge
    Bridge -->|"发送到选中的 session"| Tmux
    Tmux --> Codex
    Bridge <-->|"按 session 定位并校验路径"| Files
```

边界说明：

- Dashboard 连接 Bridge 主机上的现有 tmux server，不代表 pane 里通过 SSH 登录的其他机器。
- Composer 是给所选 Codex session 发送消息；它不提供任意 shell 命令入口。
- 文件根目录由服务端按 session 工作目录确定；客户端不能指定任意目录。
- 网页需要配对会话。若通过局域网访问，按实际 Bridge 配置和公司网络政策开放；不要把配对码或管理页面公开。

## 2. 飞书 Direct 任务入口（可选，建议单独演示）

```mermaid
flowchart LR
    User["同事在飞书发送任务 / 续问"]
    Lark["Lark SDK<br/>Direct WebSocket 运行时"]
    Store["Bridge SQLite<br/>事件去重、任务、续问、租约、outbox"]
    CodexSDK["Codex SDK<br/>执行任务 / 继续 thread"]
    Card["飞书消息或任务卡片"]

    User --> Lark
    Lark -->|"先持久化事件和任务"| Store
    Store -->|"取得执行任务"| CodexSDK
    CodexSDK -->|"执行结果与用量"| Store
    Store -->|"outbox 异步更新"| Card
    Card --> User
```

Direct 与 tmux Dashboard 是不同的入口和状态流程。AAMP + Relay 也是另一种运行模式，本图没有把它们合并进 Direct。
