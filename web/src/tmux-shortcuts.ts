export type ShortcutCategory = "favorites" | "tmux" | "codex" | "ctrl" | "keyboard";
export type ShortcutPanelId = ShortcutCategory;
export type ShortcutKind = "terminal" | "insert" | "send" | "sequence";

export type TerminalShortcut =
  | "codex-escape"
  | "codex-interrupt"
  | "codex-enter"
  | "codex-tab"
  | "codex-home"
  | "codex-shift-tab"
  | "codex-up"
  | "codex-down"
  | "codex-left"
  | "codex-right"
  | "ctrl-d"
  | "ctrl-z"
  | "ctrl-l"
  | "ctrl-a"
  | "ctrl-e"
  | "ctrl-r"
  | "ctrl-w"
  | "tmux-new-window"
  | "tmux-next-window"
  | "tmux-previous-window"
  | "tmux-window-list"
  | "tmux-zoom-pane"
  | "tmux-detach"
  | `tmux-window-${1 | 2 | 3 | 4 | 5 | 6 | 7}`;

function controlCode(key: string): string | null {
  const normalized = key.trim().toLowerCase();
  if (normalized === "space") return " ";
  if (normalized.length !== 1) return null;
  const code = normalized.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code - 64);
}

function parseSequenceToken(token: string): string | null {
  const normalized = token.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower === "esc" || lower === "escape") return "\u001b";
  if (lower === "tab") return "\t";
  if (lower === "enter" || lower === "return") return "\r";
  if (lower === "backspace") return "\u0008";
  if (lower === "space") return " ";
  if (lower === "up" || lower === "arrowup") return "\u001b[A";
  if (lower === "down" || lower === "arrowdown") return "\u001b[B";
  if (lower === "right" || lower === "arrowright") return "\u001b[C";
  if (lower === "left" || lower === "arrowleft") return "\u001b[D";
  if (lower === "home") return "\u001b[H";
  if (lower === "end") return "\u001b[F";
  if (lower === "delete" || lower === "del") return "\u001b[3~";
  if (lower === "insert" || lower === "ins") return "\u001b[2~";
  if (lower === "pageup" || lower === "page-up") return "\u001b[5~";
  if (lower === "pagedown" || lower === "page-down") return "\u001b[6~";
  const functionKey = /^f(1[0-2]|[1-9])$/.exec(lower);
  if (functionKey) {
    const functionKeySequences: Record<string, string> = {
      f1: "\u001bOP", f2: "\u001bOQ", f3: "\u001bOR", f4: "\u001bOS",
      f5: "\u001b[15~", f6: "\u001b[17~", f7: "\u001b[18~", f8: "\u001b[19~",
      f9: "\u001b[20~", f10: "\u001b[21~", f11: "\u001b[23~", f12: "\u001b[24~",
    };
    return functionKeySequences[functionKey[0]] || null;
  }
  if (normalized.startsWith("^")) return controlCode(normalized.slice(1));
  if (normalized.length === 1) return normalized;
  return null;
}

export function parseTerminalSequence(input: string): string | null {
  const source = input.trim();
  if (!source || source.length > 80) return null;
  const groups = source.split(/[\s,]+/).filter(Boolean);
  const output: string[] = [];
  for (const group of groups) {
    const parts = group.split("+").filter(Boolean);
  if (parts.length === 0) return null;
  if ((parts[0].toLowerCase() === "shift") && parts[1]?.toLowerCase() === "tab") {
    output.push("\u001b[Z");
    continue;
  }
    if (parts[0].toLowerCase() === "alt" && parts[1]) {
      const value = parseSequenceToken(parts[1]);
      if (value === null) return null;
      output.push("\u001b", value);
      continue;
    }
    if (parts[0].toLowerCase() === "ctrl" || parts[0].toLowerCase() === "control") {
      const control = controlCode(parts[1] || "");
      if (!control) return null;
      output.push(control);
      for (const part of parts.slice(2)) {
        const value = parseSequenceToken(part);
        if (value === null) return null;
        output.push(value);
      }
      continue;
    }
    for (const part of parts) {
      const value = parseSequenceToken(part);
      if (value === null) return null;
      output.push(value);
    }
  }
  return output.length > 0 ? output.join("") : null;
}

