import { useCallback, useEffect, useState, type ReactElement } from "react";

import { readVConsoleVisible, writeVConsoleVisible, readMobileShakeEnabled } from "./app-settings.js";
import { isMobileApp, setMobileShakeEnabled } from "./mobile-runtime.js";
import { useTheme, type ThemeMode } from "./theme.js";
import { fetchWorkbenchSettings, updateWorkbenchSettings, type WorkbenchNotificationSettings } from "./workbench-api.js";
import "./workbench.css";

export function SystemSettings(): ReactElement {
  const { mode, setMode } = useTheme();
  const [vConsoleVisible, setVConsoleVisible] = useState(readVConsoleVisible);
  const [notifications, setNotifications] = useState<WorkbenchNotificationSettings | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationLoading, setNotificationLoading] = useState(true);
  const [notificationSaving, setNotificationSaving] = useState<string | null>(null);
  const [notificationRevision, setNotificationRevision] = useState(0);
  const [shakeEnabled, setShakeEnabled] = useState(readMobileShakeEnabled);
  const [shakeBusy, setShakeBusy] = useState(false);
  const [shakeError, setShakeError] = useState("");

  const loadNotifications = useCallback(async (): Promise<void> => {
    setNotificationLoading(true);
    setNotificationError(null);
    try {
      const result = await fetchWorkbenchSettings();
      setNotifications(result.settings.notifications);
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : String(error));
    } finally {
      setNotificationLoading(false);
    }
  }, []);

  useEffect(() => { void loadNotifications(); }, [loadNotifications, notificationRevision]);

  const updateNotification = async (key: keyof WorkbenchNotificationSettings, checked: boolean): Promise<void> => {
    if (notificationSaving || !notifications) return;
    if (key === "browser" && checked) {
      if (typeof Notification === "undefined") {
        setNotificationError("此浏览器不支持系统通知。");
        return;
      }
      if (Notification.permission !== "granted") {
        let permission: NotificationPermission;
        try { permission = await Notification.requestPermission(); }
        catch (error) {
          setNotificationError(error instanceof Error ? error.message : "无法请求浏览器通知权限。");
          return;
        }
        if (permission !== "granted") {
          setNotificationError(permission === "denied" ? "浏览器已拒绝通知权限，请在浏览器设置中开启后重试。" : "未授予浏览器通知权限。偏好未更改。");
          return;
        }
      }
    }
    setNotificationSaving(key);
    setNotificationError(null);
    try {
      const result = await updateWorkbenchSettings({ [key]: checked });
      setNotifications(result.settings.notifications);
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : String(error));
    } finally {
      setNotificationSaving(null);
    }
  };

  return (
    <main className="page-main system-settings-page">
      <h1>系统设置</h1>
      <section className="system-settings-panel" aria-label="界面设置">
        {isMobileApp() ? <>
          <label className="system-settings-row"><span>摇一摇切换环境</span><input type="checkbox" checked={shakeEnabled} disabled={shakeBusy} onChange={(event) => {
            const enabled = event.target.checked;
            setShakeBusy(true); setShakeError("");
            void setMobileShakeEnabled(enabled).then(() => setShakeEnabled(enabled)).catch((cause: unknown) => {
              setShakeError(cause instanceof Error ? cause.message : "无法更改摇一摇设置。");
            }).finally(() => setShakeBusy(false));
          }} /></label>
          {shakeError ? <p className="workbench-page-error" role="alert">{shakeError}</p> : null}
        </> : null}
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
      <section className="system-settings-notifications" aria-label="通知偏好">
        <header className="workbench-page-header">
          <div><h2>通知偏好</h2><p className="workbench-settings-note">站内通知保留在任务面板；浏览器通知在页面打开时检查新通知，并需要浏览器授权。</p></div>
          <button type="button" onClick={() => setNotificationRevision((value) => value + 1)} disabled={notificationLoading}>刷新</button>
        </header>
        {notificationError ? <div className="workbench-page-error" role="alert">{notificationError}<button type="button" onClick={() => setNotificationRevision((value) => value + 1)}>重试</button></div> : null}
        <section className="system-settings-panel" aria-label="任务通知开关">
          {notificationLoading && !notifications ? <p className="workbench-muted">正在读取通知偏好…</p> : null}
          {notifications ? <>
            <NotificationPreferenceRow title="任务完成" description="任务执行完成时显示站内通知。" checked={notifications.completion} disabled={notificationSaving !== null} onChange={(checked) => void updateNotification("completion", checked)} />
            <NotificationPreferenceRow title="任务失败" description="任务执行失败时显示站内通知。" checked={notifications.failure} disabled={notificationSaving !== null} onChange={(checked) => void updateNotification("failure", checked)} />
            <NotificationPreferenceRow title="等待处理" description="有问题或审批需要处理时显示站内通知。" checked={notifications.action} disabled={notificationSaving !== null} onChange={(checked) => void updateNotification("action", checked)} />
            <NotificationPreferenceRow title="浏览器系统通知" description={typeof Notification === "undefined" ? "此浏览器不支持系统通知。" : `浏览器权限：${Notification.permission}`} checked={notifications.browser} disabled={notificationSaving !== null || typeof Notification === "undefined"} onChange={(checked) => void updateNotification("browser", checked)} />
          </> : !notificationLoading && !notificationError ? <p className="workbench-muted">通知偏好暂不可用。</p> : null}
        </section>
      </section>
    </main>
  );
}

function NotificationPreferenceRow({ title, description, checked, disabled, onChange }: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return <div className="workbench-settings-row">
    <label><span>{title}</span><small>{description}</small></label>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} aria-label={title} />
  </div>;
}
