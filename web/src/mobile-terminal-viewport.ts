// Own the mobile terminal's viewport for the whole screen, before an input is focused.
// The composer stays in flex flow; only this wrapper follows the VisualViewport.
export function bindMobileTerminalViewport(view: Window): () => void {
  const root = view.document.documentElement;
  const media = view.matchMedia("(max-width: 760px)");
  const viewport = view.visualViewport;
  let active = false;
  let frame = 0;
  let savedX = 0;
  let savedY = 0;

  const update = (): void => {
    frame = 0;
    if (!active) return;
    const height = viewport?.height ?? view.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    // WebKit can report a negative height during the keyboard transition.
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(top)) return;
    root.style.setProperty("--tmux-viewport-height", height + "px");
    root.style.setProperty("--tmux-viewport-top", Math.max(0, top) + "px");
    root.classList.toggle("tmux-compact-viewport", height < 300);
  };
  const schedule = (): void => {
    if (active && !frame) frame = view.requestAnimationFrame(update);
  };
  const unlock = (): void => {
    if (!active) return;
    active = false;
    view.cancelAnimationFrame(frame);
    frame = 0;
    root.classList.remove("tmux-mobile-viewport", "tmux-compact-viewport");
    root.style.removeProperty("--tmux-viewport-height");
    root.style.removeProperty("--tmux-viewport-top");
    view.scrollTo(savedX, savedY);
  };
  const syncMode = (): void => {
    if (!media.matches) {
      unlock();
      return;
    }
    if (!active) {
      savedX = view.scrollX;
      savedY = view.scrollY;
      active = true;
      root.classList.add("tmux-mobile-viewport");
      // Keep the browser's current page position. Locking the shell must not
      // itself cause a visible jump to the top or bottom of the page.
    }
    update();
  };
  media.addEventListener("change", syncMode);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  view.addEventListener("resize", schedule);
  syncMode();
  return () => {
    media.removeEventListener("change", syncMode);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    view.removeEventListener("resize", schedule);
    unlock();
  };
}
