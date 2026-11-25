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
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

import {
  beginDebugLogCapture,
  cancelDebugLogCapture,
  finishDebugLogCapture,
  isDebugLogCaptureActive,
  isDebugLogCapturePaused,
  logDebugDiagnostic,
  subscribeDebugLogCapture,
} from "./debug-log-capture.js";
import { fetchShortcutConfig, recordShortcutUse } from "./api.js";
import { readShortcutConfigCache, subscribeShortcutConfigInvalidation } from "./shortcut-config-cache.js";
import {
  type ShortcutCategory,
  DEFAULT_COMPOSER_SHORTCUTS,
  type ShortcutDefinition,
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
import { readCodexSkillCache, writeCodexSkillCache } from "./skill-cache.js";
import { getLocalDraftScope, LOCAL_DRAFT_SCOPE_EVENT, LOCAL_DRAFT_SCOPE_WILL_CHANGE_EVENT } from "./local-draft-scope.js";
import { isMobileApp, shareMobileBlob } from "./mobile-runtime.js";
import { useMobileBack } from "./use-mobile-back.js";
import { uploadFileInChunks, type DownloadUploadPhase, type UploadMetric } from "./download-upload.js";
import { imageSwipeDirection } from "./composer-image-swipe.js";
import { ComposerTransferReceiver } from "./ComposerTransferReceiver.js";
import { appendComposerTransferText } from "./composer-transfer-text.js";
import { ComposerAssetRequestError, acknowledgeComposerAdoption, adoptComposerTransfer, composerAssetAttachment, composerAssetFromAttachment, pendingComposerAdoptions, readComposerAsset, releaseComposerAsset, resolveComposerAssets, supportsComposerAssets, touchComposerAssets, type ComposerAssetAdoption, type ComposerAssetReference } from "./composer-asset-client.js";
import { applyComposerAssetAdoption, serializeComposerDraftAttachments } from "./composer-asset-draft.js";
import { shouldAcceptComposerDraftSnapshot } from "./tmux-draft-snapshot-guard.js";
import { createComposerImeGuard } from "./composer-ime.js";

const TmuxShortcutPalette = lazy(() => import("./TmuxShortcutPalette.js").then((module) => ({ default: module.TmuxShortcutPalette })));

const API_ROOT = "/tmux-dashboard/api";
type HotDraftRecovery = { callbacks: Set<() => void>; timer: number };
const hotDraftRecovery: HotDraftRecovery = import.meta.hot?.data.hotDraftRecovery ?? { callbacks: new Set(), timer: 0 };
if (import.meta.hot) {
  const hot = import.meta.hot;
  hot.data.hotDraftRecovery = hotDraftRecovery;
  const afterUpdate = (): void => {
    window.clearTimeout(hotDraftRecovery.timer);
    hotDraftRecovery.timer = window.setTimeout(() => { for (const callback of hotDraftRecovery.callbacks) callback(); }, 250);
  };
  hot.on("vite:afterUpdate", afterUpdate);
  hot.dispose(() => hot.off("vite:afterUpdate", afterUpdate));
}

function macComposerTerminalShortcut(event: KeyboardEvent, composerEmpty: boolean): TerminalShortcut | null {
  if (
    typeof navigator === "undefined"
    || !navigator.platform.toLowerCase().startsWith("mac")
    || event.isComposing
    || event.metaKey
    || event.altKey
    || event.shiftKey
  ) return null;

  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === "c") return "codex-interrupt";
    if (!composerEmpty) return null;
    if (key === "l") return "ctrl-l";
    if (key === "r") return "ctrl-r";
    return null;
  }

  if (!composerEmpty) return null;
  switch (event.key) {
    case "Escape": return "codex-escape";
    case "ArrowUp": return "codex-up";
    case "ArrowDown": return "codex-down";
    case "Enter": return "codex-enter";
    default: return null;
  }
}

function isCodexSkillTrigger(event: KeyboardEvent): boolean {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key === "$" || (event.key === "4" && event.shiftKey);
}

type CodexSkillOption = {
  skillName: string;
  descriptionZh: string;
};

function isCodexSkillList(value: unknown): value is CodexSkillOption[] {
  return Array.isArray(value) && value.every((item) => (
    typeof item === "object"
    && item !== null
    && typeof (item as { skillName?: unknown }).skillName === "string"
    && typeof (item as { descriptionZh?: unknown }).descriptionZh === "string"
  ));
}

function filterCodexSkills(skills: CodexSkillOption[], query: string): CodexSkillOption[] {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  if (!normalized) return skills;
  return skills.filter((skill) => skill.skillName.toLocaleLowerCase("en-US").includes(normalized));
}

async function fetchSessionCodexSkills(
  sessionId: string,
  signal: AbortSignal,
): Promise<{ skills: CodexSkillOption[]; refreshing: boolean; fresh: boolean }> {
  const response = await fetch(
    API_ROOT + "/sessions/" + encodeURIComponent(sessionId) + "/skills?all=1",
    {
      headers: { Accept: "application/json" },
      signal,
    },
  );
  const payload = await response.json() as {
    skills?: unknown;
    error?: string;
    refreshing?: unknown;
    fresh?: unknown;
  };
  if (!response.ok || !isCodexSkillList(payload.skills)) {
    throw new Error(payload.error || "Could not load Codex skills.");
  }
  return {
    skills: payload.skills,
    refreshing: payload.refreshing === true,
    fresh: payload.fresh === true,
  };
}

export type ComposerSubmissionResult = { ok: boolean; message?: string };
export type { TerminalShortcut };
export type SessionFileForwardImage = { name: string; url: string };
export type SessionFileForwardRequest = { id: string; sessionId: string; text: string; images?: SessionFileForwardImage[] };

type TmuxMessageComposerProps = {
  sessionId: string | null;
  sessionCreatedAt: number | null;
  sessionFileForward: SessionFileForwardRequest | null;
  onSessionFileForwardConsumed: (requestId: string) => void;
  diagnosticSessionActive: boolean;
  disabled: boolean;
  sendDisabled: boolean;
  sending: boolean;
  placeholder: string;
  onSubmit: (text: string) => Promise<ComposerSubmissionResult>;
  onSubmitCommand: (text: string) => Promise<ComposerSubmissionResult>;
  onAttachmentError: (message: string) => void;
  onOpenFiles: () => void;
  onTerminalShortcut: (shortcut: TerminalShortcut) => Promise<ComposerSubmissionResult>;
  onTerminalSequence: (sequence: string) => Promise<ComposerSubmissionResult>;
  onScrollToTop: () => void;
  onScrollToBottom: () => void;
  onExportScrollDiagnostics: () => void;
};

type AttachmentUploadProgress = {
  bytes: number;
  total: number;
  phase: DownloadUploadPhase;
};

async function uploadAttachment(
  file: File,
  signal: AbortSignal,
  onProgress: (progress: AttachmentUploadProgress) => void,
): Promise<string> {
  let phase: DownloadUploadPhase = "preparing";
  let bytes = 0;
  const uploaded = await uploadFileInChunks(file, {
    endpoint: API_ROOT + "/attachments/uploads",
    parallel: true,
    signal,
    onPhase: (nextPhase) => {
      phase = nextPhase;
      if (phase === "saving") bytes = file.size;
      onProgress({ bytes, total: file.size, phase });
    },
    onProgress: (nextBytes, saving) => {
      bytes = nextBytes;
      onProgress({ bytes, total: file.size, phase: saving ? "saving" : phase });
    },
    onMetric: (metric: UploadMetric) => logDebugDiagnostic("tmux-upload", metric.type, metric),
  });
  return uploaded.filePath;
}

