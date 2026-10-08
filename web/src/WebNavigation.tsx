import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router";


const PAGES = [
  { to: "/", label: "任务面板", end: true },
  { to: "/codex-history", label: "Codex 历史", end: true },
  { to: "/tmux-dashboard", label: "Tmux", end: false },
] as const;

const SYSTEM_PAGES = [
  { to: "/system-management/health", label: "运行状态" },
  { to: "/system-management/backups", label: "数据备份" },
  { to: "/system-management/devices", label: "设备管理" },
  { to: "/system-management/projects", label: "项目管理" },
  { to: "/system-management/shortcuts", label: "快捷键管理" },
  { to: "/system-management/usage", label: "Codex 用量" },
  { to: "/system-management/settings", label: "系统设置" },
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
  const { collapsed, toggle } = useSystemNavigation();
  const location = useLocation();
  const systemActive = location.pathname.startsWith("/system-management") || location.pathname === "/pair-admin";
  const [systemOpen, setSystemOpen] = useState(systemActive);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(null);
  const systemTriggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const activePopover = systemOpen ? "system" : null;

  useEffect(() => {
    if (systemActive) setSystemOpen(true);
  }, [systemActive]);
  useEffect(() => {
    if (!systemActive) setSystemOpen(false);
  }, [location.pathname, systemActive]);

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
    const popoverWidth = 190;
    const estimatedPopoverHeight = 280;
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
        style={{ top: popoverPosition.top, left: popoverPosition.left }}
      >
        {SYSTEM_PAGES.map((page) => (
          <NavLink
            key={page.to}
            to={page.to}
            role="menuitem"
            className={({ isActive }) => isActive ? "is-active" : undefined}
            onClick={closePopovers}
          >{page.label}</NavLink>
        ))}
      </div>,
      document.body,
    )
    : null;

  return (
    <div className={`system-navigation-shell${collapsed ? " is-collapsed" : ""}`}>
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
          {PAGES.map((page) => (
            <NavLink key={page.to} to={page.to} end={page.end} onClick={closePopovers}>
              {page.label}
            </NavLink>
          ))}
          <div className={`web-navigation-group${systemOpen ? " is-open" : ""}`}>
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
