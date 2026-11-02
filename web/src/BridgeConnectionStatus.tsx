import { useEffect, useRef, useState, type ReactElement } from "react";
import { useLocation } from "react-router";

import { useBridgeConnection } from "./connection-state.js";
import "./connection-status.css";
import { isStandaloneSshPath } from "./ssh-route.js";

export function BridgeConnectionStatus(): ReactElement | null {
  const location = useLocation();
  const connection = useBridgeConnection();
  const statusKey = [connection.browserOnline, connection.api, connection.failureKind, connection.target].join(":");
  const lastStatusKeyRef = useRef<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (lastStatusKeyRef.current === statusKey) return;
    lastStatusKeyRef.current = statusKey;
    setDismissed(false);
  }, [statusKey]);
  if (isStandaloneSshPath(location.pathname)) return null;
  if (connection.browserOnline && (connection.api === "connected" || connection.api === "unknown") && !connection.lastError) return null;
  if (dismissed) return null;

  const offline = !connection.browserOnline;
  const stale = connection.api === "stale";
  const title = offline ? "当前设备离线"
    : connection.failureKind === "target-unreachable" ? "目标主机端口不可达"
    : connection.failureKind === "api-auth-failed" ? "Bridge 鉴权失败"
    : connection.failureKind === "api-response-error" ? "Bridge API 返回错误"
    : stale ? "连接已恢复，页面显示的是最近数据"
    : connection.api === "checking" ? "正在连接 Bridge…" : "Bridge API 网络不可达";
  const detail = offline
    ? "网络恢复后会自动重试，不会刷新当前页面。"
    : connection.failureKind === "target-unreachable"
      ? "已检测到网络可用，正在尝试已安装的 OpenVPN for Android；连接成功后会自动重试。"
    : connection.failureKind === "api-auth-failed"
      ? "Bridge 已收到请求但拒绝了当前凭据，请重新配对或检查设备授权。"
    : connection.failureKind === "api-response-error"
      ? "Bridge 已收到请求但返回了错误；请检查服务状态，网络层不会启动 VPN。"
    : stale
      ? "新数据会在连接稳定后逐页更新。"
      : connection.pending > 0
        ? "正在等待服务响应，当前页面内容会保留。"
        : "请检查 Bridge 服务或网络；仅当目标主机端口不可达且手机网络可用时才会自动尝试 VPN。";
  return <div className={`bridge-connection-banner ${offline ? "is-offline" : stale ? "is-stale" : "is-unreachable"}`} role="status" aria-live="polite">
    <span className="bridge-connection-dot" aria-hidden="true" />
    <span className="bridge-connection-copy"><strong>{title}</strong><small>{detail}</small></span>
    {connection.lastSuccessAt && stale ? <time dateTime={new Date(connection.lastSuccessAt).toISOString()}>最近同步 {new Date(connection.lastSuccessAt).toLocaleTimeString("zh-CN", { hour12: false })}</time> : null}
    <button className="bridge-connection-dismiss" type="button" onClick={() => setDismissed(true)} aria-label="关闭连接提示" title="关闭提示">×</button>
  </div>;
}
