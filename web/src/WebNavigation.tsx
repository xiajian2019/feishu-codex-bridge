import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router";
import { isMobileApp, openMobileConnectionSettings } from "./mobile-runtime.js";


const PAGES = [
  { to: "/tmux-dashboard", label: "Tmux", end: false },
  { to: "/system-management/apps", label: "App 管理", end: true },
  { to: "/demos", label: "Demo", end: true },
  { to: "/codex-history", label: "Codex 历史", end: true },
] as const;

const SYSTEM_NAVIGATION_GROUPS = [
  {
    id: "operations",
    label: "运行与数据",
    column: "left",
    pages: [
      { to: "/system-management/health", label: "运行状态" },
      { to: "/system-management/backups", label: "数据备份" },
      { to: "/system-management/uploads", label: "上传下载" },
    ],
  },
  {
    id: "workspace",
    label: "项目与执行",
    column: "right",
    pages: [
      { to: "/tasks", label: "任务面板" },
      { to: "/system-management/projects", label: "项目管理" },
      { to: "/system-management/workspaces", label: "Git 工作区" },
      { to: "/system-management/automations", label: "自动化" },
      { to: "/system-management/machines", label: "执行机器" },
    ],
  },
  {
    id: "codex",
    label: "Codex 工具",
    column: "left",
    pages: [
      { to: "/system-management/shortcuts", label: "快捷键与技能" },
      { to: "/system-management/usage", label: "Codex 用量" },
      { to: "/system-management/jj", label: "JJ 工具" },
    ],
  },
  {
    id: "devices",
    label: "设备与连接",
    column: "right",
    pages: [
      { to: "/remote-desktop", label: "远程桌面" },
      { to: "/system-management/devices", label: "设备管理" },
    ],
  },
  {
    id: "preferences",
    label: "偏好设置",
    column: "left",
    pages: [
      { to: "/system-management/settings", label: "系统设置" },
    ],
  },
] as const;