export type ShortcutDefinition = {
  id: string;
  title: string;
  detail: string;
  category: ShortcutCategory;
  kind: ShortcutKind;
  value: string;
  enabled: boolean;
  builtIn?: boolean;
  dangerous?: boolean;
};

export type ShortcutStore = {
  shortcuts: ShortcutDefinition[];
  panelOrder: ShortcutPanelId[];
  disabledPanels: ShortcutPanelId[];
};

export const SHORTCUT_PANEL_ORDER: ShortcutPanelId[] = ["favorites", "tmux", "codex", "ctrl", "keyboard"];

export const SHORTCUT_PANEL_META: Record<ShortcutPanelId, { icon: string; label: string; description: string }> = {
  favorites: { icon: "☆", label: "收藏", description: "常用快捷键" },
  tmux: { icon: ">_", label: "Tmux", description: "tmux 会话操作" },
  codex: { icon: "✳", label: "Codex", description: "Codex 命令" },
  ctrl: { icon: "⌃", label: "Ctrl", description: "终端控制键" },
  keyboard: { icon: "⌨", label: "键盘", description: "特殊键和组合键" },
};

const BUILTIN_SHORTCUTS: ShortcutDefinition[] = [
  { id: "favorite-git-status", title: "git status", detail: "工作区状态", category: "favorites", kind: "send", value: "git status", enabled: true, builtIn: true },
  { id: "favorite-git-diff", title: "git diff", detail: "查看改动", category: "favorites", kind: "send", value: "git diff", enabled: true, builtIn: true },
  { id: "favorite-pwd", title: "pwd", detail: "当前目录", category: "favorites", kind: "send", value: "pwd", enabled: true, builtIn: true },
  { id: "favorite-ls", title: "ls", detail: "列出文件", category: "favorites", kind: "send", value: "ls", enabled: true, builtIn: true },
  { id: "favorite-clear", title: "clear", detail: "清屏", category: "favorites", kind: "send", value: "clear", enabled: true, builtIn: true },
  { id: "favorite-git-log", title: "git log", detail: "最近提交", category: "favorites", kind: "send", value: "git log --oneline -5", enabled: true, builtIn: true },
  { id: "favorite-npm-test", title: "npm test", detail: "运行测试", category: "favorites", kind: "send", value: "npm test", enabled: true, builtIn: true },
  { id: "favorite-git-branch", title: "git branch", detail: "当前分支", category: "favorites", kind: "send", value: "git branch --show-current", enabled: true, builtIn: true },
  { id: "tmux-new", title: "^b, c", detail: "new win", category: "tmux", kind: "terminal", value: "tmux-new-window", enabled: true, builtIn: true },
  { id: "tmux-next", title: "^b, n", detail: "next", category: "tmux", kind: "terminal", value: "tmux-next-window", enabled: true, builtIn: true },
  { id: "tmux-previous", title: "^b, p", detail: "prev win", category: "tmux", kind: "terminal", value: "tmux-previous-window", enabled: true, builtIn: true },
  { id: "tmux-detach", title: "^b, d", detail: "detach", category: "tmux", kind: "terminal", value: "tmux-detach", enabled: true, builtIn: true },
  { id: "tmux-window-list", title: "^b, w", detail: "windows", category: "tmux", kind: "terminal", value: "tmux-window-list", enabled: true, builtIn: true },
  { id: "tmux-zoom", title: "^b, z", detail: "zoom", category: "tmux", kind: "terminal", value: "tmux-zoom-pane", enabled: true, builtIn: true },
  { id: "tmux-window-1", title: "^b, 1", detail: "window 1", category: "tmux", kind: "terminal", value: "tmux-window-1", enabled: true, builtIn: true },
  { id: "tmux-window-2", title: "^b, 2", detail: "window 2", category: "tmux", kind: "terminal", value: "tmux-window-2", enabled: true, builtIn: true },
  { id: "codex-new", title: "/new", detail: "fresh", category: "codex", kind: "send", value: "/new", enabled: true, builtIn: true },
  { id: "codex-compact", title: "/compact", detail: "context", category: "codex", kind: "send", value: "/compact", enabled: true, builtIn: true },
  { id: "codex-model", title: "/model", detail: "switch", category: "codex", kind: "send", value: "/model", enabled: true, builtIn: true },
  { id: "codex-permissions", title: "/permissions", detail: "access", category: "codex", kind: "send", value: "/permissions", enabled: true, builtIn: true },
  { id: "codex-plan", title: "/plan", detail: "design", category: "codex", kind: "send", value: "/plan", enabled: true, builtIn: true },
  { id: "codex-resume", title: "/resume", detail: "continue", category: "codex", kind: "send", value: "/resume", enabled: true, builtIn: true },
  { id: "codex-diff", title: "/diff", detail: "changes", category: "codex", kind: "send", value: "/diff", enabled: true, builtIn: true },
  { id: "codex-status", title: "/status", detail: "usage", category: "codex", kind: "send", value: "/status", enabled: true, builtIn: true },
  { id: "key-escape", title: "Esc", detail: "cancel", category: "ctrl", kind: "terminal", value: "codex-escape", enabled: true, builtIn: true },
  { id: "key-enter", title: "↵", detail: "enter", category: "ctrl", kind: "terminal", value: "codex-enter", enabled: true, builtIn: true },
  { id: "key-tab", title: "Tab", detail: "complete", category: "ctrl", kind: "terminal", value: "codex-tab", enabled: true, builtIn: true },
  { id: "key-up", title: "↑", detail: "up", category: "ctrl", kind: "terminal", value: "codex-up", enabled: true, builtIn: true },
  { id: "key-down", title: "↓", detail: "down", category: "ctrl", kind: "terminal", value: "codex-down", enabled: true, builtIn: true },
  { id: "key-left", title: "←", detail: "left", category: "ctrl", kind: "terminal", value: "codex-left", enabled: true, builtIn: true },
  { id: "key-right", title: "→", detail: "right", category: "ctrl", kind: "terminal", value: "codex-right", enabled: true, builtIn: true },
  { id: "ctrl-c", title: "^C", detail: "stop", category: "ctrl", kind: "terminal", value: "codex-interrupt", enabled: true, builtIn: true, dangerous: true },
  { id: "keyboard-prefix", title: "^B", detail: "tmux prefix", category: "keyboard", kind: "sequence", value: "^B", enabled: true, builtIn: true },
  { id: "keyboard-escape", title: "esc", detail: "escape", category: "keyboard", kind: "sequence", value: "Esc", enabled: true, builtIn: true },
  { id: "keyboard-enter", title: "↵", detail: "enter", category: "keyboard", kind: "sequence", value: "Enter", enabled: true, builtIn: true },
  { id: "keyboard-tab", title: "tab", detail: "tab", category: "keyboard", kind: "sequence", value: "Tab", enabled: true, builtIn: true },
  { id: "keyboard-shift-tab", title: "shift tab", detail: "previous", category: "keyboard", kind: "sequence", value: "Shift+Tab", enabled: true, builtIn: true },
  { id: "keyboard-up", title: "↑", detail: "up", category: "keyboard", kind: "sequence", value: "ArrowUp", enabled: true, builtIn: true },
  { id: "keyboard-down", title: "↓", detail: "down", category: "keyboard", kind: "sequence", value: "ArrowDown", enabled: true, builtIn: true },
  { id: "keyboard-left", title: "←", detail: "left", category: "keyboard", kind: "sequence", value: "ArrowLeft", enabled: true, builtIn: true },
  { id: "keyboard-right", title: "→", detail: "right", category: "keyboard", kind: "sequence", value: "ArrowRight", enabled: true, builtIn: true },
  { id: "keyboard-home", title: "home", detail: "line start", category: "keyboard", kind: "sequence", value: "Home", enabled: true, builtIn: true },
  { id: "keyboard-end", title: "end", detail: "line end", category: "keyboard", kind: "sequence", value: "End", enabled: true, builtIn: true },
  { id: "keyboard-delete", title: "del", detail: "delete", category: "keyboard", kind: "sequence", value: "Delete", enabled: true, builtIn: true },
  { id: "keyboard-insert", title: "ins", detail: "insert", category: "keyboard", kind: "sequence", value: "Insert", enabled: true, builtIn: true },
  { id: "keyboard-page-up", title: "pgUp", detail: "page up", category: "keyboard", kind: "sequence", value: "PageUp", enabled: true, builtIn: true },
  { id: "keyboard-page-down", title: "pgDn", detail: "page down", category: "keyboard", kind: "sequence", value: "PageDown", enabled: true, builtIn: true },
  { id: "keyboard-f1", title: "F1", detail: "function", category: "keyboard", kind: "sequence", value: "F1", enabled: true, builtIn: true },
  { id: "keyboard-f2", title: "F2", detail: "function", category: "keyboard", kind: "sequence", value: "F2", enabled: true, builtIn: true },
  { id: "keyboard-f3", title: "F3", detail: "function", category: "keyboard", kind: "sequence", value: "F3", enabled: true, builtIn: true },
  { id: "keyboard-f4", title: "F4", detail: "function", category: "keyboard", kind: "sequence", value: "F4", enabled: true, builtIn: true },
  { id: "keyboard-f5", title: "F5", detail: "function", category: "keyboard", kind: "sequence", value: "F5", enabled: true, builtIn: true },
  { id: "keyboard-f6", title: "F6", detail: "function", category: "keyboard", kind: "sequence", value: "F6", enabled: true, builtIn: true },
  { id: "keyboard-f7", title: "F7", detail: "function", category: "keyboard", kind: "sequence", value: "F7", enabled: true, builtIn: true },
  { id: "keyboard-f8", title: "F8", detail: "function", category: "keyboard", kind: "sequence", value: "F8", enabled: true, builtIn: true },
  { id: "keyboard-f9", title: "F9", detail: "function", category: "keyboard", kind: "sequence", value: "F9", enabled: true, builtIn: true },
  { id: "keyboard-f10", title: "F10", detail: "function", category: "keyboard", kind: "sequence", value: "F10", enabled: true, builtIn: true },
  { id: "keyboard-f11", title: "F11", detail: "function", category: "keyboard", kind: "sequence", value: "F11", enabled: true, builtIn: true },
  { id: "keyboard-f12", title: "F12", detail: "function", category: "keyboard", kind: "sequence", value: "F12", enabled: true, builtIn: true },
  { id: "keyboard-question", title: "?", detail: "symbol", category: "keyboard", kind: "sequence", value: "?", enabled: true, builtIn: true },
  { id: "keyboard-slash", title: "/", detail: "symbol", category: "keyboard", kind: "sequence", value: "/", enabled: true, builtIn: true },
  { id: "keyboard-pipe", title: "|", detail: "symbol", category: "keyboard", kind: "sequence", value: "|", enabled: true, builtIn: true },
  { id: "keyboard-tilde", title: "~", detail: "symbol", category: "keyboard", kind: "sequence", value: "~", enabled: true, builtIn: true },
  { id: "keyboard-dash", title: "-", detail: "symbol", category: "keyboard", kind: "sequence", value: "-", enabled: true, builtIn: true },
  { id: "keyboard-underscore", title: "_", detail: "symbol", category: "keyboard", kind: "sequence", value: "_", enabled: true, builtIn: true },
  { id: "keyboard-equals", title: "=", detail: "symbol", category: "keyboard", kind: "sequence", value: "=", enabled: true, builtIn: true },
  { id: "keyboard-colon", title: ":", detail: "symbol", category: "keyboard", kind: "sequence", value: ":", enabled: true, builtIn: true },
  { id: "keyboard-semicolon", title: ";", detail: "symbol", category: "keyboard", kind: "sequence", value: ";", enabled: true, builtIn: true },
  { id: "keyboard-open-brace", title: "{", detail: "symbol", category: "keyboard", kind: "sequence", value: "{", enabled: true, builtIn: true },
  { id: "keyboard-close-brace", title: "}", detail: "symbol", category: "keyboard", kind: "sequence", value: "}", enabled: true, builtIn: true },
  { id: "keyboard-open-bracket", title: "[", detail: "symbol", category: "keyboard", kind: "sequence", value: "[", enabled: true, builtIn: true },
  { id: "keyboard-close-bracket", title: "]", detail: "symbol", category: "keyboard", kind: "sequence", value: "]", enabled: true, builtIn: true },
  { id: "keyboard-at", title: "@", detail: "symbol", category: "keyboard", kind: "sequence", value: "@", enabled: true, builtIn: true },
  { id: "keyboard-percent", title: "%", detail: "symbol", category: "keyboard", kind: "sequence", value: "%", enabled: true, builtIn: true },
  { id: "keyboard-caret", title: "^", detail: "symbol", category: "keyboard", kind: "sequence", value: "^", enabled: true, builtIn: true },
];

