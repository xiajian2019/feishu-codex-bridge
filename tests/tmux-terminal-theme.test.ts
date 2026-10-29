import { describe, expect, it } from "bun:test";
import { getTmuxTerminalRenderTheme, getTmuxTerminalTheme } from "../web/src/tmux-terminal-theme.js";

describe("tmux xterm themes", () => {
  it("provides distinct light and dark renderer palettes", () => {
    const light = getTmuxTerminalTheme("light");
    const dark = getTmuxTerminalTheme("dark");

    expect(light).toMatchObject({
      background: "#f6f8f5",
      foreground: "#17211b",
      cursor: "#245b41",
      green: "#8fbd9a",
    });
    expect(dark).toMatchObject({
      background: "#10141a",
      foreground: "#d8dee9",
      cursor: "#8de0bd",
    });
    expect(light.background).not.toBe(dark.background);
  });

  it("preserves the dark renderer palette without a display transform", () => {
    expect(getTmuxTerminalRenderTheme("dark")).toEqual(getTmuxTerminalTheme("dark"));
  });

  it("preserves light surface, text, cursor and selection colors after the CSS display filter", () => {
    const displayed = getTmuxTerminalTheme("light");
    const renderer = getTmuxTerminalRenderTheme("light");
    const rgb = (hex: string): number[] => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    // CSS invert(1), followed by the standard hue-rotate(180deg) matrix.
    const displayFilter = (hex: string): number[] => {
      const [r, g, b] = rgb(hex).map((channel) => 255 - channel) as [number, number, number];
      return [
        -0.574 * r + 1.43 * g + 0.144 * b,
        0.426 * r + 0.43 * g + 0.144 * b,
        0.426 * r + 1.43 * g - 0.856 * b,
      ].map((channel) => Math.max(0, Math.min(255, Math.round(channel))));
    };
    for (const key of ["background", "foreground", "cursor", "selectionBackground", "selectionForeground", "selectionInactiveBackground"] as const) {
      const expected = rgb(displayed[key]!);
      const actual = displayFilter(renderer[key]!);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(actual[channel]! - expected[channel]!)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns a fresh theme object for xterm option updates", () => {
    const first = getTmuxTerminalTheme("light");
    const second = getTmuxTerminalTheme("light");
    expect(first).not.toBe(second);
  });
});
