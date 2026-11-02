import { useEffect, useRef } from "react";
import { createBackStack } from "./mobile-back-stack.js";
import { isMobileApp, MOBILE_BACK_EVENT } from "./mobile-runtime.js";

const stack = createBackStack();
let subscriptions = 0;
const back = (event: Event): void => {
  if (event.defaultPrevented || !stack.dispatch("back")) return;
  event.preventDefault(); event.stopImmediatePropagation();
};
const escape = (event: KeyboardEvent): void => {
  if (event.key !== "Escape" || event.defaultPrevented || !stack.dispatch("escape")) return;
  event.preventDefault(); event.stopImmediatePropagation();
};

/** Priorities match the visible layers; a zero-priority handler handles a local detail view before route history. */
export function useMobileBack(active: boolean, close: () => void, priority = 100, options: { escape?: boolean; restoreFocus?: boolean } = {}): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const escapeEnabled = options.escape !== false;
  const restoreFocus = options.restoreFocus !== false;
  useEffect(() => {
    if (!active || !isMobileApp()) return;
    const previousFocus = document.activeElement;
    const remove = stack.register(() => closeRef.current(), priority, escapeEnabled);
    if (++subscriptions === 1) {
      window.addEventListener(MOBILE_BACK_EVENT, back, true);
      window.addEventListener("keydown", escape, true);
    }
    return () => {
      const wasTop = remove();
      if (--subscriptions === 0) {
        window.removeEventListener(MOBILE_BACK_EVENT, back, true);
        window.removeEventListener("keydown", escape, true);
      }
      if (wasTop && restoreFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [active, priority, escapeEnabled, restoreFocus]);
}
