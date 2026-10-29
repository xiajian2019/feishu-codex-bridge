import type { ITheme } from "@xterm/xterm";

import type { ResolvedTheme } from "./theme.js";

const TMUX_TERMINAL_THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#10141a",
    foreground: "#d8dee9",
    cursor: "#8de0bd",
    selectionBackground: "#41536b",
    selectionInactiveBackground: "#344354",
  },
  light: {
    background: "#f6f8f5",
    foreground: "#17211b",
    cursor: "#245b41",
    selectionBackground: "#b9d8c1",
    selectionForeground: "#17211b",
    selectionInactiveBackground: "#dcebe0",
    black: "#17211b",
    red: "#b42318",
    // Keep normal green soft enough for ANSI background SGR 42 while the
    // bright palette remains dark enough for readable green foreground text.
    green: "#8fbd9a",
    yellow: "#8a5a00",
    blue: "#1d4ed8",
    magenta: "#9333ea",
    cyan: "#0f766e",
    white: "#f6f8f5",
    brightBlack: "#68726c",
    brightRed: "#b42318",
    brightGreen: "#15803d",
    brightYellow: "#854d0e",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7e22ce",
    brightCyan: "#0e7490",
    brightWhite: "#ffffff",
  },
};

export function getTmuxTerminalTheme(theme: ResolvedTheme): ITheme {
  return { ...TMUX_TERMINAL_THEMES[theme] };
}

/** Compensate the palette for the light renderer's invert + hue rotation.
 * The same display filter adapts RGB/256-color backgrounds and syntax colors
 * written by terminal applications, which cannot be changed by ITheme alone.
 */
export function getTmuxTerminalRenderTheme(mode: ResolvedTheme): ITheme {
  const theme = getTmuxTerminalTheme(mode);
  if (mode === "dark") return theme;
  return Object.fromEntries(Object.entries(theme).map(([key, value]) => {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return [key, value];
    const rgb = Number.parseInt(value.slice(1), 16);
    const channels = [rgb >>> 16, (rgb >>> 8) & 255, rgb & 255];
    const twiceLuma = 2 * (0.213 * channels[0]! + 0.715 * channels[1]! + 0.072 * channels[2]!);
    return [key, "#" + channels.map((channel) => Math.max(0, Math.min(255, Math.round(255 + channel - twiceLuma)))
      .toString(16).padStart(2, "0")).join("")];
  }));
}
