import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  useAui,
  useLocalRuntime,
  type AssistantRuntime,
  type AttachmentAdapter,
  type ChatModelAdapter,
  type ThreadUserMessage,
} from "@assistant-ui/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  loadShortcutStore,
  saveShortcutStore,
  type ShortcutCategory,
  type ShortcutStore,
  type TerminalShortcut,
} from "./tmux-shortcuts.js";
import {
  clearDraftAttachments,
  clearDraftMetadata,
  loadDraftAttachment,
  loadDraftMetadata,
  saveDraftAttachment,
  saveDraftMetadata,
  type DraftAttachment,
} from "./tmux-draft-store.js";

const TmuxShortcutPalette = lazy(() => import("./TmuxShortcutPalette.js").then((module) => ({ default: module.TmuxShortcutPalette })));

const API_ROOT = "/tmux-dashboard/api";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type ComposerSubmissionResult = { ok: boolean; message?: string };
export type { TerminalShortcut };

type TmuxMessageComposerProps = {
  sessionId: string | null;
  diagnosticSessionActive: boolean;
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  onSubmit: (text: string) => Promise<ComposerSubmissionResult>;
  onAttachmentError: (message: string) => void;
  onTerminalShortcut: (shortcut: TerminalShortcut) => Promise<void>;
  onTerminalSequence: (sequence: string) => Promise<void>;
  onScrollToTop: () => void;
  onScrollToBottom: () => void;
  onExportScrollDiagnostics: () => void;
};

