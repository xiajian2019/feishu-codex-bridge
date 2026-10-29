// Loaded only by the separate mobile build. Native libraries never enter the Web build.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { FileTransfer } from "@capacitor/file-transfer";
import { Share } from "@capacitor/share";
import { Clipboard } from "@capacitor/clipboard";
import { MOBILE_BACK_EVENT, MOBILE_RESUME_EVENT, MOBILE_SHAKE_EVENT } from "./mobile-runtime.js";
import { createShakeDetector } from "./mobile-shake.js";
import type { MobileApkUpdate, ApkUpdatePhase } from "./mobile-apk-update.js";
import { setAppForeground } from "./foreground-polling.js";
import { MOBILE_SHAKE_PREFERENCE_EVENT, readMobileShakeEnabled, writeMobileShakeEnabled } from "./app-settings.js";
import {
  failMobileDownload, hasAndroidMobileDownloads, refreshAndroidMobileDownloads, startMobileDownload,
  trackAndroidMobileDownload, updateMobileDownload, subscribeMobileDownloads, getMobileDownloads, cancelAndroidMobileDownload, type NativeDownloadStatus,
} from "./mobile-download-manager.js";

interface TransferProgress {
  type: "download" | "upload";
  url: string;
  bytes: number;
  contentLength: number;
  lengthComputable: boolean;
}
interface CredentialPlugin {
  get(options: { server: string }): Promise<{ token: string | null }>;
  set(options: { server: string; token: string }): Promise<void>;
  remove(options: { server: string }): Promise<void>;
}
type ApkVerification = Pick<MobileApkUpdate, "sha256" | "size" | "packageName" | "versionCode" | "versionName"> & { uri: string };
interface UpdaterPlugin {
  verifyApk(options: ApkVerification): Promise<void>;
  saveApk(options: ApkVerification): Promise<{ fileName: string }>;
  install(options: ApkVerification): Promise<void>;
  getDownloads(options: { ids: number[] }): Promise<{ downloads: NativeDownloadStatus[] }>;
  openDownloads(): Promise<void>;
  cancelDownload(options: { id: number }): Promise<{ cancelled: boolean }>;
  openDownloadedFile(options: { id: number }): Promise<void>;
  download(options: { url: string; token: string; fileName: string; mimeType?: string; userAgent: string }): Promise<{ id: number; fileName: string }>;
  save(options: { data: string; fileName: string; mimeType?: string }): Promise<{ fileName: string; size: number }>;
}
const Credentials = registerPlugin<CredentialPlugin>("BridgeCredentials");
const Updater = registerPlugin<UpdaterPlugin>("BridgeUpdater");
// Browser preview uses memory only; tokens are never persisted in browser storage.
const previewCredentials = new Map<string, string>();
let lifecycle: Promise<void> | null = null;
let shakeCleanup: (() => void) | null = null;

export async function getCredential(server: string): Promise<string | null> {
  return Capacitor.isNativePlatform() ? (await Credentials.get({ server })).token : previewCredentials.get(server) ?? null;
}
export async function setCredential(server: string, token: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await Credentials.set({ server, token });
  else previewCredentials.set(server, token);
}
export async function removeCredential(server: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await Credentials.remove({ server });
  else previewCredentials.delete(server);
}

export function isAndroidPlatform(): boolean {
  return Capacitor.getPlatform() === "android";
}

export async function nativeAppVersion(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return "浏览器预览";
  const info = await App.getInfo();
  return `${info.version} (${info.build})`;
}
export async function nativeAppInfo(): Promise<{ id: string; build: string; version: string }> { return App.getInfo(); }

export async function installNativeLifecycle(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (lifecycle) return lifecycle;
  lifecycle = (async () => {
    const handles: PluginListenerHandle[] = [];
    try {
      handles.push(await App.addListener("appStateChange", ({ isActive }) => {
        setAppForeground(isActive);
        shakeActive = isActive;
        shakeDetector.reset();
        if (isActive) window.dispatchEvent(new Event(MOBILE_RESUME_EVENT));
      }));
      if (Capacitor.getPlatform() === "android") handles.push(await App.addListener("backButton", ({ canGoBack }) => {
        if (!window.dispatchEvent(new Event(MOBILE_BACK_EVENT, { cancelable: true }))) return;
        if (canGoBack) window.history.back();
        else void App.minimizeApp();
      }));
    } catch (error) {
      await Promise.allSettled(handles.map((handle) => handle.remove()));
      lifecycle = null;
      throw error;
    }
    installShakeDetector();
    subscribeMobileDownloads(() => {
      if (isAndroidPlatform() && hasAndroidMobileDownloads() && !downloadPolling && downloadTimer === null) watchAndroidDownloads();
    });
    void cleanDownloadCache().catch(() => {});
  })();
  return lifecycle;
}

