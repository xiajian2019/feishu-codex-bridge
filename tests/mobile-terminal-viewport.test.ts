import { describe, expect, test } from "bun:test";
import { bindMobileTerminalViewport } from "../web/src/mobile-terminal-viewport.js";

function environment(mobile = true) {
  const classes = new Set<string>();
  const styles = new Map<string, string>();
  const media = Object.assign(new EventTarget(), { matches: mobile });
  const viewport = Object.assign(new EventTarget(), { height: 775, offsetTop: 0 });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const scrolls: number[][] = [];
  const view = Object.assign(new EventTarget(), {
    innerHeight: 775, scrollX: 0, scrollY: 120,
    visualViewport: viewport,
    matchMedia: () => media,
    document: { documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
        toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
      },
      style: {
        setProperty: (name: string, value: string) => styles.set(name, value),
        removeProperty: (name: string) => styles.delete(name),
      },
    } },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    scrollTo: (x: number, y: number) => { scrolls.push([x, y]); view.scrollX = x; view.scrollY = y; },
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return { view: view as unknown as Window, media, viewport, classes, styles, frames, scrolls, flush };
}

describe("mobile terminal viewport lifecycle", () => {
  test("repeated keyboard opening follows viewport bounds without driving page scroll", () => {
    const env = environment();
    const dispose = bindMobileTerminalViewport(env.view);
    expect(env.classes.has("tmux-mobile-viewport")).toBe(true);
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const [height, offsetTop] of [[412, 0], [183.984375, 363.328125], [314, 461], [775, 0]]) {
        Object.assign(env.viewport, { height, offsetTop });
        env.viewport.dispatchEvent(new Event("resize"));
        env.viewport.dispatchEvent(new Event("scroll"));
        expect(env.frames.size).toBe(1);
        env.flush();
        expect(env.styles.get("--tmux-viewport-height")).toBe(height + "px");
        expect(env.styles.get("--tmux-viewport-top")).toBe(offsetTop + "px");
        expect(env.classes.has("tmux-compact-viewport")).toBe(height < 300);
      }
    }
    // Focusing and keyboard animations must not scroll the document.
    expect(env.scrolls).toEqual([]);
    dispose();
    expect(env.scrolls).toEqual([[0, 120]]);
    expect(env.classes.size).toBe(0);
    expect(env.styles.size).toBe(0);
  });

  test("invalid transition sizes retain geometry; leaving cancels pending work and listeners", () => {
    const env = environment();
    const dispose = bindMobileTerminalViewport(env.view);
    for (const height of [-44, 0, Number.NaN]) {
      env.viewport.height = height;
      env.viewport.dispatchEvent(new Event("resize"));
      env.flush();
      expect(env.styles.get("--tmux-viewport-height")).toBe("775px");
    }
    env.viewport.height = 412;
    env.viewport.dispatchEvent(new Event("resize"));
    expect(env.frames.size).toBe(1);
    dispose();
    env.flush();
    env.viewport.dispatchEvent(new Event("resize"));
    env.view.dispatchEvent(new Event("resize"));
    expect(env.frames.size).toBe(0);
    expect(env.styles.size).toBe(0);
  });

  test("desktop stays unlocked and changing the media query restores the previous page", () => {
    const env = environment(false);
    const dispose = bindMobileTerminalViewport(env.view);
    expect(env.classes.size).toBe(0);
    expect(env.scrolls).toEqual([]);
    env.media.matches = true;
    env.media.dispatchEvent(new Event("change"));
    expect(env.classes.has("tmux-mobile-viewport")).toBe(true);
    env.media.matches = false;
    env.media.dispatchEvent(new Event("change"));
    expect(env.classes.size).toBe(0);
    expect(env.styles.size).toBe(0);
    expect(env.scrolls).toEqual([[0, 120]]);
    dispose();
  });
});
