export type ShortcutCategory = string;
export type ShortcutPanelId = ShortcutCategory;
export type ShortcutKind = "terminal" | "insert" | "send" | "sequence";
export type ShortcutSurface = "palette" | "composer";
export type ShortcutDisplayMode = "closed" | "expanded" | "both";

export const COMPOSER_ACTION_OPTIONS = [
  { key: "attachment", label: "选择附件" },
  { key: "scroll-top", label: "滚动到顶部" },
  { key: "scroll-bottom", label: "滚动到底部" },
  { key: "session-files", label: "浏览 Session 文件" },
  { key: "debug-log", label: "调试日志" },
  { key: "scroll-export", label: "导出滚动日志" },
  { key: "terminal-escape", label: "Esc" },
  { key: "terminal-up", label: "上一条输入" },
  { key: "terminal-down", label: "下一条输入" },
  { key: "terminal-enter", label: "回车" },
  { key: "keyboard-panel", label: "键盘面板" },
  { key: "close-panel", label: "关闭快捷栏" },
  { key: "ctrl-panel", label: "Ctrl 面板" },
] as const;

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
  if (normalized === "backspace") return "\u007f";
  if (normalized === "/") return "\u001f";
  if (normalized === "?") return "\u007f";
  if (normalized.length !== 1) return null;
  const code = normalized.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code - 64);
}

type SequenceModifiers = { shift?: boolean; alt?: boolean; ctrl?: boolean };

function modifierCode(modifiers: SequenceModifiers): number {
  return 1
    + (modifiers.shift ? 1 : 0)
    + (modifiers.alt ? 2 : 0)
    + (modifiers.ctrl ? 4 : 0);
}

function parseFunctionKey(lower: string, modifiers: SequenceModifiers = {}): string | null {
  const functionKey = /^f(1[0-9]|2[0-4]|[1-9])$/.exec(lower);
  if (!functionKey) return null;
  const number = Number(functionKey[1]);
  if (number > 12 && !modifiers.shift && !modifiers.alt && !modifiers.ctrl) return null;
  const plainSequences: Record<number, string> = {
    1: "\u001bOP", 2: "\u001bOQ", 3: "\u001bOR", 4: "\u001bOS",
    5: "\u001b[15~", 6: "\u001b[17~", 7: "\u001b[18~", 8: "\u001b[19~",
    9: "\u001b[20~", 10: "\u001b[21~", 11: "\u001b[23~", 12: "\u001b[24~",
  };
  if (!modifiers.shift && !modifiers.alt && !modifiers.ctrl) return plainSequences[number] || null;
  const functionCode = number <= 4 ? String.fromCharCode(79 + number) : null;
  if (functionCode) return `\u001b[1;${modifierCode(modifiers)}${functionCode}`;
  const suffix = number <= 12 ? 13 + number * 2 : number === 13 ? 25 : 27 + (number - 14) * 2;
  return `\u001b[${suffix};${modifierCode(modifiers)}~`;
}

function parseSpecialKey(lower: string, modifiers: SequenceModifiers = {}): string | null {
  if (lower === "esc" || lower === "escape") return modifiers.alt ? "\u001b\u001b" : "\u001b";
  if (lower === "tab") {
    if (modifiers.shift && !modifiers.alt && !modifiers.ctrl) return "\u001b[Z";
    if (modifiers.alt && !modifiers.shift && !modifiers.ctrl) return "\u001b\t";
    return "\t";
  }
  if (lower === "enter" || lower === "return") {
    if (modifiers.alt && !modifiers.shift && !modifiers.ctrl) return "\u001b\r";
    return "\r";
  }
  if (lower === "backspace") return modifiers.alt ? "\u001b\u007f" : "\u007f";
  if (lower === "space") return modifiers.alt ? "\u001b " : " ";

  const arrow = ({ up: "A", down: "B", right: "C", left: "D" } as Record<string, string>)[lower.replace(/^arrow/, "")];
  if (arrow) {
    if (!modifiers.shift && !modifiers.alt && !modifiers.ctrl) return `\u001b[${arrow}`;
    return `\u001b[1;${modifierCode(modifiers)}${arrow}`;
  }

  const tildeCode: Record<string, number> = {
    delete: 3,
    del: 3,
    insert: 2,
    ins: 2,
    pageup: 5,
    "page-up": 5,
    pagedown: 6,
    "page-down": 6,
  };
  if (Object.hasOwn(tildeCode, lower)) {
    const code = tildeCode[lower]!;
    return modifiers.shift || modifiers.alt || modifiers.ctrl
      ? `\u001b[${code};${modifierCode(modifiers)}~`
      : `\u001b[${code}~`;
  }
  if (lower === "home" || lower === "end") {
    const suffix = lower === "home" ? "H" : "F";
    return modifiers.shift || modifiers.alt || modifiers.ctrl
      ? `\u001b[1;${modifierCode(modifiers)}${suffix}`
      : `\u001b[${suffix}`;
  }
  return parseFunctionKey(lower, modifiers);
}