let shakeActive = true;
const shakeDetector = createShakeDetector();

function installShakeDetector(): void {
  if (shakeCleanup || typeof window === "undefined" || !("DeviceMotionEvent" in window)) return;
  let motionEnabled = readMobileShakeEnabled();
  const onMotion = (event: DeviceMotionEvent): void => {
    if (!motionEnabled || !shakeActive || document.visibilityState === "hidden") {
      shakeDetector.reset();
      return;
    }
    const acceleration = [event.acceleration, event.accelerationIncludingGravity]
      .find((value) => value?.x != null && value.y != null && value.z != null);
    if (!acceleration || acceleration.x === null || acceleration.y === null || acceleration.z === null) {
      shakeDetector.reset();
      return;
    }
    if (shakeDetector.sample({ x: acceleration.x, y: acceleration.y, z: acceleration.z }, performance.now())) {
      window.dispatchEvent(new Event(MOBILE_SHAKE_EVENT));
    }
  };
  const resetMotion = (): void => { motionEnabled = readMobileShakeEnabled(); shakeDetector.reset(); };
  window.addEventListener("devicemotion", onMotion, { passive: true });
  document.addEventListener("visibilitychange", resetMotion);
  window.addEventListener(MOBILE_SHAKE_PREFERENCE_EVENT, resetMotion);
  shakeCleanup = () => {
    window.removeEventListener("devicemotion", onMotion);
    document.removeEventListener("visibilitychange", resetMotion);
    window.removeEventListener(MOBILE_SHAKE_PREFERENCE_EVENT, resetMotion);
  };
}

export async function copyText(value: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await Clipboard.write({ string: value });
  else await navigator.clipboard.writeText(value);
}

export async function setShakeEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    const motion = (window as typeof window & { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (!motion) throw new Error("此设备未提供摇一摇能力，可从系统管理手动切换环境。");
    if (motion.requestPermission && await motion.requestPermission() !== "granted") throw new Error("未获得运动传感器权限，可从系统管理手动切换环境。");
  }
  writeMobileShakeEnabled(enabled);
}