const STORAGE_KEY = "feishu-codex-bridge.tmux-shortcuts.v1";

function defaultStore(): ShortcutStore {
  return {
    shortcuts: BUILTIN_SHORTCUTS.map((shortcut) => ({ ...shortcut })),
    panelOrder: [...SHORTCUT_PANEL_ORDER],
    disabledPanels: [],
  };
}

function isPanelId(value: unknown): value is ShortcutPanelId {
  return typeof value === "string" && SHORTCUT_PANEL_ORDER.includes(value as ShortcutPanelId);
}

function isShortcut(value: unknown): value is ShortcutDefinition {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ShortcutDefinition>;
  return typeof item.id === "string"
    && typeof item.title === "string"
    && typeof item.detail === "string"
    && isPanelId(item.category)
    && (item.kind === "terminal" || item.kind === "insert" || item.kind === "send" || item.kind === "sequence")
    && typeof item.value === "string"
    && typeof item.enabled === "boolean";
}

export function loadShortcutStore(): ShortcutStore {
  const fallback = defaultStore();
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "") as Partial<ShortcutStore>;
    if (!Array.isArray(parsed.shortcuts)) return fallback;
    const custom = parsed.shortcuts.filter(isShortcut).map((shortcut) => ({ ...shortcut, builtIn: Boolean(shortcut.builtIn) }));
    const shortcuts = [
      ...fallback.shortcuts.map((shortcut) => custom.find((item) => item.id === shortcut.id) || shortcut),
      ...custom.filter((shortcut) => !shortcut.builtIn && !fallback.shortcuts.some((item) => item.id === shortcut.id)),
    ];
    const panelOrder = Array.isArray(parsed.panelOrder)
      ? parsed.panelOrder.filter(isPanelId).filter((id, index, list) => list.indexOf(id) === index)
      : [];
    for (const id of SHORTCUT_PANEL_ORDER) if (!panelOrder.includes(id)) panelOrder.push(id);
    const disabledPanels = Array.isArray(parsed.disabledPanels) ? parsed.disabledPanels.filter(isPanelId) : [];
    return { shortcuts, panelOrder, disabledPanels: [...new Set(disabledPanels)] };
  } catch {
    return fallback;
  }
}

export function saveShortcutStore(store: ShortcutStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage can be blocked in private or embedded browsers.
  }
}

export function makeShortcutId(): string {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
