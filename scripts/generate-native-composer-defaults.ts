import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_SHORTCUT_GROUPS, DEFAULT_SHORTCUTS } from "../src/tmux-shortcut-defaults.js";

// Keep the offline native fallback derived from the same defaults and terminal
// bytes as Web. Existing synced/user SQLite data is never changed by this file.
const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(`${root}/src/tmux-dashboard-api.ts`, "utf8");
const section = source.split("const TERMINAL_SHORTCUT_SEQUENCES:")[1]?.split("});")[0];
if (!section) throw new Error("Could not find Web terminal shortcut sequences");
const sequences = Object.fromEntries([...section.matchAll(/^  "([^"]+)": ("(?:\\.|[^"\\])*"),$/gm)]
  .map((match) => [match[1], JSON.parse(match[2]!)]));
for (const shortcut of DEFAULT_SHORTCUTS) {
  if (shortcut.kind === "terminal" && typeof sequences[shortcut.value] !== "string") {
    throw new Error(`Missing terminal sequence: ${shortcut.value}`);
  }
}
const payload = {
  groups: DEFAULT_SHORTCUT_GROUPS.map((group) => ({ ...group, enabled: true, builtIn: true })),
  shortcuts: DEFAULT_SHORTCUTS.map((shortcut, index) => ({
    ...shortcut,
    enabled: true,
    builtIn: true,
    dangerous: shortcut.dangerous ?? false,
    actionKey: shortcut.actionKey ?? null,
    displayMode: shortcut.displayMode ?? "closed",
    sortOrder: shortcut.sortOrder ?? index,
    operationCount: 0,
  })),
  terminalSequences: sequences,
};
const output = `${JSON.stringify(payload)}\n`;
const target = `${root}/android/app/src/main/assets/composer-defaults.json`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("Android Composer defaults are out of date");
} else {
  writeFileSync(target, output);
}
