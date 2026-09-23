# Changelog

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
