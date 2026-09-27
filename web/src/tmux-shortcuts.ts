export type ShortcutCategory = string;
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

export type ShortcutGroup = {
  id: string;
  title: string;
  icon: string;
  description: string;
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
  sortOrder: number;
  operationCount: number;
};

export type ShortcutStore = {
  groups: ShortcutGroup[];
  shortcuts: ShortcutDefinition[];
};
