import { useEffect, useRef, useState, type ReactElement } from "react";

import { useBridgeConnection } from "./connection-state.js";
import "./connection-status.css";

export function BridgeConnectionStatus(): ReactElement | null {
  const connection = useBridgeConnection();
  const statusKey = [connection.browserOnline, connection.api, connection.failureKind, connection.target].join(":");
  const lastStatusKeyRef = useRef<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (lastStatusKeyRef.current === statusKey) return;
    lastStatusKeyRef.current = statusKey;
    setDismissed(false);
  }, [statusKey]);
  if (connection.browserOnline && (connection.api === "connected" || connection.api === "unknown") && !connection.lastError) return null;
  if (dismissed) return null;

  const offline = !connection.browserOnline;
  const stale = connection.api === "stale";
  const title = offline ? "设备报告当前离线"
    : connection.failureKind === "target-unreachable" ? "主机探测暂未收到响应"
    : connection.failureKind === "api-auth-failed" ? "Bridge 请求被拒绝"
    : connection.failureKind === "api-response-error" ? "Bridge 请求返回错误"
    : stale ? "当前显示的是最近数据"
    : connection.api === "checking" ? "正在连接 Bridge…" : "Bridge 请求暂未完成";
  const detail = offline
    ? "请检查设备网络；网络恢复后会尝试重新连接。"
    : connection.failureKind === "target-unreachable"
      ? "可能是网络较慢或主机暂时繁忙，可以稍后重试。"
    : connection.failureKind === "api-auth-failed"
      ? "此次请求未获授权，请检查设备授权或相关权限。"
    : connection.failureKind === "api-response-error"
      ? "服务或网关返回了错误，可以稍后重试。"
    : stale
      ? "最新请求未完成，页面会保留最近的数据。"
      : connection.api === "checking" || connection.pending > 0
        ? "正在等待连接或服务响应，当前页面内容会保留。"
        : "可能是网络较慢或服务暂时繁忙，可以稍后重试。";
  const responseFailure = connection.failureKind === "api-auth-failed" || connection.failureKind === "api-response-error";
  const tone = offline ? "is-offline" : responseFailure ? "is-unreachable" : stale ? "is-stale" : "is-checking";
  return <div className={`bridge-connection-banner ${tone}`} role="status" aria-live="polite">
    <span className="bridge-connection-dot" aria-hidden="true" />
    <span className="bridge-connection-copy"><strong>{title}</strong><small>{detail}</small></span>
    {connection.lastSuccessAt && stale ? <time dateTime={new Date(connection.lastSuccessAt).toISOString()}>最近同步 {new Date(connection.lastSuccessAt).toLocaleTimeString("zh-CN", { hour12: false })}</time> : null}
    <button className="bridge-connection-dismiss" type="button" onClick={() => setDismissed(true)} aria-label="关闭连接提示" title="关闭提示">×</button>
  </div>;
}
