export const VCONSOLE_VISIBILITY_CHANGE_EVENT = "feishu-codex-bridge:vconsole-visibility-change";

const VCONSOLE_VISIBILITY_STORAGE_KEY = "feishu-codex-bridge.vconsole-visible";

export function readVConsoleVisible(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(VCONSOLE_VISIBILITY_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeVConsoleVisible(visible: boolean): void {
  try {
    window.localStorage.setItem(VCONSOLE_VISIBILITY_STORAGE_KEY, String(visible));
  } catch {
    // Keep the current tab usable when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(VCONSOLE_VISIBILITY_CHANGE_EVENT));
}