function escapePromptAttribute(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function fetchForwardImage(image: SessionFileForwardImage, signal: AbortSignal): Promise<File> {
  let url: URL;
  try {
    url = new URL(image.url, window.location.href);
  } catch {
    throw new Error("转发图片地址无效。");
  }
  const page = new URL(window.location.href);
  if (url.origin !== page.origin || !url.pathname.startsWith("/tmux-dashboard/api/attachments/images/")) {
    throw new Error("转发图片不属于当前 Bridge。");
  }
  const response = await fetch(url.pathname + url.search, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`读取转发图片失败（${response.status}）。`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("转发附件不是图片。");
  return new File([blob], image.name.trim() || "转发图片", { type: blob.type });
}

function useFileObjectUrl(file: File | null): string {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    logDebugDiagnostic("tmux-image-preview", "object-url-created", {
      contentType: file.type || "unknown",
      sizeBytes: file.size,
      sourceScheme: "blob",
    });
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return preview?.file === file ? preview.url : "";
}

function logImagePreviewResult(
  stage: "thumbnail-loaded" | "thumbnail-failed" | "lightbox-loaded" | "lightbox-failed",
  file: File,
  image: HTMLImageElement,
): void {
  logDebugDiagnostic("tmux-image-preview", stage, {
    contentType: file.type || "unknown",
    sizeBytes: file.size,
    sourceScheme: image.currentSrc.startsWith("blob:") ? "blob" : image.currentSrc.startsWith("data:") ? "data" : "other",
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    complete: image.complete,
  });
}

function ImagePreview({ file, onOpen }: { file: File; onOpen: () => void }): ReactElement {
  const previewUrl = useFileObjectUrl(file);
  return (
    <button
      className="dashboard-composer-image-preview"
      type="button"
      aria-label={"Preview " + file.name}
      title="点击放大预览"
      onClick={onOpen}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          onLoad={(event) => logImagePreviewResult("thumbnail-loaded", file, event.currentTarget)}
          onError={(event) => logImagePreviewResult("thumbnail-failed", file, event.currentTarget)}
        />
      ) : <span>IMG</span>}
    </button>
  );
}

type ComposerPreviewItem = { id: string; name: string; file?: File; asset?: ComposerAssetReference };

function RemoteImagePreview({ asset, sessionId, onOpen }: { asset: ComposerAssetReference; sessionId: string; onOpen: () => void }): ReactElement {
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setPreview(null);
    setUnavailable(false);
    const timer = window.setTimeout(() => {
      void readComposerAsset(sessionId, asset.sessionCreatedAt, asset.assetId, controller.signal, true).then((blob) => {
        if (controller.signal.aborted || !blob) return;
        url = URL.createObjectURL(blob);
        setPreview({ id: asset.assetId, url });
      }).catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [asset.assetId, asset.sessionCreatedAt, sessionId]);
  return <button className="dashboard-composer-image-preview" type="button" aria-label={"Preview " + asset.name} title={unavailable ? "图片暂不可用，点击重试" : "点击放大预览"} onClick={onOpen}>
    {preview?.id === asset.assetId ? <img src={preview.url} alt={asset.name} /> : <span>{unavailable ? "不可用" : "IMG"}</span>}
  </button>;
}

function ImageLightbox({ source, sessionId, position, total, onNavigate, onClose }: {
  source: ComposerPreviewItem;
  sessionId: string | null;
  position: number;
  total: number;
  onNavigate: (direction: -1 | 1) => void;
  onClose: () => void;
}): ReactElement {
  useMobileBack(true, onClose, 500);
  const [remoteFile, setRemoteFile] = useState<{ id: string; file: File } | null>(null);
  const [remoteError, setRemoteError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setRemoteFile(null);
    setRemoteError("");
    const timer = window.setTimeout(() => {
      if (source.asset && sessionId) {
        const asset = source.asset;
        void readComposerAsset(sessionId, asset.sessionCreatedAt, asset.assetId, controller.signal).then((blob) => {
          if (!controller.signal.aborted && blob) setRemoteFile({ id: asset.assetId, file: new File([blob], asset.name, { type: asset.contentType || blob.type }) });
        }).catch((error: unknown) => { if (!controller.signal.aborted) setRemoteError(error instanceof Error ? `图片暂不可用：${error.message}` : "图片暂不可用。"); });
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [source.id, source.asset?.assetId, source.asset?.sessionCreatedAt, sessionId]);
  const file = source.file ?? (remoteFile && source.asset && remoteFile.id === source.asset.assetId ? remoteFile.file : null);
  const previewUrl = useFileObjectUrl(file);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const touchStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const onCloseRef = useRef(onClose);
  const onNavigateRef = useRef(onNavigate);
  onCloseRef.current = onClose;
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [source.id]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeButtonRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        onNavigateRef.current(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Tab") {
        const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      className="dashboard-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={"Preview " + source.name}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {total > 1 ? <div className="dashboard-image-lightbox-navigation">
        <button type="button" aria-label="上一张图片" disabled={position === 0} onClick={() => onNavigate(-1)}>‹</button>
        <span aria-live="polite">{position + 1} / {total}</span>
        <button type="button" aria-label="下一张图片" disabled={position === total - 1} onClick={() => onNavigate(1)}>›</button>
      </div> : null}
      <button ref={closeButtonRef} className="dashboard-image-lightbox-close" type="button" aria-label="关闭图片预览" onClick={onClose}>×</button>
      <div
        ref={contentRef}
        className="dashboard-image-lightbox-content"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartRef.current = event.touches.length === 1 && touch && (window.visualViewport?.scale ?? 1) <= 1.01
            ? { id: touch.identifier, x: touch.clientX, y: touch.clientY }
            : null;
        }}
        onTouchMove={(event) => {
          if (event.touches.length !== 1) touchStartRef.current = null;
        }}
        onTouchCancel={() => { touchStartRef.current = null; }}
        onTouchEnd={(event) => {
          const start = touchStartRef.current;
          touchStartRef.current = null;
          if (!start || event.touches.length !== 0 || (window.visualViewport?.scale ?? 1) > 1.01) return;
          const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.id);
          if (!touch) return;
          const direction = imageSwipeDirection(touch.clientX - start.x, touch.clientY - start.y);
          if (direction === null) return;
          if (event.cancelable) event.preventDefault();
          onNavigate(direction);
        }}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={source.name}
            onLoad={(event) => { if (file) logImagePreviewResult("lightbox-loaded", file, event.currentTarget); }}
            onError={(event) => { if (file) logImagePreviewResult("lightbox-failed", file, event.currentTarget); }}
          />
        ) : <span>{remoteError || "图片加载中…"}</span>}
      </div>
    </div>,
    document.body,
  );
}