export async function prepareApkUpdate(update: MobileApkUpdate, token: string, install: boolean, existingUri?: string,
  onPhase?: (phase: ApkUpdatePhase, uri?: string) => void): Promise<string> {
  if (!isAndroidPlatform()) throw new Error("APK 更新仅支持 Android App。");
  const task = startMobileDownload("bridge-update.apk", install ? "installer" : "downloads");
  const parent = "bridge-downloads/" + Date.now() + "-" + crypto.randomUUID();
  const path = parent + "/bridge-update.apk";
  let verified = false;
  let uri = existingUri;
  try {
    if (!uri) {
      onPhase?.("downloading");
      await cleanDownloadCache().catch(() => {});
      await Filesystem.mkdir({ path: parent, directory: Directory.Cache, recursive: true });
      uri = (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
      await transferWithProgress(update.downloadUrl, uri, token, task);
    }
    updateMobileDownload(task, { state: "saving", message: "正在校验更新包" });
    const options: ApkVerification = { uri, sha256: update.sha256, size: update.size, packageName: update.packageName,
      versionCode: update.versionCode, versionName: update.versionName };
    await Updater.verifyApk(options);
    verified = true;
    onPhase?.("downloaded", uri);
    if (install) {
      await Updater.install(options);
      onPhase?.("installer-opened", uri);
      updateMobileDownload(task, { state: "done", message: "已校验并打开 Android 安装器；请按系统提示完成安装。" });
    } else {
      const saved = await Updater.saveApk(options);
      updateMobileDownload(task, { state: "done", savedName: saved.fileName, message: "更新包已校验并保存到 Downloads，可手动安装。" });
    }
    return uri;
  } catch (cause) {
    onPhase?.("error", verified ? uri : undefined);
    failMobileDownload(task, cause);
    throw cause;
  } finally {
    if (!verified && !existingUri) await Filesystem.rmdir({ path: parent, directory: Directory.Cache, recursive: true }).catch(() => {});
  }
}

export async function downloadFile(url: string, fileName: string, token: string): Promise<void> {
  if (!isAndroidPlatform()) throw new Error("系统下载仅支持 Android App。");
  const task = startMobileDownload(fileName, "downloads");
  try {
    const result = await Updater.download({ url, token, fileName, mimeType: mimeTypeForFileName(fileName), userAgent: navigator.userAgent });
    if (!Number.isSafeInteger(result.id) || result.id <= 0) throw new Error("系统未返回有效的下载任务，请重试。");
    trackAndroidMobileDownload(task, result.id, result.fileName);
    watchAndroidDownloads();
  } catch (cause) {
    failMobileDownload(task, cause);
    throw cause;
  }
}

let downloadTimer: ReturnType<typeof setTimeout> | null = null;
let downloadPolling = false;
let downloadWatching = false;

function watchAndroidDownloads(): void {
  if (!downloadWatching) {
    downloadWatching = true;
    window.addEventListener(MOBILE_RESUME_EVENT, refreshSystemDownloads);
    document.addEventListener("visibilitychange", refreshSystemDownloads);
  }
  void refreshSystemDownloads();
}

async function refreshSystemDownloads(): Promise<void> {
  if (downloadTimer !== null) clearTimeout(downloadTimer);
  downloadTimer = null;
  if (downloadPolling || !hasAndroidMobileDownloads() || !shakeActive || document.visibilityState === "hidden") return;
  downloadPolling = true;
  try {
    await refreshAndroidMobileDownloads(async (ids) => {
      const downloads: NativeDownloadStatus[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        downloads.push(...(await Updater.getDownloads({ ids: ids.slice(offset, offset + 100) })).downloads);
      }
      return { downloads };
    });
  } finally {
    downloadPolling = false;
    if (hasAndroidMobileDownloads() && shakeActive && !document.hidden) {
      downloadTimer = setTimeout(() => { void refreshSystemDownloads(); }, 1_000);
    }
  }
}

export async function openMobileDownloads(): Promise<void> {
  if (!isAndroidPlatform()) throw new Error("系统下载目录仅支持 Android App。");
  await Updater.openDownloads();
}

export async function cancelMobileDownload(id: string): Promise<void> {
  const task = getMobileDownloads().find((item) => item.id === id);
  if (!task?.nativeId) throw new Error("此传输只能从原页面重试。");
  const result = await Updater.cancelDownload({ id: task.nativeId });
  if (result.cancelled) cancelAndroidMobileDownload(id);
  else { await refreshSystemDownloads(); throw new Error("下载已完成，请打开文件或到系统下载查看。"); }
}
export async function openDownloadedFile(id: string): Promise<void> {
  const task = getMobileDownloads().find((item) => item.id === id);
  if (!task?.nativeId || task.state !== "done") throw new Error("请在系统下载中查看此文件。");
  await Updater.openDownloadedFile({ id: task.nativeId });
}

export async function openExternal(url: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await Browser.open({ url });
  else window.open(url, "_blank", "noopener,noreferrer");
}

// Progress events identify a URL rather than an individual transfer. Serializing
// transfers prevents two downloads of the same URL from sharing progress.
let transferQueue: Promise<void> = Promise.resolve();
async function transferWithProgress(url: string, path: string, token: string, task: string): Promise<void> {
  updateMobileDownload(task, { state: "queued", message: "等待下载" });
  const transfer = transferQueue.then(async () => {
    updateMobileDownload(task, { state: "downloading", message: undefined });
    const listener = await FileTransfer.addListener("progress", (progress: TransferProgress) => {
      if (progress.type !== "download" || progress.url !== url) return;
      updateMobileDownload(task, {
        downloadedBytes: progress.bytes,
        totalBytes: progress.lengthComputable ? progress.contentLength : null,
      });
    });
    try {
      await FileTransfer.downloadFile({ url, path, headers: { Authorization: "Bearer " + token, "User-Agent": navigator.userAgent }, disableRedirects: true, progress: true });
    } finally { await listener.remove().catch(() => {}); }
    // Progress notifications can be throttled or arrive before the final write.
    // The successful native transfer and saved file size confirm the final bytes.
    const saved = await Filesystem.stat({ path }).catch(() => null);
    if (saved && Number.isFinite(saved.size) && saved.size >= 0) {
      updateMobileDownload(task, { downloadedBytes: saved.size, totalBytes: saved.size });
    }
  });
  transferQueue = transfer.catch(() => {});
  await transfer;
}

function downloadName(suppliedName: string): string {
  return suppliedName.replace(/[/\\\u0000-\u001f\u007f]/g, "_").slice(0, 160) || "bridge-file";
}

export async function shareFile(url: string, suppliedName: string, token: string | null): Promise<void> {
  const name = downloadName(suppliedName);
  if (Capacitor.isNativePlatform() && isAndroidPlatform()) {
    if (!token) throw new Error("请先配对 Bridge。");
    await downloadFile(url, name, token);
    return;
  }
  const native = Capacitor.isNativePlatform();
  const task = startMobileDownload(name, native ? "share" : "browser");
  const parent = "bridge-downloads/" + Date.now() + "-" + crypto.randomUUID();
  let downloaded = false;
  try {
    if (!native) {
      updateMobileDownload(task, { state: "downloading" });
      const response = await fetch(url);
      if (!response.ok) throw new Error("文件下载失败（" + response.status + "）。");
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl; link.download = name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
      updateMobileDownload(task, { state: "done", downloadedBytes: blob.size, totalBytes: blob.size, message: "文件已下载并交给浏览器保存。" });
      return;
    }
    if (!token) throw new Error("请先配对 Bridge。");
    await cleanDownloadCache().catch(() => {});
    await Filesystem.mkdir({ path: parent, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path: parent + "/" + name, directory: Directory.Cache });
    await transferWithProgress(url, uri, token, task);
    downloaded = true;
    updateMobileDownload(task, { state: "sharing", message: "文件已下载，请在系统面板选择保存或分享。" });
    try {
      await Share.share({ title: name, files: [uri], dialogTitle: "保存或分享文件" });
      updateMobileDownload(task, { state: "done", message: "文件已下载，已交给系统保存／分享；保存结果请在所选应用中查看。" });
    } catch (cause) {
      if (!isShareCancelled(cause)) throw cause;
      updateMobileDownload(task, { state: "done", message: "文件已下载；你已取消保存／分享，可重新点击下载。" });
    }
  } catch (cause) {
    failMobileDownload(task, cause);
    throw cause;
  } finally {
    // Keep shared files until bounded cache cleanup; recipients may read later.
    if (native && !downloaded) await Filesystem.rmdir({ path: parent, directory: Directory.Cache, recursive: true }).catch(() => {});
  }
}

// Every authenticated download from the App uses the same global status store.
export async function downloadBridgeFile(url: string, suppliedName: string, token: string | null): Promise<void> {
  await shareFile(url, suppliedName, token);
}

function mimeTypeForFileName(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "apk") return "application/vnd.android.package-archive";
  if (extension === "json") return "application/json";
  if (extension === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function isShareCancelled(cause: unknown): boolean {
  return cause instanceof Error && /share\s+canceled|share\s+cancelled/i.test(cause.message);
}

export async function shareBlob(blob: Blob, suppliedName: string): Promise<void> {
  const name = downloadName(suppliedName);
  const native = Capacitor.isNativePlatform();
  const android = isAndroidPlatform();
  const task = startMobileDownload(name, !native ? "browser" : android ? "downloads" : "share");
  const parent = "bridge-downloads/" + Date.now() + "-" + crypto.randomUUID();
  let written = false;
  try {
    if (native && blob.size > 8 * 1024 * 1024) throw new Error("此导出超过 8 MiB，请使用文件页的流式下载，或减少诊断日志后重新导出。");
    updateMobileDownload(task, { state: "saving", totalBytes: blob.size, message: "正在保存文件" });
    if (!native) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      updateMobileDownload(task, { state: "done", downloadedBytes: blob.size, message: "已交给浏览器保存。" });
      return;
    }
    const data = await blobAsBase64(blob);
    if (android) {
      const result = await Updater.save({ data, fileName: name, mimeType: blob.type || mimeTypeForFileName(name) });
      updateMobileDownload(task, { state: "done", downloadedBytes: result.size, savedName: result.fileName, message: "已保存到系统 Downloads" });
      return;
    }
    await cleanDownloadCache().catch(() => {});
    await Filesystem.mkdir({ path: parent, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.writeFile({ path: parent + "/" + name, directory: Directory.Cache, data });
    written = true;
    updateMobileDownload(task, { state: "sharing", downloadedBytes: blob.size, message: "请在系统面板选择保存或分享。" });
    try {
      await Share.share({ title: name, files: [uri], dialogTitle: "保存或分享文件" });
      updateMobileDownload(task, { state: "done", message: "已交给系统保存／分享；保存结果请在所选应用中查看。" });
    } catch (cause) {
      if (!isShareCancelled(cause)) throw cause;
      updateMobileDownload(task, { state: "done", message: "你已取消保存／分享，可重新导出。" });
    }
  } catch (cause) {
    failMobileDownload(task, cause);
    throw cause;
  } finally {
    if (native && !android && !written) await Filesystem.rmdir({ path: parent, directory: Directory.Cache, recursive: true }).catch(() => {});
  }
}

async function blobAsBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取待保存的文件。"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

async function cleanDownloadCache(): Promise<void> {
  const { files } = await Filesystem.readdir({ path: "bridge-downloads", directory: Directory.Cache });
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  for (const file of files) {
    const match = /^(\d{13})-[a-f0-9-]{36}$/.exec(file.name);
    if (file.type !== "directory" || !match || Number(match[1]) >= cutoff) continue;
    await Filesystem.rmdir({ path: "bridge-downloads/" + file.name, directory: Directory.Cache, recursive: true }).catch(() => {});
  }
}
