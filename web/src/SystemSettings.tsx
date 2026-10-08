import { useState, type ReactElement } from "react";

import { readVConsoleVisible, writeVConsoleVisible } from "./app-settings.js";
import { useTheme, type ThemeMode } from "./theme.js";

export function SystemSettings(): ReactElement {
  const { mode, setMode } = useTheme();
  const [vConsoleVisible, setVConsoleVisible] = useState(readVConsoleVisible);

  return (
    <main className="page-main system-settings-page">
      <h1>系统设置</h1>
      <section className="system-settings-panel" aria-label="界面设置">
        <label className="system-settings-row" htmlFor="system-settings-theme-mode">
          <span>主题颜色</span>
          <select
            id="system-settings-theme-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as ThemeMode)}
          >
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </label>
        {import.meta.env.DEV ? (
          <label className="system-settings-row" htmlFor="system-settings-vconsole-visible">
            <span>显示 VConsole</span>
            <input
              id="system-settings-vconsole-visible"
              type="checkbox"
              checked={vConsoleVisible}
              onChange={(event) => {
                const visible = event.currentTarget.checked;
                setVConsoleVisible(visible);
                writeVConsoleVisible(visible);
              }}
            />
          </label>
        ) : null}
      </section>
    </main>
  );
}