function downloadDebugLog(file: File): void | Promise<void> {
  if (isMobileApp()) return shareMobileBlob(file, file.name);
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type ComposerFieldsProps = TmuxMessageComposerProps & {
  preparing: boolean;
  assetResolving: boolean;
  attachmentProgress: Readonly<Record<string, AttachmentUploadProgress>>;
  onSendStart: () => void;
  onImportAssets: (adoption: ComposerAssetAdoption) => Promise<void>;
  onDraftUserAction: () => void;
};

function ComposerFields({ sessionId, sessionCreatedAt, diagnosticSessionActive, disabled, sendDisabled, sending, placeholder, preparing, assetResolving, attachmentProgress, onSendStart, onSubmit, onSubmitCommand, onAttachmentError, onOpenFiles, onTerminalShortcut, onTerminalSequence, onScrollToTop, onScrollToBottom, onExportScrollDiagnostics, onImportAssets, onDraftUserAction }: ComposerFieldsProps): ReactElement {
  const aui = useAui();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutCategory, setShortcutCategory] = useState<ShortcutCategory>("favorites");
  const [shortcutStore, setShortcutStore] = useState<ShortcutStore>(() => readShortcutConfigCache() ?? { groups: [], shortcuts: [] });
  const [preview, setPreview] = useState<{ items: ComposerPreviewItem[]; position: number } | null>(null);
  const [phoneTransferOpen, setPhoneTransferOpen] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [addingDroppedFiles, setAddingDroppedFiles] = useState(false);
  useEffect(() => setPreview(null), [sessionId]);
  const [codexSkills, setCodexSkills] = useState<CodexSkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsLoadError, setSkillsLoadError] = useState<string | null>(null);
  const [skillsPickerOpen, setSkillsPickerOpen] = useState(false);
  useMobileBack(skillsPickerOpen, () => setSkillsPickerOpen(false), 45);
  useMobileBack(shortcutsOpen, () => setShortcutsOpen(false), 61);
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const skillsRequestRef = useRef<AbortController | null>(null);
  const skillsRequestSequenceRef = useRef(0);
  const skillsRefreshTimerRef = useRef<number | null>(null);
  const skillsSearchTimerRef = useRef<number | null>(null);
  const [debugLogActive, setDebugLogActive] = useState(() => isDebugLogCaptureActive());
  const [debugLogBusy, setDebugLogBusy] = useState(false);
  const inputDisabled = disabled || sending || preparing || debugLogBusy;
  const controlsDisabled = disabled || sendDisabled || sending || preparing || debugLogBusy || addingDroppedFiles;
  const debugLogControlsDisabled = sending || preparing || debugLogBusy || (disabled && !debugLogActive);
  useEffect(() => {
    if (controlsDisabled) setDraggingFiles(false);
  }, [controlsDisabled]);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const imeGuard = useRef(createComposerImeGuard()).current;
  const skillButtonRef = useRef<HTMLButtonElement | null>(null);
  const skillSearchRef = useRef<HTMLInputElement | null>(null);
  const skillPickerRef = useRef<HTMLDivElement | null>(null);
  const inputSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const skillTriggerRangeRef = useRef<{ start: number; end: number } | null>(null);
  const diagnosticActiveRef = useRef(diagnosticSessionActive);
  diagnosticActiveRef.current = diagnosticSessionActive;
  const composerShortcuts = useMemo(() => {
    const hasComposerGroup = shortcutStore.groups.some((group) => group.surface === "composer");
    const composerGroupIds = new Set(shortcutStore.groups
      .filter((group) => group.surface === "composer" && group.enabled)
      .map((group) => group.id));
    const hasServerConfig = hasComposerGroup;
    const source = hasServerConfig
      ? shortcutStore.shortcuts.filter((shortcut) => composerGroupIds.has(shortcut.groupId))
      : [...DEFAULT_COMPOSER_SHORTCUTS];
    return source.filter((shortcut) => shortcut.enabled).sort((left, right) => left.sortOrder - right.sortOrder);
  }, [shortcutStore]);

  const filteredCodexSkills = useMemo(
    () => filterCodexSkills(codexSkills, skillSearchQuery),
    [codexSkills, skillSearchQuery],
  );

  const loadCodexSkills = (targetSessionId: string): void => {
    if (skillsRefreshTimerRef.current !== null) {
      window.clearTimeout(skillsRefreshTimerRef.current);
      skillsRefreshTimerRef.current = null;
    }
    if (skillsSearchTimerRef.current !== null) {
      window.clearTimeout(skillsSearchTimerRef.current);
      skillsSearchTimerRef.current = null;
    }
    skillsRequestRef.current?.abort();
    const controller = new AbortController();
    skillsRequestRef.current = controller;
    const requestSequence = ++skillsRequestSequenceRef.current;
    const cacheKey = "tmux-session:" + targetSessionId + ":" + (sessionCreatedAt ?? "unknown");
    const cacheScope = getLocalDraftScope();
    const saveNativeSkills = (skills: CodexSkillOption[]): void => {
      if (import.meta.env.VITE_BRIDGE_MOBILE !== "true" || sessionCreatedAt === null) return;
      void import("./composer-native-data.js")
        .then((module) => module.saveNativeComposerSessionSkills(cacheScope, targetSessionId, sessionCreatedAt, skills))
        .catch(() => {});
    };
    const cached = readCodexSkillCache(cacheKey, isCodexSkillList);
    if (cached) {
      saveNativeSkills(cached);
      setCodexSkills(cached);
      setSkillsLoading(false);
      setSkillsLoadError(null);
      skillsRequestRef.current = null;
      return;
    }
    setSkillsLoading(true);
    setSkillsLoadError(null);
    const fetchLatest = (refreshAttempt: number): void => {
      void fetchSessionCodexSkills(targetSessionId, controller.signal)
        .then(({ skills, refreshing, fresh }) => {
          if (controller.signal.aborted || requestSequence !== skillsRequestSequenceRef.current) return;
          setCodexSkills(skills);
          if (fresh) {
            writeCodexSkillCache(cacheKey, skills, cacheScope);
            saveNativeSkills(skills);
          }
          setSkillsLoading(false);
          if (refreshing && refreshAttempt < 8) {
            skillsRefreshTimerRef.current = window.setTimeout(() => {
              skillsRefreshTimerRef.current = null;
              fetchLatest(refreshAttempt + 1);
            }, 750);
          } else {
            skillsRequestRef.current = null;
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || requestSequence !== skillsRequestSequenceRef.current) return;
          setSkillsLoadError(error instanceof Error ? error.message : "Could not load Codex skills.");
          setSkillsLoading(false);
          skillsRequestRef.current = null;
        });
    };
    fetchLatest(0);
  };

  useEffect(() => {
    skillsRequestSequenceRef.current += 1;
    if (skillsRefreshTimerRef.current !== null) {
      window.clearTimeout(skillsRefreshTimerRef.current);
      skillsRefreshTimerRef.current = null;
    }
    if (skillsSearchTimerRef.current !== null) {
      window.clearTimeout(skillsSearchTimerRef.current);
      skillsSearchTimerRef.current = null;
    }
    skillsRequestRef.current?.abort();
    skillsRequestRef.current = null;
    setSkillsPickerOpen(false);
    setSkillSearchQuery("");
    setActiveSkillIndex(0);
    inputSelectionRef.current = null;
    skillTriggerRangeRef.current = null;
    setCodexSkills([]);
    setSkillsLoading(false);
    setSkillsLoadError(null);
    return () => {
      skillsRequestSequenceRef.current += 1;
      if (skillsRefreshTimerRef.current !== null) {
        window.clearTimeout(skillsRefreshTimerRef.current);
        skillsRefreshTimerRef.current = null;
      }
      if (skillsSearchTimerRef.current !== null) {
        window.clearTimeout(skillsSearchTimerRef.current);
        skillsSearchTimerRef.current = null;
      }
      skillsRequestRef.current?.abort();
      skillsRequestRef.current = null;
    };
  }, [sessionId, sessionCreatedAt]);

  const rememberComposerSelection = (): void => {
    const input = inputRef.current;
    if (!input) return;
    inputSelectionRef.current = { start: input.selectionStart, end: input.selectionEnd };
  };

  const insertCodexSkill = (skill: CodexSkillOption): void => {
    const text = aui.composer.getState().text;
    const input = inputRef.current;
    const savedSelection = inputSelectionRef.current;
    const triggerRange = skillTriggerRangeRef.current;
    const triggerIsCurrent = triggerRange !== null
      && triggerRange.start >= 0
      && triggerRange.end === triggerRange.start + 1
      && text.slice(triggerRange.start, triggerRange.end) === "$";
    const selection = triggerIsCurrent ? triggerRange : savedSelection;
    const start = Math.max(0, Math.min(text.length, selection?.start ?? input?.selectionStart ?? text.length));
    const end = Math.max(start, Math.min(text.length, selection?.end ?? input?.selectionEnd ?? start));
    const before = text.slice(0, start);
    const after = text.slice(end);
    const token = "$" + skill.skillName;
    const separator = /^\s/u.test(after) ? "" : " ";
    const nextText = before + token + separator + after;
    const nextCursor = before.length + token.length + separator.length;
    aui.composer.setText(nextText);
    setSkillsPickerOpen(false);
    setSkillSearchQuery("");
    inputSelectionRef.current = null;
    skillTriggerRangeRef.current = null;
    window.requestAnimationFrame(() => {
      const currentInput = inputRef.current;
      if (!currentInput) return;
      currentInput.focus();
      currentInput.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const closeSkillPicker = (returnFocus = true): void => {
    setSkillsPickerOpen(false);
    skillTriggerRangeRef.current = null;
    if (returnFocus) window.requestAnimationFrame(() => skillButtonRef.current?.focus());
  };

  useEffect(() => {
    if (!skillsPickerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (!window.matchMedia("(pointer: coarse)").matches) skillSearchRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setSkillsPickerOpen(false);
      skillTriggerRangeRef.current = null;
      window.requestAnimationFrame(() => skillButtonRef.current?.focus());
    };
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (skillPickerRef.current?.contains(target) || skillButtonRef.current?.contains(target)) return;
      setSkillsPickerOpen(false);
      skillTriggerRangeRef.current = null;
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [skillsPickerOpen]);

  useEffect(() => {
    if (skillsPickerOpen) return;
    skillsRequestSequenceRef.current += 1;
    if (skillsRefreshTimerRef.current !== null) {
      window.clearTimeout(skillsRefreshTimerRef.current);
      skillsRefreshTimerRef.current = null;
    }
    if (skillsSearchTimerRef.current !== null) {
      window.clearTimeout(skillsSearchTimerRef.current);
      skillsSearchTimerRef.current = null;
    }
    skillsRequestRef.current?.abort();
    skillsRequestRef.current = null;
  }, [skillsPickerOpen]);

  useEffect(() => subscribeDebugLogCapture((active) => setDebugLogActive(active)), []);

  useEffect(() => () => cancelDebugLogCapture(), []);

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    const refresh = (): void => {
      const currentRequest = ++requestId;
      void fetchShortcutConfig()
        .then((nextStore) => {
          if (!cancelled && currentRequest === requestId) setShortcutStore(nextStore);
        })
        .catch(() => {
          // Keep a valid cached configuration; an empty store selects built-in defaults.
        });
    };
    const unsubscribe = subscribeShortcutConfigInvalidation(() => {
      setShortcutStore(readShortcutConfigCache() ?? { groups: [], shortcuts: [] });
      refresh();
    });
    refresh();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const form = composerFormRef.current;
    const workspace = form?.parentElement;
    const terminalFrame = workspace?.querySelector<HTMLElement>(".dashboard-terminal-frame");
    const viewport = window.visualViewport;
    if (!form || !workspace || !terminalFrame || !viewport || !window.matchMedia("(max-width: 760px)").matches) return;

    const instance = Math.round(performance.now());
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
      if (!isDebugLogCaptureActive() || !diagnosticActiveRef.current || isDebugLogCapturePaused()) return;
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
      console.info("[tmux-keyboard] " + snapshot);
    };
    const scheduleSamples = (source: string): void => {
      if (!isDebugLogCaptureActive() || !diagnosticActiveRef.current || isDebugLogCapturePaused()) return;
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
    const onFocus = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      if (event.type === "focusin") {
        focusCycle++;
      }
      if (!isDebugLogCaptureActive() || !diagnosticActiveRef.current || isDebugLogCapturePaused()) return;
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
    const onCaptureChange = (active: boolean): void => {
      if (active) {
        sequence = 0;
        sampleViewport("capture-start");
      }
    };
    const unsubscribeCapture = subscribeDebugLogCapture(onCaptureChange);
    resizeObserver.observe(form);
    terminalObserver.observe(terminalFrame);
    viewport.addEventListener("resize", onVisualResize);
    viewport.addEventListener("scroll", onVisualScroll);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onWindowScroll, { passive: true });
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
      form.removeEventListener("focusin", onFocus);
      form.removeEventListener("focusout", onFocus);
      unsubscribeCapture();
    };
  }, []);

  useEffect(() => {
    if (!shortcutsOpen || !composerFormRef.current) {
      document.documentElement.style.removeProperty("--dashboard-shortcut-bottom");
      document.documentElement.style.removeProperty("--dashboard-shortcut-max-height");
      return;
    }
    const form = composerFormRef.current;

    const updateBottomOffset = (): void => {
      const workspaceRect = form.parentElement?.getBoundingClientRect();
      const rect = form.getBoundingClientRect();
      if (!workspaceRect) return;
      const viewport = window.visualViewport;
      const dialog = document.querySelector<HTMLElement>(".dashboard-shortcut-dialog");
      const dialogRect = dialog?.getBoundingClientRect();
      const bottom = Math.max(0, workspaceRect.bottom - rect.top + 8);
      const maxHeight = Math.max(0, rect.top - workspaceRect.top - 16);
      document.documentElement.style.setProperty(
        "--dashboard-shortcut-bottom",
        bottom + "px",
      );
      document.documentElement.style.setProperty(
        "--dashboard-shortcut-max-height",
        maxHeight + "px",
      );
      logDebugDiagnostic("tmux-shortcut", "layout", {
        open: shortcutsOpen,
        activeTag: document.activeElement?.tagName,
        viewport: viewport ? { height: viewport.height, offsetTop: viewport.offsetTop, pageTop: viewport.pageTop } : null,
        workspace: { top: workspaceRect.top, bottom: workspaceRect.bottom, height: workspaceRect.height },
        composer: { top: rect.top, bottom: rect.bottom, height: rect.height },
        dialog: dialog ? {
          view: dialog.dataset.shortcutView,
          top: dialogRect?.top,
          bottom: dialogRect?.bottom,
          height: dialogRect?.height,
          maxHeight: getComputedStyle(dialog).maxHeight,
          overflow: getComputedStyle(dialog).overflow,
        } : null,
        cssBottom: bottom + "px",
        cssMaxHeight: maxHeight + "px",
      });
    };
    const observer = new ResizeObserver(updateBottomOffset);
    observer.observe(form);
    if (form.parentElement) observer.observe(form.parentElement);
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

  const openShortcutPalette = (category: ShortcutCategory): void => {
    if (shortcutsOpen && shortcutCategory === category) {
      setShortcutsOpen(false);
      return;
    }
    setShortcutCategory(category);
    setShortcutsOpen(true);
  };

  const toggleDebugLogCapture = async (): Promise<void> => {
    const captureActive = isDebugLogCaptureActive();
    if (debugLogControlsDisabled) return;
    if (!captureActive) {
      beginDebugLogCapture();
      return;
    }

    setDebugLogBusy(true);
    try {
      const file = finishDebugLogCapture();
      if (!file) return;
      if (import.meta.env.DEV) await aui.composer.addAttachment(file);
      else {
        const download = downloadDebugLog(file);
        if (download) await download;
      }
    } catch (error) {
      onAttachmentError(error instanceof Error ? error.message : "Could not attach the debug log.");
    } finally {
      setDebugLogBusy(false);
    }
  };

  const handleShortcutUse = async (id: string): Promise<void> => {
    setShortcutStore((current) => ({
      ...current,
      shortcuts: current.shortcuts.map((shortcut) => shortcut.id === id
        ? { ...shortcut, operationCount: shortcut.operationCount + 1 }
        : shortcut),
    }));
    try {
      const updated = await recordShortcutUse(id);
      setShortcutStore((current) => ({
        ...current,
        shortcuts: current.shortcuts.map((shortcut) => shortcut.id === id ? updated : shortcut),
      }));
    } catch {
      // Keep the optimistic count; the next config refresh reconciles it.
    }
  };

  const composerShortcutsFor = (mode: "closed" | "expanded"): ShortcutDefinition[] =>
    composerShortcuts.filter((shortcut) => shortcut.displayMode === mode || shortcut.displayMode === "both");

  const renderComposerAction = (shortcut: ShortcutDefinition): ReactElement | null => {
    const track = (): void => { void handleShortcutUse(shortcut.id); };
    const terminalAction = (value: string): ReactElement => (
      <button key={shortcut.id} className={`dashboard-keybar-button is-icon${shortcut.actionKey === "terminal-enter" ? " is-enter" : ""}`} type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.detail || shortcut.title} disabled={controlsDisabled} onClick={() => { track(); void onTerminalShortcut(value as TerminalShortcut); }}>
        {shortcut.actionKey === "terminal-enter"
          ? <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 4v7a4 4 0 0 1-4 4H4m5-5-5 5 5 5" /></svg>
          : shortcut.title}
      </button>
    );
    switch (shortcut.actionKey) {
      case "attachment":
        return <ComposerPrimitive.AddAttachment key={shortcut.id} className="dashboard-keybar-button is-attachment" type="button" multiple disabled={controlsDisabled} onClick={track}>{shortcut.title === "附件" ? "＋" : shortcut.title}</ComposerPrimitive.AddAttachment>;
      case "phone-transfer":
        return <button key={shortcut.id} className="dashboard-keybar-button is-phone-transfer" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.detail || shortcut.title} disabled={!sessionId || controlsDisabled} onClick={() => { track(); setShortcutsOpen(false); setPhoneTransferOpen(true); }}>{shortcut.title || "手机"}</button>;
      case "skill-picker":
        return <button key={shortcut.id} ref={skillButtonRef} className="dashboard-keybar-button is-skill-picker" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.detail || shortcut.title} aria-haspopup="dialog" aria-expanded={skillsPickerOpen} disabled={!sessionId || controlsDisabled} onPointerDown={rememberComposerSelection} onClick={() => { track(); openSkillsPicker(); }}>{shortcut.title || "$"}</button>;
      case "scroll-top":
        return <button key={shortcut.id} className="dashboard-keybar-button is-icon is-scroll-jump" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.title} disabled={controlsDisabled} onClick={() => { track(); onScrollToTop(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M12 19V8m0 0-5 5m5-5 5 5" /></svg></button>;
      case "scroll-bottom":
        return <button key={shortcut.id} className="dashboard-keybar-button is-icon is-scroll-jump" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.title} disabled={controlsDisabled} onClick={() => { track(); onScrollToBottom(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h14M12 5v11m0 0 5-5m-5 5-5-5" /></svg></button>;
      case "session-files":
        return <button key={shortcut.id} className="dashboard-keybar-button is-files" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.title} disabled={!sessionId || controlsDisabled} onClick={() => { track(); onOpenFiles(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9.5a1.5 1.5 0 0 1-1.5 1.5h-14a1.5 1.5 0 0 1-1.5-1.5z" /><path d="M3.5 8.5h17" /></svg></button>;
      case "debug-log":
        return <button key={shortcut.id} className={`dashboard-keybar-button is-debug-log${debugLogActive ? " is-recording" : ""}`} type="button" title={debugLogActive ? (import.meta.env.DEV ? "完成收集并添加日志文件" : "完成收集并下载日志") : "开始收集 console 日志"} aria-label={debugLogActive ? (import.meta.env.DEV ? "完成收集并添加日志文件" : "完成收集并下载日志") : "开始收集 console 日志"} aria-pressed={debugLogActive} disabled={debugLogControlsDisabled} onClick={() => { track(); void toggleDebugLogCapture(); }}>{debugLogBusy ? "…" : debugLogActive ? "■" : "●"}</button>;
      case "scroll-export":
        return <button key={shortcut.id} className="dashboard-keybar-button is-icon is-scroll-export" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.title} disabled={controlsDisabled} onClick={() => { track(); onExportScrollDiagnostics(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 15v4h14v-4" /></svg></button>;
      case "terminal-escape":
      case "terminal-up":
      case "terminal-down":
      case "terminal-enter":
        return terminalAction(shortcut.value);
      case "terminal-answer":
        return terminalAction("codex-answer");
      case "terminal-prompt-back":
        return terminalAction("codex-prompt-back");
      case "terminal-warnings":
        return terminalAction("codex-warnings");
      case "codex-panel":
        return <button key={shortcut.id} className="dashboard-keybar-button" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.detail || shortcut.title} aria-expanded={shortcutsOpen && shortcutCategory === "codex-tui"} disabled={controlsDisabled} onClick={() => { track(); openShortcutPalette("codex-tui"); }}>{shortcut.title}</button>;
      case "keyboard-panel":
        return <button key={shortcut.id} className="dashboard-keybar-button is-keyboard" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.title} aria-expanded={shortcutsOpen} disabled={controlsDisabled} onClick={() => { track(); openShortcutPalette("keyboard"); }}>⌨</button>;
      case "ctrl-panel":
        return <button key={shortcut.id} className="dashboard-keybar-button" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.title} disabled={controlsDisabled} onClick={() => { track(); openShortcutPalette("ctrl"); }}>⌃</button>;
      case "close-panel":
        return <button key={shortcut.id} className="dashboard-keybar-button is-close" type="button" title={shortcut.detail || shortcut.title} aria-label={shortcut.title} disabled={controlsDisabled} onClick={() => { track(); setShortcutsOpen(false); }}>×</button>;
      default:
        return null;
    }
  };

  const skillPickerId = "tmux-skill-picker-" + (sessionId ?? "none").replace(/[^A-Za-z0-9_-]/g, "-");
  const skillPickerListId = skillPickerId + "-list";
  const openSkillsPicker = (triggerRange?: { start: number; end: number }): void => {
    if (skillsPickerOpen) {
      closeSkillPicker(false);
      return;
    }
    if (triggerRange) {
      skillTriggerRangeRef.current = triggerRange;
      inputSelectionRef.current = { start: triggerRange.end, end: triggerRange.end };
    } else {
      skillTriggerRangeRef.current = null;
      if (document.activeElement === inputRef.current) rememberComposerSelection();
    }
    inputRef.current?.blur();
    setSkillSearchQuery("");
    setActiveSkillIndex(0);
    if (sessionId) loadCodexSkills(sessionId);
    setSkillsPickerOpen(true);
  };

  const handleFileDrag = (event: DragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = controlsDisabled ? "none" : "copy";
    if (!controlsDisabled) setDraggingFiles(true);
  };

  return (
    <>
      <ComposerPrimitive.Root
        className={"dashboard-composer" + (draggingFiles && !controlsDisabled ? " is-file-dragging" : "")}
        ref={composerFormRef}
        onDragEnter={handleFileDrag}
        onDragOver={handleFileDrag}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDraggingFiles(false);
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0 && !Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          setDraggingFiles(false);
          if (controlsDisabled || files.length === 0) return;
          setAddingDroppedFiles(true);
          void Promise.all(files.map(async (file) => {
            try {
              await aui.composer.addAttachment(file);
            } catch (error) {
              onAttachmentError(error instanceof Error ? error.message : "添加附件失败。");
            }
          })).finally(() => setAddingDroppedFiles(false));
        }}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          if (controlsDisabled) {
            event.preventDefault();
            return;
          }
          setSkillsPickerOpen(false);
          skillTriggerRangeRef.current = null;
          if (aui.composer.getState().isEmpty) return;
          setShortcutsOpen(false);
          onSendStart();
        }}
      >
        {draggingFiles && !controlsDisabled ? <span className="dashboard-composer-drop-hint" aria-hidden="true">松开以添加附件</span> : null}
        <div className="dashboard-composer-images" aria-label="Attachments to send">
          <ComposerPrimitive.Attachments>
            {({ attachment }) => {
              const progress = attachmentProgress[attachment.id];
              const percent = progress && progress.total > 0
                ? Math.min(100, Math.floor(progress.bytes / progress.total * 100))
                : 0;
              const remote = composerAssetFromAttachment(attachment);
              const isImage = attachment.file?.type.startsWith("image/") || remote?.contentType.startsWith("image/");
              const openPreview = (): void => {
                const items = aui.composer.getState().attachments.flatMap((item): ComposerPreviewItem[] => {
                  if (item.file?.type.startsWith("image/")) return [{ id: item.id, name: item.name, file: item.file }];
                  const asset = composerAssetFromAttachment(item);
                  return asset?.contentType.startsWith("image/") ? [{ id: item.id, name: asset.name, asset }] : [];
                });
                const position = items.findIndex((item) => item.id === attachment.id);
                if (position !== -1) setPreview({ items, position });
              };
              return <AttachmentPrimitive.Root
                className={"dashboard-composer-image" + (isImage ? "" : " is-file")}
                key={attachment.id}
              >
                {attachment.file?.type.startsWith("image/")
                  ? <ImagePreview file={attachment.file} onOpen={openPreview} />
                  : remote && isImage && sessionId ? <RemoteImagePreview asset={remote} sessionId={sessionId} onOpen={openPreview} />
                    : <span className="dashboard-composer-file-name" title={attachment.name}>{attachment.name}</span>}
                {progress ? <span className="dashboard-composer-upload-progress" role="status" aria-live="polite">
                  <progress max={progress.total || 1} value={Math.min(progress.bytes, progress.total || 1)} aria-label={`${attachment.name} 上传进度`} />
                  <span>{uploadPhaseText(progress.phase)} {percent}%</span>
                </span> : null}
                <AttachmentPrimitive.Remove
                  className="dashboard-composer-image-remove"
                  type="button"
                  aria-label={"Remove " + attachment.name}
                  disabled={controlsDisabled}
                  onClick={() => { onDraftUserAction(); if (remote && sessionId) void releaseComposerAsset(sessionId, remote.sessionCreatedAt, remote.assetId).catch(() => {}); }}
                >×</AttachmentPrimitive.Remove>
              </AttachmentPrimitive.Root>;
            }}
          </ComposerPrimitive.Attachments>
        </div>
        <div className="dashboard-composer-input-slot">
          <ComposerPrimitive.Input
            className="dashboard-composer-input"
            ref={inputRef}
            aria-label="Message the Codex session"
            placeholder={placeholder}
            maxLength={8_000}
            minRows={2}
            maxRows={6}
            disabled={inputDisabled}
            submitMode={controlsDisabled ? "none" : "enter"}
            unstable_insertNewlineOnTouchEnter
            unstable_focusOnRunStart={false}
            unstable_focusOnScrollToBottom={false}
            unstable_focusOnThreadSwitched={false}
            onInputCapture={onDraftUserAction}
            onCompositionStart={() => imeGuard.start()}
            onCompositionEnd={(event) => imeGuard.end(event.timeStamp)}
            onKeyDownCapture={(event) => {
              // Leave the native IME action intact while keeping it away from the submit handler.
              if (imeGuard.isImeEnter(event.nativeEvent)) event.stopPropagation();
            }}
            onKeyDown={(event) => {
              if (isCodexSkillTrigger(event.nativeEvent)) {
                const input = event.currentTarget;
                const text = aui.composer.getState().text;
                const start = Math.max(0, Math.min(text.length, input.selectionStart ?? text.length));
                const end = Math.max(start, Math.min(text.length, input.selectionEnd ?? start));
                const nextText = text.slice(0, start) + "$" + text.slice(end);
                event.preventDefault();
                aui.composer.setText(nextText);
                const triggerRange = { start, end: start + 1 };
                inputSelectionRef.current = { start: triggerRange.end, end: triggerRange.end };
                skillTriggerRangeRef.current = triggerRange;
                openSkillsPicker(triggerRange);
                return;
              }
              const shortcut = macComposerTerminalShortcut(
                event.nativeEvent,
                aui.composer.getState().isEmpty,
              );
              if (!shortcut) return;
              event.preventDefault();
              event.stopPropagation();
              void onTerminalShortcut(shortcut);
            }}
            onBlur={(event) => {
              imeGuard.reset();
              inputSelectionRef.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
            }}
            onFocus={() => {
              if (!shortcutsOpen) return;
              logDebugDiagnostic("tmux-shortcut", "composer-focus-close", { category: shortcutCategory });
              setShortcutsOpen(false);
            }}
          />
          {skillsPickerOpen ? (
            <div
              ref={skillPickerRef}
              id={skillPickerId}
              className="dashboard-skill-suggestions"
              role="dialog"
              aria-label="选择 Codex 技能"
            >
              <input
                ref={skillSearchRef}
                className="dashboard-skill-picker-search"
                type="search"
                aria-label="筛选技能"
                aria-autocomplete="list"
                aria-controls={skillPickerListId}
                aria-activedescendant={filteredCodexSkills[activeSkillIndex]
                  ? skillPickerListId + "-" + activeSkillIndex
                  : undefined}
                placeholder="搜索技能"
                value={skillSearchQuery}
                onChange={(event) => {
                  setSkillSearchQuery(event.currentTarget.value);
                  setActiveSkillIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeSkillPicker();
                    return;
                  }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    if (filteredCodexSkills.length === 0) return;
                    event.preventDefault();
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    setActiveSkillIndex((current) => (
                      current + direction + filteredCodexSkills.length
                    ) % filteredCodexSkills.length);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const selected = filteredCodexSkills[activeSkillIndex];
                    if (selected) insertCodexSkill(selected);
                  }
                }}
              />
              <div id={skillPickerListId} className="dashboard-skill-suggestions-list" role="listbox" aria-label="技能列表">
                {skillsLoading ? (
                  <div className="dashboard-skill-picker-message" role="status">正在读取技能…</div>
                ) : skillsLoadError ? (
                  <div className="dashboard-skill-picker-message is-error" role="status">{skillsLoadError}</div>
                ) : filteredCodexSkills.length === 0 ? (
                  <div className="dashboard-skill-picker-message" role="status">没有匹配的技能</div>
                ) : (
                  filteredCodexSkills.map((skill, index) => {
                    return (
                      <button
                        key={skill.skillName}
                        id={skillPickerListId + "-" + index}
                        className={"dashboard-skill-suggestion" + (index === activeSkillIndex ? " is-active" : "")}
                        type="button"
                        role="option"
                        aria-selected={index === activeSkillIndex}
                        onPointerDown={(event) => event.preventDefault()}
                        onPointerMove={() => setActiveSkillIndex(index)}
                        onClick={() => insertCodexSkill(skill)}
                      >
                        <span className="dashboard-skill-suggestion-heading">
                          <span className="dashboard-skill-suggestion-name">{skill.skillName}</span>
                        </span>
                        <span className="dashboard-skill-suggestion-description">
                          {skill.descriptionZh}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}
        </div>
        <div className="dashboard-composer-actions">
          <div className="dashboard-composer-keybar" role="toolbar" aria-label="Quick terminal keys">
            {shortcutsOpen ? (
              <>{composerShortcutsFor("expanded").map(renderComposerAction)}</>
            ) : (
              <>{composerShortcutsFor("closed").map(renderComposerAction)}</>
            )}
          </div>
          <ComposerPrimitive.Send
            className="dashboard-compose-send"
            type="button"
            disabled={controlsDisabled}
            aria-label={sendDisabled ? "等待连接恢复后发送" : addingDroppedFiles ? "正在添加附件" : sending || preparing ? "正在发送" : "发送消息"}
            title={sendDisabled ? "连接不可用，恢复后可发送" : undefined}
          ><span className="dashboard-send-label">{addingDroppedFiles ? "添加附件中…" : assetResolving ? "准备附件…" : sending || preparing ? "发送中…" : "发送"}</span><span aria-hidden="true">↑</span></ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
      {preview ? <ImageLightbox
        source={preview.items[preview.position]!}
        sessionId={sessionId}
        position={preview.position}
        total={preview.items.length}
        onNavigate={(direction) => setPreview((current) => current ? {
          ...current,
          position: Math.max(0, Math.min(current.items.length - 1, current.position + direction)),
        } : null)}
        onClose={() => setPreview(null)}
      /> : null}
      {phoneTransferOpen ? <ComposerTransferReceiver
        sessionId={sessionId}
        sessionCreatedAt={sessionCreatedAt}
        onImportText={(incoming) => {
          const current = aui.composer.getState().text;
          const next = appendComposerTransferText(current, incoming);
          if (next !== current) aui.composer.setText(next);
        }}
        onImportFile={(file) => aui.composer.addAttachment(file).then(() => undefined)}
        onImportAssets={onImportAssets}
        onClose={() => setPhoneTransferOpen(false)}
      /> : null}
      <Suspense fallback={null}>
        <TmuxShortcutPalette
          open={shortcutsOpen}
          category={shortcutCategory}
          onOpenChange={setShortcutsOpen}
          onCategoryChange={setShortcutCategory}
          store={shortcutStore}
          onShortcutUse={handleShortcutUse}
          onSubmitText={onSubmit}
          onSubmitCommand={onSubmitCommand}
          onTerminalShortcut={onTerminalShortcut}
          onTerminalSequence={onTerminalSequence}
        />
      </Suspense>
    </>
  );
}

function subscribeComposerDraftScope(listener: () => void): () => void {
  window.addEventListener(LOCAL_DRAFT_SCOPE_EVENT, listener);
  return () => window.removeEventListener(LOCAL_DRAFT_SCOPE_EVENT, listener);
}

export function TmuxMessageComposer(props: TmuxMessageComposerProps): ReactElement {
  const scope = useSyncExternalStore(subscribeComposerDraftScope, getLocalDraftScope, () => null);
  return <ScopedTmuxMessageComposer key={JSON.stringify([scope, props.sessionId, props.sessionCreatedAt])} {...props} />;
}

function ScopedTmuxMessageComposer(props: TmuxMessageComposerProps): ReactElement {
  const [preparing, setPreparing] = useState(false);
  const [assetResolving, setAssetResolving] = useState(false);
  const [attachmentProgress, setAttachmentProgress] = useState<Record<string, AttachmentUploadProgress>>({});
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const attachmentUploads = useRef(new Set<AbortController>());
  const assetImportState = useRef<{ key: string; imported: Set<string>; operations: Map<string, Promise<void>> }>({ key: "", imported: new Set(), operations: new Map() });
  const assetTouchAt = useRef(new Map<string, number>());
  const draftUserAction = useRef(false);
  const draftUserRevision = useRef(0);
  const draftResetRevision = useRef(0);
  const contextKey = JSON.stringify([getLocalDraftScope(), props.sessionId, props.sessionCreatedAt]);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  if (assetImportState.current.key !== contextKey) assetImportState.current = { key: contextKey, imported: new Set(), operations: new Map() };
  const importAssets = async (adoption: ComposerAssetAdoption): Promise<void> => {
    const sessionId = props.sessionId;
    const sessionCreatedAt = props.sessionCreatedAt;
    const scope = getLocalDraftScope();
    const state = assetImportState.current;
    const composer = runtimeRef.current?.thread.composer;
    if (!sessionId || sessionCreatedAt === null || !composer || !scope) throw new Error("当前 Session 或设备尚未准备好。");
    const pending = state.operations.get(adoption.transferId);
    if (pending) return pending;
    const operation = applyComposerAssetAdoption(composer, sessionId, sessionCreatedAt, adoption, state.imported, scope, () => mountedRef.current && contextKeyRef.current === state.key);
    state.operations.set(adoption.transferId, operation);
    try { await operation; } finally { if (state.operations.get(adoption.transferId) === operation) state.operations.delete(adoption.transferId); }
  };
  useEffect(() => {
    setAttachmentProgress({});
    return () => {
      for (const upload of attachmentUploads.current) upload.abort();
      attachmentUploads.current.clear();
    };
  }, [props.sessionId]);
  const submitRef = useRef(props.onSubmit);
  const attachmentErrorRef = useRef(props.onAttachmentError);
  const forwardConsumedRef = useRef(props.onSessionFileForwardConsumed);
  const processedForwardIdRef = useRef<string | null>(null);
  submitRef.current = props.onSubmit;
  attachmentErrorRef.current = props.onAttachmentError;
  forwardConsumedRef.current = props.onSessionFileForwardConsumed;

  const attachmentAdapter = useMemo<AttachmentAdapter>(() => ({
    accept: "*",
    async add({ file }) {
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
      const upload = new AbortController();
      attachmentUploads.current.add(upload);
      try {
        const path = await uploadAttachment(attachment.file, upload.signal, (progress) => {
          setAttachmentProgress((current) => ({ ...current, [attachment.id]: progress }));
        });
        setAttachmentProgress((current) => {
          const next = { ...current };
          delete next[attachment.id];
          return next;
        });
        return {
          ...attachment,
          status: { type: "complete" },
          content: [{ type: "text", text: path }],
        };
      } catch (error) {
        setAttachmentProgress((current) => {
          const next = { ...current };
          delete next[attachment.id];
          return next;
        });
        setPreparing(false);
        attachmentErrorRef.current(error instanceof Error ? error.message : "Attachment upload failed.");
        throw error;
      } finally {
        attachmentUploads.current.delete(upload);
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

      const originalMessageText = userMessage.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const messageText = originalMessageText.trim();
      const remoteAssets = userMessage.attachments.flatMap((attachment) => {
        const asset = composerAssetFromAttachment(attachment);
        return asset ? [asset] : [];
      });
      const draftScopeAtSend = getLocalDraftScope();
      const contextAtSend = JSON.stringify([draftScopeAtSend, props.sessionId, props.sessionCreatedAt]);
      let result: ComposerSubmissionResult;
      try {
        if (remoteAssets.length && (!props.sessionId || props.sessionCreatedAt === null
          || remoteAssets.some((asset) => asset.sessionCreatedAt !== props.sessionCreatedAt))) {
          throw new Error("草稿附件属于已变化的 Session，请重新添加。");
        }
        let resolved = new Map<string, { path: string; name: string; contentType: string }>();
        if (remoteAssets.length && props.sessionId && props.sessionCreatedAt !== null) {
          setAssetResolving(true);
          for (const transferId of new Set(remoteAssets.map((asset) => asset.transferId))) {
            await acknowledgeComposerAdoption(props.sessionId, props.sessionCreatedAt, transferId);
          }
          const items = await resolveComposerAssets(props.sessionId, props.sessionCreatedAt, remoteAssets);
          if (!mountedRef.current || contextKeyRef.current !== contextAtSend || getLocalDraftScope() !== draftScopeAtSend) throw new Error("Bridge、设备或 Session 已变化，附件未发送。");
          resolved = new Map(items.map((item) => [item.assetId, item]));
        }
        const uploadedAttachments = userMessage.attachments.flatMap((attachment) => {
          const remote = composerAssetFromAttachment(attachment);
          if (remote) {
            const item = resolved.get(remote.assetId);
            if (!item) throw new Error("草稿附件尚未准备好，请重试。");
            return [{ path: item.path, name: item.name, isImage: item.contentType.startsWith("image/") }];
          }
          return (attachment.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => ({ path: part.text, name: attachment.name, isImage: (attachment.contentType ?? attachment.file?.type ?? "").startsWith("image/") }));
        });
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
        if (!mountedRef.current || contextKeyRef.current !== contextAtSend || getLocalDraftScope() !== draftScopeAtSend) throw new Error("Bridge、设备或 Session 已变化，消息未发送。");
        result = await submitRef.current(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : "草稿附件处理失败，请重试。";
        attachmentErrorRef.current(message);
        result = { ok: false, message };
      } finally {
        setAssetResolving(false);
        setPreparing(false);
      }

      if (result.ok && props.sessionId && mountedRef.current && contextKeyRef.current === contextAtSend && getLocalDraftScope() === draftScopeAtSend) {
        draftResetRevision.current += 1;
        clearDraftMetadata(props.sessionId, draftScopeAtSend);
        await clearDraftAttachments(props.sessionId);
        if (assetImportState.current.key === contextAtSend) assetImportState.current.imported.clear();
      }

      if (!result.ok) {
        const composer = runtimeRef.current?.thread.composer;
        if (mountedRef.current && contextKeyRef.current === contextAtSend && getLocalDraftScope() === draftScopeAtSend) {
          composer?.setText(originalMessageText);
          window.setTimeout(() => {
            if (!mountedRef.current || contextKeyRef.current !== contextAtSend || getLocalDraftScope() !== draftScopeAtSend) return;
            for (const attachment of userMessage.attachments) {
              const remote = composerAssetFromAttachment(attachment);
              const source = remote ? composerAssetAttachment(remote) : attachment.file;
              if (source) {
                void composer?.addAttachment(source).catch((error: unknown) => {
                  attachmentErrorRef.current(error instanceof Error ? error.message : "Could not restore the image draft.");
                });
              }
            }
          }, 0);
        }
      }

      return {
        content: [{ type: "text", text: result.ok ? "Delivered to the tmux session." : "Delivery status is uncertain or the message was rejected." }],
      };
    },
  }), [props.sessionId, props.sessionCreatedAt]);

  const runtime = useLocalRuntime(chatModel, { adapters: { attachments: attachmentAdapter } });
  runtimeRef.current = runtime;
  const runtimeLoading = useSyncExternalStore(runtime.thread.subscribe, () => runtime.thread.getState().isLoading);

  useEffect(() => {
    const sessionId = props.sessionId;
    if (!import.meta.hot || !sessionId) return;
    let cancelled = false;
    const recoverAfterUpdate = (): void => {
      const revision = draftUserRevision.current;
      const scope = getLocalDraftScope();
      const key = contextKey;
      void (async () => {
          if (cancelled || revision !== draftUserRevision.current || !scope || scope !== getLocalDraftScope() || contextKeyRef.current !== key) return;
          const currentRuntime = runtimeRef.current;
          if (!currentRuntime || currentRuntime.thread.getState().isLoading) return;
          const composer = currentRuntime.thread.composer;
          const draft = loadDraftMetadata(sessionId);
          if (!draft || (!draft.text && !draft.attachments.length)) return;
          if (assetImportState.current.key === key) for (const id of draft.importedTransferIds ?? []) assetImportState.current.imported.add(id);
          if (draft.text && !composer.getState().text) composer.setText(draft.text);
          for (const attachment of draft.attachments) {
            if (cancelled || revision !== draftUserRevision.current || scope !== getLocalDraftScope() || contextKeyRef.current !== key) return;
            if (attachment.remote) {
              if (!composer.getState().attachments.some((entry) => composerAssetFromAttachment(entry)?.assetId === attachment.remote!.assetId)) {
                await composer.addAttachment(composerAssetAttachment(attachment.remote));
              }
            } else {
              const file = await loadDraftAttachment(sessionId, attachment.id);
              if (cancelled || revision !== draftUserRevision.current || !file) continue;
              if (!composer.getState().attachments.some((entry) => entry.name === file.name && entry.file?.size === file.size)) await composer.addAttachment(file);
            }
          }
      })().catch((error: unknown) => { if (!cancelled) attachmentErrorRef.current(error instanceof Error ? error.message : "恢复草稿失败。"); });
    };
    hotDraftRecovery.callbacks.add(recoverAfterUpdate);
    return () => { cancelled = true; hotDraftRecovery.callbacks.delete(recoverAfterUpdate); };
  }, [contextKey, props.sessionId, props.sessionCreatedAt]);

  useEffect(() => {
    const sessionId = props.sessionId;
    if (!sessionId || runtimeLoading) return;
    const draftScope = getLocalDraftScope();
    const composer = runtime.thread.composer;
    let cancelled = false;
    let restored = false;
    let saveTimer = 0;
    const forwardImageController = new AbortController();
    // The runtime can detach before this effect cleans up. Keep the last real
    // composer state rather than reading its temporary empty replacement.
    let latestState = composer.getState();
    let resetRevision = draftResetRevision.current;
    let explicitSnapshotPending = false;

    const flushDraft = (): void => {
      if (!restored || cancelled || resetRevision !== draftResetRevision.current) return;
      const state = latestState;
      const attachments: DraftAttachment[] = serializeComposerDraftAttachments(state.attachments);
      const previous = loadDraftMetadata(sessionId);
      if (!explicitSnapshotPending && previous && !shouldAcceptComposerDraftSnapshot(previous, { text: state.text, attachments }, false)) return;
      const imported = assetImportState.current.key === contextKey ? [...assetImportState.current.imported].slice(-1000) : [];
      if (!state.text && attachments.length === 0 && imported.length === 0) {
        clearDraftMetadata(sessionId, draftScope);
        explicitSnapshotPending = false;
        return;
      }
      if (saveDraftMetadata(sessionId, { text: state.text, attachments, importedTransferIds: imported }, draftScope)) explicitSnapshotPending = false;
      const remote = attachments.flatMap((attachment) => attachment.remote ? [attachment.remote] : []);
      if (supportsComposerAssets() && props.sessionCreatedAt !== null && remote.length && contextKeyRef.current === contextKey
        && remote.every((asset) => asset.sessionCreatedAt === props.sessionCreatedAt)) {
        const touchKey = contextKey + ":" + remote.map((asset) => asset.assetId).sort().join(",");
        if (Date.now() - (assetTouchAt.current.get(touchKey) ?? 0) > 12 * 60 * 60 * 1_000) {
          assetTouchAt.current.set(touchKey, Date.now());
          void touchComposerAssets(sessionId, props.sessionCreatedAt, remote).catch(() => { assetTouchAt.current.delete(touchKey); });
        }
      }
    };
    const persist = (): void => {
      if (!restored || cancelled || runtime.thread.getState().isLoading) return;
      const nextState = composer.getState();
      if (resetRevision !== draftResetRevision.current) {
        resetRevision = draftResetRevision.current;
      } else if (!shouldAcceptComposerDraftSnapshot(latestState, nextState, draftUserAction.current)) {
        draftUserAction.current = false;
        return;
      }
      explicitSnapshotPending ||= draftUserAction.current;
      draftUserAction.current = false;
      latestState = nextState;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(flushDraft, 180);
    };

    const flushBeforePageHide = (): void => flushDraft();
    const flushWhenHidden = (): void => {
      if (document.visibilityState === "hidden") flushDraft();
    };

    const unsubscribe = composer.subscribe(persist);
    window.addEventListener("pagehide", flushBeforePageHide);
    window.addEventListener(LOCAL_DRAFT_SCOPE_WILL_CHANGE_EVENT, flushBeforePageHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    const restore = async (): Promise<void> => {
      const draft = loadDraftMetadata(sessionId);
      if (cancelled) return;

      if (draft) {
        if (assetImportState.current.key === contextKey) for (const id of draft.importedTransferIds ?? []) assetImportState.current.imported.add(id);
        if (!composer.getState().text && draft.text) composer.setText(draft.text);
        for (const attachment of draft.attachments) {
          if (cancelled) return;
          try {
            if (attachment.remote) {
              if (!composer.getState().attachments.some((current) => composerAssetFromAttachment(current)?.assetId === attachment.remote!.assetId)) {
                await composer.addAttachment(composerAssetAttachment(attachment.remote));
              }
            } else {
              const file = await loadDraftAttachment(sessionId, attachment.id);
              if (cancelled || !file) continue;
              if (composer.getState().attachments.some((current) => current.name === file.name && current.file?.size === file.size)) continue;
              await composer.addAttachment(file);
            }
          } catch (error) {
            attachmentErrorRef.current(error instanceof Error ? error.message : "Could not restore the image draft.");
          }
        }
      }
      if (cancelled) return;
      if (
        props.sessionFileForward?.sessionId === sessionId
        && processedForwardIdRef.current !== props.sessionFileForward.id
      ) {
        processedForwardIdRef.current = props.sessionFileForward.id;
        const currentText = composer.getState().text;
        const trimmedEnd = currentText.replace(/\n+$/, "");
        const lines = trimmedEnd.split("\n");
        let removedMatchingLines = false;
        if (props.sessionFileForward.text) {
          while (lines[lines.length - 1] === props.sessionFileForward.text) {
            lines.pop();
            removedMatchingLines = true;
          }
        }
        const baseText = removedMatchingLines ? lines.join("\n") : currentText;
        if (props.sessionFileForward.text) {
          const separator = baseText && !baseText.endsWith("\n") ? "\n" : "";
          composer.setText(`${baseText}${separator}${props.sessionFileForward.text}`);
        }
        for (const image of props.sessionFileForward.images ?? []) {
          if (cancelled) return;
          try {
            const file = await fetchForwardImage(image, forwardImageController.signal);
            if (cancelled) return;
            if (composer.getState().attachments.some((current) => current.name === file.name && current.file?.size === file.size)) continue;
            await composer.addAttachment(file);
          } catch (error) {
            if (!cancelled && !forwardImageController.signal.aborted) {
              attachmentErrorRef.current(error instanceof Error ? error.message : "转发图片读取失败。");
            }
          }
        }
        if (!cancelled) forwardConsumedRef.current(props.sessionFileForward.id);
      }
      if (!cancelled) {
        restored = true;
        persist();
        void recoverPendingAssets();
      }
    };
    let recovering = false;
    let recoveryTimer = 0;
    let recoveryAttempts = 0;
    const recoverPendingAssets = async (): Promise<void> => {
      if (recovering || cancelled || !restored || document.visibilityState !== "visible" || !supportsComposerAssets() || props.sessionCreatedAt === null) return;
      recovering = true;
      let retryPreparing = false;
      try {
        const pending = await pendingComposerAdoptions(sessionId, props.sessionCreatedAt);
        const adoptions = [...pending.adoptions];
        for (const item of pending.preparing) {
          if (cancelled || contextKeyRef.current !== contextKey || getLocalDraftScope() !== draftScope) return;
          try { adoptions.push(await adoptComposerTransfer(sessionId, props.sessionCreatedAt, item.targetId, item.transferId)); }
          catch (error) {
            if (error instanceof ComposerAssetRequestError && error.status !== 409 && error.status < 500) throw error;
            retryPreparing = true;
          }
        }
        for (const adoption of adoptions) {
          if (cancelled || contextKeyRef.current !== contextKey || getLocalDraftScope() !== draftScope) return;
          await importAssets(adoption);
          if (cancelled || contextKeyRef.current !== contextKey || getLocalDraftScope() !== draftScope) return;
          await acknowledgeComposerAdoption(sessionId, props.sessionCreatedAt, adoption.transferId);
        }
      } catch (error) {
        if (!cancelled && navigator.onLine && contextKeyRef.current === contextKey) {
          attachmentErrorRef.current(error instanceof Error ? error.message : "恢复手机附件失败，请重试。");
        }
      } finally {
        recovering = false;
        if (retryPreparing && !cancelled) {
          const delay = Math.min(30_000, 2_000 * 2 ** Math.min(recoveryAttempts++, 4));
          recoveryTimer = window.setTimeout(() => { void recoverPendingAssets(); }, delay);
        } else recoveryAttempts = 0;
      }
    };
    const recoverWhenVisible = (): void => { if (document.visibilityState === "visible") void recoverPendingAssets(); };
    window.addEventListener("online", recoverWhenVisible);
    document.addEventListener("visibilitychange", recoverWhenVisible);
    void restore();

    return () => {
      window.clearTimeout(saveTimer);
      window.clearTimeout(recoveryTimer);
      flushDraft();
      cancelled = true;
      forwardImageController.abort();
      unsubscribe();
      window.removeEventListener("pagehide", flushBeforePageHide);
      window.removeEventListener(LOCAL_DRAFT_SCOPE_WILL_CHANGE_EVENT, flushBeforePageHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("online", recoverWhenVisible);
      document.removeEventListener("visibilitychange", recoverWhenVisible);
    };
  }, [props.sessionFileForward, props.sessionId, props.sessionCreatedAt, contextKey, runtime, runtimeLoading]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerFields
        {...props}
        preparing={preparing}
        assetResolving={assetResolving}
        attachmentProgress={attachmentProgress}
        onImportAssets={importAssets}
        onDraftUserAction={() => { draftUserAction.current = true; draftUserRevision.current += 1; }}
        onSendStart={() => {
          if (!runtime.thread.composer.getState().isEmpty) setPreparing(true);
        }}
      />
    </AssistantRuntimeProvider>
  );
}

function uploadPhaseText(phase: DownloadUploadPhase): string {
  switch (phase) {
    case "preparing": return "准备中";
    case "creating": return "创建上传任务";
    case "reading": return "读取文件";
    case "uploading": return "上传中";
    case "confirming": return "Mac 正在写入";
    case "saving": return "保存到 Mac";
  }
}
