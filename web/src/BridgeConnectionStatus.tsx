import type { ReactElement } from "react";

import { useBridgeConnection } from "./connection-state.js";
import "./connection-status.css";

export function BridgeConnectionStatus(): ReactElement | null {
  const connection = useBridgeConnection();
  if (connection.browserOnline && (connection.api === "connected" || connection.api === "unknown") && !connection.lastError) return null;

  const offline = !connection.browserOnline;
  const stale = connection.api === "stale";
  const title = offline ? "当前设备离线" : stale ? "连接已恢复，页面显示的是最近数据" : connection.api === "checking" ? "正在连接 Bridge…" : "Bridge API 暂时不可用";
  const detail = offline
    ? "网络恢复后会自动重试，不会刷新当前页面。"
    : stale
      ? "新数据会在连接稳定后逐页更新。"
      : connection.pending > 0
        ? "正在等待服务响应，当前页面内容会保留。"
        : "请检查 Bridge 服务或网络；已有页面和草稿仍可继续查看。";
  return <div className={`bridge-connection-banner ${offline ? "is-offline" : stale ? "is-stale" : "is-unreachable"}`} role="status" aria-live="polite">
    <span className="bridge-connection-dot" aria-hidden="true" />
    <span className="bridge-connection-copy"><strong>{title}</strong><small>{detail}</small></span>
    {connection.lastSuccessAt && stale ? <time dateTime={new Date(connection.lastSuccessAt).toISOString()}>最近同步 {new Date(connection.lastSuccessAt).toLocaleTimeString("zh-CN", { hour12: false })}</time> : null}
  </div>;
}
