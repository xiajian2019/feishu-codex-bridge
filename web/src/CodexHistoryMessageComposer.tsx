import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement } from "react";

import type { CodexHistoryAttachment } from "./types.js";
import { deleteCodexHistoryAttachment, uploadCodexHistoryAttachment } from "./api.js";

export interface CodexHistoryComposerResult {
  ok: boolean;
  message?: string;
}

export interface CodexHistoryMessageComposerProps {
  disabled: boolean;
  sendDisabled: boolean;
  sending: boolean;
  cancelling: boolean;
  placeholder: string;
  onSubmit: (text: string, attachmentIds: string[]) => Promise<CodexHistoryComposerResult>;
  onInterrupt: () => void;
  onAttachmentError: (message: string) => void;
  onScrollToTop: () => void;
  onScrollToBottom: () => void;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function useFileObjectUrl(file: File | null): string {
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return previewUrl;
}

function PendingAttachment({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}): ReactElement {
  const previewUrl = useFileObjectUrl(file.type.startsWith("image/") ? file : null);
  return (
    <div className={`dashboard-composer-image${file.type.startsWith("image/") ? "" : " is-file"}`}>
      {previewUrl
        ? <img className="codex-history-attachment-preview" src={previewUrl} alt={file.name} />
        : <span className="dashboard-composer-file-name" title={file.name}>{file.name}</span>}
      <button
        className="dashboard-composer-image-remove"
        type="button"
        aria-label={`移除 ${file.name}`}
        disabled={disabled}
        onClick={onRemove}
      >×</button>
    </div>
  );
}

export function CodexHistoryMessageComposer({
  disabled,
  sendDisabled,
  sending,
  cancelling,
  placeholder,
  onSubmit,
  onInterrupt,
  onAttachmentError,
  onScrollToTop,
  onScrollToBottom,
}: CodexHistoryMessageComposerProps): ReactElement {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [preparing, setPreparing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const controlsDisabled = disabled || preparing;
  const submitDisabled = controlsDisabled || sendDisabled || sending || cancelling;

  const addFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selected.length === 0) return;
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      onAttachmentError(`“${oversized.name}”超过 25 MiB，无法添加。`);
      return;
    }
    setFiles((current) => {
      const additions = selected.filter((file) => !current.some((item) => sameFile(item, file)));
      if (current.length + additions.length > MAX_ATTACHMENTS) {
        onAttachmentError(`一次最多选择 ${MAX_ATTACHMENTS} 个文件。`);
        return current;
      }
      return [...current, ...additions];
    });
  };

  const send = async (): Promise<void> => {
    if (submitDisabled || (!text.trim() && files.length === 0)) return;
    setPreparing(true);
    const staged: CodexHistoryAttachment[] = [];
    try {
      for (const file of files) {
        const uploaded = await uploadCodexHistoryAttachment(file);
        staged.push(uploaded);
      }
      const result = await onSubmit(text.trim(), staged.map((item) => item.attachmentId));
      if (!result.ok) {
        await Promise.all(staged.map(({ attachmentId }) => deleteCodexHistoryAttachment(attachmentId).catch(() => undefined)));
        if (result.message) onAttachmentError(result.message);
        return;
      }
      setText("");
      setFiles([]);
      if (textAreaRef.current) textAreaRef.current.style.height = "";
    } catch (error) {
      await Promise.all(staged.map(({ attachmentId }) => deleteCodexHistoryAttachment(attachmentId).catch(() => undefined)));
      onAttachmentError(error instanceof Error ? error.message : "附件上传失败。");
    } finally {
      setPreparing(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <form
      className="dashboard-composer codex-history-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <input
        ref={fileInputRef}
        className="codex-history-file-input"
        type="file"
        multiple
        accept="image/*,*/*"
        onChange={addFiles}
        aria-label="选择图片或文件"
      />
      <div className="dashboard-composer-images" aria-label="待发送附件">
        {files.map((file, index) => (
          <PendingAttachment
            key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
            file={file}
            disabled={controlsDisabled}
            onRemove={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
          />
        ))}
      </div>
      <textarea
        ref={textAreaRef}
        className="dashboard-composer-input"
        aria-label="发送消息到 Codex session"
        placeholder={placeholder}
        maxLength={8_000}
        rows={2}
        value={text}
        disabled={controlsDisabled}
        enterKeyHint="send"
        onChange={(event) => {
          setText(event.currentTarget.value);
          event.currentTarget.style.height = "auto";
          event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 160)}px`;
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="dashboard-composer-actions">
        <div className="dashboard-composer-keybar" role="toolbar" aria-label="Codex 历史会话操作">
          <button
            className="dashboard-keybar-button is-attachment"
            type="button"
            aria-label="选择图片或文件"
            title="选择图片或文件"
            disabled={controlsDisabled}
            onClick={() => fileInputRef.current?.click()}
          >＋</button>
          <button
            className="dashboard-keybar-button is-icon is-scroll-jump"
            type="button"
            aria-label="移动到顶部"
            title="移动到顶部"
            disabled={controlsDisabled}
            onClick={onScrollToTop}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M12 19V8m0 0-5 5m5-5 5 5" /></svg>
          </button>
          <button
            className="dashboard-keybar-button is-icon is-scroll-jump"
            type="button"
            aria-label="移动到最底部"
            title="移动到最底部"
            disabled={controlsDisabled}
            onClick={onScrollToBottom}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h14M12 5v11m0 0 5-5m-5 5-5-5" /></svg>
          </button>
        </div>
        {sending || cancelling ? (
          <button
            className="codex-interrupt-button"
            type="button"
            disabled={cancelling}
            aria-label={cancelling ? "正在中断 Codex 执行" : "中断 Codex 执行"}
            onClick={onInterrupt}
          >{cancelling ? "中断中…" : "中断"}</button>
        ) : (
          <button
            className="dashboard-compose-send"
            type="submit"
            disabled={submitDisabled || (!text.trim() && files.length === 0)}
            aria-label={preparing ? "正在发送到 Codex" : "发送到 Codex"}
          >
            <span className="dashboard-send-label">{preparing ? "发送中…" : "发送"}</span>
            <span aria-hidden="true">↑</span>
          </button>
        )}
      </div>
    </form>
  );
}

function sameFile(left: File, right: File): boolean {
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
}
