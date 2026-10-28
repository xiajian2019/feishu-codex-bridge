import { useRef, useState, type ReactElement } from "react";
import { useUploadManager, type GlobalUploadTask } from "./upload-manager.js";
import "./downloads-upload.css";

export function DownloadsUpload({ embedded = false }: { embedded?: boolean }): ReactElement {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { tasks: items, addFiles, startPending: start, cancel, remove, clearFinished, copyPath, copiedTaskId: copied, copyError } = useUploadManager();
  const busy = items.some((item) => ["preparing", "creating", "reading", "uploading", "confirming", "saving"].includes(item.state));
  const pendingCount = items.filter((item) => ["queued", "error", "cancelled"].includes(item.state)).length;
  const saving = items.some((item) => item.state === "saving");

  const Container = embedded ? "section" : "main";
  return <Container className={embedded ? "downloads-upload-panel" : "downloads-upload-page"}>
    {!embedded && <header className="downloads-upload-header"><h1>文件上传</h1><span>保存到 Mac · ~/Downloads</span></header>}
    <section className={`downloads-upload-card${dragging ? " is-dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
      <div className="downloads-upload-toolbar">
        <input ref={input} type="file" multiple hidden aria-label="选择上传文件" disabled={busy}
          onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>选择文件</button>
        <button type="button" className="primary" onClick={() => void start()} disabled={busy || !pendingCount}>
          {busy ? "上传中…" : "开始上传"}
        </button>
        {busy ? <button type="button" onClick={cancel} disabled={saving}>取消上传</button> : null}
        {!busy && items.length ? <button type="button" onClick={clearFinished}>清空已完成</button> : null}
      </div>
      <p className="downloads-upload-note">支持拖放和多选，文件大小不限。同名文件自动加序号。</p>
      {!items.length ? <div className="downloads-upload-empty">将文件拖到这里，或点击“选择文件”</div> :
        <ul className="downloads-upload-list" aria-label="上传文件列表">{items.map((item) => <li key={item.id} className="downloads-upload-item">
          <div className="downloads-upload-file"><strong title={item.file.name}>{item.file.name}</strong><span>{fileSize(item.file.size)}</span></div>
          <div className="downloads-upload-state" aria-live="polite">
            <span className={item.state === "error" ? "is-error" : undefined}>{stateText(item)}</span>
            {item.result ? <button type="button" onClick={() => void copyPath(item)}>{copied === item.id ? "已复制" : "复制文件路径"}</button> : null}
            {!busy && item.state !== "done" ? <button type="button" aria-label={`移除 ${item.file.name}`} onClick={() => remove(item.id)}>移除</button> : null}
          </div>
          {["preparing", "creating", "reading", "uploading", "confirming", "saving"].includes(item.state) ? <progress max={item.file.size || 1} value={item.sent}
            aria-label={`${item.file.name} 上传进度`} /> : null}
          {item.result ? <code className="downloads-upload-path">{item.result.filePath}</code> : null}
          {item.error ? <p className="downloads-upload-error" role="alert">{item.error}</p> : null}
        </li>)}</ul>}
      {copyError ? <p className="downloads-upload-error" role="alert">{copyError}</p> : null}
    </section>
  </Container>;
}

function stateText(item: GlobalUploadTask): string {
  if (item.state === "uploading") return `${fileSize(item.sent)} / ${fileSize(item.file.size)} · ${item.file.size ? Math.floor(item.sent / item.file.size * 100) : 0}%`;
  return { queued: "待上传", preparing: "正在连接 Mac…", creating: "正在准备保存位置…", reading: "正在读取文件…",
    confirming: "Mac 正在写入…", saving: "正在保存…", done: "上传完成", error: "上传失败", cancelled: "已取消" }[item.state];
}
function fileSize(size: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${unit ? size.toFixed(1) : size} ${units[unit]}`;
}
