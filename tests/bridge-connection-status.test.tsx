import { afterEach, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BridgeConnectionStatus } from "../web/src/BridgeConnectionStatus.js";
import { markBridgeCacheFallback, markBridgeRequestFailure, markBridgeRequestStart, markBridgeRequestSuccess } from "../web/src/connection-state.js";

afterEach(() => markBridgeRequestSuccess());

it("describes unfinished requests and cached data without claiming a VPN or recovered connection", () => {
  markBridgeRequestSuccess();
  markBridgeRequestFailure(new TypeError("fixture network delay"));
  let html = renderToStaticMarkup(<BridgeConnectionStatus />);
  expect(html).toContain("Bridge 请求暂未完成");
  expect(html).toContain("网络较慢");
  expect(html).not.toContain("VPN");
  expect(html).not.toContain("不可达");

  markBridgeCacheFallback();
  html = renderToStaticMarkup(<BridgeConnectionStatus />);
  expect(html).toContain("当前显示的是最近数据");
  expect(html).not.toContain("连接已恢复");

  markBridgeRequestStart();
  html = renderToStaticMarkup(<BridgeConnectionStatus />);
  expect(html).toContain("正在连接 Bridge");
  expect(html).toContain("is-checking");

  markBridgeRequestFailure(new Error("fixture unauthorized"), 401);
  html = renderToStaticMarkup(<BridgeConnectionStatus />);
  expect(html).toContain("Bridge 请求被拒绝");
  expect(html).toContain("is-unreachable");
});
