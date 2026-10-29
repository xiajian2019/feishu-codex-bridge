# tmux Session 快照与重启恢复

Bridge 的 tmux 运行在 Mac 上。底层仍使用官方的 `tmux-resurrect` + `tmux-continuum`，但 Bridge 会把全局保存文件切分为每个 Session 的独立快照；保存和恢复都针对具体 Session，不会恢复整个 tmux server。

## 安装与启用

在 Bridge checkout 中执行：

```sh
bun run tmux:setup
```

脚本会：

- 安装 TPM、`tmux-resurrect` 和 `tmux-continuum` 到 `~/.tmux/plugins`；
- 在现有 tmux 配置旁写入独立的 `feishu-codex-bridge-resurrect.conf`，只追加一个 `source-file` 入口，不覆盖现有快捷键；
- 开启 15 分钟全局保存，以及 macOS 登录后的 tmux 自动启动；全局自动恢复关闭，由 Bridge 按活动 Session 恢复；
- 默认把 `codex` 加入可恢复进程白名单。

如果只想检查当前状态：

```sh
bun run tmux:setup:check
```

安装后，重新打开 tmux 或执行 `prefix + R`（当前 tmux-kit 配置的重载快捷键）。Dashboard 每个 Session 行都有“保存快照 / 更新快照 / 恢复”操作；恢复只针对已挂起的 Session。为避免误触全局恢复，受管配置会解绑 `prefix + Ctrl-s` 和 `prefix + Ctrl-r`。

“挂起”和“终结”是两种不同状态：挂起会先保存该 Session 的独立快照，再停止其中的 tmux/进程；它会留在列表中并可点击“恢复”。终结会永久结束该 Session 的可恢复状态，只保留历史记录。

## 进程恢复边界

窗口、Pane、布局和工作目录可以由快照恢复；进程恢复由 `@resurrect-processes` 白名单决定。当前只默认恢复 `codex`，其他开发服务器请确认启动命令和幂等性后再加入，不要直接启用 `:all:`，因为快照可能重新执行带有副作用的命令。

macOS 自动启动依赖 tmux-continuum 的 Terminal 自动化能力，首次使用可能需要在“系统设置 → 隐私与安全性 → 辅助功能”允许对应脚本控制 Terminal。Bridge/Dashboard 首次读取 Session 列表时，会只恢复数据库中仍处于活动状态且没有正在运行实例的 Session；显式终结的 Session 会删除并禁用其快照。

全局快照文件由 tmux-resurrect 按其默认规则保存；Bridge 的独立 Session 快照位于其中的 `bridge-sessions/`。它们属于本机 tmux 状态，不写入 Bridge SQLite，也不会进入仓库提交或 Bridge 备份包。
