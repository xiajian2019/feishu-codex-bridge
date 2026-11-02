import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativeTheme = "light" | "dark";

interface NativeThemePlugin {
  setTheme(request: { theme: NativeTheme }): Promise<void>;
  getTheme(): Promise<{ theme: NativeTheme }>;
}

const NativeThemePlugin = registerPlugin<NativeThemePlugin>("BridgeNativeTheme");

/** Keep native Activities aligned with the Web ThemeProvider. */
export function syncNativeTheme(theme: NativeTheme): void {
  if (!Capacitor.isNativePlatform()) return;
  void NativeThemePlugin.setTheme({ theme }).catch(() => {
    // Native theme sync is best effort; the Activity falls back to system theme.
  });
}