async function uploadAttachment(file: File): Promise<string> {
  const response = await fetch(API_ROOT + "/attachments", {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json() as { path?: string; error?: string };
  if (!response.ok || typeof payload.path !== "string") {
    throw new Error(payload.error || "Attachment upload failed (" + response.status + ").");
  }
  return payload.path;
}

function escapePromptAttribute(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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

function ImagePreview({ file, onOpen }: { file: File; onOpen: (file: File) => void }): ReactElement {
  const previewUrl = useFileObjectUrl(file);
  return (
    <button
      className="dashboard-composer-image-preview"
      type="button"
      aria-label={"Preview " + file.name}
      title="点击放大预览"
      onClick={() => onOpen(file)}
    >
      {previewUrl ? <img src={previewUrl} alt={file.name} /> : <span>IMG</span>}
    </button>
  );
}

function ImageLightbox({ file, onClose }: { file: File; onClose: () => void }): ReactElement {
  const previewUrl = useFileObjectUrl(file);
  return (
    <div
      className="dashboard-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={"Preview " + file.name}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dashboard-image-lightbox-content">
        <button className="dashboard-image-lightbox-close" type="button" aria-label="关闭图片预览" onClick={onClose}>×</button>
        {previewUrl ? <img src={previewUrl} alt={file.name} /> : <span>图片加载中…</span>}
      </div>
    </div>
  );
}

type ComposerFieldsProps = TmuxMessageComposerProps & {
  preparing: boolean;
  onSendStart: () => void;
};

function ComposerFields({ diagnosticSessionActive, disabled, sending, placeholder, preparing, onSendStart, onSubmit, onTerminalShortcut, onTerminalSequence, onScrollToTop, onScrollToBottom, onExportScrollDiagnostics }: ComposerFieldsProps): ReactElement {
  const aui = useAui();
  const controlsDisabled = disabled || sending || preparing;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutCategory, setShortcutCategory] = useState<ShortcutCategory>("favorites");
  const [shortcutStore, setShortcutStore] = useState<ShortcutStore>(() => loadShortcutStore());
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const diagnosticActiveRef = useRef(diagnosticSessionActive);
  diagnosticActiveRef.current = diagnosticSessionActive;

  useEffect(() => {
    const form = composerFormRef.current;
    const workspace = form?.parentElement;
    const terminalFrame = workspace?.querySelector<HTMLElement>(".dashboard-terminal-frame");
    const viewport = window.visualViewport;
    if (!form || !workspace || !terminalFrame || !viewport || !window.matchMedia("(max-width: 760px)").matches) return;

    // Keep snapshots as JSON strings: Safari/vConsole must not show later object values.
    // Never record draft text, attachments, session IDs, or other user content.
    const debugWindow = window as typeof window & { __tmuxKeyboardLog?: string[]; __tmuxKeyboardPaused?: boolean };
    const debugLog = debugWindow.__tmuxKeyboardLog ??= [];
    const instance = Math.round(performance.now());
    let recording = false;
    let focusCycle = 0;
    let sequence = 0;
    let animationFrame = 0;
    let settleTimer = 0;
    const focusTimers = new Set<number>();
    const rectSnapshot = (element: HTMLElement): object => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width };
    };
    const logViewport = (event: string, detail: object = {}): void => {
      if (!import.meta.env.DEV || !recording || !diagnosticActiveRef.current || debugWindow.__tmuxKeyboardPaused) return;
      const rect = form.getBoundingClientRect();
      const style = getComputedStyle(form);
      const snapshot = JSON.stringify({
        layoutVersion: "viewport-shell-v1",
        instance, sequence: ++sequence, focusCycle, event,
        ms: Math.round(performance.now()),
        focused: form.contains(document.activeElement),
        activeTag: document.activeElement?.tagName,
        visibility: document.visibilityState,
        window: { innerHeight: window.innerHeight, innerWidth: window.innerWidth, scrollY: window.scrollY },
        document: {
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
          scrollTop: document.documentElement.scrollTop,
          bodyScrollTop: document.body.scrollTop,
        },
        visual: {
          height: viewport.height, width: viewport.width,
          offsetTop: viewport.offsetTop, pageTop: viewport.pageTop, scale: viewport.scale,
        },
        viewportShell: {
          active: document.documentElement.classList.contains("tmux-mobile-viewport"),
          height: document.documentElement.style.getPropertyValue("--tmux-viewport-height"),
          top: document.documentElement.style.getPropertyValue("--tmux-viewport-top"),
          rect: rectSnapshot(document.getElementById("root")!),
        },
        composer: {
          ...rectSnapshot(form), position: style.position, rectBottom: rect.bottom,
          cssBottom: style.bottom,
          inputFontSize: getComputedStyle(form.querySelector("textarea") ?? form).fontSize,
        },
        terminal: {
          ...rectSnapshot(terminalFrame), flex: terminalFrame.style.flex,
          marginBottom: getComputedStyle(terminalFrame).marginBottom,
        },
        workspace: rectSnapshot(workspace),
        shellBottomMinusComposerBottom: document.getElementById("root")!.getBoundingClientRect().bottom - rect.bottom,
        pageScrollMinusViewportTop: window.scrollY - viewport.offsetTop,
        ...detail,
      });
      debugLog.push(snapshot);
      if (debugLog.length > 300) debugLog.splice(0, debugLog.length - 300);
      console.info("[tmux-keyboard] " + snapshot);
    };
    const scheduleSamples = (source: string): void => {
      if (!recording || !diagnosticActiveRef.current || debugWindow.__tmuxKeyboardPaused) return;
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(settleTimer);
      animationFrame = window.requestAnimationFrame(() => logViewport(source + ":raf"));
      settleTimer = window.setTimeout(() => logViewport(source + ":settled-300ms"), 300);
    };
    const sampleViewport = (source: string): void => {
      logViewport(source);
      scheduleSamples(source);
    };
    const onVisualResize = (): void => sampleViewport("visual.resize");
    const onVisualScroll = (): void => sampleViewport("visual.scroll");
    const onWindowResize = (): void => sampleViewport("window.resize");
    const onWindowScroll = (): void => sampleViewport("window.scroll");
    const startRecording = (event: Event): void => {
      if (!import.meta.env.DEV || !diagnosticActiveRef.current || !(event.target instanceof HTMLTextAreaElement) || event.target.disabled) return;
      if (!recording) {
        debugLog.length = 0;
        recording = true;
        sequence = 0;
      }
      debugWindow.__tmuxKeyboardPaused = false;
      logViewport(event.type + ":capture-start");
    };
    const onFocus = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      if (event.type === "focusin") {
        focusCycle++;
        startRecording(event);
      }
      if (!recording || !diagnosticActiveRef.current || debugWindow.__tmuxKeyboardPaused) return;
      logViewport(event.type);
      // Capture even if WebKit does not dispatch a final viewport event.
      for (const delay of [100, 350, 700]) {
        const timer = window.setTimeout(() => {
          focusTimers.delete(timer);
          logViewport(event.type + ":" + delay + "ms");
        }, delay);
        focusTimers.add(timer);
      }
    };
    const resizeObserver = new ResizeObserver(() => sampleViewport("composer.resize"));
    const terminalObserver = new ResizeObserver(() => logViewport("terminal.resize"));
    resizeObserver.observe(form);
    terminalObserver.observe(terminalFrame);
    viewport.addEventListener("resize", onVisualResize);
    viewport.addEventListener("scroll", onVisualScroll);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    form.addEventListener("pointerdown", startRecording);
    form.addEventListener("focusin", onFocus);
    form.addEventListener("focusout", onFocus);
    sampleViewport("mount");

    return () => {
      logViewport("unmount");
      resizeObserver.disconnect();
      terminalObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(settleTimer);
      focusTimers.forEach((timer) => window.clearTimeout(timer));
      viewport.removeEventListener("resize", onVisualResize);
      viewport.removeEventListener("scroll", onVisualScroll);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowScroll);
      form.removeEventListener("pointerdown", startRecording);
      form.removeEventListener("focusin", onFocus);
      form.removeEventListener("focusout", onFocus);
    };
  }, []);

  useEffect(() => {
    if (!shortcutsOpen || !composerFormRef.current) {
      document.documentElement.style.removeProperty("--dashboard-shortcut-bottom");
      document.documentElement.style.removeProperty("--dashboard-shortcut-max-height");
      return;
    }

    const updateBottomOffset = (): void => {
      const rect = composerFormRef.current?.getBoundingClientRect();
      if (!rect) return;
      document.documentElement.style.setProperty(
        "--dashboard-shortcut-bottom",
        Math.max(0, document.documentElement.clientHeight - rect.top + 8) + "px",
      );
      document.documentElement.style.setProperty(
        "--dashboard-shortcut-max-height",
        Math.max(0, rect.top - (window.visualViewport?.offsetTop ?? 0) - 16) + "px",
      );
    };
    const observer = new ResizeObserver(updateBottomOffset);
    observer.observe(composerFormRef.current);
    window.addEventListener("resize", updateBottomOffset);
    window.visualViewport?.addEventListener("resize", updateBottomOffset);
    window.visualViewport?.addEventListener("scroll", updateBottomOffset);
    updateBottomOffset();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBottomOffset);
      window.visualViewport?.removeEventListener("resize", updateBottomOffset);
      window.visualViewport?.removeEventListener("scroll", updateBottomOffset);
      document.documentElement.style.removeProperty("--dashboard-shortcut-bottom");
      document.documentElement.style.removeProperty("--dashboard-shortcut-max-height");
    };
  }, [shortcutsOpen]);

  useEffect(() => {
    saveShortcutStore(shortcutStore);
  }, [shortcutStore]);

  const openShortcutPalette = (category: ShortcutCategory): void => {
    if (shortcutsOpen && shortcutCategory === category) {
      setShortcutsOpen(false);
      return;
    }
    setShortcutCategory(category);
    setShortcutsOpen(true);
  };

  return (
    <>
      <ComposerPrimitive.Root
        className="dashboard-composer"
        ref={composerFormRef}
        onSubmit={() => {
          if (aui.composer.getState().isEmpty) return;
          setShortcutsOpen(false);
          onSendStart();
        }}
      >
        <div className="dashboard-composer-images" aria-label="Attachments to send">
          <ComposerPrimitive.Attachments>
            {({ attachment }) => (
              <AttachmentPrimitive.Root
                className={"dashboard-composer-image" + (attachment.file?.type.startsWith("image/") ? "" : " is-file")}
                key={attachment.id}
              >
                {attachment.file?.type.startsWith("image/")
                  ? <ImagePreview file={attachment.file} onOpen={setPreviewFile} />
                  : <span className="dashboard-composer-file-name" title={attachment.name}>{attachment.name}</span>}
                <AttachmentPrimitive.Remove
                  className="dashboard-composer-image-remove"
                  type="button"
                  aria-label={"Remove " + attachment.name}
                  disabled={controlsDisabled}
                >×</AttachmentPrimitive.Remove>
              </AttachmentPrimitive.Root>
            )}
          </ComposerPrimitive.Attachments>
        </div>
        <ComposerPrimitive.Input
          className="dashboard-composer-input"
          aria-label="Message the Codex session"
          placeholder={placeholder}
          maxLength={8_000}
          minRows={2}
          maxRows={6}
          disabled={controlsDisabled}
          submitMode="enter"
          unstable_insertNewlineOnTouchEnter
          unstable_focusOnRunStart={false}
          unstable_focusOnScrollToBottom={false}
          unstable_focusOnThreadSwitched={false}
        />
        <div className="dashboard-composer-actions">
          <div className="dashboard-composer-keybar" role="toolbar" aria-label="Quick terminal keys">
            {shortcutsOpen ? (
              <>
                <button className="dashboard-keybar-button is-close" type="button" title="关闭快捷栏" aria-label="关闭快捷栏" disabled={controlsDisabled} onClick={() => setShortcutsOpen(false)}>×</button>
                <button className="dashboard-keybar-button is-icon is-scroll-jump" type="button" aria-label="Scroll terminal to top" disabled={controlsDisabled} onClick={onScrollToTop}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M12 19V8m0 0-5 5m5-5 5 5" /></svg>
                </button>
                <button className="dashboard-keybar-button is-icon is-scroll-jump" type="button" aria-label="Scroll terminal to bottom" disabled={controlsDisabled} onClick={onScrollToBottom}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h14M12 5v11m0 0 5-5m-5 5-5-5" /></svg>
                </button>
                <button className="dashboard-keybar-button is-icon is-scroll-export" type="button" aria-label="Download scroll diagnostics" disabled={controlsDisabled} onClick={onExportScrollDiagnostics}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 15v4h14v-4" /></svg>
                </button>
                <button className="dashboard-keybar-button" type="button" title="Escape" aria-label="Escape" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-escape")}>Esc</button>
                <button className="dashboard-keybar-button is-icon" type="button" title="上一条输入" aria-label="上一条输入" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-up")}>↑</button>
                <button className="dashboard-keybar-button is-icon" type="button" title="下一条输入" aria-label="下一条输入" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-down")}>↓</button>
                <button className="dashboard-keybar-button is-icon" type="button" title="回车" aria-label="回车" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-enter")}>↵</button>
                <button className="dashboard-keybar-button" type="button" title="Ctrl 快捷键" aria-label="Ctrl 快捷键" disabled={controlsDisabled} onClick={() => openShortcutPalette("ctrl")}>⌃</button>
              </>
            ) : (
              <>
                <ComposerPrimitive.AddAttachment className="dashboard-keybar-button is-attachment" type="button" multiple disabled={controlsDisabled}>＋</ComposerPrimitive.AddAttachment>
                <button className="dashboard-keybar-button is-icon is-scroll-jump" type="button" aria-label="Scroll terminal to top" disabled={controlsDisabled} onClick={onScrollToTop}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M12 19V8m0 0-5 5m5-5 5 5" /></svg>
                </button>
                <button className="dashboard-keybar-button is-icon is-scroll-jump" type="button" aria-label="Scroll terminal to bottom" disabled={controlsDisabled} onClick={onScrollToBottom}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h14M12 5v11m0 0 5-5m-5 5-5-5" /></svg>
                </button>
                <button className="dashboard-keybar-button is-icon is-scroll-export" type="button" aria-label="Download scroll diagnostics" disabled={controlsDisabled} onClick={onExportScrollDiagnostics}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 15v4h14v-4" /></svg>
                </button>
                <button className="dashboard-keybar-button" type="button" title="Escape" aria-label="Escape" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-escape")}>Esc</button>
                <button className="dashboard-keybar-button" type="button" title="Tab" aria-label="Tab" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-tab")}>Tab</button>
                <button className="dashboard-keybar-button is-icon" type="button" title="上一条输入" aria-label="上一条输入" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-up")}>↑</button>
                <button className="dashboard-keybar-button is-icon" type="button" title="下一条输入" aria-label="下一条输入" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-down")}>↓</button>
                <button className="dashboard-keybar-button is-icon" type="button" title="回车" aria-label="回车" disabled={controlsDisabled} onClick={() => void onTerminalShortcut("codex-enter")}>↵</button>
                <button className="dashboard-keybar-button is-keyboard" type="button" title="打开键盘面板" aria-label="打开键盘面板" aria-expanded={shortcutsOpen} disabled={controlsDisabled} onClick={() => openShortcutPalette("keyboard")}>⌨</button>
              </>
            )}
          </div>
          <ComposerPrimitive.Send
            className="dashboard-compose-send"
            type="button"
            disabled={controlsDisabled}
            aria-label={sending || preparing ? "正在发送" : "发送消息"}
          ><span className="dashboard-send-label">{sending || preparing ? "发送中…" : "发送"}</span><span aria-hidden="true">↑</span></ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
      {previewFile ? <ImageLightbox file={previewFile} onClose={() => setPreviewFile(null)} /> : null}
      <Suspense fallback={null}>
        <TmuxShortcutPalette
          open={shortcutsOpen}
          category={shortcutCategory}
          onOpenChange={setShortcutsOpen}
          onCategoryChange={setShortcutCategory}
          store={shortcutStore}
          onStoreChange={(nextStore) => {
            setShortcutStore(nextStore);
            if (nextStore.disabledPanels.includes(shortcutCategory)) {
              setShortcutCategory(nextStore.panelOrder.find((id) => !nextStore.disabledPanels.includes(id)) ?? "favorites");
            }
          }}
          onSubmitText={onSubmit}
          onTerminalShortcut={onTerminalShortcut}
          onTerminalSequence={onTerminalSequence}
        />
      </Suspense>
    </>
  );
}

