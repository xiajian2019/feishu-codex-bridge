import { Link } from "react-router";
import { Workbench } from "./Workbench.js";
import { isMobileApp } from "./mobile-runtime.js";

export function MobileInboxPage() {
  return <main className="page-main"><header className="workbench-page-header"><div><h1>待处理中心</h1><p>复用原任务与 History 的真实请求，响应仍回到原执行轮次。</p></div>{isMobileApp() ? <Link to="/mobile-shares">分享收件箱</Link> : null}</header>
    <p className="workbench-settings-note">本批支持 App 前台发现变化后的系统通知。锁屏、后台或退出后的即时推送尚未配置；回前台会重新读取。</p>
    <Workbench initialPanel="actions" />
  </main>;
}
