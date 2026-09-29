import { createContext, useContext, useEffect, useState, type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { NavLink, useLocation } from "react-router";

import { useTheme, type ThemeMode } from "./theme.js";

const PAGES = [
  { to: "/", label: "Bridge", end: true },
  { to: "/codex-history", label: "Codex 历史", end: true },
  { to: "/tmux-dashboard", label: "tmux Dashboard", end: false },
] as const;

const SYSTEM_PAGES = [
  { to: "/system-management/devices", label: "设备管理" },
  { to: "/system-management/shortcuts", label: "快捷键管理" },
] as const;

type SystemNavigationState = {
  collapsed: boolean;
  setCollapsed: Dispatch<SetStateAction<boolean>>;
  toggle: () => void;
};

const SystemNavigationContext = createContext<SystemNavigationState | null>(null);

export function SystemNavigationProvider({ children }: { children: ReactNode }): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const value = { collapsed, setCollapsed, toggle: () => setCollapsed((current) => !current) };
  return <SystemNavigationContext.Provider value={value}>{children}</SystemNavigationContext.Provider>;
}

export function useSystemNavigation(): SystemNavigationState {
  const state = useContext(SystemNavigationContext);
  if (!state) throw new Error("useSystemNavigation must be used inside SystemNavigationProvider.");
  return state;
}

export function WebNavigation(): ReactElement {
  const { mode, setMode } = useTheme();
  const { collapsed, toggle } = useSystemNavigation();
  const location = useLocation();
  const systemActive = location.pathname.startsWith("/system-management") || location.pathname === "/pair-admin";
  const [systemOpen, setSystemOpen] = useState(systemActive);
  useEffect(() => {
    if (systemActive) setSystemOpen(true);
  }, [systemActive]);
  useEffect(() => {
    if (!systemActive) setSystemOpen(false);
  }, [location.pathname, systemActive]);
  return (
    <div className={`system-navigation-shell${collapsed ? " is-collapsed" : ""}`}>
      <nav className="web-navigation" aria-label="系统页面">
        <button
          className="web-navigation-toggle"
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "展开顶部菜单" : "收起顶部菜单"}
          aria-expanded={!collapsed}
          aria-controls="web-navigation-menu"
          title={collapsed ? "展开顶部菜单" : "收起顶部菜单"}
        ><span aria-hidden="true">☰</span></button>
        <div id="web-navigation-menu" className="web-navigation-menu" hidden={collapsed}>
          {PAGES.map((page) => (
            <NavLink key={page.to} to={page.to} end={page.end} onClick={() => setSystemOpen(false)}>
              {page.label}
            </NavLink>
          ))}
          <div className={`web-navigation-group${systemOpen ? " is-open" : ""}`}>
            <button
              className="web-navigation-group-trigger"
              type="button"
              aria-expanded={systemOpen}
              aria-haspopup="menu"
              aria-controls="system-navigation-submenu"
              onClick={() => setSystemOpen((current) => !current)}
            >系统管理 <span aria-hidden="true">⌄</span></button>
          </div>
          <label className="theme-picker">
            <span>主题</span>
            <select aria-label="选择主题" value={mode} onChange={(event) => setMode(event.target.value as ThemeMode)}>
              <option value="system">跟随系统</option>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
        </div>
      </nav>
      {systemOpen ? (
        <div id="system-navigation-submenu" className="web-navigation-submenu-popover" role="menu" aria-label="系统管理">
          {SYSTEM_PAGES.map((page) => (
            <NavLink
              key={page.to}
              to={page.to}
              role="menuitem"
              className={({ isActive }) => isActive ? "is-active" : undefined}
              onClick={() => setSystemOpen(false)}
            >{page.label}</NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