export function TmuxMessageComposer(props: TmuxMessageComposerProps): ReactElement {
  const [preparing, setPreparing] = useState(false);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const submitRef = useRef(props.onSubmit);
  const attachmentErrorRef = useRef(props.onAttachmentError);
  submitRef.current = props.onSubmit;
  attachmentErrorRef.current = props.onAttachmentError;

  const attachmentAdapter = useMemo<AttachmentAdapter>(() => ({
    accept: "*",
    async add({ file }) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        const message = "Each attachment must be 10 MB or smaller.";
        attachmentErrorRef.current(message);
        throw new Error(message);
      }

      const id = ["attachment", Date.now(), Math.random()].join("-");
      if (props.sessionId) await saveDraftAttachment(props.sessionId, id, file);
      return {
        id,
        type: file.type.startsWith("image/") ? "image" : "file",
        name: file.name,
        contentType: file.type,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async remove() {},
    async send(attachment) {
      try {
        const path = await uploadAttachment(attachment.file);
        return {
          ...attachment,
          status: { type: "complete" },
          content: [{ type: "text", text: path }],
        };
      } catch (error) {
        setPreparing(false);
        attachmentErrorRef.current(error instanceof Error ? error.message : "Attachment upload failed.");
        throw error;
      }
    },
  }), [props.sessionId]);

  const chatModel = useMemo<ChatModelAdapter>(() => ({
    async run({ messages }) {
      const userMessage = [...messages].reverse().find((message): message is ThreadUserMessage => message.role === "user");
      if (!userMessage) {
        setPreparing(false);
        return { content: [] };
      }

      const messageText = userMessage.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const uploadedAttachments = userMessage.attachments.flatMap((attachment) =>
        (attachment.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => ({
            path: part.text,
            name: attachment.name,
            isImage: (attachment.contentType ?? attachment.file?.type ?? "").startsWith("image/"),
          })),
      );
      const imageAttachments = uploadedAttachments.filter((attachment) => attachment.isImage);
      const fileAttachments = uploadedAttachments.filter((attachment) => !attachment.isImage);
      const imageNote = imageAttachments.length > 0
        ? "请打开并查看我附上的图片，再结合上面的文字处理：\n" + imageAttachments
          .map((attachment, index) => `<image name=[Image #${index + 1}] path="${attachment.path}">`)
          .join("\n")
        : "";
      const fileNote = fileAttachments.length > 0
        ? "请读取我附上的文件，再结合上面的文字处理：\n" + fileAttachments
          .map((attachment) => `<file name="${escapePromptAttribute(attachment.name)}" path="${attachment.path}">`)
          .join("\n")
        : "";
      const text = [messageText, imageNote, fileNote].filter(Boolean).join("\n\n");
      let result: ComposerSubmissionResult;
      try {
        result = await submitRef.current(text);
      } finally {
        setPreparing(false);
      }

      if (result.ok && props.sessionId) {
        clearDraftMetadata(props.sessionId);
        await clearDraftAttachments(props.sessionId);
      }

      if (!result.ok) {
        const composer = runtimeRef.current?.thread.composer;
        composer?.setText(messageText);
        window.setTimeout(() => {
          for (const attachment of userMessage.attachments) {
            if (attachment.file) {
              void composer?.addAttachment(attachment.file).catch((error: unknown) => {
                attachmentErrorRef.current(error instanceof Error ? error.message : "Could not restore the image draft.");
              });
            }
          }
        }, 0);
      }

      return {
        content: [{ type: "text", text: result.ok ? "Delivered to the tmux session." : "The message was not delivered." }],
      };
    },
  }), [props.sessionId]);

  const runtime = useLocalRuntime(chatModel, { adapters: { attachments: attachmentAdapter } });
  runtimeRef.current = runtime;

  useEffect(() => {
    const sessionId = props.sessionId;
    if (!sessionId) return;
    const composer = runtime.thread.composer;
    let cancelled = false;
    let restored = false;
    let saveTimer = 0;

    const flushDraft = (): void => {
      if (!restored || cancelled) return;
      const state = composer.getState();
      const attachments: DraftAttachment[] = state.attachments
        .filter((attachment) => attachment.status.type !== "complete")
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          contentType: attachment.contentType ?? "application/octet-stream",
          size: attachment.file?.size ?? 0,
          lastModified: attachment.file?.lastModified ?? 0,
        }));
      if (!state.text && attachments.length === 0) {
        clearDraftMetadata(sessionId);
        return;
      }
      saveDraftMetadata(sessionId, { text: state.text, attachments });
    };
    const persist = (): void => {
      if (!restored || cancelled) return;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(flushDraft, 180);
    };

    const flushBeforePageHide = (): void => flushDraft();
    const flushWhenHidden = (): void => {
      if (document.visibilityState === "hidden") flushDraft();
    };

    const unsubscribe = composer.subscribe(persist);
    window.addEventListener("pagehide", flushBeforePageHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    const restore = async (): Promise<void> => {
      const draft = loadDraftMetadata(sessionId);
      if (!draft || cancelled) {
        restored = true;
        persist();
        return;
      }

      if (!composer.getState().text && draft.text) composer.setText(draft.text);
      if (composer.getState().attachments.length === 0) {
        for (const attachment of draft.attachments) {
          const file = await loadDraftAttachment(sessionId, attachment.id);
          if (cancelled || !file) continue;
          if (composer.getState().attachments.some((current) => current.name === file.name && current.file?.size === file.size)) continue;
          try {
            await composer.addAttachment(file);
          } catch (error) {
            attachmentErrorRef.current(error instanceof Error ? error.message : "Could not restore the image draft.");
          }
        }
      }
      if (!cancelled) {
        restored = true;
        persist();
      }
    };
    void restore();

    return () => {
      cancelled = true;
      window.clearTimeout(saveTimer);
      unsubscribe();
      window.removeEventListener("pagehide", flushBeforePageHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [props.sessionId, runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerFields
        {...props}
        preparing={preparing}
        onSendStart={() => {
          if (!runtime.thread.composer.getState().isEmpty) setPreparing(true);
        }}
      />
    </AssistantRuntimeProvider>
  );
}
