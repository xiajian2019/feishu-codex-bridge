import type { ReactElement } from "react";
import { NavLink } from "react-router";

import { useTheme, type ThemeMode } from "./theme.js";

const PAGES = [
  { to: "/", label: "Bridge", end: true },
  { to: "/tmux-dashboard", label: "tmux Dashboard", end: false },
  { to: "/pair-admin", label: "设备管理", end: true },
] as const;

export function WebNavigation(): ReactElement {
  const { mode, setMode } = useTheme();
  return (
    <div className="system-navigation-shell">
      <nav className="web-navigation" aria-label="系统页面">
        {PAGES.map((page) => (
          <NavLink key={page.to} to={page.to} end={page.end}>
            {page.label}
          </NavLink>
        ))}
        <label className="theme-picker">
          <span>主题</span>
          <select aria-label="选择主题" value={mode} onChange={(event) => setMode(event.target.value as ThemeMode)}>
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </label>
      </nav>
    </div>
  );
}
