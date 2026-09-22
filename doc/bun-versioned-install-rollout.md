# Bun 固定目录安装与服务切换方案

## 目标

把从下载目录启动的安装包部署到用户固定目录，后续版本以不可变版本目录并行保留，通过稳定入口切换。更新期间先停止占用 HTTP/WebSocket 端口的旧服务，再切换并启动新版本；新版本未就绪时恢复旧入口和服务。该设计避免覆盖正在运行的二进制、socket 与其旁加载资源。

默认安装根目录为 `~/Applications/Feishu Codex Bridge`，可由 `FEISHU_CODEX_BRIDGE_INSTALL_ROOT` 覆盖。该路径属于当前用户，不要求管理员权限。

## 目录约定

```text
<install-root>/
├── current -> releases/<version>-<content-hash>
├── releases/
│   ├── <previous-version>-<content-hash>/
│   └── <active-version>-<content-hash>/
├── config.json
└── runtime/
    ├── bridge.db
    ├── bridge.db-wal
    ├── bridge.db-shm
    ├── logs/
    └── direct/attachments/
```

`releases/` 中的版本目录发布后不再原地改写。配置、数据库及其 WAL/SHM、日志、附件和凭据必须留在版本目录之外。旧版本不自动清理，回滚确认完成前保留可运行的上一个版本。

LaunchAgent 的可执行文件和工作目录必须经由 `<install-root>/current`，其 `config.json`、SQLite 数据库和日志必须指向固定根目录。这样服务配置不依赖下载目录或某个具体版本目录。

## 安装与更新事务

1. 校验完整发布包、版本清单、目标架构和可执行文件；在 `releases/` 下创建唯一 staging 目录并复制/解包。
2. 在 staging 目录完成包结构检查，再将其提升为新的不可变版本目录。
3. 读取并保留原 LaunchAgent plist、`current` 目标及用户数据。迁移旧安装时，仅在旧服务停止后复制缺失的配置、数据库/WAL/SHM 和附件；固定根目录已有数据优先，不覆盖。
4. 对已加载服务执行应用级 graceful stop，等待 LaunchAgent 卸载且旧 PID 退出；不得通过强杀进程绕过端口或 SQLite 清理。
5. 用同目录临时符号链接和原子 rename 更新 `current`。LaunchAgent 再从稳定入口启动新版本，并等待 LaunchAgent running 和运行时健康信号。
6. 如果链接切换、服务启动或健康检查任一步失败，停止新进程、恢复旧 `current`、恢复原 LaunchAgent plist 并启动旧版本。未激活的 staging 目录可以清理；已发布版本目录保留。
7. Core 更新仅允许覆盖与当前 manifest 标识兼容的运行时代际；运行时代际改变必须使用完整 Direct/Lite 包。

单实例服务需要独占现有 HTTP/WebSocket 监听端口；没有 socket activation 或代理接管时不能承诺零停机。更新会出现短暂重启窗口，但不会在旧进程仍持有端口时并行启动新进程。

## 优雅停机合同

- 收到 `SIGTERM`/`SIGINT` 后停止接收新任务与新 outbox 工作，停止定时器和健康检查。
- 允许当前任务最多排空 30 秒；超时后取消执行并将活动工作重新排队，确保不把未完成任务标记为成功。
- 等待活动卡片/通知发送收尾，关闭 Feishu WebSocket，释放运行时租约后再关闭 SQLite。
- HTTP 服务停止接受新连接、结束 SSE 客户端、关闭空闲连接并等待活动请求完成。
- LaunchAgent 配置的退出宽限期为 60 秒，高于应用的 30 秒排空上限；安装器和更新器等待旧 PID 退出后再替换服务入口。

## 验收

- 干净安装后 LaunchAgent 的程序、工作目录与环境变量均经由固定根目录的 `current`，配置/数据库/日志位于固定数据目录。
- 从旧 Node 安装迁移后，配置、数据库、WAL/SHM、附件保持不变；新 Direct 单文件包在不依赖系统 Node/Bun 的环境中可启动。
- 更新期间旧 PID 退出后才启动新 PID；新服务健康检查成功后事务完成，端口监听由新版本持有。
- 模拟新版本启动失败，确认 `current` 和 LaunchAgent 恢复到旧版本，旧服务重新就绪，两个版本目录均保留。
- 活动任务在正常退出时完成排空；超过 30 秒的任务可恢复重试，WebSocket、HTTP/SSE 和 SQLite 均按顺序关闭。
- Core/Lite/Direct 更新、启动失败回滚、重复安装、版本目录已存在以及有活动任务时的自动更新都有自动化覆盖。
- 验证运行版本时检查 LaunchAgent plist、PID/命令行、实际监听端口及健康状态；包构建通过不能代替对活动服务的验证。

## 当前实现与验证

- `install.command` 使用固定根目录和不可变 `releases/<version>-<hash>`，修正迁移临时文件 PID 名称，通过 `mv -fh` 替换 `current`，失败时恢复旧入口；默认安装会要求启动新 LaunchAgent 并等待运行时就绪。
- 更新器按 staging → 新版本目录 → `current` 原子切换运行，并保留旧版本；Core 包应用前验证运行时代际兼容性。
- Direct 运行时在 SIGTERM/SIGINT 时最多排空任务 30 秒，之后中止并重新排队；LaunchAgent 的退出期限为 60 秒，停止命令等待旧 PID 退出。Web 控制台关闭 SSE/空闲连接，Tmux WebSocket 服务向活动客户端发送关闭帧。
- `sh -n install.command`、25 个安装/LaunchAgent/更新器聚焦测试、全量 `bun test`（207 项、838 assertions、39 个文件）和 `git diff --check` 均通过。
- `bun run typecheck` 当前因 `src/aamp-cli.ts` 第 1、2 行的未使用导入报错；未改动该无关代码。
- 本轮只读核对发现当前 LaunchAgent 仍指向仓库 `release/` 下的 Direct 二进制；Mach-O 中可见 `Bun v1.4.2` 与 `bun:sqlite`。新固定目录安装尚未激活，本轮未重启服务；启动失败回滚也未对真实安装进行端到端演练。