function parseSequenceToken(token: string, modifiers: SequenceModifiers = {}): string | null {
  const normalized = token.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const special = parseSpecialKey(lower, modifiers);
  if (special !== null) return special;
  if (normalized.startsWith("^")) return controlCode(normalized.slice(1));
  if (normalized.length === 1) {
    const value = normalized;
    if (modifiers.ctrl) {
      const control = controlCode(value);
      return control === null ? null : control;
    }
    if (modifiers.alt) return "\u001b" + (modifiers.shift ? value.toUpperCase() : value);
    return modifiers.shift ? value.toUpperCase() : value;
  }
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
    const modifiers: SequenceModifiers = {};
    let key = "";
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "shift") modifiers.shift = true;
      else if (lower === "alt" || lower === "meta") modifiers.alt = true;
      else if (lower === "ctrl" || lower === "control") modifiers.ctrl = true;
      else if (key) return null;
      else key = part;
    }
    if (!key) return null;
    const value = parseSequenceToken(key, modifiers);
    if (value === null) return null;
    output.push(value);
  }
  return output.length > 0 ? output.join("") : null;
}

export type ShortcutGroup = {
  id: string;
  title: string;
  icon: string;
  description: string;
  surface: ShortcutSurface;
  layout: "grid" | "keyboard";
  sortOrder: number;
  enabled: boolean;
  builtIn: boolean;
};

export type ShortcutDefinition = {
  id: string;
  groupId: string;
  title: string;
  detail: string;
  kind: ShortcutKind;
  value: string;
  enabled: boolean;
  builtIn: boolean;
  dangerous: boolean;
  actionKey: string | null;
  displayMode: ShortcutDisplayMode;
  sortOrder: number;
  operationCount: number;
};

export type ShortcutStore = {
  groups: ShortcutGroup[];
  shortcuts: ShortcutDefinition[];
};

export const DEFAULT_COMPOSER_SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "composer-attachment", groupId: "composer", title: "附件", detail: "选择文件", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "attachment", displayMode: "closed", sortOrder: 0, operationCount: 0 },
  { id: "composer-scroll-top", groupId: "composer", title: "顶部", detail: "滚动到顶部", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "scroll-top", displayMode: "both", sortOrder: 1, operationCount: 0 },
  { id: "composer-scroll-bottom", groupId: "composer", title: "底部", detail: "滚动到底部", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "scroll-bottom", displayMode: "both", sortOrder: 2, operationCount: 0 },
  { id: "composer-session-files", groupId: "composer", title: "文件", detail: "浏览 Session 文件", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "session-files", displayMode: "both", sortOrder: 3, operationCount: 0 },
  { id: "composer-debug-log", groupId: "composer", title: "日志", detail: "收集调试日志", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "debug-log", displayMode: "both", sortOrder: 4, operationCount: 0 },
  { id: "composer-scroll-export", groupId: "composer", title: "导出", detail: "导出滚动日志", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "scroll-export", displayMode: "both", sortOrder: 5, operationCount: 0 },
  { id: "composer-escape", groupId: "composer", title: "Esc", detail: "cancel", kind: "terminal", value: "codex-escape", enabled: true, builtIn: true, dangerous: false, actionKey: "terminal-escape", displayMode: "both", sortOrder: 6, operationCount: 0 },
  { id: "composer-up", groupId: "composer", title: "↑", detail: "上一条输入", kind: "terminal", value: "codex-up", enabled: true, builtIn: true, dangerous: false, actionKey: "terminal-up", displayMode: "both", sortOrder: 7, operationCount: 0 },
  { id: "composer-down", groupId: "composer", title: "↓", detail: "下一条输入", kind: "terminal", value: "codex-down", enabled: true, builtIn: true, dangerous: false, actionKey: "terminal-down", displayMode: "both", sortOrder: 8, operationCount: 0 },
  { id: "composer-enter", groupId: "composer", title: "↵", detail: "回车", kind: "terminal", value: "codex-enter", enabled: true, builtIn: true, dangerous: false, actionKey: "terminal-enter", displayMode: "both", sortOrder: 9, operationCount: 0 },
  { id: "composer-keyboard-panel", groupId: "composer", title: "键盘", detail: "打开键盘面板", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "keyboard-panel", displayMode: "closed", sortOrder: 10, operationCount: 0 },
  { id: "composer-close-panel", groupId: "composer", title: "关闭", detail: "关闭快捷栏", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "close-panel", displayMode: "expanded", sortOrder: 0, operationCount: 0 },
  { id: "composer-ctrl-panel", groupId: "composer", title: "Ctrl", detail: "打开 Ctrl 面板", kind: "insert", value: "", enabled: true, builtIn: true, dangerous: false, actionKey: "ctrl-panel", displayMode: "expanded", sortOrder: 11, operationCount: 0 },
];
