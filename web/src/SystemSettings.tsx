import { useCallback, useEffect, useState, type ReactElement } from "react";

import { readVConsoleVisible, writeVConsoleVisible, readMobileShakeEnabled } from "./app-settings.js";
import { isMobileApp, setMobileShakeEnabled } from "./mobile-runtime.js";
import { useTheme, type ThemeMode } from "./theme.js";
import { fetchWorkbenchSettings, updateWorkbenchSettings, type WorkbenchNotificationSettings } from "./workbench-api.js";
import "./workbench.css";
import { readMobileNotificationPreferences, updateMobileNotificationPreferences, type MobileNotificationPreferences } from "./mobile-notifications.js";
import { getMobileNotificationPermission } from "./mobile-runtime.js";

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
  const [nativePreferences, setNativePreferences] = useState<MobileNotificationPreferences>(readMobileNotificationPreferences);
  const [nativePermission, setNativePermission] = useState("读取中");
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeError, setNativeError] = useState("");
  useEffect(() => {
    if (isMobileApp()) void getMobileNotificationPermission().then(setNativePermission).catch(() => setNativePermission("暂不可读"));
  }, []);
  const updateNative = (patch: Partial<Omit<MobileNotificationPreferences, "enabledAt">>): void => {
    if (nativeBusy) return;
    setNativeBusy(true); setNativeError("");
    void updateMobileNotificationPreferences(patch).then(setNativePreferences).then(() => getMobileNotificationPermission()).then(setNativePermission)
      .catch((cause: unknown) => setNativeError(cause instanceof Error ? cause.message : "原生通知设置失败。" )).finally(() => setNativeBusy(false));
  };

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
      {isMobileApp() ? <section className="system-settings-notifications" aria-label="本机原生通知">
        <h2>本机原生通知与恢复</h2><p className="workbench-settings-note">设置只作用当前环境和当前设备。系统权限：{nativePermission}。前台检测到新事件后发原生通知；后台即时推送尚未配置，不承诺退出 App 后获知新事件。</p>
        <NotificationPreferenceRow title="启用本机原生通知" description="仅提示有新动态；点击后验证环境和设备并打开关联页面。" checked={nativePreferences.enabled} disabled={nativeBusy} onChange={(enabled) => updateNative({ enabled })} />
        {([ ["completion", "完成通知"], ["failure", "失败通知"], ["action", "待处理通知"] ] as const).map(([key, title]) => <NotificationPreferenceRow key={key} title={title} description="在当前设备接收此类事件；站内记录不受本开关影响。" checked={nativePreferences[key]} disabled={nativeBusy} onChange={(enabled) => updateNative({ [key]: enabled })} />)}
        <NotificationPreferenceRow title="恢复上次工作页面" description="按环境和设备恢复；通知、分享及显式打开目标优先，不恢复执行操作。" checked={nativePreferences.restoreLocation} disabled={nativeBusy} onChange={(restoreLocation) => updateNative({ restoreLocation })} />
        {nativeError ? <p className="workbench-page-error" role="alert">{nativeError}</p> : null}
      </section> : null}
      <section className="system-settings-notifications" aria-label="通知偏好">
        <header className="workbench-page-header">
          <div><h2>通知偏好</h2><p className="workbench-settings-note">{isMobileApp() ? "以下事件类别由后端保存；本机原生通知另由上方设备设置控制。待处理中心始终可查看已有记录。" : "站内通知保留在任务面板；浏览器通知在页面打开时检查新通知，并需要浏览器授权。"}</p></div>
          <button type="button" onClick={() => setNotificationRevision((value) => value + 1)} disabled={notificationLoading}>刷新</button>
        </header>
        {notificationError ? <div className="workbench-page-error" role="alert">{notificationError}<button type="button" onClick={() => setNotificationRevision((value) => value + 1)}>重试</button></div> : null}
        <section className="system-settings-panel" aria-label="任务通知开关">
          {notificationLoading && !notifications ? <p className="workbench-muted">正在读取通知偏好…</p> : null}
          {notifications ? <>
            <NotificationPreferenceRow title="任务完成" description="任务执行完成时显示站内通知。" checked={notifications.completion} disabled={notificationSaving !== null} onChange={(checked) => void updateNotification("completion", checked)} />
            <NotificationPreferenceRow title="任务失败" description="任务执行失败时显示站内通知。" checked={notifications.failure} disabled={notificationSaving !== null} onChange={(checked) => void updateNotification("failure", checked)} />
            <NotificationPreferenceRow title="等待处理" description="有问题或审批需要处理时显示站内通知。" checked={notifications.action} disabled={notificationSaving !== null} onChange={(checked) => void updateNotification("action", checked)} />
            <NotificationPreferenceRow title={isMobileApp() ? "Web 通知兼容偏好（原有）" : "浏览器系统通知"} description={isMobileApp() ? "此项不控制 App 原生通知；原生权限与开关见上方本机设置。" : typeof Notification === "undefined" ? "此浏览器不支持系统通知。" : `浏览器权限：${Notification.permission}`} checked={notifications.browser} disabled={notificationSaving !== null || typeof Notification === "undefined"} onChange={(checked) => void updateNotification("browser", checked)} />
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
