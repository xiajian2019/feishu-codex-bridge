# Changelog

## 0.4.0 - 2026-09-26

### Added

- Codex 历史会话页面，支持按 Codex home/账号查询只读历史、筛选并查看会话详情。
- 已配对设备改名和重新生成配对二维码。
- tmux Dashboard 支持任意文件类型附件、滚动诊断下载、长按复制及全站可折叠导航。

### Changed

- tmux 终端改用 Canvas renderer，并修复触摸手势末尾位移丢失，保留限速惯性滚动。
- 开发 Web 页面和 API 统一使用 Bridge 的 web-only 服务及开发数据库。

### Security

- Codex 历史通过 app-server 只读协议读取，不解析认证文件、SQLite 或 JSONL 状态文件。

## 0.3.0 - 2026-09-23

### Added

- 使用 Bun 1.4.2 构建 macOS Bun 单一二进制 Portable 包。
- Web 设备配对、二维码配对和 SQLite 会话管理。
- tmux Dashboard 与 Bridge 统一 Web 入口。

### Changed

- 默认 release 只生成带版本号的 Bun 单一二进制包。
- 旧版 core/lite/direct 多模式打包迁移到 release:legacy。
- 设备管理、tmux 页面和 Web API 统一接入 Web Auth。

### Security

- 未配对设备不能访问任务数据、tmux API、SSE 或终端 WebSocket。
- 配对会话默认有效 30 天，支持单设备和全部设备撤销。
