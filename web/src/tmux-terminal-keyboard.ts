import type { Terminal } from "@xterm/xterm";

/**
 * Keep page-level keyboard maps (including browser Vim extensions) away from
 * keys that are being typed into an xterm terminal. The custom handler runs
 * before xterm processes the event, so returning true keeps terminal input
 * intact while stopping the event from bubbling to the page.
 */
export function isolateTmuxTerminalKeyboard(terminal: Terminal): void {
  terminal.attachCustomKeyEventHandler((event) => {
    event.stopPropagation();
    return true;
  });
}
