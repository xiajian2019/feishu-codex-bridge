import type { ShortcutGroupLayout, ShortcutKind } from "./types.js";

export interface ShortcutGroupSeed {
  id: string;
  title: string;
  icon: string;
  description: string;
  layout: ShortcutGroupLayout;
  sortOrder: number;
}

export interface ShortcutSeed {
  id: string;
  groupId: string;
  title: string;
  detail: string;
  kind: ShortcutKind;
  value: string;
  dangerous?: boolean;
}

export const DEFAULT_SHORTCUT_GROUPS: readonly ShortcutGroupSeed[] = [
  { id: "favorites", title: "收藏", icon: "☆", description: "按操作次数显示最常用的 8 个快捷键", layout: "grid", sortOrder: 0 },
  { id: "tmux", title: "Tmux", icon: ">_", description: "tmux 会话操作", layout: "grid", sortOrder: 1 },
  { id: "codex", title: "Codex", icon: "✳", description: "Codex 命令", layout: "grid", sortOrder: 2 },
  { id: "ctrl", title: "Ctrl", icon: "⌃", description: "终端控制键", layout: "grid", sortOrder: 3 },
  { id: "keyboard", title: "键盘", icon: "⌨", description: "特殊键和组合键", layout: "keyboard", sortOrder: 4 },
];

