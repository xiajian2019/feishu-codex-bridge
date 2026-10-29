import { type KeyboardEvent, type ReactElement } from "react";
import { useSearchParams } from "react-router";
import { DownloadsUpload } from "./DownloadsUpload.js";
import { LinkTools } from "./LinkTools.js";
import { BackendFeatureGate } from "./BackendFeatureGate.js";
import "./upload-downloads.css";

type TransferTab = "upload" | "download";
const TABS: Array<{ id: TransferTab; label: string }> = [
  { id: "upload", label: "上传文件" },
  { id: "download", label: "链接下载" },
];

export function UploadDownloads(): ReactElement {
  const [params, setParams] = useSearchParams();
  const selected: TransferTab = params.get("tab") === "download" ? "download" : "upload";
  const select = (tab: TransferTab): void => {
    const next = new URLSearchParams(params);
    if (tab === "upload") next.delete("tab");
    else next.set("tab", tab);
    setParams(next, { replace: true });
  };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: TransferTab = event.key === "Home" ? "upload" : event.key === "End" ? "download"
      : selected === "upload" ? "download" : "upload";
    select(next);
    document.getElementById(`transfer-tab-${next}`)?.focus();
  };

  return <main className="upload-downloads-page">
    <header className="upload-downloads-header">
      <h1>上传下载</h1>
      <span>保存到 Mac · ~/Downloads</span>
    </header>
    <div className="upload-downloads-tabs" role="tablist" aria-label="上传下载功能">
      {TABS.map((tab) => <button key={tab.id} id={`transfer-tab-${tab.id}`} type="button" role="tab"
        aria-selected={selected === tab.id} aria-controls={`transfer-panel-${tab.id}`}
        tabIndex={selected === tab.id ? 0 : -1} onClick={() => select(tab.id)} onKeyDown={navigateTabs}>
        {tab.label}
      </button>)}
    </div>
    {/* Keep both mounted: switching tools must not abort uploads or discard results. */}
    <section id="transfer-panel-upload" role="tabpanel" aria-labelledby="transfer-tab-upload" hidden={selected !== "upload"}>
      <BackendFeatureGate feature="download-uploads"><DownloadsUpload embedded /></BackendFeatureGate>
    </section>
    <section id="transfer-panel-download" role="tabpanel" aria-labelledby="transfer-tab-download" hidden={selected !== "download"}>
      <LinkTools embedded />
    </section>
  </main>;
}