const MOBILE_SYSTEM_PAGES = [
  { to: "/system-management/app-tools", label: "扫一扫" },
  { to: "/mobile-inbox", label: "待处理" },
  { to: "/mobile-shares", label: "分享收件箱" },
  { to: "/nearby-transfer", label: "附近传文件" },
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

import { useMobileBack } from "./use-mobile-back.js";

export function WebNavigation(): ReactElement {
  const { collapsed, toggle } = useSystemNavigation();
  const location = useLocation();
  const pages = PAGES;
  const standaloneToolRoute = location.pathname === "/system-management/app-tools" || location.pathname === "/composer-transfer";
  const appManagementRoute = location.pathname === "/system-management/apps" || location.pathname.startsWith("/system-management/apps/");
  const systemActive = !standaloneToolRoute && !appManagementRoute && (location.pathname.startsWith("/system-management") || location.pathname === "/pair-admin"
    || location.pathname === "/remote-desktop" || location.pathname === "/tasks" || location.pathname.startsWith("/tasks/")
    || (isMobileApp() && ["/mobile-inbox", "/mobile-shares", "/nearby-transfer"].includes(location.pathname)));
  const [systemOpen, setSystemOpen] = useState(false);
  useMobileBack(systemOpen, () => setSystemOpen(false), 1000);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(null);
  const systemTriggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const activePopover = systemOpen ? "system" : null;

  useEffect(() => {
    const closeForMobileEnvironment = (): void => setSystemOpen(false);
    window.addEventListener("bridge:mobile-environment-open", closeForMobileEnvironment);
    return () => window.removeEventListener("bridge:mobile-environment-open", closeForMobileEnvironment);
  }, []);

  useEffect(() => {
    setSystemOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (collapsed) setSystemOpen(false);
  }, [collapsed]);

  useLayoutEffect(() => {
    if (!activePopover) {
      setPopoverPosition(null);
      return;
    }
    const trigger = systemTriggerRef.current;
    if (!trigger) return;
    const popoverWidth = Math.min(440, window.innerWidth - 24);
    const estimatedPopoverHeight = window.innerWidth <= 480 ? 420 : 360;
    const updatePosition = (): void => {
      const rect = trigger.getBoundingClientRect();
      const maxLeft = Math.max(12, window.innerWidth - popoverWidth - 12);
      const belowTop = rect.bottom + 6;
      const top = belowTop + estimatedPopoverHeight <= window.innerHeight - 12
        ? belowTop
        : Math.max(12, rect.top - estimatedPopoverHeight - 6);
      const nextPosition = {
        top: Math.round(top),
        left: Math.round(Math.max(12, Math.min(rect.left, maxLeft))),
      };
      setPopoverPosition((current) => current && current.top === nextPosition.top && current.left === nextPosition.left ? current : nextPosition);
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [activePopover]);

  useEffect(() => {
    if (!activePopover) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (systemTriggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setSystemOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setSystemOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activePopover]);

  const closePopovers = (): void => {
    setSystemOpen(false);
  };

  const systemPopover = activePopover === "system" && popoverPosition
    ? createPortal(
      <div
        id="system-navigation-submenu"
        ref={popoverRef}
        className="web-navigation-submenu-popover"
        role="menu"
        aria-label="系统管理"
        style={{ top: popoverPosition.top, left: popoverPosition.left, maxHeight: `calc(100dvh - ${popoverPosition.top + 12}px)` }}
      >
        <div className="web-navigation-submenu-heading" role="presentation">
          <strong>系统管理</strong>
          <span>按使用场景整理</span>
        </div>
        <div className="web-navigation-submenu-columns" role="presentation">
          {(["left", "right"] as const).map((column) => (
            <div key={column} className="web-navigation-submenu-column" role="presentation">
              {SYSTEM_NAVIGATION_GROUPS.filter((group) => group.column === column).map((group) => (
                <section key={group.id} className="web-navigation-submenu-group" role="group" aria-labelledby={`system-navigation-group-${group.id}`}>
                  <h2 id={`system-navigation-group-${group.id}`}>{group.label}</h2>
                  <div className="web-navigation-submenu-group-items">
                    {group.pages.map((page) => (
                      <NavLink
                        key={page.to}
                        to={page.to}
                        role="menuitem"
                        className={({ isActive }) => isActive ? "is-active" : undefined}
                        onClick={closePopovers}
                      >{page.label}</NavLink>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ))}
        </div>
        {isMobileApp() ? <>
          <section className="web-navigation-submenu-group is-mobile" role="group" aria-labelledby="system-navigation-group-mobile">
            <h2 id="system-navigation-group-mobile">App 与连接</h2>
            <div className="web-navigation-submenu-group-items">
              <button
                className="web-navigation-submenu-action"
                type="button"
                role="menuitem"
                onClick={() => {
                  closePopovers();
                  openMobileConnectionSettings();
                }}
              >App 连接</button>
              {MOBILE_SYSTEM_PAGES.map((page) => (
                <NavLink key={page.to} to={page.to} role="menuitem" className={({ isActive }) => isActive ? "is-active" : undefined} onClick={closePopovers}>{page.label}</NavLink>
              ))}
            </div>
          </section>
        </> : null}
      </div>,
      document.body,
    )
    : null;

  return (
    <div className={`system-navigation-shell${collapsed ? " is-collapsed" : ""}${location.pathname === "/composer-transfer" ? " is-composer-transfer" : ""}`}>
      <nav className="web-navigation" aria-label="系统页面">
        <button
          className="web-navigation-toggle"
          type="button"
          onClick={() => {
            closePopovers();
            toggle();
          }}
          aria-label={collapsed ? "展开顶部菜单" : "收起顶部菜单"}
          aria-expanded={!collapsed}
          aria-controls="web-navigation-menu"
          title={collapsed ? "展开顶部菜单" : "收起顶部菜单"}
        ><span aria-hidden="true">☰</span></button>
        <div id="web-navigation-menu" className="web-navigation-menu" hidden={collapsed}>
          {pages.map((page) => (
            <NavLink key={page.to} to={page.to} end={page.end} onClick={closePopovers}>
              {page.label}
            </NavLink>
          ))}
          <div className={`web-navigation-group${systemOpen ? " is-open" : ""}${systemActive ? " is-current" : ""}`}>
            <button
              ref={systemTriggerRef}
              className="web-navigation-group-trigger"
              type="button"
              aria-expanded={systemOpen}
              aria-haspopup="menu"
              aria-controls="system-navigation-submenu"
              onClick={() => {
                setSystemOpen((current) => !current);
              }}
            >系统管理 <span className="menu-chevron" aria-hidden="true" /></button>
          </div>
        </div>
      </nav>
      {systemPopover}
    </div>
  );
}