export const DEFAULT_SHORTCUTS: readonly ShortcutSeed[] = [
  { id: "favorite-git-status", title: "git status", detail: "工作区状态", groupId: "favorites", kind: "send", value: "git status" },
  { id: "favorite-git-diff", title: "git diff", detail: "查看改动", groupId: "favorites", kind: "send", value: "git diff" },
  { id: "favorite-pwd", title: "pwd", detail: "当前目录", groupId: "favorites", kind: "send", value: "pwd" },
  { id: "favorite-ls", title: "ls", detail: "列出文件", groupId: "favorites", kind: "send", value: "ls" },
  { id: "favorite-clear", title: "clear", detail: "清屏", groupId: "favorites", kind: "send", value: "clear" },
  { id: "favorite-git-log", title: "git log", detail: "最近提交", groupId: "favorites", kind: "send", value: "git log --oneline -5" },
  { id: "favorite-npm-test", title: "npm test", detail: "运行测试", groupId: "favorites", kind: "send", value: "npm test" },
  { id: "favorite-git-branch", title: "git branch", detail: "当前分支", groupId: "favorites", kind: "send", value: "git branch --show-current" },
  { id: "tmux-new", title: "^b, c", detail: "new win", groupId: "tmux", kind: "terminal", value: "tmux-new-window" },
  { id: "tmux-next", title: "^b, n", detail: "next", groupId: "tmux", kind: "terminal", value: "tmux-next-window" },
  { id: "tmux-previous", title: "^b, p", detail: "prev win", groupId: "tmux", kind: "terminal", value: "tmux-previous-window" },
  { id: "tmux-detach", title: "^b, d", detail: "detach", groupId: "tmux", kind: "terminal", value: "tmux-detach" },
  { id: "tmux-window-list", title: "^b, w", detail: "windows", groupId: "tmux", kind: "terminal", value: "tmux-window-list" },
  { id: "tmux-zoom", title: "^b, z", detail: "zoom", groupId: "tmux", kind: "terminal", value: "tmux-zoom-pane" },
  { id: "tmux-window-1", title: "^b, 1", detail: "window 1", groupId: "tmux", kind: "terminal", value: "tmux-window-1" },
  { id: "tmux-window-2", title: "^b, 2", detail: "window 2", groupId: "tmux", kind: "terminal", value: "tmux-window-2" },
  { id: "codex-new", title: "/new", detail: "fresh", groupId: "codex", kind: "send", value: "/new" },
  { id: "codex-compact", title: "/compact", detail: "context", groupId: "codex", kind: "send", value: "/compact" },
  { id: "codex-model", title: "/model", detail: "switch", groupId: "codex", kind: "send", value: "/model" },
  { id: "codex-permissions", title: "/permissions", detail: "access", groupId: "codex", kind: "send", value: "/permissions" },
  { id: "codex-plan", title: "/plan", detail: "design", groupId: "codex", kind: "send", value: "/plan" },
  { id: "codex-resume", title: "/resume", detail: "continue", groupId: "codex", kind: "send", value: "/resume" },
  { id: "codex-diff", title: "/diff", detail: "changes", groupId: "codex", kind: "send", value: "/diff" },
  { id: "codex-status", title: "/status", detail: "usage", groupId: "codex", kind: "send", value: "/status" },
  { id: "key-escape", title: "Esc", detail: "cancel", groupId: "ctrl", kind: "terminal", value: "codex-escape" },
  { id: "key-enter", title: "↵", detail: "enter", groupId: "ctrl", kind: "terminal", value: "codex-enter" },
  { id: "key-tab", title: "Tab", detail: "complete", groupId: "ctrl", kind: "terminal", value: "codex-tab" },
  { id: "key-up", title: "↑", detail: "up", groupId: "ctrl", kind: "terminal", value: "codex-up" },
  { id: "key-down", title: "↓", detail: "down", groupId: "ctrl", kind: "terminal", value: "codex-down" },
  { id: "key-left", title: "←", detail: "left", groupId: "ctrl", kind: "terminal", value: "codex-left" },
  { id: "key-right", title: "→", detail: "right", groupId: "ctrl", kind: "terminal", value: "codex-right" },
  { id: "ctrl-c", title: "^C", detail: "stop", groupId: "ctrl", kind: "terminal", value: "codex-interrupt", dangerous: true },
  { id: "keyboard-prefix", title: "^B", detail: "tmux prefix", groupId: "keyboard", kind: "sequence", value: "^B" },
  { id: "keyboard-escape", title: "esc", detail: "escape", groupId: "keyboard", kind: "sequence", value: "Esc" },
  { id: "keyboard-enter", title: "↵", detail: "enter", groupId: "keyboard", kind: "sequence", value: "Enter" },
  { id: "keyboard-tab", title: "tab", detail: "tab", groupId: "keyboard", kind: "sequence", value: "Tab" },
  { id: "keyboard-shift-tab", title: "shift tab", detail: "previous", groupId: "keyboard", kind: "sequence", value: "Shift+Tab" },
  { id: "keyboard-up", title: "↑", detail: "up", groupId: "keyboard", kind: "sequence", value: "ArrowUp" },
  { id: "keyboard-down", title: "↓", detail: "down", groupId: "keyboard", kind: "sequence", value: "ArrowDown" },
  { id: "keyboard-left", title: "←", detail: "left", groupId: "keyboard", kind: "sequence", value: "ArrowLeft" },
  { id: "keyboard-right", title: "→", detail: "right", groupId: "keyboard", kind: "sequence", value: "ArrowRight" },
  { id: "keyboard-home", title: "home", detail: "line start", groupId: "keyboard", kind: "sequence", value: "Home" },
  { id: "keyboard-end", title: "end", detail: "line end", groupId: "keyboard", kind: "sequence", value: "End" },
  { id: "keyboard-delete", title: "del", detail: "delete", groupId: "keyboard", kind: "sequence", value: "Delete" },
  { id: "keyboard-insert", title: "ins", detail: "insert", groupId: "keyboard", kind: "sequence", value: "Insert" },
  { id: "keyboard-page-up", title: "pgUp", detail: "page up", groupId: "keyboard", kind: "sequence", value: "PageUp" },
  { id: "keyboard-page-down", title: "pgDn", detail: "page down", groupId: "keyboard", kind: "sequence", value: "PageDown" },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `keyboard-f${index + 1}`,
    title: `F${index + 1}`,
    detail: "function",
    groupId: "keyboard",
    kind: "sequence" as const,
    value: `F${index + 1}`,
  })),
  { id: "keyboard-question", title: "?", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "?" },
  { id: "keyboard-slash", title: "/", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "/" },
  { id: "keyboard-pipe", title: "|", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "|" },
  { id: "keyboard-tilde", title: "~", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "~" },
  { id: "keyboard-dash", title: "-", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "-" },
  { id: "keyboard-underscore", title: "_", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "_" },
  { id: "keyboard-equals", title: "=", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "=" },
  { id: "keyboard-colon", title: ":", detail: "symbol", groupId: "keyboard", kind: "sequence", value: ":" },
  { id: "keyboard-semicolon", title: ";", detail: "symbol", groupId: "keyboard", kind: "sequence", value: ";" },
  { id: "keyboard-open-brace", title: "{", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "{" },
  { id: "keyboard-close-brace", title: "}", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "}" },
  { id: "keyboard-open-bracket", title: "[", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "[" },
  { id: "keyboard-close-bracket", title: "]", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "]" },
  { id: "keyboard-at", title: "@", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "@" },
  { id: "keyboard-percent", title: "%", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "%" },
  { id: "keyboard-caret", title: "^", detail: "symbol", groupId: "keyboard", kind: "sequence", value: "^" },
];
